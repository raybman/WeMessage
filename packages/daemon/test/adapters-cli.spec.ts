/**
 * s5-execution Scenario 11 (CLI half, live rows) — `wemessage adapters`
 * (list / add / rm / enable / disable / token-rotate / test) and `watch`'s
 * adapter-health rendering, driven as a real subprocess against a real
 * daemon (§3.8, exit codes 1/2/3/4, C-9).
 *
 * LOCATION DEVIATION (precedent: rules-audit-cli.spec.ts S2 Sc11,
 * send-connect-cli.spec.ts S3 Sc10, drafts-cli.spec.ts S4 Sc11): the slice
 * names a packages/cli test, but `nobody-imports-daemon` and
 * `cli-desktop-thin-clients` in .dependency-cruiser.cjs forbid packages/cli
 * from importing @wemessage/daemon, and these rows need a REAL daemon
 * minting real tokens. The pure-function rows (table shape, the shown-once
 * block, the `draft.delta` preview accumulator) live where they belong, in
 * packages/cli/test/cli-s5.spec.ts.
 *
 * The row that matters most here is the shown-once token: the CLI must print
 * a minted token exactly once, at creation, and there must be no path — no
 * later verb, no cached file, no log — that shows it again. That is asserted
 * against the REAL minted string, not a fixture, because a fixture cannot
 * catch a CLI that quietly writes what the daemon returned to disk.
 *
 * This file runs its own no-green sweep (C-9) over every transcript it
 * collects.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createLoopbackSendBackend } from './helpers/loopback-backend.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);
/** Any ANSI escape (covers color incl. green): the no-green rule, strict. */
const ANSI_RE = /\x1b\[/;
const HANDLE = '+15551234567';

/**
 * The daemon's greeting frame as it appears on `watch`'s stdout. Matched as a
 * substring of the NDJSON rather than parsed, because the fact we need
 * ("the stream is live") is present the moment those bytes are, and a parse
 * would have to wait for a complete line to be sure.
 */
const GREETING_RE = /"event"\s*:\s*"connection\.state"/;

/** The narrowest thing a chunk source has to be for readiness to work. */
interface ChunkSource {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/**
 * Resolve when the greeting arrives; REJECT when it does not. The rejection
 * is the load-bearing half — see the readiness rows above.
 */
function greetingReady(source: ChunkSource, budgetMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seen = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `watch produced no connection.state greeting within ${String(budgetMs)}ms; ` +
            `stdout so far: ${JSON.stringify(seen.slice(0, 300))}`,
        ),
      );
    }, budgetMs);
    timer.unref();
    source.on('data', (chunk) => {
      if (settled) return;
      // Accumulated, not per-chunk: a pipe may split the greeting across two
      // reads and a byte stream owes us nothing about where it breaks.
      seen += chunk.toString();
      if (!GREETING_RE.test(seen)) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

function fakeWatcher(): FsWatcher {
  return {
    watch() {
      return () => {};
    },
  };
}

const probes: DoctorProbes = {
  osMajor: () => 15,
  fda: () => Promise.resolve('ok'),
  automation: () => Promise.resolve('ok'),
  messagesRunning: () => Promise.resolve(true),
};

interface Ctx {
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  token: string;
  configDir: string;
  dir: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
const children: ChildProcess[] = [];
/**
 * Adapter sockets opened by the watch rows. They must be closed AND drained
 * server-side before the store goes away: the transport writes an
 * `adapter.disconnected` audit row from its own 'close' handler, and a store
 * closed out from under it surfaces as an unhandled exception that has
 * nothing to do with the test that ran (same hazard cleanupAgentHarness
 * handles for the in-process harness).
 */
const agentSockets: { ws: WebSocket; daemon: RunningDaemon }[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const { ws, daemon } of agentSockets.splice(0)) {
    await new Promise<void>((resolve) => {
      if (ws.readyState === ws.CLOSED) return resolve();
      ws.on('close', () => resolve());
      ws.close();
    });
    const deadline = Date.now() + 2_000;
    while (
      (daemon.server.agentTransport?.openSessions() ?? 0) > 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const transcripts: { args: string[]; stdout: string; stderr: string }[] = [];
afterAll(() => {
  expect(transcripts.length).toBeGreaterThan(0);
  for (const t of transcripts) {
    expect(t.stdout, `stdout of ${t.args.join(' ')}`).not.toMatch(ANSI_RE);
    expect(t.stderr, `stderr of ${t.args.join(' ')}`).not.toMatch(ANSI_RE);
  }
});

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-adapters-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle(HANDLE);
  fixture.addChat({ identifier: HANDLE, handleIds: [handleId] });

  const configDir = join(dir, 'config');
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher: fakeWatcher(),
    doctorProbes: probes,
    backend: createLoopbackSendBackend(fixture, clock),
    backendName: 'loopback',
  });
  cleanups.push(() => daemon.stop());
  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  return { daemon, fixture, token, configDir, dir };
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      transcripts.push({ args, stdout, stderr });
      resolve({ code, stdout, stderr });
    });
    child.stdin.end();
  });
}

function envFor(ctx: Ctx): Record<string, string> {
  return {
    WEMESSAGE_PORT: String(ctx.daemon.port),
    WEMESSAGE_TOKEN: ctx.token,
    WEMESSAGE_DIR: ctx.configDir,
  };
}

interface Credential {
  adapter: { id: string; kind: string; hasToken: boolean };
  token: string;
  connectCmd: string;
}

async function addAdapter(ctx: Ctx, id: string): Promise<Credential> {
  const res = await runCli(
    ['adapters', 'add', id, '--kind', 'echo', '--name', 'Echo One', '--json'],
    envFor(ctx),
  );
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as Credential;
}

/** Every regular file under a directory tree, as text. */
function readAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const entry of readdirSync(p)) {
      const child = join(p, entry);
      if (statSync(child).isDirectory()) walk(child);
      else {
        try {
          out.push(readFileSync(child, 'utf8'));
        } catch {
          /* binary/unreadable: nothing a token could hide in as utf8 */
        }
      }
    }
  };
  walk(root);
  return out;
}

describe('wemessage adapters — add prints the token exactly once (§3.8)', () => {
  it('add mints, prints the token with an only-time-you-see-it line, and the connect command', async () => {
    const ctx = await boot();
    const human = await runCli(
      ['adapters', 'add', 'echo-1', '--kind', 'echo', '--name', 'Echo One'],
      envFor(ctx),
    );
    expect(human.code, human.stderr).toBe(0);
    const minted = /wm_[0-9a-f]{64}/.exec(human.stdout)?.[0];
    expect(minted, 'a wm_ token is printed').toBeDefined();
    expect(human.stdout.toLowerCase()).toContain(
      'this is the only time you will see this token',
    );
    expect(human.stdout).toContain('connect:');
    // Exactly once, in the whole transcript.
    expect(human.stdout.split(String(minted)).length - 1).toBe(1);
  }, 20_000);

  it('no later verb can show a minted token again, and nothing on disk holds it', async () => {
    const ctx = await boot();
    const cred = await addAdapter(ctx, 'echo-1');
    expect(cred.token).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(cred.adapter.hasToken).toBe(true);

    const list = await runCli(['adapters', 'list'], envFor(ctx));
    expect(list.code).toBe(0);
    expect(list.stdout).not.toContain(cred.token);
    expect(list.stdout).toContain('set');

    const listJson = await runCli(['adapters', 'list', '--json'], envFor(ctx));
    expect(listJson.stdout).not.toContain(cred.token);

    // The shown-once token is never echoed to a log or cache file: sweep the
    // whole config dir (the only place the CLI may write) for the string.
    for (const contents of readAllFiles(ctx.dir)) {
      expect(contents).not.toContain(cred.token);
    }
  }, 20_000);
});

describe('wemessage adapters — list / enable / disable / rm (§3.8)', () => {
  it('list renders the monochrome table and --json is machine-readable', async () => {
    const ctx = await boot();
    await addAdapter(ctx, 'echo-1');

    const list = await runCli(['adapters', 'list'], envFor(ctx));
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('ID');
    expect(list.stdout).toContain('KIND');
    expect(list.stdout).toContain('HEALTH');
    expect(list.stdout).toContain('TOKEN');
    expect(list.stdout).toContain('LAST SEEN');
    expect(list.stdout).toContain('echo-1');
    expect(list.stdout).toContain('echo');

    const json = await runCli(['adapters', 'list', '--json'], envFor(ctx));
    const rows = JSON.parse(json.stdout) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['echo-1']);
  }, 20_000);

  it('disable then enable round-trips the enabled flag', async () => {
    const ctx = await boot();
    await addAdapter(ctx, 'echo-1');

    const off = await runCli(
      ['adapters', 'disable', 'echo-1', '--json'],
      envFor(ctx),
    );
    expect(off.code, off.stderr).toBe(0);
    expect((JSON.parse(off.stdout) as { enabled: boolean }).enabled).toBe(
      false,
    );

    const on = await runCli(
      ['adapters', 'enable', 'echo-1', '--json'],
      envFor(ctx),
    );
    expect((JSON.parse(on.stdout) as { enabled: boolean }).enabled).toBe(true);
  }, 20_000);

  it('rm deletes; rm of an adapter a rule points at is a 409 → exit 1 naming the rules', async () => {
    const ctx = await boot();
    await addAdapter(ctx, 'echo-1');
    const rule = await runCli(
      [
        'rules',
        'add',
        '--name',
        'lunch',
        '--adapter',
        'echo-1',
        '--keyword',
        'lunch',
        '--json',
      ],
      envFor(ctx),
    );
    expect(rule.code, rule.stderr).toBe(0);
    const ruleId = (JSON.parse(rule.stdout) as { rule: { id: string } }).rule
      .id;

    const blocked = await runCli(['adapters', 'rm', 'echo-1'], envFor(ctx));
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toBe('');
    expect(blocked.stderr).toContain('adapter-referenced');
    // The actionable content of the refusal is WHICH rules are in the way.
    expect(blocked.stderr).toContain(ruleId);

    await runCli(['rules', 'rm', ruleId], envFor(ctx));
    const gone = await runCli(['adapters', 'rm', 'echo-1'], envFor(ctx));
    expect(gone.code, gone.stderr).toBe(0);
    expect(gone.stdout).toContain('deleted echo-1');

    const list = await runCli(['adapters', 'list'], envFor(ctx));
    expect(list.stdout).toContain('(no adapters)');
  }, 20_000);

  it('adding an id that already exists is a 409 → exit 1', async () => {
    const ctx = await boot();
    await addAdapter(ctx, 'echo-1');
    const again = await runCli(
      ['adapters', 'add', 'echo-1', '--kind', 'echo'],
      envFor(ctx),
    );
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('adapter-exists');
    expect(again.stdout).toBe('');
  }, 20_000);
});

describe('wemessage adapters — token-rotate (F-42)', () => {
  it('mints a different token, prints it once, and states the 60-second carry-over', async () => {
    const ctx = await boot();
    const first = await addAdapter(ctx, 'echo-1');
    const rotated = await runCli(
      ['adapters', 'token-rotate', 'echo-1'],
      envFor(ctx),
    );
    expect(rotated.code, rotated.stderr).toBe(0);
    const next = /wm_[0-9a-f]{64}/.exec(rotated.stdout)?.[0];
    expect(next).toBeDefined();
    expect(next).not.toBe(first.token);
    expect(rotated.stdout).toContain('old token valid 60 seconds');
    expect(rotated.stdout.split(String(next)).length - 1).toBe(1);
    // The token it replaced is not reprinted alongside the new one.
    expect(rotated.stdout).not.toContain(first.token);
  }, 20_000);
});

describe('wemessage adapters — usage refusals (exit 2, §3.8)', () => {
  // s5 Scenario 13 REVISED this row deliberately. The conformance kit now
  // exists and is green on echo and sol, but it is workspace-internal (F-52)
  // and `cli-desktop-thin-clients` forbids packages/cli/src from importing it
  // or the adapters it drives. The verb therefore still refuses — and the
  // assertion moves from "the kit does not exist" to "the kit is not reachable
  // from here yet, and here is where it is", which is the true statement.
  it('test refuses honestly and points at where the kit does run (F-52)', async () => {
    const ctx = await boot();
    await addAdapter(ctx, 'echo-1');
    const res = await runCli(['adapters', 'test', 'echo-1'], envFor(ctx));
    // An honest refusal beats a verb that silently does nothing.
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('workspace-internal');
    expect(res.stderr).toContain('@wemessage/adapter-testkit');
    expect(res.stderr).toContain('S7');
    expect(res.stdout).toBe('');
  }, 20_000);

  it('an unknown --kind and a missing --kind are usage errors, refused before the wire', async () => {
    const ctx = await boot();
    const badKind = await runCli(
      ['adapters', 'add', 'x-1', '--kind', 'skynet'],
      envFor(ctx),
    );
    expect(badKind.code).toBe(2);
    expect(badKind.stderr).toContain('--kind must be one of');

    const noKind = await runCli(['adapters', 'add', 'x-2'], envFor(ctx));
    expect(noKind.code).toBe(2);

    // Neither reached the daemon.
    const list = await runCli(['adapters', 'list', '--json'], envFor(ctx));
    expect(JSON.parse(list.stdout)).toEqual([]);
  }, 20_000);

  it('bad bearer exits 4; dead daemon exits 3', async () => {
    const ctx = await boot();
    const auth = await runCli(['adapters', 'list', '--json'], {
      ...envFor(ctx),
      WEMESSAGE_TOKEN: 'wm_wrong',
    });
    expect(auth.code).toBe(4);
    expect(auth.stdout).toBe('');

    const dead = await runCli(['adapters', 'list', '--json'], {
      WEMESSAGE_PORT: '9', // discard port — nothing listens
      WEMESSAGE_TOKEN: 'wm_whatever',
      WEMESSAGE_DIR: ctx.configDir,
    });
    expect(dead.code).toBe(3);
    expect(dead.stdout).toBe('');
  }, 20_000);
});

/**
 * s7 Scenario 1 (F-82) — readiness is the greeting, not a stopwatch.
 *
 * `watchUntil` below used to hand its caller a `ready` promise built from
 * `setTimeout(resolve, 300)`: a guess that the CLI had opened its WS and the
 * daemon had accepted it. Under load on a shared machine that guess loses,
 * the caller provokes `adapter.health` into a socket nobody is reading yet,
 * and the row fails with "timed out" pointing at the wrong thing entirely.
 *
 * The daemon already emits a `connection.state` greeting on every `/v1/events`
 * accept (daemon.ts, §3.4) FOR EXACTLY THIS REASON — "proves the stream is
 * live" — and `watch` prints it, in both modes, because human mode renders
 * only `draft.delta` and `adapter.health` and leaves everything else as
 * NDJSON. So the fact we want is already on the wire; the helper just has to
 * read it instead of guessing.
 *
 * These three rows are the helper's own unit tests, driven by a stub chunk
 * source rather than a real subprocess: the point is the readiness RULE, and
 * proving a rule with a spawned CLI would prove the CLI.
 */
describe('watchUntil readiness signal (s7 Sc1, F-82)', () => {
  const greetingChunk = Buffer.from(
    `${JSON.stringify({
      event: 'connection.state',
      state: { killSwitch: false, globalMode: 'draft-only' },
    })}\n`,
  );

  it('resolves on the first connection.state line', async () => {
    const source = new EventEmitter();
    const ready = greetingReady(source, 5_000);
    setTimeout(() => source.emit('data', greetingChunk), 5);
    await expect(ready).resolves.toBeUndefined();
  });

  it('rejects when no greeting ever arrives (it does not silently resolve)', async () => {
    // The whole point: the old helper resolved after 300 ms whether or not
    // anything was listening. A readiness signal that cannot fail is not a
    // readiness signal, it is a sleep with better branding.
    const source = new EventEmitter();
    await expect(greetingReady(source, 25)).rejects.toThrow(/greeting/);
  });

  it('is not satisfied by some other event on the same stream', async () => {
    // Negative row (C-3): `watch` prints every event as NDJSON, so "a line
    // arrived" is not the same fact as "the stream is live". Only the
    // greeting is the greeting.
    const source = new EventEmitter();
    const ready = greetingReady(source, 25);
    source.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          event: 'adapter.health',
          adapterId: 'echo-1',
          status: 'connected',
        })}\n`,
      ),
    );
    await expect(ready).rejects.toThrow(/greeting/);
  });

  it('tolerates a greeting split across two chunks', async () => {
    // A pipe is a byte stream, not a line stream; the 300 ms timer never had
    // to care and the replacement does.
    const source = new EventEmitter();
    const ready = greetingReady(source, 5_000);
    const half = Math.floor(greetingChunk.length / 2);
    source.emit('data', greetingChunk.subarray(0, half));
    source.emit('data', greetingChunk.subarray(half));
    await expect(ready).resolves.toBeUndefined();
  });
});

/**
 * Watch: `adapter.health` is the one S5 event a subprocess can provoke end to
 * end without hand-building a draft correlation — a real adapter socket
 * completing `hello` broadcasts it. The `draft.delta` preview accumulator is
 * proven as a pure function in packages/cli/test/cli-s5.spec.ts, because
 * driving a real streaming draft through a spawned CLI would prove the
 * daemon's stream, not the renderer.
 */
describe('wemessage watch — adapter.health (§3.8)', () => {
  function watchUntil(
    args: string[],
    env: Record<string, string>,
    predicate: (out: string) => boolean,
  ): { ready: Promise<void>; done: Promise<string>; child: ChildProcess } {
    const child = spawn(process.execPath, [CLI_BIN, 'watch', ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    let resolveDone: (s: string) => void = () => {};
    const done = new Promise<string>((resolve) => (resolveDone = resolve));
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (predicate(stdout)) resolveDone(stdout);
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', () => {
      transcripts.push({ args: ['watch', ...args], stdout, stderr });
      resolveDone(stdout);
    });
    // s7 Sc1 (F-82): readiness is the daemon's `connection.state` greeting,
    // not `setTimeout(resolve, 300)`. The old timer was a guess about
    // scheduler latency on a machine we do not control, and it resolved
    // whether or not the CLI had connected at all — so a lost race showed up
    // as a mystery timeout in the row below rather than as "watch never
    // connected", which is what had actually happened. The budget is
    // generous and its expiry is a FAILURE with the stdout attached.
    const ready = greetingReady(child.stdout, 10_000);
    return { ready, done, child };
  }

  async function connectAdapter(
    ctx: Ctx,
    id: string,
    token: string,
  ): Promise<WebSocket> {
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(ctx.daemon.port)}/v1/agent`,
    );
    agentSockets.push({ ws, daemon: ctx.daemon });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        v: 1,
        id: 'hello-1',
        type: 'hello',
        ts: clock.now(),
        payload: { adapterId: id, token, wire: 1 },
      }),
    );
    return ws;
  }

  it('renders adapter.health as a plain state line, and --json emits it as NDJSON unchanged', async () => {
    const ctx = await boot();
    const cred = await addAdapter(ctx, 'echo-1');

    const human = watchUntil([], envFor(ctx), (s) => s.includes('echo-1'));
    await human.ready;
    const ws1 = await connectAdapter(ctx, 'echo-1', cred.token);
    const humanOut = await human.done;
    human.child.kill();
    ws1.close();
    expect(humanOut).toContain('adapter echo-1: connected');
    expect(humanOut).not.toMatch(ANSI_RE);
    // Rendered, not raw JSON — for THIS event. Every other event on the bus
    // is still NDJSON in human mode, which is what it has always been (§3.8),
    // so the assertion is scoped to adapter.health rather than to the stream.
    expect(humanOut).not.toContain('"adapter.health"');

    const json = watchUntil(['--json'], envFor(ctx), (s) =>
      s.includes('adapter.health'),
    );
    await json.ready;
    const ws2 = await connectAdapter(ctx, 'echo-1', cred.token);
    const jsonOut = await json.done;
    json.child.kill();
    ws2.close();
    const line = jsonOut
      .split('\n')
      .filter((l) => l.includes('adapter.health'))[0];
    expect(JSON.parse(String(line))).toEqual({
      event: 'adapter.health',
      adapterId: 'echo-1',
      status: 'connected',
    });
  }, 30_000);
});

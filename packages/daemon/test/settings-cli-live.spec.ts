/**
 * s7-execution Scenario 5 (CLI half, live rows) — `wemessage settings
 * get|set` and `wemessage watch --events`, driven as a real subprocess
 * against a real daemon (§3.8 exit codes, C-9).
 *
 * LOCATION DEVIATION (precedent: rules-audit-cli.spec.ts S2 Sc11,
 * send-connect-cli.spec.ts S3 Sc10, drafts-cli.spec.ts S4 Sc11,
 * adapters-cli.spec.ts S5 Sc11, windows-cli-live.spec.ts S6 Sc12): the
 * scenario names a packages/cli test, but `nobody-imports-daemon` and
 * `cli-desktop-thin-clients` forbid packages/cli from importing
 * @wemessage/daemon, and these rows need a REAL daemon with a REAL store —
 * the exit codes, the daemon's own refusal words arriving on stderr, and a
 * subscription filter that has to survive a socket. The pure-function rows
 * (table shape, refusal copy, the value literal) live in
 * packages/cli/test/cli-s7.spec.ts.
 *
 * The load-bearing rows here are two:
 *
 *  - **Every one of the five refusals reaches the operator by name.** Sc 4
 *    spent a whole scenario making `PATCH /v1/settings` distinguish
 *    `unknown-key` from `read-only-key` from `wrong-type` from
 *    `below-floor` from `above-ceiling`, each with the datum that makes it
 *    actionable. A wrapper that printed "request failed (HTTP 400)" would
 *    have thrown all of it away one layer above where it was earned, so
 *    there is one row per reason, driven end to end.
 *  - **A filter is a filter on the wire, not in the renderer.** The
 *    `--events` row provokes two different broadcasts and asserts the one
 *    that was not asked for never arrives — which is only true if the list
 *    reached the daemon's `?events=`. A CLI that fetched everything and
 *    hid the rest would pass a renderer test and fail this one.
 *
 * This file runs its own no-green sweep (C-9) over every transcript it
 * collects.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_KILL_SWITCH,
  SETTING_UNDO_GRACE_SECONDS,
  type Clock,
  type FsWatcher,
} from '@wemessage/core';
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
const GREETING_RE = /"event"\s*:\s*"connection\.state"/;

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
}

const cleanups: (() => Promise<void> | void)[] = [];
const children: ChildProcess[] = [];
/**
 * Adapter sockets opened by the `--events` row. Closed AND drained
 * server-side before the store goes away, for the reason adapters-cli.spec.ts
 * documents: the transport writes `adapter.disconnected` from its own close
 * handler, and a store yanked out from under it surfaces as an unhandled
 * exception attributed to whatever test happens to be running.
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
  const dir = mkdtempSync(join(tmpdir(), 'wm-settings-cli-'));
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
  return { daemon, fixture, token, configDir };
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

// ---------------------------------------------------------------------------
// row 4 — `settings get`
// ---------------------------------------------------------------------------

describe('wemessage settings get (row 4)', () => {
  it('renders a fenced table carrying value, default, bounds and read-only status', async () => {
    const ctx = await boot();
    const res = await runCli(['settings', 'get'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);

    const lines = res.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('```');
    expect(lines.at(-1)).toBe('```');
    expect(res.stdout).toContain('KEY');
    expect(res.stdout).toContain('DEFAULT');

    // A bounded key shows the floor the daemon will refuse below.
    const cap = lines.find((l) => l.includes(SETTING_CAP_CONTACT_PER_2MIN));
    expect(cap).toBeDefined();
    expect(cap).toMatch(/\b1-60\b/);

    // A read-only key is never a normal row.
    const kill = lines.find((l) => l.includes(SETTING_KILL_SWITCH));
    expect(kill).toContain('READ-ONLY');
    expect(kill).toContain('wemessage kill');
  }, 20_000);

  it('--json is the daemon payload, unmodified', async () => {
    const ctx = await boot();
    const res = await runCli(['settings', 'get', '--json'], envFor(ctx));
    expect(res.code, res.stderr).toBe(0);
    const wire = await ctx.daemon.server.app.inject({
      method: 'GET',
      url: '/v1/settings',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    const expected = (wire.json() as { settings: Record<string, unknown> })
      .settings;
    expect(JSON.parse(res.stdout)).toEqual(expected);
    // 15 keys, 11 writable and 4 read-only (Sc 4's closed list).
    expect(Object.keys(expected)).toHaveLength(15);
  }, 20_000);

  it('never prints token material of any kind', async () => {
    // PUBLIC: adapter tokens are minted once and never re-displayed, and the
    // operator bearer is never echoed. The settings surface has no business
    // carrying either, and this row is what keeps it that way if the closed
    // list ever grows.
    const ctx = await boot();
    const res = await runCli(['settings', 'get', '--json'], envFor(ctx));
    expect(res.stdout).not.toContain(ctx.token);
    expect(res.stdout).not.toMatch(/wm_[0-9a-f]{64}/);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// row 5 — `settings set`, the happy path and all five refusals
// ---------------------------------------------------------------------------

describe('wemessage settings set (row 5)', () => {
  it('a legal write exits 0, prints the new value, and reaches the store', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', SETTING_CAP_CONTACT_PER_2MIN, '3'],
      envFor(ctx),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain(`${SETTING_CAP_CONTACT_PER_2MIN}: 3`);
    expect(ctx.daemon.store.getSetting(SETTING_CAP_CONTACT_PER_2MIN)).toBe('3');
  }, 20_000);

  it('a bool key takes true/false', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', 'send.retryAsSms', 'true'],
      envFor(ctx),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('send.retryAsSms: true');
  }, 20_000);

  it('setting the undo window to zero says so in plain words, and still writes', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', SETTING_UNDO_GRACE_SECONDS, '0'],
      envFor(ctx),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('no undo window');
    expect(ctx.daemon.store.getSetting(SETTING_UNDO_GRACE_SECONDS)).toBe('0');
  }, 20_000);

  it('below-floor: exit 1, the daemon`s word, and the floor it could not have known', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', SETTING_CAP_CONTACT_PER_2MIN, '0'],
      envFor(ctx),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('below-floor');
    expect(res.stderr).toContain('(floor 1)');
    expect(res.stderr).not.toContain('HTTP 400');
    expect(res.stdout).toBe('');
    // Nothing was written.
    expect(ctx.daemon.store.getSetting(SETTING_CAP_CONTACT_PER_2MIN)).toBe(
      null,
    );
  }, 20_000);

  it('above-ceiling: exit 1, naming the ceiling', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', 'send.capGlobalPerHour', '100000'],
      envFor(ctx),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('above-ceiling');
    expect(res.stderr).toContain('ceiling 10000');
  }, 20_000);

  it('read-only-key: exit 2, remediated to the CLI verb that owns it', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', SETTING_KILL_SWITCH, 'true'],
      envFor(ctx),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('read-only-key');
    expect(res.stderr).toContain('wemessage kill');
    // And the switch was NOT flipped by the attempt.
    const status = await ctx.daemon.server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect((status.json() as { killSwitch: boolean }).killSwitch).toBe(false);
  }, 20_000);

  it('unknown-key: exit 2, pointing at the closed list', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', 'send.nope', '1'],
      envFor(ctx),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('unknown-key');
    expect(res.stderr).toContain('send.nope');
    expect(res.stderr).toContain('wemessage settings get');
  }, 20_000);

  it('wrong-type: exit 2, naming the type the key expects', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['settings', 'set', 'send.retryAsSms', 'yes'],
      envFor(ctx),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('wrong-type');
    expect(res.stderr).toContain('bool');

    // The int half of the same refusal, so neither type is proven by the
    // other: a non-integer literal reaches the daemon and comes back named.
    const int = await runCli(
      ['settings', 'set', SETTING_CAP_CONTACT_PER_2MIN, '1.5'],
      envFor(ctx),
    );
    expect(int.code).toBe(2);
    expect(int.stderr).toContain('wrong-type');
    expect(int.stderr).toContain('int');
  }, 20_000);

  it('bad bearer exits 4 and a dead daemon exits 3 — neither is a settings refusal', async () => {
    const ctx = await boot();
    const auth = await runCli(['settings', 'get', '--json'], {
      ...envFor(ctx),
      WEMESSAGE_TOKEN: 'wm_wrong',
    });
    expect(auth.code).toBe(4);
    const dead = await runCli(['settings', 'get'], {
      WEMESSAGE_PORT: '9',
      WEMESSAGE_TOKEN: 'wm_whatever',
      WEMESSAGE_DIR: ctx.configDir,
    });
    expect(dead.code).toBe(3);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// row 3 — `watch --events`
// ---------------------------------------------------------------------------

describe('wemessage watch --events (row 3)', () => {
  /** The narrowest thing a chunk source has to be for readiness to work. */
  interface ChunkSource {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  }

  /**
   * Resolve when the greeting arrives; REJECT when it does not. The rejection
   * is the load-bearing half: a filter row that silently waited forever on a
   * stream that never opened would time out looking like a slow machine.
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
        seen += chunk.toString();
        if (!GREETING_RE.test(seen)) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

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
    const done = new Promise<string>((resolve) => {
      resolveDone = resolve;
    });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (predicate(stdout)) resolveDone(stdout);
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', () => {
      transcripts.push({ args: ['watch', ...args], stdout, stderr });
      resolveDone(stdout);
    });
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

  async function addAdapter(ctx: Ctx, id: string): Promise<string> {
    const res = await runCli(
      ['adapters', 'add', id, '--kind', 'echo', '--json'],
      envFor(ctx),
    );
    expect(res.code, res.stderr).toBe(0);
    return (JSON.parse(res.stdout) as { token: string }).token;
  }

  it('the list travels to the daemon: an event outside it never arrives', async () => {
    const ctx = await boot();
    const token = await addAdapter(ctx, 'echo-1');

    const watch = watchUntil(
      ['--events', 'adapter.health', '--json'],
      envFor(ctx),
      (s) => s.includes('adapter.health'),
    );
    await watch.ready;

    // A broadcast the filter excludes...
    const killed = await runCli(['kill'], envFor(ctx));
    expect(killed.code, killed.stderr).toBe(0);
    // ...and one it includes.
    await connectAdapter(ctx, 'echo-1', token);

    const out = await watch.done;
    watch.child.kill();

    expect(out).toContain('adapter.health');
    // The excluded broadcast is absent, which is only true if `?events=`
    // reached the daemon: the CLI does no filtering of its own, and a
    // wrapper that subscribed to everything and hid the rest would pass a
    // renderer test and fail this one.
    expect(out).not.toContain('toggle.changed');
    // The greeting is delivered even though the filter excludes it: it is the
    // liveness proof, not a subscription.
    expect(out.match(/connection\.state/g)).toHaveLength(1);
  }, 30_000);

  it('an unknown name exits 2 with the daemon`s own words, not a stack', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['watch', '--events', 'draft.typo', '--json'],
      envFor(ctx),
    );
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('unknown-event');
    expect(res.stderr).toContain('draft.typo');
    // Not an unreachable daemon (exit 3's story), and not a stack trace.
    expect(res.stderr).not.toContain('unreachable');
    expect(res.stderr).not.toContain('    at ');
    expect(res.stdout).toBe('');
  }, 20_000);

  it('an empty --events is the daemon`s refusal too, never read here as "everything"', async () => {
    const ctx = await boot();
    const res = await runCli(['watch', '--events', '', '--json'], envFor(ctx));
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('unknown-event');
    expect(res.stdout).toBe('');
  }, 20_000);
});

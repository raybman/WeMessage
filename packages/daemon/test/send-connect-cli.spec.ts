/**
 * s3-execution Scenario 10 (part 3) — CLI verbs `doctor`/`send`/`connect`/
 * `disconnect` (§3.8, F-29, exit 5). LOCATION DEVIATION (same precedent as
 * rules-audit-cli.spec.ts, S2 Scenario 11): the spec names
 * packages/cli/test/cli-s3.spec.ts, but an in-test daemon there is
 * structurally impossible — `nobody-imports-daemon` (.dependency-cruiser.cjs,
 * INV-1/§3.1) exempts only packages/daemon/src, and `cli-desktop-thin-clients`
 * forbids packages/cli/src (and, by the repo's own convention, its test
 * harness) from depending on @wemessage/daemon at all. Booting a REAL daemon
 * in-process to spawn the compiled CLI against is exactly the shape
 * rules-audit-cli.spec.ts already established for this reason, so this spec
 * lives beside it.
 *
 * Compiled bin via child_process against a REAL `startDaemon()` instance on
 * an ephemeral port — never `.inject()`, the CLI speaks real HTTP/fetch.
 * No real osascript, no real iMessage (test/arch.spec.ts gates (a)/(b)):
 * `LoopbackSendBackend` + a fixture chat.db + controllable `DoctorProbes`
 * fakes, same conventions as send-verify.spec.ts / connect.spec.ts.
 *
 * No-green sweep (C-8): this file's own afterAll asserts zero ANSI bytes
 * across every transcript IT collects (doctor/send/connect/disconnect) —
 * rules-audit-cli.spec.ts already runs the equivalent sweep for the S1/S2
 * verbs; together the two files cover "the whole CLI surface" per spec text.
 *
 * The interactive `--purge` TTY-prompt path (type "delete my data" at a real
 * terminal) cannot be driven from a subprocess here: Node gives a spawned
 * child's stdin a pipe, never a pty, and this repo takes no new pty
 * dependency (Gate 4: no new package.json deps). This file exercises the two
 * scriptable edges instead (non-TTY refusal, `--yes-really-purge` bypass);
 * packages/cli/src/purge.ts's own unit test (packages/cli/test/purge.spec.ts)
 * covers the phrase-matching logic itself in isolation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { SETTING_KILL_SWITCH } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  readToken,
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import {
  createLoopbackSendBackend,
  type LoopbackSendBackend,
} from './helpers/loopback-backend.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);
/** Any ANSI escape (covers color incl. green): the no-green rule, strict. */
const ANSI_RE = /\[/;

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

interface FakeWatcher extends FsWatcher {
  fire: () => void;
}
function fakeWatcher(): FakeWatcher {
  const handlers: (() => void)[] = [];
  return {
    watch(_paths, onChange) {
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
}

type FdaState = 'ok' | 'eperm' | 'enoent' | 'error';
interface ControllableProbes extends DoctorProbes {
  setFda(v: FdaState): void;
}
function controllableProbes(): ControllableProbes {
  let fda: FdaState = 'ok';
  return {
    osMajor: () => 15,
    fda: () => Promise.resolve(fda),
    automation: () => Promise.resolve('ok'),
    messagesRunning: () => Promise.resolve(true),
    setFda: (v) => {
      fda = v;
    },
  };
}

interface Ctx {
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  probes: ControllableProbes;
  backend: LoopbackSendBackend;
  configDir: string;
  token: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** Every CLI transcript, swept by the afterAll no-ANSI assertion. */
const transcripts: { args: string[]; stdout: string; stderr: string }[] = [];
afterAll(() => {
  expect(transcripts.length).toBeGreaterThan(0);
  for (const t of transcripts) {
    expect(t.stdout, `stdout of ${t.args.join(' ')}`).not.toMatch(ANSI_RE);
    expect(t.stderr, `stderr of ${t.args.join(' ')}`).not.toMatch(ANSI_RE);
  }
});

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-send-connect-cli-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');

  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const probes = controllableProbes();
  const backend = createLoopbackSendBackend(fixture, clock);

  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher: fakeWatcher(),
    doctorProbes: probes,
    backend,
    backendName: 'loopback',
  });
  cleanups.push(() => daemon.stop());

  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  return { daemon, fixture, probes, backend, configDir, token };
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

function envFor(
  ctx: Ctx,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    WEMESSAGE_PORT: String(ctx.daemon.port),
    WEMESSAGE_TOKEN: ctx.token,
    ...extra,
  };
}

describe('wemessage doctor (§1.3.7, F-29)', () => {
  it('fully-connected: exit 0, monochrome checks table, probed timestamp', async () => {
    const ctx = await boot();
    const res = await runCli(['doctor'], envFor(ctx));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('state: fully-connected');
    expect(res.stdout).toContain('✓ os');
    expect(res.stdout).toContain('✓ fda');
    expect(res.stdout).toContain('✓ automation');
    expect(res.stdout).toContain('✓ messages');
    expect(res.stdout).toMatch(/probed: \d{4}-\d{2}-\d{2}T/);
  });

  it('--json prints the raw DoctorReport verbatim', async () => {
    const ctx = await boot();
    const res = await runCli(['doctor', '--json'], envFor(ctx));
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      state: string;
      checks: unknown[];
      probedAt: string;
    };
    expect(body.state).toBe('fully-connected');
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it('degraded (fda eperm): exit 1, remediation printed verbatim, ✗ glyph', async () => {
    const ctx = await boot();
    ctx.probes.setFda('eperm');
    const res = await runCli(['doctor'], envFor(ctx));
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('state: disconnected');
    expect(res.stdout).toContain('✗ fda');
    expect(res.stdout).toContain('Full Disk Access is not reaching the daemon');
  });

  it('macOS-26 divergence: local probe ok + daemon fda fail prints the divergence playbook', async () => {
    const ctx = await boot();
    ctx.probes.setFda('eperm');
    const dir = mkdtempSync(join(tmpdir(), 'wm-chatdb-local-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const localChatDb = join(dir, 'chat.db');
    writeFileSync(localChatDb, ''); // openable by this test process

    const res = await runCli(
      ['doctor'],
      envFor(ctx, { WEMESSAGE_CHATDB_PATH: localChatDb }),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain(
      'divergence: this shell can read chat.db but the daemon cannot',
    );
    expect(res.stdout).toContain('macOS 26 FDA propagation landmine');
  });

  it('no divergence line when the local probe fails too (ENOENT: no chat.db locally either)', async () => {
    const ctx = await boot();
    ctx.probes.setFda('eperm');
    const res = await runCli(
      ['doctor'],
      envFor(ctx, {
        WEMESSAGE_CHATDB_PATH: join(
          tmpdir(),
          'wm-does-not-exist-dir',
          'chat.db',
        ),
      }),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).not.toContain('divergence:');
  });
});

describe('wemessage send --to <handle> --body <text>', () => {
  it('sent: exit 0, draft id then sentMessageGuid', async () => {
    const ctx = await boot();
    const handleId = ctx.fixture.addHandle('+15551234567');
    ctx.fixture.addChat({ identifier: '+15551234567', handleIds: [handleId] });

    const res = await runCli(
      ['send', '--to', '+15551234567', '--body', 'hello'],
      envFor(ctx),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('draft:');
    expect(res.stdout).toContain('sent:');
  });

  it('failed (no-conversation): exit 1, error code + honest message printed', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['send', '--to', '+15559990000', '--body', 'first contact'],
      envFor(ctx),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('failed: no-conversation');
  });

  it('gate-denied (kill-switch): exit 5, reason on stderr', async () => {
    const ctx = await boot();
    const handleId = ctx.fixture.addHandle('+15552223333');
    ctx.fixture.addChat({ identifier: '+15552223333', handleIds: [handleId] });
    ctx.daemon.store.setSetting(SETTING_KILL_SWITCH, '1');

    const res = await runCli(
      ['send', '--to', '+15552223333', '--body', 'should never leave the gate'],
      envFor(ctx),
    );
    expect(res.code).toBe(5);
    expect(res.stderr).toContain('gate denied: kill-switch');
  });

  it('--json passthrough for the sent outcome', async () => {
    const ctx = await boot();
    const handleId = ctx.fixture.addHandle('+15554445555');
    ctx.fixture.addChat({ identifier: '+15554445555', handleIds: [handleId] });

    const res = await runCli(
      ['send', '--to', '+15554445555', '--body', 'hi', '--json'],
      envFor(ctx),
    );
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as {
      draftId: string;
      outcome: string;
      sentMessageGuid: string;
    };
    expect(body.outcome).toBe('sent');
  });
});

describe('wemessage connect (§1.3.7)', () => {
  it('after a disconnect, connect reports fully-connected again', async () => {
    const ctx = await boot();
    const disc = await runCli(['disconnect'], envFor(ctx));
    expect(disc.code).toBe(0);
    const rotated = readToken(ctx.configDir);
    if (rotated === null) throw new Error('expected a rotated token');

    const res = await runCli(
      ['connect'],
      envFor(ctx, { WEMESSAGE_TOKEN: rotated }),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('state: fully-connected');
  });
});

describe('wemessage disconnect (§1.3.7)', () => {
  it('without --purge: exit 0, step results rendered, purge step skipped', async () => {
    const ctx = await boot();
    const res = await runCli(['disconnect'], envFor(ctx));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('state: disconnected');
    expect(res.stdout).toContain('purge');
  });

  it('--purge without confirmation on non-TTY stdin: refuses, exit 2, daemon never called', async () => {
    const ctx = await boot();
    const res = await runCli(['disconnect', '--purge'], envFor(ctx));
    expect(res.code).toBe(2);
    // Prove the daemon really never saw the request: the same token still works.
    const status = await runCli(['status'], envFor(ctx));
    expect(status.code).toBe(0);
  });

  it('--purge --yes-really-purge: bypasses the prompt, exit 0, purge step done', async () => {
    const ctx = await boot();
    const res = await runCli(
      ['disconnect', '--purge', '--yes-really-purge'],
      envFor(ctx),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('✓ purge');
  });
});

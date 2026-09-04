/**
 * Scenario 11 — Tail-pipeline e2e: the S1 demo in test form (spec Part 2 #11;
 * §4.0 integration tier).
 *
 * Composition: real store (temp), real ingest against a fixture chat.db, fake
 * FsWatcher, valid token file. Asserts:
 * - boot order recovery -> watcher -> listen (§2.5 "runs cursor + send-ledger
 *   recovery before serving");
 * - authenticated WS /v1/events client receives {event:'message.received',
 *   message: SanitizedInbound} per §3.4 with content.untrusted === true and
 *   control characters stripped (§2.4.5 — sanitizer at the event boundary from
 *   day one), including an attributedBody-only Ventura-style row;
 * - edited/unsent fixture rows produce message.edited / message.unsent (§3.4);
 * - unauthenticated client receives nothing;
 * - GET /v1/status returns connection state + cursor + counts (F-5 shape,
 *   adapters empty);
 * - CLI (real compiled bin via child_process, WEMESSAGE_TOKEN env per §2.6):
 *   `wemessage watch --json` emits NDJSON, `wemessage status` renders the
 *   payload, `wemessage auth print-token` / `auth rotate` (old bearers 401),
 *   exit 3 daemon-unreachable, exit 4 auth failure (§3.8 exit codes).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  createClient,
  readTokenFile,
  DaemonAuthError,
  DaemonUnreachableError,
} from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const CLI_BIN = fileURLToPath(
  new URL('../../cli/dist/bin.js', import.meta.url),
);

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

// s3 Scenario 7: startDaemon requires explicit doctorProbes (no production
// default — see doctor.ts's header comment on why). Fixed 'fully-connected'
// fake for this file's fixture-driven boot; never calls real osascript
// (test/arch.spec.ts gate (b)).
const fullyConnectedProbes: DoctorProbes = {
  osMajor: () => 15,
  fda: async () => 'ok',
  automation: async () => 'ok',
  messagesRunning: async () => true,
};

interface FakeWatcher extends FsWatcher {
  paths: string[][];
  fire: () => void;
}

function fakeWatcher(): FakeWatcher {
  const handlers: (() => void)[] = [];
  const w: FakeWatcher = {
    paths: [],
    watch(paths, onChange) {
      w.paths.push([...paths]);
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
  return w;
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Ctx {
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  watcher: FakeWatcher;
  configDir: string;
  chatId: number;
  handleId: number;
  baseUrl: string;
  token: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-tail-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');

  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle('+15550001111');
  const chatId = fixture.addChat('iMessage;-;+15550001111', handleId);

  const watcher = fakeWatcher();
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher,
    doctorProbes: fullyConnectedProbes,
    backend: createUnusedSendBackend(),
    backendName: 'unused',
  });
  cleanups.push(() => daemon.stop());

  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  return {
    daemon,
    fixture,
    watcher,
    configDir,
    chatId,
    handleId,
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    token,
  };
}

describe('daemon boot (§2.5)', () => {
  it('boots recovery -> watcher -> listen, watching chat.db + wal', async () => {
    const ctx = await boot();
    expect(ctx.daemon.bootLog).toEqual(['recovery', 'watcher', 'listen']);
    expect(ctx.daemon.recovery.cursor).toBeDefined(); // T-9.3 ran (Scenario 9)
    expect(ctx.watcher.paths[0]).toHaveLength(2);
    expect(ctx.watcher.paths[0]?.[1]).toMatch(/chat\.db-wal$/);
  });
});

describe('WS tail (§3.4, §2.4.5)', () => {
  it('authenticated client receives sanitized message.received events in order', async () => {
    const ctx = await boot();
    const events: GatewayEventPayload[] = [];
    const client = createClient({ baseUrl: ctx.baseUrl, token: ctx.token });
    const sub = await client.events((e) => events.push(e));
    cleanups.push(() => sub.close());

    // greeting frame proves the subscription is live before rows are appended
    await waitFor(() => events.length >= 1, 'connection.state greeting');
    expect(events[0]).toEqual({
      event: 'connection.state',
      state: 'fully-connected',
    });

    const a = ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX tail one\u0007 bell stripped', // BEL is stripped (2.4.5)
    });
    // Ventura-style row: text column NULL, attributedBody only (§2.2.1)
    const b = ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      attributedBodyFixture: 'emoji',
    });
    ctx.watcher.fire();

    await waitFor(() => events.length >= 3, 'two message.received events');
    const received = events.slice(1);
    expect(received.map((e) => e.event)).toEqual([
      'message.received',
      'message.received',
    ]);
    const first = received[0];
    const second = received[1];
    if (
      first?.event !== 'message.received' ||
      second?.event !== 'message.received'
    ) {
      throw new Error('unreachable: asserted above');
    }
    // in ROWID order
    expect(first.message.guid).toBe(a.guid);
    expect(second.message.guid).toBe(b.guid);
    // §2.4.5: untrusted wrapper + control chars stripped at the event boundary
    expect(first.message.content.untrusted).toBe(true);
    expect(first.message.content.text).toBe('GL-FIX tail one bell stripped');
    // attributedBody-only row decoded (§2.2.1)
    expect(second.message.content.text).toBe('GL-FIX-002 emoji 👍🏽🔥');
    expect(second.message.handle).toBe('+15550001111');
    expect(second.message.service).toBe('imessage');
  });

  it('edited and unsent fixture rows produce message.edited / message.unsent', async () => {
    const ctx = await boot();
    const events: GatewayEventPayload[] = [];
    const client = createClient({ baseUrl: ctx.baseUrl, token: ctx.token });
    const sub = await client.events((e) => events.push(e));
    cleanups.push(() => sub.close());
    await waitFor(() => events.length >= 1, 'greeting');

    // an appended row that already carries an edit (date_edited set)
    const edited = ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX pre-edit body',
    });
    ctx.fixture.editMessage(edited.guid, 'GL-FIX edited body v2');
    const unsent = ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX to be unsent',
    });
    ctx.fixture.unsendMessage(unsent.guid);
    ctx.watcher.fire();

    await waitFor(() => events.length >= 3, 'edited + unsent events');
    expect(events[1]).toEqual({
      event: 'message.edited',
      guid: edited.guid,
      // summary-info latest revision is authoritative (§1.3.8, Scenario 7)
      newText: 'GL-FIX-005 edited body (v2)',
    });
    expect(events[2]).toEqual({ event: 'message.unsent', guid: unsent.guid });
  });

  it('unauthenticated client receives nothing (connection refused at upgrade)', async () => {
    const ctx = await boot();
    const events: GatewayEventPayload[] = [];
    const bad = createClient({
      baseUrl: ctx.baseUrl,
      token: `wm_${'f'.repeat(64)}`,
    });
    await expect(bad.events((e) => events.push(e))).rejects.toThrow();

    // and the broadcast that follows leaks nothing to it
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX secret',
    });
    ctx.watcher.fire();
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual([]);
  });
});

describe('/v1/status (F-5)', () => {
  it('returns connection state + cursor position + message count', async () => {
    const ctx = await boot();
    ctx.fixture.addMessageBurst(3, {
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX status row',
    });
    ctx.watcher.fire();
    const client = createClient({ baseUrl: ctx.baseUrl, token: ctx.token });
    // scan is async; poll status until the cursor lands
    let status = await client.status();
    const deadline = Date.now() + 2000;
    while ((status.cursor?.lastRowid ?? 0) < 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      status = await client.status();
    }
    expect(status.connectionState).toBe('fully-connected');
    expect(status.cursor?.lastRowid).toBe(3);
    expect(status.counts.messagesToday).toBe(3);
    expect(status.adapters).toEqual([]);
    // s6 Scenario 11: the last two F-5 placeholders. This daemon is fully
    // connected, has no kill switch set, no pause, no rules and no breaker,
    // so it is armed with nothing bounding it — and the point of the row is
    // that the payload now says so instead of `null`.
    expect(status.killSwitch).toBe(false);
    expect(status.armed).toEqual({
      armed: true,
      until: null,
      reason: 'armed',
    });
  });
});

/** Spawn the real compiled CLI bin (§3.8) and collect stdout/exit. */
function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      env: { ...process.env, ...env },
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI (§3.8, §2.6)', () => {
  it('wemessage status renders the payload; --json is machine-readable', async () => {
    const ctx = await boot();
    const env = {
      WEMESSAGE_PORT: String(ctx.daemon.port),
      WEMESSAGE_TOKEN: ctx.token,
    };
    const json = await runCli(['status', '--json'], env);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as { connectionState: string };
    expect(payload.connectionState).toBe('fully-connected');

    const human = await runCli(['status'], env);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('fully-connected');
  });

  it('wemessage watch --json emits one NDJSON object per event', async () => {
    const ctx = await boot();
    const child = spawn(process.execPath, [CLI_BIN, 'watch', '--json'], {
      env: {
        ...process.env,
        WEMESSAGE_PORT: String(ctx.daemon.port),
        WEMESSAGE_TOKEN: ctx.token,
      },
    });
    children.push(child);
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));

    // first NDJSON line is the connection.state greeting => stream is live
    await waitFor(() => out.includes('\n'), 'watch greeting line');
    const greeting = JSON.parse(out.split('\n')[0] ?? '') as {
      event: string;
    };
    expect(greeting.event).toBe('connection.state');

    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX ndjson row',
    });
    ctx.watcher.fire();
    await waitFor(
      () => out.split('\n').filter((l) => l.trim()).length >= 2,
      'message NDJSON line',
    );
    const lines = out.split('\n').filter((l) => l.trim());
    const evt = JSON.parse(lines[1] ?? '') as GatewayEventPayload;
    expect(evt.event).toBe('message.received');
    if (evt.event !== 'message.received') throw new Error('unreachable');
    expect(evt.message.content.text).toBe('GL-FIX ndjson row');
    child.kill('SIGTERM');
  });

  it('auth print-token prints the token from the config dir (§2.6 file trust)', async () => {
    const ctx = await boot();
    const res = await runCli(['auth', 'print-token'], {
      WEMESSAGE_DIR: ctx.configDir,
    });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(ctx.token);
  });

  it('auth rotate rotates the token and old bearers get 401 (§2.6)', async () => {
    const ctx = await boot();
    const res = await runCli(['auth', 'rotate'], {
      WEMESSAGE_DIR: ctx.configDir,
    });
    expect(res.code).toBe(0);
    const rotated = res.stdout.trim();
    expect(rotated).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(rotated).not.toBe(ctx.token);
    expect(readTokenFile(ctx.configDir)).toBe(rotated);

    const oldClient = createClient({ baseUrl: ctx.baseUrl, token: ctx.token });
    await expect(oldClient.status()).rejects.toBeInstanceOf(DaemonAuthError);
    const newClient = createClient({ baseUrl: ctx.baseUrl, token: rotated });
    const status = await newClient.status();
    expect(status.connectionState).toBe('fully-connected');
  });

  it('exits 3 when the daemon is unreachable, 4 on auth failure (§3.8)', async () => {
    const unreachable = await runCli(['status'], {
      WEMESSAGE_PORT: '47199', // nothing listens here
      WEMESSAGE_TOKEN: 'wm_deadbeef',
    });
    expect(unreachable.code).toBe(3);

    const ctx = await boot();
    const badAuth = await runCli(['status'], {
      WEMESSAGE_PORT: String(ctx.daemon.port),
      WEMESSAGE_TOKEN: `wm_${'e'.repeat(64)}`,
    });
    expect(badAuth.code).toBe(4);
  });
});

describe('client error taxonomy', () => {
  it('DaemonUnreachableError on connection refusal', async () => {
    const client = createClient({
      baseUrl: 'http://127.0.0.1:47198',
      token: 'wm_x',
    });
    await expect(client.status()).rejects.toBeInstanceOf(
      DaemonUnreachableError,
    );
  });
});

describe('daemon.token file remains the source of truth', () => {
  it('the token file on disk matches what the daemon accepts', async () => {
    const ctx = await boot();
    const onDisk = readFileSync(
      join(ctx.configDir, 'daemon.token'),
      'utf8',
    ).trim();
    expect(onDisk).toBe(ctx.token);
  });
});

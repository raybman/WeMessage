/**
 * Scenario 9 (part 1) — POST /v1/disconnect (s3-execution §1.3.7, §2.4.1).
 * ★ CHECKPOINT.
 *
 * A pure-unit ordering/shape suite against `disconnectDaemon` (fake deps,
 * mirrors doctor.spec.ts's `Pick<Store, ...>`/`Pick<AuditSink, ...>`
 * fake-port convention), then `startDaemon`-based integration tests
 * (modeled on tail-pipeline.spec.ts's fakeWatcher()/waitFor()/boot()
 * conventions and send-verify.spec.ts's raw-`ws` WS-collection convention)
 * proving the 8 RED rows end to end: never real osascript, never a real
 * iMessage (test/arch.spec.ts gates (a)/(b)) — a fake `FsWatcher` + fake
 * `DoctorProbes` + a fixture chat.db stand in throughout.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AuditEvent, Clock, FsWatcher, Store } from '@wemessage/core';
import { SETTING_CONNECTION_STATE } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createClient, DaemonAuthError } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  AUTOMATION_DENIED,
  FDA_EPERM,
  MANUAL_REVOCATION,
  disconnectDaemon,
  readToken,
  startDaemon,
  type AuditSink,
  type DisconnectDeps,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const NO_EM_DASH = /—/;

// ---------------------------------------------------------------------------
// Pure unit: disconnectDaemon ordering + response shape
// ---------------------------------------------------------------------------

function fakeStore(initial: Record<string, string> = {}): Pick<
  Store,
  'getSetting' | 'setSetting' | 'clearAdapterTokens'
> & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getSetting: (key) => values.get(key) ?? null,
    setSetting: (key, value) => {
      values.set(key, value);
    },
    clearAdapterTokens: () => 0,
  };
}

function fakeSink(): Pick<AuditSink, 'append' | 'broadcast'> & {
  appends: { event: AuditEvent; actor: unknown }[];
  broadcasts: GatewayEventPayload[];
} {
  const appends: { event: AuditEvent; actor: unknown }[] = [];
  const broadcasts: GatewayEventPayload[] = [];
  return {
    appends,
    broadcasts,
    append: vi.fn((event: AuditEvent, actor: unknown) => {
      appends.push({ event, actor });
      return { seq: appends.length, hash: `h${appends.length}` };
    }),
    broadcast: vi.fn((payload: GatewayEventPayload) => {
      broadcasts.push(payload);
    }),
  };
}

describe('disconnectDaemon — ordering (§1.3.7)', () => {
  it('executes watcher-stop, state, tokens, event, close-clients, rotation in that exact order', () => {
    const order: string[] = [];
    const store = fakeStore({ [SETTING_CONNECTION_STATE]: 'fully-connected' });
    const originalSetSetting = store.setSetting;
    store.setSetting = (key, value) => {
      if (key === SETTING_CONNECTION_STATE && value === 'disconnected') {
        order.push('state');
      }
      originalSetSetting(key, value);
    };
    store.clearAdapterTokens = () => {
      order.push('tokens');
      return 0;
    };
    const sink = fakeSink();
    const originalAppend = sink.append;
    sink.append = vi.fn((event: AuditEvent, actor: unknown) => {
      if (event.type === 'gateway.disconnected') order.push('event');
      return originalAppend(event, actor);
    });

    const deps: DisconnectDeps = {
      store,
      sink,
      stopWatcher: () => order.push('watcher-stop'),
      closeEventClients: () => order.push('close-clients'),
      rotateToken: () => {
        order.push('rotation');
        return 'wm_' + 'a'.repeat(64);
      },
      purge: () => order.push('purge'),
    };

    disconnectDaemon(deps, { purge: false });

    expect(order).toEqual([
      'watcher-stop',
      'state',
      'tokens',
      'event',
      'close-clients',
      'rotation',
    ]);
  });

  it('broadcasts the gateway.disconnected WS twin BEFORE closing event clients', () => {
    const order: string[] = [];
    const store = fakeStore();
    const sink = fakeSink();
    const originalBroadcast = sink.broadcast;
    sink.broadcast = vi.fn((payload: GatewayEventPayload) => {
      if (payload.event === 'gateway.disconnected') order.push('broadcast');
      originalBroadcast(payload);
    });
    disconnectDaemon(
      {
        store,
        sink,
        stopWatcher: () => {},
        closeEventClients: () => order.push('close-clients'),
        rotateToken: () => 'wm_' + 'b'.repeat(64),
        purge: () => {},
      },
      { purge: false },
    );
    expect(order).toEqual(['broadcast', 'close-clients']);
  });
});

describe('disconnectDaemon — response shape (§1.3.7)', () => {
  it('returns 6 steps + manualRevocation, verbatim-pinned to doctor.ts remediation copy', () => {
    const store = fakeStore({ [SETTING_CONNECTION_STATE]: 'read-only' });
    const sink = fakeSink();
    const report = disconnectDaemon(
      {
        store,
        sink,
        stopWatcher: () => {},
        closeEventClients: () => {},
        rotateToken: () => 'wm_' + 'c'.repeat(64),
        purge: () => {},
      },
      { purge: false },
    );

    expect(report.state).toBe('disconnected');
    expect(report.steps).toEqual([
      { id: 'watcher-stop', status: 'done' },
      { id: 'state', status: 'done' },
      {
        id: 'adapter-tokens',
        status: 'done',
        detail: 'revoked 0 adapter token(s)',
      },
      { id: 'token-rotation', status: 'done' },
      {
        id: 'launchd',
        status: 'skipped',
        detail: 'not running under launchd (dev mode)',
      },
      { id: 'purge', status: 'skipped', detail: 'purge not requested' },
    ]);
    expect(report.manualRevocation).toEqual(MANUAL_REVOCATION);
    expect(report.manualRevocation).toEqual([AUTOMATION_DENIED, FDA_EPERM]);
    for (const s of report.manualRevocation) {
      expect(NO_EM_DASH.test(s)).toBe(false);
    }

    expect(sink.appends[0]).toEqual({
      event: {
        type: 'connection.state-changed',
        from: 'read-only',
        to: 'disconnected',
      },
      actor: { kind: 'human', via: 'api' },
    });
    expect(sink.appends[1]).toEqual({
      event: {
        type: 'gateway.disconnected',
        reason: 'user-disconnect',
        revokedAdapterTokens: 0,
        purge: false,
      },
      actor: { kind: 'human', via: 'api' },
    });
  });

  it('purge:true -> the purge step is "done" and the injected purge() runs', () => {
    const store = fakeStore();
    const sink = fakeSink();
    let purged = false;
    const report = disconnectDaemon(
      {
        store,
        sink,
        stopWatcher: () => {},
        closeEventClients: () => {},
        rotateToken: () => 'wm_' + 'd'.repeat(64),
        purge: () => {
          purged = true;
        },
      },
      { purge: true },
    );
    expect(purged).toBe(true);
    expect(report.steps.at(-1)).toEqual({
      id: 'purge',
      status: 'done',
      detail: 'store closed, config directory deleted',
    });
  });

  it('a failed token rewrite records token-rotation as "failed", not thrown', () => {
    const store = fakeStore();
    const sink = fakeSink();
    const report = disconnectDaemon(
      {
        store,
        sink,
        stopWatcher: () => {},
        closeEventClients: () => {},
        rotateToken: () => null,
        purge: () => {},
      },
      { purge: false },
    );
    expect(report.steps.find((s) => s.id === 'token-rotation')).toEqual({
      id: 'token-rotation',
      status: 'failed',
      detail: 'could not rewrite the token file',
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: startDaemon + POST /v1/disconnect over HTTP/WS
// ---------------------------------------------------------------------------

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const fullyConnectedProbes: DoctorProbes = {
  osMajor: () => 15,
  fda: async () => 'ok',
  automation: async () => 'ok',
  messagesRunning: async () => true,
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
  chatDbPath: string;
  chatId: number;
  handleId: number;
  baseUrl: string;
  token: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-disconnect-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');

  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle('+15550009999');
  const chatId = fixture.addChat({
    identifier: '+15550009999',
    handleIds: [handleId],
  });

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
    chatDbPath,
    chatId,
    handleId,
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    token,
  };
}

function connectWs(
  baseUrl: string,
  token: string,
): Promise<{
  frames: GatewayEventPayload[];
  socket: WebSocket;
  closed: Promise<void>;
}> {
  const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const frames: GatewayEventPayload[] = [];
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as GatewayEventPayload);
  });
  const closed = new Promise<void>((resolve) => socket.on('close', resolve));
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve({ frames, socket, closed }));
    socket.on('error', reject);
  });
}

describe('POST /v1/disconnect — row 1: watcher-stop drain window', () => {
  it('firing the watcher after disconnect produces no ingestion', async () => {
    const ctx = await boot();
    const disconnectRes = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {},
    });
    expect(disconnectRes.statusCode).toBe(200);

    const newToken = readToken(ctx.configDir);
    if (newToken === null) throw new Error('expected a rotated token');
    const ws = await connectWs(ctx.baseUrl, newToken);
    cleanups.push(() => ws.socket.close());
    await waitFor(() => ws.frames.length >= 1, 'disconnected greeting');
    expect(ws.frames[0]).toEqual({
      event: 'connection.state',
      state: 'disconnected',
    });

    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX should never be ingested post-disconnect',
    });
    ctx.watcher.fire();
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.frames).toHaveLength(1); // greeting only, no message.received
  });
});

describe('POST /v1/disconnect — row 2: state persisted, fail-closed, survives a restart', () => {
  it('gate denies POST /v1/send with 403 immediately after disconnect', async () => {
    const ctx = await boot();
    await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {},
    });
    const newToken = readToken(ctx.configDir);
    if (newToken === null) throw new Error('expected a rotated token');

    const res = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${newToken}` },
      payload: { chatGuid: 'iMessage;-;+15550009999', body: 'nope' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'gate-denied',
      reason: 'disconnected',
    });
  });

  it('the disconnected state survives a full daemon restart against the same configDir', async () => {
    const ctx = await boot();
    await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {},
    });
    await ctx.daemon.stop();

    const watcher2 = fakeWatcher();
    const daemon2 = await startDaemon({
      configDir: ctx.configDir,
      chatDbPath: ctx.chatDbPath,
      clock,
      watcher: watcher2,
      doctorProbes: fullyConnectedProbes,
      backend: createUnusedSendBackend(),
      backendName: 'unused',
    });
    cleanups.push(() => daemon2.stop());

    const status = await daemon2.server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: {
        authorization: `Bearer ${readToken(ctx.configDir) ?? ''}`,
      },
    });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { connectionState: string }).connectionState).toBe(
      'disconnected',
    );
  });
});

describe('POST /v1/disconnect — row 3: adapter tokens revoked, audited, broadcast ordering', () => {
  it('NULLs token_hash on every adapter without deleting the row; audits the count; WS frame precedes socket close', async () => {
    const ctx = await boot();
    ctx.daemon.store.db
      .prepare(
        'INSERT INTO adapters (id, kind, display_name, token_hash) VALUES (?, ?, ?, ?)',
      )
      .run('sol', 'sol', 'Sol', 'hash-1');
    ctx.daemon.store.db
      .prepare(
        'INSERT INTO adapters (id, kind, display_name, token_hash) VALUES (?, ?, ?, ?)',
      )
      .run('hermes', 'hermes', 'Hermes', 'hash-2');

    const ws = await connectWs(ctx.baseUrl, ctx.token);
    const log: string[] = [];
    ws.socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as GatewayEventPayload;
      log.push(frame.event);
    });
    ws.socket.on('close', () => log.push('close'));

    const res = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      steps: { id: string; status: string; detail?: string }[];
    };
    const tokensStep = body.steps.find((s) => s.id === 'adapter-tokens');
    expect(tokensStep).toEqual({
      id: 'adapter-tokens',
      status: 'done',
      detail: 'revoked 2 adapter token(s)',
    });

    const rows = ctx.daemon.store.db
      .prepare('SELECT id, token_hash FROM adapters WHERE id IN (?, ?)')
      .all('sol', 'hermes') as { id: string; token_hash: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.token_hash === null)).toBe(true);

    const auditRows = ctx.daemon.store
      .readAuditRows(0, 1000)
      .map((r) => JSON.parse(r.eventJson) as AuditEvent);
    const disconnectAudit = auditRows.find(
      (e) => e.type === 'gateway.disconnected',
    );
    expect(disconnectAudit).toEqual({
      type: 'gateway.disconnected',
      reason: 'user-disconnect',
      revokedAdapterTokens: 2,
      purge: false,
    });

    await ws.closed;
    // greeting + connection.state + gateway.disconnected all land as
    // messages BEFORE the socket close — the frame reliably precedes close().
    const closeIdx = log.indexOf('close');
    const disconnectIdx = log.indexOf('gateway.disconnected');
    expect(disconnectIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBe(log.length - 1);
    expect(disconnectIdx).toBeLessThan(closeIdx);
  });
});

describe('POST /v1/disconnect — row 4: old bearer 401s immediately, new token is well-formed', () => {
  it('rejects the pre-disconnect bearer without a restart; the new token file is wm_-prefixed, 64 hex chars', async () => {
    const ctx = await boot();
    await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {},
    });

    const oldClient = createClient({ baseUrl: ctx.baseUrl, token: ctx.token });
    await expect(oldClient.status()).rejects.toBeInstanceOf(DaemonAuthError);

    const rotated = readToken(ctx.configDir);
    expect(rotated).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(rotated).not.toBe(ctx.token);
  });
});

describe('POST /v1/disconnect — rows 5+6: launchd honesty + manual revocation copy', () => {
  it('response includes the exact launchd-skipped step and the pinned manualRevocation array', async () => {
    const ctx = await boot();
    const res = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: {},
    });
    const body = res.json() as {
      steps: { id: string; status: string; detail?: string }[];
      manualRevocation: string[];
    };
    expect(body.steps.find((s) => s.id === 'launchd')).toEqual({
      id: 'launchd',
      status: 'skipped',
      detail: 'not running under launchd (dev mode)',
    });
    expect(body.manualRevocation).toEqual([AUTOMATION_DENIED, FDA_EPERM]);
    for (const s of body.manualRevocation) {
      expect(NO_EM_DASH.test(s)).toBe(false);
    }
  });
});

describe('POST /v1/disconnect — row 7: purge deletes the config dir and 503s everything after', () => {
  it('purge:true removes configDir; subsequent requests 503; daemon.stop() does not throw', async () => {
    const ctx = await boot();
    const res = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { purge: true },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(ctx.configDir)).toBe(false);

    const health = await ctx.daemon.server.app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ error: 'no-auth-token' });

    const send = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: 'Bearer whatever' },
      payload: { chatGuid: 'iMessage;-;+15550009999', body: 'x' },
    });
    expect(send.statusCode).toBe(503);

    await expect(ctx.daemon.stop()).resolves.toBeUndefined();
  });
});

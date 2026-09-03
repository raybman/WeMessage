/**
 * Scenario 8 — POST /v1/send + GET /v1/doctor (s3-execution §1.6 routes).
 * ★ CHECKPOINT.
 *
 * POST /v1/send is the human-direct mint-then-dispatch path (§1.5 body
 * extension): a human names a `chatGuid` (handle-style, "service;-;handle")
 * + `body`; the route mints an already-'approved' Draft against the F-22
 * reserved 'human' adapter row, mints a matching Approval, then dispatches
 * through the real `dispatchApproved` (core, Scenario 6) — never a bespoke
 * reimplementation of gate/verify logic in the route.
 *
 * Real store (temp dir) + real ingest `ChatDbReader` over a fixture chat.db
 * (never mocked — `resolveChat`/`findOutboundMessage` are the real SQL) +
 * `LoopbackSendBackend` (test/helpers/loopback-backend.ts) standing in for
 * AppleScript (test/arch.spec.ts gate (a)/(b): no real osascript in any
 * test, ever). `delay` advances the harness's own fake Clock instead of
 * sleeping wall-clock time, so the row-2 unverified-timeout case (a real
 * 10s VERIFY_BUDGET_MS budget) runs in milliseconds.
 *
 * Six rows:
 *  1. verified send -> 200 {outcome:'sent'}; audit chain draft.created ->
 *     draft.approved -> send.attempted -> draft.sent; WS broadcasts all four
 *     wire events (draft.created/approved/sent — send.attempted has no wire
 *     event, audit-only per §1.8).
 *  2. backend accepts but never lands (`.sabotage()`) -> 200 failed
 *     {code:'unverified', message: the exact copy dispatcher.ts pins}.
 *  3. new recipient (no fixture chat for the handle) -> 200 failed
 *     no-conversation; backend never invoked.
 *  4. group-chat target (handle resolves ONLY via a group chat's
 *     chat_handle_join, exercising the post-resolveChat isGroup branch, not
 *     the parseChatGuid format short-circuit) -> 200 failed
 *     group-send-disabled; backend never invoked.
 *  5. all three gate-denied states (kill-switch, disconnected, read-only)
 *     -> 403 {error:'gate-denied', reason}; WS gate.denied reshapes the
 *     core DispatchGateDenied (no chatGuid) into the wire event (chatGuid
 *     added from the draft — INV-1: core can't know the wire shape).
 *  6. auth posture inherited unchanged: no bearer -> 401; no obtainable
 *     token -> 503.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AuditEvent, Clock } from '@wemessage/core';
import { SETTING_CONNECTION_STATE, SETTING_KILL_SWITCH } from '@wemessage/core';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { openStore, type SqliteStore } from '@wemessage/store';
import { buildServer, startServer, type DaemonServer } from '@wemessage/daemon';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  createLoopbackSendBackend,
  createUnusedChatDbReader,
  createUnusedSendBackend,
  type LoopbackSendBackend,
} from './helpers/loopback-backend.js';

const T0 = '2026-09-01T12:00:00.000Z';

interface ClockCtl {
  clock: Clock;
  advance(ms: number): void;
}
function fakeClock(startIso = T0): ClockCtl {
  let now = new Date(startIso).getTime();
  return {
    clock: {
      now: () => new Date(now).toISOString(),
      nowMs: () => now,
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

const dirs: string[] = [];
const stores: SqliteStore[] = [];
const readers: IngestChatDbReader[] = [];
const fixtureHandles: ChatDbFixture[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const r of readers.splice(0)) r.close();
  for (const f of fixtureHandles.splice(0)) f.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

interface Harness {
  server: DaemonServer;
  store: SqliteStore;
  fixture: ChatDbFixture;
  backend: LoopbackSendBackend;
  clockCtl: ClockCtl;
  headers: { authorization: string };
}

/** Real fully-connected gate state by default (§2.4.1: unset -> disconnected -> gate-denied). */
async function boot(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-send-verify-'));
  dirs.push(dir);
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  fixtureHandles.push(fixture);

  const clockCtl = fakeClock();
  const store = openStore({ dir, clock: clockCtl.clock });
  stores.push(store);
  store.setSetting(SETTING_CONNECTION_STATE, 'fully-connected');

  const reader = createChatDbReader(chatDbPath, { clock: clockCtl.clock });
  readers.push(reader);
  const backend = createLoopbackSendBackend(fixture, clockCtl.clock);

  const server = await buildServer({
    configDir: dir,
    send: {
      store,
      reader,
      backend,
      backendName: 'loopback',
      clock: clockCtl.clock,
      // advance the SAME injected clock instead of a real sleep — the
      // row-2 case burns a full 10s VERIFY_BUDGET_MS in test time this way.
      delay: (ms: number) => {
        clockCtl.advance(ms);
        return Promise.resolve();
      },
      doctorProbes: {
        osMajor: () => 15,
        fda: async () => 'ok',
        automation: async () => 'ok',
        messagesRunning: async () => true,
      },
    },
  });
  servers.push(server);
  if (server.token === null) throw new Error('harness: no token');
  return {
    server,
    store,
    fixture,
    backend,
    clockCtl,
    headers: { authorization: `Bearer ${server.token}` },
  };
}

interface ParsedAudit {
  type: string;
  [key: string]: unknown;
}
function auditTrail(store: SqliteStore): ParsedAudit[] {
  return store
    .readAuditRows(0, 1000)
    .map((row) => JSON.parse(row.eventJson) as AuditEvent as ParsedAudit);
}

async function send(
  h: Harness,
  body: { chatGuid: string; body: string },
): Promise<{ statusCode: number; json: unknown }> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: h.headers,
    payload: body,
  });
  return { statusCode: res.statusCode, json: res.json() };
}

async function collectWs(h: Harness): Promise<{
  frames: GatewayEventPayload[];
  close: () => void;
}> {
  const port = await startServer(h.server);
  const frames: GatewayEventPayload[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, {
    headers: h.headers,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  socket.on('message', (data) => {
    frames.push(JSON.parse(String(data)) as GatewayEventPayload);
  });
  return { frames, close: () => socket.close() };
}

describe('POST /v1/send — row 1: verified send (§2.2.2 full loop)', () => {
  it('200 {outcome:"sent"}; audit chain created->approved->attempted->sent; WS broadcasts every wire event', async () => {
    const h = await boot();
    const handleId = h.fixture.addHandle('+15551234567');
    h.fixture.addChat({ identifier: '+15551234567', handleIds: [handleId] });
    const ws = await collectWs(h);

    const res = await send(h, {
      chatGuid: 'iMessage;-;+15551234567',
      body: 'hello from the human-direct path',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json as {
      draftId: string;
      outcome: string;
      sentMessageGuid: string;
    };
    expect(body.outcome).toBe('sent');
    expect(typeof body.sentMessageGuid).toBe('string');
    expect(h.backend.callCount()).toBe(1);

    expect(auditTrail(h.store).map((e) => e.type)).toEqual([
      'draft.created',
      'draft.approved',
      'send.attempted',
      'draft.sent',
    ]);

    await sleep(200);
    ws.close();
    const events = ws.frames.map((f) => f.event);
    expect(events).toEqual(['draft.created', 'draft.approved', 'draft.sent']);
    const sentFrame = ws.frames.find((f) => f.event === 'draft.sent') as {
      event: 'draft.sent';
      draftId: string;
      sentMessageGuid: string;
    };
    expect(sentFrame.draftId).toBe(body.draftId);
    expect(sentFrame.sentMessageGuid).toBe(body.sentMessageGuid);
  });
});

describe('POST /v1/send — row 2: backend accepts but never lands', () => {
  it('200 failed {code:"unverified"} with the pinned copy, after burning the full verify budget', async () => {
    const h = await boot();
    const handleId = h.fixture.addHandle('+15559990000');
    h.fixture.addChat({ identifier: '+15559990000', handleIds: [handleId] });
    h.backend.sabotage();

    const res = await send(h, {
      chatGuid: 'iMessage;-;+15559990000',
      body: 'this will never verify',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json as {
      outcome: string;
      error: { code: string; message: string };
    };
    expect(body.outcome).toBe('failed');
    expect(body.error.code).toBe('unverified');
    expect(body.error.message).toBe(
      'send accepted but could not confirm in Messages history within 10s',
    );
    expect(h.backend.callCount()).toBe(1);
  });
});

describe('POST /v1/send — row 3: new recipient, no existing conversation', () => {
  it('200 failed {code:"no-conversation"}; backend never invoked', async () => {
    const h = await boot();
    // deliberately no addHandle/addChat for this handle at all

    const res = await send(h, {
      chatGuid: 'iMessage;-;+15559998888',
      body: 'first contact',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json as { outcome: string; error: { code: string } };
    expect(body.outcome).toBe('failed');
    expect(body.error.code).toBe('no-conversation');
    expect(h.backend.callCount()).toBe(0);
  });
});

describe('POST /v1/send — row 4: target resolves to a group chat', () => {
  it('200 failed {code:"group-send-disabled"} (post-resolveChat branch, not the chatGuid-format short-circuit); backend never invoked', async () => {
    const h = await boot();
    const handleA = h.fixture.addHandle('+15552223333');
    const handleB = h.fixture.addHandle('+15554445555');
    // handleA is linked ONLY via the group chat's chat_handle_join — no
    // separate 1:1 chat exists for it — so parseChatGuid sees a normal
    // one-to-one guid (isGroup:false) and only resolveChat's participant
    // count (2) discovers the group.
    h.fixture.addGroupChat([handleA, handleB]);

    const res = await send(h, {
      chatGuid: 'iMessage;-;+15552223333',
      body: 'group targets are not sendable in S3',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json as { outcome: string; error: { code: string } };
    expect(body.outcome).toBe('failed');
    expect(body.error.code).toBe('group-send-disabled');
    expect(h.backend.callCount()).toBe(0);
  });
});

describe('POST /v1/send — row 5: gate denies (all three §2.4.1 deny reasons)', () => {
  it.each([
    [
      'kill-switch',
      () => {
        return { key: SETTING_KILL_SWITCH, value: '1' };
      },
    ],
    [
      'disconnected',
      () => {
        return { key: SETTING_CONNECTION_STATE, value: 'disconnected' };
      },
    ],
    [
      'read-only',
      () => {
        return { key: SETTING_CONNECTION_STATE, value: 'read-only' };
      },
    ],
  ] as const)(
    '%s -> 403 {error:"gate-denied", reason}; WS gate.denied carries reason+chatGuid+draftId',
    async (reason, setDenyState) => {
      const h = await boot();
      const handleId = h.fixture.addHandle('+15550001111');
      h.fixture.addChat({ identifier: '+15550001111', handleIds: [handleId] });
      const denyState = setDenyState();
      h.store.setSetting(denyState.key, denyState.value);
      const ws = await collectWs(h);

      const res = await send(h, {
        chatGuid: 'iMessage;-;+15550001111',
        body: 'should never leave the gate',
      });

      expect(res.statusCode).toBe(403);
      expect(res.json).toEqual({ error: 'gate-denied', reason });
      expect(h.backend.callCount()).toBe(0);

      await sleep(200);
      ws.close();
      const denial = ws.frames.find((f) => f.event === 'gate.denied') as {
        event: 'gate.denied';
        reason: string;
        chatGuid: string;
        draftId?: string;
      };
      expect(denial).toBeDefined();
      expect(denial.reason).toBe(reason);
      expect(denial.chatGuid).toBe('iMessage;-;+15550001111');
      expect(typeof denial.draftId).toBe('string');
    },
  );
});

describe('POST /v1/send — row 6: auth posture inherited unchanged (§2.4.2/§2.6)', () => {
  it('no bearer -> 401', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/send',
      payload: { chatGuid: 'iMessage;-;+15550001111', body: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('no obtainable token -> 503 (unwritable configDir, first-run self-heal fails)', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'wm-send-verify-store-'));
    dirs.push(storeDir);
    const configDir = mkdtempSync(join(tmpdir(), 'wm-send-verify-cfg-'));
    dirs.push(configDir);
    const clockCtl = fakeClock();
    const store = openStore({ dir: storeDir, clock: clockCtl.clock });
    stores.push(store);
    chmodSync(configDir, 0o500);

    const server = await buildServer({
      configDir,
      send: {
        store,
        reader: createUnusedChatDbReader(),
        backend: createUnusedSendBackend(),
        backendName: 'unused',
        clock: clockCtl.clock,
        delay: () => Promise.resolve(),
        doctorProbes: {
          osMajor: () => 15,
          fda: async () => 'ok',
          automation: async () => 'ok',
          messagesRunning: async () => true,
        },
      },
    });
    servers.push(server);
    expect(server.token).toBeNull();

    const res = await server.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: 'Bearer whatever' },
      payload: { chatGuid: 'iMessage;-;+15550001111', body: 'x' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'no-auth-token' });
  });
});

/**
 * v2 F7c: the facts `GET /v1/status` carries on a real startDaemon().
 *
 *  - lastSyncAt is the last scan BURST (cursor.lastScanAt), not the last row:
 *    a quiet burst still moves it, an old row does not drag it back.
 *  - FDA revoked mid-run freezes lastSyncAt where the last good burst left
 *    it, keeps the mirror (the copy is still on this Mac) and drops the
 *    handle (the reader is closed, so it does not say whose it is).
 *  - The mirror is recounted only when the cursor or index mark moves.
 *  - Only the connected iMessage entry carries facts; the store-less
 *    fallback carries no asOf and no mirror.
 *  - The mirror path on the wire is `~`-abbreviated, never absolute.
 *  - The operator's handle reaches the status payload and nothing else: not
 *    the audit log, the SSE stream, a /v1/agent frame, wemessage.db or its
 *    WAL, or an onError log.
 *  - Status is the operator's: 401 without a bearer, 401 on an adapter token.
 *
 * Every chat.db is a synthetic fixture in tmp; every number is +1555 and
 * every address example.com. Nothing reads ~/Library/Messages or Contacts.
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import {
  createChatDbReader,
  type FdaProbeResult,
  type IngestChatDbReader,
} from '@wemessage/ingest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { DB_FILENAME } from '@wemessage/store';
import {
  buildServer,
  createStatusFacts,
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { openSse } from './helpers/sse-client.js';
import {
  boot as bootHarness,
  cleanupHarness,
} from './helpers/draft-harness.js';

const ME = '+15550100000';
const THEM = '+15556660000';
const T0 = '2026-10-10T15:00:00.000Z';

interface SettableClock extends Clock {
  set(iso: string): void;
  advance(ms: number): string;
}
function settableClock(start: string): SettableClock {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    set: (iso) => {
      ms = Date.parse(iso);
    },
    advance: (by) => {
      ms += by;
      return new Date(ms).toISOString();
    },
  };
}

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

interface Probes extends DoctorProbes {
  setFda(v: FdaProbeResult): void;
}
function probes(): Probes {
  let fda: FdaProbeResult = 'ok';
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

/** Delegates to the real fixture reader until armed, then EACCES. */
function controllableOpenReader(): {
  openReader: (
    path: string,
    options: Parameters<typeof createChatDbReader>[1],
  ) => IngestChatDbReader;
  arm(): void;
} {
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    openReader: (path, options) => {
      if (!armed) return createChatDbReader(path, options);
      const err = Object.assign(new Error('EACCES: permission denied'), {
        code: 'EACCES',
      });
      const boom = (): never => {
        throw err;
      };
      return {
        isReadonly: () => true,
        openMode: 'immutable',
        rawDb: null as never,
        readSince: boom,
        readMutatedSince: boom,
        resolveChat: boom,
        findOutboundMessage: boom,
        readChatTurns: boom,
        listChats: boom,
        readChatPage: boom,
        chatTitles: boom,
        chatsTitled: boom,
        existingGuids: boom,
        yearCounts: boom,
        ownHandle: boom,
        close: () => undefined,
      };
    },
  };
}

interface Ctx {
  root: string;
  configDir: string;
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  clock: SettableClock;
  watcher: FakeWatcher;
  probes: Probes;
  openReader: ReturnType<typeof controllableOpenReader>;
  chatId: number;
  handleId: number;
  token: string;
  errors: string[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function boot(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), 'wm-status-fields-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configDir = join(root, 'config');
  const chatDbPath = join(root, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle(THEM);
  const chatId = fixture.addChat({ identifier: THEM, handleIds: [handleId] });
  // Yesterday (UTC), sent by me: in the mirror, not "today".
  fixture.addMessage({
    chatId,
    text: 'status-fields yesterday',
    at: '2026-10-09T22:00:00.000Z',
    isFromMe: true,
    callerId: ME,
  });
  // Today, inbound: its caller id is the account it arrived on, and the
  // handle is read from sent rows only.
  fixture.addMessage({
    chatId,
    handleId,
    text: 'status-fields inbound today',
    at: '2026-10-10T08:00:00.000Z',
    callerId: 'other@example.com',
  });
  // Today, sent by me over iMessage: the handle's source.
  fixture.addMessage({
    chatId,
    text: 'status-fields sent today',
    at: '2026-10-10T09:00:00.000Z',
    isFromMe: true,
    callerId: ME,
  });

  const clock = settableClock(T0);
  const watcher = fakeWatcher();
  const p = probes();
  const openReader = controllableOpenReader();
  const errors: string[] = [];
  const daemon = await startDaemon({
    autonomy: 'live',
    configDir,
    chatDbPath,
    clock,
    watcher,
    doctorProbes: p,
    backend: {
      isAvailable: () => Promise.resolve(false),
      send: () =>
        Promise.resolve({ accepted: false, errorCode: 'messages-not-running' }),
    },
    backendName: 'status-fields-fake',
    scanOpenReader: openReader.openReader,
    zone: 'UTC',
    homeDir: root,
    onError: (e) => {
      errors.push(
        e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
      );
    },
  });
  cleanups.push(() => daemon.stop());
  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  return {
    root,
    configDir,
    daemon,
    fixture,
    clock,
    watcher,
    probes: p,
    openReader,
    chatId,
    handleId,
    token,
    errors,
  };
}

interface Channel {
  channel: string;
  state: string;
  reason?: string;
  lastSyncAt?: string | null;
  today?: number;
  handle?: string | null;
}
interface Status {
  connectionState: string;
  cursor: { lastRowid: number; lastScanAt: string } | null;
  counts: { messagesToday: number };
  channels: Channel[];
  asOf?: string;
  mirror?: {
    path: string;
    bytes: number;
    messages: number;
    chats: number;
    historyFrom: string | null;
    phase: string;
    indexed: number;
    eligible: number;
    countedAt: string;
  };
}

async function statusRaw(
  ctx: Ctx,
): Promise<{ statusCode: number; body: string; json: Status }> {
  const res = await ctx.daemon.server.app.inject({
    method: 'GET',
    url: '/v1/status',
    headers: { authorization: `Bearer ${ctx.token}` },
  });
  return { statusCode: res.statusCode, body: res.body, json: res.json() };
}
async function status(ctx: Ctx): Promise<Status> {
  return (await statusRaw(ctx)).json;
}
function imessage(s: Status): Channel {
  const c = s.channels.find((x) => x.channel === 'imessage');
  if (c === undefined) throw new Error('no imessage entry');
  return c;
}

async function waitFor(
  ctx: Ctx,
  pred: (s: Status) => boolean,
  label: string,
  ms = 3000,
): Promise<Status> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await status(ctx);
    if (pred(s)) return s;
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${label}; last ${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('status facts on the composed daemon (v2 F7c)', () => {
  it('lastSyncAtIsLastBurstNotLastRow', async () => {
    const ctx = await boot();
    const booted = await status(ctx);
    // The boot catch-up burst ran at T0 and copied all three rows.
    expect(imessage(booted).lastSyncAt).toBe(T0);
    expect(booted.cursor?.lastScanAt).toBe(T0);
    expect(imessage(booted).today).toBe(2);
    expect(booted.counts.messagesToday).toBe(2);
    expect(imessage(booted).handle).toBe(ME);
    expect(booted.asOf).toBe(T0);

    // A burst that copies a row sent an hour BEFORE T0: lastSyncAt is the
    // burst's time, not the row's.
    const t1 = ctx.clock.advance(30_000);
    const before = booted.cursor?.lastRowid ?? -1;
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'status-fields late arrival',
      at: '2026-10-10T14:00:00.000Z',
    });
    ctx.watcher.fire();
    const moved = await waitFor(
      ctx,
      (s) => (s.cursor?.lastRowid ?? -1) > before,
      'the row was copied',
    );
    expect(imessage(moved).lastSyncAt).toBe(t1);
    expect(imessage(moved).today).toBe(3);
    expect(moved.asOf).toBe(t1);

    // A burst that copies nothing still moves it.
    const t2 = ctx.clock.advance(45_000);
    ctx.watcher.fire();
    const quiet = await waitFor(
      ctx,
      (s) => imessage(s).lastSyncAt === t2,
      'the quiet burst landed',
    );
    expect(quiet.cursor?.lastRowid).toBe(moved.cursor?.lastRowid);
  });

  it('fdaRevokedFreezesLastSyncAt', async () => {
    const ctx = await boot();
    await waitFor(ctx, (s) => s.connectionState === 'fully-connected', 'up');
    const good = await status(ctx);
    expect(imessage(good).handle).toBe(ME);
    expect(good.mirror?.messages).toBe(3);

    ctx.openReader.arm();
    ctx.probes.setFda('eperm');
    const later = ctx.clock.advance(60_000);
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'status-fields never copied',
      at: '2026-10-10T15:00:30.000Z',
    });
    ctx.watcher.fire();
    const down = await waitFor(
      ctx,
      (s) => s.connectionState === 'disconnected',
      'FDA revoked',
    );
    const im = imessage(down);
    expect(im.lastSyncAt).toBe(T0);
    expect(down.cursor?.lastScanAt).toBe(T0);
    expect(im.handle).toBeNull();
    expect(down.asOf).toBe(later);
    expect(down.mirror).toBeDefined();
    expect(down.mirror?.messages).toBe(3);
    expect(down.mirror?.path).toBe(`~/config/${DB_FILENAME}`);
  });

  it('mirrorRecountOnlyWhenCursorMoves', async () => {
    const ctx = await boot();
    await status(ctx);
    const first = ctx.daemon.statusRecounts();
    expect(first).toBe(1);
    for (let i = 0; i < 100; i += 1) {
      ctx.clock.advance(10_000);
      await status(ctx);
    }
    expect(ctx.daemon.statusRecounts()).toBe(1);

    // The cursor moves: the next status recounts, once.
    const before = (await status(ctx)).cursor?.lastRowid ?? -1;
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'status-fields recount',
      at: '2026-10-10T16:00:00.000Z',
    });
    ctx.watcher.fire();
    await waitFor(
      ctx,
      (s) => (s.cursor?.lastRowid ?? -1) > before,
      'the cursor moved',
    );
    // The index step after the burst moves the mark too: give the cache a
    // read past the 5 s floor, then it holds again.
    ctx.clock.advance(6_000);
    const recounted = await status(ctx);
    expect(recounted.mirror?.messages).toBe(4);
    const after = ctx.daemon.statusRecounts();
    expect(after).toBeGreaterThan(1);
    for (let i = 0; i < 100; i += 1) {
      ctx.clock.advance(10_000);
      await status(ctx);
    }
    expect(ctx.daemon.statusRecounts()).toBe(after);
  });

  it('the recount waits out its 5 s floor even while the cursor moves', () => {
    let rowid = 1;
    let nowMs = Date.parse(T0);
    const clock: Clock = {
      now: () => new Date(nowMs).toISOString(),
      nowMs: () => nowMs,
    };
    let counted = 0;
    const facts = createStatusFacts({
      store: {
        getCursor: () => ({ lastRowid: rowid, lastScanAt: clock.now() }),
        countSentSince: () => 0,
        mirrorCounts: () => {
          counted += 1;
          return { messages: rowid, chats: 1, historyFrom: null };
        },
        searchCoverage: () => ({
          indexed: rowid,
          eligible: rowid,
          throughRowid: rowid,
          mirrorAsOf: null,
        }),
        getSetting: () => null,
      },
      clock,
      zone: 'UTC',
      displayPath: '~/x/wemessage.db',
      statBytes: () => 0,
      ownHandle: () => ME,
    });
    expect(facts.mirror().messages).toBe(1);
    // Moving every second for 4 s: still the first count.
    for (let i = 0; i < 4; i += 1) {
      rowid += 1;
      nowMs += 1_000;
      expect(facts.mirror().messages).toBe(1);
    }
    nowMs += 1_000;
    expect(facts.mirror().messages).toBe(rowid);
    expect(counted).toBe(2);
    expect(facts.recounts()).toBe(2);
  });

  it('notConnectedCarriesNoFacts', async () => {
    const ctx = await boot();
    const s = await status(ctx);
    for (const entry of s.channels) {
      if (entry.channel === 'imessage') {
        expect(entry.state).toBe('connected');
        expect(Object.keys(entry).sort()).toEqual(
          ['channel', 'handle', 'lastSyncAt', 'state', 'today'].sort(),
        );
        continue;
      }
      expect(entry).toEqual({
        channel: entry.channel,
        state: 'not_connected',
        reason: 'not_in_this_version',
      });
    }

    // The store-less fallback (no getStatus): no facts, no asOf, no mirror.
    const dir = mkdtempSync(join(tmpdir(), 'wm-status-fallback-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bare = await buildServer({ configDir: dir });
    cleanups.push(() => bare.app.close());
    const res = await bare.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${String(bare.token)}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('asOf');
    expect(body).not.toHaveProperty('mirror');
    for (const entry of body['channels'] as Channel[]) {
      expect(entry).not.toHaveProperty('lastSyncAt');
      expect(entry).not.toHaveProperty('today');
      expect(entry).not.toHaveProperty('handle');
    }

    // The store-backed fallback (the harness, no composed facts): none.
    const h = await bootHarness();
    cleanups.push(() => cleanupHarness());
    const r2 = await h.server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: h.headers,
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json() as Record<string, unknown>;
    expect(b2).not.toHaveProperty('asOf');
    expect(b2).not.toHaveProperty('mirror');
    for (const entry of b2['channels'] as Channel[]) {
      expect(entry).not.toHaveProperty('today');
    }
  });

  it('pathIsTildeNeverAbsolute', async () => {
    const ctx = await boot();
    const { body, json } = await statusRaw(ctx);
    expect(json.mirror?.path).toBe(`~/config/${DB_FILENAME}`);
    expect(body).not.toContain(ctx.root);
    expect(body).not.toContain(tmpdir());
    expect(json.mirror?.bytes).toBeGreaterThan(0);
    expect(json.mirror?.messages).toBe(3);
    expect(json.mirror?.chats).toBe(1);
    expect(json.mirror?.historyFrom).toBe('2026-10-09T22:00:00.000Z');
    expect(json.mirror?.countedAt).toBe(T0);
  });

  it('handleNeverInAuditSseOrAgent', async () => {
    const ctx = await boot();
    const base = `http://127.0.0.1:${String(ctx.daemon.port)}`;
    const sse = await openSse(base, '/v1/events/sse', {
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    cleanups.push(() => sse.close());

    const minted = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { id: 'echo', kind: 'echo', displayName: 'Echo' },
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;
    const frames: string[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(ctx.daemon.port)}/v1/agent`,
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          if (ws.readyState === ws.CLOSED) return resolve();
          ws.on('close', () => resolve());
          ws.close();
        }),
    );
    ws.on('message', (data) => frames.push(String(data)));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        v: 1,
        id: `01${'F'.repeat(24)}`,
        type: 'hello',
        ts: ctx.clock.now(),
        payload: { adapterId: 'echo', token: adapterToken, wire: 1 },
      }),
    );
    await waitFor(
      ctx,
      () => ctx.daemon.store.getAdapter('echo')?.health === 'connected',
      'adapter connected',
    );
    // A rule that hands every inbound row from the counterpart to the agent,
    // so a /v1/agent frame carries a copied message.
    const at = ctx.clock.now();
    ctx.daemon.store.insertRule({
      id: `${'0'.repeat(25)}1`,
      name: 'status-fields watch',
      enabled: true,
      matcher: { kind: 'keyword', keywords: ['watched'], mode: 'any' },
      adapterId: 'echo',
      respondMode: 'draft-only',
      scheduleId: null,
      outsideWindow: 'draft-only',
      allowGroupDrafts: false,
      matchAttachmentOnly: false,
      draftTtlMinutes: 240,
      priority: 100,
      createdAt: at,
      updatedAt: at,
    });
    ctx.daemon.store.setContactPolicy({
      handle: THEM,
      mode: 'draft-only',
      updatedAt: at,
    });
    const framesBefore = frames.length;

    // Traffic while everyone listens: a sent row with the caller id, an
    // inbound row, and status reads that do carry the handle.
    const before = (await status(ctx)).cursor?.lastRowid ?? -1;
    ctx.clock.advance(61_000);
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      text: 'status-fields sent while watched',
      at: '2026-10-10T15:01:00.000Z',
      isFromMe: true,
      callerId: ME,
    });
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'status-fields inbound while watched',
      at: '2026-10-10T15:01:01.000Z',
      callerId: ME,
    });
    ctx.watcher.fire();
    const s = await waitFor(
      ctx,
      (x) => (x.cursor?.lastRowid ?? -1) >= before + 2,
      'both rows copied',
    );
    expect(imessage(s).handle).toBe(ME);
    for (let i = 0; i < 5; i += 1) await status(ctx);
    await sse.waitForEvents(1, 'some event reached the stream');

    const audit = ctx.daemon.store
      .readAuditRows(0, 10_000)
      .map((r) => `${r.eventJson}${r.actorJson}`)
      .join('\n');
    expect(audit.length).toBeGreaterThan(0);
    expect(audit).not.toContain(ME);
    expect(sse.raw.length).toBeGreaterThan(0);
    expect(sse.raw).not.toContain(ME);
    await waitFor(ctx, () => frames.length > framesBefore, 'agent frame');
    expect(frames.slice(framesBefore).join('\n')).toContain('watched');
    expect(frames.join('\n')).not.toContain(ME);
    expect(ctx.errors.join('\n')).not.toContain(ME);

    // Nor in the mirror's own bytes: wemessage.db and its WAL.
    const db = join(ctx.configDir, DB_FILENAME);
    for (const file of [db, `${db}-wal`]) {
      if (!existsSync(file)) continue;
      expect(readFileSync(file).includes(Buffer.from(ME)), file).toBe(false);
    }
  });

  it('401 with no bearer, and 401 with an adapter token', async () => {
    const ctx = await boot();
    const minted = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { id: 'echo', kind: 'echo', displayName: 'Echo' },
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;
    for (const authorization of [
      null,
      `Bearer wm_${'0'.repeat(64)}`,
      `Bearer ${adapterToken}`,
      adapterToken,
    ]) {
      const res = await ctx.daemon.server.app.inject({
        method: 'GET',
        url: '/v1/status',
        headers: authorization === null ? {} : { authorization },
      });
      expect(res.statusCode, String(authorization)).toBe(401);
      expect(res.body).not.toContain(ME);
      expect(res.body).not.toContain('mirror');
    }
  });
});

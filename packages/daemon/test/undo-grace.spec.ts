/**
 * s4-execution Scenario 6 ★ CHECKPOINT — the undo window and the scheduler.
 *
 * The product promise being tested: after you approve, you get N seconds to
 * take it back, and when those seconds are up the message actually goes.
 * Both halves have to be true, and both have to survive a restart.
 *
 * Everything here is driven by a hand-advanced fake Clock and explicit
 * `tick()` calls. No interval, no wall-clock sleep, no timer. That is not
 * only a speed choice: an implementation that armed an in-memory timer at
 * approve time would pass a timer-based test and still lose every pending
 * send on restart. Row 5 is the one that catches it — approve, throw the
 * whole server away, rebuild against the same directory, tick past the
 * deadline, and demand exactly one send.
 *
 * Real store + real ingest ChatDbReader over a fixture chat.db + the
 * loopback backend (the S3 send-verify harness, reused). The verify half of
 * dispatchApproved therefore runs for real against real SQL.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Clock, Draft, Ulid } from '@wemessage/core';
import {
  dispatchApproved,
  SETTING_CONNECTION_STATE,
  SETTING_UNDO_GRACE_SECONDS,
} from '@wemessage/core';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { openStore, type SqliteStore } from '@wemessage/store';
import {
  buildServer,
  createAuditSink,
  createScheduler,
  type DaemonServer,
  type Scheduler,
} from '@wemessage/daemon';
import {
  createLoopbackSendBackend,
  type LoopbackSendBackend,
} from './helpers/loopback-backend.js';

const T0 = '2026-09-01T12:00:00.000Z';
/** The fixture handle that has a real 1:1 chat and verifies on send. */
const CHAT = 'iMessage;-;+15551234567';

interface ClockCtl {
  clock: Clock;
  advance(ms: number): void;
  set(iso: string): void;
}
function fakeClock(startIso = T0): ClockCtl {
  let now = new Date(startIso).getTime();
  return {
    clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
    advance(ms) {
      now += ms;
    },
    set(iso) {
      now = new Date(iso).getTime();
    },
  };
}

const dirs: string[] = [];
const stores: SqliteStore[] = [];
const readers: IngestChatDbReader[] = [];
const fixtures: ChatDbFixture[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const r of readers.splice(0)) r.close();
  for (const f of fixtures.splice(0)) f.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

interface Harness {
  dir: string;
  fixture: ChatDbFixture;
  server: DaemonServer;
  store: SqliteStore;
  scheduler: Scheduler;
  backend: LoopbackSendBackend;
  clockCtl: ClockCtl;
  headers: { authorization: string };
}

/**
 * Boot against `dir` (a fresh temp dir by default). Passing an existing dir
 * is how row 5 simulates a restart: same database file, same fixture, a
 * completely new process-side object graph.
 */
async function boot(
  opts: { dir?: string; startIso?: string; fixture?: ChatDbFixture } = {},
): Promise<Harness> {
  const dir =
    opts.dir ??
    (() => {
      const d = mkdtempSync(join(tmpdir(), 'wm-undo-grace-'));
      dirs.push(d);
      return d;
    })();
  const chatDbPath = join(dir, 'chat.db');
  // On a restart (row 5) the chat.db is already built — rebuilding it would
  // throw, and more to the point the whole premise is that nothing on disk
  // is discarded.
  let fixture = opts.fixture;
  if (fixture === undefined) {
    fixture = createChatDb(chatDbPath);
    fixtures.push(fixture);
    // A real 1:1 chat for CHAT's handle, so resolveChat succeeds and the
    // verify poll has somewhere to find the outbound row. Without this every
    // dispatch parks as 'no-conversation' and the suite would be testing the
    // scheduler against a permanently broken send path.
    const handleId = fixture.addHandle('+15551234567');
    fixture.addChat({ identifier: '+15551234567', handleIds: [handleId] });
  }

  const clockCtl = fakeClock(opts.startIso ?? T0);
  const store = openStore({ dir, clock: clockCtl.clock });
  stores.push(store);
  store.setSetting(SETTING_CONNECTION_STATE, 'fully-connected');

  const reader = createChatDbReader(chatDbPath, { clock: clockCtl.clock });
  readers.push(reader);
  const backend = createLoopbackSendBackend(fixture, clockCtl.clock);
  const delay = (ms: number): Promise<void> => {
    clockCtl.advance(ms);
    return Promise.resolve();
  };
  // ONE §1.8 sink shared by the routes and the scheduler, exactly as the
  // composed daemon shares it. Two sinks would mean two audit orderings.
  const sink = createAuditSink({ store, clock: clockCtl.clock });

  const server = await buildServer({
    configDir: dir,
    drafts: { store, clock: clockCtl.clock, sink },
  });
  servers.push(server);
  if (server.token === null) throw new Error('harness: no token');

  const scheduler = createScheduler({
    store,
    clock: clockCtl.clock,
    sink,
    dispatch: (draftId: Ulid, approvalId: Ulid) =>
      dispatchApproved(
        {
          store,
          reader,
          backend,
          clock: clockCtl.clock,
          delay,
          backendName: 'loopback',
          emit: () => {},
        },
        draftId,
        approvalId,
      ),
  });

  return {
    dir,
    fixture,
    server,
    store,
    scheduler,
    backend,
    clockCtl,
    headers: { authorization: `Bearer ${server.token}` },
  };
}

function auditTypes(store: SqliteStore): string[] {
  return store
    .readAuditRows(0, 1000)
    .map((row) => (JSON.parse(row.eventJson) as AuditEvent).type);
}

async function createDraft(
  h: Harness,
  body = 'ready when you are',
): Promise<Draft> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/drafts',
    headers: h.headers,
    payload: { chatGuid: CHAT, body },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { draft: Draft }).draft;
}

function post(h: Harness, url: string) {
  return h.server.app.inject({
    method: 'POST',
    url,
    headers: h.headers,
    payload: {},
  });
}

describe('undo grace + scheduler (s4 Scenario 6)', () => {
  it('holds the send until the grace deadline, then dispatches once', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    expect(h.store.getDraft(draft.id)!.sendNotBefore).toBe(
      '2026-09-01T12:00:10.000Z',
    );

    // One second short. Not "approximately not yet" — zero backend calls.
    h.clockCtl.advance(9_000);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)!.state).toBe('approved');

    h.clockCtl.advance(1_000);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
    expect(h.store.getDraft(draft.id)!.state).toBe('sent');
    // s6 Sc 11: the scheduler's first tick also announces the posture this
    // daemon booted into (`arming.changed`, on-change only — the ticks after
    // it add nothing). It is a fact about the daemon, not about this draft,
    // so it is filtered out rather than folded into a list whose whole point
    // is one draft's life in order.
    expect(auditTypes(h.store).filter((t) => t !== 'arming.changed')).toEqual([
      'draft.created',
      'draft.approved',
      'send.attempted',
      'draft.sent',
    ]);
  });

  it('recall inside the window stops the send for good', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    await post(h, `/v1/drafts/${draft.id}/approve`);

    h.clockCtl.advance(5_000);
    const res = await post(h, `/v1/drafts/${draft.id}/recall`);
    expect(res.statusCode).toBe(200);
    const recalled = h.store.getDraft(draft.id)!;
    expect(recalled.state).toBe('recalled');
    expect(recalled.sendNotBefore).toBeUndefined();
    expect(h.store.listApprovals(draft.id).map((a) => a.action)).toEqual([
      'approve',
      'recall',
    ]);

    // The deadline arrives and nothing happens. This is the assertion that
    // matters: a recall that only changed state but left the stamp would
    // still be picked up here.
    h.clockCtl.advance(10_000);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)!.state).toBe('recalled');
    // Same filter, same reason as the row above.
    expect(auditTypes(h.store).filter((t) => t !== 'arming.changed')).toEqual([
      'draft.created',
      'draft.approved',
      'draft.recalled',
    ]);
  });

  it('409s a recall after the deadline, and the approval still stands', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    await post(h, `/v1/drafts/${draft.id}/approve`);

    // Past the deadline but before any tick: the scheduler has not run, so
    // the draft is still 'approved' and the state table would happily allow
    // a recall. Time is the constraint, not state.
    h.clockCtl.advance(11_000);
    const res = await post(h, `/v1/drafts/${draft.id}/recall`);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('grace-elapsed');
    expect(h.store.getDraft(draft.id)!.state).toBe('approved');

    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
    expect(h.store.getDraft(draft.id)!.state).toBe('sent');
  });

  it('expires stale pending drafts in the same tick, and never as a gate denial (C-6)', async () => {
    const h = await boot();
    const stale = await createDraft(h, 'nobody looked at this');
    const live = await createDraft(h, 'approved in time');
    await post(h, `/v1/drafts/${live.id}/approve`);

    // Past the 240-minute default TTL.
    h.clockCtl.advance(241 * 60 * 1_000);
    await h.scheduler.tick();

    expect(h.store.getDraft(stale.id)!.state).toBe('expired');
    expect(h.store.getDraft(live.id)!.state).toBe('sent');

    const rows = h.store
      .readAuditRows(0, 1000)
      .map((row) => JSON.parse(row.eventJson) as AuditEvent);
    const expired = rows.find((r) => r.type === 'draft.expired');
    expect(expired).toBeDefined();
    // C-6: expiry is a clock running out, not a refusal. If a gate.denied
    // row can appear on this path, every "why are we blocked" investigation
    // inherits rows that mean "nobody ever looked at it."
    expect(rows.some((r) => r.type === 'gate.denied')).toBe(false);
    const expiredRow = h.store
      .readAuditRows(0, 1000)
      .find(
        (row) =>
          (JSON.parse(row.eventJson) as AuditEvent).type === 'draft.expired',
      )!;
    expect(JSON.parse(expiredRow.actorJson)).toEqual({
      kind: 'system',
      reason: 'expiry',
    });
  });

  it('survives a restart mid-grace: the deadline comes from the database', async () => {
    const first = await boot();
    const draft = await createDraft(first);
    await post(first, `/v1/drafts/${draft.id}/approve`);
    expect(first.backend.callCount()).toBe(0);

    // Kill everything process-side. Anything the old server was holding in
    // memory about this draft is now gone.
    await first.server.app.close();
    servers.splice(servers.indexOf(first.server), 1);
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);

    const second = await boot({
      dir: first.dir,
      fixture: first.fixture,
      startIso: '2026-09-01T12:00:30.000Z',
    });
    expect(second.store.getDraft(draft.id)!.state).toBe('approved');

    await second.scheduler.tick();
    expect(second.backend.callCount()).toBe(1);
    expect(second.store.getDraft(draft.id)!.state).toBe('sent');

    // And a second tick does not send it again: the state transition, not a
    // consumed in-memory queue, is what makes this idempotent.
    await second.scheduler.tick();
    expect(second.backend.callCount()).toBe(1);
  });

  it('dispatches several due drafts serially, oldest approval first', async () => {
    const h = await boot();
    const ids: string[] = [];
    for (const body of ['first', 'second', 'third']) {
      const d = await createDraft(h, body);
      ids.push(d.id);
      await post(h, `/v1/drafts/${d.id}/approve`);
      // Stagger the approvals so their deadlines strictly order.
      h.clockCtl.advance(1_000);
    }

    h.clockCtl.advance(20_000);
    await h.scheduler.tick();

    expect(h.backend.callCount()).toBe(3);
    expect(h.backend.calls().map((c) => c.body)).toEqual([
      'first',
      'second',
      'third',
    ]);
    for (const id of ids) expect(h.store.getDraft(id)!.state).toBe('sent');
  });

  it('zero grace (F-32): sends on the next tick and the recall window is already shut', async () => {
    const h = await boot();
    h.store.setSetting(SETTING_UNDO_GRACE_SECONDS, '0');
    const draft = await createDraft(h);
    await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(h.store.getDraft(draft.id)!.sendNotBefore).toBe(T0);

    // No advance at all: `send_not_before <= now` is already true.
    const recall = await post(h, `/v1/drafts/${draft.id}/recall`);
    expect(recall.statusCode).toBe(409);

    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
    expect(h.store.getDraft(draft.id)!.state).toBe('sent');
  });
});

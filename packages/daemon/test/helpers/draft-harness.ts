/**
 * Shared S4 draft-surface harness (extracted in s4-execution Scenario 7).
 *
 * Scenarios 6 through 13 all need the same thing: a real store, a real
 * ingest reader over a fixture chat.db with a resolvable 1:1 chat, the
 * loopback send backend, a hand-driven fake Clock, the draft routes, and a
 * scheduler wired to the real `dispatchApproved`. Copying that boot into
 * seven files would guarantee the copies drift, and a harness that differs
 * per suite quietly changes what each suite is actually proving.
 *
 * Everything here is test-only and lives under test/ so the dependency
 * cruiser's no-fixtures-in-prod rule keeps holding.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { AuditEvent, Clock, Draft, Ulid } from '@wemessage/core';
import { dispatchApproved, SETTING_CONNECTION_STATE } from '@wemessage/core';
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
} from './loopback-backend.js';

export const T0 = '2026-09-01T12:00:00.000Z';
/** The fixture handle that has a real 1:1 chat and verifies on send. */
export const CHAT = 'iMessage;-;+15551234567';
export const HANDLE = '+15551234567';

export interface ClockCtl {
  clock: Clock;
  advance(ms: number): void;
  set(iso: string): void;
}

export function fakeClock(startIso = T0): ClockCtl {
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

/** Call from each suite's `afterEach`. */
export async function cleanupHarness(): Promise<void> {
  for (const s of servers.splice(0)) await s.app.close();
  for (const r of readers.splice(0)) r.close();
  for (const f of fixtures.splice(0)) f.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
}

export interface Harness {
  dir: string;
  fixture: ChatDbFixture;
  server: DaemonServer;
  store: SqliteStore;
  scheduler: Scheduler;
  /**
   * The SAME `dispatchApproved` closure the scheduler runs, exposed so the
   * adversarial suite (Scenario 12) can hand the dispatcher a forged
   * approval directly. Going through the scheduler would only ever exercise
   * approvals the product itself minted, which is the opposite of the
   * threat model. Test-only: no production caller gains this reach.
   */
  dispatch: (draftId: Ulid, approvalId: Ulid) => Promise<unknown>;
  backend: LoopbackSendBackend;
  /** The one §1.8 sink the routes and scheduler share. */
  sink: ReturnType<typeof createAuditSink>;
  /** Every broadcast, with the audit log as it stood when it was sent. */
  broadcasts: Array<{ frame: unknown; auditAtBroadcast: string[] }>;
  clockCtl: ClockCtl;
  headers: { authorization: string };
}

export interface BootOptions {
  /** Reuse an existing config dir — how a restart is simulated. */
  dir?: string;
  /** Reuse an already-built chat.db (required when reusing `dir`). */
  fixture?: ChatDbFixture;
  startIso?: string;
  /** s5 Sc5: the adapter transport's hello deadline, injected for tests. */
  helloDeadlineMs?: number;
}

export async function boot(opts: BootOptions = {}): Promise<Harness> {
  const dir =
    opts.dir ??
    (() => {
      const d = mkdtempSync(join(tmpdir(), 'wm-s4-'));
      dirs.push(d);
      return d;
    })();
  const chatDbPath = join(dir, 'chat.db');

  // On a restart the chat.db is already built — rebuilding it would throw,
  // and more to the point the whole premise is that nothing on disk is lost.
  let fixture = opts.fixture;
  if (fixture === undefined) {
    fixture = createChatDb(chatDbPath);
    fixtures.push(fixture);
    // A real 1:1 chat for CHAT's handle, so resolveChat succeeds and the
    // verify poll has somewhere to find the outbound row. Without it every
    // dispatch parks as 'no-conversation' and the suite would be testing
    // against a permanently broken send path.
    const handleId = fixture.addHandle(HANDLE);
    fixture.addChat({ identifier: HANDLE, handleIds: [handleId] });
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
  const rawSink = createAuditSink({ store, clock: clockCtl.clock });
  /**
   * §1.8 witness. Every broadcast is recorded together with the audit types
   * that were already durable AT THAT MOMENT, which is the only way a test
   * can tell "appended then broadcast" from "broadcast then appended" — the
   * final log looks identical either way, and the difference only shows up
   * as a lost record on a crash between the two.
   */
  const broadcasts: Array<{ frame: unknown; auditAtBroadcast: string[] }> = [];
  const sink = {
    ...rawSink,
    broadcast: (frame: Parameters<typeof rawSink.broadcast>[0]) => {
      broadcasts.push({ frame, auditAtBroadcast: auditTypes(store) });
      return rawSink.broadcast(frame);
    },
  };

  const server = await buildServer({
    configDir: dir,
    drafts: { store, clock: clockCtl.clock, sink },
    // s5 Scenario 4: the adapter registry rides along in the harness so the
    // agent-era suites boot the same server the composed daemon does.
    adapters: {
      store,
      clock: clockCtl.clock,
      sink,
      ...(opts.helloDeadlineMs !== undefined
        ? { helloDeadlineMs: opts.helloDeadlineMs }
        : {}),
    },
  });
  servers.push(server);
  if (server.token === null) throw new Error('harness: no token');

  const dispatch = (draftId: Ulid, approvalId: Ulid) =>
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
    );

  const scheduler = createScheduler({
    store,
    clock: clockCtl.clock,
    sink,
    dispatch,
  });

  return {
    dir,
    fixture,
    server,
    store,
    scheduler,
    dispatch,
    backend,
    sink,
    broadcasts,
    clockCtl,
    headers: { authorization: `Bearer ${server.token}` },
  };
}

/** Drop a harness's server+store without waiting for afterEach (restart tests). */
export async function shutdown(h: Harness): Promise<void> {
  await h.server.app.close();
  const si = servers.indexOf(h.server);
  if (si >= 0) servers.splice(si, 1);
  h.store.close();
  const di = stores.indexOf(h.store);
  if (di >= 0) stores.splice(di, 1);
}

export function auditEvents(store: SqliteStore): AuditEvent[] {
  return store
    .readAuditRows(0, 2000)
    .map((row) => JSON.parse(row.eventJson) as AuditEvent);
}

export function auditTypes(store: SqliteStore): string[] {
  return auditEvents(store).map((e) => e.type);
}

export function auditActors(store: SqliteStore, type: string): unknown[] {
  return store
    .readAuditRows(0, 2000)
    .filter((row) => (JSON.parse(row.eventJson) as AuditEvent).type === type)
    .map((row) => JSON.parse(row.actorJson));
}

export async function createDraft(
  h: Harness,
  body = 'ready when you are',
  payload: Record<string, unknown> = {},
): Promise<Draft> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/drafts',
    headers: h.headers,
    payload: { chatGuid: CHAT, body, ...payload },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { draft: Draft }).draft;
}

export function post(
  h: Harness,
  url: string,
  payload: Record<string, unknown> = {},
) {
  return h.server.app.inject({
    method: 'POST',
    url,
    headers: h.headers,
    payload,
  });
}

export function get(h: Harness, url: string) {
  return h.server.app.inject({ method: 'GET', url, headers: h.headers });
}

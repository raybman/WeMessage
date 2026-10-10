/**
 * v2 F3 (G-06a): `PUT /v1/threads/:guid/state` and `GET /v1/threads/state`,
 * Done, Snooze and Mute kept by the daemon instead of the app's memory.
 *
 * What these rows hold the routes to:
 *  - snooze needs an end, nothing else may carry one (the refine);
 *  - an undo may restore an earlier `actAt`, never a later one;
 *  - two windows acting at once is a 409 that names the winner;
 *  - only the operator bearer gets in: an adapter token is a 401;
 *  - wake is computed from the daemon clock on read, with no write;
 *  - the audit row is durable before the frame leaves (§1.8);
 *  - the frame rides the operator transports, never the adapter socket.
 *
 * Every guid and handle here is synthetic (`+1555...`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@wemessage/core';
import {
  auditActors,
  auditEvents,
  boot,
  T0,
  type Harness,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAuthed,
  waitUntil,
} from './helpers/agent-harness.js';
import { openSse } from './helpers/sse-client.js';
import { ROUTE_TABLE } from './transport-surface.snapshot.js';

afterEach(cleanupAgentHarness);

const GUID = 'any;-;+15550100001';
const OTHER = 'any;-;+15550100002';
const statePath = (guid: string): string =>
  `/v1/threads/${encodeURIComponent(guid)}/state`;
const LIST = '/v1/threads/state';

interface WireState {
  chatGuid: string;
  act: string | null;
  actAt: string | null;
  snoozedUntil: string | null;
  attention: string | null;
  updatedAt: string;
  awake: boolean;
}

function put(
  h: Harness,
  guid: string,
  payload: unknown,
  // null, not undefined: an explicit undefined would take the default.
  authorization: string | null = h.headers.authorization,
) {
  return h.server.app.inject({
    method: 'PUT',
    url: statePath(guid),
    headers: {
      ...(authorization === null ? {} : { authorization }),
      'content-type': 'application/json',
    },
    payload: JSON.stringify(payload),
  });
}

function list(
  h: Harness,
  method: 'GET' | 'HEAD' = 'GET',
  authorization: string | null = h.headers.authorization,
) {
  return h.server.app.inject({
    method,
    url: LIST,
    headers: authorization === null ? {} : { authorization },
  });
}

const stateOf = (res: { json(): unknown }): WireState | null =>
  (res.json() as { state: WireState | null }).state;

type ThreadAudit = Extract<AuditEvent, { type: 'thread.state-changed' }>;
const threadAudits = (h: Harness): ThreadAudit[] =>
  auditEvents(h.store).filter(
    (e): e is ThreadAudit => e.type === 'thread.state-changed',
  );

describe('PUT /v1/threads/:guid/state (v2 F3)', () => {
  it('snooze, done and clear: each answers the record, stamped by the daemon clock', async () => {
    const h = await boot();

    const snoozed = await put(h, GUID, {
      act: 'snoozed',
      snoozedUntil: '2026-09-02T09:00:00.000-07:00',
    });
    expect(snoozed.statusCode).toBe(200);
    expect(stateOf(snoozed)).toEqual({
      chatGuid: GUID,
      act: 'snoozed',
      actAt: T0,
      snoozedUntil: '2026-09-02T09:00:00.000-07:00',
      attention: null,
      updatedAt: T0,
      awake: false,
    });

    h.clockCtl.advance(60_000);
    const done = await put(h, GUID, { act: 'done' });
    expect(done.statusCode).toBe(200);
    expect(stateOf(done)).toEqual({
      chatGuid: GUID,
      act: 'done',
      actAt: h.clockCtl.clock.now(),
      snoozedUntil: null,
      attention: null,
      updatedAt: h.clockCtl.clock.now(),
      awake: false,
    });

    const cleared = await put(h, GUID, { act: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ state: null });
    expect(h.store.getThreadState(GUID)).toBeNull();
  });

  it('attention: omitted keeps the current one, null returns it to the default', async () => {
    const h = await boot();
    await put(h, GUID, { act: null, attention: 'stream' });
    const muted = stateOf(await put(h, GUID, { act: 'muted' }));
    expect(muted?.attention).toBe('stream');
    expect(muted?.act).toBe('muted');
    const reset = await put(h, GUID, { act: null, attention: null });
    expect(reset.json()).toEqual({ state: null });
  });

  it('an undo restores an earlier actAt exactly', async () => {
    const h = await boot();
    h.clockCtl.advance(3_600_000);
    const restored = stateOf(
      await put(h, GUID, { act: 'done', actAt: '2026-09-01T12:30:00.000Z' }),
    );
    expect(restored?.actAt).toBe('2026-09-01T12:30:00.000Z');
    expect(restored?.updatedAt).toBe(h.clockCtl.clock.now());
  });

  it('400 invalid-thread-state: a snooze without until, an until without a snooze', async () => {
    const h = await boot();
    for (const body of [
      { act: 'snoozed' },
      { act: 'snoozed', snoozedUntil: null },
      { act: 'done', snoozedUntil: '2026-09-02T09:00:00.000Z' },
      { act: null, snoozedUntil: '2026-09-02T09:00:00.000Z' },
    ]) {
      const res = await put(h, GUID, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      const err = res.json() as {
        error: string;
        detail: { issues: unknown[] };
      };
      expect(err.error).toBe('invalid-thread-state');
      expect(err.detail.issues.length).toBeGreaterThan(0);
    }
    expect(h.store.listThreadStates()).toEqual([]);
    expect(threadAudits(h)).toEqual([]);
    expect(h.broadcasts).toEqual([]);
  });

  it('400 invalid-thread-state: an actAt in the future, or on a clear, or a bad body', async () => {
    const h = await boot();
    for (const body of [
      { act: 'done', actAt: '2026-09-01T12:00:00.001Z' },
      { act: null, actAt: T0 },
      { act: 'archived' },
      { act: 'done', seenAt: T0 },
      { act: 'done', attention: 'loud' },
      { act: 'done', ifUpdatedAt: 'yesterday' },
      {},
    ]) {
      const res = await put(h, GUID, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect((res.json() as { error: string }).error).toBe(
        'invalid-thread-state',
      );
    }
    // An actAt exactly at the daemon's now is not in the future.
    expect((await put(h, GUID, { act: 'done', actAt: T0 })).statusCode).toBe(
      200,
    );
  });

  it('409 conflict: a stale ifUpdatedAt names the record that won, and writes nothing', async () => {
    const h = await boot();
    const first = stateOf(await put(h, GUID, { act: 'done' }));
    expect(first).not.toBeNull();

    h.clockCtl.advance(1_000);
    // The second window saw no record; the first window already wrote one.
    const stale = await put(h, GUID, { act: 'muted', ifUpdatedAt: null });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: 'conflict',
      detail: { current: first },
    });

    const older = await put(h, GUID, {
      act: 'muted',
      ifUpdatedAt: '2026-09-01T11:00:00.000Z',
    });
    expect(older.statusCode).toBe(409);
    expect(h.store.getThreadState(GUID)?.act).toBe('done');
    expect(threadAudits(h)).toHaveLength(1);

    // A matching token goes through, and so does "expect no record" on a
    // guid that has none.
    const fresh = await put(h, GUID, {
      act: 'muted',
      ifUpdatedAt: first?.updatedAt ?? null,
    });
    expect(fresh.statusCode).toBe(200);
    expect(
      (await put(h, OTHER, { act: 'done', ifUpdatedAt: null })).statusCode,
    ).toBe(200);
  });

  it('audit: one thread.state-changed row per write, from and to, under the human API actor', async () => {
    const h = await boot();
    const a = stateOf(await put(h, GUID, { act: 'done' }));
    h.clockCtl.advance(1_000);
    await put(h, GUID, { act: null });

    const rows = threadAudits(h);
    expect(rows).toHaveLength(2);
    // The audit row stores the record; `awake` is computed, never stored.
    const stored: Partial<WireState> = { ...(a ?? ({} as WireState)) };
    expect(stored.awake).toBe(false);
    delete stored.awake;
    expect(rows[0]).toEqual({
      type: 'thread.state-changed',
      chatGuid: GUID,
      from: null,
      to: stored,
    });
    expect(rows[1]).toEqual({
      type: 'thread.state-changed',
      chatGuid: GUID,
      from: stored,
      to: null,
    });
    expect(auditActors(h.store, 'thread.state-changed')).toEqual([
      { kind: 'human', via: 'api' },
      { kind: 'human', via: 'api' },
    ]);
  });

  it('§1.8: the audit row is durable before the thread.state frame leaves', async () => {
    const h = await boot();
    await put(h, GUID, {
      act: 'snoozed',
      snoozedUntil: '2026-09-02T09:00:00.000Z',
    });
    const frames = h.broadcasts.filter(
      (b) => (b.frame as { event: string }).event === 'thread.state',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.auditAtBroadcast).toContain('thread.state-changed');
    expect(frames[0]?.frame).toEqual({
      event: 'thread.state',
      chatGuid: GUID,
      state: {
        chatGuid: GUID,
        act: 'snoozed',
        actAt: T0,
        snoozedUntil: '2026-09-02T09:00:00.000Z',
        attention: null,
        updatedAt: T0,
        awake: false,
      },
    });
  });

  it('a guid is only bounded, never looked up: an unknown one is accepted, an overlong one refused', async () => {
    const h = await boot();
    expect(
      (await put(h, 'any;-;+15550100099', { act: 'done' })).statusCode,
    ).toBe(200);
    const long = await put(h, 'x'.repeat(513), { act: 'done' });
    expect([400, 414]).toContain(long.statusCode);
  });
});

describe('GET /v1/threads/state (v2 F3)', () => {
  it('lists every record, sorted by guid, dated by the daemon clock', async () => {
    const h = await boot();
    await put(h, OTHER, { act: 'muted' });
    await put(h, GUID, { act: 'done' });
    h.clockCtl.advance(5_000);
    const res = await list(h);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { states: WireState[]; asOf: string };
    expect(body.asOf).toBe(h.clockCtl.clock.now());
    expect(body.states.map((s) => [s.chatGuid, s.act])).toEqual([
      [GUID, 'done'],
      [OTHER, 'muted'],
    ]);
    expect(Object.keys(body).sort()).toEqual(['asOf', 'states']);
  });

  it('awake flips when the fake clock passes snoozedUntil, with no write in between', async () => {
    const h = await boot();
    await put(h, GUID, {
      act: 'snoozed',
      snoozedUntil: '2026-09-01T13:00:00.000+00:00',
    });
    const stamp = h.store.getThreadState(GUID)?.updatedAt;
    const auditCount = auditEvents(h.store).length;
    const awakeNow = async (): Promise<boolean | undefined> =>
      ((await list(h)).json() as { states: WireState[] }).states[0]?.awake;

    expect(await awakeNow()).toBe(false);
    h.clockCtl.set('2026-09-01T12:59:59.999Z');
    expect(await awakeNow()).toBe(false);
    h.clockCtl.set('2026-09-01T13:00:00.000Z');
    expect(await awakeNow()).toBe(true);

    expect(h.store.getThreadState(GUID)?.updatedAt).toBe(stamp);
    expect(auditEvents(h.store).length).toBe(auditCount);
  });

  it('HEAD twin answers 200 with no body', async () => {
    const h = await boot();
    const res = await list(h, 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('reads and only reads: no audit row and no broadcast follow a list', async () => {
    const h = await boot();
    await put(h, GUID, { act: 'done' });
    const audits = auditEvents(h.store).length;
    const frames = h.broadcasts.length;
    await list(h);
    await list(h, 'HEAD');
    expect(auditEvents(h.store).length).toBe(audits);
    expect(h.broadcasts.length).toBe(frames);
  });
});

describe("thread state is the operator's alone (v2 F3)", () => {
  it('401 with no bearer, a wrong one, or an adapter token, on every method', async () => {
    const h = await boot();
    const minted = await h.server.app.inject({
      method: 'POST',
      url: '/v1/adapters',
      headers: h.headers,
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
      const w = await put(h, GUID, { act: 'done' }, authorization);
      expect(w.statusCode, `PUT ${String(authorization)}`).toBe(401);
      for (const method of ['GET', 'HEAD'] as const) {
        const r = await list(h, method, authorization);
        expect(r.statusCode, `${method} ${String(authorization)}`).toBe(401);
      }
    }
    expect(h.store.listThreadStates()).toEqual([]);
    expect(threadAudits(h)).toEqual([]);
  });

  it('the frame reaches an operator SSE stream after the append, and /v1/agent receives nothing', async () => {
    const h = await bootAgent({ greeting: true });
    const sock = await connectAuthed(h, await addAdapter(h, 'echo-1'));
    const base = h.baseUrl.replace('ws://', 'http://');
    const sse = await openSse(base, '/v1/events/sse?events=thread.state', {
      headers: h.headers,
    });
    try {
      const agentFramesBefore = sock.frames.length;
      const res = await put(h, GUID, { act: 'done' });
      expect(res.statusCode).toBe(200);
      // The greeting (`connection.state`) always opens the stream; the
      // filter governs everything after it.
      await sse.waitForEvents(2, 'greeting, then thread.state on SSE');
      expect(sse.events.map((e) => e.event)).toEqual([
        'connection.state',
        'thread.state',
      ]);
      const ev = sse.events[1];
      expect(JSON.parse(ev?.data ?? 'null')).toEqual({
        event: 'thread.state',
        chatGuid: GUID,
        state: stateOf(res),
      });
      // Settle the loop, then prove the adapter socket saw no frame at all.
      await waitUntil(() => true);
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
      expect(sock.frames.slice(agentFramesBefore)).toEqual([]);
    } finally {
      await sse.close();
    }
  });
});

describe('the surface (v2 F3, route ratchet #29)', () => {
  it('pins PUT, GET and its HEAD twin, and no path says seen, read or mark', () => {
    // 78 since v2 F2b (#30) added `GET /v1/search` and its twin; 80 since
    // v2 F2c (#31) added `GET /v1/threads/:guid/years` and its twin.
    expect(ROUTE_TABLE).toHaveLength(80);
    for (const r of [
      'GET /v1/threads/state',
      'HEAD /v1/threads/state',
      'PUT /v1/threads/:guid/state',
    ]) {
      expect(ROUTE_TABLE).toContain(r);
    }
    expect(
      ROUTE_TABLE.filter((r) =>
        /seen|\/read|mark/i.test(r.split(' ')[1] ?? ''),
      ),
    ).toEqual([]);
  });

  it('wake is judged by the daemon clock: the route file never reads wall time', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/thread-state.ts', import.meta.url)),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now/);
    expect(src).toMatch(/clock\.now\(\)/);
  });
});

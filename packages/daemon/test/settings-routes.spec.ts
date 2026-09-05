/**
 * s7-execution Scenario 4 — `GET /v1/settings` and `PATCH /v1/settings`, the
 * operator's configuration surface. Ratchet update #22. Owed to this slice by
 * both S5 §4.3 and S6 §4.3 (F-85); the roadmap's S7 block forgot it.
 *
 * **What this route is, in one sentence.** Every knob S4 through S6 minted as
 * a settings key has been reachable only by opening the SQLite file with a
 * third-party tool; this is the first surface that lets an operator read them
 * all and change the ones they are allowed to change.
 *
 * **The closed list is the whole design.** A settings route over a flat
 * key/value table is one `Object.assign` away from being a remote-code
 * facility: the gate reads `connection.state` to decide whether this daemon
 * may speak at all, and a PATCH that could write it would let anyone with the
 * operator token hand-set "fully-connected" over a machine that has never
 * probed. So the surface is a LIST, not a filter: fifteen keys, each with a
 * declared type, each with the production reader that already consumes it,
 * and every other string in the table — `connection.state` included — is a
 * 400 `unknown-key` that writes nothing. Row 4 is that row, and it names the
 * two keys most worth reaching for.
 *
 * **Floors are enforced at the write, not only at the read.** Three of the
 * four autonomy-relevant numbers already floor themselves where they are read
 * (`readCap` clamps to 1, `readAutoGraceSeconds` clamps to 5), which means a
 * route with no floors would look like it worked and quietly disagree with
 * the daemon about what the setting says. Rows 3 and 11 refuse instead, and
 * row 11's second half is the one that matters: `send.autoGraceSeconds`
 * INHERITS `send.undoGraceSeconds` (F-78), so the interesting attack is not
 * "set the auto grace to zero" (refused) but "set the operator grace to zero
 * and let autonomy inherit it" — which is legal, because a human who approves
 * a draft may have it go now, and still leaves autonomy at five seconds.
 *
 * **The read-only rows exist to give a better refusal, not to hide keys.**
 * The kill switch, the global mode, the pause deadline and the breaker's trip
 * instant are all real rows in the same table, and an operator staring at a
 * settings screen should see them. They refuse a write with the ROUTE that
 * owns them, so "why can't I change this" has an answer in the response body
 * (row 5). What they never do is accept the write and diverge from the
 * toggle routes' audit trail.
 *
 * **Ordering is §1.8, and the witness is the harness's.** `draft-harness`
 * records, for every broadcast, the audit types that were already durable at
 * that instant; row 2 asserts the `setting.changed` row was one of them. A
 * settings change that reached a socket before it reached the log would be a
 * change a crash could erase after somebody had already acted on it.
 *
 * Every handle is synthetic (`+1555…`). No key here can reach a send path:
 * row 15 pins both new modules out of the port-importer allowlist.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import * as core from '@wemessage/core';
import {
  bumpSendCounters,
  contactRateScope,
  readAutoGraceSeconds,
  readCircuitConfig,
  readLoopLimits,
  readRateCaps,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CONNECTION_STATE,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  SETTING_UNDO_GRACE_SECONDS,
  type AuditEvent,
  type Message,
  type Rule,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
  boot,
  CHAT,
  get,
  HANDLE,
  T0,
  type Harness,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAuthed,
  waitUntil,
  type AgentHarness,
  type FakeAdapterSocket,
} from './helpers/agent-harness.js';
import { openSse, probeHttp, type SseStream } from './helpers/sse-client.js';
import {
  PORT_IMPORTER_ALLOWLIST,
  ROUTE_TABLE,
} from './transport-surface.snapshot.js';

afterEach(cleanupAgentHarness);

const SETTINGS_PATH = '/v1/settings';

const defaultsFixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../fixtures/settings/defaults.json', import.meta.url),
    ),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>;

const settingsSchemaFile = fileURLToPath(
  new URL('../src/settings/schema.ts', import.meta.url),
);
const settingsRouteFile = fileURLToPath(
  new URL('../src/routes/settings.ts', import.meta.url),
);

interface SettingEntry {
  value: unknown;
  default: unknown;
  version: number;
  type: string;
  readOnly: boolean;
  floor?: number;
  ceiling?: number;
  use?: string;
}

/**
 * Always a JSON body with an explicit content-type, even for the malformed
 * rows: a bare string handed to `inject` goes out with no content-type and
 * fastify answers 415 before the route is reached, which would test the
 * framework rather than the refusal.
 */
function patch(h: Harness, payload: unknown) {
  return h.server.app.inject({
    method: 'PATCH',
    url: SETTINGS_PATH,
    headers: { ...h.headers, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function settings(h: Harness): Promise<Record<string, SettingEntry>> {
  const res = await get(h, SETTINGS_PATH);
  expect(res.statusCode).toBe(200);
  return (res.json() as { settings: Record<string, SettingEntry> }).settings;
}

function auditOf(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

/* --------------------------------------------------------------------- *
 * Row 1: the closed list, typed, and pinned to a committed fixture.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 1: GET /v1/settings is the closed list', () => {
  it('returns exactly the fixture keys, typed, with defaults and versions', async () => {
    const h = await boot();
    const body = await settings(h);

    // The key set is the ratchet: adding, removing or renaming a key cannot
    // land without a reviewed diff to `fixtures/settings/defaults.json`.
    expect(Object.keys(body)).toEqual(Object.keys(defaultsFixture));
    // Sorted on the wire, so a stranger diffing two daemons diffs values.
    expect(Object.keys(body)).toEqual([...Object.keys(body)].sort());

    for (const [key, spec] of Object.entries(defaultsFixture)) {
      const entry = body[key];
      expect(entry, key).toBeDefined();
      // On a store nobody has written, every value IS its default and every
      // version is -1 ("never set"), which is the honest way to say that a
      // shipped default is not a stored decision.
      expect(entry, key).toEqual({
        ...spec,
        value: spec['default'],
        version: -1,
      });
    }

    // Typed, not the raw TEXT column (the whole reason `GET` exists).
    expect(typeof body['send.capContactPer2Min']?.value).toBe('number');
    expect(typeof body['send.retryAsSms']?.value).toBe('boolean');
    expect(body['arming.pauseUntil']?.value).toBeNull();

    // exactOptionalPropertyTypes: a writable key has NO `use` key at all,
    // and a read-only key has no floor/ceiling — omitted, never undefined.
    expect('use' in (body['send.capGlobalPerHour'] ?? {})).toBe(false);
    expect('floor' in (body['send.killSwitch'] ?? {})).toBe(false);
    expect('floor' in (body['send.retryAsSms'] ?? {})).toBe(false);
  });

  it('reports the value the daemon actually uses, not the stored bytes', async () => {
    const h = await boot();
    // A row nothing this product wrote: `readCap` refuses to read it and
    // falls back to the shipped default, so the API must say 1, not "seven".
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, 'seven');
    const body = await settings(h);
    expect(body['send.capContactPer2Min']?.value).toBe(1);
    expect(readRateCaps(h.store).contactPer2Min).toBe(1);
    // …while still admitting the key HAS been written, which is what
    // separates "nobody set this" from "somebody set it to nonsense".
    expect(body['send.capContactPer2Min']?.version).toBeGreaterThanOrEqual(0);
  });
});

/* --------------------------------------------------------------------- *
 * Row 2: an accepted PATCH writes, audits, then broadcasts — in that order.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 2: an accepted mutation', () => {
  it('writes the store, audits setting.changed, then broadcasts toggle.changed', async () => {
    const h = await boot();
    const res = await patch(h, { 'send.capContactPer2Min': 3 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { changed: string[] }).changed).toEqual([
      'send.capContactPer2Min',
    ]);

    const body = await settings(h);
    expect(body['send.capContactPer2Min']?.value).toBe(3);
    expect(body['send.capContactPer2Min']?.version).toBe(0);
    // The store holds the string form; the route does the typing.
    expect(h.store.getSetting(SETTING_CAP_CONTACT_PER_2MIN)).toBe('3');

    const rows = auditOf(h, 'setting.changed');
    expect(rows).toEqual([
      {
        type: 'setting.changed',
        key: 'send.capContactPer2Min',
        from: 1,
        to: 3,
      },
    ]);
    expect(
      auditEvents(h.store).length,
      'exactly one audit row per accepted key',
    ).toBe(rows.length);

    // §1.8: the broadcast carries the existing `toggle.changed` WS variant —
    // no new WS literal enters the ratchet — and the audit row was already
    // durable when it went out.
    expect(h.broadcasts).toHaveLength(1);
    const [sent] = h.broadcasts;
    expect(sent?.frame).toEqual({
      event: 'toggle.changed',
      key: 'send.capContactPer2Min',
      value: 3,
      actor: { kind: 'human', via: 'api' },
    });
    expect(sent?.auditAtBroadcast).toContain('setting.changed');
  });

  it('reaches a WS client and an SSE client as identical bytes', async () => {
    const h = await bootAgent({ greeting: true });
    const ws = await openWs(h);
    const sse = await openSse(
      h.baseUrl.replace('ws://', 'http://'),
      '/v1/events/sse',
      { headers: h.headers },
    );
    openStreams.push(sse);
    await sse.waitForEvents(1, 'sse greeting');
    await ws.waitFor(1, 'ws greeting');

    expect((await patch(h, { 'send.capGlobalPerHour': 42 })).statusCode).toBe(
      200,
    );
    await sse.waitForEvents(2, 'sse toggle.changed');
    await ws.waitFor(2, 'ws toggle.changed');

    // Parity is INHERITED from Sc 3 (one serialization, one filter, two
    // transports); this row proves the new emitter rides it rather than
    // re-proving the mechanism.
    expect(sse.events[1]?.event).toBe('toggle.changed');
    expect(sse.events[1]?.data).toBe(ws.frames[1]);
    expect(JSON.parse(ws.frames[1] ?? 'null')).toMatchObject({
      event: 'toggle.changed',
      key: 'send.capGlobalPerHour',
      value: 42,
    });
    await ws.close();
  });
});

/* --------------------------------------------------------------------- *
 * Rows 3-7, 11, 12: everything the route refuses. C-3.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 3: below the floor', () => {
  it('refuses 0 for a capped integer and writes nothing', async () => {
    const h = await boot();
    const res = await patch(h, { 'send.capContactPer2Min': 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'below-floor',
      key: 'send.capContactPer2Min',
      floor: 1,
    });
    expect(h.store.getSetting(SETTING_CAP_CONTACT_PER_2MIN)).toBeNull();
    expect(auditEvents(h.store)).toEqual([]);
    expect(h.broadcasts).toEqual([]);
  });
});

describe('s7 Sc4 row 4: the closed list is closed', () => {
  it('refuses an unknown key, including the two most tempting ones', async () => {
    const h = await boot();
    const keys = [
      'send.notAKey',
      // The gate's fail-closed pin: a daemon whose probe says otherwise must
      // not be told by a PATCH what its own connection posture is.
      SETTING_CONNECTION_STATE,
      // Autonomy over SMS is a widening with no floor to bound it; it has no
      // owning route in this slice, so it has no entry in the list either.
      'send.allowSmsAuto',
    ];
    const before = keys.map((k) => h.store.getSetting(k));
    for (const [i, key] of keys.entries()) {
      const res = await patch(h, { [key]: 'degraded' });
      expect(res.statusCode, key).toBe(400);
      expect(res.json(), key).toEqual({ error: 'unknown-key', key });
      // Untouched, not merely absent: `connection.state` already HAS a value
      // here, and the failure this row guards against is overwriting it.
      expect(h.store.getSetting(key), key).toBe(before[i]);
    }
    expect(auditEvents(h.store)).toEqual([]);
    expect(h.broadcasts).toEqual([]);
  });
});

describe('s7 Sc4 row 5: read-only keys point at the route that owns them', () => {
  it('refuses the kill switch and does not flip it', async () => {
    const h = await boot();
    const res = await patch(h, { 'send.killSwitch': true });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'read-only-key',
      key: 'send.killSwitch',
      use: 'POST /v1/toggles/kill-switch',
    });
    expect(h.store.getSetting(SETTING_KILL_SWITCH)).toBeNull();
    const status = await get(h, '/v1/status');
    expect((status.json() as { killSwitch: boolean }).killSwitch).toBe(false);
    expect(auditEvents(h.store)).toEqual([]);
  });

  it('refuses every read-only key with its own pointer', async () => {
    const h = await boot();
    for (const [key, spec] of Object.entries(defaultsFixture)) {
      if (spec['readOnly'] !== true) continue;
      const res = await patch(h, { [key]: 'anything' });
      expect(res.statusCode, key).toBe(400);
      expect(res.json(), key).toEqual({
        error: 'read-only-key',
        key,
        use: spec['use'],
      });
    }
    expect(auditEvents(h.store)).toEqual([]);
  });
});

describe('s7 Sc4 row 6: a PATCH is all-or-nothing', () => {
  it('refuses the whole body when the second key fails', async () => {
    const h = await boot();
    const res = await patch(h, {
      'send.capGlobalPerHour': 50,
      'send.capContactPer2Min': 0,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'below-floor',
      key: 'send.capContactPer2Min',
      floor: 1,
    });
    // The first key was valid and is NOT written: validation runs to
    // completion before the first `setSetting`.
    expect(h.store.getSetting(SETTING_CAP_GLOBAL_PER_HOUR)).toBeNull();
    expect(auditEvents(h.store)).toEqual([]);
    expect(h.broadcasts).toEqual([]);
  });
});

describe('s7 Sc4 row 7: types are checked, not coerced', () => {
  it('refuses a string for a bool and a fraction for an int', async () => {
    const h = await boot();
    const bool = await patch(h, { 'send.retryAsSms': 'yes' });
    expect(bool.statusCode).toBe(400);
    expect(bool.json()).toEqual({
      error: 'wrong-type',
      key: 'send.retryAsSms',
      expected: 'bool',
    });

    for (const bad of [1.5, '3', null, [], { n: 1 }, 2 ** 53]) {
      const res = await patch(h, { 'send.capGlobalPerHour': bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json(), JSON.stringify(bad)).toEqual({
        error: 'wrong-type',
        key: 'send.capGlobalPerHour',
        expected: 'int',
      });
    }
    expect(auditEvents(h.store)).toEqual([]);
  });

  it('refuses a body that is not an object of keys', async () => {
    const h = await boot();
    for (const bad of [[], 'x', 3]) {
      const res = await patch(h, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid-settings');
    }
  });
});

describe('s7 Sc4 row 8: a no-op writes nothing', () => {
  it('accepts the current value, changes nothing, audits nothing', async () => {
    const h = await boot();
    expect((await patch(h, { 'send.capContactPer2Min': 3 })).statusCode).toBe(
      200,
    );
    const versionAfterWrite = h.store.getSettingVersion(
      SETTING_CAP_CONTACT_PER_2MIN,
    );

    const again = await patch(h, {
      'send.capContactPer2Min': 3,
      'send.retryAsSms': false,
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { changed: string[] }).changed).toEqual([]);
    expect(h.store.getSettingVersion(SETTING_CAP_CONTACT_PER_2MIN)).toBe(
      versionAfterWrite,
    );
    expect(auditOf(h, 'setting.changed')).toHaveLength(1);
    expect(h.broadcasts).toHaveLength(1);

    // An empty body is the degenerate no-op, not an error: it is what "save"
    // means on a form nobody touched.
    const empty = await patch(h, {});
    expect(empty.statusCode).toBe(200);
    expect((empty.json() as { changed: string[] }).changed).toEqual([]);
  });
});

/* --------------------------------------------------------------------- *
 * Row 9: the route feeds the real gate, not a parallel copy.
 * --------------------------------------------------------------------- */

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}S4`;

function makeRule(): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    respondMode: 'auto',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 45,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
  };
}

let guidSeq = 0;
function inbound(at: string): Message {
  guidSeq += 1;
  return {
    guid: `GUID-SET-${String(guidSeq)}`,
    sourceRowid: 5_000 + guidSeq,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'tacos tonight?',
    attachments: [],
    sentAt: at,
    receivedAt: at,
  };
}

interface RequestFrame {
  type: string;
  payload: { rule: { respondMode: string } };
}

function requests(sock: FakeAdapterSocket): RequestFrame[] {
  return (sock.frames as RequestFrame[]).filter(
    (f) => f.type === 'draft.request',
  );
}

async function modeOfRequest(
  sock: FakeAdapterSocket,
  n: number,
): Promise<string | null> {
  await waitUntil(() => requests(sock).length >= n, `draft.request #${n}`);
  return requests(sock)[n - 1]?.payload.rule.respondMode ?? null;
}

describe('s7 Sc4 row 9: the cap the route wrote is the cap the gate reads', () => {
  it('raising per-contact pacing through PATCH lets a second auto through, lowering it clamps', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h, ADAPTER);
    const sock = await connectAuthed(h, cred);
    h.store.insertRule(makeRule());
    h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');

    const dispatch = createInboundDispatch({
      store: h.store,
      clock: h.clockCtl.clock,
      sink: h.sink,
      reader: h.reader,
      transport: {
        isConnected: (id) => h.server.agentTransport?.isConnected(id) ?? false,
        sendTo: (id, frame) =>
          h.server.agentTransport?.sendTo(id, frame) ?? false,
      },
    });
    const deliver = async (message: Message): Promise<void> => {
      h.store.insertInboundMessage(message);
      h.sink.broadcast(toGatewayEvent(message));
      await dispatch.emitWinner(message, h.store.listRules());
    };

    // Raised through the ROUTE, never through `setSetting` — that is the
    // whole point of the row.
    expect((await patch(h, { 'send.capContactPer2Min': 2 })).statusCode).toBe(
      200,
    );
    expect(readRateCaps(h.store).contactPer2Min).toBe(2);

    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 1)).toBe('auto');
    bumpSendCounters(h.store, {
      now: h.clockCtl.clock.now(),
      auto: true,
      handle: HANDLE,
    });

    h.clockCtl.advance(30_000);
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 2)).toBe('auto');
    bumpSendCounters(h.store, {
      now: h.clockCtl.clock.now(),
      auto: true,
      handle: HANDLE,
    });

    // Lower it back through the route and the very next inbound clamps.
    expect((await patch(h, { 'send.capContactPer2Min': 1 })).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(30_000);
    await deliver(inbound(h.clockCtl.clock.now()));
    expect(await modeOfRequest(sock, 3)).toBe('draft-only');
    expect(h.store.sumRateCounter(contactRateScope(HANDLE), T0)).toBe(2);
  });
});

/* --------------------------------------------------------------------- *
 * Row 10: the ratchet, the HEAD twin and the three 401s.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 10: the transport surface', () => {
  it('pins GET, HEAD and PATCH in the route table (#22, 67 rows)', async () => {
    expect(ROUTE_TABLE).toHaveLength(67);
    expect(ROUTE_TABLE).toContain('GET /v1/settings');
    expect(ROUTE_TABLE).toContain('HEAD /v1/settings');
    expect(ROUTE_TABLE).toContain('PATCH /v1/settings');
    // PATCH gets no auto-HEAD twin: fastify mints those for GET only, which
    // is why one GET plus one PATCH is +3 and not +4.
    expect(ROUTE_TABLE.filter((r) => r.endsWith(' /v1/settings'))).toEqual([
      'GET /v1/settings',
      'HEAD /v1/settings',
      'PATCH /v1/settings',
    ]);
  });

  it('answers HEAD with 200 and no body, and 401s all three without a bearer', async () => {
    const h = await bootAgent();
    const base = h.baseUrl.replace('ws://', 'http://');

    const head = await probeHttp(base, SETTINGS_PATH, {
      method: 'HEAD',
      headers: h.headers,
    });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');

    for (const method of ['GET', 'HEAD', 'PATCH']) {
      const res = await probeHttp(base, SETTINGS_PATH, { method });
      expect(res.status, method).toBe(401);
    }
  });
});

/* --------------------------------------------------------------------- *
 * Row 11: the F-78 floor cannot be reached through this route, by either
 * of the two doors into it.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 11: autonomy keeps its five seconds', () => {
  it('refuses an auto-grace under the floor and cannot be walked around through the operator grace', async () => {
    const h = await boot();

    const direct = await patch(h, { 'send.autoGraceSeconds': 0 });
    expect(direct.statusCode).toBe(400);
    expect(direct.json()).toEqual({
      error: 'below-floor',
      key: 'send.autoGraceSeconds',
      floor: core.AUTO_GRACE_FLOOR_SECONDS,
    });

    // The operator's own undo window MAY be zero — a human who clicks approve
    // is allowed to mean now — and doing it does not drag autonomy down with
    // it, because `readAutoGraceSeconds` floors what it inherits.
    const indirect = await patch(h, { 'send.undoGraceSeconds': 0 });
    expect(indirect.statusCode).toBe(200);
    expect(h.store.getSetting(SETTING_UNDO_GRACE_SECONDS)).toBe('0');
    expect(readAutoGraceSeconds(h.store)).toBe(5);

    // And the inheritance is visible rather than folklore: with the operator
    // grace at 60, clearing the auto grace would land on 60.
    expect((await patch(h, { 'send.undoGraceSeconds': 60 })).statusCode).toBe(
      200,
    );
    const body = await settings(h);
    expect(body['send.autoGraceSeconds']?.default).toBe(60);
    expect(body['send.autoGraceSeconds']?.value).toBe(60);
  });

  it('refuses a negative operator grace and a value over the ceiling', async () => {
    const h = await boot();
    const below = await patch(h, { 'send.undoGraceSeconds': -1 });
    expect(below.statusCode).toBe(400);
    expect(below.json()).toEqual({
      error: 'below-floor',
      key: 'send.undoGraceSeconds',
      floor: 0,
    });

    const above = await patch(h, { 'send.capGlobalPerHour': 10_001 });
    expect(above.statusCode).toBe(400);
    expect(above.json()).toEqual({
      error: 'above-ceiling',
      key: 'send.capGlobalPerHour',
      ceiling: 10_000,
    });
    expect(auditEvents(h.store)).toEqual([]);
  });
});

/* --------------------------------------------------------------------- *
 * Row 12: every writable key round-trips through its production reader.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 12: every writable key reaches the code that reads it', () => {
  it('round-trips each one through the reader the daemon actually uses', async () => {
    const h = await boot();
    const raised: Record<string, number | boolean> = {
      'send.capContactPer2Min': 7,
      'send.capContactPerHour': 17,
      'send.capGlobalPerHour': 77,
      'send.undoGraceSeconds': 20,
      'send.autoGraceSeconds': 30,
      'send.retryAsSms': true,
      'send.circuitFailureThreshold': 9,
      'send.circuitFailureWindowMin': 19,
      'send.circuitOpenMinutes': 29,
      'send.loopConsecutiveAutoMax': 4,
      'send.loopDuplicateLookback': 6,
    };
    // Every writable key in the fixture is exercised — a new one cannot be
    // added without this row noticing it was never proved to reach anything.
    const writable = Object.entries(defaultsFixture)
      .filter(([, spec]) => spec['readOnly'] === false)
      .map(([key]) => key);
    expect([...Object.keys(raised)].sort()).toEqual([...writable].sort());

    const res = await patch(h, raised);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { changed: string[] }).changed).toEqual(
      [...writable].sort(),
    );

    expect(readRateCaps(h.store)).toEqual({
      contactPer2Min: 7,
      contactPerHour: 17,
      globalPerHour: 77,
    });
    expect(readCircuitConfig(h.store)).toEqual({
      failureThreshold: 9,
      failureWindowMin: 19,
      openMinutes: 29,
    });
    expect(readLoopLimits(h.store)).toEqual({
      consecutiveAutoMax: 4,
      duplicateLookback: 6,
    });
    expect(readAutoGraceSeconds(h.store)).toBe(30);

    // One audit row and one broadcast per key, in key order, and every audit
    // row was durable before the first frame left (§1.8).
    expect(
      auditOf(h, 'setting.changed').map((e) => (e as { key: string }).key),
    ).toEqual([...writable].sort());
    expect(h.broadcasts).toHaveLength(writable.length);
    expect(
      h.broadcasts[0]?.auditAtBroadcast.filter((t) => t === 'setting.changed'),
    ).toHaveLength(writable.length);
  });
});

/* --------------------------------------------------------------------- *
 * Rows 13-15: provenance, C-8, INV-2.
 * --------------------------------------------------------------------- */

describe('s7 Sc4 row 13: no key is minted by the route', () => {
  it('every key in the closed list is an exported core SETTING_ constant', () => {
    const minted = new Set(
      Object.entries(core)
        .filter(([name]) => name.startsWith('SETTING_'))
        .map(([, value]) => value as string),
    );
    // Plus the one key core exports under a non-`SETTING_` name because it is
    // the breaker's operator-facing POSTURE name rather than a stored row.
    for (const key of Object.keys(defaultsFixture)) {
      expect(minted.has(key), `${key} is not a core settings constant`).toBe(
        true,
      );
    }
  });
});

describe('s7 Sc4 row 14: C-8 — no schema moved', () => {
  it('writes every knob and still declares zero indexes and no new table', async () => {
    const h = await boot();
    expect(
      (
        await patch(h, {
          'send.capGlobalPerHour': 99,
          'send.retryAsSms': true,
        })
      ).statusCode,
    ).toBe(200);
    const declared = h.store.db
      .prepare('SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL')
      .all() as { type: string; name: string }[];
    expect(declared.filter((o) => o.type === 'index')).toEqual([]);
    expect(
      declared.filter((o) => /setting/iu.test(o.name)).map((o) => o.name),
    ).toEqual(['settings']);
  });
});

describe('s7 Sc4 row 15: INV-2 — settings cannot reach a send path', () => {
  it('keeps both new modules off the port-importer allowlist', () => {
    expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(15);
    for (const entry of PORT_IMPORTER_ALLOWLIST) {
      expect(entry).not.toMatch(/settings/u);
    }
    // The allowlist is enforced by a textual scan, so the guard is only real
    // while these files stay silent about those port names.
    for (const file of [settingsSchemaFile, settingsRouteFile]) {
      const text = readFileSync(file, 'utf8');
      expect(text.includes('Send' + 'Backend'), file).toBe(false);
      expect(text.includes('ChatDb' + 'Reader'), file).toBe(false);
    }
  });
});

/* --------------------------------------------------------------------- *
 * A WS reader kept local: byte identity is the claim, so nothing here may
 * normalise anything on the way in.
 * --------------------------------------------------------------------- */

interface WsStream {
  frames: string[];
  waitFor(n: number, label?: string): Promise<void>;
  close(): Promise<void>;
}

const openStreams: SseStream[] = [];
const openSockets: WebSocket[] = [];

afterEach(async () => {
  await Promise.all(openStreams.splice(0).map((s) => s.close()));
  for (const ws of openSockets.splice(0)) ws.close();
});

function openWs(h: AgentHarness): Promise<WsStream> {
  const ws = new WebSocket(`${h.baseUrl}/v1/events`, { headers: h.headers });
  openSockets.push(ws);
  const frames: string[] = [];
  let notify: (() => void) | null = null;
  ws.on('message', (data) => {
    frames.push(String(data));
    notify?.();
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () =>
      resolve({
        frames,
        waitFor(n, label) {
          if (frames.length >= n) return Promise.resolve();
          return new Promise((ok, fail) => {
            const timer = setTimeout(
              () => fail(new Error(`ws: timed out waiting for ${label ?? n}`)),
              4000,
            );
            notify = () => {
              if (frames.length < n) return;
              clearTimeout(timer);
              ok();
            };
          });
        },
        close: () =>
          new Promise<void>((done) => {
            if (ws.readyState === ws.CLOSED) return done();
            ws.on('close', () => done());
            ws.close();
          }),
      }),
    );
    ws.on('error', reject);
  });
}

/**
 * s6-execution Part 2 Scenario 11 — arming state, pause and quick-disarm.
 *
 * One question, asked from five directions: **is this daemon allowed to
 * speak on its own right now, and until when?** `resolveArming` answers it
 * by DERIVING the posture from persisted state on every call. Nothing is
 * cached, nothing is scheduled, and no boolean named `armed` exists in any
 * table — which is the whole reason a restart cannot resurrect a stale
 * "yes" and there is no timer to drift.
 *
 * The five dimensions are `{disconnected, killSwitch, pause, schedule,
 * circuit}` and they are strictly ordered: `disconnected > kill-switch >
 * paused > outside-window > circuit-open` (§1.3.6, §1.7). Row 1 walks that
 * order as a table rather than as prose, because precedence bugs are
 * invisible until exactly two holds are set at once.
 *
 * `until` is computed independently of which hold won: it is the earliest
 * REAL horizon among the pause deadline, the current window's close and the
 * breaker's expiry, or `null` when nothing bounds the posture. An operator
 * watching a countdown wants to know when something will change, not which
 * of the reasons happens to own the clock.
 *
 * Pause is the polite one. It withdraws AUTONOMY and nothing else: drafting
 * continues, drafts collect, and a human can still approve and send. The
 * kill switch slams the whole outbound path shut. Row 3 asserts the two side
 * by side, because the difference between them is the entire reason pause
 * exists as a separate mechanism.
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type {
  ArmingState,
  AuditEvent,
  Draft,
  GateDecision,
  Handle,
  Message,
  Rule,
  Schedule,
  Ulid,
} from '@wemessage/core';
import {
  evaluateGate,
  maybeAutoApprove,
  parseChatGuid,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  windowCloseAfter,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_CONNECTION_STATE,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  SETTING_PAUSE_UNTIL,
} from '@wemessage/core';
import { createInboundDispatch, resolveArming } from '@wemessage/daemon';
import {
  ROUTE_TABLE,
  EMITTED_WS_EVENTS,
  WS_EVENT_VOCABULARY,
} from './transport-surface.snapshot.js';
import {
  auditActors,
  auditEvents,
  boot,
  CHAT,
  cleanupHarness,
  get,
  HANDLE,
  post,
  shutdown,
  T0,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(cleanupHarness);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
const OPEN_ID = `${'0'.repeat(24)}S1`;
const SHUT_ID = `${'0'.repeat(24)}S2`;

/**
 * Three horizons, deliberately at three different distances from T0 so that
 * "the earliest one" is a real choice at every row rather than a coincidence:
 *
 *   T0        12:00:00Z   every row starts here
 *   circuit   12:15:00Z   `send.circuitOpenedAt = T0` + the 15-minute default
 *   pause     12:30:00Z   what the rows that pause write
 *   window    13:00:00Z   the close of the 11:00–13:00 window
 */
const CIRCUIT_UNTIL = '2026-09-01T12:15:00.000Z';
const PAUSE_UNTIL = '2026-09-01T12:30:00.000Z';
const WINDOW_CLOSE = '2026-09-01T13:00:00.000Z';

const newUlid = monotonicFactory();

/** Armed at T0 and shutting at 13:00Z, UTC (one of arch guard (f)'s five). */
function openSchedule(): Schedule {
  return {
    id: OPEN_ID,
    name: 'midday',
    timezone: 'UTC',
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '11:00',
        end: '13:00',
      },
    ],
    enabled: true,
  };
}

/** Shut at T0 and every other instant this suite ever stands on. */
function shutSchedule(): Schedule {
  return {
    id: SHUT_ID,
    name: 'small-hours',
    timezone: 'UTC',
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '01:00',
        end: '02:00',
      },
    ],
    enabled: true,
  };
}

function makeRule(scheduleId: string | null, over: Partial<Rule> = {}): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    // All three scopes say auto, so every withheld below is a CLAMP or a
    // deny and never a narrow scope in the §2.4.3 ladder.
    respondMode: 'auto',
    scheduleId,
    outsideWindow: 'draft-only',
    allowGroupDrafts: true,
    matchAttachmentOnly: false,
    draftTtlMinutes: 480,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

interface WorldOptions {
  /** 'fully-connected' unless a row is about a degraded probe. */
  connection?: 'fully-connected' | 'read-only' | 'disconnected' | 'unsupported';
  killSwitch?: boolean;
  /** Written straight into `arming.pauseUntil`; the route is row 6's subject. */
  pause?: string;
  /**
   * 'none' seeds no rule at all (nothing bounds the schedule dimension),
   * 'open' a rule pointing at the 11:00–13:00 window, 'shut' one pointing at
   * a window that is closed at T0. 'unscheduled' is the third arming shape:
   * an enabled rule with `scheduleId: null`, which §3.2 defines as always
   * armed and therefore unbounded.
   */
  schedule?: 'none' | 'open' | 'shut' | 'unscheduled';
  circuit?: boolean;
  startIso?: string;
  /** The global scope, which has been unreachable from outside until row 7a. */
  globalMode?: 'draft-only' | 'auto';
}

/**
 * A booted daemon with exactly the holds a row names and nothing else. Every
 * dimension is set by writing the SAME persisted state production writes, so
 * a row that passes here is a row about the real derivation and not about a
 * test seam.
 */
async function world(opts: WorldOptions = {}): Promise<Harness> {
  const h = await boot({ startIso: opts.startIso ?? T0 });
  const res = await post(h, '/v1/adapters', {
    id: ADAPTER,
    kind: 'echo',
    displayName: ADAPTER,
  });
  expect(res.statusCode).toBe(201);

  if (opts.connection !== undefined) {
    h.store.setSetting(SETTING_CONNECTION_STATE, opts.connection);
  }
  if (opts.killSwitch === true) h.store.setSetting(SETTING_KILL_SWITCH, '1');
  if (opts.pause !== undefined) {
    h.store.setSetting(SETTING_PAUSE_UNTIL, opts.pause);
  }
  if (opts.circuit === true) {
    // The breaker's state is an INSTANT, not a flag (F-65): opened at T0, so
    // `circuitOpenUntil` derives 12:15Z from the 15-minute default.
    h.store.setSetting(SETTING_CIRCUIT_OPENED_AT, T0);
  }
  const schedule = opts.schedule ?? 'none';
  if (schedule === 'open' || schedule === 'shut') {
    h.store.insertSchedule(
      schedule === 'open' ? openSchedule() : shutSchedule(),
    );
    h.store.insertRule(makeRule(schedule === 'open' ? OPEN_ID : SHUT_ID));
  } else if (schedule === 'unscheduled') {
    h.store.insertRule(makeRule(null));
  }
  h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
  h.store.setSetting(SETTING_GLOBAL_MODE, opts.globalMode ?? 'auto');
  return h;
}

function arming(h: Harness): ArmingState {
  return resolveArming({ store: h.store, clock: h.clockCtl.clock });
}

/**
 * The default per-contact pacing cap is one auto send per two minutes
 * (F-66), so a row that auto-approves twice inside two fake minutes would be
 * measuring Sc 6. Raised by name at the call sites that need it, visible in
 * review, never a test-only bypass inside a production reader.
 */
function capsOutOfTheWay(h: Harness): void {
  h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
  h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '100');
  h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '100');
}

let seq = 0;

/** A synthetic inbound, mirrored so a draft can point at it. */
function inbound(h: Harness, over: Partial<Message> = {}): Message {
  seq += 1;
  const at = h.clockCtl.clock.now();
  const message: Message = {
    guid: `GUID-SC11-${String(seq)}`,
    sourceRowid: 11_000 + seq,
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
    ...over,
  };
  h.store.insertInboundMessage(message);
  return message;
}

/**
 * A rule-borne `pending` draft, inserted exactly as `adapters/submit.ts`
 * inserts one and pointed at a real mirrored inbound. Straight into the
 * store rather than over a socket: every row that uses it is about what
 * `maybeAutoApprove` DECIDES, and the composed inbound path that mints one
 * is proven end to end in Sc 5 and Sc 10.
 */
function pending(h: Harness, ttlMinutes = 480): Draft {
  const source = inbound(h);
  seq += 1;
  const at = h.clockCtl.clock.now();
  const draft: Draft = {
    id: newUlid(Date.parse(at)),
    inboundGuid: source.guid,
    chatGuid: CHAT,
    ruleId: RULE_ID,
    adapterId: ADAPTER,
    idempotencyKey: `idem-sc11-${String(seq)}`,
    body: 'on my way',
    originalBody: 'on my way',
    state: 'pending',
    stateChangedAt: at,
    expiresAt: new Date(Date.parse(at) + ttlMinutes * MINUTE).toISOString(),
    createdAt: at,
  };
  h.store.insertDraft(draft);
  return draft;
}

/** The production auto decision, with the daemon's own dependencies. */
function auto(h: Harness, draftId: Ulid): Promise<'approved' | 'withheld'> {
  return maybeAutoApprove(
    {
      store: h.store,
      clock: h.clockCtl.clock,
      sink: h.sink,
      newId: () => newUlid(Date.parse(h.clockCtl.clock.now())) as Ulid,
    },
    draftId,
  );
}

/** The gate at the context the DRAFT moment builds, for rows that name a cause. */
function decisionFor(h: Harness, draft: Draft): GateDecision {
  const now = h.clockCtl.clock.now();
  const rule = draft.ruleId === null ? null : h.store.getRule(draft.ruleId);
  const scheduleId = rule?.scheduleId ?? null;
  const parsed = parseChatGuid(draft.chatGuid);
  const handle: Handle = parsed.handle;
  return evaluateGate({
    now,
    settings: readGateSettings(h.store),
    rule,
    schedule: scheduleId === null ? null : h.store.getSchedule(scheduleId),
    contact: h.store.getContactPolicy(handle),
    message: {
      isGroup: parsed.isGroup,
      service: parsed.service,
      handle,
      chatGuid: draft.chatGuid,
    },
    counters: readGateCounters(h.store, {
      now,
      handle,
      chatGuid: draft.chatGuid,
    }),
    candidate: readLoopCandidate(h.store, {
      chatGuid: draft.chatGuid,
      body: draft.body,
    }),
  });
}

function events(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

/** Every `arming.changed` frame this harness has broadcast, in order. */
function armingFrames(h: Harness): Array<Record<string, unknown>> {
  return h.broadcasts
    .map((b) => b.frame as Record<string, unknown>)
    .filter((f) => f['event'] === 'arming.changed');
}

/** The §1.8 witness for the LAST `arming.changed` frame. */
function auditAtLastArmingFrame(h: Harness): string[] {
  const hits = h.broadcasts.filter(
    (b) => (b.frame as { event?: string }).event === 'arming.changed',
  );
  return hits.at(-1)?.auditAtBroadcast ?? [];
}

// --- Row 1: the precedence table -------------------------------------------

describe('s6 Sc11 row 1: resolveArming precedence over the five dimensions', () => {
  interface Row {
    name: string;
    opts: WorldOptions;
    expected: ArmingState;
  }

  const rows: Row[] = [
    {
      name: 'nothing held, one open window: armed, bounded by the window close',
      opts: { schedule: 'open' },
      expected: { armed: true, until: WINDOW_CLOSE, reason: 'armed' },
    },
    {
      name: 'nothing held, no rule at all: armed and unbounded',
      opts: { schedule: 'none' },
      expected: { armed: true, until: null, reason: 'armed' },
    },
    {
      name: 'nothing held, an unscheduled rule: armed and unbounded (§3.2)',
      opts: { schedule: 'unscheduled' },
      expected: { armed: true, until: null, reason: 'armed' },
    },
    {
      name: 'circuit alone: circuit-open, bounded by the breaker',
      opts: { schedule: 'none', circuit: true },
      expected: { armed: false, until: CIRCUIT_UNTIL, reason: 'circuit-open' },
    },
    {
      name: 'shut window alone: outside-window, and nothing bounds it',
      opts: { schedule: 'shut' },
      expected: { armed: false, until: null, reason: 'outside-window' },
    },
    {
      name: 'shut window beats circuit; until is still the earliest horizon',
      opts: { schedule: 'shut', circuit: true },
      expected: {
        armed: false,
        until: CIRCUIT_UNTIL,
        reason: 'outside-window',
      },
    },
    {
      name: 'pause alone: paused, bounded by its own deadline',
      opts: { schedule: 'none', pause: PAUSE_UNTIL },
      expected: { armed: false, until: PAUSE_UNTIL, reason: 'paused' },
    },
    {
      name: 'pause beats an open window; until is the earlier of the two',
      opts: { schedule: 'open', pause: PAUSE_UNTIL },
      expected: { armed: false, until: PAUSE_UNTIL, reason: 'paused' },
    },
    {
      name: 'pause beats a shut window and the breaker',
      opts: { schedule: 'shut', pause: PAUSE_UNTIL, circuit: true },
      expected: { armed: false, until: CIRCUIT_UNTIL, reason: 'paused' },
    },
    {
      name: 'kill switch beats pause, window and breaker',
      opts: {
        schedule: 'shut',
        pause: PAUSE_UNTIL,
        circuit: true,
        killSwitch: true,
      },
      expected: { armed: false, until: CIRCUIT_UNTIL, reason: 'kill-switch' },
    },
    {
      name: 'disconnected beats everything, including the kill switch',
      opts: {
        connection: 'disconnected',
        schedule: 'shut',
        pause: PAUSE_UNTIL,
        circuit: true,
        killSwitch: true,
      },
      expected: { armed: false, until: CIRCUIT_UNTIL, reason: 'disconnected' },
    },
    {
      name: 'read-only is its own reason, not folded into disconnected',
      opts: { connection: 'read-only', schedule: 'none' },
      expected: { armed: false, until: null, reason: 'read-only' },
    },
    {
      name: 'unsupported is its own reason too (F-73)',
      opts: { connection: 'unsupported', schedule: 'none' },
      expected: { armed: false, until: null, reason: 'unsupported' },
    },
  ];

  for (const row of rows) {
    it(row.name, async () => {
      const h = await world(row.opts);
      expect(arming(h)).toEqual(row.expected);
    });
  }

  it('derives fresh on every call: nothing is cached between two reads', async () => {
    const h = await world({ schedule: 'open' });
    expect(arming(h).armed).toBe(true);
    h.store.setSetting(SETTING_KILL_SWITCH, '1');
    expect(arming(h)).toEqual({
      armed: false,
      until: WINDOW_CLOSE,
      reason: 'kill-switch',
    });
  });
});

// --- Row 2: /v1/status stops lying -----------------------------------------

describe('s6 Sc11 row 2: /v1/status reports the arming state and the switch', () => {
  it('armed is the derived state, not null', async () => {
    const h = await world({ schedule: 'open' });
    const res = await get(h, '/v1/status');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { armed: unknown; killSwitch: unknown };
    expect(body.armed).toEqual({
      armed: true,
      until: WINDOW_CLOSE,
      reason: 'armed',
    });
    // The value has existed since S4 and the placeholder was a lie.
    expect(body.killSwitch).toBe(false);
  });

  it('follows the kill switch through the toggle route', async () => {
    const h = await world({ schedule: 'open' });
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);
    const body = (await get(h, '/v1/status')).json() as {
      armed: ArmingState;
      killSwitch: unknown;
    };
    expect(body.killSwitch).toBe(true);
    expect(body.armed.reason).toBe('kill-switch');
    expect(body.armed.armed).toBe(false);
  });
});

// --- Row 3: pause is polite, kill slams ------------------------------------

describe('s6 Sc11 row 3: pause suppresses autonomy only', () => {
  it('drafting continues, autonomy withholds, a human still sends', async () => {
    const h = await world({ schedule: 'open', pause: PAUSE_UNTIL });
    capsOutOfTheWay(h);

    // (a) drafting continues: the draft-moment gate ALLOWS, clamped rather
    // than denied, so `createInboundDispatch` still puts a request on the
    // wire and a draft still gets made.
    const frames: Array<{ type?: string }> = [];
    const dispatch = createInboundDispatch({
      store: h.store,
      clock: h.clockCtl.clock,
      sink: h.sink,
      reader: h.reader,
      transport: {
        isConnected: () => true,
        sendTo: (_id, frame) => {
          frames.push(frame as { type?: string });
          return true;
        },
      },
    });
    await dispatch.emitWinner(inbound(h), h.store.listRules());
    expect(frames.filter((f) => f.type === 'draft.request')).toHaveLength(1);

    // (b) autonomy withholds, and the recorded cause is the shut-window
    // literal pause reuses (F-68) rather than a new one.
    const draft = pending(h);
    const decision = decisionFor(h, draft);
    expect(decision).toMatchObject({ allow: true, mode: 'draft-only' });
    expect(decision).toHaveProperty('clampedBy', 'outside-window');
    expect(await auto(h, draft.id)).toBe('withheld');

    // (c) a human approval still sends. Pause is not the kill switch.
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(11_000);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
  });

  it('the kill switch refuses the same human approval, side by side', async () => {
    const h = await world({ schedule: 'open', killSwitch: true });
    capsOutOfTheWay(h);
    const draft = pending(h);

    expect(await auto(h, draft.id)).toBe('withheld');
    const res = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: 'kill-switch' });
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
  });
});

// --- Row 4: the deadline is on disk ----------------------------------------

describe('s6 Sc11 row 4: pause survives a restart', () => {
  it('a second daemon over the same store is still paused, same deadline', async () => {
    // No schedule, deliberately: the pause is then the ONLY hold and the only
    // horizon, so what survives the restart is unambiguously the pause and
    // not a window that happens to still be open on the other side.
    const h = await world({ schedule: 'none' });
    const res = await post(h, '/v1/toggles/pause', { until: '1h' });
    expect(res.statusCode).toBe(200);
    const until = (res.json() as { until: string }).until;
    expect(until).toBe(new Date(Date.parse(T0) + HOUR).toISOString());
    const restartAt = h.clockCtl.clock.now();

    await shutdown(h);
    const h2 = await boot({
      dir: h.dir,
      fixture: h.fixture,
      startIso: restartAt,
    });

    // Same row, same deadline, and the posture is derived from it rather
    // than re-announced by anything the reboot ran.
    expect(h2.store.getSetting(SETTING_PAUSE_UNTIL)).toBe(until);
    expect(arming(h2)).toEqual({
      armed: false,
      until,
      reason: 'paused',
    });

    // And it lifts on the ORIGINAL horizon, not an hour after the reboot —
    // the whole reason the state is a deadline and not a timer. Arch guard
    // (d) pins the negative: no production file puts `pauseUntil` inside a
    // `setTimeout`.
    h2.clockCtl.set(new Date(Date.parse(until)).toISOString());
    expect(arming(h2).reason).toBe('armed');
  });
});

// --- Row 5: a stale deadline is not a hold ---------------------------------

describe('s6 Sc11 row 5: a past deadline is not a pause', () => {
  it('resolves armed, because pause can only withdraw autonomy', async () => {
    const h = await world({
      schedule: 'none',
      pause: new Date(Date.parse(T0) - MINUTE).toISOString(),
    });
    expect(arming(h)).toEqual({ armed: true, until: null, reason: 'armed' });
  });

  it('cannot arm anything: a stale pause under a shut window is still shut', async () => {
    const h = await world({
      schedule: 'shut',
      pause: new Date(Date.parse(T0) - MINUTE).toISOString(),
    });
    expect(arming(h).reason).toBe('outside-window');
  });

  it('an UNREADABLE deadline is a hold with no horizon, not an absent one', async () => {
    // Fail-closed, the opposite direction from a past deadline: a row nobody
    // can parse is not a row this product wrote, and the reading that
    // silently restores autonomy is the wrong one to guess. An operator can
    // always clear it with `{until: null}`.
    const h = await world({ schedule: 'none', pause: 'not-an-instant' });
    expect(arming(h)).toEqual({ armed: false, until: null, reason: 'paused' });
  });
});

// --- Row 6: the deadline forms ---------------------------------------------

describe('s6 Sc11 row 6: POST /v1/toggles/pause deadline forms', () => {
  it("'1h' resolves to now + 3600s", async () => {
    const h = await world({ schedule: 'open' });
    const res = await post(h, '/v1/toggles/pause', { until: '1h' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { until: string }).until).toBe(
      new Date(Date.parse(T0) + HOUR).toISOString(),
    );
  });

  it("'until-tomorrow' resolves to the next 08:00 in the daemon HOST zone", async () => {
    const h = await world({ schedule: 'open' });
    const res = await post(h, '/v1/toggles/pause', { until: 'until-tomorrow' });
    expect(res.statusCode).toBe(200);
    const until = (res.json() as { until: string }).until;

    // Asserted host-agnostically on purpose: the row is about the operator's
    // OWN zone, which is whatever this machine is set to, and arch guard (f)
    // pins the five IANA strings any file may name. Naming a sixth here to
    // make the assertion prettier would be the thing the guard exists to
    // stop.
    const local = new Date(until);
    expect([local.getHours(), local.getMinutes(), local.getSeconds()]).toEqual([
      8, 0, 0,
    ]);
    expect(Date.parse(until)).toBeGreaterThan(Date.parse(T0));
    // At most a day away, with an hour of slack for a DST transition.
    expect(Date.parse(until)).toBeLessThanOrEqual(Date.parse(T0) + 25 * HOUR);
  });

  it("'rest-of-window' resolves to the armed schedule's close", async () => {
    const h = await world({ schedule: 'open' });
    const res = await post(h, '/v1/toggles/pause', { until: 'rest-of-window' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { until: string }).until).toBe(WINDOW_CLOSE);
    // Which is exactly what the window math says, read the same way.
    expect(windowCloseAfter(openSchedule(), T0)).toBe(WINDOW_CLOSE);
  });

  it("'rest-of-window' with nothing armed is 409 not-armed", async () => {
    const h = await world({ schedule: 'shut' });
    const res = await post(h, '/v1/toggles/pause', { until: 'rest-of-window' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not-armed' });
    expect(h.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
  });

  it("'rest-of-window' with an UNBOUNDED posture is 409 too", async () => {
    // Armed, but no window to rest out: there is no honest deadline here and
    // inventing one would be worse than refusing.
    const h = await world({ schedule: 'unscheduled' });
    expect(arming(h).armed).toBe(true);
    expect(
      (await post(h, '/v1/toggles/pause', { until: 'rest-of-window' }))
        .statusCode,
    ).toBe(409);
  });

  it('an explicit ISO instant in the future is taken verbatim', async () => {
    const h = await world({ schedule: 'open' });
    const res = await post(h, '/v1/toggles/pause', { until: PAUSE_UNTIL });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { until: string }).until).toBe(PAUSE_UNTIL);
    expect(arming(h).reason).toBe('paused');
  });

  it('an explicit ISO instant in the PAST is 400 and writes nothing', async () => {
    const h = await world({ schedule: 'open' });
    const past = new Date(Date.parse(T0) - MINUTE).toISOString();
    const res = await post(h, '/v1/toggles/pause', { until: past });
    expect(res.statusCode).toBe(400);
    expect(h.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
    expect(events(h, 'arming.paused')).toEqual([]);
  });

  it('a string that is neither a form nor an instant is 400', async () => {
    const h = await world({ schedule: 'open' });
    const res = await post(h, '/v1/toggles/pause', {
      until: 'next-tuesday-ish',
    });
    expect(res.statusCode).toBe(400);
    expect(h.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
  });
});

// --- Row 7: what the pause route writes and says ---------------------------

describe('s6 Sc11 row 7: pause and resume audit and announce', () => {
  it('audits arming.paused {until} under the human API actor', async () => {
    const h = await world({ schedule: 'open' });
    await post(h, '/v1/toggles/pause', { until: PAUSE_UNTIL });

    expect(events(h, 'arming.paused')).toEqual([
      { type: 'arming.paused', until: PAUSE_UNTIL },
    ]);
    expect(auditActors(h.store, 'arming.paused')).toEqual([
      { kind: 'human', via: 'api' },
    ]);
  });

  it('audits arming.resumed on {until: null} and clears the row', async () => {
    const h = await world({ schedule: 'open' });
    await post(h, '/v1/toggles/pause', { until: PAUSE_UNTIL });
    const res = await post(h, '/v1/toggles/pause', { until: null });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { until: string | null }).until).toBeNull();
    expect(h.store.getSetting(SETTING_PAUSE_UNTIL)).toBeNull();
    expect(events(h, 'arming.resumed')).toEqual([{ type: 'arming.resumed' }]);
    expect(auditActors(h.store, 'arming.resumed')).toEqual([
      { kind: 'human', via: 'api' },
    ]);
    expect(arming(h).reason).toBe('armed');
  });

  it('both broadcast arming.changed, and §1.8 puts the append first', async () => {
    const h = await world({ schedule: 'open' });
    await post(h, '/v1/toggles/pause', { until: PAUSE_UNTIL });
    expect(armingFrames(h)).toHaveLength(1);
    expect(armingFrames(h)[0]).toEqual({
      event: 'arming.changed',
      armed: false,
      until: PAUSE_UNTIL,
      reason: 'paused',
    });
    // The operator's row AND the derived row are durable before the frame.
    expect(auditAtLastArmingFrame(h)).toContain('arming.paused');
    expect(auditAtLastArmingFrame(h)).toContain('arming.changed');

    await post(h, '/v1/toggles/pause', { until: null });
    expect(armingFrames(h)).toHaveLength(2);
    expect(armingFrames(h)[1]).toMatchObject({
      armed: true,
      reason: 'armed',
      until: WINDOW_CLOSE,
    });
    expect(auditAtLastArmingFrame(h)).toContain('arming.resumed');
  });
});

// --- Row 7a: the ladder's top scope becomes settable (F-77) ----------------

describe("s6 Sc11 row 7a: POST /v1/toggles/global-mode sets the ladder's top scope", () => {
  it('the setting is unreachable before this route: a fresh daemon is draft-only', async () => {
    // The negative that matters. `send.globalMode` has been read by the gate
    // since S1 and written by NOBODY, so the three-scope ladder has never
    // had a reachable `auto` at its top. There is exactly one route that
    // writes it, and row 11 pins the count.
    const h = await boot();
    expect(h.store.getSetting(SETTING_GLOBAL_MODE)).toBeNull();
    expect(readGateSettings(h.store).globalMode).toBe('draft-only');
    expect(
      ROUTE_TABLE.filter((r) => r.endsWith('/v1/toggles/global-mode')),
    ).toEqual(['POST /v1/toggles/global-mode']);
  });

  it("{mode:'auto'} writes the setting, audits and announces", async () => {
    const h = await world({ schedule: 'open', globalMode: 'draft-only' });
    const res = await post(h, '/v1/toggles/global-mode', { mode: 'auto' });

    expect(res.statusCode).toBe(200);
    expect(h.store.getSetting(SETTING_GLOBAL_MODE)).toBe('auto');
    expect(readGateSettings(h.store).globalMode).toBe('auto');
    expect(events(h, 'arming.mode-changed')).toEqual([
      { type: 'arming.mode-changed', mode: 'auto' },
    ]);
    expect(auditActors(h.store, 'arming.mode-changed')).toEqual([
      { kind: 'human', via: 'api' },
    ]);
    expect(armingFrames(h)).toHaveLength(1);
    expect(auditAtLastArmingFrame(h)).toContain('arming.mode-changed');
  });

  it('an unknown mode is 400 invalid-mode and writes nothing', async () => {
    const h = await world({ schedule: 'open', globalMode: 'draft-only' });
    const res = await post(h, '/v1/toggles/global-mode', { mode: 'yolo' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid-mode' });
    expect(h.store.getSetting(SETTING_GLOBAL_MODE)).toBe('draft-only');
    expect(events(h, 'arming.mode-changed')).toEqual([]);
    expect(armingFrames(h)).toEqual([]);
  });

  it("back to 'draft-only' withdraws autonomy immediately", async () => {
    const h = await world({ schedule: 'open', globalMode: 'auto' });
    capsOutOfTheWay(h);
    const first = pending(h);
    expect(await auto(h, first.id)).toBe('approved');

    expect(
      (await post(h, '/v1/toggles/global-mode', { mode: 'draft-only' }))
        .statusCode,
    ).toBe(200);

    // The next decision is withheld. The in-grace approval above is left to
    // the send-moment re-gate (the kill-switch disjunction shape, not a
    // second cancel path).
    h.clockCtl.advance(3 * MINUTE);
    const second = pending(h);
    expect(await auto(h, second.id)).toBe('withheld');
  });
});

// --- Row 8: on-change only -------------------------------------------------

describe('s6 Sc11 row 8: sweepArming emits on change and never on a tick', () => {
  it('twenty ticks inside one window produce exactly one row', async () => {
    const h = await world({ schedule: 'open' });
    for (let i = 0; i < 20; i += 1) {
      await h.scheduler.tick();
      h.clockCtl.advance(MINUTE);
    }
    expect(events(h, 'arming.changed')).toHaveLength(1);
    expect(armingFrames(h)).toHaveLength(1);
    expect(events(h, 'arming.changed')[0]).toMatchObject({
      from: null,
      to: { armed: true, reason: 'armed' },
    });
  });

  it('a window closing between two ticks produces exactly one more', async () => {
    const h = await world({ schedule: 'open' });
    await h.scheduler.tick();
    expect(events(h, 'arming.changed')).toHaveLength(1);

    h.clockCtl.set(WINDOW_CLOSE);
    await h.scheduler.tick();
    await h.scheduler.tick();
    await h.scheduler.tick();

    const rows = events(h, 'arming.changed');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      from: { armed: true, reason: 'armed' },
      to: { armed: false, until: null, reason: 'outside-window' },
    });
    expect(armingFrames(h)).toHaveLength(2);
  });

  it('the derived row is a SYSTEM actor, never the operator', async () => {
    const h = await world({ schedule: 'open' });
    await h.scheduler.tick();
    const actors = auditActors(h.store, 'arming.changed');
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ kind: 'system' });
  });
});

// --- Row 9: every disarm collapses autonomy --------------------------------

describe('s6 Sc11 row 9: every disarm collapses autonomy', () => {
  const disarms: Array<[string, WorldOptions]> = [
    ['the kill switch', { schedule: 'open', killSwitch: true }],
    ['a live pause', { schedule: 'open', pause: PAUSE_UNTIL }],
    ['a shut window', { schedule: 'shut' }],
    ['an open breaker', { schedule: 'open', circuit: true }],
    ['a degraded doctor probe', { schedule: 'open', connection: 'read-only' }],
  ];

  for (const [name, opts] of disarms) {
    it(`${name} withholds autonomy and reports armed: false`, async () => {
      const h = await world(opts);
      capsOutOfTheWay(h);
      const draft = pending(h);
      expect(await auto(h, draft.id)).toBe('withheld');
      expect(arming(h).armed).toBe(false);
      expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    });
  }

  it('TTL expiry expires the draft rather than sending it', async () => {
    const h = await world({ schedule: 'open' });
    capsOutOfTheWay(h);
    const draft = pending(h, 5);
    h.clockCtl.advance(6 * MINUTE);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('expired');
    expect(h.backend.callCount()).toBe(0);
    // C-6: expiry is not a denial. The gate was never consulted.
    expect(events(h, 'gate.denied')).toEqual([]);
  });
});

// --- Row 10: unsupported denies (F-73) -------------------------------------

describe('s6 Sc11 row 10: connectionState unsupported denies', () => {
  it('readGateSettings CARRIES it instead of collapsing it', async () => {
    const h = await world({ schedule: 'open', connection: 'unsupported' });
    expect(readGateSettings(h.store).connectionState).toBe('unsupported');
  });

  it('the gate denies, exactly as it denies disconnected', async () => {
    const h = await world({ schedule: 'open', connection: 'unsupported' });
    capsOutOfTheWay(h);
    const draft = pending(h);
    // The DISPLAY value lives in `ArmingReason`, which has four connection
    // values; `GateDenyReason` has three and this slice mints nothing into
    // it, so a Mac that cannot send at all is refused under the literal
    // that already means "this daemon cannot send".
    expect(decisionFor(h, draft)).toEqual({
      allow: false,
      reason: 'disconnected',
    });
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(arming(h).reason).toBe('unsupported');
  });

  it('a value outside the enum still defaults to disconnected', async () => {
    const h = await world({ schedule: 'open' });
    h.store.setSetting(SETTING_CONNECTION_STATE, 'bogus');
    expect(readGateSettings(h.store).connectionState).toBe('disconnected');
    expect(arming(h).reason).toBe('disconnected');
  });
});

// --- Row 11: ratchet #20 ---------------------------------------------------

describe('s6 Sc11 row 11: the transport surface grew by exactly two routes', () => {
  it('ROUTE_TABLE names both new POSTs, and the ratchet has moved on', () => {
    // 60 after Sc 3's +7. Two POSTs, and POST routes never get an auto-HEAD
    // twin (the POST /v1/rules precedent), so +2 and not +4: 62 at the close
    // of S6, which is what this row pinned when it was written.
    //
    // s7 Sc3 (ratchet #21) added `GET /v1/events/sse` and the auto-HEAD twin
    // fastify mints for it — +2 the other way round from this row's +2, since
    // a GET costs two entries and a POST costs one — so the absolute total is
    // now 64. The row's actual claim is unchanged and still checked below:
    // BOTH arming POSTs are reachable surface. The total is updated rather
    // than deleted because it is what catches a route nobody meant to add.
    expect(ROUTE_TABLE).toHaveLength(64);
    expect(ROUTE_TABLE).toContain('POST /v1/toggles/pause');
    expect(ROUTE_TABLE).toContain('POST /v1/toggles/global-mode');
  });

  it('arming.changed joins BOTH WS lists in the same diff', () => {
    expect(WS_EVENT_VOCABULARY).toContain('arming.changed');
    expect(EMITTED_WS_EVENTS).toContain('arming.changed');
    // S6's ONE protocol addition (F-67).
    expect(WS_EVENT_VOCABULARY).toHaveLength(17);
    expect(EMITTED_WS_EVENTS).toHaveLength(17);
  });
});

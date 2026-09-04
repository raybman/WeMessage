/**
 * s6-execution Part 2 Scenario 7 — the circuit breaker and `resume --circuit`.
 * Spec rows 1-8; §1.7 "Circuit breaker (Sc 7)"; flags F-65 (gate denials are
 * NOT failures), F-61 (the state is a `settings` row, no migration) and F-62
 * (the failure count is DERIVED from `drafts`, no new table and no index).
 *
 * **What the breaker is for, and what it deliberately is not.** It protects
 * against a broken SEND PATH: a backend that has started refusing, a Messages
 * install that stopped verifying, a machine that went sideways at 3am. It is
 * not a policy mechanism. That distinction is the whole of F-65 and it is the
 * reason `countSendFailuresSince` excludes `gate-denied` failures in SQL — a
 * kill switch working correctly is not a broken send path, and a breaker that
 * counted denials would turn one deliberate operator action into a
 * fifteen-minute outage, i.e. turning safety on would turn more safety on.
 *
 * **The state is an instant, not a boolean and not a timer.** `send.circuitOpenedAt`
 * is written once when the threshold is crossed and read lazily at every
 * evaluation; "open" is the arithmetic `now < openedAt + 15min`. Nothing is
 * scheduled, so a restart cannot resurrect a stale horizon and a fifteen-minute
 * window cannot drift by however long the process was asleep. Row 3 asserts
 * the close is lazy by advancing the clock past the horizon and checking that
 * NOTHING happened until the next evaluation asked.
 *
 * **Where the breaker stops something in THIS scenario.** The gate treats an
 * open circuit as a CLAMP (§1.7 step 7), not a deny — a clamp is asserted in
 * `scope-resolution.spec.ts`, where the gate is pure. The one thing that
 * STOPS here is row 8: drafts still inside their undo grace when the breaker
 * trips are rejected through the pre-existing `approved + reject` row with
 * the pre-existing `'circuit-breaker'` system actor, exactly as the kill
 * switch already cancels in-grace drafts. Turning a clamp into a send-moment
 * refusal was Sc 10's job (F-59, the context-bearing re-gate), and it landed
 * without moving a single assertion here: that refusal binds an approval the
 * MACHINE made, and every send in this suite is approved through the route
 * by a person. A breaker that vetoes a person is a bug (Sc 8 row 7).
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@wemessage/core';
import {
  CIRCUIT_TOGGLE_KEY,
  readGateCounters,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_KILL_SWITCH,
} from '@wemessage/core';
import {
  auditActors,
  auditEvents,
  boot,
  CHAT,
  cleanupHarness,
  createDraft,
  HANDLE,
  post,
  shutdown,
  T0,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(cleanupHarness);

const MINUTE = 60_000;
/** `DEFAULT_UNDO_GRACE_SECONDS` (routes/drafts.ts) in ms. */
const GRACE_MS = 10_000;
/** A sabotaged send burns `VERIFY_BUDGET_MS` of fake clock before parking. */
const VERIFY_MS = 10_000;
/** One failing send therefore costs exactly this much fake time. */
const FAILURE_MS = GRACE_MS + VERIFY_MS;

function approve(h: Harness, draftId: string) {
  return post(h, `/v1/drafts/${draftId}/approve`);
}

/** The gate's own view, read exactly where every production call site reads it. */
function circuitOpen(h: Harness): boolean {
  return readGateCounters(h.store, {
    now: h.clockCtl.clock.now(),
    handle: HANDLE,
    chatGuid: CHAT,
  }).circuitOpen;
}

function auditOf(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

/** Every `toggle.changed` row this suite cares about, breaker only. */
function circuitToggles(h: Harness): AuditEvent[] {
  return auditOf(h, 'toggle.changed').filter(
    (e) => 'key' in e && e.key === CIRCUIT_TOGGLE_KEY,
  );
}

function frames(h: Harness): unknown[] {
  return h.broadcasts.map((b) => b.frame);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * One REAL failing send: create, approve, wait out the undo grace, let the
 * scheduler dispatch it, and let the sabotaged backend fail verification.
 * Nothing here is a stand-in — this is the same path a live send takes, which
 * is what makes the failure it leaves in `drafts` the same row the breaker
 * counts.
 */
async function failOneSend(h: Harness, body: string): Promise<string> {
  const draft = await createDraft(h, body);
  expect((await approve(h, draft.id)).statusCode).toBe(200);
  h.clockCtl.advance(GRACE_MS);
  await h.scheduler.tick();
  expect(h.store.getDraft(draft.id)?.state).toBe('failed');
  expect(h.store.getDraft(draft.id)?.error?.code).toBe('unverified');
  return draft.id;
}

/**
 * Five real failing sends inside ten minutes, then one more draft approved and
 * still INSIDE its undo grace when the next evaluation runs. Returns that
 * sixth draft's id: it is the one the breaker catches (rows 1 and 8).
 */
async function tripBreaker(h: Harness): Promise<string> {
  h.backend.sabotage();
  for (let i = 0; i < 5; i += 1) await failOneSend(h, `doomed ${String(i)}`);
  // Nothing has evaluated the circuit yet, and nothing is supposed to have:
  // the state is derived on demand, so it is written by the first evaluation
  // that sees the threshold crossed and not by the failure itself.
  expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();

  const sixth = await createDraft(h, 'the one the breaker catches');
  expect((await approve(h, sixth.id)).statusCode).toBe(200);
  // Its grace has NOT elapsed, so this tick dispatches nothing at all. The
  // only thing it does is evaluate the circuit.
  await h.scheduler.tick();
  return sixth.id;
}

// --- RED row 1 -------------------------------------------------------------

describe('s6 Sc7 row 1: five failures in ten minutes open the breaker', () => {
  it('writes the instant, audits and broadcasts the flip, and stops the sixth', async () => {
    const h = await boot();
    const sixth = await tripBreaker(h);
    const openedAt = h.clockCtl.clock.now();

    // The state: one settings row holding one instant (F-61 — no column, no
    // table, no migration).
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBe(openedAt);
    expect(circuitOpen(h)).toBe(true);

    // The record, then the notice (§1.8).
    expect(circuitToggles(h)).toEqual([
      { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: true },
    ]);
    expect(frames(h)).toContainEqual({
      event: 'toggle.changed',
      key: CIRCUIT_TOGGLE_KEY,
      value: true,
      actor: { kind: 'system', reason: 'circuit-breaker' },
    });

    // The sixth never reached the backend: five sends attempted, five failed,
    // and the one the breaker caught was stopped before it was ever tried.
    expect(h.backend.callCount()).toBe(5);
    const caught = h.store.getDraft(sixth);
    expect(caught?.state).toBe('rejected');
    expect(caught?.error?.code).toBe('circuit-open');
    expect(auditOf(h, 'gate.denied')).toEqual([
      { type: 'gate.denied', draftId: sixth, reason: 'circuit-open' },
    ]);
  });

  it('appends before it broadcasts, for the flip and for the draft it caught', async () => {
    const h = await boot();
    const sixth = await tripBreaker(h);

    const flip = h.broadcasts.find(
      (b) => (b.frame as { event?: string }).event === 'toggle.changed',
    );
    expect(flip?.auditAtBroadcast).toContain('toggle.changed');

    const rejected = h.broadcasts.find(
      (b) =>
        (b.frame as { event?: string; draftId?: string }).event ===
          'draft.rejected' &&
        (b.frame as { draftId?: string }).draftId === sixth,
    );
    // Both of the draft's rows are durable before its courtesy frame goes out:
    // a dropped socket loses the notice, never the record of what was stopped.
    expect(rejected?.auditAtBroadcast).toContain('gate.denied');
    expect(rejected?.auditAtBroadcast).toContain('draft.rejected');
  });
});

// --- RED row 2 -------------------------------------------------------------

describe('s6 Sc7 row 2: four is not five, and the window slides', () => {
  it('four failures leave the breaker closed', async () => {
    const h = await boot();
    h.backend.sabotage();
    for (let i = 0; i < 4; i += 1) await failOneSend(h, `four ${String(i)}`);
    await h.scheduler.tick();

    expect(h.store.countSendFailuresSince(T0)).toBe(4);
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    expect(circuitOpen(h)).toBe(false);
    expect(circuitToggles(h)).toEqual([]);
  });

  it('a fifth failure eleven minutes after the first does not open it', async () => {
    const h = await boot();
    h.backend.sabotage();

    await failOneSend(h, 'the first');
    const firstAtMs = Date.parse(h.clockCtl.clock.now());
    // Three more, spread so they are all still inside the ten-minute window
    // when the fifth lands. If they were not, this row would prove nothing
    // beyond "four failures do not open it", which the row above already says.
    for (let i = 0; i < 3; i += 1) {
      h.clockCtl.advance(2 * MINUTE);
      await failOneSend(h, `middle ${String(i)}`);
    }

    // The fifth lands exactly eleven minutes after the first, so the first has
    // swept past the trailing edge: five failures exist, four are in scope.
    h.clockCtl.set(iso(firstAtMs + 11 * MINUTE - FAILURE_MS));
    await failOneSend(h, 'the fifth, too late to count with the first');
    expect(h.clockCtl.clock.now()).toBe(iso(firstAtMs + 11 * MINUTE));
    await h.scheduler.tick();

    expect(h.store.countSendFailuresSince(T0)).toBe(5);
    expect(
      h.store.countSendFailuresSince(
        iso(firstAtMs + 11 * MINUTE - 10 * MINUTE),
      ),
    ).toBe(4);
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    expect(circuitOpen(h)).toBe(false);
    expect(circuitToggles(h)).toEqual([]);
  });
});

// --- RED row 3 -------------------------------------------------------------

describe('s6 Sc7 row 3: it closes itself, lazily and without a timer', () => {
  it('is still open one millisecond before the horizon', async () => {
    const h = await boot();
    await tripBreaker(h);
    h.clockCtl.advance(15 * MINUTE - 1);
    expect(circuitOpen(h)).toBe(true);
  });

  it('closes fifteen minutes later, at the next evaluation rather than by a timer', async () => {
    const h = await boot();
    await tripBreaker(h);
    const openedAt = h.store.getSetting(SETTING_CIRCUIT_OPENED_AT);
    expect(openedAt).not.toBeNull();

    h.clockCtl.advance(15 * MINUTE);

    // NOTHING has run. No callback fired, no sweep was scheduled, and the row
    // is still sitting in `settings` exactly as it was written — and yet the
    // gate already reads the breaker as closed, because "open" is arithmetic
    // over a persisted instant and not a flag somebody has to remember to
    // clear. This is the assertion that says there is no timer: if one
    // existed, the audit row below would already be here.
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBe(openedAt);
    expect(circuitOpen(h)).toBe(false);
    expect(circuitToggles(h)).toEqual([
      { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: true },
    ]);

    // The next evaluation is what makes it observable.
    await h.scheduler.tick();
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    expect(circuitToggles(h)).toEqual([
      { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: true },
      { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: false },
    ]);
    expect(frames(h)).toContainEqual({
      event: 'toggle.changed',
      key: CIRCUIT_TOGGLE_KEY,
      value: false,
      actor: { kind: 'system', reason: 'circuit-breaker' },
    });

    // And it is announced exactly once: a lazy close that re-announces on
    // every tick is a log nobody can read.
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(circuitToggles(h)).toHaveLength(2);
  });
});

// --- RED row 4 (the teeth row, TN-circuit-counts-denials) ------------------

describe('s6 Sc7 row 4: gate denials are not failures (F-65)', () => {
  it('fifty kill-switch denials leave the circuit closed', async () => {
    const h = await boot();
    // Explicit, visible headroom (F-66): fifty approvals is well past the
    // shipped global bound of 30/hr, and a 403 there would silently turn this
    // row into "we only tried twenty-nine".
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '1000');

    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const draft = await createDraft(h, `refused ${String(i)}`);
      expect((await approve(h, draft.id)).statusCode).toBe(200);
      // The switch goes on AFTER the grace has elapsed, so the draft is out of
      // `cancelGraceApproved`'s reach and the refusal happens at the send
      // moment — the one that parks it 'failed' with {code:'gate-denied'},
      // which is precisely the row that looks like a backend error.
      h.clockCtl.advance(GRACE_MS);
      h.store.setSetting(SETTING_KILL_SWITCH, '1');
      await h.scheduler.tick();
      h.store.setSetting(SETTING_KILL_SWITCH, '0');
      ids.push(draft.id);
    }

    // The fixture is real: fifty drafts, all terminally 'failed', all carrying
    // the code a re-gate denial writes.
    for (const id of ids) {
      const draft = h.store.getDraft(id);
      expect(draft?.state).toBe('failed');
      expect(draft?.error?.code).toBe('gate-denied');
    }
    // Nothing was ever sent, which is the point: there is no broken send path
    // here, only a switch doing its job.
    expect(h.backend.callCount()).toBe(0);

    // Asserted directly on the port — this is the SQL predicate F-65 is about.
    expect(h.store.countSendFailuresSince(T0)).toBe(0);

    // And end to end: no instant written, no flip audited, gate still clear.
    await h.scheduler.tick();
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    expect(circuitOpen(h)).toBe(false);
    expect(circuitToggles(h)).toEqual([]);
  });

  it('a real send failure alongside them still counts', async () => {
    const h = await boot();
    // The other half of the same claim: the exclusion is about the CODE, not
    // about the state. Without this row the predicate could be narrowed to
    // "count nothing" and row 4 above would still pass.
    h.backend.sabotage();
    await failOneSend(h, 'a genuinely broken send');
    expect(h.store.countSendFailuresSince(T0)).toBe(1);
  });
});

// --- RED row 5 -------------------------------------------------------------

describe('s6 Sc7 row 5: the kill switch and the breaker are independent holds', () => {
  it('lifting the kill switch leaves an open breaker open', async () => {
    const h = await boot();
    await tripBreaker(h);
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);

    const res = await post(h, '/v1/toggles/kill-switch', { on: false });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ on: false, circuitCleared: false });
    expect(h.store.getSetting(SETTING_KILL_SWITCH)).toBe('0');
    expect(circuitOpen(h)).toBe(true);
  });

  it('resetting the breaker leaves the kill switch on', async () => {
    const h = await boot();
    await tripBreaker(h);
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);

    const res = await post(h, '/v1/toggles/kill-switch', {
      on: true,
      circuit: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ on: true, circuitCleared: true });
    expect(h.store.getSetting(SETTING_KILL_SWITCH)).toBe('1');
    expect(h.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBeNull();
    expect(circuitOpen(h)).toBe(false);
  });

  it('clearing a breaker that was never open writes nothing at all', async () => {
    const h = await boot();
    const res = await post(h, '/v1/toggles/kill-switch', {
      on: false,
      circuit: true,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ circuitCleared: false });
    // Idempotent and silent: clearing a hold that was not set is a no-op that
    // produces no audit noise, so `resume` can clear every hold blindly.
    expect(circuitToggles(h)).toEqual([]);
  });
});

// --- RED row 6 -------------------------------------------------------------

describe('s6 Sc7 row 6: the breaker survives a restart', () => {
  it('a fresh store over the same file still reports it open', async () => {
    const h = await boot();
    await tripBreaker(h);
    const openedAt = h.store.getSetting(SETTING_CIRCUIT_OPENED_AT);
    const restartAt = h.clockCtl.clock.now();
    expect(circuitOpen(h)).toBe(true);

    await shutdown(h);
    const h2 = await boot({
      dir: h.dir,
      fixture: h.fixture,
      startIso: restartAt,
    });

    expect(h2.store.getSetting(SETTING_CIRCUIT_OPENED_AT)).toBe(openedAt);
    expect(circuitOpen(h2)).toBe(true);
    // Nothing re-announced it and nothing re-armed: the posture is read from
    // the row, so a reboot inside the window is invisible except that the
    // breaker is still open.
    expect(circuitToggles(h2)).toEqual([
      { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: true },
    ]);

    // And it still closes on the ORIGINAL horizon, not fifteen minutes after
    // the reboot — the whole reason the state is an instant and not a timer.
    h2.clockCtl.set(iso(Date.parse(openedAt ?? T0) + 15 * MINUTE));
    expect(circuitOpen(h2)).toBe(false);
  });
});

// --- RED row 8 (row 7 is the CLI row, in drafts-cli.spec.ts) ---------------

describe('s6 Sc7 row 8: the in-grace rejection reuses what already exists', () => {
  it('is an approved -> rejected transition by the circuit-breaker system actor', async () => {
    const h = await boot();
    const sixth = await tripBreaker(h);

    // The pre-existing system reason (§3.2 has carried 'circuit-breaker'
    // unminted since S1). No new actor, no new transition, no new event type.
    expect(auditActors(h.store, 'draft.rejected')).toEqual([
      { kind: 'system', reason: 'circuit-breaker' },
    ]);
    expect(h.store.getDraft(sixth)?.state).toBe('rejected');
    // Its grace is gone with it: a rejected draft has nothing left to fire.
    expect(h.store.getDraft(sixth)?.sendNotBefore).toBeUndefined();

    // A draft whose grace had ALREADY elapsed is not this mechanism's to
    // stop — it belongs to the send-moment re-gate, which since Sc 10 (F-59)
    // reads the breaker for itself. It refuses the machine's approvals only,
    // so a second tick still finds nothing here to reject.
    await h.scheduler.tick();
    expect(auditOf(h, 'draft.rejected')).toHaveLength(1);
  });
});

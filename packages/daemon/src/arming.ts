/**
 * Arming (s6-execution Part 2 Scenario 11, §1.3.6 / §1.7 "Arming"; F-67,
 * F-68, F-73).
 *
 * One question, asked from five directions: **is this daemon allowed to
 * speak on its own right now, and until when?** The five dimensions are the
 * connection, the kill switch, the operator's pause, the schedules and the
 * breaker, and they are strictly ordered:
 *
 *   disconnected > kill-switch > paused > outside-window > circuit-open
 *
 * **Nothing is stored and nothing is scheduled.** There is no column called
 * `armed`, no cached `ArmingState`, and no timer anywhere in this file. Every
 * call re-derives the posture from persisted state against the injected
 * clock, which is what makes the three properties below true by construction
 * rather than by discipline:
 *
 *  - a restart cannot resurrect a stale "yes": there is no yes on disk to
 *    resurrect, only the deadlines the holds are made of;
 *  - a daemon asleep through its own pause wakes up armed, and one restarted
 *    a minute in resumes with the rest of the pause intact;
 *  - the gate can never disagree with the badge, because both read the same
 *    rows the same way (arch guard (d) pins the no-timer half).
 *
 * This lives in the daemon rather than core for the usual two reasons. It
 * needs a `Store` and a sink to be observable, and the schedule dimension is
 * a union over the RULE TABLE — `evaluateGate` judges one message against one
 * rule, while an operator's badge is a statement about the whole daemon.
 *
 * §1.8 throughout: the audit row is durable before its frame goes out.
 */
import {
  circuitOpenUntil,
  humanApiActor,
  isArmed,
  systemActor,
  windowCloseAfter,
  SETTING_KILL_SWITCH,
  SETTING_PAUSE_UNTIL,
  type ArmingReason,
  type ArmingState,
  type Clock,
  type IsoUtc,
  type Store,
} from '@wemessage/core';
import { readConnectionState } from './doctor.js';
import type { AuditSink } from './audit-sink.js';

/**
 * The last posture that was ANNOUNCED, as JSON, so `sweepArming` can tell a
 * change from a tick (F-67).
 *
 * A settings row rather than a module variable, for the same reason the pause
 * deadline is one: a daemon that restarts inside a shut window must not
 * re-announce a transition that already happened, and an in-memory witness
 * would re-announce it on every boot. `null` (no row) means "never announced",
 * which is a real and distinct state — it is what makes the FIRST sweep after
 * an install emit exactly one row.
 */
export const SETTING_ARMING_LAST_BROADCAST = 'arming.lastBroadcast';

export interface ArmingDeps {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'listRules' | 'getSchedule'>;
  clock: Clock;
}

export interface ArmingSweepDeps extends ArmingDeps {
  store: Pick<
    Store,
    'getSetting' | 'setSetting' | 'deleteSetting' | 'listRules' | 'getSchedule'
  >;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/**
 * Is the operator's pause in force, and until when?
 *
 * `{paused: true, until: null}` for a deadline nobody can parse: fail-closed,
 * matching the gate's own reading of the same row. A pause is a request for
 * silence, and the wrong guess on a corrupt row is the one that speaks.
 */
function pauseHold(
  store: ArmingDeps['store'],
  now: IsoUtc,
): { paused: boolean; until: IsoUtc | null } {
  const raw = store.getSetting(SETTING_PAUSE_UNTIL);
  if (raw === null) return { paused: false, until: null };
  const untilMs = Date.parse(raw);
  if (!Number.isFinite(untilMs)) return { paused: true, until: null };
  if (Date.parse(now) >= untilMs) return { paused: false, until: null };
  return { paused: true, until: new Date(untilMs).toISOString() };
}

/**
 * The schedule dimension for the WHOLE daemon: is any enabled rule's window
 * open, and when does the last of them shut?
 *
 * Three cases, and the reasoning for each is the same sentence read three
 * ways — "could this daemon speak autonomously about SOMETHING right now":
 *
 *  - no enabled rules at all: armed and unbounded. A daemon with nothing to
 *    do is not a daemon being held back, and reporting `outside-window` on a
 *    fresh install would be a hold an operator cannot find or clear.
 *  - an enabled rule with no schedule: armed and unbounded (§3.2, always
 *    armed). One such rule is enough; there is no window to report.
 *  - otherwise armed iff at least one referenced schedule is armed, and the
 *    horizon is the LATEST close among the armed ones, because that is when
 *    the daemon actually stops being able to speak.
 *
 * A rule pointing at a schedule that no longer exists is SKIPPED, matching
 * `scheduleClosed` in the gate: a dangling reference withdraws autonomy for
 * that rule rather than granting it.
 */
function scheduleHold(
  store: ArmingDeps['store'],
  now: IsoUtc,
): { armed: boolean; until: IsoUtc | null } {
  const enabled = store.listRules().filter((rule) => rule.enabled);
  if (enabled.length === 0) return { armed: true, until: null };

  let armed = false;
  let latestClose: IsoUtc | null = null;
  for (const rule of enabled) {
    if (rule.scheduleId === null) return { armed: true, until: null };
    const schedule = store.getSchedule(rule.scheduleId);
    if (schedule === null) continue;
    if (!isArmed(schedule, now)) continue;
    armed = true;
    const close = windowCloseAfter(schedule, now);
    // A window with no computable close (a schedule armed every minute of
    // the scan horizon) is armed WITHOUT a horizon, and an unbounded window
    // has to win over a bounded one: the daemon does not stop speaking when
    // the bounded one shuts.
    if (close === null) return { armed: true, until: null };
    if (latestClose === null || Date.parse(close) > Date.parse(latestClose)) {
      latestClose = close;
    }
  }
  return { armed, until: latestClose };
}

/**
 * The close of the currently-armed window, for `POST /v1/toggles/pause`'s
 * `rest-of-window` form (F-68).
 *
 * `null` when nothing is armed AND when what is armed has no window to rest
 * out — an always-on rule, or none at all. The route turns both into the same
 * `409 not-armed`, which is the honest answer: there is no deadline to
 * compute, and inventing one would be worse than refusing. Read from the
 * SCHEDULE dimension alone rather than from `resolveArming().until`, because
 * that field is the earliest of three horizons and an operator asking to
 * pause for the rest of their window did not ask about the breaker.
 */
export function armedWindowClose(deps: ArmingDeps): IsoUtc | null {
  const hold = scheduleHold(deps.store, deps.clock.now());
  return hold.armed ? hold.until : null;
}

/** The earliest of a set of horizons, ignoring the absent ones. */
function earliest(candidates: Array<IsoUtc | null>): IsoUtc | null {
  let best: IsoUtc | null = null;
  for (const at of candidates) {
    if (at === null) continue;
    if (best === null || Date.parse(at) < Date.parse(best)) best = at;
  }
  return best;
}

/**
 * The whole posture, derived (§1.7).
 *
 * `until` is computed independently of which hold won: it is the earliest
 * REAL horizon among the pause deadline, the current window's close and the
 * breaker's expiry. An operator watching a countdown wants to know when
 * something will next change, not which of several holds happens to own the
 * clock — and the alternative, reporting only the winning reason's own
 * horizon, would show a five-minute countdown that expires into a still-shut
 * daemon.
 */
export function resolveArming(deps: ArmingDeps): ArmingState {
  const { store, clock } = deps;
  const now = clock.now();

  const pause = pauseHold(store, now);
  const schedule = scheduleHold(store, now);
  const circuitUntil = circuitOpenUntil(store, now);
  const until = earliest([pause.until, schedule.until, circuitUntil]);

  const state = (reason: ArmingReason): ArmingState => ({
    armed: reason === 'armed',
    until,
    reason,
  });

  // Precedence, §1.3.6, top to bottom. A host that cannot send at all
  // outranks a switch, which outranks a hand, which outranks a calendar,
  // which outranks a breaker: the further up this list a hold sits, the less
  // anything below it can do about the silence.
  const connection = readConnectionState(store);
  if (connection !== 'fully-connected') return state(connection);
  if (store.getSetting(SETTING_KILL_SWITCH) === '1')
    return state('kill-switch');
  if (pause.paused) return state('paused');
  if (!schedule.armed) return state('outside-window');
  if (circuitUntil !== null) return state('circuit-open');
  return state('armed');
}

function sameState(a: ArmingState | null, b: ArmingState): boolean {
  return (
    a !== null &&
    a.armed === b.armed &&
    a.until === b.until &&
    a.reason === b.reason
  );
}

/** The last announced posture, or `null` when nothing has ever been announced. */
function lastBroadcast(store: ArmingDeps['store']): ArmingState | null {
  const raw = store.getSetting(SETTING_ARMING_LAST_BROADCAST);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ArmingState;
  } catch {
    // A witness nobody can read is a witness that has not seen anything. The
    // cost of the wrong guess here is one redundant announcement, which is
    // the cheapest failure available.
    return null;
  }
}

export interface SweepArmingOptions {
  /**
   * Announce even when the posture did not change.
   *
   * The two callers want different things and both are right. The SCHEDULER
   * wants on-change only (F-67): twenty ticks inside one window must produce
   * one row, or the audit log becomes a heartbeat. An operator ROUTE wants an
   * acknowledgement of the action it just took, even when the action changed
   * no posture — pausing an already-disconnected daemon is a real thing a
   * person did, and their screen should say so.
   *
   * What it does NOT do is write a lying audit row. The derived
   * `arming.changed` append happens only on a real change either way; this
   * flag governs the frame alone.
   */
  alwaysBroadcast?: boolean;
}

/**
 * Derive the posture, and announce it if it moved.
 *
 * Returns the current state so a route can put it in its response without a
 * second derivation.
 *
 * The witness is written BEFORE the append, and both before the frame. That
 * ordering is deliberate and it is not the §1.8 rule being bent: §1.8 governs
 * the append/broadcast pair, which holds here. The witness sits outside it
 * because a crash between "wrote the witness" and "wrote the row" costs one
 * missing audit row, while the other order costs an INFINITE loop of
 * re-announcements on every restart in the same posture — and of the two
 * failures only the second is unbounded.
 */
export function sweepArming(
  deps: ArmingSweepDeps,
  opts: SweepArmingOptions = {},
): ArmingState {
  const { store, sink } = deps;
  const to = resolveArming(deps);
  const from = lastBroadcast(store);
  const changed = !sameState(from, to);

  if (changed) {
    store.setSetting(SETTING_ARMING_LAST_BROADCAST, JSON.stringify(to));
    // The DERIVED row, and therefore a system actor. 'rule-engine' is the
    // pre-existing §3.2 reason for "the daemon's own evaluation decided
    // this", which is exactly what happened: no new SystemReason is minted
    // for a posture that is a function of rows other actors already wrote.
    sink.append(
      { type: 'arming.changed', from, to },
      systemActor('rule-engine'),
    );
  }
  if (changed || opts.alwaysBroadcast === true) {
    sink.broadcast({
      event: 'arming.changed',
      armed: to.armed,
      until: to.until,
      reason: to.reason,
    });
  }
  return to;
}

/**
 * Write or clear the pause deadline, audit the operator's action, and
 * announce whatever posture resulted.
 *
 * `until: null` is resume. Deleting the row IS the whole of resuming, which
 * is why there is no second verb and no sentinel value: absent means not
 * paused everywhere that reads it, so a resumed daemon and one that was never
 * paused are the same rows and the same posture.
 *
 * Ordering is §1.8 twice over: the operator's row lands, then the derived
 * row, then the single frame that reports the outcome of both.
 */
export function setPause(
  deps: ArmingSweepDeps,
  until: IsoUtc | null,
): ArmingState {
  const { store, sink } = deps;
  if (until === null) {
    store.deleteSetting(SETTING_PAUSE_UNTIL);
    sink.append({ type: 'arming.resumed' }, humanApiActor());
  } else {
    store.setSetting(SETTING_PAUSE_UNTIL, until);
    sink.append({ type: 'arming.paused', until }, humanApiActor());
  }
  return sweepArming(deps, { alwaysBroadcast: true });
}

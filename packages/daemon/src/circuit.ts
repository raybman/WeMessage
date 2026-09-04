/**
 * The send-path circuit breaker (s6-execution Part 2 Scenario 7, §1.7; F-65).
 *
 * It watches for a BROKEN SEND PATH — a backend that has started refusing, a
 * Messages install that stopped verifying, a machine that went sideways at
 * 3am — and withdraws autonomy for fifteen minutes when five sends fail
 * inside ten. It is emphatically not a policy mechanism, which is the whole
 * of F-65: `countSendFailuresSince` excludes `gate-denied` failures in SQL,
 * because a kill switch working correctly is not a broken send path and a
 * breaker that counted denials would turn one deliberate operator action into
 * a fifteen-minute outage. Turning safety on would turn more safety on.
 *
 * **The state is an instant, and that is the design.** `send.circuitOpenedAt`
 * is one `settings` row (F-61: no column, no table, no migration) holding the
 * moment the threshold was crossed. "Open" is the arithmetic
 * `now < openedAt + openMinutes`, recomputed by `circuitOpenUntil` at every
 * evaluation. Nothing is scheduled, so:
 *
 *  - a restart mid-window reopens to the ORIGINAL horizon rather than a fresh
 *    fifteen minutes, and a daemon that was asleep for an hour reopens to a
 *    breaker that has long since closed;
 *  - the gate can never be stale, because it derives the posture itself
 *    (`readGateCounters`) instead of reading a flag somebody has to remember
 *    to clear;
 *  - arch guard (d) holds trivially: there is no `setTimeout` in this file to
 *    put near a horizon field.
 *
 * What this module adds on top of that arithmetic is the OBSERVABLE part,
 * which needs a sink and therefore cannot live in core (INV-1): the audit row
 * and the courtesy frame for each flip, and the in-grace drafts an opening
 * breaker takes down with it. Both are why `sweepCircuit` is called at the
 * top of every scheduler tick rather than being folded into the gate.
 *
 * **What it stops, and what it does not.** An open breaker is a CLAMP at the
 * gate (§1.7 step 7), not a deny: a message still deserves a draft a human
 * can look at. The one thing STOPPED here is the set of drafts still inside
 * their undo grace at the moment the breaker trips, cancelled through the
 * same `cancelGraceApproved` + `draft.rejected` path the kill switch has used
 * since S4 Scenario 9. Turning the clamp into a send-moment refusal is Sc
 * 10's job (F-59, the context-bearing re-gate); nothing here pretends
 * otherwise, and a draft whose grace had already elapsed is deliberately left
 * to that mechanism.
 *
 * §1.8 throughout: every append precedes its broadcast, and for a caught
 * draft BOTH of its rows are durable before its frame goes out. A dropped
 * socket loses the notice, never the record of what was stopped.
 */
import {
  circuitFailureWindowStart,
  circuitOpenUntil,
  CIRCUIT_TOGGLE_KEY,
  readCircuitConfig,
  SETTING_CIRCUIT_OPENED_AT,
  systemActor,
  type Actor,
  type Clock,
  type IsoUtc,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from './audit-sink.js';

export interface CircuitDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/**
 * Clear the breaker, whoever asked. Returns whether a row was actually
 * removed, which is what the resume path reports as `circuitCleared`.
 *
 * Silent when nothing was set: clearing a hold that is not held is a no-op
 * that produces no audit noise, so `wemessage resume --circuit` can clear
 * blindly without teaching an operator to fear their own reset command.
 *
 * Back to "never set" rather than to a sentinel value, because the absence of
 * the key is already the closed state everywhere else that reads it — a
 * cleared breaker and a breaker that never tripped are the same posture and
 * should be the same row count.
 */
export function closeCircuit(deps: CircuitDeps, actor: Actor): boolean {
  const { store, sink } = deps;
  if (store.getSetting(SETTING_CIRCUIT_OPENED_AT) === null) return false;
  store.deleteSetting(SETTING_CIRCUIT_OPENED_AT);
  sink.append(
    { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: false },
    actor,
  );
  sink.broadcast({
    event: 'toggle.changed',
    key: CIRCUIT_TOGGLE_KEY,
    value: false,
    actor,
  });
  return true;
}

/**
 * Trip it: write the instant, announce the flip, and take down whatever was
 * still inside its undo grace.
 *
 * The cancelled drafts get TWO audit rows each and one frame. `gate.denied`
 * names the cause once per draft, so "why did this stop" is answerable from
 * the draft's own row rather than by correlating timestamps against a single
 * toggle event; `draft.rejected` is the state change, carrying the
 * pre-existing 'circuit-breaker' system actor (§3.2 has held that reason
 * unminted since S1 — no new actor, no new event type, no new transition).
 */
function openCircuit(deps: CircuitDeps, now: IsoUtc): void {
  const { store, sink } = deps;
  const actor = systemActor('circuit-breaker');
  store.setSetting(SETTING_CIRCUIT_OPENED_AT, now);
  sink.append(
    { type: 'toggle.changed', key: CIRCUIT_TOGGLE_KEY, on: true },
    actor,
  );
  sink.broadcast({
    event: 'toggle.changed',
    key: CIRCUIT_TOGGLE_KEY,
    value: true,
    actor,
  });

  const cancelled = store.cancelGraceApproved(now, {
    code: 'circuit-open',
    message: 'gate denied: circuit-open',
    at: now,
  });
  for (const draft of cancelled) {
    sink.append(
      { type: 'gate.denied', draftId: draft.id, reason: 'circuit-open' },
      actor,
    );
    sink.append({ type: 'draft.rejected', draftId: draft.id }, actor);
    sink.broadcast({
      event: 'draft.rejected',
      draftId: draft.id,
      actor,
    });
  }
}

/**
 * One evaluation of the breaker against `clock.now()`. Idempotent, cheap, and
 * called at the top of every scheduler tick.
 *
 * Close first, then re-evaluate in the SAME sweep. Doing it the other way
 * round would leave a one-tick window in which the breaker had just closed
 * while the failure count was already back over the threshold, and an
 * operator watching a genuinely broken send path would see the hold blink off
 * and on again for no reason they could name. Closing then immediately
 * reopening is honest; announcing a close that was never true is not.
 *
 * The count is deliberately taken AFTER any dispatching this tick will do is
 * still pending: `sweepCircuit` runs before `sweepGrace`, so a failure
 * produced by this tick's sends is counted by the next one. That keeps "the
 * breaker opened" a statement about failures that had already happened when
 * it opened, which is the only reading under which the instant it records is
 * meaningful.
 */
export function sweepCircuit(deps: CircuitDeps): void {
  const { store, clock } = deps;
  const now = clock.now();

  if (
    store.getSetting(SETTING_CIRCUIT_OPENED_AT) !== null &&
    circuitOpenUntil(store, now) === null
  ) {
    closeCircuit(deps, systemActor('circuit-breaker'));
  }
  if (circuitOpenUntil(store, now) !== null) return;

  const failures = store.countSendFailuresSince(
    circuitFailureWindowStart(store, now),
  );
  if (failures < readCircuitConfig(store).failureThreshold) return;
  openCircuit(deps, now);
}

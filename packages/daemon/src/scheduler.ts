/**
 * The grace scheduler (s4-execution Scenario 6, §1.3.3 + §1.7).
 *
 * One `tick(now)` does exactly three things, in this order:
 *   1. Circuit sweep (s6 Sc 7) — the breaker is closed if its horizon has
 *      passed and opened if the failure threshold has been crossed.
 *   2. TTL sweep — every 'pending' draft past `expiresAt` becomes 'expired'.
 *   3. Grace sweep — every 'approved' draft whose persisted `sendNotBefore`
 *      has arrived is dispatched, SEQUENTIALLY, oldest first.
 *
 * The circuit sweep goes FIRST so that the failures it counts are the ones
 * that had already happened when it decided, and so that an opening breaker
 * takes down the in-grace drafts before anything else in the tick looks at
 * them. It is here rather than in the gate because a flip has to be audited
 * and broadcast, and core is not allowed to hold a sink (INV-1); the gate
 * still derives the posture itself, so the two can never disagree.
 *
 * Three properties this file exists to guarantee:
 *
 * - **The deadline lives in the database, never in memory.** No timer is
 *   armed at approve time and no in-process map holds pending sends. A tick
 *   asks the store "what is due as of `now`," which is the only formulation
 *   that survives a daemon restart mid-grace. `undo-grace.spec.ts` pins this
 *   by killing the daemon inside the window and restarting past it.
 *
 * - **Expiry is not a denial.** C-6: a draft that ran out its TTL emits
 *   `draft.expired` with the system 'expiry' actor and NOTHING else. Never
 *   `gate.denied` — the gate was never consulted, nobody refused anything,
 *   the clock simply ran out. Conflating the two would poison every "why
 *   are we being blocked" investigation with rows that mean "nobody looked."
 *
 * - **Sends are serialized.** Dispatch is awaited one at a time. The core
 *   dispatcher holds a process-wide send mutex anyway, so parallel calls
 *   would merely queue, but queueing behind a mutex loses the ordering the
 *   store's `ORDER BY send_not_before` established. Approve order is the
 *   order a human expects to see messages arrive in.
 *
 * The tick is idempotent by construction: both sweeps transition rows OUT of
 * the states they select on, so a redundant tick finds nothing. It is also
 * re-entrant-unsafe by design — `runTick` guards against overlap rather than
 * interleaving two sweeps, because interleaving is how a draft gets sent
 * twice.
 */
import {
  systemActor,
  type Clock,
  type Store,
  type Ulid,
} from '@wemessage/core';
import type { AuditSink } from './audit-sink.js';
import { sweepCircuit } from './circuit.js';

export interface SchedulerDeps {
  store: Store;
  clock: Clock;
  /**
   * `draft.expired` is deliberately audit-only (§1.8) and the dispatch path
   * owns its own broadcasts, so the TTL and grace sweeps never reach for
   * `broadcast`. The circuit sweep does: a breaker flipping is a posture
   * change an operator's UI has to see, exactly as a kill-switch flip is.
   */
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  /**
   * Injected rather than constructed here so the scheduler never needs the
   * backend, reader or delay: it decides WHEN, `dispatchApproved` decides
   * HOW. Errors are the caller's to swallow — see `tick`.
   */
  dispatch: (draftId: Ulid, approvalId: Ulid) => Promise<unknown>;
  /** Reported rather than thrown: one bad draft must not stop the sweep. */
  onError?: (draftId: Ulid, err: unknown) => void;
  /**
   * s5 Scenario 8: a draft that ran out its TTL is news the originating
   * agent needs — it proposed something and a human never looked. Called
   * AFTER the append (§1.8) and deliberately typed as a bare draft-id
   * callback: the scheduler decides WHEN a draft expires and nothing else,
   * and it has no business knowing whether an adapter exists.
   */
  onExpired?: (draftId: Ulid) => void;
}

export interface Scheduler {
  /** Run both sweeps once against `clock.now()`. Never throws. */
  tick(): Promise<void>;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, clock, sink, dispatch, onError, onExpired } = deps;
  let running = false;

  const sweepExpired = (now: string): void => {
    const expiry = systemActor('expiry');
    for (const draft of store.listExpiredPending(now)) {
      try {
        store.applyDraftTransition({
          id: draft.id,
          from: 'pending',
          to: 'expired',
          at: now,
        });
      } catch (err) {
        // Lost a race with a human approving in the same instant. Their
        // approval wins; the draft is no longer pending and no longer ours.
        onError?.(draft.id, err);
        continue;
      }
      sink.append({ type: 'draft.expired', draftId: draft.id }, expiry);
      onExpired?.(draft.id);
    }
  };

  const sweepGrace = async (now: string): Promise<void> => {
    for (const due of store.listGraceElapsed(now)) {
      try {
        await dispatch(due.draftId, due.approvalId);
      } catch (err) {
        // dispatchApproved throws only on an INV-2 validation failure, which
        // it has already audited. Swallow it here so the remaining due
        // drafts still go out.
        onError?.(due.draftId, err);
      }
    }
  };

  return {
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        sweepCircuit({ store, clock, sink });
        const now = clock.now();
        sweepExpired(now);
        await sweepGrace(now);
      } finally {
        running = false;
      }
    },
  };
}

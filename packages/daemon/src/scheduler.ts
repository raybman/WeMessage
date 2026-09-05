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
  type DraftError,
  type MessageGuid,
  type Store,
  type Ulid,
} from '@wemessage/core';
import type { AuditSink } from './audit-sink.js';
import { sweepCircuit } from './circuit.js';
import { sweepArming } from './arming.js';

export interface SchedulerDeps {
  store: Store;
  clock: Clock;
  /**
   * Used by all four sweeps, and in every case `append` strictly precedes
   * `broadcast` (§1.8): the log is the record, the frame is a courtesy, and
   * a crash between the two must lose the courtesy rather than the record.
   *
   * s8 Sc3 (F-107) ended this file's abstention. S4's F-39 deferred
   * `draft.expired` to audit-only because nothing could read a frame; a GUI
   * that watches a queue rather than polling it is that reader, so the TTL
   * sweep now broadcasts, and the grace sweep broadcasts `draft.requeued`
   * when core reports that outcome. The circuit and arming sweeps already
   * did: a breaker flipping is a posture change an operator's UI has to see,
   * exactly as a kill-switch flip is.
   *
   * s8 Sc6 finished the job the sentence above started. The grace sweep now
   * broadcasts ALL THREE dispatch outcomes, not just the requeue: an
   * approved draft leaving is `draft.sent` and a refused one is
   * `draft.failed`, and until this scenario neither had an emit site on the
   * path that actually sends approved drafts. `POST /v1/send` had them,
   * which is why the gap survived a ratchet that only counts names.
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
      // §1.8, in this order and for this reason: the row is durable, THEN
      // the frame goes out, THEN the originating agent is told. A subscriber
      // that reacted to the frame by reading the audit log must find the row
      // already there, and `onExpired` reaches a socket we do not control.
      sink.append({ type: 'draft.expired', draftId: draft.id }, expiry);
      sink.broadcast({ event: 'draft.expired', draftId: draft.id });
      onExpired?.(draft.id);
    }
  };

  const sweepGrace = async (now: string): Promise<void> => {
    for (const due of store.listGraceElapsed(now)) {
      try {
        const result = await dispatch(due.draftId, due.approvalId);
        // s8 Sc3 (F-72, F-107): `draft.requeued` is CORE-ORIGINATED. Core
        // withdraws the approval, puts the draft back in the queue and
        // writes both the `draft.requeued` and the `gate.denied` rows, then
        // returns `{outcome:'requeued'}` — it cannot broadcast, because a
        // sink is a daemon thing and core holds no adapter- or
        // protocol-shaped dependency (INV-1). So the daemon translates the
        // outcome into the frame HERE, narrowing the injected closure's
        // `Promise<unknown>` exactly as `adapters/feedback.ts`'s
        // `observeDispatch` narrows it for `send_verified`/`send_failed`.
        // That is the tree's existing channel for a core outcome becoming a
        // daemon-side effect, and this rides it rather than opening another.
        //
        // §1.8 holds for free: both rows were durable before `dispatch`
        // resolved, so there is no window in which this frame precedes them.
        // This is also the ONLY requeue site — `routes/send.ts` treats a
        // `requeued` outcome as an invariant violation, because a human who
        // pressed send is not subject to a schedule.
        //
        // s8 Sc6: the same translation, for the OTHER two outcomes.
        //
        // S3 wired `draft.sent` and `draft.failed` on `POST /v1/send` and
        // nowhere else, which was complete while the send-test route was the
        // only way a draft could leave: `draft.requeued` was added above in
        // Sc3 because the sweep is the only place it can happen, and the
        // other two looked like they were already covered. They were not.
        // The grace sweep is how an APPROVED draft is actually sent, and a
        // GUI that watches the queue instead of polling it was left watching
        // a card that says `approved` for ever — the draft went out, or the
        // dispatcher refused it in its own words, and the operator's screen
        // was told neither. Both events are already in the vocabulary and in
        // `EMITTED_WS_EVENTS`, so this is a second emit site for a name the
        // ratchet already carries rather than a surface change.
        //
        // §1.8 holds here for the same reason it does above: core made the
        // ledger and audit rows durable before `dispatch` resolved, so the
        // frame cannot precede the record.
        const outcome = (result as { outcome?: unknown } | null)?.outcome;
        if (outcome === 'requeued') {
          sink.broadcast({ event: 'draft.requeued', draftId: due.draftId });
        } else if (outcome === 'sent') {
          sink.broadcast({
            event: 'draft.sent',
            draftId: due.draftId,
            sentMessageGuid: (result as { sentMessageGuid: MessageGuid })
              .sentMessageGuid,
          });
        } else if (outcome === 'failed') {
          sink.broadcast({
            event: 'draft.failed',
            draftId: due.draftId,
            error: (result as { error: DraftError }).error,
          });
        }
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
        // s6 Scenario 11 (F-67). AFTER the breaker sweep, because the breaker
        // is one of the five dimensions the posture is derived from and a
        // sweep that ran first would announce a state that was already stale
        // by the end of the same tick. On-change only: twenty ticks inside
        // one window write one audit row, not twenty.
        sweepArming({ store, clock, sink });
        const now = clock.now();
        sweepExpired(now);
        await sweepGrace(now);
      } finally {
        running = false;
      }
    },
  };
}

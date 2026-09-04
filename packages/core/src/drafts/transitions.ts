/**
 * The pure draft-lifecycle transition table (s4-execution §1.7, Part 2
 * Scenario 2). The single source of legality: everything else in S4 (the
 * store's `applyDraftTransition` port method, the daemon's draft routes, the
 * undo-grace scheduler) calls THIS function first and persists only what it
 * returns. Zero I/O, zero clock reads (`now` is never consulted here — grace
 * elapsed / TTL elapsed are decided by the CALLER comparing timestamps
 * before invoking the event; this function only knows "the event happened").
 *
 * Two independent failure modes, two error classes (roadmap risk #1: one
 * pure function, store re-asserts `from` in-transaction so persistence
 * cannot drift from this table):
 *
 *  - `IllegalDraftTransition {from, event}` — the (from, event) pair is
 *    absent from the table entirely. Silence is impossible: the cross
 *    product of every DraftState x DraftEvent pair not listed below throws
 *    this, by construction (see draft-transitions.spec.ts).
 *  - `IllegalDraftActor {from, event, actor}` — the pair IS legal, but the
 *    actor driving it violates that row's actor constraint (§1.7's "actor
 *    constraint" column), e.g. an agent actor attempting `approve` (S4: only
 *    humans approve; system `auto-respond` auto-approval is S6).
 *
 * `retry`'s ceiling (`failed -> approved`, at most 2 retries / ledger
 * attempt <= 3) is table-adjacent but count-dependent, so it is checked
 * alongside the pair lookup rather than encoded in the table shape: an
 * exhausted ceiling is exactly as illegal as an absent pair
 * (IllegalDraftTransition), because from the caller's perspective a failed
 * draft past its ceiling has no legal event left to fire.
 */
import type { Actor, DraftState } from '../domain/types.js';

/** Mirrors events.ts's local alias — the system Actor variant's reason literal. */
type SystemReason = Extract<Actor, { kind: 'system' }>['reason'];

export type DraftEvent =
  | 'approve'
  | 'reject'
  | 'ttl-elapsed'
  | 'superseded'
  | 'edit'
  | 'grace-elapsed'
  | 'recall'
  | 'verified'
  | 'send-failed'
  | 'retry'
  // F-72 (s6 Scenario 10): the send moment's one non-terminal refusal. A
  // clamp is not a failure, so a shut window does not park an approved draft
  // as 'failed'; it puts it back where a human can act on it.
  | 'window-closed';

export class IllegalDraftTransition extends Error {
  readonly from: DraftState;
  readonly event: DraftEvent;

  constructor(from: DraftState, event: DraftEvent) {
    super(`illegal draft transition: ${from} + ${event}`);
    this.name = 'IllegalDraftTransition';
    this.from = from;
    this.event = event;
  }
}

export class IllegalDraftActor extends Error {
  readonly from: DraftState;
  readonly event: DraftEvent;
  readonly actor: Actor;

  constructor(from: DraftState, event: DraftEvent, actor: Actor) {
    super(
      `actor '${actor.kind}' may not drive the transition ${from} + ${event}`,
    );
    this.name = 'IllegalDraftActor';
    this.from = from;
    this.event = event;
    this.actor = actor;
  }
}

export interface ApplyDraftTransitionInput {
  from: DraftState;
  event: DraftEvent;
  actor: Actor;
  /**
   * Required only for the 'retry' event: retries already used on this draft
   * (the store supplies `ledger attempt - 1`). Omitted for every other
   * event.
   */
  retriesUsed?: number;
}

/** §1.7: at most 2 retries (1 initial try + 2 retries = ledger attempt <= 3). */
export const MAX_DRAFT_RETRIES = 2;

/** §1.7 "system, reason recorded" rows: the three reasons that may reject a draft. */
const SYSTEM_REJECT_REASONS = new Set<SystemReason>([
  'kill-switch',
  'disconnect',
  'circuit-breaker',
]);

// The pure table: from -> event -> to. Absent = illegal (IllegalDraftTransition).
const TABLE: {
  [F in DraftState]?: { [E in DraftEvent]?: DraftState };
} = {
  pending: {
    approve: 'approved',
    reject: 'rejected',
    'ttl-elapsed': 'expired',
    superseded: 'superseded',
    edit: 'pending',
  },
  approved: {
    'grace-elapsed': 'sending',
    recall: 'recalled',
    reject: 'rejected',
    // s6 Sc 10 (F-72). The only row in this table that moves BACKWARDS, and
    // the only one that needs to: every other exit from 'approved' is either
    // a send or a terminal state, and neither is honest about a window that
    // shut nine seconds before the grace elapsed. The draft is unchanged and
    // still wanted; what expired was the authority to send it without asking.
    'window-closed': 'pending',
  },
  sending: {
    verified: 'sent',
    'send-failed': 'failed',
  },
  failed: {
    retry: 'approved',
  },
  // sent | rejected | expired | superseded | recalled: terminal, no rows.
  // 'sending' crash recovery is not an event here — T-9.3 startup recovery
  // (recovery.ts) reconciles it directly against the send ledger.
};

/**
 * Validate the actor against the one row's constraint. Rows with no actor
 * constraint (`approved + grace-elapsed`, `sending + verified`,
 * `sending + send-failed` — §1.7 marks these "—" or mechanism-only) accept
 * any actor: they are driven by the scheduler/dispatcher, not a human or
 * agent decision.
 */
function assertActor(from: DraftState, event: DraftEvent, actor: Actor): void {
  const illegal = (): never => {
    throw new IllegalDraftActor(from, event, actor);
  };

  if (from === 'pending' && (event === 'approve' || event === 'edit')) {
    // F-58 (s6 Sc 9): C-1 is widened by EXACTLY ONE disjunct — the system
    // actor a machine wears when it approves on the operator's behalf. Not a
    // broadened `kind !== 'agent'`, not a new actor kind, not a bypass
    // parameter on `applyDraftTransition`: every other system reason and
    // every agent stays illegal here, pinned reason by reason in
    // `draft-transitions.spec.ts` so the disjunct cannot quietly become two.
    //
    // Scoped to `approve`, deliberately NARROWER than the flag's literal
    // text. The two events share this branch only because they shared a
    // constraint; they are not the same permission. Editing a pending draft
    // is authorship — a machine that could take the `edit` edge could put
    // words in the operator's mouth without ever approving anything, and
    // nothing in Sc 9 needs it. `pending + edit` therefore stays human-only,
    // and there is a row asserting it stayed that way.
    const isAutoApprove =
      event === 'approve' &&
      actor.kind === 'system' &&
      actor.reason === 'auto-respond';
    if (actor.kind !== 'human' && !isAutoApprove) illegal();
    return;
  }
  if (event === 'reject' && (from === 'pending' || from === 'approved')) {
    const isSystemRejecter =
      actor.kind === 'system' && SYSTEM_REJECT_REASONS.has(actor.reason);
    if (from === 'approved') {
      // §1.7: "approved + kill/disconnect/circuit -> rejected, system,
      // reason recorded" is the ONLY reject row for 'approved' — a human
      // does not reject their own approved draft (they recall it instead).
      if (!isSystemRejecter) illegal();
      return;
    }
    // from === 'pending': human, or system with one of the three reasons.
    if (actor.kind === 'human' || isSystemRejecter) return;
    illegal();
    return;
  }
  if (from === 'pending' && event === 'ttl-elapsed') {
    if (!(actor.kind === 'system' && actor.reason === 'expiry')) illegal();
    return;
  }
  if (from === 'pending' && event === 'superseded') {
    if (!(actor.kind === 'system' && actor.reason === 'supersede')) illegal();
    return;
  }
  if (from === 'approved' && event === 'window-closed') {
    // Exactly one legal actor, by name. A human recalls, a human rejects,
    // and the three system rejecters are enumerated above; requeueing is
    // none of those, so it gets its own reason rather than borrowing one.
    if (!(actor.kind === 'system' && actor.reason === 'window-closed'))
      illegal();
    return;
  }
  if (from === 'approved' && event === 'recall') {
    if (actor.kind !== 'human') illegal();
    return;
  }
  if (from === 'failed' && event === 'retry') {
    if (actor.kind !== 'human') illegal();
    return;
  }
  // approved+grace-elapsed, sending+verified, sending+send-failed: no
  // actor constraint (mechanism-only transitions).
}

/**
 * Apply one lifecycle event to a draft's current state. Pure: returns the
 * resulting `DraftState` or throws. Callers (store, routes, scheduler)
 * persist the returned state and append the matching audit row themselves —
 * this function performs no I/O.
 */
export function applyDraftTransition(
  input: ApplyDraftTransitionInput,
): DraftState {
  const { from, event, actor, retriesUsed } = input;
  const to = TABLE[from]?.[event];
  if (to === undefined) {
    throw new IllegalDraftTransition(from, event);
  }
  if (event === 'retry') {
    if (retriesUsed === undefined || retriesUsed >= MAX_DRAFT_RETRIES) {
      throw new IllegalDraftTransition(from, event);
    }
  }
  assertActor(from, event, actor);
  return to;
}

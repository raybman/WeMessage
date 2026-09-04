/**
 * @wemessage/core/sending/auto-approve — the ONE place a machine may decide
 * to speak on the operator's behalf (s6-execution §1.7 "Auto-approval",
 * Scenario 9; F-58, F-70, F-74, F-78).
 *
 * **What autonomy actually is here.** Nothing in this file sends anything.
 * Every mechanism a send needs has existed since S4: an `Approval` row, a
 * persisted `sendNotBefore`, the scheduler's grace sweep, `dispatchApproved`,
 * the send ledger, the mutex-held re-gate. The one thing missing was somebody
 * willing to write the approval when no human was there to. That is all
 * `maybeAutoApprove` is, and being ONLY that is what keeps INV-2 intact: the
 * single path to a send is still `dispatchApproved` holding a validated
 * approval row, and this function feeds that path exactly the row the human
 * approve route feeds it.
 *
 * So it never dispatches, never names the send port, never holds a port of
 * any kind, and the port importer allowlist does not grow in S6 at all
 * (`test/arch.spec.ts` S6 row (c), 15 files in, 15 files out). That sentence
 * is load-bearing, and this file once proved it the hard way: naming the port
 * in a COMMENT here failed the guard, because the importer scan is a
 * substring scan over file content and does not care whether the mention is
 * an import, a type or prose. Recorded so the next reader knows the guard is
 * stricter than it looks.
 *
 * **Why one file.** S6 rows (a) and (b) pin this path by name: nothing else
 * in production may mint the `auto-respond` reason, and nothing else may
 * write an approval beside a system actor. The guard's value was never that
 * the literal appears nowhere — it is that "where can this system decide to
 * speak for me" has a single-file answer, forever. A second autonomy added
 * anywhere else fails the build rather than shipping.
 *
 * **Fail-closed, everywhere.** Every early return below is a 'withheld', and
 * the conditions are stated positively: the draft must exist, must still be
 * pending, must carry a rule, the gate must ALLOW, the resolved mode must be
 * `auto`, and nothing may have clamped it. A field this function forgets to
 * read, a store row it cannot load, a service it does not recognise — each
 * one lands on 'withheld'. The failure mode of a bug here is a draft sitting
 * in a human's queue, never a message nobody chose to send.
 *
 * **A clamp is still not a denial (§1.7).** A withheld decision writes no
 * `gate.denied` row, because nobody was refused: no approval was minted, so
 * no send was ever attempted. Turning the send-moment clamps into denials
 * carrying the approval's own provenance is Sc 10's work (F-59).
 */
import type {
  Actor,
  ContactPolicy,
  Rule,
  Schedule,
  Ulid,
} from '../domain/types.js';
import type { AuditEvent } from '../audit/events.js';
import type { Clock, Store } from '../ports/index.js';
import { applyDraftTransition } from '../drafts/transitions.js';
import {
  bumpSendCounters,
  evaluateGate,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  SETTING_UNDO_GRACE_SECONDS,
} from '../gate/index.js';
import { windowCloseAfter } from '../schedule/index.js';
import { parseChatGuid } from './dispatcher.js';

/**
 * F-78: autonomy's own undo window, defaulting to the operator's
 * (`send.undoGraceSeconds`) so an install that never touches it gets one
 * consistent "time to catch it" number rather than two.
 */
export const SETTING_AUTO_GRACE_SECONDS = 'send.autoGraceSeconds';

/**
 * The floor, in seconds. F-78 refused a grace of zero outright: an
 * autonomous send a human has no interval to catch is not a send with a
 * short grace, it is a fait accompli, and the kill switch would have nothing
 * to dominate. Five seconds is short enough to feel immediate and long
 * enough that flipping the switch, or the daemon noticing a disconnect, can
 * still land first. There is no setting value that reaches zero.
 */
export const AUTO_GRACE_FLOOR_SECONDS = 5;

/** §1.3.3's shipped undo window, the default this one inherits. */
const DEFAULT_AUTO_GRACE_SECONDS = 10;

/**
 * How long an auto-approved draft waits before the scheduler may send it.
 *
 * Unset falls back to `send.undoGraceSeconds`, then to 10. Anything at or
 * below the floor, negative, or not a number at all IS the floor — a
 * malformed setting must not be able to shorten the interval, which is the
 * one direction that costs the operator something.
 */
export function readAutoGraceSeconds(store: Pick<Store, 'getSetting'>): number {
  const raw =
    store.getSetting(SETTING_AUTO_GRACE_SECONDS) ??
    store.getSetting(SETTING_UNDO_GRACE_SECONDS);
  const parsed = raw === null ? DEFAULT_AUTO_GRACE_SECONDS : Number(raw);
  if (!Number.isFinite(parsed)) return AUTO_GRACE_FLOOR_SECONDS;
  return Math.max(AUTO_GRACE_FLOOR_SECONDS, parsed);
}

/**
 * The two audit-sink calls this function makes, and nothing else.
 *
 * Declared structurally rather than imported because the sink lives in the
 * daemon and the broadcast frame's type lives in the protocol package, and
 * core depends on neither (INV-1). The daemon's real sink satisfies this
 * shape, so composition costs nothing; what it buys is that core still has
 * never heard of a WS client or an adapter.
 */
export interface AutoApproveSink {
  append(event: AuditEvent, actor: Actor): unknown;
  broadcast(payload: {
    event: 'draft.approved';
    draftId: Ulid;
    actor: Actor;
  }): void;
}

export interface AutoApproveDeps {
  store: Store;
  clock: Clock;
  sink: AutoApproveSink;
  /**
   * A fresh sortable id for the approval row.
   *
   * Injected because core has zero package dependencies (INV-1, pinned by
   * `test/arch.spec.ts` row (e)) and therefore cannot generate a ULID
   * itself — the same reason `DispatchApprovedDeps` takes `delay` and
   * `emit`. It must be MONOTONIC and lexicographically sortable: the store
   * breaks approval ties on `(at DESC, id DESC)`, so a UUID here would make
   * two approvals written in the same millisecond order arbitrarily.
   */
  newId(): Ulid;
}

/** The system actor autonomy wears. The one mint site (F-74, S6 row (a)). */
function autoActor(): Actor {
  return { kind: 'system', reason: 'auto-respond' };
}

/**
 * Decide whether a freshly minted, rule-borne draft may approve itself, and
 * if so, approve it.
 *
 * Called from exactly ONE place — `adapters/submit.ts`, immediately after a
 * draft is minted and broadcast — and returns 'withheld' for everything else.
 *
 * The §1.7 contract is a promise, and it is kept as one: the call site awaits
 * it and Sc 10's send-moment re-gate may yet need the room. The body is
 * synchronous today, though, and the split below is how both stay true
 * without an `async` keyword the linter would rightly object to (nothing in
 * this repo carries an eslint suppression and this is not the place to open
 * that account). `decide` runs to completion before the promise is even
 * constructed, which is a property worth having on purpose: the mint hands
 * back a draft that has ALREADY been decided, so nothing that polls the
 * store can catch one in a half-decided state and no test has to wait for a
 * verdict that was reached before it looked.
 */
export function maybeAutoApprove(
  deps: AutoApproveDeps,
  draftId: Ulid,
): Promise<'approved' | 'withheld'> {
  return Promise.resolve(decide(deps, draftId));
}

function decide(deps: AutoApproveDeps, draftId: Ulid): 'approved' | 'withheld' {
  const { store, clock, sink } = deps;
  const now = clock.now();

  const draft = store.getDraft(draftId);
  if (draft === null) return 'withheld';
  // Only a draft nobody has acted on yet. This is also what makes a second
  // call idempotent by refusal rather than by luck: re-running the decision
  // on an already-approved draft cannot mint a second approval for one send.
  if (draft.state !== 'pending') return 'withheld';
  // §1.7: autonomy ANSWERS, it does not initiate. A draft with no rule was
  // an adapter's own idea (§3.2 proactive), and that is the one place an
  // adapter picks the audience. F-50 already clamps such a decision to
  // draft-only at the gate; this is the second, independent lock, so a
  // regression in either one is not enough on its own.
  if (draft.ruleId === null) return 'withheld';
  const rule: Rule | null = store.getRule(draft.ruleId);
  if (rule === null) return 'withheld';

  // Rebuild the context this draft would be judged in. The handle and the
  // service come from the mirrored INBOUND where there is one: a group chat
  // guid carries no counterparty handle at all, and 'rcs' is a service no
  // chat-guid prefix can spell. `isGroup` comes from the chat guid, because
  // that is what the SEND path parses and disagreeing with it there is how a
  // group message gets attempted.
  const parsed = parseChatGuid(draft.chatGuid);
  const source =
    draft.inboundGuid === null || draft.inboundGuid === undefined
      ? null
      : store.getInboundMessage(draft.inboundGuid);
  const handle = source?.handle ?? parsed.handle;
  const schedule: Schedule | null =
    rule.scheduleId === null ? null : store.getSchedule(rule.scheduleId);
  const contact: ContactPolicy | null = store.getContactPolicy(handle);
  const settings = readGateSettings(store);

  const decision = evaluateGate({
    now,
    settings,
    rule,
    schedule,
    contact,
    message: {
      isGroup: parsed.isGroup,
      service: source?.service ?? parsed.service,
      handle,
      chatGuid: draft.chatGuid,
    },
    counters: readGateCounters(store, {
      now,
      handle,
      chatGuid: draft.chatGuid,
    }),
    // A body exists by now, so BOTH halves of the loop breaker are available
    // here — unlike the inbound draft moment, where only the streak can fire.
    candidate: readLoopCandidate(store, {
      chatGuid: draft.chatGuid,
      body: draft.body,
    }),
  });

  if (!decision.allow) return 'withheld';
  // The three conditions §1.7 states, kept separate rather than folded into
  // one boolean so a reader can see that a CLAMP withholds even though the
  // gate allowed. `clampedBy` is redundant today (every clamp also forces
  // 'draft-only') and is checked anyway: the day a clamp is added that does
  // not move the mode, this stays correct instead of silently granting.
  if (decision.mode !== 'auto') return 'withheld';
  if (decision.clampedBy !== undefined) return 'withheld';
  // Unreachable while `allow` is true and the draft carries a rule — §2.4.3
  // step 3 denies an unknown contact outright — but the audit row records
  // the RESOLVED contact scope, and a resolved scope has to come from a row.
  if (contact === null) return 'withheld';

  const actor = autoActor();
  const approvalId = deps.newId();

  // C-1, widened by exactly one disjunct (F-58). The auto actor's approve
  // edge is a ROW in the one transition table, validated by the same pure
  // function every other approval runs through — not a bypass around it.
  applyDraftTransition({ from: 'pending', event: 'approve', actor });

  // F-71: the budget is spent when the APPROVAL is written, through the same
  // helper the human approve route uses, so a machine's send and a person's
  // send land in the same rolling windows. `auto: true` is the only
  // difference: this one counts against the contact's pacing as well as the
  // global bound, because pacing is a claim about how often a MACHINE may
  // speak to one person.
  bumpSendCounters(store, { now, auto: true, handle });

  store.insertApproval({
    id: approvalId,
    draftId: draft.id,
    action: 'approve',
    actor,
    at: now,
  });
  // The store re-asserts `from` inside the transaction, so a racing
  // transition cannot leave two winners. `sendNotBefore` is PERSISTED rather
  // than armed as a timer: that is what lets a restart mid-grace still send,
  // and a kill flip mid-grace still stop it.
  store.applyDraftTransition({
    id: draft.id,
    from: 'pending',
    to: 'approved',
    at: now,
    sendNotBefore: new Date(
      Date.parse(now) + readAutoGraceSeconds(store) * 1000,
    ).toISOString(),
  });

  // §1.8: durable first, then observable. The two rows go down adjacent —
  // the reason a machine decided and the decision it made are one event
  // split in two, and anything interleaved between them would be a second
  // writer nobody reviewed.
  const armedUntil = schedule === null ? null : windowCloseAfter(schedule, now);
  sink.append(
    {
      type: 'auto.approved',
      draftId: draft.id,
      approvalId,
      ruleId: rule.id,
      adapterId: draft.adapterId,
      scopes: {
        global: settings.globalMode,
        contact: contact.mode,
        rule: rule.respondMode,
      },
      scheduleId: rule.scheduleId,
      ...(armedUntil === null ? {} : { armedUntil }),
    },
    actor,
  );
  sink.append(
    { type: 'draft.approved', draftId: draft.id, approvalId, actor },
    actor,
  );
  sink.broadcast({ event: 'draft.approved', draftId: draft.id, actor });

  return 'approved';
}

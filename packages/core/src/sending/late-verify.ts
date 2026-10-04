/**
 * s10 Slice 2: late verification. No blind re-send.
 *
 * `dispatchApproved` gives Messages 10s to write the outbound row before it
 * parks the draft 'failed' with code 'unverified'. Under load (and on macOS
 * 26 with attributedBody-only rows) the row can land after that budget. The
 * honest state of such a draft is "unknown", and a human who presses Retry
 * on it would send the same text twice.
 *
 * Two callers share `findLanded`:
 *  - `verifyLate` (this file): the retry route and the scheduler sweep ask
 *    about a FAILED draft. Found means failed -> sent.
 *  - the dispatcher's ledger guard: inside the send mutex, after resolveChat
 *    and before beginSendAttempt, for an APPROVED draft whose ledger is
 *    still open. Found means approved -> sent, and nothing is put on
 *    the wire. That guard is the real backstop: it is the last moment the
 *    first attempt's started_at is knowable, because beginSendAttempt
 *    overwrites it on every retry.
 *
 * This module READS chat.db and WRITES only through the CAS port. Its deps
 * carry no send port at all and must never gain one (arch row).
 *
 * Known edge, accepted: the match is exact text in the same chat since the
 * first attempt. If the human typed the identical text by hand in Messages
 * after a failure, that row is taken as the draft's. The alternative is a
 * duplicate message to a real person, which is the worse error.
 */
import type { Actor, ChatGuid, MessageGuid, Ulid } from '../domain/types.js';
import { applyDraftTransition } from '../drafts/transitions.js';
import type {
  ChatDbReader,
  Clock,
  SendLedgerView,
  Store,
} from '../ports/index.js';
import { parseChatGuid } from './chat-guid.js';

/** The one actor allowed on the 'late-verified' edge (transitions.ts assertActor). */
export const LATE_VERIFY_ACTOR: Actor = {
  kind: 'system',
  reason: 'late-verify',
};

export interface LateVerifyDeps {
  store: Store;
  reader: Pick<ChatDbReader, 'resolveChat' | 'findOutboundMessage'>;
  clock: Clock;
}

export type LateVerifyResult =
  | { outcome: 'sent'; sentMessageGuid: MessageGuid }
  | { outcome: 'not-found' }
  | {
      outcome: 'skipped';
      reason: 'not-failed' | 'not-unverified' | 'no-ledger' | 'group';
    };

/**
 * One lookup, from the FIRST attempt's start. Shared by verifyLate and the
 * dispatcher guard so the two can never disagree about what "landed" means.
 */
export async function findLanded(
  reader: Pick<ChatDbReader, 'findOutboundMessage'>,
  input: { chatGuid: ChatGuid; body: string; ledger: SendLedgerView },
): Promise<MessageGuid | null> {
  const found = await reader.findOutboundMessage({
    chatGuid: input.chatGuid,
    text: input.body,
    sinceIso: input.ledger.startedAt,
  });
  return found === null ? null : found.guid;
}

export async function verifyLate(
  deps: LateVerifyDeps,
  draftId: Ulid,
): Promise<LateVerifyResult> {
  const { store, reader, clock } = deps;
  const draft = store.getDraft(draftId);
  if (draft === null || draft.state !== 'failed') {
    return { outcome: 'skipped', reason: 'not-failed' };
  }
  // Only 'unverified' means "Messages accepted it". Every other failure
  // code (a refused send, no conversation, a gate denial) means it never left.
  if (draft.error?.code !== 'unverified') {
    return { outcome: 'skipped', reason: 'not-unverified' };
  }
  const ledger = store.getSendLedger(draftId);
  if (ledger === null) {
    return { outcome: 'skipped', reason: 'no-ledger' };
  }
  const parsed = parseChatGuid(draft.chatGuid);
  if (parsed.isGroup) {
    return { outcome: 'skipped', reason: 'group' };
  }
  // Same resolution the dispatcher used: an 'any;-;' draft guid is not the
  // chat.db guid, the resolved one is.
  const resolved = await reader.resolveChat(parsed.handle);
  if (resolved === null) return { outcome: 'not-found' };
  if (resolved.isGroup) return { outcome: 'skipped', reason: 'group' };

  const guid = await findLanded(reader, {
    chatGuid: resolved.chatGuid,
    body: draft.body,
    ledger,
  });
  if (guid === null) return { outcome: 'not-found' };

  applyDraftTransition({
    from: 'failed',
    event: 'late-verified',
    actor: LATE_VERIFY_ACTOR,
  });
  try {
    store.applyDraftTransition({
      id: draftId,
      from: 'failed',
      to: 'sent',
      at: clock.now(),
      sentMessageGuid: guid,
    });
  } catch (err) {
    // A lost CAS: the retry route or the sweep moved it first. That caller
    // owns the outcome now. Anything else (the draft is still 'failed') is a
    // real write failure and must surface.
    if (store.getDraft(draftId)?.state !== 'failed') {
      return { outcome: 'not-found' };
    }
    throw err;
  }
  store.appendAudit({
    at: clock.now(),
    eventJson: JSON.stringify({
      type: 'draft.sent',
      draftId,
      sentMessageGuid: guid,
    }),
    actorJson: JSON.stringify(LATE_VERIFY_ACTOR),
  });
  return { outcome: 'sent', sentMessageGuid: guid };
}

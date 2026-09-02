/**
 * Post-send verification (s3-execution §1.3, §2.2.2, Scenario 4).
 *
 * The AppleScript backend's `accepted:true` (Scenario 2) is never proof of
 * delivery — Messages can accept a send and still fail to actually post it.
 * `verifySend`'s signature can't even express "trust the exit code": it
 * takes no `SendOutcome`, only what's needed to poll chat.db for a real row.
 *
 * Backoff: 250ms, doubling each miss, capped to a 10s total budget. Each
 * wait is `min(nextInterval, remainingBudget)` so the schedule lands on the
 * budget exactly instead of overshooting it (a naive uncapped doubling sum
 * — 250+500+1000+2000+4000+8000 — blows past 10s on the 6th wait).
 */
import type {
  ChatDbReader,
  ChatGuid,
  Clock,
  IsoUtc,
  MessageGuid,
} from '@wemessage/core';

export interface VerifySendInput {
  chatGuid: ChatGuid;
  body: string;
  sendStartedAt: IsoUtc;
}

export interface VerifySendResult {
  verified: boolean;
  guid?: MessageGuid;
}

const VERIFY_BUDGET_MS = 10_000;
const INITIAL_INTERVAL_MS = 250;

export async function verifySend(
  reader: Pick<ChatDbReader, 'findOutboundMessage'>,
  clock: Clock,
  delay: (ms: number) => Promise<void>,
  input: VerifySendInput,
): Promise<VerifySendResult> {
  const startMs = clock.nowMs();
  let interval = INITIAL_INTERVAL_MS;

  for (;;) {
    const found = await reader.findOutboundMessage({
      chatGuid: input.chatGuid,
      text: input.body,
      sinceIso: input.sendStartedAt,
    });
    if (found !== null) return { verified: true, guid: found.guid };

    const elapsed = clock.nowMs() - startMs;
    const remaining = VERIFY_BUDGET_MS - elapsed;
    if (remaining <= 0) return { verified: false };

    await delay(Math.min(interval, remaining));
    interval *= 2;
  }
}

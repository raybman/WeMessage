/**
 * Rule evaluation — eligibility + priority ordering (S2 Scenario 3).
 * s2-execution §1.7 (binding, cited to plan §1.3.8 + §2.7).
 *
 * F-12 (coordinator-confirmed): the engine is policy-free — it returns the
 * FULL ordered match list (priority ASC, "lower fires first" §3.2; id ASC
 * tiebreak). Single-winner enforcement lives in the daemon pipeline
 * (Scenario 9), so flipping F-12 never requires engine rework.
 *
 * Pure per INV-1: no Clock, no I/O, no store access. The draft-existence
 * predicate for edit re-matching is injected — drafts do not exist until S4,
 * where the daemon supplies a real implementation instead of `() => false`
 * (deferral recorded in s2-execution Part 4.3 #2).
 */
import type { Message, MessageGuid, Rule } from '../domain/types.js';
import { evaluateMatcher } from './matchers.js';

export interface EvaluateContext {
  /** §1.3.8: an edit is re-matched only when no draft exists yet. */
  hasDraftForMessage(guid: MessageGuid): boolean;
}

/** §1.7 input eligibility, evaluated before any matcher runs. */
function isMessageEligible(message: Message, ctx: EvaluateContext): boolean {
  if (message.isFromMe) return false; // INV-6, primary loop guard §2.4.3
  switch (message.kind) {
    case 'tapback': // §1.3.8: a 'loved' tapback must not trigger an auto-reply
    case 'unsend':
      return false;
    case 'edit':
      return !ctx.hasDraftForMessage(message.guid);
    case 'text':
    case 'audio':
    case 'attachment-only':
      return true;
  }
}

function isRuleEligible(rule: Rule, message: Message): boolean {
  if (!rule.enabled) return false; // UI §3 S3: dimmed, editable, skipped
  if (
    (message.kind === 'audio' || message.kind === 'attachment-only') &&
    !rule.matchAttachmentOnly
  ) {
    return false; // §1.7: attachment-ish kinds gate on matchAttachmentOnly
  }
  return true;
}

/**
 * Evaluate all rules against a message. Returns every matching rule in
 * firing order: priority ASC, id ASC tiebreak. Group messages ARE matched
 * (§1.3.8: "ingested, matched, and surfaced as events/audit only").
 */
export function evaluateRules(
  rules: readonly Rule[],
  message: Message,
  ctx: EvaluateContext,
): Rule[] {
  if (!isMessageEligible(message, ctx)) return [];
  const input = { text: message.text, handle: message.handle };
  return rules
    .filter(
      (rule) =>
        isRuleEligible(rule, message) && evaluateMatcher(rule.matcher, input),
    )
    .sort((a, b) =>
      a.priority !== b.priority
        ? a.priority - b.priority
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
}

/**
 * Dry-run replay — pure part of §1.6 route 7 (S2 Scenario 10).
 *
 * §1.3.2 "Dry run" affordance: replays a rule against the last N inbound
 * messages, read-only, no drafts created. This helper is the thin
 * composition over `evaluateRules` for a single rule; the daemon route
 * supplies the window (most recent first via
 * `store.listRecentInboundMessages`) and this helper never re-orders it.
 *
 * Verdict fidelity: per-row verdicts use the SAME engine and the SAME
 * message eligibility as live matching — a self-sent or tapback row reports
 * matched:false for exactly the reason live matching skips it. ONE
 * deliberate divergence, cited: rule-level `enabled` is ignored, because a
 * disabled rule must still be dry-runnable (editor affordance; UI §3 S3's
 * dry-run panel operates on drafts-in-progress). Everything else
 * (matchAttachmentOnly gating, kind/isFromMe eligibility, matcher
 * semantics) is live-identical.
 *
 * Part 4.3 #2 deferral: drafts do not exist until S4, so the edit-re-match
 * predicate is the documented `() => false` stub — the same stub the daemon
 * pipeline and the rules-test route use.
 *
 * Pure per INV-1: no Clock, no I/O, no store access, inputs never mutated.
 */
import type { Handle, Message, MessageGuid, Rule } from '../domain/types.js';
import { evaluateRules } from './evaluate.js';

/** §1.6 route 7: textPreview is the first 80 chars of the decoded text. */
export const DRY_RUN_PREVIEW_CHARS = 80;

/** §1.6 route 7 row shape: { guid, handle, textPreview, matched }. */
export interface DryRunRow {
  guid: MessageGuid;
  handle: Handle;
  /** First 80 chars; null when the row has no text (no throw). */
  textPreview: string | null;
  matched: boolean;
}

/** §1.6 route 7 response body: { total, matched, rows }. */
export interface DryRunResult {
  /** Rows evaluated (the window actually available, ≤ requested limit). */
  total: number;
  /** Rows where matched === true. */
  matched: number;
  /** Same order as the input window (most recent first at the route). */
  rows: DryRunRow[];
}

export function dryRun(rule: Rule, messages: readonly Message[]): DryRunResult {
  // Editor affordance (UI §3 S3): dry-run evaluates the matcher even for a
  // disabled rule. Copy-on-override keeps the caller's rule untouched.
  const armed: Rule = rule.enabled ? rule : { ...rule, enabled: true };
  const ctx = { hasDraftForMessage: () => false };
  const rows: DryRunRow[] = messages.map((message) => ({
    guid: message.guid,
    handle: message.handle,
    textPreview:
      message.text === null
        ? null
        : message.text.slice(0, DRY_RUN_PREVIEW_CHARS),
    matched: evaluateRules([armed], message, ctx).length > 0,
  }));
  return {
    total: rows.length,
    matched: rows.filter((row) => row.matched).length,
    rows,
  };
}

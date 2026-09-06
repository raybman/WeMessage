/**
 * F-109: the list's "N today", derived from audit rows the screen already has.
 *
 * Not a route and not a stored counter. `rule.matched` is already in the
 * §2.3 `audit_log` and already reachable through `GET /v1/audit`, so a
 * per-rule tally is a fold over a page the client fetched anyway. Adding a
 * column would mean a number that can disagree with the log it summarises.
 *
 * Two details are the whole test:
 *
 *  - **LOCAL midnight**, not UTC and not a rolling 24 hours. The operator
 *    reads "today" as their own day. West of UTC a UTC midnight puts this
 *    evening's matches in tomorrow's count; east of it, last night's in
 *    today's.
 *  - **`rule.matched` only.** A `draft.created` carries a `ruleId` too, and
 *    counting both doubles every row on the list.
 *
 * A row whose `eventJson` will not parse is SKIPPED rather than thrown on: a
 * rules list that goes blank because one historical audit row is malformed
 * is a worse failure than a count that is one low.
 */
import type { AuditRowPayload } from '@wemessage/client';

/** Midnight of `nowIso`'s own day, in the machine's zone, as epoch ms. */
function localMidnight(nowIso: string): number {
  const now = new Date(nowIso);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Matches per rule id since local midnight.
 *
 * A rule absent from the map has no matches today; the caller renders
 * `map.get(id) ?? 0` rather than a blank, because a blank reads as "unknown"
 * and the answer is known.
 */
export function rulesToday(
  rows: readonly AuditRowPayload[],
  nowIso: string,
): ReadonlyMap<string, number> {
  const floor = localMidnight(nowIso);
  const out = new Map<string, number>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at) || at < floor) continue;
    let event: unknown;
    try {
      event = JSON.parse(row.eventJson);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const bag = event as Record<string, unknown>;
    if (bag['type'] !== 'rule.matched') continue;
    const ruleId = bag['ruleId'];
    if (typeof ruleId !== 'string' || ruleId.length === 0) continue;
    out.set(ruleId, (out.get(ruleId) ?? 0) + 1);
  }
  return out;
}

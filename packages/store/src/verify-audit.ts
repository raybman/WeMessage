/**
 * Thin chunked walker over `readAuditRows` (s2 Scenario 6). The walk LOGIC
 * itself stays core/audit's pure `verifyChain` — this module only pages
 * rows in bounded-memory chunks and threads the ChainLink between them.
 */
import type { AuditRow, ChainLink, VerifyChainResult } from '@wemessage/core';
import { verifyChain } from '@wemessage/core';

/** Anything that can page audit rows (the `Store` port qualifies). */
export interface AuditRowsSource {
  readAuditRows(afterSeq: number, limit: number): AuditRow[];
}

/**
 * Full-chain verification in chunks of `chunkSize` rows. Returns core's
 * `VerifyChainResult`; on failure, `length` counts all rows examined across
 * chunks up to and including the failing one.
 */
export function verifyAuditChain(
  source: AuditRowsSource,
  chunkSize = 500,
): VerifyChainResult {
  let prior: ChainLink | undefined;
  let length = 0;
  for (;;) {
    const rows = source.readAuditRows(prior?.seq ?? 0, chunkSize);
    if (rows.length === 0) {
      return { ok: true, length };
    }
    const result = verifyChain(rows, prior);
    if (!result.ok) {
      return { ...result, length: length + result.length };
    }
    length += result.length;
    const last = rows[rows.length - 1] as AuditRow;
    prior = { seq: last.seq, hash: last.hash };
  }
}

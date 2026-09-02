/**
 * Audit hash-chain math — pure (S2 Scenario 4).
 * Plan §2.3: hash = sha256(prev_hash || at || event || actor).
 *
 * F-13 canonical encoding (coordinator-confirmed; FROZEN once one row ships
 * in a real store):
 *   - input = UTF-8 bytes of prevHash + '\n' + at + '\n' + eventJson + '\n'
 *     + actorJson (the four STORED strings, verbatim — never re-serialized);
 *   - output = lowercase hex (64 chars);
 *   - genesis: seq 1 uses prev_hash = '0'.repeat(64).
 *
 * `node:crypto` here is legal under the arch rules as pinned by S2
 * Scenario 1: sha256 is a pure deterministic function (no I/O, no clock,
 * no entropy — `randomBytes`-style use stays banned from core by review,
 * INV-1 "ulid at the I/O edge" precedent).
 */
import { createHash } from 'node:crypto';
import type { AuditRow } from '../ports/index.js';
import type { IsoUtc } from '../domain/types.js';

export const GENESIS_HASH = '0'.repeat(64);

export function chainHash(
  prevHash: string,
  at: IsoUtc,
  eventJson: string,
  actorJson: string,
): string {
  return createHash('sha256')
    .update(prevHash + '\n' + at + '\n' + eventJson + '\n' + actorJson, 'utf8')
    .digest('hex');
}

export type VerifyFailureReason = 'seq-gap' | 'link-broken' | 'hash-mismatch';

export type VerifyChainResult =
  | { ok: true; length: number }
  | {
      ok: false;
      brokenAtSeq: number;
      reason: VerifyFailureReason;
      /** Rows examined in this walk (first failure wins; walk stops there). */
      length: number;
      /** Substrate for the S8 tamper EXPORT REPORT (s2 §1.8). */
      expectedHash?: string;
      actualHash?: string;
    };

/** Link expectation carried between chunks (Scenario 6 walks readAuditRows). */
export interface ChainLink {
  seq: number;
  hash: string;
}

/**
 * Walk `rows` checking, per row and in this order (first failure wins):
 *  1. contiguity — seq must be prior.seq + 1 (gapless from 1, UI §3 S6);
 *  2. linkage — prevHash must equal the prior row's hash (genesis for seq 1);
 *  3. recomputed-hash equality over the STORED strings verbatim (F-13).
 *
 * `prior` continues a chunked walk: pass the last verified row of the
 * previous chunk. Omitted, the walk starts at genesis (seq 1).
 */
export function verifyChain(
  rows: readonly AuditRow[],
  prior?: ChainLink,
): VerifyChainResult {
  let expectedSeq = (prior?.seq ?? 0) + 1;
  let expectedPrev = prior?.hash ?? GENESIS_HASH;

  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'seq-gap',
        length: rows.length,
      };
    }
    if (row.prevHash !== expectedPrev) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'link-broken',
        length: rows.length,
        expectedHash: expectedPrev,
        actualHash: row.prevHash,
      };
    }
    const recomputed = chainHash(
      row.prevHash,
      row.at,
      row.eventJson,
      row.actorJson,
    );
    if (row.hash !== recomputed) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: 'hash-mismatch',
        length: rows.length,
        expectedHash: recomputed,
        actualHash: row.hash,
      };
    }
    expectedSeq += 1;
    expectedPrev = row.hash;
  }

  return { ok: true, length: rows.length };
}

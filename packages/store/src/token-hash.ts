/**
 * s5 Scenario 3 — adapter token hashing.
 *
 * scrypt from `node:crypto`, not argon2id (F-41): argon2 is a native
 * dependency, and §1.2 admits no new repo-level production deps. The salt
 * travels inline in the stored string so a hash is self-describing and a
 * future parameter change can be rolled forward per row.
 *
 * Format: `scrypt$<N>$<saltHex>$<digestHex>`.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const KEYLEN = 32;

export function hashAdapterToken(token: string, salt?: Buffer): string {
  const s = salt ?? randomBytes(16);
  const digest = scryptSync(token, s, KEYLEN, { N, r: 8, p: 1 });
  return `scrypt$${String(N)}$${s.toString('hex')}$${digest.toString('hex')}`;
}

/** Constant-time compare. A malformed or empty stored hash verifies nothing. */
export function verifyAdapterToken(
  token: string,
  stored: string | null,
): boolean {
  if (stored === null || stored === '') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2] ?? '', 'hex');
  const expected = Buffer.from(parts[3] ?? '', 'hex');
  if (!Number.isFinite(n) || salt.length === 0 || expected.length === 0)
    return false;
  const actual = scryptSync(token, salt, expected.length, { N: n, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

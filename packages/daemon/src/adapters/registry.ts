/**
 * s5 Scenario 4 — adapter credential helpers.
 *
 * Pure functions over the store: mint a token, rotate one with a single 60s
 * carry-over slot (F-42), and build the connect command an operator pastes.
 * The plaintext is returned to exactly one caller, the route that asked for
 * it, and is never stored, logged or audited.
 */
import { randomBytes } from 'node:crypto';
import type { Clock, Store } from '@wemessage/core';
import { hashAdapterToken } from '@wemessage/store';

/** R11 prefix + 32 random bytes, matching auth.ts's discipline. */
export function generateAdapterToken(): string {
  return `wm_${randomBytes(32).toString('hex')}`;
}

/** How long a rotated-out token keeps working (F-42). One slot, never a chain. */
export const ROTATION_GRACE_MS = 60_000;

export function connectCmd(kind: string, port: number, token: string): string {
  return `wemessage-adapter-${kind} --url ws://127.0.0.1:${String(port)}/v1/agent --token ${token}`;
}

/** First mint: no carry-over exists yet, so nothing is parked. */
export function mintToken(store: Store, id: string): string {
  const token = generateAdapterToken();
  store.setAdapterTokenHash(id, hashAdapterToken(token), null);
  return token;
}

/**
 * Rotation. The outgoing hash moves into the carry-over slot inside the
 * store, which is the only place that ever sees hash material.
 */
export function rotateToken(store: Store, id: string, clock: Clock): string {
  const token = generateAdapterToken();
  store.rotateAdapterTokenHash(
    id,
    hashAdapterToken(token),
    new Date(clock.nowMs() + ROTATION_GRACE_MS).toISOString(),
  );
  return token;
}

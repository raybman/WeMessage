/**
 * §1.6 routes 8-9: audit list + verify (S2 Scenario 11).
 *
 * Both are read-only over the store's append-only audit_log (§2.3):
 *  - GET /v1/audit: store.listAudit is already reverse-chron (seq DESC);
 *    `since` (ISO, inclusive lower bound — F-19's `sinceAt`) and `event`
 *    (exact type filter) compose AND; `limit` defaults to 100, capped at
 *    1000 — 400 above, never silently clamped (route 7 dry-run precedent).
 *  - GET /v1/audit/verify: a full chain walk on EVERY call, never cached
 *    (§2.3 "full chain walk every call") — @wemessage/store's
 *    verifyAuditChain chunks over store.readAuditRows and defers the
 *    hash-chain math itself to core's pure verifyChain (F-13 frozen
 *    encoding). Response shape is core's VerifyChainResult verbatim.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '@wemessage/core';
import { verifyAuditChain } from '@wemessage/store';

export interface AuditRouteDeps {
  store: Store;
}

// strictObject: unknown query params are surface too (fail closed — same
// idiom as rules.ts's dryRunQuery, route 7).
const listQuery = z.strictObject({
  since: z.string().min(1).optional(),
  event: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export function registerAuditRoutes(
  app: FastifyInstance,
  deps: AuditRouteDeps,
): void {
  const { store } = deps;

  // §1.6 route 8: audit list (§2.4.4, §3.8)
  app.get('/v1/audit', (req, reply) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-query',
        detail: { issues: parsed.error.issues },
      });
    }
    const { since, event, limit } = parsed.data;
    return store.listAudit({
      ...(since !== undefined ? { sinceAt: since } : {}),
      ...(event !== undefined ? { event } : {}),
      limit,
    });
  });

  // §1.6 route 9: audit verify (§2.3) — never cached, full walk every call.
  app.get('/v1/audit/verify', () => verifyAuditChain(store));
}

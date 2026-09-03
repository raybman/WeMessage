/**
 * §2.4.3 contact policies (s4-execution Scenario 10). Three modes on a
 * ladder: 'deny' (nothing), 'draft-only' (a human must approve), 'auto'
 * (the rule may send on its own). An ABSENT row is not a fourth mode, it is
 * "unknown", and §1.3.5's deny-all default means unknown denies for
 * rule-driven traffic.
 *
 * That distinction is why DELETE removes the row rather than writing
 * 'deny'. Both refuse the next message, so a shortcut looks harmless, but
 * the audit trail would then be unable to answer "did the operator ever
 * decide about this person, or have they simply never come up?" — which is
 * the difference between a policy and an accident.
 *
 * Handles are normalized on the way in (§1.7 / §2.3), reusing the SAME
 * normalizer the rule contact-matcher uses. A policy set on
 * '(555) 000-0007' and a message arriving from '+15550000007' must be the
 * same row, or the operator's decision silently fails to apply.
 *
 * The ladder binds the AGENT boundary only. A human sending from their own
 * machine through /v1/send is exempt (§2.4.5, F-20): the allowlist exists to
 * keep hostile inbound from reaching agents, not to stop the operator from
 * texting whoever they like.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanApiActor,
  normalizeHandle,
  type Clock,
  type ContactMode,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';

export interface ContactRouteDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append'>;
}

const putBody = z.strictObject({
  mode: z.enum(['deny', 'draft-only', 'auto']),
  displayName: z.string().min(1).optional(),
});

export function registerContactRoutes(
  app: FastifyInstance,
  deps: ContactRouteDeps,
): void {
  const { store, clock, sink } = deps;
  const actor = humanApiActor();

  app.get('/v1/contacts', async (_req, reply) =>
    reply.send({ contacts: store.listContactPolicies() }),
  );

  app.put<{ Params: { handle: string } }>(
    '/v1/contacts/:handle',
    async (req, reply) => {
      const parsed = putBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid-contact-policy',
          detail: { issues: parsed.error.issues },
        });
      }
      const handle = normalizeHandle(decodeURIComponent(req.params.handle));
      const previous = store.getContactPolicy(handle);
      const policy = {
        handle,
        mode: parsed.data.mode satisfies ContactMode,
        ...(parsed.data.displayName !== undefined
          ? { displayName: parsed.data.displayName }
          : {}),
        updatedAt: clock.now(),
      };
      store.setContactPolicy(policy);
      // from:null is the honest reading of "there was no decision here
      // before", which is not the same fact as "it used to be deny".
      sink.append(
        {
          type: 'contact.policy-changed',
          handle,
          from: previous?.mode ?? null,
          to: policy.mode,
        },
        actor,
      );
      return reply.send({ contact: policy });
    },
  );

  app.delete<{ Params: { handle: string } }>(
    '/v1/contacts/:handle',
    async (req, reply) => {
      const handle = normalizeHandle(decodeURIComponent(req.params.handle));
      const previous = store.getContactPolicy(handle);
      if (previous === null || !store.deleteContactPolicy(handle)) {
        return reply.code(404).send({ error: 'not-found' });
      }
      sink.append(
        {
          type: 'contact.policy-changed',
          handle,
          from: previous.mode,
          to: null,
        },
        actor,
      );
      return reply.send({ deleted: handle });
    },
  );
}

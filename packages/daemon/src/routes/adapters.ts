/**
 * §1.6 adapter registry routes (s5-execution Scenario 4).
 *
 * The registry is where an operator decides which agents may speak into
 * their conversations at all, so every verb here is audited, and the one
 * secret involved is shown exactly once.
 *
 * Postures, inherited and not re-decided:
 *  - §1.8: `sink.append` before anything else observable.
 *  - The token is minted here, returned here, and never read back. `GET`
 *    answers `hasToken`, a boolean. If an operator loses the token they
 *    rotate; there is no recovery path, by design.
 *  - Deleting an adapter a rule still points at is a 409, not a cascade: the
 *    rule would otherwise be left addressing an agent that cannot exist.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  humanApiActor,
  type AdapterRecord,
  type Clock,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';
import { connectCmd, mintToken, rotateToken } from '../adapters/registry.js';

export interface AdapterRouteDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append'>;
  /** Used only to build the connect command an operator pastes. */
  port: number;
}

const KINDS = ['sol', 'hermes', 'luna', 'openclaw', 'echo', 'generic'] as const;

const createBody = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(KINDS),
  displayName: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

const patchBody = z.strictObject({
  enabled: z.boolean().optional(),
  displayName: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export function registerAdapterRoutes(
  app: FastifyInstance,
  deps: AdapterRouteDeps,
): void {
  const { store, clock, sink, port } = deps;
  const actor = humanApiActor();

  app.get('/v1/adapters', async (_req, reply) =>
    reply.send({ adapters: store.listAdapters() }),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/adapters/:id',
    async (req, reply) => {
      const adapter = store.getAdapter(req.params.id);
      if (adapter === null) return reply.code(404).send({ error: 'not-found' });
      return reply.send({ adapter });
    },
  );

  app.post('/v1/adapters', async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-adapter',
        detail: { issues: parsed.error.issues },
      });
    }
    const { id, kind, displayName } = parsed.data;
    // 'human' is taken by the reserved FK anchor, and getAdapter hides it —
    // so the conflict has to be checked against the raw id, not the lookup.
    if (id === 'human' || store.getAdapter(id) !== null) {
      return reply.code(409).send({ error: 'adapter-exists', id });
    }
    const adapter: AdapterRecord = {
      id,
      kind,
      displayName,
      enabled: true,
      hasToken: false,
      health: 'unknown',
      config: parsed.data.config ?? {},
    };
    store.insertAdapter(adapter);
    const token = mintToken(store, id);
    sink.append({ type: 'adapter.created', adapterId: id, kind }, actor);
    return reply.code(201).send({
      adapter: store.getAdapter(id),
      token,
      connectCmd: connectCmd(kind, port, token),
    });
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/adapters/:id',
    async (req, reply) => {
      const existing = store.getAdapter(req.params.id);
      if (existing === null)
        return reply.code(404).send({ error: 'not-found' });
      const parsed = patchBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid-adapter',
          detail: { issues: parsed.error.issues },
        });
      }
      const next: AdapterRecord = {
        ...existing,
        ...(parsed.data.enabled !== undefined
          ? { enabled: parsed.data.enabled }
          : {}),
        ...(parsed.data.displayName !== undefined
          ? { displayName: parsed.data.displayName }
          : {}),
        ...(parsed.data.config !== undefined
          ? { config: parsed.data.config }
          : {}),
      };
      store.updateAdapter(next);
      sink.append(
        {
          type: 'adapter.updated',
          adapterId: next.id,
          from: {
            enabled: existing.enabled,
            displayName: existing.displayName,
          },
          to: { enabled: next.enabled, displayName: next.displayName },
        },
        actor,
      );
      return reply.send({ adapter: store.getAdapter(next.id) });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/adapters/:id/token',
    async (req, reply) => {
      const existing = store.getAdapter(req.params.id);
      if (existing === null)
        return reply.code(404).send({ error: 'not-found' });
      const token = rotateToken(store, existing.id, clock);
      sink.append(
        { type: 'adapter.token-rotated', adapterId: existing.id },
        actor,
      );
      return reply.send({
        adapter: store.getAdapter(existing.id),
        token,
        connectCmd: connectCmd(existing.kind, port, token),
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/adapters/:id',
    async (req, reply) => {
      const existing = store.getAdapter(req.params.id);
      if (existing === null)
        return reply.code(404).send({ error: 'not-found' });
      try {
        store.deleteAdapter(existing.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith('adapter-referenced')) throw error;
        return reply.code(409).send({
          error: 'adapter-referenced',
          ruleIds: message.slice('adapter-referenced: '.length).split(','),
        });
      }
      sink.append({ type: 'adapter.deleted', adapterId: existing.id }, actor);
      return reply.code(204).send();
    },
  );
}

/**
 * §1.6 routes: POST /v1/disconnect, POST /v1/connect (s3-execution
 * Scenario 9). Thin wrappers over connection.ts's `disconnectDaemon`/
 * `connectDaemon` — same "engine does the work, route does the HTTP" split
 * as routes/doctor.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  connectDaemon,
  disconnectDaemon,
  type ConnectDeps,
  type DisconnectDeps,
} from '../connection.js';

export interface ConnectionRouteDeps {
  disconnect: DisconnectDeps;
  connect: ConnectDeps;
}

const disconnectBody = z.strictObject({ purge: z.boolean().optional() });

export function registerConnectionRoutes(
  app: FastifyInstance,
  deps: ConnectionRouteDeps,
): void {
  app.post('/v1/disconnect', (req, reply) => {
    const parsed = disconnectBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-disconnect',
        detail: { issues: parsed.error.issues },
      });
    }
    const purge = parsed.data.purge ?? false;
    const report = disconnectDaemon(deps.disconnect, { purge });
    return reply.send(report);
  });

  app.post('/v1/connect', async (_req, reply) => {
    const report = await connectDaemon(deps.connect);
    return reply.send(report);
  });
}

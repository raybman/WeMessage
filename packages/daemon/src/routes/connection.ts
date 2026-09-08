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
    const { report, afterResponse } = disconnectDaemon(deps.disconnect, {
      purge,
    });

    /*
     * ARMED BEFORE THE SEND, FIRED AFTER IT.
     *
     * `close` rather than `finish`: `finish` says the last chunk reached the
     * socket, `close` says the exchange is over, and only `close` also fires
     * when the client walked away mid-response. Both matter here. A
     * successful `bootout` ends this process, so if it ran before the send
     * the operator would get a reset connection instead of the report they
     * asked for -- and if it never ran because the client aborted, a daemon
     * the operator explicitly disconnected would still be running at the
     * next login. The audit row is already written either way: the human
     * asked, and that is the fact the log records.
     *
     * Registered before `send` because `send` can complete synchronously.
     */
    if (afterResponse !== null)
      reply.raw.once('close', () => {
        void afterResponse();
      });

    return reply.send(report);
  });

  app.post('/v1/connect', async (_req, reply) => {
    const report = await connectDaemon(deps.connect);
    return reply.send(report);
  });
}

/**
 * Daemon HTTP/WS skeleton (S1): token auth, /v1/health, /v1/status,
 * WS /v1/events. Fail-closed per §2.4.2 row 1; bearer auth per §2.6.
 * Event fan-out and real status wiring land in Scenario 11.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { loadOrCreateToken, tokenEquals } from './auth.js';

export interface DaemonOptions {
  /** Injected config dir (tests use temp dirs; never the real App Support). */
  configDir: string;
}

export interface DaemonServer {
  app: FastifyInstance;
  /** null => no token could be read or generated => 503-everything mode. */
  token: string | null;
  /** Test observability: route-handler executions (must stay 0 in 503 mode). */
  counters: { handlerCalls: number };
}

const HEALTH_PATH = '/v1/health';

export async function buildServer(opts: DaemonOptions): Promise<DaemonServer> {
  const token = loadOrCreateToken(opts.configDir);
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const counters = { handlerCalls: 0 };

  app.addHook('onRequest', async (req, reply) => {
    // §2.4.2 row 1: no token → 503 everything, health included. Never open.
    if (token === null) {
      return reply.code(503).send({ error: 'no-auth-token' });
    }
    // F-4 (proposed resolution, cited in auth-failclosed.spec.ts): with a token
    // present, unauthenticated GET /v1/health is liveness-only. Everything else
    // requires the bearer; WS authenticates the same way at upgrade (§2.6).
    if (req.method === 'GET' && req.url.split('?')[0] === HEALTH_PATH) {
      return;
    }
    const header = req.headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : null;
    if (presented === null || !tokenEquals(token, presented)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get(HEALTH_PATH, () => {
    counters.handlerCalls += 1;
    return { status: 'ok' }; // liveness only, no state payload (F-4)
  });

  app.get('/v1/status', () => {
    counters.handlerCalls += 1;
    // F-5 proposed S1 payload: nulls for S4/S6 concepts, never fake values.
    // Real cursor/counts wiring lands in Scenario 11.
    return {
      connectionState: 'disconnected',
      cursor: null,
      counts: { messagesToday: 0 },
      adapters: [],
      killSwitch: null,
      armed: null,
    };
  });

  app.get('/v1/events', { websocket: true }, () => {
    counters.handlerCalls += 1;
    // Event bus fan-out lands in Scenario 11; auth already enforced at upgrade.
  });

  return { app, token, counters };
}

/**
 * Listen on 127.0.0.1 ONLY (§2.6, §1.4.2 #3 — the bind host is not
 * configurable). Returns the bound port (ephemeral when port is 0/omitted).
 */
export async function startServer(
  server: DaemonServer,
  opts?: { port?: number },
): Promise<number> {
  await server.app.listen({ host: '127.0.0.1', port: opts?.port ?? 0 });
  const address = server.app.addresses()[0];
  if (!address) throw new Error('daemon failed to bind');
  return address.port;
}

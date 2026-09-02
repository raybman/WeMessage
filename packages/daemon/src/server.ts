/**
 * Daemon HTTP/WS surface (S1): token auth, /v1/health, /v1/status,
 * WS /v1/events. Fail-closed per §2.4.2 row 1; bearer auth per §2.6.
 *
 * Auth reads the token FILE per request (§2.6: the CLI manages the file
 * directly, `auth rotate` rewrites it) so rotation 401s old bearers
 * immediately without a daemon restart. The boot-time token is only the
 * first-run generation + fallback when the file vanishes mid-flight.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { Clock, Store } from '@wemessage/core';
import { createAuditSink, type AuditSink } from './audit-sink.js';
import { loadOrCreateToken, readToken, tokenEquals } from './auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerRuleRoutes } from './routes/rules.js';

export interface DaemonOptions {
  /** Injected config dir (tests use temp dirs; never the real App Support). */
  configDir: string;
  /** F-5 status payload provider; Scenario 11 wires the real one. */
  getStatus?: () => unknown;
  /** Called with each authenticated WS /v1/events socket (event fan-out). */
  onEventsClient?: (socket: WebSocket) => void;
  /**
   * When provided, registers the S2 rule routes (§1.6 routes 1-6) and the
   * audit sink. Optional so S1 transport harnesses keep booting bare.
   * `sink` lets the composed daemon share ONE §1.8 chokepoint between the
   * routes and the match pipeline (Scenario 9); omitted, one is created.
   */
  rules?: { store: Store; clock: Clock; sink?: AuditSink };
}

export interface DaemonServer {
  app: FastifyInstance;
  /** null => no token could be read or generated => 503-everything mode. */
  token: string | null;
  /** Test observability: route-handler executions (must stay 0 in 503 mode). */
  counters: { handlerCalls: number };
  /**
   * INV-3/F-17 observability: every registered route as `METHOD url`
   * (auto-HEAD twins included). The transport-surface ratchet pins this
   * list — see test/transport-surface.snapshot.ts before adding routes.
   */
  routes: string[];
  /** Present when opts.rules was given; Scenario 9 emits through it. */
  sink?: AuditSink;
}

const HEALTH_PATH = '/v1/health';

export async function buildServer(opts: DaemonOptions): Promise<DaemonServer> {
  const bootToken = loadOrCreateToken(opts.configDir);
  const app = Fastify({ logger: false });

  // INV-3/F-17: record the full reachable surface. Registered before any
  // route (hooks only see routes added after them).
  const routes: string[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push(`${method} ${route.url}`);
  });

  await app.register(websocket);
  const counters = { handlerCalls: 0 };

  // §2.6: the token file is the live source of truth (rotation = rewrite);
  // fall back to the boot token only if the file disappears mid-flight.
  const currentToken = (): string | null =>
    readToken(opts.configDir) ?? bootToken;

  app.addHook('onRequest', async (req, reply) => {
    const token = currentToken();
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
    return (
      opts.getStatus?.() ?? {
        connectionState: 'disconnected',
        cursor: null,
        counts: { messagesToday: 0 },
        adapters: [],
        killSwitch: null,
        armed: null,
      }
    );
  });

  const sink = opts.rules
    ? (opts.rules.sink ?? createAuditSink(opts.rules))
    : undefined;

  app.get('/v1/events', { websocket: true }, (socket) => {
    counters.handlerCalls += 1;
    // auth already enforced at upgrade by the onRequest hook (§2.6)
    sink?.addClient(socket);
    opts.onEventsClient?.(socket);
  });

  if (opts.rules && sink) {
    // §1.6 routes 1-6 (S2 Scenario 7). The transport-surface ratchet pins
    // the resulting route table — update the snapshot deliberately.
    registerRuleRoutes(app, {
      store: opts.rules.store,
      clock: opts.rules.clock,
      sink,
    });
    // §1.6 routes 8-9 (S2 Scenario 11): audit reads share the rules gate —
    // there is no standalone opt-in, audit only exists where rules do.
    registerAuditRoutes(app, { store: opts.rules.store });
  }

  return {
    app,
    token: bootToken,
    counters,
    routes,
    ...(sink ? { sink } : {}),
  };
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

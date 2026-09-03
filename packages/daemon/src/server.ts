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
import type { ChatDbReader, Clock, SendBackend, Store } from '@wemessage/core';
import { createAuditSink, type AuditSink } from './audit-sink.js';
import { loadOrCreateToken, readToken, tokenEquals } from './auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerDoctorRoutes } from './routes/doctor.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerToggleRoutes } from './routes/toggles.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerSendRoutes } from './routes/send.js';
import { registerConnectionRoutes } from './routes/connection.js';
import type { DoctorProbes } from './doctor.js';

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
  /**
   * s3-execution Scenario 8: when provided, registers `GET /v1/doctor` and
   * `POST /v1/send` (§1.6). Optional for the same reason `rules` is —
   * earlier transport harnesses boot bare. Shares the ONE §1.8 sink with
   * `rules` when the real daemon passes both (daemon.ts always does); a
   * standalone test may pass `send` alone and get its own sink instead.
   */
  send?: {
    store: Store;
    reader: ChatDbReader;
    backend: SendBackend;
    backendName: string;
    clock: Clock;
    delay: (ms: number) => Promise<void>;
    doctorProbes: DoctorProbes;
    sink?: AuditSink;
  };
  /**
   * s3-execution Scenario 9: when provided, registers `POST /v1/disconnect`
   * and `POST /v1/connect` (§1.6). Shares the ONE §1.8 sink with `rules`/
   * `send` when the real daemon passes all three (daemon.ts always does).
   * `purge()` is wrapped below so the module-local `purged` latch flips to
   * true BEFORE the real purge runs — fail-closed even if the delete itself
   * throws partway through.
   */
  connection?: {
    store: Store;
    clock: Clock;
    sink?: AuditSink;
    probes: DoctorProbes;
    stopWatcher: () => void;
    closeEventClients: () => void;
    rotateToken: () => string | null;
    purge: () => void;
    rearmWatcher: () => Promise<void>;
  };

  /**
   * s4-execution Scenario 5: when provided, registers the §1.6 draft
   * review surface (create/list/show/approve/reject). Optional on the same
   * terms as `rules`/`send`/`connection`, and shares the ONE §1.8 sink with
   * them when the composed daemon passes several.
   */
  drafts?: { store: Store; clock: Clock; sink?: AuditSink };
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

  // s3-execution Scenario 9: once a `purge:true` disconnect runs, this
  // process must never serve authenticated again, even if the config-dir
  // delete itself throws partway (the connection.purge wrapper below flips
  // this BEFORE calling the real purge). Checked ahead of the token file so
  // a purge can't be undone by another process re-creating the file.
  let purged = false;

  // §2.6: the token file is the live source of truth (rotation = rewrite);
  // fall back to the boot token only if the file disappears mid-flight.
  const currentToken = (): string | null =>
    purged ? null : (readToken(opts.configDir) ?? bootToken);

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

  // One §1.8 chokepoint shared across rules/audit AND doctor/send when both
  // are provided (daemon.ts always provides both, with the same explicit
  // `sink` on each); either can also stand alone with its own sink in tests.
  const sinkSource = opts.rules ?? opts.send ?? opts.connection ?? opts.drafts;
  const sink = sinkSource
    ? (sinkSource.sink ??
      createAuditSink({ store: sinkSource.store, clock: sinkSource.clock }))
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

  if (opts.send && sink) {
    // §1.6 route: GET /v1/doctor (s3-execution Scenario 8), reusing the
    // Scenario 7 engine on-demand.
    registerDoctorRoutes(app, {
      probes: opts.send.doctorProbes,
      store: opts.send.store,
      sink,
      clock: opts.send.clock,
    });
    // §1.6 route: POST /v1/send (s3-execution Scenario 8), the human-direct
    // mint-then-dispatch path.
    registerSendRoutes(app, {
      store: opts.send.store,
      reader: opts.send.reader,
      backend: opts.send.backend,
      backendName: opts.send.backendName,
      clock: opts.send.clock,
      delay: opts.send.delay,
      doctorProbes: opts.send.doctorProbes,
      sink,
    });
  }

  if (opts.drafts && sink) {
    // §1.6 routes: the draft queue humans actually review through.
    registerDraftRoutes(app, {
      store: opts.drafts.store,
      clock: opts.drafts.clock,
      sink,
    });
    // The kill switch rides with the draft surface: it exists to stop
    // drafts, and there is no configuration in which one is wanted without
    // the other.
    // Contact policies ride with the draft surface for the same reason the
    // kill switch does: they are the other half of deciding what may be
    // said, and there is no configuration that wants one without the other.
    registerContactRoutes(app, {
      store: opts.drafts.store,
      clock: opts.drafts.clock,
      sink,
    });
    registerToggleRoutes(app, {
      store: opts.drafts.store,
      clock: opts.drafts.clock,
      sink,
    });
  }

  if (opts.connection && sink) {
    const connection = opts.connection;
    // Fail-closed even if the delete throws partway: flip the latch first.
    const purge = (): void => {
      purged = true;
      connection.purge();
    };
    registerConnectionRoutes(app, {
      disconnect: {
        store: connection.store,
        sink,
        stopWatcher: connection.stopWatcher,
        closeEventClients: connection.closeEventClients,
        rotateToken: connection.rotateToken,
        purge,
      },
      connect: {
        store: connection.store,
        sink,
        clock: connection.clock,
        probes: connection.probes,
        rearmWatcher: connection.rearmWatcher,
      },
    });
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

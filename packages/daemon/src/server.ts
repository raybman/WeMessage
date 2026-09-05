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
import type { GatewayEventPayload } from '@wemessage/protocol';
// s7 Sc12: the refusal code for a malformed `?events=` filter is the same
// protocol-level 4400 the adapter transport sends, and it is now spelled once.
import { CLOSE_CODES } from '@wemessage/protocol';
import { SETTING_KILL_SWITCH } from '@wemessage/core';
import type {
  ChatDbReader,
  Clock,
  Draft,
  SendBackend,
  Store,
} from '@wemessage/core';
import { createAuditSink, type AuditSink } from './audit-sink.js';
import { loadOrCreateToken, readToken, tokenEquals } from './auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerDoctorRoutes } from './routes/doctor.js';
import { registerAdapterRoutes } from './routes/adapters.js';
import {
  createAdapterTransport,
  type AdapterTransportHandle,
} from './adapters/transport.js';
import {
  createAgentRequests,
  createAgentSubmitHandler,
  type AgentRequests,
} from './adapters/submit.js';
import {
  createAgentFeedback,
  type AgentFeedback,
} from './adapters/feedback.js';
import { createRequestSender } from './adapters/dispatch.js';

/**
 * The §2.6 local API port, used only to render the connect command an
 * operator pastes. A server bound to an ephemeral port in tests renders this
 * one, which is what an operator would actually type.
 */
const DEFAULT_ADAPTER_PORT = 47100;
import { registerDraftRoutes } from './routes/drafts.js';
import { registerToggleRoutes } from './routes/toggles.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSendRoutes } from './routes/send.js';
import { registerConnectionRoutes } from './routes/connection.js';
import { registerSseRoute, type SseTimer } from './routes/events-sse.js';
import { closeReasonFor, parseEventFilter } from './events-filter.js';
import { readConnectionState, type DoctorProbes } from './doctor.js';
import { resolveArming } from './arming.js';

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

  /**
   * s5-execution Scenario 4: the adapter registry surface. Separate opt-in
   * from `drafts` because an operator can run the human compose surface with
   * no agents registered at all, which is the S1-S4 product.
   */
  adapters?: {
    store: Store;
    clock: Clock;
    sink?: AuditSink;
    port?: number;
    /** s5 Sc5: injected so tests drive the deadline without sleeping. */
    helloDeadlineMs?: number;
    /**
     * s5 Sc8: needed only to re-ask an agent on redraft (a `draft.request`
     * carries conversation context, which is a chat.db read, F-46). Optional
     * because a server booted without it still serves the whole adapter
     * surface — the redraft simply stays the S4 body copy it always was.
     */
    reader?: ChatDbReader;
  };

  /**
   * s7 Scenario 3: the `connection.state` frame BOTH event transports open
   * with. One closure, read by the WS route and the SSE route, because the
   * whole point of the parity rows is that a client cannot tell which
   * transport it picked from the bytes it receives — and two greetings built
   * in two places is the first place that would stop being true.
   *
   * Optional because a bare S1 transport harness has no store to derive a
   * connection state from. `daemon.ts` always passes it.
   */
  greeting?: () => GatewayEventPayload;

  /**
   * s7 Scenario 3: the SSE keepalive seam (C-5). Tests hand in a timer they
   * fire by hand; production defaults to a real unref'd interval inside the
   * route, so nothing here reads a wall clock.
   */
  sse?: { keepaliveMs?: number; timer?: SseTimer };
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
  /** Present when opts.adapters was given (s5 Sc5): the WS /v1/agent owner. */
  agentTransport?: AdapterTransportHandle;
  /**
   * Present when opts.adapters was given (s5 Sc7): the issued-correlation
   * registry. The dispatcher writes to it when a `draft.request` leaves; the
   * submit handler reads it to tell a real answer from a forged one.
   */
  agentRequests?: AgentRequests;
  /**
   * Present when opts.adapters was given (s5 Sc8): the `draft.feedback`
   * emitter. Exposed so the composition root can wrap its `dispatchApproved`
   * closure with `observeDispatch` — the send path's outcome reaches the
   * adapter through a daemon-side callback, never a core import (INV-1).
   */
  agentFeedback?: AgentFeedback;
}

/** F-22: the reserved adapter row humans draft under; it is never re-asked. */
const HUMAN_ADAPTER_ID = 'human';

const HEALTH_PATH = '/v1/health';
/**
 * F-56 — the ONE route that opts out of the operator bearer, and the most
 * security-sensitive decision in S5.
 *
 * An adapter is not the operator. It holds a per-adapter `wm_` token that the
 * daemon stores only as a scrypt hash, and it presents that token in the
 * `hello` frame. Requiring the operator bearer at upgrade would mean handing
 * every agent on the machine the credential that can approve sends, rotate
 * auth and purge the gateway — precisely the escalation the per-adapter token
 * exists to prevent. So the upgrade is open and the FIRST FRAME is the gate:
 * `adapters/transport.ts` accepts nothing but `hello` from an unauthenticated
 * socket, closes it on anything else, and closes it on silence past the hello
 * deadline. The exemption is also narrow by construction — exact path, GET
 * only, and only when the adapter registry is actually wired.
 */
const AGENT_PATH = '/v1/agent';

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
    // F-56 (see AGENT_PATH above): adapters authenticate in `hello`, never
    // with the operator bearer.
    if (
      opts.adapters !== undefined &&
      req.method === 'GET' &&
      req.url.split('?')[0] === AGENT_PATH
    ) {
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

  // One §1.8 chokepoint shared across rules/audit AND doctor/send when both
  // are provided (daemon.ts always provides both, with the same explicit
  // `sink` on each); either can also stand alone with its own sink in tests.
  const sinkSource =
    opts.rules ?? opts.send ?? opts.connection ?? opts.drafts ?? opts.adapters;
  const sink = sinkSource
    ? (sinkSource.sink ??
      createAuditSink({ store: sinkSource.store, clock: sinkSource.clock }))
    : undefined;

  app.get('/v1/status', () => {
    counters.handlerCalls += 1;
    // F-5 proposed S1 payload: nulls for S4/S6 concepts, never fake values.
    // s5 Sc14: `adapters` is the one F-5 field this slice can finally fill —
    // adapter health lands here, so the registry IS the answer. It stays an
    // empty list on a server booted without adapters, which is the honest
    // reading of "there are none", not a placeholder.
    //
    // s6 Scenario 11: `killSwitch` and `armed` are the next two to stop being
    // placeholders, and they stop wherever a store is actually wired. A
    // server with no store at all keeps reporting `null` for both — that is
    // still the honest answer there, because there is nothing to derive them
    // from, and inventing `armed: false` would report a hold that does not
    // exist. Derived on every request, never cached (§1.7).
    return (
      opts.getStatus?.() ??
      (sinkSource
        ? {
            connectionState: readConnectionState(sinkSource.store),
            cursor: null,
            counts: { messagesToday: 0 },
            adapters: opts.adapters?.store.listAdapters() ?? [],
            killSwitch:
              sinkSource.store.getSetting(SETTING_KILL_SWITCH) === '1',
            armed: resolveArming({
              store: sinkSource.store,
              clock: sinkSource.clock,
            }),
          }
        : {
            connectionState: 'disconnected',
            cursor: null,
            counts: { messagesToday: 0 },
            adapters: opts.adapters?.store.listAdapters() ?? [],
            killSwitch: null,
            armed: null,
          })
    );
  });

  app.get('/v1/events', { websocket: true }, (socket, req) => {
    counters.handlerCalls += 1;
    // auth already enforced at upgrade by the onRequest hook (§2.6)
    //
    // s7 Scenario 3: `?events=` is parsed by the SAME module the SSE route
    // uses, before the socket joins the fan-out. A bad filter closes the
    // socket with 4400 and NEVER sends the greeting: a subscription that
    // was refused must not look briefly alive, or a client will report the
    // stream as working right up until it notices it received nothing.
    const parsed = parseEventFilter((req.query as { events?: unknown }).events);
    if (!parsed.ok) {
      socket.close(CLOSE_CODES.protocol.code, closeReasonFor(parsed.name));
      return;
    }
    const greeting = opts.greeting?.();
    if (greeting !== undefined) socket.send(JSON.stringify(greeting));
    sink?.addClient(socket, parsed.filter);
    opts.onEventsClient?.(socket);
  });

  if (sink) {
    // §1.6: `GET /v1/events/sse` (+ fastify's auto-HEAD twin) — ratchet #21.
    // Gated on the sink for the same reason every other surface is gated on
    // its dependency: a stream with nothing to subscribe to is a route that
    // exists only to hang. Read-only by construction (INV-2).
    registerSseRoute(app, {
      sink,
      ...(opts.greeting !== undefined ? { greeting: opts.greeting } : {}),
      ...(opts.sse?.keepaliveMs !== undefined
        ? { keepaliveMs: opts.sse.keepaliveMs }
        : {}),
      ...(opts.sse?.timer !== undefined ? { timer: opts.sse.timer } : {}),
      onHandled: () => {
        counters.handlerCalls += 1;
      },
    });
  }

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
    // §1.6 `/v1/schedules` (s6 Scenario 3). Same gate as rules and audit:
    // a schedule only means anything as a rule's arming window, so there is
    // no world where schedules are wanted and rules are not. Ratchet #19.
    registerScheduleRoutes(app, { store: opts.rules.store, sink });
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

  // s5 Scenario 8: the draft routes are registered before the adapter
  // transport exists (they are the older surface, and they must register
  // whether or not adapters are configured at all), so the feedback tap is
  // reached through a late-bound ref rather than a value. Undefined here
  // means "no agent era on this server", which is exactly the S1-S4 product.
  let agentFeedback: AgentFeedback | undefined;
  let redraftRequest: ((source: Draft) => void) | undefined;

  if (opts.drafts && sink) {
    // §1.6 routes: the draft queue humans actually review through.
    registerDraftRoutes(app, {
      store: opts.drafts.store,
      clock: opts.drafts.clock,
      sink,
      feedback: (input) => agentFeedback?.emit(input),
      onRedraft: (source) => redraftRequest?.(source),
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
    // s7 Sc4: the settings surface rides with the toggles for the same
    // reason the contact policies do — a toggle is a setting an operator
    // reaches for in a hurry, and the rest of them are the same table. It
    // is registered AFTER the toggle routes so the `use:` pointers this
    // route hands back always name routes that exist in the same server.
    registerSettingsRoutes(app, {
      store: opts.drafts.store,
      clock: opts.drafts.clock,
      sink,
    });
  }

  let agentTransport: AdapterTransportHandle | undefined;
  let agentRequests: AgentRequests | undefined;
  if (opts.adapters && sink) {
    // §1.6 adapter registry (s5 Scenario 4). Ratchet update #14.
    registerAdapterRoutes(app, {
      store: opts.adapters.store,
      clock: opts.adapters.clock,
      sink,
      port: opts.adapters.port ?? DEFAULT_ADAPTER_PORT,
    });
    // s5 Scenario 5: the adapter wire itself. Ratchet update #15.
    const adapterOpts = opts.adapters;
    // s5 Scenario 7: submit handling is composed HERE, next to the socket
    // that carries it, so `agentRequests` has exactly one owner per server.
    agentRequests = createAgentRequests();
    agentFeedback = createAgentFeedback({
      store: adapterOpts.store,
      clock: adapterOpts.clock,
      sink,
      // Late-bound for the same reason the daemon's dispatcher is: the
      // transport is built on the very next statement, and the feedback
      // module must not capture `undefined` forever. Addressed to the
      // ORIGINATING adapter and nobody else (teeth T8-broadcast-feedback).
      transport: {
        sendTo: (id, frame) => agentTransport?.sendTo(id, frame) ?? false,
      },
    });
    agentTransport = createAdapterTransport({
      store: adapterOpts.store,
      clock: adapterOpts.clock,
      sink,
      submit: createAgentSubmitHandler({
        store: adapterOpts.store,
        clock: adapterOpts.clock,
        sink,
        requests: agentRequests,
        // s5 Scenario 9: a `{handle}` target resolves against the same
        // chat.db the redraft re-ask reads. Omitted, never undefined.
        ...(adapterOpts.reader !== undefined
          ? { reader: adapterOpts.reader }
          : {}),
        refuse: (input) => agentFeedback?.refuse(input),
      }),
      ...(adapterOpts.helloDeadlineMs !== undefined
        ? { helloDeadlineMs: adapterOpts.helloDeadlineMs }
        : {}),
    });
    app.get(AGENT_PATH, { websocket: true }, (socket) => {
      counters.handlerCalls += 1;
      agentTransport?.accept(socket);
    });
    // S4 F-40's other half. A redraft is not a match: the rule already won
    // when the message arrived, so this re-asks that same rule's adapter
    // directly rather than re-running evaluation (which `hasDraftForMessage`
    // would suppress anyway, the body copy having just been minted).
    const reader = adapterOpts.reader;
    if (reader !== undefined) {
      const sender = createRequestSender({
        store: adapterOpts.store,
        clock: adapterOpts.clock,
        sink,
        reader,
        transport: {
          isConnected: (id) => agentTransport?.isConnected(id) ?? false,
          sendTo: (id, frame) => agentTransport?.sendTo(id, frame) ?? false,
        },
        issueRequest: (req) => agentRequests?.issue(req),
      });
      redraftRequest = (source) => {
        // Human drafts have no agent to re-ask; a proactive draft (Sc 9)
        // has no rule and no inbound message to re-ask about.
        if (source.adapterId === HUMAN_ADAPTER_ID) return;
        if (source.ruleId === null || source.inboundGuid === null) return;
        const rule = adapterOpts.store.getRule(source.ruleId);
        const message = adapterOpts.store.getInboundMessage(source.inboundGuid);
        if (rule === null || message === null) return;
        // Fire-and-forget: the redraft response is already decided, and
        // reading conversation context must not hold the route open.
        void sender.send(rule, message);
      };
    }
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
    ...(agentTransport ? { agentTransport } : {}),
    ...(agentRequests ? { agentRequests } : {}),
    ...(agentFeedback ? { agentFeedback } : {}),
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

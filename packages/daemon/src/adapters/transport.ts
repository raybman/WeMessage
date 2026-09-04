/**
 * s5-execution Scenario 5 — the WS adapter transport (`GET /v1/agent`).
 *
 * This is the daemon's only unauthenticated-at-upgrade route (F-56): an
 * adapter holds a per-adapter `wm_` token, not the operator bearer, and it
 * presents that token inside the first frame. Everything in this file exists
 * to make that exemption safe:
 *
 *  - hello-first. A socket that has not authenticated may do exactly one
 *    thing: send a well-formed `hello`. Anything else — a draft, a malformed
 *    blob, silence past `helloDeadlineMs` — closes it. There is no state an
 *    un-helloed socket can reach except "gone".
 *  - fail-closed per adapter (§2.4.2). Unknown id, wrong token, NULL hash,
 *    disabled row: all 4401, all audited, and none of them touches health —
 *    an adapter that never authenticated was never connected, and writing
 *    `connected` for a failed attempt would make the health column a log of
 *    who tried rather than who is here.
 *  - INV-2 at the frame level. There is no send frame in the protocol, so an
 *    adapter that sends one (or replays a gateway→agent frame back at us) is
 *    dropped and audited as `adapter.no-send-frame`, NEVER `gate.denied`
 *    (C-6 taxonomy pin). The socket stays open: a confused adapter is not a
 *    hostile one, and closing would hide the next thing it does.
 *  - §1.8 throughout: `sink.append` precedes `setAdapterHealth`, which
 *    precedes `sink.broadcast`. The log is the record; the event is the
 *    courtesy.
 *
 * Time is injected. `tick()` drives both the hello deadline and the liveness
 * ping, so the tests contain no real sleeps and no wall-clock flakes; the
 * daemon process wires `tick()` to an interval at composition time.
 */
import type { WebSocket } from 'ws';
import type { Actor, Clock, Store } from '@wemessage/core';
import {
  parseAgentFrame,
  WIRE_VERSION,
  type HelloFrame,
} from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';
import type { AgentSubmitHandler } from './submit.js';

/** Close codes (RFC 6455 private range, 4000-4999). */
const CLOSE_PROTOCOL = 4400;
const CLOSE_AUTH = 4401;
const CLOSE_TIMEOUT = 4408;
const CLOSE_VERSION = 4426;

const DEFAULT_HELLO_DEADLINE_MS = 5_000;
/** One missed pong is tolerated; the second consecutive miss closes. */
const MAX_MISSED_PONGS = 2;

export interface AdapterTransportDeps {
  store: Store;
  clock: Clock;
  sink: AuditSink;
  helloDeadlineMs?: number;
  /**
   * s5 Scenario 7. The transport owns the socket and nothing else: it parses,
   * authenticates and routes, then hands the payload to the handler that
   * knows what a draft is. Optional so Scenario 5's transport still stands on
   * its own — without it `draft.submit` remains an unhandled frame, which is
   * exactly what Scenario 5 asserts.
   */
  submit?: AgentSubmitHandler;
}

export interface AdapterTransportHandle {
  /** Take ownership of a freshly upgraded socket. */
  accept(socket: WebSocket): void;
  /** Hello deadlines + liveness pings. Injected clock, no timers here. */
  tick(): void;
  /** Sc 6+: the dispatch side asks whether an adapter is reachable. */
  isConnected(adapterId: string): boolean;
  /** Sc 6+: deliver a gateway→agent frame. False when nobody is listening. */
  sendTo(adapterId: string, frame: unknown): boolean;
  /**
   * Consecutive missed pongs for an adapter's live session, or null when it
   * has none. Exposed so liveness can be asserted deterministically instead
   * of by racing the event loop against the next tick.
   */
  missedPongs(adapterId: string): number | null;
  /** Sockets this transport still owns (shutdown drains against this). */
  openSessions(): number;
  closeAll(): void;
}

interface Session {
  socket: WebSocket;
  openedAtMs: number;
  adapterId: string | null;
  missedPongs: number;
  awaitingPong: boolean;
  finalized: boolean;
}

function agentActor(adapterId: string): Actor {
  return { kind: 'agent', adapterId };
}

/** Pre-auth we have no adapter identity to attribute the row to. */
const TRANSPORT_ACTOR: Actor = { kind: 'system', reason: 'rule-engine' };

export function createAdapterTransport(
  deps: AdapterTransportDeps,
): AdapterTransportHandle {
  const { store, clock, sink } = deps;
  const helloDeadlineMs = deps.helloDeadlineMs ?? DEFAULT_HELLO_DEADLINE_MS;
  const submit = deps.submit;
  const sessions = new Set<Session>();

  const violate = (s: Session, reason: string, close: boolean): void => {
    sink.append(
      {
        type: 'adapter.protocol-violation',
        ...(s.adapterId !== null ? { adapterId: s.adapterId } : {}),
        reason,
      },
      s.adapterId !== null ? agentActor(s.adapterId) : TRANSPORT_ACTOR,
    );
    if (close) s.socket.close(CLOSE_PROTOCOL);
  };

  const authFail = (
    s: Session,
    reason: 'unknown-adapter' | 'bad-token' | 'disabled',
    adapterId: string | null,
  ): void => {
    sink.append(
      {
        type: 'adapter.auth-failed',
        ...(adapterId !== null ? { adapterId } : {}),
        reason,
      },
      TRANSPORT_ACTOR,
    );
    s.socket.close(CLOSE_AUTH);
  };

  /**
   * The single exit for an authenticated session. Idempotent: a revoked
   * socket finalizes at its next frame and again on 'close', and health must
   * not be rewritten by the second one (the first reason is the true one).
   */
  const finalize = (
    s: Session,
    reason: 'closed' | 'revoked' | 'unhealthy',
  ): void => {
    if (s.finalized || s.adapterId === null) return;
    s.finalized = true;
    const adapterId = s.adapterId;
    const status = reason === 'unhealthy' ? 'unhealthy' : 'disconnected';
    sink.append(
      { type: 'adapter.disconnected', adapterId, reason },
      agentActor(adapterId),
    );
    // The row may have been deleted out from under a live socket; health is a
    // courtesy column and must never take the daemon down with it.
    try {
      store.setAdapterHealth(adapterId, status, clock.now());
    } catch {
      /* adapter row gone: the audit row above is the record that matters */
    }
    sink.broadcast({ event: 'adapter.health', adapterId, status });
  };

  const authenticate = (s: Session, frame: HelloFrame): void => {
    const { adapterId, token, wire } = frame.payload;
    if (wire !== WIRE_VERSION) {
      // Version first: a peer that does not speak our wire cannot be told
      // anything else meaningfully, including that its token was wrong.
      s.socket.close(CLOSE_VERSION, JSON.stringify({ expected: WIRE_VERSION }));
      return;
    }
    if (typeof adapterId !== 'string' || typeof token !== 'string') {
      violate(s, 'hello-shape', true);
      return;
    }
    // `getAdapter` hides the reserved 'human' row, so the FK anchor can never
    // be connected to — it has no token by construction and no agent behind
    // it (F-22).
    const known = store.getAdapter(adapterId);
    if (known === null) {
      authFail(s, 'unknown-adapter', null);
      return;
    }
    const matched = store.findAdapterByToken(token, clock.now());
    if (matched === null || matched.id !== adapterId) {
      authFail(s, 'bad-token', adapterId);
      return;
    }
    if (!matched.enabled) {
      authFail(s, 'disabled', adapterId);
      return;
    }
    s.adapterId = adapterId;
    sink.append(
      { type: 'adapter.connected', adapterId },
      agentActor(adapterId),
    );
    store.setAdapterHealth(adapterId, 'connected', clock.now());
    sink.broadcast({
      event: 'adapter.health',
      adapterId,
      status: 'connected',
    });
  };

  /**
   * Re-checked on EVERY frame, not just at hello: `POST /v1/disconnect`
   * revokes tokens on a running daemon, and a socket that authenticated an
   * hour ago must not keep its access because it never reconnected.
   */
  const stillCredentialed = (adapterId: string): boolean => {
    const row = store.getAdapter(adapterId);
    return row !== null && row.enabled && row.hasToken;
  };

  const onMessage = (s: Session, raw: unknown): void => {
    let json: unknown;
    try {
      json = JSON.parse(String(raw));
    } catch {
      violate(s, 'json', s.adapterId === null);
      return;
    }
    const parsed = parseAgentFrame(json);

    if (s.adapterId === null) {
      // Hello-first: pre-auth there is exactly one acceptable frame.
      if (!parsed.ok || parsed.frame.type !== 'hello') {
        violate(s, 'hello-first', true);
        return;
      }
      authenticate(s, parsed.frame);
      return;
    }

    if (!stillCredentialed(s.adapterId)) {
      finalize(s, 'revoked');
      s.socket.close(CLOSE_AUTH);
      return;
    }

    if (!parsed.ok) {
      // A frame that exists but points the wrong way, or a type we do not
      // have at all, is the NO_SEND_FRAME case: evidence, socket stays open.
      const type = (json as { type?: unknown }).type;
      if (
        (parsed.error.kind === 'direction' ||
          parsed.error.kind === 'unknown-type') &&
        typeof type === 'string'
      ) {
        sink.append(
          {
            type: 'adapter.no-send-frame',
            adapterId: s.adapterId,
            frameType: type,
          },
          agentActor(s.adapterId),
        );
        return;
      }
      violate(s, parsed.error.kind, false);
      return;
    }

    switch (parsed.frame.type) {
      case 'pong':
        s.awaitingPong = false;
        s.missedPongs = 0;
        return;
      case 'hello':
        // A second hello would be a re-auth on an already-trusted socket.
        violate(s, 'duplicate-hello', false);
        return;
      case 'draft.submit':
        // s5 Scenario 7. Every refusal inside the handler is audited there,
        // and none of them closes the socket: a confused agent gets to keep
        // talking, and the log is what makes its confusion visible.
        if (submit === undefined) {
          violate(s, `unhandled:${parsed.frame.type}`, false);
          return;
        }
        submit.onSubmit(s.adapterId, parsed.frame.payload);
        return;
      case 'draft.delta':
        if (submit === undefined) {
          violate(s, `unhandled:${parsed.frame.type}`, false);
          return;
        }
        submit.onDelta(s.adapterId, parsed.frame.payload);
        return;
      case 'proactive.propose':
        // s5 Scenario 9. Fire-and-forget: resolving a `{handle}` target is a
        // chat.db read, and a socket callback must not wait on the disk. Every
        // refusal inside the handler audits itself, and none closes the
        // socket — same posture as `draft.submit`.
        if (submit === undefined) {
          violate(s, `unhandled:${parsed.frame.type}`, false);
          return;
        }
        void submit.onProactive(s.adapterId, parsed.frame.payload);
        return;
      default:
        // A well-formed frame with no handler is a protocol violation of OUR
        // making, not the adapter's; recorded so the gap is visible rather
        // than silent.
        violate(s, `unhandled:${parsed.frame.type}`, false);
        return;
    }
  };

  return {
    accept(socket) {
      const session: Session = {
        socket,
        openedAtMs: clock.nowMs(),
        adapterId: null,
        missedPongs: 0,
        awaitingPong: false,
        finalized: false,
      };
      sessions.add(session);
      socket.on('message', (data: unknown) => {
        onMessage(session, data);
      });
      socket.on('close', () => {
        sessions.delete(session);
        finalize(session, 'closed');
      });
      socket.on('error', () => {
        /* the close handler is the single exit */
      });
    },

    tick() {
      for (const s of [...sessions]) {
        if (s.adapterId === null) {
          if (clock.nowMs() - s.openedAtMs >= helloDeadlineMs) {
            violate(s, 'hello-timeout', true);
          }
          continue;
        }
        if (s.awaitingPong) {
          s.missedPongs += 1;
          if (s.missedPongs >= MAX_MISSED_PONGS) {
            finalize(s, 'unhealthy');
            s.socket.close(CLOSE_TIMEOUT);
            continue;
          }
        }
        s.awaitingPong = true;
        s.socket.send(
          JSON.stringify({
            v: WIRE_VERSION,
            id: `ping-${String(clock.nowMs())}`,
            type: 'ping',
            ts: clock.now(),
            payload: {},
          }),
        );
      }
    },

    isConnected(adapterId) {
      for (const s of sessions) if (s.adapterId === adapterId) return true;
      return false;
    },

    sendTo(adapterId, frame) {
      for (const s of sessions) {
        if (s.adapterId === adapterId && s.socket.readyState === 1) {
          s.socket.send(JSON.stringify(frame));
          return true;
        }
      }
      return false;
    },

    missedPongs(adapterId) {
      for (const s of sessions) {
        if (s.adapterId === adapterId) return s.missedPongs;
      }
      return null;
    },

    openSessions() {
      return sessions.size;
    },

    closeAll() {
      for (const s of [...sessions]) s.socket.close();
    },
  };
}

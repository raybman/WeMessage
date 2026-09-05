/**
 * s7 Scenario 3 — `GET /v1/events/sse`, the read-only event transport.
 *
 * WS /v1/events has been the only way to watch the gateway since S1, and it
 * costs a client a WebSocket library, an upgrade handshake and a reconnect
 * strategy. SSE costs `curl -N` and a `for` loop. That is the entire reason
 * this route exists: the events are the same events, and the barrier to
 * watching them should be as close to zero as a shell can get.
 *
 * **This surface is read-only and structurally so (INV-2).** Nothing here
 * imports from core's sending path, and this module is deliberately absent
 * from `PORT_IMPORTER_ALLOWLIST` so the ratchet fails if that ever stops
 * being true. That allowlist is enforced by a TEXTUAL scan of production
 * source, which is why this comment does not spell out the two port names it
 * is talking about: naming them here would put this file on the list, which
 * is a small, funny proof that the guard is real. An event stream is the one
 * place where "it only reads" must be enforced by what the file can reach,
 * not by what the handler happens to do today — approve-before-send is
 * inviolable, and a send path reachable from a subscription is a send path
 * reachable from anything that can open a subscription.
 *
 * **Auth is the header bearer, and only the header bearer (F-84).** The
 * obvious objection is that a browser's `EventSource` cannot set headers, so
 * a browser cannot use this route without a `?token=` escape hatch. We
 * decline the hatch. The operator token is minted once and never
 * re-displayed; putting it in a query string writes it into shell history,
 * proxy access logs, `ps` output and any `Referer` the page later sends. The
 * clients this repo actually has — the CLI and the adapters — set headers
 * without effort, and `curl -H` is not a hardship. If a browser client ever
 * ships, it gets a short-lived scoped grant minted for it, not the operator's
 * credential smuggled through a URL. The refusal is free here: the existing
 * `onRequest` auth hook covers every path but `/v1/health` and `/v1/agent`,
 * so a tokenless SSE request 401s before this handler is ever entered.
 *
 * **Keepalive is an injected timer (C-5), not a bare interval.** An idle
 * stream is indistinguishable from a dead one to every proxy between here
 * and the client, so we emit a `: keepalive` comment on a fixed cadence —
 * a comment, so it is invisible to `EventSource` consumers and cannot be
 * mistaken for an event by anything parsing the wire. Tests hand in a timer
 * they fire by hand; there is no sleeping in the suite and no wall clock in
 * the assertions.
 */
import type { FastifyInstance } from 'fastify';
import type { GatewayEventPayload } from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';
import { parseEventFilter } from '../events-filter.js';

export const SSE_PATH = '/v1/events/sse';

/**
 * §1.7: 15 s. Short enough to beat the default idle timeout of every proxy
 * anyone is likely to put in front of this (nginx and the ELB family both
 * default to 60 s), long enough that an idle stream is not a traffic source.
 */
export const SSE_KEEPALIVE_MS = 15_000;

/**
 * The keepalive seam. Returns its own cancel — the route never reaches for a
 * timer id, so a test double and the production timer are interchangeable.
 */
export type SseTimer = (onTick: () => void, everyMs: number) => () => void;

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  // `no-transform` matters as much as `no-cache`: a proxy that "helpfully"
  // gzips or re-chunks an event stream turns it into a stalled one.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // nginx-family: disable response buffering for this response.
  'x-accel-buffering': 'no',
};

export interface SseRouteDeps {
  /** The ONE §1.8 chokepoint. SSE is a subscriber on it, never a second one. */
  sink: AuditSink;
  /** The `connection.state` frame both transports open with, when wired. */
  greeting?: () => GatewayEventPayload;
  keepaliveMs?: number;
  timer?: SseTimer;
  /** Test observability: the server's shared handler-call counter. */
  onHandled?: () => void;
}

const realTimer: SseTimer = (onTick, everyMs) => {
  const handle = setInterval(onTick, everyMs);
  // A keepalive must never be the reason a process refuses to exit.
  handle.unref();
  return () => {
    clearInterval(handle);
  };
};

export function registerSseRoute(app: FastifyInstance, deps: SseRouteDeps) {
  const timer = deps.timer ?? realTimer;
  const everyMs = deps.keepaliveMs ?? SSE_KEEPALIVE_MS;

  /**
   * Every live stream's teardown. `app.close()` would otherwise wait on
   * sockets that are, by design, never going to end on their own — a daemon
   * that cannot shut down while anyone is watching it is a daemon that
   * cannot be restarted.
   */
  const teardowns = new Set<() => void>();
  app.addHook('onClose', () => {
    for (const teardown of [...teardowns]) teardown();
  });

  app.get(SSE_PATH, (req, reply) => {
    deps.onHandled?.();
    const parsed = parseEventFilter((req.query as { events?: unknown }).events);
    if (!parsed.ok) {
      // C-3: refuse the whole subscription. Serving a stream that silently
      // omits the name the caller misspelled is the failure mode this scenario
      // exists to prevent.
      return reply
        .code(400)
        .send({ error: 'unknown-event', name: parsed.name });
    }

    // Fastify's `exposeHeadRoutes` mints a HEAD twin that runs THIS handler.
    // A HEAD that hijacked and streamed would hang every client that probes
    // the route before using it, so the twin answers with the headers alone
    // and — the part worth a row of its own — never registers a subscriber.
    if (req.method === 'HEAD') {
      return reply.headers(SSE_HEADERS).code(200).send();
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, SSE_HEADERS);

    let closed = false;
    let lastId = 0;
    const write = (chunk: string): void => {
      // Write-after-close is an unhandled EPIPE in production and a flake in
      // tests; the guard is cheaper than either.
      if (closed || res.writableEnded) return;
      res.write(chunk);
    };

    const send = (payload: GatewayEventPayload, frame: string): void => {
      lastId += 1;
      // One `data:` line per line of the payload, per the SSE framing rules.
      // `JSON.stringify` never emits a raw newline, so this is a single line
      // today; it is written this way so a future multi-line payload cannot
      // silently truncate at the first `\n`.
      const data = frame
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\n');
      write(`id: ${String(lastId)}\nevent: ${payload.event}\n${data}\n\n`);
    };

    // The greeting precedes the subscription and ignores the filter: it is
    // the proof that the stream is live, not an event anyone subscribed to,
    // and a filtered stream that opened silently would be indistinguishable
    // from one that failed to open. WS does exactly the same, in the same
    // order, from the same closure.
    const greeting = deps.greeting?.();
    if (greeting !== undefined) send(greeting, JSON.stringify(greeting));

    const unsubscribe = deps.sink.subscribe(send, parsed.filter);
    const cancelKeepalive = timer(() => {
      write(': keepalive\n\n');
    }, everyMs);

    const teardown = (): void => {
      if (closed) return;
      closed = true;
      teardowns.delete(teardown);
      unsubscribe();
      cancelKeepalive();
      res.end();
    };
    teardowns.add(teardown);
    res.on('close', teardown);
    res.on('error', teardown);
    return;
  });
}

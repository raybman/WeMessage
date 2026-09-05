/**
 * s7 Scenario 3 — a test-only Server-Sent Events client.
 *
 * The daemon's other HTTP rows go through `app.inject`, which buffers the
 * whole response before it resolves. That is exactly the wrong shape for a
 * stream that never ends: an SSE row has to observe the FIRST bytes while the
 * connection is still open, and it has to be able to hang up and let the
 * server watch it go. So this speaks real `node:http` against a real listening
 * port (`bootAgent`), and the parser below is a real, if small, SSE parser
 * rather than a `JSON.parse` of whatever arrived.
 *
 * It is deliberately literal about the wire format, because Scenario 3's
 * load-bearing claim is a claim about BYTES:
 *
 *  - a `data:` field's value is the rest of the line with ONE optional leading
 *    space removed (WHATWG's rule, not "trim");
 *  - a multi-line payload is many `data:` lines joined back with `\n`;
 *  - a line starting with `:` is a comment and dispatches nothing (that is
 *    what the keepalive is, and a parser that reported it as an event would
 *    make the keepalive row pass for the wrong reason);
 *  - a blank line dispatches; anything buffered without one has not arrived.
 *
 * `raw` keeps every byte received, so a row can assert on framing itself
 * rather than only on the parser's opinion of it.
 *
 * No readiness is ever a sleep. `waitForEvents`/`waitForComments` resolve off
 * the socket's own data callback; the timeout they carry is a FAILURE path
 * that turns a hung stream into a named error instead of a suite that stops.
 */
import { request, type IncomingHttpHeaders } from 'node:http';

export interface SseEvent {
  /** `id:` field, or null when the frame carried none. */
  id: string | null;
  /** `event:` field, or null (the SSE default is the "message" type). */
  event: string | null;
  /** All `data:` lines, joined with `\n` — the payload the sender meant. */
  data: string;
}

export interface SseStream {
  status: number;
  headers: IncomingHttpHeaders;
  /** Dispatched events, in arrival order. */
  events: SseEvent[];
  /** Raw comment lines including the leading ':' (`: keepalive`). */
  comments: string[];
  /** Every byte received, unparsed. */
  raw: string;
  /** Body of a non-200 response (empty for a live stream). */
  body: string;
  waitForEvents(n: number, label?: string): Promise<void>;
  waitForComments(n: number, label?: string): Promise<void>;
  /** Hang up like a browser tab closing; resolves once the socket is gone. */
  close(): Promise<void>;
}

const DEFAULT_WAIT_MS = 4000;

export interface SseOptions {
  headers?: Record<string, string>;
  /** Failure-path budget for the waiters (never a readiness sleep). */
  waitMs?: number;
}

export function openSse(
  baseUrl: string,
  path: string,
  options: SseOptions = {},
): Promise<SseStream> {
  const url = new URL(path, baseUrl);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  return new Promise<SseStream>((resolve, reject) => {
    const req = request(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { accept: 'text/event-stream', ...(options.headers ?? {}) },
      },
      (res) => {
        const events: SseEvent[] = [];
        const comments: string[] = [];
        const stream: SseStream = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          events,
          comments,
          raw: '',
          body: '',
          waitForEvents: (n, label) =>
            waitFor(
              () => events.length >= n,
              label ?? `${String(n)} sse events`,
            ),
          waitForComments: (n, label) =>
            waitFor(
              () => comments.length >= n,
              label ?? `${String(n)} sse comments`,
            ),
          close: () =>
            new Promise<void>((done) => {
              if (res.destroyed) return done();
              res.on('close', () => done());
              req.destroy();
            }),
        };

        let notify: (() => void) | null = null;
        function waitFor(pred: () => boolean, label: string): Promise<void> {
          if (pred()) return Promise.resolve();
          return new Promise<void>((ok, fail) => {
            const timer = setTimeout(() => {
              notify = null;
              fail(new Error(`sse-client: timed out waiting for ${label}`));
            }, waitMs);
            notify = () => {
              if (!pred()) return;
              clearTimeout(timer);
              notify = null;
              ok();
            };
          });
        }

        // Field accumulator for the event currently being assembled.
        let id: string | null = null;
        let event: string | null = null;
        let data: string[] = [];
        let sawField = false;

        const dispatch = (): void => {
          if (!sawField) return;
          events.push({ id, event, data: data.join('\n') });
          id = null;
          event = null;
          data = [];
          sawField = false;
        };

        const line = (text: string): void => {
          if (text === '') return dispatch();
          if (text.startsWith(':')) {
            comments.push(text);
            return;
          }
          const colon = text.indexOf(':');
          const field = colon === -1 ? text : text.slice(0, colon);
          let value = colon === -1 ? '' : text.slice(colon + 1);
          // WHATWG: strip exactly one leading space, never more.
          if (value.startsWith(' ')) value = value.slice(1);
          sawField = true;
          if (field === 'id') id = value;
          else if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        };

        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          stream.raw += chunk;
          if (stream.status !== 200) {
            stream.body += chunk;
            notify?.();
            return;
          }
          buffer += chunk;
          let cut = buffer.indexOf('\n');
          while (cut !== -1) {
            line(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf('\n');
          }
          notify?.();
        });
        res.on('end', () => notify?.());
        res.on('error', () => notify?.());
        resolve(stream);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export interface HttpProbe {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * A one-shot request that must NOT stream: the HEAD twin and the refusal rows.
 * It fails loudly rather than hanging if the daemon ever answers one of those
 * with an open stream, which is precisely the bug the HEAD row exists for.
 */
export function probeHttp(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    waitMs?: number;
  } = {},
): Promise<HttpProbe> {
  const url = new URL(path, baseUrl);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  return new Promise<HttpProbe>((resolve, reject) => {
    const req = request(
      {
        method: options.method ?? 'GET',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          clearTimeout(budget);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    const budget = setTimeout(() => {
      req.destroy();
      reject(
        new Error(`probeHttp: ${options.method ?? 'GET'} ${path} never ended`),
      );
    }, waitMs);
    req.on('error', (err) => {
      clearTimeout(budget);
      reject(err);
    });
    req.end();
  });
}

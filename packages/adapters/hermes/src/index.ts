/**
 * s7-execution Scenario 8 — `@wemessage/adapter-hermes`, HTTP mode.
 *
 * Scenario 7 shipped the other direction: a plugin that lives inside Hermes
 * and dials the gateway. This is the direction where we do the calling. The
 * adapter holds the gateway socket, and for each `draft.request` it opens one
 * run against Hermes' own HTTP API and turns the resulting event stream into
 * `draft.delta` frames and exactly one `draft.submit`.
 *
 *   gateway ──draft.request──▶ [adapter] ──POST /v1/runs──▶ Hermes
 *   gateway ◀──delta/submit─── [adapter] ◀──GET …/events─── Hermes
 *
 * **`/v1/runs` is Hermes' route, not ours.** Nothing in this file adds a
 * WeMessage route, a frame type or a close code; the wire is exactly what it
 * was before this file existed.
 *
 * Five properties are load-bearing, each pinned by a row of
 * `test/http-mode.spec.ts` against a fake Hermes on a loopback port:
 *
 *  - **There is no send path, and there cannot be one.** Hermes is an agent
 *    that takes actions in its own world; on this wire the only thing it can
 *    produce is a draft for a human to approve (INV-2). That is not a policy
 *    this file enforces with an `if`, it is the shape of the vocabulary:
 *    `AGENT_FRAME_TYPES` is the closed set of types `emit` will put on the
 *    socket, there is exactly one call site that writes to that socket, and
 *    no member of the set reaches `SendBackend`. A Hermes run that emits
 *    send-shaped events, or ends with a completion phrased as an order, still
 *    produces one `draft.submit` and nothing else.
 *  - **The credential is configuration and it fails closed.** The Hermes
 *    bearer is read from `HERMES_API_TOKEN` and the endpoint from
 *    `HERMES_BASE_URL`, both at construction, both by name in the error when
 *    absent. There is no committed default, no argv, and no fallback
 *    hostname: an adapter that ships a default endpoint is an adapter that
 *    dials a stranger, and one that treats `''` as a token sends an empty
 *    `Bearer` and blames the 401 on the far side. The value never appears in
 *    a log line, a frame or a stack.
 *  - **A partial answer is never a draft.** `run.failed`, `run.cancelled`, a
 *    stream that stops without a terminal event, a transport that dies
 *    mid-flight, a run that outruns its own deadline: the accumulated text is
 *    discarded and the gateway is told `declined`. Half an answer shown to a
 *    person as a finished draft is worse than no draft at all, and the
 *    `draft.submit` payload has no `reason` slot, so the cause goes to the
 *    operator log where an operator can act on it.
 *  - **The parser carries.** SSE frames arrive split across reads; a parser
 *    without a carry buffer cuts a token in half and never says so. The line
 *    accumulator below is the whole reason `draft.delta` frames reassemble
 *    into exactly the `draft.submit` body, and it is exported so that
 *    property can be proven without a socket.
 *  - **Thin client, still.** `@wemessage/protocol` is the only import
 *    (`adapters-thin-clients`), and the HTTP client is the platform's own
 *    global `fetch` — no new runtime dependency, no second HTTP stack.
 */
import {
  parseGatewayFrame,
  WIRE_VERSION,
  type Correlation,
  type DraftRequestFrame,
} from '@wemessage/protocol';

/**
 * The closed set of frame types this adapter may put on the gateway socket,
 * mirroring the `AGENT_FRAME_TYPES` frozenset the Sc 7 plugin pins on the
 * Python side. It is a literal rather than a derivation on purpose: widening
 * the adapter's outbound vocabulary should be an edit a reviewer sees, not a
 * side effect of a protocol change. The spec asserts it against the
 * protocol's own derivation, so the two cannot silently disagree.
 *
 * `send` is not here. There is no such frame.
 */
export const AGENT_FRAME_TYPES: readonly string[] = [
  'hello',
  'draft.submit',
  'draft.delta',
  'proactive.propose',
  'pong',
];

/** Where the Hermes bearer comes from. Nowhere else, ever. */
export const HERMES_TOKEN_ENV = 'HERMES_API_TOKEN';
/** Where the Hermes endpoint comes from. No committed default. */
export const HERMES_BASE_URL_ENV = 'HERMES_BASE_URL';
/** Which model the run asks for. Optional; not a secret. */
export const HERMES_MODEL_ENV = 'HERMES_MODEL';

const DEFAULT_MODEL = 'hermes';
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;
/**
 * How much of the request's own deadline the run may spend. The gateway says
 * when it stops waiting; a run aborted AT that instant produces a submit that
 * arrives after it, so the abort happens with a tenth of the budget in hand.
 * This is the only horizon in the file — there is no adapter-local timeout
 * constant, because a second answer to "how long is too long" is a second
 * thing to keep in sync with the wire.
 */
const DEADLINE_HEADROOM = 0.9;

/* ── SSE ───────────────────────────────────────────────────────────────── */

/** One dispatched SSE event: the `data:` lines, joined, nothing more. */
export interface SseEvent {
  data: string;
}

export interface SseParser {
  /** Feed bytes. Returns whichever events completed inside this chunk. */
  push(chunk: string): SseEvent[];
  /** End of stream. An unterminated trailing frame is discarded, not guessed. */
  end(): SseEvent[];
}

/**
 * A line-oriented SSE reader with a carry buffer.
 *
 * The carry is the entire point. A chunk boundary can land anywhere — between
 * two frames, mid-line, mid-key, between the two bytes of a UTF-8 character —
 * and a reader that treats each chunk as a whole either drops the tail or
 * emits two halves of a JSON object. Hermes' own encoder puts the event name
 * *inside* the `data:` payload rather than on an `event:` line, so a torn
 * frame is not a malformed event, it is a silently missing one: the run looks
 * like it ended without ever completing.
 *
 * Comments (`: keepalive`) are not events and produce nothing, which is what
 * keeps a long quiet run from looking like a stream of empty deltas.
 */
export function createSseParser(): SseParser {
  let carry = '';
  let data: string[] = [];

  const dispatch = (out: SseEvent[]): void => {
    if (data.length === 0) return;
    // SSE joins consecutive `data:` lines with a newline before anyone parses
    // the payload, so a JSON body may legally arrive across several of them.
    out.push({ data: data.join('\n') });
    data = [];
  };

  const line = (raw: string, out: SseEvent[]): void => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text === '') {
      dispatch(out);
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== 'data') return;
    const value = colon === -1 ? '' : text.slice(colon + 1);
    data.push(value.startsWith(' ') ? value.slice(1) : value);
  };

  return {
    push(chunk: string): SseEvent[] {
      const out: SseEvent[] = [];
      carry += chunk;
      let nl = carry.indexOf('\n');
      while (nl !== -1) {
        line(carry.slice(0, nl), out);
        carry = carry.slice(nl + 1);
        nl = carry.indexOf('\n');
      }
      return out;
    },
    end(): SseEvent[] {
      // Deliberately empty. A frame without its blank-line terminator is a
      // frame the far side never finished sending, and completing it here
      // would invent an event nobody emitted.
      carry = '';
      data = [];
      return [];
    },
  };
}

/* ── gateway socket ────────────────────────────────────────────────────── */

/** The bit of a socket this adapter actually uses. */
export interface HermesSocket {
  send(data: string): void;
  close(code?: number): void;
}

export interface HermesSocketHandlers {
  onMessage(raw: string): void;
  onClose(code: number): void;
}

export type HermesSocketFactory = (
  url: string,
  handlers: HermesSocketHandlers,
) => Promise<HermesSocket>;

/* ── adapter ───────────────────────────────────────────────────────────── */

/**
 * What the adapter believes about HERMES, not about the gateway. The daemon
 * owns the `adapter.health` gateway event and derives it from the connection
 * it can see; what an adapter can contribute is an honest account of the
 * upstream only it can reach.
 */
export type HermesHealth = 'unknown' | 'connected' | 'unhealthy';

/**
 * Counters an operator (and the spec) can read. Every ignored event and every
 * discarded partial is counted rather than merely dropped: silent tolerance
 * is how a mapping table rots without anyone noticing.
 */
export interface HermesStats {
  /** Events the mapping table has no opinion about. */
  ignored: number;
  /** Runs Hermes reported as failed. */
  failed: number;
  /** Runs Hermes reported as cancelled. */
  cancelled: number;
  /** Streams that ended with no terminal event. */
  truncated: number;
  /** Streams that died mid-flight. */
  streamErrors: number;
  /** Non-2xx answers from Hermes. */
  httpErrors: number;
  /** Runs aborted because the request's deadline came first. */
  timedOut: number;
  /** Completions whose payload disagreed with the streamed preview. */
  reconciled: number;
  /** Runs currently open. Zero at rest, or something is leaking a socket. */
  openStreams: number;
}

export interface HermesHttpAdapterOptions {
  /** Gateway agent socket URL. */
  url: string;
  /** Gateway adapter token (minted by `wemessage adapters add`). */
  token: string;
  ws: HermesSocketFactory;
  adapterId?: string;
  clock?: { now(): string };
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Operator-visible log. Decline reasons surface here. */
  logger?: { error(message: string): void };
  /**
   * Where Hermes configuration is read from. Injected so a test can supply
   * one without mutating the process, and so the resolution has exactly one
   * implementation. Defaults to the process environment.
   */
  env?: Record<string, string | undefined>;
}

export interface HermesHttpAdapter {
  /** Resolves with the process exit code. 0 clean, 1 gave up. */
  run(): Promise<number>;
  stop(): void;
  health(): HermesHealth;
  stats(): HermesStats;
}

/** A request we have asked Hermes about and have not yet answered on. */
interface InFlight {
  correlation: Correlation;
  seq: number;
  buffer: string;
}

/** How a run ended, if it ended. `body: undefined` is a decline. */
interface Settled {
  body: string | undefined;
}

/**
 * Derived, never random — the gateway dedups on the inbound being answered,
 * and Hermes dedups runs on the same string via `Idempotency-Key`. One value
 * on both sides, so a replay is de-duplicated by both or by neither.
 */
function idempotencyKey(correlation: Correlation): string {
  const anchor = correlation.inboundGuid ?? `req:${correlation.requestId}`;
  return `hermes:${anchor}`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read one required setting, or refuse to exist.
 *
 * Failing at construction rather than at the first request is the whole
 * posture: a misconfigured adapter that starts up, dials the gateway and then
 * declines everything looks like a broken agent to the person waiting for a
 * draft. One that refuses to start names the knob and is honestly absent.
 */
function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = (env[name] ?? '').trim();
  if (value === '')
    throw new Error(
      `[hermes] ${name} is not set: the Hermes HTTP adapter will not start. ` +
        `Set ${name} in the adapter environment to enable it.`,
    );
  return value;
}

export function createHermesHttpAdapter(
  opts: HermesHttpAdapterOptions,
): HermesHttpAdapter {
  const env = opts.env ?? process.env;
  // Resolved here, before anything is dialled and before any request exists.
  const bearer = `Bearer ${required(env, HERMES_TOKEN_ENV)}`;
  const baseUrl = required(env, HERMES_BASE_URL_ENV).replace(/\/+$/, '');
  const model = (env[HERMES_MODEL_ENV] ?? '').trim() || DEFAULT_MODEL;

  const adapterId = opts.adapterId ?? 'hermes';
  const clock = opts.clock ?? { now: (): string => new Date().toISOString() };
  const delay =
    opts.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logger = opts.logger ?? {
    error: (m: string): void => {
      console.error(m);
    },
  };

  let counter = 0;
  let socket: HermesSocket | null = null;
  let stopped = false;
  let health: HermesHealth = 'unknown';
  const live = new Set<InFlight>();
  const aborts = new Set<AbortController>();
  const stats: HermesStats = {
    ignored: 0,
    failed: 0,
    cancelled: 0,
    truncated: 0,
    streamErrors: 0,
    httpErrors: 0,
    timedOut: 0,
    reconciled: 0,
    openStreams: 0,
  };

  /**
   * The single chokepoint. Every byte this adapter puts on the gateway wire
   * goes through here, and a type outside the closed set never reaches the
   * socket — which is why "the adapter cannot send" is a property of the
   * code's shape rather than of anyone's discipline (INV-2).
   */
  const emit = (type: string, payload: unknown): void => {
    if (!AGENT_FRAME_TYPES.includes(type)) return;
    if (socket === null) return;
    counter += 1;
    socket.send(
      JSON.stringify({
        v: WIRE_VERSION,
        id: `${adapterId}-${String(counter).padStart(6, '0')}`,
        type,
        ts: clock.now(),
        payload,
      }),
    );
  };

  /**
   * The only place a Hermes run becomes a gateway draft, and it fires at most
   * once per request. `body === undefined` is a decline, and a decline never
   * carries text.
   */
  const finish = (f: InFlight, body: string | undefined): void => {
    if (!live.delete(f)) return;
    emit('draft.submit', {
      correlation: f.correlation,
      idempotencyKey: idempotencyKey(f.correlation),
      ...(body === undefined ? { declined: true } : { body }),
    });
  };

  /**
   * The mapping table, and the whole of it. Returns how the run ended, or
   * `null` if it has not. Anything unrecognised is counted and ignored: a
   * tool call, a reasoning trace, an approval request Hermes wants answered
   * — none of them is a frame we owe anyone, and answering the approval one
   * would be this adapter granting a permission on a human's behalf.
   */
  const onEvent = (f: InFlight, data: string): Settled | null => {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      stats.ignored += 1;
      return null;
    }
    if (!isRecord(json) || typeof json['event'] !== 'string') {
      stats.ignored += 1;
      return null;
    }

    switch (json['event']) {
      case 'message.delta': {
        const delta = json['delta'];
        if (typeof delta !== 'string' || delta === '') return null;
        f.seq += 1;
        f.buffer += delta;
        emit('draft.delta', {
          correlation: f.correlation,
          seq: f.seq,
          textDelta: delta,
        });
        return null;
      }
      case 'run.completed': {
        // The completion payload wins. Hermes redacts and reconciles its own
        // final text, so where the two disagree the terminal one is the
        // authoritative answer — but the disagreement is counted and logged,
        // because a preview that differs from the draft a human approves is
        // something an operator needs to be able to find out about.
        const output = json['output'];
        if (typeof output === 'string' && output !== f.buffer) {
          stats.reconciled += 1;
          logger.error(
            `[hermes] ${f.correlation.requestId}: reconciled — the completion ` +
              'payload differs from the streamed preview; the completion wins',
          );
        }
        const text = typeof output === 'string' ? output : f.buffer;
        return { body: text.trim() === '' ? undefined : text };
      }
      case 'run.failed': {
        stats.failed += 1;
        const reason = json['error'];
        logger.error(
          `[hermes] declined ${f.correlation.requestId}: run.failed ` +
            `(${typeof reason === 'string' ? reason : 'unknown'}); ` +
            'partial answer discarded',
        );
        return { body: undefined };
      }
      case 'run.cancelled': {
        stats.cancelled += 1;
        logger.error(
          `[hermes] declined ${f.correlation.requestId}: run.cancelled; ` +
            'partial answer discarded',
        );
        return { body: undefined };
      }
      default:
        stats.ignored += 1;
        return null;
    }
  };

  /**
   * One run, start to finish: admit it, stream it, and return the text it
   * produced — or `undefined`, which is every unhappy ending there is. This
   * function does not throw and does not emit a submit; the caller owns the
   * single `finish`.
   */
  const streamRun = async (
    f: InFlight,
    input: string,
    budgetMs: number,
  ): Promise<string | undefined> => {
    const controller = new AbortController();
    let deadlineHit = false;
    const timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort();
    }, budgetMs);
    aborts.add(controller);
    stats.openStreams += 1;
    const rid = f.correlation.requestId;

    try {
      const admitted = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST',
        headers: {
          authorization: bearer,
          'content-type': 'application/json',
          // The same string the submit will carry, so Hermes' run dedup and
          // the gateway's draft dedup agree about what a replay is.
          'idempotency-key': idempotencyKey(f.correlation),
        },
        body: JSON.stringify({ model, input }),
        signal: controller.signal,
      });
      if (!admitted.ok) {
        stats.httpErrors += 1;
        health = 'unhealthy';
        // Not retried, deliberately. A credential or an endpoint that is
        // wrong now is wrong on the retry, and a loop against a 401 turns our
        // own misconfiguration into someone else's outage.
        logger.error(
          `[hermes] POST /v1/runs answered ${String(admitted.status)} for ` +
            `${rid}: declined, not retried`,
        );
        return undefined;
      }
      const body: unknown = await admitted.json();
      const runId =
        isRecord(body) && typeof body['run_id'] === 'string'
          ? body['run_id']
          : null;
      if (runId === null) {
        stats.httpErrors += 1;
        health = 'unhealthy';
        logger.error(`[hermes] POST /v1/runs returned no run_id for ${rid}`);
        return undefined;
      }

      const events = await fetch(
        `${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`,
        {
          headers: { authorization: bearer, accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );
      if (!events.ok) {
        stats.httpErrors += 1;
        health = 'unhealthy';
        logger.error(
          `[hermes] the event stream for ${rid} answered ` +
            `${String(events.status)}: declined`,
        );
        return undefined;
      }
      const stream = events.body;
      if (stream === null) {
        stats.streamErrors += 1;
        health = 'unhealthy';
        logger.error(`[hermes] the event stream for ${rid} had no body`);
        return undefined;
      }
      health = 'connected';

      // Annotated, not inferred: the platform types `Response.body` as a
      // stream of `any`, and an `any` flowing into the decoder would make the
      // one place bytes become text the one place with no type at all.
      const reader: ReadableStreamDefaultReader<Uint8Array> =
        stream.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      let settled: Settled | null = null;
      try {
        while (settled === null) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const event of parser.push(
            decoder.decode(chunk.value, { stream: true }),
          )) {
            settled = onEvent(f, event.data);
            if (settled !== null) break;
          }
        }
      } finally {
        parser.end();
        try {
          await reader.cancel();
        } catch {
          // The stream is already gone; there is nothing to release.
        }
      }

      if (settled === null) {
        // EOF with no terminal event. Not "assume it finished": an unknown
        // outcome is a decline, because the alternative promotes truncation
        // to a finished draft.
        stats.truncated += 1;
        logger.error(
          `[hermes] the stream for ${rid} ended with no terminal event: ` +
            'partial answer discarded',
        );
        return undefined;
      }
      return settled.body;
    } catch (err) {
      if (deadlineHit) {
        stats.timedOut += 1;
        logger.error(
          `[hermes] ${rid} outran its deadline (${String(budgetMs)}ms): the ` +
            'run was aborted and the partial answer discarded',
        );
      } else {
        stats.streamErrors += 1;
        health = 'unhealthy';
        logger.error(
          `[hermes] transport failure for ${rid}: ${describe(err)}; ` +
            'partial answer discarded',
        );
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      aborts.delete(controller);
      stats.openStreams -= 1;
    }
  };

  const ask = (frame: DraftRequestFrame): void => {
    const { correlation, message, constraints } = frame.payload;
    const f: InFlight = { correlation, seq: 0, buffer: '' };
    live.add(f);

    const text = message.content.text;
    if (text === null || text.trim() === '') {
      // Nothing to ask about. Decline at the boundary rather than opening a
      // run against an empty prompt.
      finish(f, undefined);
      return;
    }

    const budget = Math.max(
      1,
      Math.round(constraints.deadlineMs * DEADLINE_HEADROOM),
    );
    // The untrusted inbound text goes into `input` verbatim. Hermes owns its
    // own system prompt; blending instructions of ours into a field that
    // carries a stranger's words is the injection surface, not a mitigation.
    void streamRun(f, text, budget).then(
      (body) => {
        finish(f, body);
      },
      () => {
        finish(f, undefined);
      },
    );
  };

  const onGatewayMessage = (raw: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // Malformed bytes from the gateway are the gateway's problem. Throwing
      // here would take a healthy adapter down over one bad frame.
      return;
    }
    const parsed = parseGatewayFrame(json);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.type === 'ping') {
      emit('pong', {});
      return;
    }
    if (frame.type === 'draft.request') ask(frame);
    // `draft.feedback` and `event` are informational. There is no frame we
    // owe in reply, and inventing one would be a frame nobody asked for.
  };

  const connectOnce = (): Promise<number> =>
    new Promise<number>((resolve) => {
      void opts
        .ws(opts.url, {
          onMessage: onGatewayMessage,
          onClose: (code: number) => {
            socket = null;
            // A gateway drop mid-run discards every partial answer: there is
            // nowhere to submit them and no one waiting for them.
            for (const f of [...live]) {
              live.delete(f);
              logger.error(
                `[hermes] gateway socket closed (${String(code)}) mid-run for ` +
                  `${f.correlation.requestId}: partial answer discarded`,
              );
            }
            resolve(code);
          },
        })
        .then((s) => {
          socket = s;
          if (stopped) {
            s.close();
            return;
          }
          emit('hello', {
            adapterId,
            token: opts.token,
            wire: WIRE_VERSION,
            // Streaming only. This adapter answers what it is asked and
            // never originates, so claiming `proactive` would be a claim the
            // conformance kit is entitled to probe and we would not honour.
            features: ['streaming'],
          });
        });
    });

  return {
    async run(): Promise<number> {
      let exit = 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const code = await connectOnce();
        if (stopped) {
          exit = 0;
          break;
        }
        if (attempt < maxAttempts) await delay(BACKOFF_MS * attempt);
        // Fail closed rather than hammering a gateway that has refused us.
        else exit = code === 1000 ? 0 : 1;
      }
      stopped = true;
      for (const controller of [...aborts]) controller.abort();
      return exit;
    },
    stop(): void {
      stopped = true;
      // Aborted, not abandoned: an un-aborted run holds a socket open for as
      // long as Hermes feels like holding it.
      for (const controller of [...aborts]) controller.abort();
      socket?.close();
    },
    health: (): HermesHealth => health,
    stats: (): HermesStats => ({ ...stats }),
  };
}

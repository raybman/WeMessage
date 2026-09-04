/**
 * s5-execution Scenario 12 — `@wemessage/adapter-sol`.
 *
 * The first third-party agent behind the gateway's adapter seam, and the
 * proof that the seam costs the agent nothing. **Zero Sol changes.** Not one
 * line of `~/sol-agent` moves for this adapter to work: it speaks Sol's
 * pre-existing external WS seam — RD §4's `{type:"message"}` frame into
 * `GatewayManager.handle`, gated by `WS_SECRET` — and translates in both
 * directions. Sol does not learn that iMessage exists. It receives a message
 * and answers it, exactly as it does for Discord or the desktop client.
 *
 * The adapter is a bridge with two sockets and no opinions:
 *
 *   gateway ──draft.request──▶ [sol adapter] ──{type:"message"}──▶ Sol
 *   gateway ◀──delta/submit── [sol adapter] ◀──token/done/error── Sol
 *
 * Four properties are load-bearing, and each is pinned by a row of
 * `sol-adapter.contract.spec.ts` against an in-process mock Sol:
 *
 *  - **`authenticatedOwner` is never ours to set.** Sol's own invariant
 *    (lib/gateway/types.ts) says the field may be set ONLY by a transport
 *    that verified an owner credential for THAT connection, and never read
 *    off a client frame. We are a client frame. So it does not appear in
 *    `SOL_INCOMING_MESSAGE_FIELDS`, it is not constructed anywhere below, and
 *    the spec asserts key-absence on every byte the mock receives for the
 *    whole session (INV-4). A gateway that could grant itself owner authority
 *    by asserting it in JSON would have no authority model at all.
 *  - **Fail closed on a missing secret, without bricking anything.** No
 *    `WS_SECRET` means the adapter refuses to start, says so by name on the
 *    operator log, and exits non-zero — it never dials Sol unauthenticated,
 *    and never dials the gateway either, because an adapter that connects and
 *    then cannot answer is worse than one that is honestly absent. This
 *    mirrors Sol's own posture (`ws-server.ts` 503s every request when the
 *    secret is unset).
 *  - **No send frame exists.** Sol's `sendMessage` — the MCP proactive tool —
 *    becomes `proactive.propose`, a *request* for a human to approve, never a
 *    send. Sol's `sendReply` becomes `draft.submit`, likewise. There is no
 *    code path in this file that can put a message in front of a person
 *    without an approval (INV-2).
 *  - **An interrupted stream produces no draft.** If Sol's socket drops
 *    mid-answer, the accumulated partial text is discarded, not submitted.
 *    Half an answer shown to a human as a finished draft is a worse failure
 *    than no answer.
 *
 * ── Sol seam drift, observed 2026-09-03 (recorded, NOT fixed) ──────────────
 *
 * The roadmap flags this seam as S5 risk #1, and the tripwire fired. RD §4
 * described the WS seam as carrying an `IncomingMessage`. On the live tree,
 * `lib/ws-server.ts` (RD §4 cites it without a path; it is at `lib/`, not
 * `lib/gateway/`) instead HARDCODES the identity for every WS message:
 *
 *     userId: "ws-desktop", userName: "Desktop", channelId: "ws-desktop",
 *     authenticatedOwner: ws.data.authedOwner === true
 *
 * Three consequences, stated plainly:
 *
 *   1. Sol's WS seam currently ignores per-conversation identity. Our
 *      namespaced `imessage:{handle}` / `chatGuid` travel on the frame and are
 *      dropped on Sol's side today, so every iMessage conversation would share
 *      the `ws-desktop` session key.
 *   2. `authenticatedOwner` is set by Sol from the *connection*, which is
 *      exactly right and exactly why we must never send it. The drift does not
 *      weaken that invariant; it strengthens the case for our key-absence
 *      assertion.
 *   3. `sendReply` and `sendMessage` both collapse into `{type:"token"}` on
 *      the live WS transport, so the two are indistinguishable on that wire.
 *      We keep them distinct (`reply` / `proactive`) because the gateway
 *      treats them as different objects — a draft versus a proposal — and
 *      collapsing them here would launder a proactive message into a reply.
 *
 * **No fix lands in Sol.** That is the whole premise of this adapter, and
 * chasing the drift upstream would trade a zero-change integration for a fork.
 * It is recorded here, pinned by row 6 of the contract spec, and left for a
 * future scenario to absorb adapter-side (a per-conversation session id, or
 * the HTTP seam) if and when Sol's identity handling changes.
 *
 * Dependency posture: `@wemessage/protocol` and nothing else
 * (`adapters-thin-clients`). Zero LLM dependencies — Sol owns the model, we
 * own the wire. Both sockets, the clock and the backoff are injected, so the
 * spec opens no sockets and sleeps not at all.
 */
import {
  parseGatewayFrame,
  WIRE_VERSION,
  type Correlation,
  type DraftRequestFrame,
} from '@wemessage/protocol';

/**
 * Every top-level key we are permitted to put on a Sol client frame, and
 * every key we are permitted to put inside its `IncomingMessage`. RD §4 is
 * the source; row 6 of the contract spec is the tripwire. These are pinned
 * literals rather than derivations so that widening our Sol-facing surface is
 * a deliberate, reviewable edit and not a side effect of a refactor.
 *
 * `authenticatedOwner` is absent by design and must stay absent. See the
 * header.
 */
export const SOL_CLIENT_FRAME_FIELDS = [
  'type',
  'sessionId',
  'message',
] as const;

export const SOL_INCOMING_MESSAGE_FIELDS = [
  'userId',
  'userName',
  'channelId',
  'text',
] as const;

/** The bit of a socket this adapter actually uses. */
export interface SolSocket {
  send(data: string): void;
  close(code?: number): void;
}

/** Callbacks the factory wires up before it resolves. */
export interface SolSocketHandlers {
  onMessage(raw: string): void;
  onClose(code: number): void;
}

export type SolSocketFactory = (
  url: string,
  handlers: SolSocketHandlers,
) => Promise<SolSocket>;

export interface SolAdapterOptions {
  /** Gateway agent socket URL. */
  url: string;
  /** Gateway adapter token (minted by `wemessage adapters add`). */
  token: string;
  ws: SolSocketFactory;
  /** Sol's WS seam. */
  solUrl: string;
  solWs: SolSocketFactory;
  /**
   * Sol's `WS_SECRET`. Injected, never read from `process.env` here: the
   * caller owns secret resolution, and a library that reaches for the
   * environment cannot be tested without one.
   */
  wsSecret: string | undefined;
  adapterId?: string;
  clock?: { now(): string };
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Operator-visible log. The decline reason surfaces here (see below). */
  logger?: { error(message: string): void };
}

export interface SolAdapter {
  /** Resolves with the process exit code. 0 clean, 2 misconfigured, 1 gave up. */
  run(): Promise<number>;
  stop(): void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;
/** Non-zero and distinct from "gave up": this one is the operator's to fix. */
const EXIT_MISCONFIGURED = 2;

/** A request we have asked Sol about and have not yet answered the gateway on. */
interface InFlight {
  correlation: Correlation;
  seq: number;
  buffer: string;
}

/**
 * Derived, never random — the gateway dedups on the inbound being answered,
 * so a restart-style replay must produce the same key. `requestId` is the
 * fallback for a redraft, which carries no inbound.
 */
function idempotencyKey(correlation: Correlation): string {
  const anchor = correlation.inboundGuid ?? `req:${correlation.requestId}`;
  return `sol:${anchor}`;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function createSolAdapter(opts: SolAdapterOptions): SolAdapter {
  const adapterId = opts.adapterId ?? 'sol';
  const clock = opts.clock ?? { now: (): string => new Date().toISOString() };
  const delay =
    opts.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const logger = opts.logger ?? {
    error: (m: string): void => console.error(m),
  };

  let counter = 0;
  let proactiveCounter = 0;
  let gwSocket: SolSocket | null = null;
  let solSocket: SolSocket | null = null;
  let sessionId: string | null = null;
  let inflight: InFlight | null = null;
  let stopped = false;
  let solGaveUp = false;

  // ── gateway side ─────────────────────────────────────────────────────────

  const emit = (type: string, payload: unknown): void => {
    counter += 1;
    gwSocket?.send(
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
   * The only place a Sol answer becomes a gateway draft. `body === undefined`
   * is a decline, and a decline never carries text: a partial answer shown to
   * a human as a finished draft is worse than no draft at all.
   */
  const finish = (f: InFlight, body: string | undefined): void => {
    inflight = null;
    emit('draft.submit', {
      correlation: f.correlation,
      idempotencyKey: idempotencyKey(f.correlation),
      ...(body === undefined ? { declined: true } : { body }),
    });
  };

  // ── Sol side ─────────────────────────────────────────────────────────────

  /**
   * The URL carries the secret as Sol's `?token=` query parameter, which is
   * what its upgrade handler checks. The secret never crosses onto the
   * gateway wire — that socket has its own, unrelated adapter token.
   */
  const solEndpoint = (): string => {
    const secret = (opts.wsSecret ?? '').trim();
    const sep = opts.solUrl.includes('?') ? '&' : '?';
    return `${opts.solUrl}${sep}token=${encodeURIComponent(secret)}`;
  };

  const askSol = (frame: DraftRequestFrame): void => {
    const { correlation, message } = frame.payload;
    const text = message.content.text;
    if (text === null || text.trim() === '') {
      // Nothing to ask about. Decline at the boundary rather than making Sol
      // answer an empty prompt.
      finish({ correlation, seq: 0, buffer: '' }, undefined);
      return;
    }
    inflight = { correlation, seq: 0, buffer: '' };
    // Object literal with fixed keys — never a spread of wire data, which is
    // the property that keeps `authenticatedOwner` structurally unreachable.
    solSocket?.send(
      JSON.stringify({
        type: 'message',
        sessionId,
        message: {
          // Namespaced, per RD §4's contract: `imessage:{handle}` cannot
          // collide with a Discord or Telegram principal.
          userId: `imessage:${message.handle}`,
          userName: message.handle,
          channelId: message.chatGuid,
          text,
        },
      }),
    );
  };

  const onSolMessage = (raw: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // Malformed bytes from Sol are Sol's problem. Crashing here would take a
      // healthy adapter down over one bad frame.
      return;
    }
    if (!isRecord(json) || typeof json['type'] !== 'string') return;

    switch (json['type']) {
      case 'sessionCreated': {
        // `createStream().init()` — a stream exists; nothing is owed to the
        // gateway yet, so nothing goes on the wire.
        const sid = json['sessionId'];
        if (typeof sid === 'string') sessionId = sid;
        return;
      }
      case 'token': {
        // `updateText` — one delta out, seq monotonic within the request.
        const text = json['text'];
        if (inflight === null || typeof text !== 'string') return;
        inflight.seq += 1;
        inflight.buffer += text;
        emit('draft.delta', {
          correlation: inflight.correlation,
          seq: inflight.seq,
          textDelta: text,
        });
        return;
      }
      case 'done': {
        // `finalize` — the accumulated text becomes exactly one draft.
        if (inflight === null) return;
        const body = inflight.buffer;
        finish(inflight, body.trim() === '' ? undefined : body);
        return;
      }
      case 'error': {
        // `error` — declined, and the partial buffer dies with it. The reason
        // goes to the operator log because `draft.submit`'s payload is a
        // closed set with no `reason` slot (FRAME_SPECS); inventing one would
        // make the gateway's own guard reject the frame.
        if (inflight === null) return;
        const message =
          typeof json['message'] === 'string' ? json['message'] : 'unknown';
        logger.error(
          `[sol] declined ${inflight.correlation.requestId}: ${message}`,
        );
        finish(inflight, undefined);
        return;
      }
      case 'reply': {
        // `sendReply` — a reply to the person we are already talking to. It is
        // still a draft: Sol cannot send, only offer.
        const text = json['text'];
        if (inflight === null || typeof text !== 'string') return;
        finish(inflight, text);
        return;
      }
      case 'proactive': {
        // `sendMessage` — the MCP proactive tool. A proposal, never a send,
        // and it is deliberately NOT collapsed into the reply path.
        const text = json['text'];
        const channelId = json['channelId'];
        if (typeof text !== 'string' || typeof channelId !== 'string') return;
        proactiveCounter += 1;
        emit('proactive.propose', {
          idempotencyKey: `sol:proactive:${channelId}:${String(proactiveCounter)}`,
          target: { chatGuid: channelId },
          body: text,
          reason: `Sol sendMessage to ${channelId}`,
        });
        return;
      }
      default:
        // Anything else on Sol's wire — dashboard frames, a future frame type,
        // a hostile `{type:"send"}` — is not ours to act on. Silence is the
        // correct response: there is no frame we owe them.
        return;
    }
  };

  const connectSolOnce = (): Promise<number> =>
    new Promise<number>((resolve) => {
      void opts
        .solWs(solEndpoint(), {
          onMessage: onSolMessage,
          onClose: (code: number) => {
            solSocket = null;
            // A drop mid-stream discards the partial answer. No draft.
            if (inflight !== null) {
              logger.error(
                `[sol] socket closed (${String(code)}) mid-stream for ` +
                  `${inflight.correlation.requestId}: partial answer discarded`,
              );
              inflight = null;
            }
            resolve(code);
          },
        })
        .then((s) => {
          solSocket = s;
          if (stopped) s.close();
        });
    });

  /** Reconnect loop with injected backoff and a fail-closed ceiling. */
  const runSol = async (): Promise<void> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await connectSolOnce();
      if (stopped) return;
      if (attempt < maxAttempts) {
        await delay(BACKOFF_MS * attempt);
      } else {
        // Loudly, rather than hammering Sol forever.
        solGaveUp = true;
        logger.error(
          `[sol] gave up reconnecting to Sol after ${String(maxAttempts)} attempts`,
        );
        gwSocket?.close();
        return;
      }
    }
  };

  const onGatewayMessage = (raw: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = parseGatewayFrame(json);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.type === 'ping') {
      emit('pong', {});
      return;
    }
    if (frame.type === 'draft.request') askSol(frame);
    // `draft.feedback` and `event` are informational: Sol has no callback for
    // them, and answering would be a frame we owe nobody.
  };

  const connectGatewayOnce = (): Promise<number> =>
    new Promise<number>((resolve) => {
      void opts
        .ws(opts.url, {
          onMessage: onGatewayMessage,
          onClose: (code: number) => {
            gwSocket = null;
            resolve(code);
          },
        })
        .then((s) => {
          gwSocket = s;
          if (stopped) {
            s.close();
            return;
          }
          emit('hello', {
            adapterId,
            token: opts.token,
            wire: WIRE_VERSION,
            features: ['streaming', 'proactive'],
          });
        });
    });

  return {
    async run(): Promise<number> {
      const secret = (opts.wsSecret ?? '').trim();
      if (secret === '') {
        // Fail closed, and say which knob. Mirrors Sol's own 503 posture: an
        // adapter that connects and cannot answer is worse than one that is
        // honestly absent. Nothing else in the gateway is affected.
        logger.error(
          '[sol] WS_SECRET is not set: the Sol adapter is disabled and will ' +
            'not connect. Set WS_SECRET in the adapter environment to enable it.',
        );
        return EXIT_MISCONFIGURED;
      }

      const sol = runSol();

      let exit = 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const code = await connectGatewayOnce();
        if (stopped) {
          exit = 0;
          break;
        }
        if (solGaveUp) break;
        if (attempt < maxAttempts) await delay(BACKOFF_MS * attempt);
        else exit = code === 1000 ? 0 : 1;
      }
      stopped = true;
      solSocket?.close();
      await sol;
      return exit;
    },
    stop(): void {
      stopped = true;
      solSocket?.close();
      gwSocket?.close();
    },
  };
}

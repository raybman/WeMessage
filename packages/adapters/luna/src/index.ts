/**
 * s7-execution Scenario 9 — `@wemessage/adapter-luna`.
 *
 * Luna behind the gateway's adapter seam, built to the Gen-2 `ChannelAdapter`
 * contract transcribed in `contract.ts`. It passes the same six conformance
 * checks echo, sol and both Hermes modes pass, and it has never been run
 * against a real Luna. `verification.ts` carries that admission as a value
 * and the README prints it in paragraph one. Read `LUNA_VERIFICATION` before
 * you deploy this.
 *
 * What the adapter actually is: a translator between two shapes that were
 * designed independently and happen to fit.
 *
 *   gateway  --draft.request-->  host.receive(inbound)
 *   gateway  <--draft.submit--   channel.deliver(completion)
 *
 * Four properties are load-bearing, and each is a row in
 * `test/luna.spec.ts`:
 *
 *  - **Fail-SOFT on a missing credential.** With no token, `start()` resolves,
 *    the state is `disabled`, and the socket factory is never called. This is
 *    the exact opposite of `@wemessage/adapter-sol`, whose constructor throws,
 *    and the difference is not a style preference: sol is a process, and a
 *    process that cannot authenticate should die loudly. A Luna channel is one
 *    of several inside somebody else's boot sequence, and a throw there takes
 *    down every other channel with it. The digest is explicit — a missing
 *    token disables that channel only. So the fail-closed instinct that is
 *    right everywhere else in this repo is wrong here, and the test row says
 *    so in its name.
 *  - **`deliver()` cannot originate.** It answers an OPEN `draft.request` for
 *    that chat, and rejects with `no-open-request` when there is none, having
 *    put nothing on the wire. This is INV-2 as reachability rather than as
 *    policy: Luna has no way to start a conversation because there is no
 *    frame that would carry one, and the single `emit` chokepoint below drops
 *    anything outside `AGENT_FRAME_TYPES` before it can try.
 *  - **No streaming declared, none emitted.** Luna's output is
 *    completion-shaped (plan §3.6.3), so `hello` declares no optional
 *    features, and check 4 therefore never probes for a `draft.delta` we
 *    would not send. Declaring a feature we do not have is a lie the kit is
 *    entitled to catch.
 *  - **`start()` is idempotent.** The digest lists a `startAdapters()`
 *    double-start bug among the things not to trigger. Calling `start()`
 *    twice here dials once: the connect loop is memoised, so a host that
 *    starts its channels twice gets one socket rather than two adapters
 *    fighting over one adapter id.
 *
 * Dependency posture matches echo and sol: `@wemessage/protocol` and nothing
 * else. The socket factory, the clock and the backoff are injected, so this
 * file opens no port, reads no environment and shells out to nothing — which
 * is also why it structurally cannot go looking for a Luna to talk to.
 */
import {
  parseGatewayFrame,
  WIRE_VERSION,
  type Correlation,
  type DraftRequestFrame,
} from '@wemessage/protocol';
import {
  type LunaChannelAdapterContract,
  type LunaChannelHost,
  type LunaChannelState,
  type LunaOutboundMessage,
  type LunaTransportKind,
} from './contract.js';

export {
  LUNA_ASSUMPTION_HEADING,
  LUNA_CONTRACT_CLAIMS,
  type AssumedClaim,
  type LunaChannelAdapterContract,
  type LunaChannelHost,
  type LunaChannelState,
  type LunaContractClaim,
  type LunaInboundMessage,
  type LunaOutboundMessage,
  type LunaTransportKind,
  type TranscribedClaim,
} from './contract.js';
export {
  liveVerificationOffenders,
  verificationBanner,
  LIVE_EVIDENCE_MARKER,
  LUNA_VERIFICATION,
  type AdapterVerification,
  type ConformanceOnly,
  type EvidenceProbe,
  type LiveVerified,
  type VerificationTier,
} from './verification.js';

/** The bit of a socket this adapter actually uses. */
export interface LunaSocket {
  send(data: string): void;
  close(code?: number): void;
}

/** Callbacks the factory wires up before it resolves. */
export interface LunaSocketHandlers {
  onMessage(raw: string): void;
  onClose(code: number): void;
}

export type LunaSocketFactory = (
  url: string,
  handlers: LunaSocketHandlers,
) => Promise<LunaSocket>;

export interface LunaAdapterOptions {
  url: string;
  /**
   * Absent or empty disables the channel. Deliberately optional: this is the
   * one place in the repo where a missing credential is not an error, and the
   * type says so rather than a comment saying so.
   */
  token?: string | undefined;
  ws: LunaSocketFactory;
  /** The Luna side of the seam. Injected; never imported (see `contract.ts`). */
  host: LunaChannelHost;
  adapterId?: string;
  clock?: { now(): string };
  delay?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export interface LunaChannelAdapter extends LunaChannelAdapterContract {
  /** Resolves with the process exit code: 0 on a clean stop, 1 on give-up. */
  run(): Promise<number>;
  state(): LunaChannelState;
}

/**
 * The complete set of frame types an agent may put on this wire, derived from
 * the protocol's own direction table and re-stated here because the `emit`
 * chokepoint below is the last thing between this adapter and the socket.
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

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;
const TRANSPORT: LunaTransportKind = 'websocket';

/**
 * Derived, never random — the same rule echo and Hermes follow. A daemon
 * restart that re-delivers the same inbound must dedup at the gateway rather
 * than put a second draft in front of a human.
 */
function idempotencyKey(correlation: Correlation): string {
  const anchor = correlation.inboundGuid ?? `req:${correlation.requestId}`;
  return `luna:${anchor}`;
}

export function createLunaChannelAdapter(
  opts: LunaAdapterOptions,
): LunaChannelAdapter {
  const adapterId = opts.adapterId ?? 'luna';
  const clock = opts.clock ?? { now: (): string => new Date().toISOString() };
  const delay =
    opts.delay ??
    ((ms: number): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  // The credential decision is made once, here, and never re-read: a channel
  // that is disabled at boot stays disabled until someone restarts it with a
  // token, which is what an operator expects and what a half-enabled channel
  // would not deliver.
  const enabled = (opts.token ?? '') !== '';

  let counter = 0;
  let socket: LunaSocket | null = null;
  let stopped = false;
  let phase: LunaChannelState = enabled ? 'idle' : 'disabled';
  let loop: Promise<number> | null = null;
  /** Open `draft.request`s, oldest first, keyed by the chat they belong to. */
  const open = new Map<string, DraftRequestFrame[]>();

  let signalOpen: () => void = () => undefined;
  const firstOpen = new Promise<void>((resolve) => {
    signalOpen = resolve;
  });

  /**
   * The only place a byte reaches the socket. A type outside the agent→gateway
   * vocabulary is dropped here rather than sent and refused: the daemon would
   * audit it as `adapter.no-send-frame` (C-6), and an adapter that has to be
   * told by the far side is an adapter with a bug on this side.
   */
  const emit = (type: string, payload: unknown): void => {
    if (!AGENT_FRAME_TYPES.includes(type)) return;
    counter += 1;
    socket?.send(
      JSON.stringify({
        v: WIRE_VERSION,
        id: `${adapterId}-${String(counter).padStart(6, '0')}`,
        type,
        ts: clock.now(),
        payload,
      }),
    );
  };

  /** Take the OLDEST open request for a chat, or `undefined` if there is none. */
  const take = (chatGuid: string): DraftRequestFrame | undefined => {
    const queue = open.get(chatGuid);
    if (queue === undefined || queue.length === 0) return undefined;
    const frame = queue.shift();
    if (queue.length === 0) open.delete(chatGuid);
    return frame;
  };

  /** Take one SPECIFIC request off the queue. True if it was still open. */
  const drop = (frame: DraftRequestFrame): boolean => {
    const chatGuid = frame.payload.correlation.chatGuid;
    const queue = open.get(chatGuid);
    if (queue === undefined) return false;
    const at = queue.indexOf(frame);
    if (at < 0) return false;
    queue.splice(at, 1);
    if (queue.length === 0) open.delete(chatGuid);
    return true;
  };

  /** The one `draft.submit` a request is entitled to. `undefined` declines. */
  const finish = (frame: DraftRequestFrame, body: string | undefined): void => {
    const { correlation } = frame.payload;
    const base = { correlation, idempotencyKey: idempotencyKey(correlation) };
    // A decline is a decline: no body key at all. An empty string would show
    // a human a draft that says nothing.
    emit(
      'draft.submit',
      body === undefined ? { ...base, declined: true } : { ...base, body },
    );
  };

  const answer = async (frame: DraftRequestFrame): Promise<void> => {
    const { correlation, message } = frame.payload;
    const text = message.content.text;
    if (text === null || text.trim() === '') {
      // Nothing to answer, so Luna is never asked. Handing a host an empty
      // prompt invites it to invent something, and the invention would land
      // in a human's approval queue.
      drop(frame);
      finish(frame, undefined);
      return;
    }
    try {
      await opts.host.receive({
        chatGuid: correlation.chatGuid,
        handle: message.handle,
        text,
        inboundGuid: correlation.inboundGuid,
        service: message.service,
        channel: { deliver },
      });
    } catch {
      // A host that throws is a host that did not answer. The gateway is
      // still owed exactly one submit, and the deadline does not care why.
    }
    // Still open means the host never called `deliver`. Decline rather than
    // let the request rot: an unanswered `draft.request` is a check-2 failure
    // and, on a real daemon, a draft that never appears.
    if (drop(frame)) finish(frame, undefined);
  };

  async function deliver(msg: LunaOutboundMessage): Promise<void> {
    if (!enabled) throw new Error('channel-disabled');
    const frame = take(msg.chatGuid);
    // INV-2, as reachability. There is no frame that opens a conversation, so
    // an unsolicited completion has nowhere to go and is refused before any
    // byte is written. `no-open-request` is the whole of the send story.
    if (frame === undefined) throw new Error('no-open-request');
    const text = typeof msg.text === 'string' ? msg.text : '';
    finish(frame, text.trim() === '' ? undefined : text);
    return Promise.resolve();
  }

  const onMessage = (raw: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      // A malformed frame is the far side's problem. Crashing here would take
      // a healthy channel down over one bad byte, and in Luna's process that
      // is somebody else's boot sequence.
      return;
    }
    const parsed = parseGatewayFrame(json);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.type === 'ping') {
      emit('pong', {});
      return;
    }
    if (frame.type !== 'draft.request') return;
    const chat = frame.payload.correlation.chatGuid;
    open.set(chat, [...(open.get(chat) ?? []), frame]);
    void answer(frame);
  };

  const connectOnce = (): Promise<number> =>
    new Promise<number>((resolve) => {
      phase = 'starting';
      void opts
        .ws(opts.url, {
          onMessage,
          onClose: (code: number) => {
            socket = null;
            open.clear();
            phase = stopped ? 'stopped' : 'idle';
            resolve(code);
          },
        })
        .then((s) => {
          socket = s;
          if (stopped) {
            s.close();
            return;
          }
          phase = 'connected';
          emit('hello', {
            adapterId,
            token: opts.token ?? '',
            wire: WIRE_VERSION,
            // Empty and honest. Luna hands back a finished completion, so
            // there is nothing to stream and nothing to propose.
            features: [],
          });
          signalOpen();
        })
        .catch(() => {
          phase = stopped ? 'stopped' : 'idle';
          resolve(1006);
        });
    });

  const runLoop = async (): Promise<number> => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const code = await connectOnce();
      if (stopped) return 0;
      // The ceiling is the point: a channel the gateway has refused must give
      // up rather than hammer it forever.
      if (attempt < maxAttempts) await delay(BACKOFF_MS * attempt);
      else return code === 1000 ? 0 : 1;
    }
    return 1;
  };

  const ensureLoop = (): Promise<number> => {
    if (!enabled) return Promise.resolve(0);
    loop ??= runLoop();
    return loop;
  };

  return {
    transport: TRANSPORT,
    async start(): Promise<void> {
      // Fail-SOFT. No token means this channel is off and its host's boot
      // continues; it does not mean an exception three frames up somebody
      // else's stack.
      if (!enabled) {
        phase = 'disabled';
        return;
      }
      // Idempotent: `loop` is memoised, so the second call rides the first
      // connection rather than opening a second one.
      void ensureLoop();
      await Promise.race([firstOpen, ensureLoop().then(() => undefined)]);
    },
    run: ensureLoop,
    deliver,
    async stop(): Promise<void> {
      stopped = true;
      phase = 'stopped';
      socket?.close();
      if (loop !== null) await loop;
    },
    state(): LunaChannelState {
      return phase;
    },
  };
}

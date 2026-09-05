/**
 * s5-execution Scenario 13 — the mock gateway (plan Part 3).
 *
 * An in-memory stand-in for `GET /v1/agent`: it accepts a `hello`, scripts
 * `draft.request` fixtures, can put deliberately malformed bytes on the wire,
 * and records every frame the adapter sends back. It is NOT a second
 * implementation of the daemon transport — it validates with the daemon's own
 * `parseAgentFrame`, so a third party cannot pass the kit against a laxer
 * parser than the one that will actually judge it.
 *
 * Three deliberate properties:
 *
 *  - **The permitted vocabulary is derived, never listed.** `FRAME_SPECS` is
 *    the source of truth for which types may travel agent→gateway; a hardcoded
 *    array here would be a second place to forget to update.
 *  - **The adapter's exceptions are caught and recorded, not propagated.**
 *    "Survives malformed frames without crashing" is a check, and a check
 *    cannot be an unhandled throw that takes the runner down with it.
 *  - **Version negotiation is a property of the bytes, not of a handshake.**
 *    There is no gateway hello in this protocol, so a mock "demanding v0"
 *    means a mock that emits `v: 0` frames. A conformant adapter refuses them
 *    and answers nothing.
 */
import {
  FRAME_SPECS,
  FRAME_TYPES,
  parseAgentFrame,
  WIRE_VERSION,
  type Frame,
  type FrameType,
} from '@wemessage/protocol';
import type {
  TestkitSocket,
  TestkitSocketFactory,
  TestkitSocketHandlers,
} from './types.js';

/** Derived from the protocol, so the kit and the daemon cannot disagree. */
export const AGENT_TO_GATEWAY_TYPES: readonly FrameType[] = FRAME_TYPES.filter(
  (t) => FRAME_SPECS[t].direction === 'agent->gateway',
);

/** Which wire version the mock puts on the frames it emits. */
export type WireMode = 'v0' | 'v1' | 'v2';

export interface MockGatewayOptions {
  /** The id the adapter is expected to present. */
  adapterId: string;
  /** The token the adapter is expected to present. */
  token: string;
  /** `'reject'` closes every hello 4401 — the fail-closed probe (check 5). */
  auth?: 'accept' | 'reject';
  wire?: WireMode;
  clock?: { now(): string };
}

/** One scripted `draft.request`. */
export interface RequestFixture {
  requestId: string;
  chatGuid?: string;
  inboundGuid?: string;
  handle?: string;
  text: string | null;
  maxChars?: number;
  deadlineMs?: number;
}

export interface MockGateway {
  /** Hand this to the adapter as its gateway socket factory. */
  ws: TestkitSocketFactory;
  /** How many times the adapter dialled — the fail-closed ceiling. */
  connections(): number;
  /** Frames that parsed as `agent->gateway`, in arrival order. */
  frames(): Frame[];
  /** Frame types, in arrival order. */
  types(): string[];
  /**
   * Anything the adapter sent that `parseAgentFrame` refused: an outbound
   * frame type it may not use, a gateway→agent frame replayed at us, junk.
   * A conformant adapter leaves this empty for the whole session.
   */
  violations(): string[];
  /** True if any callback into the adapter threw (check 3's crash probe). */
  crashed(): boolean;
  /** The `features` array the adapter declared in `hello`, or `[]`. */
  helloFeatures(): string[];
  /** True once a well-formed `hello` has been accepted. */
  authenticated(): boolean;
  /** Deliver a scripted `draft.request`. */
  request(fixture: RequestFixture): void;
  /** Deliver a well-formed gateway→agent frame. */
  deliver(frame: unknown): void;
  /** Deliver raw bytes — the malformed-input probes. */
  deliverRaw(raw: string): void;
  /** Deliver a `ping`. */
  ping(): void;
  /** Close the live socket. */
  close(code?: number): void;
}

const DEFAULT_CHAT = 'iMessage;-;+15551230000';
const DEFAULT_HANDLE = '+15551230000';
const DEFAULT_MAX_CHARS = 1_000;
const DEFAULT_DEADLINE_MS = 5_000;
const CLOSE_AUTH = 4401;

const WIRE_OF: Record<WireMode, number> = { v0: 0, v1: WIRE_VERSION, v2: 2 };

export function createMockGateway(opts: MockGatewayOptions): MockGateway {
  const clock = opts.clock ?? { now: (): string => new Date().toISOString() };
  const wire = WIRE_OF[opts.wire ?? 'v1'];
  const rejectAuth = opts.auth === 'reject';

  let connections = 0;
  let counter = 0;
  let live: { socket: TestkitSocket; handlers: TestkitSocketHandlers } | null =
    null;
  let crashed = false;
  let authenticated = false;
  let features: string[] = [];
  const frames: Frame[] = [];
  const violations: string[] = [];

  /**
   * Every entry into the adapter goes through here. An adapter that throws on
   * our bytes has failed check 3; it has not earned the right to abort the
   * run, so the throw becomes a recorded fact.
   */
  const intoAdapter = (fn: () => void): void => {
    try {
      fn();
    } catch {
      crashed = true;
    }
  };

  const emit = (type: string, payload: unknown): void => {
    counter += 1;
    const raw = JSON.stringify({
      v: wire,
      id: `mock-${String(counter).padStart(6, '0')}`,
      type,
      ts: clock.now(),
      payload,
    });
    const handlers = live?.handlers;
    if (handlers === undefined) return;
    intoAdapter(() => {
      handlers.onMessage(raw);
    });
  };

  const onAdapterFrame = (raw: string): void => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      violations.push('<unparseable>');
      return;
    }
    const parsed = parseAgentFrame(json);
    if (!parsed.ok) {
      const type = (json as { type?: unknown }).type;
      violations.push(typeof type === 'string' ? type : '<malformed>');
      return;
    }
    frames.push(parsed.frame);
    if (parsed.frame.type !== 'hello') return;

    // Auth. The mock is deliberately strict about the id AND the token: an
    // adapter that dials with someone else's id is exactly the forgery the
    // daemon closes 4401 on, and the kit must not be more forgiving.
    features = parsed.frame.payload.features ?? [];
    const idOk = parsed.frame.payload.adapterId === opts.adapterId;
    const tokenOk = parsed.frame.payload.token === opts.token;
    if (rejectAuth || !idOk || !tokenOk) {
      const socket = live?.socket;
      live = null;
      socket?.close(CLOSE_AUTH);
      return;
    }
    authenticated = true;
  };

  const ws: TestkitSocketFactory = (_url, handlers) => {
    connections += 1;
    let closed = false;
    const socket: TestkitSocket = {
      send(data: string) {
        onAdapterFrame(data);
      },
      close(code?: number) {
        if (closed) return;
        closed = true;
        if (live?.socket === socket) live = null;
        intoAdapter(() => {
          handlers.onClose(code ?? 1000);
        });
      },
    };
    live = { socket, handlers };
    return Promise.resolve(socket);
  };

  return {
    ws,
    connections: () => connections,
    frames: () => [...frames],
    types: () => frames.map((f) => f.type),
    violations: () => [...violations],
    crashed: () => crashed,
    helloFeatures: () => [...features],
    authenticated: () => authenticated,

    request(fixture) {
      const chatGuid = fixture.chatGuid ?? DEFAULT_CHAT;
      const handle = fixture.handle ?? DEFAULT_HANDLE;
      const inboundGuid = fixture.inboundGuid ?? `p:0/${fixture.requestId}`;
      emit('draft.request', {
        correlation: { requestId: fixture.requestId, chatGuid, inboundGuid },
        message: {
          guid: inboundGuid,
          chatGuid,
          handle,
          isGroup: false,
          service: 'imessage',
          receivedAt: clock.now(),
          // `untrusted: true` is the whole posture: whatever is in `text` is
          // data. The injection probe rides in on this exact field.
          content: { untrusted: true, text: fixture.text, attachments: [] },
        },
        context: [],
        rule: {
          id: `${'0'.repeat(24)}R1`,
          name: 'conformance',
          respondMode: 'draft-only',
        },
        constraints: {
          maxChars: fixture.maxChars ?? DEFAULT_MAX_CHARS,
          deadlineMs: fixture.deadlineMs ?? DEFAULT_DEADLINE_MS,
        },
      });
    },

    deliver(frame) {
      const handlers = live?.handlers;
      if (handlers === undefined) return;
      const raw = JSON.stringify(frame);
      intoAdapter(() => {
        handlers.onMessage(raw);
      });
    },

    deliverRaw(raw) {
      const handlers = live?.handlers;
      if (handlers === undefined) return;
      intoAdapter(() => {
        handlers.onMessage(raw);
      });
    },

    ping() {
      emit('ping', {});
    },

    close(code) {
      live?.socket.close(code ?? 1000);
    },
  };
}

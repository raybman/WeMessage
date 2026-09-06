/**
 * s8 Sc12 — a scripted adapter on the real `/v1/agent` socket.
 *
 * Every desktop scenario before this one could stage its drafts with
 * `directClient.createDraft` or `store.insertDraft`, because what it was
 * asserting was true of a draft however the draft got there. Sc12 cannot.
 * The three facts this scenario exists to prove are all about AUTONOMY:
 *
 *  - the deny-all default stops the agent being ASKED at all
 *    (`adapters/dispatch.ts` refuses on `decision.reason` before it builds a
 *    frame, so a handle with no `ContactPolicy` row produces no request);
 *  - a contact rung set to AUTO under a `draft-only` global still only
 *    drafts (`maybeAutoApprove` withholds on `decision.mode !== 'auto'`);
 *  - `sms-auto-forbidden` withholds the auto-approval and nothing else
 *    (`decision.clampedBy !== undefined`).
 *
 * All three live behind `adapters/submit.ts`, whose one call site is an
 * agent's `draft.submit` answering a `draft.request` THIS gateway issued.
 * A hand-inserted draft skips every one of them, so a hand-inserted draft
 * cannot tell us whether they hold. This is a real socket, speaking the
 * real wire, against the real correlation registry — the same posture as
 * `harness.ts` booting a real daemon rather than a convincing fake.
 *
 * It is deliberately thin: connect, greet, and answer every request with
 * one body. Nothing here decides anything; the daemon does.
 *
 * `WebSocket` is Node's own global (`@types/node`'s `web-globals/fetch.d.ts`
 * declares it). The `ws` package would have been a new dependency in
 * `apps/desktop` for a test helper, and this needs none of what it adds.
 */
import { WIRE_VERSION } from '@wemessage/protocol';

/** The half of `draft.request`'s payload a scripted agent actually reads. */
export interface AgentRequestSeen {
  readonly requestId: string;
  readonly chatGuid: string;
  readonly inboundGuid: string;
  /** The RESOLVED mode (F-60), never the rule's declared one. */
  readonly respondMode: string;
  readonly ruleId: string;
  readonly text: string | null;
}

export interface FakeAgent {
  /** Every `draft.request` this adapter has been sent, in arrival order. */
  requests(): readonly AgentRequestSeen[];
  /** Every frame, for rows that care about what was NOT sent. */
  frames(): readonly unknown[];
  close(): Promise<void>;
}

interface Envelope {
  readonly type?: unknown;
  readonly payload?: unknown;
}

function readRequest(payload: unknown): AgentRequestSeen | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const correlation = p['correlation'];
  const rule = p['rule'];
  const message = p['message'];
  if (
    typeof correlation !== 'object' ||
    correlation === null ||
    typeof rule !== 'object' ||
    rule === null
  )
    return null;
  const c = correlation as Record<string, unknown>;
  const r = rule as Record<string, unknown>;
  const m = (
    typeof message === 'object' && message !== null ? message : {}
  ) as Record<string, unknown>;
  return {
    requestId: String(c['requestId'] ?? ''),
    chatGuid: String(c['chatGuid'] ?? ''),
    inboundGuid: String(c['inboundGuid'] ?? ''),
    respondMode: String(r['respondMode'] ?? ''),
    ruleId: String(r['id'] ?? ''),
    text: typeof m['text'] === 'string' ? m['text'] : null,
  };
}

export interface FakeAgentOptions {
  /** The daemon's OWN port, never the tee: an adapter is not the app. */
  port: number;
  adapterId: string;
  token: string;
  /** The one body this adapter proposes for everything it is asked. */
  body: string;
  /** ISO instants for the frame envelope; the fixture clock, by hand. */
  now: () => string;
  /** The daemon's OWN view of the adapter row; greeted is not authed. */
  connected: () => boolean;
}

/**
 * Connect, greet, and answer every `draft.request` with `body`.
 *
 * Answering is synchronous inside the message handler, so a row can wait on
 * the DRAFT it produces rather than on this helper — the same reason the
 * suite waits on `data-conn` rather than on a launch promise.
 */
export async function connectFakeAgent(
  options: FakeAgentOptions,
): Promise<FakeAgent> {
  const seen: AgentRequestSeen[] = [];
  const all: unknown[] = [];
  let issued = 0;
  const ws = new WebSocket(`ws://127.0.0.1:${String(options.port)}/v1/agent`);
  const nextId = (): string => {
    issued += 1;
    return `01${String(issued).padStart(24, '0')}`;
  };
  const send = (type: string, payload: unknown): void => {
    ws.send(
      JSON.stringify({
        v: WIRE_VERSION,
        id: nextId(),
        type,
        ts: options.now(),
        payload,
      }),
    );
  };
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => {
      resolve();
    });
    ws.addEventListener('error', () => {
      reject(new Error('fake agent: the /v1/agent socket refused to open'));
    });
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    const frame = JSON.parse(String(ev.data)) as Envelope;
    all.push(frame);
    if (frame.type === 'ping') {
      send('pong', {});
      return;
    }
    if (frame.type !== 'draft.request') return;
    const req = readRequest(frame.payload);
    if (req === null) return;
    seen.push(req);
    // A real adapter answers on its own turn. The gateway has already told
    // us the RESOLVED mode; we neither read it nor act on it, which is the
    // point — an adapter that could talk itself into `auto` would be an
    // autonomy escalation with extra steps.
    send('draft.submit', {
      correlation: {
        requestId: req.requestId,
        chatGuid: req.chatGuid,
        inboundGuid: req.inboundGuid,
      },
      idempotencyKey: `fake-agent-${String(seen.length)}-${req.requestId}`,
      body: options.body,
    });
  });
  send('hello', {
    adapterId: options.adapterId,
    token: options.token,
    wire: WIRE_VERSION,
  });
  // Greeted is not authenticated. The daemon's own adapter row is the only
  // honest signal, and a row that asserts "no request was issued" would be
  // vacuous if it raced this handshake.
  for (let i = 0; i < 2000; i += 1) {
    if (options.connected()) break;
    await new Promise<void>((r) => {
      setImmediate(r);
    });
  }
  if (!options.connected())
    throw new Error(
      'fake agent: the daemon never marked the adapter connected',
    );
  return {
    requests: () => seen,
    frames: () => all,
    /**
     * Close, and drain against the DAEMON's view rather than ours.
     *
     * The client's `close` event fires first; the server's handler writes
     * `adapter.disconnected` afterwards. Resolving on our own event would
     * let the harness tear the store down underneath that write, and the
     * store would throw from a socket callback with no test to blame it on
     * — the same drain `agent-harness.ts` does for the same reason.
     */
    close: async () => {
      await new Promise<void>((resolve) => {
        if (ws.readyState === 3) return resolve();
        ws.addEventListener('close', () => {
          resolve();
        });
        ws.close();
      });
      for (let i = 0; i < 2000; i += 1) {
        if (!options.connected()) return;
        await new Promise<void>((r) => {
          setImmediate(r);
        });
      }
      throw new Error('fake agent: the daemon never saw the socket close');
    },
  };
}

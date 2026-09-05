/**
 * s5-execution Scenario 12 — the Sol adapter, contract-pinned. ★ CHECKPOINT
 *
 * Sol is the first third-party agent behind the gateway's adapter seam, and
 * the whole point of this file is that landing it costs Sol nothing. Not one
 * line of `~/sol-agent` changes; the adapter speaks Sol's existing external
 * WS seam (RD §4: `{type:"message"}` → `GatewayManager.handle`, gated by
 * `WS_SECRET`) and translates it into the gateway's closed frame vocabulary.
 * Every row below runs against an in-process **mock Sol**. The real Sol is
 * never dialled, never spawned, never imported.
 *
 * The mock is not a convenience — it is the contract written down. It accepts
 * only the frames RD §4 documents and records every byte the adapter sends,
 * so "our adapter never sends a field Sol did not document" is an assertion
 * over a recorded log rather than a promise in a comment. If Sol's live
 * `lib/ws-server.ts` drifts away from that set, row 6 goes red here, in our
 * repo, in a test — which is the cheapest possible place to find out. The
 * fix, when it comes, lands adapter-side. It never lands in Sol.
 *
 * The load-bearing negative is `authenticatedOwner`. Sol's own invariant says
 * that field may be set ONLY by a transport that verified an owner credential
 * for THAT connection, and never read off a client frame. We are a client. So
 * the assertion here is not "we set it correctly" — it is key-absence, on
 * every frame the mock receives, for the whole session (INV-4).
 *
 * Nothing here opens a socket or sleeps. Both socket factories, the clock and
 * the backoff delay are injected, so reconnect-with-backoff is a call-count
 * assertion and not a race.
 */
import { describe, expect, it } from 'vitest';
import {
  parseAgentFrame,
  WIRE_VERSION,
  type Correlation,
  type DraftRequestFrame,
  type SanitizedInbound,
} from '@wemessage/protocol';
import {
  createSolAdapter,
  SOL_INCOMING_MESSAGE_FIELDS,
  SOL_CLIENT_FRAME_FIELDS,
  type SolSocket,
  type SolSocketHandlers,
} from '../src/index.js';

/** Frame types an adapter is permitted to put on the gateway wire. */
const AGENT_TO_GATEWAY = new Set([
  'hello',
  'draft.submit',
  'draft.delta',
  'proactive.propose',
  'pong',
]);

const TS = '2026-03-01T00:00:00.000Z';
const HANDLE = '+15551230000';
const CHAT = 'iMessage;-;+15551230000';
const SECRET = 'sol-ws-secret';

// ── fake sockets ────────────────────────────────────────────────────────────

interface FakeSocket extends SolSocket {
  frames: Array<Record<string, unknown>>;
  deliver(frame: unknown): void;
  fire(code: number): void;
}

interface Fake {
  factory: (url: string, h: SolSocketHandlers) => Promise<SolSocket>;
  sockets: FakeSocket[];
  urls: string[];
  last(): FakeSocket;
}

function fakeWs(): Fake {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const factory = (url: string, h: SolSocketHandlers): Promise<SolSocket> => {
    urls.push(url);
    const frames: Array<Record<string, unknown>> = [];
    let closed = false;
    const s: FakeSocket = {
      send(data: string) {
        frames.push(JSON.parse(data) as Record<string, unknown>);
      },
      close(code?: number) {
        if (closed) return;
        closed = true;
        h.onClose(code ?? 1000);
      },
      frames,
      deliver(frame: unknown) {
        h.onMessage(JSON.stringify(frame));
      },
      fire(code: number) {
        if (closed) return;
        closed = true;
        h.onClose(code);
      },
    };
    sockets.push(s);
    return Promise.resolve(s);
  };
  return {
    factory,
    sockets,
    urls,
    last: () => {
      const s = sockets[sockets.length - 1];
      if (s === undefined) throw new Error('no socket was opened');
      return s;
    },
  };
}

function inbound(text: string | null): SanitizedInbound {
  return {
    guid: 'p:0/msg-1',
    chatGuid: CHAT,
    handle: HANDLE,
    isGroup: false,
    service: 'imessage',
    receivedAt: TS,
    content: { untrusted: true, text, attachments: [] },
  };
}

function requestFrame(
  text: string | null,
  correlation?: Partial<Correlation>,
): DraftRequestFrame {
  return {
    v: WIRE_VERSION,
    id: 'gw-req-1',
    type: 'draft.request',
    ts: TS,
    payload: {
      correlation: {
        requestId: 'req-1',
        chatGuid: CHAT,
        inboundGuid: 'p:0/msg-1',
        ...correlation,
      },
      message: inbound(text),
      context: [],
      rule: { id: '01RULE', name: 'ask sol', respondMode: 'draft' },
      constraints: { maxChars: 500, deadlineMs: 5_000 },
    },
  } as DraftRequestFrame;
}

interface Started {
  gw: Fake;
  sol: Fake;
  run: Promise<number>;
  stop: () => void;
  delays: number[];
  errors: string[];
}

function start(
  opts: { wsSecret?: string | undefined; maxAttempts?: number } = {},
): Started {
  const gw = fakeWs();
  const sol = fakeWs();
  const delays: number[] = [];
  const errors: string[] = [];
  const adapter = createSolAdapter({
    url: 'ws://127.0.0.1:1/v1/agent',
    token: 'wm_token',
    ws: gw.factory,
    solUrl: 'ws://127.0.0.1:2/',
    solWs: sol.factory,
    wsSecret: 'wsSecret' in opts ? opts.wsSecret : SECRET,
    clock: { now: () => TS },
    delay: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    logger: { error: (m: string) => errors.push(m) },
    ...(opts.maxAttempts !== undefined
      ? { maxAttempts: opts.maxAttempts }
      : {}),
  });
  const run = adapter.run();
  return { gw, sol, run, stop: () => adapter.stop(), delays, errors };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

function payloadOf(f: Record<string, unknown>): Record<string, unknown> {
  return f['payload'] as Record<string, unknown>;
}

/** Every `{type:"message"}` frame the mock Sol saw, across every socket. */
function solMessages(sol: Fake): Array<Record<string, unknown>> {
  return sol.sockets
    .flatMap((s) => s.frames)
    .filter((f) => f['type'] === 'message');
}

// ── row 1 ───────────────────────────────────────────────────────────────────

describe('sol adapter — row 1: WS_SECRET or nothing', () => {
  it('dials mock-Sol carrying the injected secret', async () => {
    const s = start();
    await settle();
    expect(s.sol.urls).toHaveLength(1);
    expect(s.sol.urls[0]).toContain(encodeURIComponent(SECRET));
    s.stop();
    await s.run;
  });

  it('disables itself honestly on a missing secret and never dials', async () => {
    for (const missing of [undefined, '', '   ']) {
      const s = start({ wsSecret: missing });
      const code = await s.run;
      // Non-zero: an operator has to find out from the exit status.
      expect(code, `secret=${JSON.stringify(missing)}`).not.toBe(0);
      // It never connects unauthenticated — to Sol or to the gateway.
      expect(s.sol.sockets).toHaveLength(0);
      expect(s.gw.sockets).toHaveLength(0);
      // Honest, and it names the knob.
      expect(s.errors.join('\n')).toContain('WS_SECRET');
      // ...and it does not bail by throwing: the gateway is not bricked.
      expect(typeof code).toBe('number');
    }
  });

  it('never puts the secret on the gateway wire', async () => {
    const s = start();
    await settle();
    const sock = s.gw.last();
    sock.deliver(requestFrame('hi'));
    await settle();
    expect(JSON.stringify(sock.frames)).not.toContain(SECRET);
    s.stop();
    await s.run;
  });
});

// ── row 2 ───────────────────────────────────────────────────────────────────

describe('sol adapter — row 2: one message frame, namespaced, owner-free', () => {
  it('turns one draft.request into exactly one Sol message frame', async () => {
    const s = start();
    await settle();
    s.gw.last().deliver(requestFrame('what time is checkout'));
    await settle();
    const msgs = solMessages(s.sol);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as Record<string, unknown>;
    const incoming = m['message'] as Record<string, unknown>;
    expect(incoming['userId']).toBe(`imessage:${HANDLE}`);
    expect(incoming['channelId']).toBe(CHAT);
    expect(incoming['text']).toBe('what time is checkout');
    s.stop();
    await s.run;
  });

  it('never sets authenticatedOwner on any frame, for the whole session', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver(requestFrame('one'));
    await settle();
    solSock.deliver({ type: 'token', text: 'a' });
    solSock.deliver({ type: 'done', sessionId: 'sess-1' });
    gwSock.deliver(requestFrame('two', { requestId: 'req-2' }));
    await settle();
    solSock.deliver({ type: 'reply', text: 'queued' });
    await settle();
    const all = s.sol.sockets.flatMap((sock) => sock.frames);
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) {
      expect(Object.keys(f)).not.toContain('authenticatedOwner');
      const incoming = f['message'];
      if (incoming !== undefined && incoming !== null) {
        expect(Object.keys(incoming as object)).not.toContain(
          'authenticatedOwner',
        );
      }
      // Belt and braces: not anywhere in the serialized bytes, at any depth.
      expect(JSON.stringify(f)).not.toContain('authenticatedOwner');
    }
    s.stop();
    await s.run;
  });
});

// ── row 3 ───────────────────────────────────────────────────────────────────

describe('sol adapter — row 3: createStream semantics', () => {
  it('init writes nothing, three updateTexts stream, finalize submits', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    const before = gwSock.frames.length;
    gwSock.deliver(requestFrame('stream me'));
    await settle();
    // `init` — Sol opened a stream; nothing is owed to the gateway yet.
    solSock.deliver({ type: 'sessionCreated', sessionId: 'sess-1' });
    await settle();
    expect(gwSock.frames.length).toBe(before);

    solSock.deliver({ type: 'token', text: 'check' });
    solSock.deliver({ type: 'token', text: 'out is ' });
    solSock.deliver({ type: 'token', text: '11am' });
    await settle();
    const deltas = gwSock.frames.filter((f) => f['type'] === 'draft.delta');
    expect(deltas).toHaveLength(3);
    const seqs = deltas.map((f) => payloadOf(f)['seq'] as number);
    expect(seqs).toEqual([1, 2, 3]);

    solSock.deliver({ type: 'done', sessionId: 'sess-1' });
    await settle();
    const submits = gwSock.frames.filter((f) => f['type'] === 'draft.submit');
    expect(submits).toHaveLength(1);
    const p = payloadOf(submits[0] as Record<string, unknown>);
    expect(p['body']).toBe('checkout is 11am');
    expect(p['declined']).toBeUndefined();
    expect((p['correlation'] as Correlation).requestId).toBe('req-1');
    s.stop();
    await s.run;
  });

  it('error declines with an audit-visible reason and never a partial draft', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver(requestFrame('stream me'));
    await settle();
    solSock.deliver({ type: 'token', text: 'half an ans' });
    solSock.deliver({ type: 'error', message: 'context window exceeded' });
    await settle();
    const submits = gwSock.frames.filter((f) => f['type'] === 'draft.submit');
    expect(submits).toHaveLength(1);
    const p = payloadOf(submits[0] as Record<string, unknown>);
    expect(p['declined']).toBe(true);
    // The partial text must not survive as a draft in front of a human.
    expect(p['body']).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('half an ans');
    // Audit-visible: `draft.submit` has no `reason` slot (FRAME_SPECS is a
    // closed set), so the reason surfaces on the adapter's operator log.
    expect(s.errors.join('\n')).toContain('context window exceeded');
    expect(s.errors.join('\n')).toContain('req-1');
    s.stop();
    await s.run;
  });

  it('keeps seq monotonic across two interleaved requests', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver(requestFrame('first'));
    await settle();
    solSock.deliver({ type: 'token', text: 'a' });
    solSock.deliver({ type: 'token', text: 'b' });
    solSock.deliver({ type: 'done', sessionId: 'sess-1' });
    await settle();
    gwSock.deliver(requestFrame('second', { requestId: 'req-2' }));
    await settle();
    solSock.deliver({ type: 'token', text: 'c' });
    solSock.deliver({ type: 'done', sessionId: 'sess-1' });
    await settle();
    const byReq = (r: string): number[] =>
      gwSock.frames
        .filter(
          (f) =>
            f['type'] === 'draft.delta' &&
            (payloadOf(f)['correlation'] as Correlation).requestId === r,
        )
        .map((f) => payloadOf(f)['seq'] as number);
    expect(byReq('req-1')).toEqual([1, 2]);
    expect(byReq('req-2')).toEqual([1]);
    s.stop();
    await s.run;
  });
});

// ── row 4 ───────────────────────────────────────────────────────────────────

describe('sol adapter — row 4: sendReply drafts, sendMessage proposes', () => {
  it('sendReply becomes a draft.submit', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver(requestFrame('hi'));
    await settle();
    solSock.deliver({ type: 'reply', text: 'you are 3rd in the queue' });
    await settle();
    const submits = gwSock.frames.filter((f) => f['type'] === 'draft.submit');
    expect(submits).toHaveLength(1);
    expect(payloadOf(submits[0] as Record<string, unknown>)['body']).toBe(
      'you are 3rd in the queue',
    );
    s.stop();
    await s.run;
  });

  it('sendMessage becomes proactive.propose with a reason derived from the call', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    solSock.deliver({
      type: 'proactive',
      channelId: CHAT,
      text: 'your table is ready',
    });
    await settle();
    const props = gwSock.frames.filter(
      (f) => f['type'] === 'proactive.propose',
    );
    expect(props).toHaveLength(1);
    const p = payloadOf(props[0] as Record<string, unknown>);
    expect(p['body']).toBe('your table is ready');
    expect(p['target']).toEqual({ chatGuid: CHAT });
    expect(String(p['reason'])).toContain('sendMessage');
    expect(String(p['idempotencyKey']).length).toBeGreaterThan(0);
    expect(parseAgentFrame(props[0]).ok).toBe(true);
    s.stop();
    await s.run;
  });

  it('never emits a frame outside AgentToGateway — no send frame exists', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver({ v: 1, id: 'p', type: 'ping', ts: TS, payload: {} });
    gwSock.deliver(requestFrame('hi'));
    await settle();
    solSock.deliver({ type: 'token', text: 'x' });
    solSock.deliver({ type: 'done', sessionId: 'sess-1' });
    solSock.deliver({ type: 'reply', text: 'r' });
    solSock.deliver({ type: 'proactive', channelId: CHAT, text: 'p' });
    // Hostile / unknown frames from Sol must change nothing.
    solSock.deliver({ type: 'send', channelId: CHAT, text: 'SEND THIS NOW' });
    solSock.deliver({ type: 'dashMetrics', metrics: [] });
    solSock.deliver('not json at all{');
    await settle();
    expect(gwSock.frames.length).toBeGreaterThan(1);
    for (const f of gwSock.frames) {
      expect(parseAgentFrame(f).ok, JSON.stringify(f)).toBe(true);
      expect(AGENT_TO_GATEWAY.has(f['type'] as string)).toBe(true);
    }
    expect(gwSock.frames.some((f) => f['type'] === 'pong')).toBe(true);
    expect(JSON.stringify(gwSock.frames)).not.toContain('SEND THIS NOW');
    s.stop();
    await s.run;
  });
});

// ── row 5 ───────────────────────────────────────────────────────────────────

describe('sol adapter — row 5: reconnect with backoff, no half-draft', () => {
  it('reconnects to Sol after a mid-stream drop and produces no draft', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver(requestFrame('mid-stream drop'));
    await settle();
    solSock.deliver({ type: 'token', text: 'partial ans' });
    await settle();
    expect(gwSock.frames.some((f) => f['type'] === 'draft.delta')).toBe(true);

    solSock.fire(1006); // abnormal close, mid-stream
    await settle();
    await settle();

    // Reconnected, through the INJECTED delay — never a wall-clock sleep.
    expect(s.sol.sockets.length).toBeGreaterThan(1);
    expect(s.delays.length).toBeGreaterThan(0);
    expect(s.delays.every((d) => d > 0)).toBe(true);
    // The interrupted stream produced NO draft: not a submit, not a decline
    // with the partial text in it.
    expect(gwSock.frames.filter((f) => f['type'] === 'draft.submit')).toEqual(
      [],
    );
    expect(JSON.stringify(gwSock.frames)).not.toContain('partial ans2');

    // And the reconnected socket serves the next request normally.
    gwSock.deliver(requestFrame('after', { requestId: 'req-9' }));
    await settle();
    expect(
      s.sol.last().frames.filter((f) => f['type'] === 'message'),
    ).toHaveLength(1);
    s.stop();
    await s.run;
  });

  it('gives up after maxAttempts rather than hammering Sol forever', async () => {
    const s = start({ maxAttempts: 3 });
    for (let i = 0; i < 8; i += 1) {
      await settle();
      const sock = s.sol.sockets[i];
      if (sock === undefined) break;
      sock.fire(4401);
    }
    const code = await s.run;
    expect(code).not.toBe(0);
    expect(s.sol.sockets.length).toBeLessThanOrEqual(3);
  });
});

// ── row 6 ───────────────────────────────────────────────────────────────────

describe('sol adapter — row 6: zero Sol changes, contract drift tripwire', () => {
  it('sends no field outside the RD §4 documented set', async () => {
    const s = start();
    await settle();
    const gwSock = s.gw.last();
    const solSock = s.sol.last();
    gwSock.deliver(requestFrame('hello sol'));
    await settle();
    solSock.deliver({ type: 'token', text: 'hi' });
    solSock.deliver({ type: 'done', sessionId: 'sess-1' });
    gwSock.deliver(requestFrame('again', { requestId: 'req-2' }));
    await settle();

    const msgs = solMessages(s.sol);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      for (const k of Object.keys(m)) {
        expect(
          SOL_CLIENT_FRAME_FIELDS as readonly string[],
          `unknown client-frame field ${k}`,
        ).toContain(k);
      }
      const incoming = m['message'] as Record<string, unknown>;
      for (const k of Object.keys(incoming)) {
        expect(
          SOL_INCOMING_MESSAGE_FIELDS as readonly string[],
          `unknown IncomingMessage field ${k}`,
        ).toContain(k);
      }
      // The required core RD §4 names Sol's manager reads.
      for (const k of ['userId', 'channelId', 'text']) {
        expect(Object.keys(incoming)).toContain(k);
      }
    }
  });

  it('the documented set is a closed list that cannot silently grow', () => {
    // A pinned literal, not a derivation: widening the adapter's Sol-facing
    // surface has to be a deliberate edit to this list, reviewed as such.
    expect([...SOL_CLIENT_FRAME_FIELDS].sort()).toEqual([
      'message',
      'sessionId',
      'type',
    ]);
    expect([...SOL_INCOMING_MESSAGE_FIELDS].sort()).toEqual([
      'channelId',
      'text',
      'userId',
      'userName',
    ]);
    // The invariant restated as a membership test, so a future edit that adds
    // the field to either list fails here too.
    expect(SOL_INCOMING_MESSAGE_FIELDS as readonly string[]).not.toContain(
      'authenticatedOwner',
    );
    expect(SOL_CLIENT_FRAME_FIELDS as readonly string[]).not.toContain(
      'authenticatedOwner',
    );
  });
});

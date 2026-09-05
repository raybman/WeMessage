/**
 * s8-execution Scenario 3 (client half) — the DTOs a GUI needs.
 *
 * Same posture as client-s3/s4/s5/s7: unit tests over a stubbed `fetch` and a
 * stubbed `ws`. This package is a transport (§2.5), so the only questions
 * worth asking here are "did it build the right request", "did it keep the
 * shape of the answer", and "does the type it hands a consumer describe the
 * bytes the daemon actually sends". The behaviour behind every route below
 * is proven at the daemon, in `drafts-lifecycle-events.spec.ts` and
 * `bulk-partial-failure.spec.ts`.
 *
 * Four things this file is about.
 *
 * **`bulkDrafts` learns a third verb.** The daemon's `action` enum widened by
 * one word; the wrapper's union widens with it and the request body is
 * asserted byte for byte, because the whole failure mode of a stringly-typed
 * verb is that it looks right and means something else.
 *
 * **`DraftPayload` gains `proactiveReason`.** Core's `Draft` has carried it
 * since S5 §3.2 and this DTO never did, so a consumer reading the field off a
 * proactive draft was reading `undefined` from a type that promised nothing.
 * The daemon sends it; the type now admits it. It is genuinely optional —
 * a rule-borne draft has no such reason — so an ordinary draft must OMIT the
 * key rather than carry an explicit `undefined`.
 *
 * **The four lifecycle frames need no client work, and that is worth a row.**
 * `GatewayEventPayload` is re-exported straight from `@wemessage/protocol`,
 * so Sc 2's four variants arrived here the moment they were declared. The
 * rows below are therefore about the frames being USABLE — narrowed on
 * `event` and read without a cast — rather than about anything this package
 * had to add. A consumer that has to reach for `as` is a consumer whose
 * screen will be wrong on the day the shape changes.
 *
 * **`parseChatGuid` is a mirror, and it refuses rather than shrugging.** A
 * GUI renders a chat guid as a person: an avatar, a name, a service icon. It
 * needs the same split `@wemessage/core` does, and it cannot have core —
 * this package depends on `@wemessage/protocol` and `ws` and nothing else,
 * deliberately, because it ships to third parties and core would drag the
 * store, the gate and the dispatcher behind it. So the client owns a small
 * copy. The copy is a strict NARROWING: identical where core resolves a
 * service it knows, and a thrown error exactly where core would have
 * answered `service: 'unknown'`. Core cannot throw — it runs inside the
 * dispatcher, where a malformed guid must degrade to a refusal and not to an
 * exception in the send path — but a caller drawing a screen is better served
 * by a failure than by an icon chosen at random. The two are pinned to each
 * other in `packages/daemon/test/drafts-lifecycle-events.spec.ts`, the one
 * package that can import both.
 *
 * Handles are synthetic (`+1555…`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The socket factory, stubbed. `vi.hoisted` because a `vi.mock` factory is
 * hoisted above the imports and can only close over values hoisted with it.
 */
const { FakeSocket } = vi.hoisted(() => {
  class FakeSocketImpl {
    static instances: FakeSocketImpl[] = [];
    readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    closeCalls = 0;
    constructor(
      readonly url: string,
      readonly opts: { headers?: Record<string, string> },
    ) {
      FakeSocketImpl.instances.push(this);
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    fire(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    close(): void {
      this.closeCalls += 1;
    }
  }
  return { FakeSocket: FakeSocketImpl };
});

vi.mock('ws', () => ({ default: FakeSocket }));

const { createClient, parseChatGuid } = await import('../src/index.js');
type WeMessageClient = import('../src/index.js').WeMessageClient;
type GatewayEventPayload = import('../src/index.js').GatewayEventPayload;
type DraftPayload = import('../src/index.js').DraftPayload;
type BulkResult = import('../src/index.js').BulkResult;

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  FakeSocket.instances.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = 'wm_0123456789abcdef';
const CHAT = 'iMessage;-;+15550000001';

const client = (): WeMessageClient =>
  createClient({ baseUrl: 'http://127.0.0.1:47100', token: TOKEN });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function alwaysJson(status: number, body: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonResponse(status, body)),
  );
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

const BULK: BulkResult = {
  batchId: '01BATCH00000000000000000',
  matched: 3,
  applied: 2,
  appliedIds: ['01AAA0000000000000000000', '01BBB0000000000000000000'],
  refused: [{ id: '01CCC0000000000000000000', error: 'illegal-transition' }],
};

// ---------------------------------------------------------------------------
// bulk reject
// ---------------------------------------------------------------------------

describe('s8 Sc3 client: bulkDrafts accepts reject', () => {
  it("posts {action:'reject'} with the selector spread flat", async () => {
    alwaysJson(200, BULK);
    const result = await client().bulkDrafts('reject', {
      filter: { all: true },
    });

    const { url, init } = lastCall();
    expect(url).toBe('http://127.0.0.1:47100/v1/drafts/bulk');
    expect(init.method).toBe('POST');
    // Flat, not nested under `selector`: the route's zod strictObject takes
    // `ids` or `filter` at the top level and refuses anything else outright,
    // so a wrapper that nested them would 400 on every call.
    expect(JSON.parse(String(init.body))).toEqual({
      action: 'reject',
      filter: { all: true },
    });
    expect(result).toEqual(BULK);
  });

  it('carries an explicit id list unchanged', async () => {
    alwaysJson(200, BULK);
    await client().bulkDrafts('reject', {
      ids: ['01AAA0000000000000000000', '01BBB0000000000000000000'],
    });
    expect(JSON.parse(String(lastCall().init.body))).toEqual({
      action: 'reject',
      ids: ['01AAA0000000000000000000', '01BBB0000000000000000000'],
    });
  });

  it('keeps refused entries as data rather than collapsing them', async () => {
    alwaysJson(200, BULK);
    const result = await client().bulkDrafts('reject', {
      filter: { all: true },
    });
    // A batch is N acts reported honestly. A wrapper that threw on a
    // non-empty `refused`, or reported only a count, would make the one
    // situation the endpoint exists for — a drifted queue — unhandleable.
    expect(result.refused).toEqual([
      { id: '01CCC0000000000000000000', error: 'illegal-transition' },
    ]);
    expect(result.applied).toBe(2);
    expect(result.matched).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DraftPayload.proactiveReason
// ---------------------------------------------------------------------------

describe('s8 Sc3 client: DraftPayload admits proactiveReason', () => {
  const base = {
    id: '01AAA0000000000000000000',
    inboundGuid: null,
    chatGuid: CHAT,
    ruleId: null,
    adapterId: 'echo-1',
    idempotencyKey: 'k1',
    body: 'shall I book it?',
    originalBody: 'shall I book it?',
    state: 'pending' as const,
    stateChangedAt: '2026-09-01T12:00:00.000Z',
    expiresAt: '2026-09-01T16:00:00.000Z',
    createdAt: '2026-09-01T12:00:00.000Z',
  };

  it('reads the reason off a proactive draft with no cast', async () => {
    alwaysJson(200, {
      drafts: [{ ...base, proactiveReason: 'flight lands in an hour' }],
    });
    const drafts: DraftPayload[] = await client().listDrafts();
    // The point of the row is that this expression COMPILES. A `string |
    // undefined` read off a typed DTO is the difference between a GUI that
    // renders "why am I being asked this" and one whose author had to reach
    // for `as` and got the spelling wrong.
    const reason: string | undefined = drafts[0]?.proactiveReason;
    expect(reason).toBe('flight lands in an hour');
  });

  it('leaves the key ABSENT on an ordinary draft', async () => {
    alwaysJson(200, { drafts: [base] });
    const drafts: DraftPayload[] = await client().listDrafts();
    const draft = drafts[0] as unknown as Record<string, unknown>;
    // Absent, not present-and-undefined. The daemon omits the column when it
    // is NULL (exactOptionalPropertyTypes), the JSON therefore has no key,
    // and a DTO that promised `proactiveReason: string | undefined` as a
    // REQUIRED property would be describing bytes that are not on the wire.
    expect('proactiveReason' in draft).toBe(false);
    expect(drafts[0]?.proactiveReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the four lifecycle frames, narrowed
// ---------------------------------------------------------------------------

describe('s8 Sc3 client: the four lifecycle frames narrow on `event`', () => {
  /** Open a subscription and push raw frames at it, as the daemon would. */
  async function received(
    frames: readonly unknown[],
  ): Promise<GatewayEventPayload[]> {
    const seen: GatewayEventPayload[] = [];
    const pending = client().events((e) => seen.push(e));
    const socket = FakeSocket.instances.at(-1);
    if (socket === undefined) throw new Error('no socket was constructed');
    socket.fire('open');
    const subscription = await pending;
    for (const frame of frames) {
      socket.fire('message', Buffer.from(JSON.stringify(frame)));
    }
    subscription.close();
    return seen;
  }

  it('delivers all four with their §1.6 payloads intact', async () => {
    const seen = await received([
      { event: 'draft.expired', draftId: '01AAA0000000000000000000' },
      {
        event: 'draft.superseded',
        draftId: '01AAA0000000000000000000',
        byDraftId: '01BBB0000000000000000000',
      },
      {
        event: 'draft.redrafted',
        draftId: '01AAA0000000000000000000',
        newDraftId: '01CCC0000000000000000000',
      },
      { event: 'draft.requeued', draftId: '01AAA0000000000000000000' },
    ]);
    expect(seen.map((e) => e.event)).toEqual([
      'draft.expired',
      'draft.superseded',
      'draft.redrafted',
      'draft.requeued',
    ]);

    // Narrowed on the discriminant, read without a cast. `byDraftId` and
    // `newDraftId` are DIFFERENT words for the neighbouring facts and the
    // compiler is the thing that keeps them apart: a switch that read
    // `byDraftId` off a redraft would not build.
    const links: string[] = [];
    for (const e of seen) {
      if (e.event === 'draft.superseded') links.push(e.byDraftId);
      if (e.event === 'draft.redrafted') links.push(e.newDraftId);
    }
    expect(links).toEqual([
      '01BBB0000000000000000000',
      '01CCC0000000000000000000',
    ]);
  });

  it('a clamped draft.created carries clampedBy on the summary', async () => {
    const seen = await received([
      {
        event: 'draft.created',
        draft: {
          id: '01AAA0000000000000000000',
          chatGuid: CHAT,
          handle: '+15550000001',
          ruleId: null,
          adapterId: 'echo-1',
          body: 'on my way',
          state: 'pending',
          expiresAt: '2026-09-01T16:00:00.000Z',
          createdAt: '2026-09-01T12:00:00.000Z',
          clampedBy: 'rate-limited',
        },
      },
    ]);
    const first = seen[0];
    expect(first?.event).toBe('draft.created');
    if (first?.event !== 'draft.created') throw new Error('unreachable');
    // Same `GateDenyReason` union the deny frames carry (C-6), reached
    // through the same DTO. One cause is one word wherever it appears.
    expect(first.draft.clampedBy).toBe('rate-limited');
  });
});

// ---------------------------------------------------------------------------
// parseChatGuid
// ---------------------------------------------------------------------------

describe('s8 Sc3 client: parseChatGuid', () => {
  it('splits a 1:1 guid into handle, service and isGroup', () => {
    expect(parseChatGuid('iMessage;-;+15550000001')).toEqual({
      handle: '+15550000001',
      service: 'imessage',
      isGroup: false,
    });
    expect(parseChatGuid('SMS;-;+15550000002')).toEqual({
      handle: '+15550000002',
      service: 'sms',
      isGroup: false,
    });
  });

  it('reports a group guid as a group with no counterparty handle', () => {
    // A room has no single person on the other end, and inventing one is how
    // a GUI ends up captioning a group thread with whoever spoke last.
    expect(parseChatGuid('iMessage;+;chat123')).toEqual({
      handle: '',
      service: 'imessage',
      isGroup: true,
    });
  });

  it('keeps the separator out of the handle, including when it recurs', () => {
    // Split on the FIRST separator and take the rest verbatim: an email
    // handle can contain almost anything, and a `lastIndexOf` or a naive
    // `split(';-;')[1]` would truncate it.
    expect(parseChatGuid('iMessage;-;a;-;b').handle).toBe('a;-;b');
  });

  it('throws on a guid whose service it cannot name', () => {
    for (const bad of ['', 'garbage', 'whatsapp;-;+15550000003', ';-;x']) {
      expect(() => parseChatGuid(bad), bad).toThrow(/chat guid/i);
    }
  });

  it('is a pure function of its argument: no daemon, no socket', () => {
    // It is exported from a transport package, so it is worth pinning that
    // it is not secretly a request. A GUI calls this once per rendered row.
    parseChatGuid('iMessage;-;+15550000001');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

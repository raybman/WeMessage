/**
 * v2 A1: `GET /v1/threads`, the conversations list the v2 messenger opens on.
 *
 * The route is a read and only a read. It asks the `ChannelSource` it was
 * handed for one page, tags each row with that source's channel, strips
 * control characters at the wire (the reader hands back raw chat.db text),
 * and dates the answer with the daemon's own clock so the GUI can say
 * "as of 16:42" without reading a clock of its own.
 *
 * Three things it must never do, each a row below:
 *  - answer anyone but the operator. An adapter token is a credential for
 *    `hello` on `/v1/agent`, not a bearer, and a conversations list is the
 *    single most sensitive read this daemon serves.
 *  - be chat.db-shaped. iMessage is the first source, not the only shape a
 *    source can have (TN-imessage-is-just-a-source).
 *  - write. No audit row and no broadcast follow from looking at a list.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidCursorError,
  type ChannelSource,
  type ChatSummary,
  type ChatsQuery,
} from '@wemessage/core';
import {
  auditEvents,
  boot,
  cleanupHarness,
  get,
  post,
  T0,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

interface WireThread {
  chatGuid: string;
  channel: string;
  title: string;
  isGroup: boolean;
  lastLine: string | null;
  lastFromMe: boolean;
  lastAt: string;
}
interface ThreadsBody {
  threads: WireThread[];
  nextCursor: string | null;
  total: number;
  asOf: string;
}

const WIRE_KEYS = [
  'channel',
  'chatGuid',
  'isGroup',
  'lastAt',
  'lastFromMe',
  'lastLine',
  'title',
];

/** Minute `m` past 10:00 on the harness's day, as an ISO instant. */
const at = (m: number): string =>
  `2026-09-01T10:${String(m).padStart(2, '0')}:00.000Z`;

function guidOf(h: Harness, chatId: number): string {
  const row = h.fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

/** A 1:1 chat with its one participant, as Messages makes it. */
function oneToOne(h: Harness, handle: string): number {
  const id = h.fixture.addHandle(handle);
  return h.fixture.addChat({ identifier: handle, handleIds: [id] });
}

/**
 * Three conversations, seeded AFTER boot. The reader opens chat.db
 * read-only rather than immutable (see `createChatDbReader`), so it sees
 * rows written after it opened, exactly as it sees Messages write.
 */
function seedThree(h: Harness): {
  late: number;
  middle: number;
  early: number;
} {
  const early = oneToOne(h, '+15550000201');
  h.fixture.addMessage({ chatId: early, text: 'see you at six', at: at(1) });
  const late = oneToOne(h, 'friend@example.com');
  h.fixture.addMessage({ chatId: late, text: 'older line', at: at(0) });
  h.fixture.addMessage({ chatId: late, text: 'newest line', at: at(5) });
  const middle = oneToOne(h, '+15550000203');
  h.fixture.addMessage({
    chatId: middle,
    text: 'on my way',
    at: at(3),
    isFromMe: true,
  });
  return { late, middle, early };
}

function inject(
  h: Harness,
  url: string,
  authorization?: string,
  method: 'GET' | 'HEAD' = 'GET',
) {
  return h.server.app.inject({
    method,
    url,
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** A source with no chat.db behind it, recording what it was asked. */
function fakeSource(
  answer: (q: ChatsQuery) => Promise<{
    chats: ChatSummary[];
    nextCursor: string | null;
    total: number;
  }>,
): ChannelSource & { asked: ChatsQuery[] } {
  const asked: ChatsQuery[] = [];
  return {
    channel: 'imessage',
    asked,
    listChats: (q) => {
      asked.push(q);
      return answer(q);
    },
    readChatPage: () => Promise.reject(new Error('not this route')),
  };
}

describe('GET /v1/threads (v2 A1)', () => {
  it('lists conversations newest-first, each tagged with its channel, dated by the daemon clock', async () => {
    const h = await boot({ threads: true });
    const { late, middle, early } = seedThree(h);

    const res = await get(h, '/v1/threads');
    expect(res.statusCode).toBe(200);
    const body = res.json() as ThreadsBody;

    // The harness's own boot chat has no messages, so it is not a
    // conversation yet and is neither listed nor counted.
    expect(body.threads.map((t) => t.chatGuid)).toEqual([
      guidOf(h, late),
      guidOf(h, middle),
      guidOf(h, early),
    ]);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBeNull();
    expect(body.asOf).toBe(T0);
    expect(body.threads[0]).toEqual({
      chatGuid: 'iMessage;-;friend@example.com',
      channel: 'imessage',
      title: 'friend@example.com',
      isGroup: false,
      lastLine: 'newest line',
      lastFromMe: false,
      lastAt: at(5),
    });
    expect(body.threads[1]).toMatchObject({
      lastLine: 'on my way',
      lastFromMe: true,
    });
    for (const t of body.threads)
      expect(Object.keys(t).sort()).toEqual(WIRE_KEYS);
  });

  it('asOf is the daemon clock at the moment of the answer', async () => {
    const h = await boot({ threads: true });
    seedThree(h);
    h.clockCtl.advance(90_000);
    const body = (await get(h, '/v1/threads')).json() as ThreadsBody;
    expect(body.asOf).toBe('2026-09-01T12:01:30.000Z');
  });

  it('pages with an opaque cursor: every conversation exactly once, in order', async () => {
    const h = await boot({ threads: true });
    const ids = ['+15550000211', '+15550000212', '+15550000213'].map((p) =>
      oneToOne(h, p),
    );
    ids.push(oneToOne(h, 'pager@example.com'), oneToOne(h, '+15550000215'));
    ids.forEach((chatId, i) =>
      h.fixture.addMessage({ chatId, text: `line ${i}`, at: at(10 + i) }),
    );

    const whole = (await get(h, '/v1/threads')).json() as ThreadsBody;
    expect(whole.total).toBe(5);

    const walked: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string =
        cursor === null
          ? '/v1/threads?limit=2'
          : `/v1/threads?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await get(h, url);
      expect(res.statusCode).toBe(200);
      const body = res.json() as ThreadsBody;
      expect(body.total).toBe(5);
      walked.push(...body.threads.map((t) => t.chatGuid));
      pageSizes.push(body.threads.length);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pageSizes).toEqual([2, 2, 1]);
    expect(walked).toEqual(whole.threads.map((t) => t.chatGuid));
  });

  it('limit defaults to 100 and the page says there is more', async () => {
    const h = await boot({ threads: true });
    h.fixture.db.transaction(() => {
      for (let i = 0; i < 101; i += 1) {
        const handle = `+1555200${String(i).padStart(4, '0')}`;
        const chatId = oneToOne(h, handle);
        h.fixture.addMessage({
          chatId,
          text: handle,
          at: `2026-09-01T09:${String(i % 60).padStart(2, '0')}:00.000Z`,
        });
      }
    })();
    const body = (await get(h, '/v1/threads')).json() as ThreadsBody;
    expect(body.threads).toHaveLength(100);
    expect(body.total).toBe(101);
    expect(body.nextCursor).not.toBeNull();
  });

  it.each([
    ['limit=0'],
    ['limit=201'],
    ['limit=abc'],
    ['limit=1.5'],
    ['cursor='],
    ['bogus=1'],
  ])('400 invalid-query for %s', async (query) => {
    const h = await boot({ threads: true });
    const res = await get(h, `/v1/threads?${query}`);
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      detail: { issues: unknown[] };
    };
    expect(body.error).toBe('invalid-query');
    expect(body.detail.issues.length).toBeGreaterThan(0);
  });

  it('400 invalid-cursor for a cursor the reader did not mint', async () => {
    const h = await boot({ threads: true });
    seedThree(h);
    const forged = Buffer.from('1.02', 'utf8').toString('base64url');
    for (const cursor of ['nope', forged]) {
      const res = await get(
        h,
        `/v1/threads?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(res.statusCode, cursor).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid-cursor' });
    }
  });

  it('503 source-unavailable when the source fails, and the failure does not leak', async () => {
    // A path-shaped message, deliberately neither the live one nor a home
    // directory: the S3 guard forbids the first in any test file, and the
    // public-repo sweep forbids the second anywhere in the tree.
    const rejecting = fakeSource(() =>
      Promise.reject(
        new Error(
          'EPERM: operation not permitted, open /private/var/fixture/chat.db',
        ),
      ),
    );
    const h = await boot({ threads: rejecting });
    const res = await get(h, '/v1/threads');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'source-unavailable' });
    expect(res.body).not.toContain('EPERM');
    expect(res.body).not.toContain('/private/');
    expect(res.body).not.toContain('chat.db');

    // A source that throws before it returns a promise is the same answer.
    const throwing: ChannelSource = {
      channel: 'imessage',
      listChats: () => {
        throw new Error('not connected');
      },
      readChatPage: () => {
        throw new Error('not connected');
      },
    };
    const h2 = await boot({ threads: throwing });
    const res2 = await get(h2, '/v1/threads');
    expect(res2.statusCode).toBe(503);
    expect(res2.json()).toEqual({ error: 'source-unavailable' });
  });

  it('is behind the operator bearer: none, a wrong one and an adapter token are all 401', async () => {
    const h = await boot({ threads: true });
    seedThree(h);
    const minted = await post(h, '/v1/adapters', {
      id: 'echo',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;
    expect(adapterToken).toMatch(/^wm_[0-9a-f]{64}$/);

    for (const authorization of [
      undefined,
      `Bearer wm_${'0'.repeat(64)}`,
      `Bearer ${adapterToken}`,
      adapterToken,
    ]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await inject(h, '/v1/threads', authorization, method);
        expect(res.statusCode, `${method} ${String(authorization)}`).toBe(401);
        expect(res.body).not.toContain('friend@example.com');
      }
    }
    // Non-vacuous: the operator's own bearer is answered.
    const ok = await inject(h, '/v1/threads', h.headers.authorization);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('friend@example.com');
  });

  it('HEAD answers 200 with no body', async () => {
    const h = await boot({ threads: true });
    seedThree(h);
    const res = await inject(h, '/v1/threads', h.headers.authorization, 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('strips control characters from titles and previews, and keeps tabs and newlines', async () => {
    const h = await boot({ threads: true });
    const a = h.fixture.addHandle('+15550000221');
    const b = h.fixture.addHandle('+15550000222');
    const crew = h.fixture.addGroupChat([a, b], {
      displayName: 'Crew\u0007 chat\u009b',
    });
    h.fixture.addMessage({
      chatId: crew,
      handleId: a,
      text: 'red\u001b[31m alert\tnow\nok\u0000\u007f',
      at: at(7),
    });
    const body = (await get(h, '/v1/threads')).json() as ThreadsBody;
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]?.title).toBe('Crew chat');
    expect(body.threads[0]?.lastLine).toBe('red[31m alert\tnow\nok');
    expect(body.threads[0]?.isGroup).toBe(true);
  });

  it('reads and only reads: no audit row and no broadcast follow a listing', async () => {
    const h = await boot({ threads: true });
    seedThree(h);
    const auditBefore = auditEvents(h.store).length;
    const broadcastsBefore = h.broadcasts.length;
    await get(h, '/v1/threads');
    await get(h, '/v1/threads?limit=1');
    await inject(h, '/v1/threads', h.headers.authorization, 'HEAD');
    expect(auditEvents(h.store).length).toBe(auditBefore);
    expect(h.broadcasts.length).toBe(broadcastsBefore);
  });

  it('is not served unless the daemon was handed a source', async () => {
    const h = await boot();
    const res = await get(h, '/v1/threads');
    expect(res.statusCode).toBe(404);
  });
});

describe('TN-imessage-is-just-a-source (v2 A1)', () => {
  /**
   * The seam phase B plugs into. A source with no chat.db behind it, no
   * ROWIDs and no Apple epoch, serves the same wire shape through the same
   * route, and the route forwards the query it was asked without
   * interpreting the cursor: whether a cursor is valid is the source's
   * call, and the source says so with core's `InvalidCursorError`.
   */
  const ROW: ChatSummary = {
    chatGuid: 'any;-;+15550000231',
    title: '+15550000231',
    isGroup: false,
    lastLine: 'from a source with no database',
    lastFromMe: false,
    lastAt: '2026-09-01T11:59:00.000Z',
  };

  it('serves a page from a source that is not chat.db, and forwards the query verbatim', async () => {
    const source = fakeSource(() =>
      Promise.resolve({ chats: [ROW], nextCursor: 'opaque-2', total: 7 }),
    );
    const h = await boot({ threads: source });
    // The harness's chat.db has a real conversation in it. It must not
    // appear: the route reads its source, never the database.
    seedThree(h);

    const first = await get(h, '/v1/threads');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      threads: [{ ...ROW, channel: 'imessage' }],
      nextCursor: 'opaque-2',
      total: 7,
      asOf: T0,
    });

    await get(h, '/v1/threads?limit=2&cursor=opaque-2');
    expect(source.asked[0]).toStrictEqual({ limit: 100 });
    expect(source.asked[1]).toStrictEqual({ limit: 2, cursor: 'opaque-2' });
  });

  it('puts the DTO on the wire, not whatever else the source returned', async () => {
    const leaky = { ...ROW, rowid: 42, rawDate: '781012800000000000' };
    const source = fakeSource(() =>
      Promise.resolve({ chats: [leaky], nextCursor: null, total: 1 }),
    );
    const h = await boot({ threads: source });
    const body = (await get(h, '/v1/threads')).json() as ThreadsBody;
    expect(Object.keys(body.threads[0] ?? {}).sort()).toEqual(WIRE_KEYS);
  });

  it("maps the source's InvalidCursorError to 400, whatever the source", async () => {
    const source = fakeSource(() =>
      Promise.reject(new InvalidCursorError('not one of mine')),
    );
    const h = await boot({ threads: source });
    const res = await get(h, '/v1/threads?cursor=whatever');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid-cursor' });
  });
});

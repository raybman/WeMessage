/**
 * v2 A2: `GET /v1/threads/:guid/messages`, one page of one conversation.
 *
 * The same contract as the list (A1), one level down. A read and only a
 * read: the rows come from `source.readChatPage`, control characters are
 * stripped at the wire, and the answer is dated by the daemon's clock. The
 * route owns the refusals the source cannot make: a query with both a
 * cursor and a date jump is a 400 before anything is read. The source owns
 * the rest: a chat it has never seen is a 404, a cursor it did not mint a
 * 400, and a source that is down a 503 that names nothing.
 *
 * A transcript is more sensitive than the list it opens from, so the
 * operator bearer guards it the same way: an adapter token is not a bearer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidCursorError,
  UnknownChatError,
  type ChannelSource,
  type TurnsPage,
  type TurnsQuery,
} from '@wemessage/core';
import {
  auditEvents,
  boot,
  cleanupHarness,
  get,
  post,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

interface WireTurn {
  guid: string;
  from: 'me' | 'them';
  kind: string;
  text: string | null;
  at: string;
  handle?: string;
  editedAt?: string;
  unsentAt?: string;
  attachments: number;
  service?: string;
  delivery?: { state: string; at: string | null; errorCode?: number } | null;
  reactions?: { kind: string; from: string; handle?: string }[];
  files?: {
    name: string | null;
    mime: string | null;
    uti: string | null;
    bytes: number | null;
    sticker: boolean;
    hidden: boolean;
  }[];
}
interface MessagesBody {
  chatGuid: string;
  channel: string;
  turns: WireTurn[];
  nextBefore: string | null;
  asOf: string;
}

/** Minute `m` past 10:00 on the harness's day, as an ISO instant. */
const at = (m: number): string =>
  `2026-09-01T10:${String(m).padStart(2, '0')}:00.000Z`;

function guidOf(h: Harness, chatId: number): string {
  const row = h.fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

const pathOf = (guid: string, query = ''): string =>
  `/v1/threads/${encodeURIComponent(guid)}/messages${query}`;

/** A 1:1 chat with three turns, seeded after boot. */
function seedChat(h: Harness): { guid: string; guids: string[] } {
  const handleId = h.fixture.addHandle('friend@example.com');
  const chatId = h.fixture.addChat({
    identifier: 'friend@example.com',
    handleIds: [handleId],
  });
  const guids = [
    h.fixture.addMessage({ chatId, handleId, text: 'lunch?', at: at(1) }),
    h.fixture.addMessage({ chatId, text: 'sure', isFromMe: true, at: at(2) }),
    h.fixture.addMessage({ chatId, handleId, text: 'noon then', at: at(3) }),
  ].map((m) => m.guid);
  return { guid: guidOf(h, chatId), guids };
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
  answer: (q: TurnsQuery) => Promise<TurnsPage>,
): ChannelSource & { asked: TurnsQuery[] } {
  const asked: TurnsQuery[] = [];
  return {
    channel: 'imessage',
    asked,
    listChats: () => Promise.reject(new Error('not this route')),
    readChatPage: (q) => {
      asked.push(q);
      return answer(q);
    },
  };
}

describe('GET /v1/threads/:guid/messages (v2 A2)', () => {
  it('answers the end of the conversation, oldest first, tagged and dated by the daemon', async () => {
    const h = await boot({ threads: true });
    const { guid, guids } = seedChat(h);

    const res = await get(h, pathOf(guid));

    expect(res.statusCode).toBe(200);
    const body = res.json() as MessagesBody;
    expect(body.chatGuid).toBe(guid);
    expect(body.channel).toBe('imessage');
    expect(body.nextBefore).toBeNull();
    expect(body.asOf).toBe('2026-09-01T12:00:00.000Z');
    expect(body.turns.map((t) => t.guid)).toEqual(guids);
    expect(body.turns[0]).toEqual({
      guid: guids[0],
      from: 'them',
      kind: 'text',
      text: 'lunch?',
      at: at(1),
      handle: 'friend@example.com',
      attachments: 0,
      service: 'imessage',
      reactions: [],
      files: [],
    });
    expect(body.turns[1]).toEqual({
      guid: guids[1],
      from: 'me',
      kind: 'text',
      text: 'sure',
      at: at(2),
      attachments: 0,
      service: 'imessage',
      delivery: null,
      reactions: [],
      files: [],
    });
  });

  it('pages back with nextBefore: every turn exactly once', async () => {
    const h = await boot({ threads: true });
    const { guid, guids } = seedChat(h);

    const first = (
      await get(h, pathOf(guid, '?limit=2'))
    ).json() as MessagesBody;
    expect(first.turns.map((t) => t.guid)).toEqual(guids.slice(1));
    expect(first.nextBefore).not.toBeNull();
    const older = (
      await get(
        h,
        pathOf(
          guid,
          `?limit=2&before=${encodeURIComponent(first.nextBefore ?? '')}`,
        ),
      )
    ).json() as MessagesBody;
    expect(older.turns.map((t) => t.guid)).toEqual(guids.slice(0, 1));
    expect(older.nextBefore).toBeNull();
  });

  it('until jumps to a date: the page ends at the newest turn at or before it', async () => {
    const h = await boot({ threads: true });
    const { guid, guids } = seedChat(h);

    const body = (
      await get(h, pathOf(guid, `?until=${encodeURIComponent(at(2))}`))
    ).json() as MessagesBody;

    expect(body.turns.map((t) => t.guid)).toEqual(guids.slice(0, 2));
  });

  it('400 invalid-query for a cursor AND a date jump together, before anything is read', async () => {
    const source = fakeSource(() =>
      Promise.resolve({ turns: [], nextBefore: null }),
    );
    const h = await boot({ threads: source });

    const res = await get(
      h,
      pathOf(
        'any;-;+15550000301',
        `?before=abc&until=${encodeURIComponent(at(1))}`,
      ),
    );

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid-query');
    expect(source.asked).toEqual([]);
  });

  it('400 invalid-query for a bad limit, a bad instant or an unknown parameter', async () => {
    const source = fakeSource(() =>
      Promise.resolve({ turns: [], nextBefore: null }),
    );
    const h = await boot({ threads: source });
    for (const q of [
      '?limit=0',
      '?limit=201',
      '?limit=ten',
      '?until=yesterday',
      '?until=2026-09-01',
      '?before=',
      '?page=2',
    ]) {
      const res = await get(h, pathOf('any;-;+15550000302', q));
      expect(res.statusCode, q).toBe(400);
      expect((res.json() as { error: string }).error, q).toBe('invalid-query');
    }
    expect(source.asked).toEqual([]);
  });

  it('limit defaults to 50, and the query reaches the source verbatim', async () => {
    const source = fakeSource(() =>
      Promise.resolve({ turns: [], nextBefore: null }),
    );
    const h = await boot({ threads: source });

    await get(h, pathOf('any;+;chat303'));
    await get(h, pathOf('any;+;chat303', '?limit=7&before=opaque-cursor'));
    await get(
      h,
      pathOf('any;+;chat303', `?until=${encodeURIComponent(at(4))}`),
    );

    expect(source.asked).toEqual([
      { chatGuid: 'any;+;chat303', limit: 50 },
      { chatGuid: 'any;+;chat303', limit: 7, before: 'opaque-cursor' },
      { chatGuid: 'any;+;chat303', limit: 50, until: at(4) },
    ]);
  });

  it('400 invalid-cursor for a cursor the reader did not mint', async () => {
    const h = await boot({ threads: true });
    const { guid } = seedChat(h);

    const res = await get(h, pathOf(guid, '?before=not-a-cursor'));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid-cursor' });
  });

  it('404 unknown-chat for a chat the source has never seen', async () => {
    const h = await boot({ threads: true });
    seedChat(h);

    const res = await get(h, pathOf('iMessage;-;+15550009999'));

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'unknown-chat' });
  });

  it("maps the source's own refusals, whatever the source", async () => {
    const unknown = fakeSource(() => Promise.reject(new UnknownChatError()));
    const h = await boot({ threads: unknown });
    expect((await get(h, pathOf('x;-;y'))).statusCode).toBe(404);

    const forged = fakeSource(() => Promise.reject(new InvalidCursorError()));
    const h2 = await boot({ threads: forged });
    expect((await get(h2, pathOf('x;-;y', '?before=z'))).statusCode).toBe(400);
  });

  it('503 source-unavailable when the source fails, and the failure does not leak', async () => {
    const failing = fakeSource(() =>
      Promise.reject(
        new Error(
          'EPERM: open /private/var/db/chat.db: operation not permitted',
        ),
      ),
    );
    const h = await boot({ threads: failing });
    const res = await get(h, pathOf('any;-;+15550000310'));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'source-unavailable' });
    expect(res.body).not.toContain('EPERM');
    expect(res.body).not.toContain('chat.db');

    const throwing: ChannelSource = {
      channel: 'imessage',
      listChats: () => Promise.reject(new Error('not this route')),
      readChatPage: () => {
        throw new Error('not connected');
      },
    };
    const h2 = await boot({ threads: throwing });
    const res2 = await get(h2, pathOf('any;-;+15550000310'));
    expect(res2.statusCode).toBe(503);
    expect(res2.json()).toEqual({ error: 'source-unavailable' });
  });

  it('is behind the operator bearer: none, a wrong one and an adapter token are all 401', async () => {
    const h = await boot({ threads: true });
    const { guid } = seedChat(h);
    const minted = await post(h, '/v1/adapters', {
      id: 'echo',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(minted.statusCode).toBe(201);
    const adapterToken = (minted.json() as { token: string }).token;

    for (const authorization of [
      undefined,
      `Bearer wm_${'0'.repeat(64)}`,
      `Bearer ${adapterToken}`,
      adapterToken,
    ]) {
      for (const method of ['GET', 'HEAD'] as const) {
        const res = await inject(h, pathOf(guid), authorization, method);
        expect(res.statusCode, `${method} ${String(authorization)}`).toBe(401);
        expect(res.body).not.toContain('lunch?');
      }
    }
    const ok = await inject(h, pathOf(guid), h.headers.authorization);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('lunch?');
  });

  it('HEAD answers 200 with no body', async () => {
    const h = await boot({ threads: true });
    const { guid } = seedChat(h);
    const res = await inject(h, pathOf(guid), h.headers.authorization, 'HEAD');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });

  it('strips control characters from text and handles, keeps tabs and newlines, and a text of only controls is none', async () => {
    const h = await boot({ threads: true });
    const handleId = h.fixture.addHandle('+15550000320');
    const chatId = h.fixture.addChat({
      identifier: '+15550000320',
      handleIds: [handleId],
    });
    h.fixture.addMessage({
      chatId,
      handleId,
      text: 'red\u001b[31m alert\tnow\nok\u0000\u007f',
      at: at(1),
    });
    h.fixture.addMessage({ chatId, handleId, text: '\u0007\u009b', at: at(2) });
    h.fixture.db
      .prepare('UPDATE handle SET id = ? WHERE ROWID = ?')
      .run('+1555\u001b0000320', handleId);

    const body = (
      await get(h, pathOf(guidOf(h, chatId)))
    ).json() as MessagesBody;

    expect(body.turns.map((t) => t.text)).toEqual([
      'red[31m alert\tnow\nok',
      null,
    ]);
    expect(body.turns[0]?.handle).toBe('+15550000320');
  });

  it('puts the DTO on the wire, not whatever else the source returned', async () => {
    const source = fakeSource(() =>
      Promise.resolve({
        turns: [
          {
            guid: 'G1',
            from: 'them',
            kind: 'text',
            text: 'hi',
            at: at(1),
            attachments: 0,
            rowid: 42,
            attributedBody: 'secret',
            // v2 Phase B: per-board meta is fake-daemon-only, never real wire.
            meta: { reactions: [{ emoji: 'x', from: 'them' }] },
          } as TurnsPage['turns'][number],
        ],
        nextBefore: null,
        debug: 'internal',
      } as TurnsPage),
    );
    const h = await boot({ threads: source });

    const body = (await get(h, pathOf('any;-;+15550000330'))).json() as Record<
      string,
      unknown
    >;

    expect(Object.keys(body).sort()).toEqual([
      'asOf',
      'channel',
      'chatGuid',
      'nextBefore',
      'turns',
    ]);
    expect(Object.keys((body.turns as object[])[0] ?? {}).sort()).toEqual([
      'at',
      'attachments',
      'from',
      'guid',
      'kind',
      'text',
    ]);
  });

  describe('rich turns (v2 F4)', () => {
    /** A source answering one page of exactly these turns. */
    const pageOf = (turns: TurnsPage['turns']) =>
      fakeSource(() => Promise.resolve({ turns, nextBefore: null }));
    const file = {
      name: 'IMG_0412.heic',
      mime: 'image/heic',
      uti: 'public.heic',
      bytes: 2_400_000,
      sticker: false,
      hidden: false,
    };

    it('wireCarriesServiceDeliveryReactionsFiles, from a real chat.db', async () => {
      const h = await boot({ threads: true });
      const handleId = h.fixture.addHandle('+15550100001');
      const chatId = h.fixture.addChat({
        identifier: '+15550100001',
        handleIds: [handleId],
      });
      const mine = h.fixture.addAttachmentOnly({
        chatId,
        isFromMe: true,
        at: at(55),
        isSent: true,
        isDelivered: true,
        dateDelivered: at(56),
        dateRead: at(57),
        filename: '~/Library/Messages/Attachments/ab/12/F00D/IMG_0412.heic',
        transferName: 'IMG_0412.heic',
        mimeType: 'image/heic',
        uti: 'public.heic',
        totalBytes: 2_400_000,
      });
      h.fixture.addTapback(mine.guid, 2000, {
        chatId,
        handleId,
        at: at(58),
      });

      const body = (
        await get(h, pathOf(guidOf(h, chatId)))
      ).json() as MessagesBody;

      expect(body.turns).toEqual([
        {
          guid: mine.guid,
          from: 'me',
          kind: 'attachment-only',
          text: null,
          at: at(55),
          attachments: 1,
          service: 'imessage',
          delivery: { state: 'read', at: at(57) },
          reactions: [{ kind: 'love', from: 'them', handle: '+15550100001' }],
          files: [file],
        },
      ]);
    });

    it('inboundNeverHasDelivery, even when a source hands one over', async () => {
      const h = await boot({
        threads: pageOf([
          {
            guid: 'G1',
            from: 'them',
            kind: 'text',
            text: 'hi',
            at: at(1),
            attachments: 0,
            service: 'sms',
            delivery: { state: 'read', at: at(2) },
          },
          {
            guid: 'G2',
            from: 'me',
            kind: 'text',
            text: 'yo',
            at: at(3),
            attachments: 0,
            service: 'sms',
            delivery: { state: 'failed', at: null, errorCode: 22 },
          },
        ]),
      });

      const body = (
        await get(h, pathOf('any;-;+15550000350'))
      ).json() as MessagesBody;

      expect(body.turns[0]).not.toHaveProperty('delivery');
      expect(body.turns[1]?.delivery).toEqual({
        state: 'failed',
        at: null,
        errorCode: 22,
      });
    });

    it('a source that does not say stays silent: no key is invented', async () => {
      const h = await boot({
        threads: pageOf([
          {
            guid: 'G1',
            from: 'me',
            kind: 'text',
            text: 'hi',
            at: at(1),
            attachments: 0,
          },
        ]),
      });
      const body = (
        await get(h, pathOf('any;-;+15550000351'))
      ).json() as MessagesBody;
      expect(Object.keys(body.turns[0] ?? {}).sort()).toEqual([
        'at',
        'attachments',
        'from',
        'guid',
        'kind',
        'text',
      ]);
    });

    it('fileNameControlStrippedAndCapped, and reaction handles are stripped', async () => {
      const h = await boot({
        threads: pageOf([
          {
            guid: 'G1',
            from: 'them',
            kind: 'attachment-only',
            text: null,
            at: at(1),
            attachments: 4,
            reactions: [
              { kind: 'like', from: 'them', handle: '+1555\u001b0100002' },
            ],
            files: [
              {
                ...file,
                name: 'a\u0000b\nc\t\u001b.pdf',
                mime: 'app\u0007/pdf',
              },
              { ...file, name: `${'n'.repeat(400)}.pdf` },
              { ...file, name: '\u0001\u0002' },
              { ...file, name: null, mime: null, uti: null, bytes: null },
            ],
          },
        ]),
      });

      const body = (
        await get(h, pathOf('any;-;+15550000352'))
      ).json() as MessagesBody;
      const names = body.turns[0]?.files?.map((f) => f.name);

      expect(names?.[0]).toBe('abc.pdf');
      expect(body.turns[0]?.files?.[0]?.mime).toBe('app/pdf');
      expect(names?.[1]).toHaveLength(255);
      expect(names?.[2]).toBeNull();
      expect(body.turns[0]?.files?.[3]).toEqual({
        name: null,
        mime: null,
        uti: null,
        bytes: null,
        sticker: false,
        hidden: false,
      });
      expect(body.turns[0]?.reactions).toEqual([
        { kind: 'like', from: 'them', handle: '+15550100002' },
      ]);
    });

    it('noPathOnWire: no "/" and no "Library" in any file name', async () => {
      const h = await boot({
        threads: pageOf([
          {
            guid: 'G1',
            from: 'them',
            kind: 'attachment-only',
            text: null,
            at: at(1),
            attachments: 2,
            files: [
              {
                ...file,
                name: '~/Library/Messages/Attachments/ab/12/F00D/x.pdf',
              },
              { ...file, name: 'a/b/../' },
            ],
          },
        ]),
      });

      const body = (
        await get(h, pathOf('any;-;+15550000353'))
      ).json() as MessagesBody;
      const names = (body.turns[0]?.files ?? []).map((f) => f.name);

      expect(names).toEqual(['x.pdf', null]);
      for (const n of names) {
        expect(n ?? '').not.toMatch(/\/|Library/);
      }
    });
  });

  it('reads and only reads: no audit row and no broadcast follow a page view', async () => {
    const h = await boot({ threads: true });
    const { guid } = seedChat(h);
    const auditBefore = auditEvents(h.store).length;
    const broadcastsBefore = h.broadcasts.length;
    await get(h, pathOf(guid));
    await get(h, pathOf(guid, '?limit=1'));
    await inject(h, pathOf(guid), h.headers.authorization, 'HEAD');
    expect(auditEvents(h.store).length).toBe(auditBefore);
    expect(h.broadcasts.length).toBe(broadcastsBefore);
  });

  it('is not served unless the daemon was handed a source', async () => {
    const h = await boot();
    const res = await get(h, pathOf('any;-;+15550000340'));
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('unknown-chat');
  });
});

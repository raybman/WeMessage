/**
 * v2 A1: `listChats`, the conversations page behind `GET /v1/threads`
 * (the v2 body extension to the chat.db port).
 *
 * One statement answers the page AND the total, so the count on screen and
 * the rows under it are the same snapshot of chat.db. Chats are ordered by
 * their newest REAL message: a tapback is a reaction to a message, not a
 * message, and a chat that only ever received reactions has nothing to show.
 * Paging is keyset on (last message date, chat ROWID), so a page boundary
 * that lands inside a tie neither repeats a chat nor skips one, and the
 * cursor is opaque: anything the reader did not mint is refused as an
 * `InvalidCursorError`, never guessed at.
 *
 * The reader hands back RAW text. Sanitizing is the wire's job (the route
 * strips control characters), so these rows assert what chat.db says.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import { InvalidCursorError, type Clock } from '@wemessage/core';

const FIXED_NOW = '2026-03-02T12:00:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

/** Minute `m` past 10:00 on 2026-03-01, as an ISO instant. */
const at = (m: number): string =>
  `2026-03-01T10:${String(m).padStart(2, '0')}:00.000Z`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshFixture(): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wm-list-chats-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = createChatDb(join(dir, 'chat.db'));
  cleanups.push(() => fixture.close());
  return fixture;
}

function readerOver(fixture: ChatDbFixture): IngestChatDbReader {
  const reader = createChatDbReader(fixture.path, { clock: fakeClock });
  cleanups.push(() => reader.close());
  return reader;
}

function guidOf(fixture: ChatDbFixture, chatId: number): string {
  const row = fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

/** A 1:1 chat with one participant handle wired up, as Messages makes it. */
function oneToOne(fixture: ChatDbFixture, handle: string): number {
  const h = fixture.addHandle(handle);
  return fixture.addChat({ identifier: handle, handleIds: [h] });
}

const cursorOf = (raw: string): string =>
  Buffer.from(raw, 'utf8').toString('base64url');

describe('listChats (v2 A1)', () => {
  it('lists chats newest-first by their last message, total in the same answer', async () => {
    const f = freshFixture();
    const early = oneToOne(f, '+15550000001');
    f.addMessage({ chatId: early, text: 'see you at six', at: at(1) });
    const late = oneToOne(f, 'friend@example.com');
    f.addMessage({ chatId: late, text: 'older line', at: at(0) });
    f.addMessage({ chatId: late, text: 'newest line', at: at(5) });
    const middle = oneToOne(f, '+15550000003');
    f.addMessage({ chatId: middle, text: 'middle', at: at(3) });

    const page = await readerOver(f).listChats({ limit: 100 });

    expect(page.chats.map((c) => c.chatGuid)).toEqual([
      guidOf(f, late),
      guidOf(f, middle),
      guidOf(f, early),
    ]);
    expect(page.total).toBe(3);
    expect(page.nextCursor).toBeNull();
    expect(page.chats[0]).toEqual({
      chatGuid: 'iMessage;-;friend@example.com',
      title: 'friend@example.com',
      isGroup: false,
      lastLine: 'newest line',
      lastFromMe: false,
      lastAt: at(5),
    });
  });

  it('marks a last message the operator sent as lastFromMe', async () => {
    const f = freshFixture();
    const chat = oneToOne(f, '+15550000010');
    f.addMessage({ chatId: chat, text: 'their question', at: at(1) });
    f.addMessage({
      chatId: chat,
      text: 'my answer',
      at: at(2),
      isFromMe: true,
    });

    const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

    expect(row?.lastLine).toBe('my answer');
    expect(row?.lastFromMe).toBe(true);
  });

  describe('title', () => {
    it('a named group is its display name', async () => {
      const f = freshFixture();
      const g = f.addGroupChat(
        [f.addHandle('+15550000021'), f.addHandle('+15550000022')],
        { displayName: 'Climbing crew' },
      );
      f.addMessage({ chatId: g, text: 'rope?', at: at(1) });

      const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(row?.title).toBe('Climbing crew');
      expect(row?.isGroup).toBe(true);
    });

    it('an unnamed group is its participants, sorted, comma-separated', async () => {
      const f = freshFixture();
      const g = f.addGroupChat([
        f.addHandle('+15550000033'),
        f.addHandle('alex@example.com'),
        f.addHandle('+15550000031'),
      ]);
      f.addMessage({ chatId: g, text: 'hi all', at: at(1) });

      const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(row?.title).toBe('+15550000031, +15550000033, alex@example.com');
    });

    it('an EMPTY display name counts as no name (chat.db stores "" for unnamed)', async () => {
      const f = freshFixture();
      const g = f.addGroupChat([f.addHandle('+15550000041')], {
        displayName: '',
      });
      f.addMessage({ chatId: g, text: 'x', at: at(1) });
      const one = f.addChat({
        identifier: '+15550000042',
        displayName: '   ',
      });
      f.addMessage({ chatId: one, text: 'y', at: at(2) });

      const rows = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(rows.map((r) => r.title)).toEqual([
        '+15550000042',
        '+15550000041',
      ]);
    });

    it('a 1:1 chat is its identifier, and a group with nobody left is its room', async () => {
      const f = freshFixture();
      const one = oneToOne(f, '+15550000051');
      f.addMessage({ chatId: one, text: 'a', at: at(1) });
      const empty = f.addGroupChat([]);
      f.addMessage({ chatId: empty, text: 'b', at: at(2) });

      const rows = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(rows[1]?.title).toBe('+15550000051');
      expect(rows[0]?.title).toMatch(/^chat[0-9a-f]{12}$/);
    });
  });

  describe('lastLine', () => {
    it('decodes an attributedBody-only last message (the macOS 26 shape)', async () => {
      const f = freshFixture();
      const chat = oneToOne(f, '+15550000061');
      f.addMessage({
        chatId: chat,
        attributedBodyText: 'typed on macOS 26',
        at: at(1),
      });

      const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(row?.lastLine).toBe('typed on macOS 26');
    });

    it('drops the attachment placeholder, and an attachment alone is no line at all', async () => {
      const f = freshFixture();
      const withText = oneToOne(f, '+15550000071');
      f.addMessage({ chatId: withText, text: '￼ look at this ', at: at(2) });
      const bare = oneToOne(f, '+15550000072');
      f.addMessage({ chatId: bare, text: '￼', at: at(1) });

      const rows = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(rows.map((r) => r.lastLine)).toEqual(['look at this', null]);
    });

    it('an unsent last message is null, and still dates the chat', async () => {
      const f = freshFixture();
      const chat = oneToOne(f, '+15550000081');
      f.addMessage({ chatId: chat, text: 'kept', at: at(1) });
      const gone = f.addMessage({ chatId: chat, text: 'oops', at: at(4) });
      f.unsendMessage(gone.guid, { at: at(5) });

      const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(row?.lastLine).toBeNull();
      expect(row?.lastAt).toBe(at(4));
    });

    it('whitespace alone is no line', async () => {
      const f = freshFixture();
      const chat = oneToOne(f, '+15550000091');
      f.addMessage({ chatId: chat, text: ' \n\t ', at: at(1) });

      const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(row?.lastLine).toBeNull();
    });
  });

  describe('what counts as a conversation', () => {
    it('a tapback is not the last message: the reaction neither dates nor previews', async () => {
      const f = freshFixture();
      const chat = oneToOne(f, '+15550000101');
      const target = f.addMessage({
        chatId: chat,
        text: 'the joke',
        at: at(1),
      });
      f.addTapback(target.guid, 2001, { chatId: chat, at: at(9) });
      const other = oneToOne(f, '+15550000102');
      f.addMessage({ chatId: other, text: 'in between', at: at(5) });

      const rows = (await readerOver(f).listChats({ limit: 10 })).chats;

      expect(rows.map((r) => r.lastLine)).toEqual(['in between', 'the joke']);
      expect(rows[1]?.lastAt).toBe(at(1));
    });

    it('a chat with no messages, or only reactions, is not listed and not counted', async () => {
      const f = freshFixture();
      oneToOne(f, '+15550000111');
      const reactionsOnly = oneToOne(f, '+15550000112');
      f.addTapback('5D1E0F00-0000-4000-8000-000000000000', 2000, {
        chatId: reactionsOnly,
        at: at(3),
      });
      const real = oneToOne(f, '+15550000113');
      f.addMessage({ chatId: real, text: 'the only real one', at: at(1) });

      const page = await readerOver(f).listChats({ limit: 10 });

      expect(page.chats.map((c) => c.chatGuid)).toEqual([guidOf(f, real)]);
      expect(page.total).toBe(1);
    });

    it('an empty chat.db is an empty page with a zero total', async () => {
      const f = freshFixture();

      const page = await readerOver(f).listChats({ limit: 10 });

      expect(page).toEqual({ chats: [], nextCursor: null, total: 0 });
    });
  });

  it('reads group-ness from the guid, including the macOS 26 "any" prefix', async () => {
    const f = freshFixture();
    const shapes = [
      f.addChat({ identifier: '+15550000121' }),
      f.addChat({ identifier: '+15550000122', guidPrefix: 'any' }),
      f.addGroupChat([f.addHandle('+15550000123')]),
      f.addGroupChat([f.addHandle('+15550000124')], { guidPrefix: 'any' }),
    ];
    shapes.forEach((chatId, i) =>
      f.addMessage({ chatId, text: `m${String(i)}`, at: at(i + 1) }),
    );

    const rows = (await readerOver(f).listChats({ limit: 10 })).chats;
    const byGuid = new Map(rows.map((r) => [r.chatGuid, r.isGroup]));

    expect(shapes.map((c) => byGuid.get(guidOf(f, c)))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(guidOf(f, shapes[3] as number)).toMatch(/^any;\+;chat/);
  });

  it('dates a seconds-era row (pre-High Sierra chat.db) as seconds, not nanoseconds', async () => {
    const f = freshFixture();
    const chat = oneToOne(f, '+15550000131');
    const m = f.addMessage({ chatId: chat, text: 'from 2016', at: at(1) });
    const seconds = 500_000_000;
    f.db
      .prepare('UPDATE message SET date = ? WHERE ROWID = ?')
      .run(seconds, m.rowid);
    f.db
      .prepare(
        'UPDATE chat_message_join SET message_date = ? WHERE message_id = ?',
      )
      .run(seconds, m.rowid);

    const [row] = (await readerOver(f).listChats({ limit: 10 })).chats;

    expect(row?.lastAt).toBe(
      new Date((978_307_200 + seconds) * 1000).toISOString(),
    );
  });

  describe('paging', () => {
    /** Five chats, two of them tied on the exact same last instant. */
    function fiveWithATie(f: ChatDbFixture): void {
      const plan: Array<[string, number]> = [
        ['+15550000141', 1],
        ['+15550000142', 4],
        ['+15550000143', 4],
        ['+15550000144', 2],
        ['+15550000145', 7],
      ];
      for (const [handle, minute] of plan) {
        const chat = oneToOne(f, handle);
        f.addMessage({ chatId: chat, text: handle, at: at(minute) });
      }
    }

    it('walks every chat exactly once across pages, through a tie, with one total', async () => {
      const f = freshFixture();
      fiveWithATie(f);
      const reader = readerOver(f);
      const everything = await reader.listChats({ limit: 100 });

      const seen: string[] = [];
      const totals: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await reader.listChats({
          limit: 2,
          ...(cursor !== null ? { cursor } : {}),
        });
        seen.push(...page.chats.map((c) => c.chatGuid));
        totals.push(page.total);
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(everything.chats.map((c) => c.chatGuid));
      expect(new Set(seen).size).toBe(5);
      expect(totals).toEqual([5, 5, 5]);
    });

    it('breaks a tie by the newer chat first, so the order is total', async () => {
      const f = freshFixture();
      fiveWithATie(f);

      const rows = (await readerOver(f).listChats({ limit: 100 })).chats;

      expect(rows.map((r) => r.lastLine)).toEqual([
        '+15550000145',
        '+15550000143',
        '+15550000142',
        '+15550000144',
        '+15550000141',
      ]);
    });

    it('a full last page still ends with a null cursor', async () => {
      const f = freshFixture();
      for (let i = 0; i < 4; i += 1) {
        const chat = oneToOne(f, `+1555000015${String(i)}`);
        f.addMessage({ chatId: chat, text: 'x', at: at(i + 1) });
      }
      const reader = readerOver(f);

      const first = await reader.listChats({ limit: 2 });
      const second = await reader.listChats({
        limit: 2,
        cursor: first.nextCursor ?? 'missing',
      });

      expect(first.nextCursor).not.toBeNull();
      expect(second.chats).toHaveLength(2);
      expect(second.nextCursor).toBeNull();
    });

    it('caps a page at 200 rows whatever the caller asks for', async () => {
      const f = freshFixture();
      f.db.transaction(() => {
        for (let i = 0; i < 205; i += 1) {
          const chat = f.addChat({
            identifier: `+1555100${String(i).padStart(4, '0')}`,
          });
          f.addMessage({ chatId: chat, text: 'x' });
        }
      })();

      const page = await readerOver(f).listChats({ limit: 10_000 });

      expect(page.chats).toHaveLength(200);
      expect(page.total).toBe(205);
      expect(page.nextCursor).not.toBeNull();
    });

    it('refuses any cursor it did not mint', async () => {
      const f = freshFixture();
      fiveWithATie(f);
      const reader = readerOver(f);
      const minted = (await reader.listChats({ limit: 2 })).nextCursor;
      expect(minted).not.toBeNull();

      const forged = [
        'nope',
        `${minted ?? ''}=`,
        cursorOf('1.2.3'),
        cursorOf('abc.1'),
        cursorOf('01.2'),
        cursorOf('1.02'),
        cursorOf('-1.2'),
        cursorOf('1.'),
        cursorOf('.1'),
        cursorOf('99999999999999999999.1'),
        cursorOf('1.99999999999999999999'),
      ];
      for (const cursor of forged) {
        await expect(
          reader.listChats({ limit: 2, cursor }),
          cursor,
        ).rejects.toBeInstanceOf(InvalidCursorError);
      }
    });
  });
});

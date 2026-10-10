/**
 * v2 A2: `readChatPage`, one page of one conversation behind
 * `GET /v1/threads/:guid/messages`.
 *
 * The transcript reads newest first and pages backwards. Paging is keyset on
 * (message date, message ROWID), so a page boundary inside a tie neither
 * repeats a turn nor skips one, and messages that arrive while someone walks
 * back never shift the older pages under them. A reaction belongs to the
 * message it reacts to and a rename is not something anyone said, so neither
 * is a turn. Looking at a transcript writes nothing: a row that fails to
 * decode is drawn as no text, and is NOT reported to the decode-failure sink
 * that the ingest loop audits.
 *
 * The reader hands back RAW text; the route sanitizes. These rows assert what
 * chat.db says.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import {
  InvalidCursorError,
  UnknownChatError,
  type Clock,
  type TranscriptTurn,
} from '@wemessage/core';

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
  const dir = mkdtempSync(join(tmpdir(), 'wm-chat-page-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = createChatDb(join(dir, 'chat.db'));
  cleanups.push(() => fixture.close());
  return fixture;
}

function readerOver(
  fixture: ChatDbFixture,
  onDecodeFailed?: () => void,
): IngestChatDbReader {
  const reader = createChatDbReader(fixture.path, {
    clock: fakeClock,
    ...(onDecodeFailed !== undefined ? { onDecodeFailed } : {}),
  });
  cleanups.push(() => reader.close());
  return reader;
}

function guidOf(fixture: ChatDbFixture, chatId: number): string {
  const row = fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

/** A 1:1 chat with its participant handle, as Messages makes it. */
function oneToOne(
  fixture: ChatDbFixture,
  handle: string,
): { chatId: number; handleId: number; guid: string } {
  const handleId = fixture.addHandle(handle);
  const chatId = fixture.addChat({ identifier: handle, handleIds: [handleId] });
  return { chatId, handleId, guid: guidOf(fixture, chatId) };
}

/** Walk every older page from the newest; returns guids oldest first. */
async function walkAll(
  reader: IngestChatDbReader,
  chatGuid: string,
  limit: number,
  between?: (page: number) => void,
): Promise<{ guids: string[]; pages: number }> {
  const chunks: string[][] = [];
  let before: string | null = null;
  let pages = 0;
  do {
    const page = await reader.readChatPage({
      chatGuid,
      limit,
      ...(before !== null ? { before } : {}),
    });
    chunks.unshift(page.turns.map((t) => t.guid));
    before = page.nextBefore;
    pages += 1;
    between?.(pages);
  } while (before !== null && pages < 10_000);
  return { guids: chunks.flat(), pages };
}

describe('readChatPage (v2 A2)', () => {
  it('returns the end of the conversation, oldest turn first, both directions', async () => {
    const f = freshFixture();
    const c = oneToOne(f, '+15550002001');
    const a = f.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'are you around',
      at: at(1),
    });
    const b = f.addMessage({
      chatId: c.chatId,
      text: 'yes, what is up',
      isFromMe: true,
      at: at(2),
    });

    const page = await readerOver(f).readChatPage({
      chatGuid: c.guid,
      limit: 50,
    });

    expect(page.nextBefore).toBeNull();
    expect(page.turns).toEqual<TranscriptTurn[]>([
      {
        guid: a.guid,
        from: 'them',
        kind: 'text',
        text: 'are you around',
        at: at(1),
        handle: '+15550002001',
        attachments: 0,
        service: 'imessage',
        reactions: [],
        files: [],
      },
      {
        guid: b.guid,
        from: 'me',
        kind: 'text',
        text: 'yes, what is up',
        at: at(2),
        attachments: 0,
        service: 'imessage',
        delivery: null,
        reactions: [],
        files: [],
      },
    ]);
  });

  it('never leaks a turn from another chat', async () => {
    const f = freshFixture();
    const mine = oneToOne(f, '+15550002011');
    const other = oneToOne(f, '+15550002012');
    f.addMessage({ chatId: mine.chatId, text: 'mine', at: at(1) });
    f.addMessage({ chatId: other.chatId, text: 'not mine', at: at(2) });

    const page = await readerOver(f).readChatPage({
      chatGuid: mine.guid,
      limit: 50,
    });

    expect(page.turns.map((t) => t.text)).toEqual(['mine']);
  });

  describe('what counts as a turn', () => {
    it('a tapback is not a turn, and neither is a group event', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002021');
      const said = f.addMessage({ chatId: c.chatId, text: 'said', at: at(1) });
      f.addTapback(said.guid, 2000, { chatId: c.chatId, at: at(2) });
      const rename = f.addMessage({ chatId: c.chatId, text: null, at: at(3) });
      f.db
        .prepare('UPDATE message SET item_type = 2 WHERE ROWID = ?')
        .run(rename.rowid);

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 50,
      });

      expect(page.turns.map((t) => t.guid)).toEqual([said.guid]);
    });

    it('decodes an attributedBody-only row (the macOS 26 shape)', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002031');
      f.addMessage({
        chatId: c.chatId,
        attributedBodyText: 'typed on macOS 26',
        isFromMe: true,
        at: at(1),
      });

      const [turn] = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turn?.text).toBe('typed on macOS 26');
      expect(turn?.kind).toBe('text');
    });

    it('an edit reads as its newest revision, the same text the agent context reads', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002041');
      const m = f.addMessage({ chatId: c.chatId, text: 'frist', at: at(1) });
      f.editMessage(m.guid, 'first', { at: at(2) });
      const reader = readerOver(f);

      const [turn] = (await reader.readChatPage({ chatGuid: c.guid, limit: 5 }))
        .turns;
      const [agentTurn] = await reader.readChatTurns({
        chatGuid: c.guid,
        limit: 5,
      });

      expect(turn?.editedAt).toBe(at(2));
      expect(turn?.text).toBe(agentTurn?.text);
      expect(turn?.text).not.toBe('frist');
    });

    it('an unsent message keeps its place with no text', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002051');
      const m = f.addMessage({ chatId: c.chatId, text: 'oops', at: at(1) });
      f.unsendMessage(m.guid, { at: at(3) });

      const [turn] = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turn).toMatchObject({
        guid: m.guid,
        text: null,
        at: at(1),
        unsentAt: at(3),
      });
    });

    it('an attachment alone is attachment-only; words beside one stay text', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002061');
      const bare = f.addAttachmentOnly({ chatId: c.chatId, at: at(1) });
      const captioned = f.addMessage({
        chatId: c.chatId,
        text: '￼ look at this ',
        cacheHasAttachments: true,
        at: at(2),
      });
      f.addAttachment(captioned.rowid);
      f.addAttachment(captioned.rowid);

      const turns = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turns.map((t) => [t.guid, t.kind, t.text, t.attachments])).toEqual(
        [
          [bare.guid, 'attachment-only', null, 1],
          [captioned.guid, 'text', 'look at this', 2],
        ],
      );
    });

    it('a voice message is audio', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002071');
      f.addAudioMessage({ chatId: c.chatId, at: at(1) });

      const [turn] = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turn?.kind).toBe('audio');
      expect(turn?.attachments).toBe(1);
    });

    it('a row that fails to decode is no text, and the failure is NOT reported', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002081');
      const m = f.addMessage({ chatId: c.chatId, text: 'x', at: at(1) });
      f.db
        .prepare(
          'UPDATE message SET text = NULL, attributedBody = ? WHERE ROWID = ?',
        )
        .run(Buffer.from('not a typedstream at all'), m.rowid);
      const sink = vi.fn();

      const [turn] = (
        await readerOver(f, sink).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turn).toMatchObject({ guid: m.guid, text: null, kind: 'text' });
      expect(sink).not.toHaveBeenCalled();
    });
  });

  describe('rich turns (v2 F4)', () => {
    it('reactionsFoldedNotTurns: a tapback rides its target, mine included', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002301');
      const said = f.addMessage({
        chatId: c.chatId,
        handleId: c.handleId,
        text: 'said',
        at: at(1),
      });
      f.addTapback(said.guid, 2000, {
        chatId: c.chatId,
        handleId: c.handleId,
        at: at(2),
      });
      f.addTapback(said.guid, 2001, {
        chatId: c.chatId,
        isFromMe: true,
        part: 1,
        at: at(3),
      });

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 50,
      });

      expect(page.turns.map((t) => t.guid)).toEqual([said.guid]);
      expect(page.turns[0]?.reactions).toEqual([
        { kind: 'love', from: 'them', handle: '+15550002301' },
        { kind: 'like', from: 'me' },
      ]);
    });

    it('cursorUnchangedByReactions: 450 turns and 300 tapbacks walk as the 450', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002311');
      const turns = f.db.transaction(() => {
        const out: string[] = [];
        for (let i = 0; i < 450; i += 1) {
          const m = f.addMessage({ chatId: c.chatId, text: `t${String(i)}` });
          out.push(m.guid);
          if (i % 3 === 0) {
            f.addTapback(m.guid, 2000 + (i % 6), {
              chatId: c.chatId,
              handleId: c.handleId,
            });
            if (i % 9 === 0) {
              f.addTapback(m.guid, 3000 + (i % 6), {
                chatId: c.chatId,
                handleId: c.handleId,
              });
            }
          }
        }
        return out;
      })();
      const tapbacks = f.db
        .prepare(
          'SELECT COUNT(*) AS n FROM message WHERE associated_message_type != 0',
        )
        .get() as { n: number };
      expect(tapbacks.n).toBe(150 + 50);
      // Top up to 300 tapbacks with removals that clear nothing.
      f.db.transaction(() => {
        for (let i = 0; i < 100; i += 1) {
          f.addTapback(turns[i * 4 + 1] ?? '', 3003, {
            chatId: c.chatId,
            handleId: c.handleId,
          });
        }
      })();

      const { guids, pages } = await walkAll(readerOver(f), c.guid, 50);

      expect(pages).toBe(9);
      expect(guids).toEqual(turns);
    });

    it('reactionOnOlderPageArrivesWithIt', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002321');
      const old = f.addMessage({ chatId: c.chatId, text: 'old', at: at(1) });
      for (let i = 0; i < 5; i += 1) {
        f.addMessage({ chatId: c.chatId, text: 'newer', at: at(2 + i) });
      }
      f.addTapback(old.guid, 2003, {
        chatId: c.chatId,
        handleId: c.handleId,
        at: at(20),
      });
      const reader = readerOver(f);

      const head = await reader.readChatPage({ chatGuid: c.guid, limit: 5 });
      const older = await reader.readChatPage({
        chatGuid: c.guid,
        limit: 5,
        before: head.nextBefore ?? 'missing',
      });

      expect(head.turns.every((t) => t.reactions?.length === 0)).toBe(true);
      expect(older.turns.map((t) => [t.guid, t.reactions])).toEqual([
        [old.guid, [{ kind: 'laugh', from: 'them', handle: '+15550002321' }]],
      ]);
    });

    it('filesEqualCount: names are transfer names, never the stored path', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002331');
      const three = f.addMessage({ chatId: c.chatId, text: null, at: at(1) });
      for (const [name, mime, uti] of [
        ['Quarterly plan.pdf', 'application/pdf', 'com.adobe.pdf'],
        ['IMG_0412.heic', 'image/heic', 'public.heic'],
        ['clip.mov', 'video/quicktime', 'com.apple.quicktime-movie'],
      ] as const) {
        f.addAttachment(three.rowid, {
          transferName: name,
          filename: `~/Library/Messages/Attachments/ab/12/F00D-${name}.bin`,
          mimeType: mime,
          uti,
          totalBytes: 2048,
        });
      }
      const many = f.addMessage({ chatId: c.chatId, text: null, at: at(2) });
      for (let i = 0; i < 25; i += 1) f.addAttachment(many.rowid);

      const turns = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turns[0]?.attachments).toBe(3);
      expect(turns[0]?.files).toEqual([
        {
          name: 'Quarterly plan.pdf',
          mime: 'application/pdf',
          uti: 'com.adobe.pdf',
          bytes: 2048,
          sticker: false,
          hidden: false,
        },
        {
          name: 'IMG_0412.heic',
          mime: 'image/heic',
          uti: 'public.heic',
          bytes: 2048,
          sticker: false,
          hidden: false,
        },
        {
          name: 'clip.mov',
          mime: 'video/quicktime',
          uti: 'com.apple.quicktime-movie',
          bytes: 2048,
          sticker: false,
          hidden: false,
        },
      ]);
      expect(turns[1]?.attachments).toBe(25);
      expect(turns[1]?.files).toHaveLength(20);
      expect(JSON.stringify(turns)).not.toMatch(/Library|F00D/);
    });

    it('hiddenAndStickerFlagged, and a NULL name or size is null', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002341');
      const m = f.addMessage({ chatId: c.chatId, text: null, at: at(1) });
      f.addAttachment(m.rowid, {
        isSticker: true,
        transferName: 'sticker.heic',
      });
      f.addAttachment(m.rowid, {
        hidden: true,
        transferName: null,
        totalBytes: 0,
      });

      const [turn] = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(
        turn?.files?.map((x) => [x.name, x.bytes, x.sticker, x.hidden]),
      ).toEqual([
        ['sticker.heic', 1024, true, false],
        [null, null, false, true],
      ]);
    });

    it('serviceUnknownWhenNull; SMS and RCS read as themselves', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002351');
      const none = f.addMessage({ chatId: c.chatId, text: 'a', at: at(1) });
      f.db
        .prepare('UPDATE message SET service = NULL WHERE ROWID = ?')
        .run(none.rowid);
      f.addSmsMessage({ chatId: c.chatId, text: 'b', at: at(2) });
      const rcs = f.addMessage({ chatId: c.chatId, text: 'c', at: at(3) });
      // Apple's raw column casing, set in SQL: the input side of mapService.
      f.db
        .prepare("UPDATE message SET service = 'RCS' WHERE ROWID = ?")
        .run(rcs.rowid);
      f.addMessage({ chatId: c.chatId, text: 'd', at: at(4) });

      const turns = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turns.map((t) => t.service)).toEqual([
        'unknown',
        'sms',
        'rcs',
        'imessage',
      ]);
    });

    it('delivery rides outbound turns only, and a group never reaches read', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002361');
      f.addMessage({
        chatId: c.chatId,
        handleId: c.handleId,
        text: 'in',
        at: at(1),
      });
      f.addMessage({
        chatId: c.chatId,
        text: 'read',
        isFromMe: true,
        isSent: true,
        isDelivered: true,
        dateDelivered: at(3),
        dateRead: at(4),
        at: at(2),
      });
      f.addMessage({
        chatId: c.chatId,
        text: 'failed',
        isFromMe: true,
        error: 22,
        at: at(5),
      });
      const h2 = f.addHandle('+15550002362');
      const group = f.addGroupChat([c.handleId, h2]);
      f.addMessage({
        chatId: group,
        text: 'to the group',
        isFromMe: true,
        isSent: true,
        dateDelivered: at(7),
        dateRead: at(8),
        at: at(6),
      });
      const reader = readerOver(f);

      const turns = (await reader.readChatPage({ chatGuid: c.guid, limit: 5 }))
        .turns;
      const [groupTurn] = (
        await reader.readChatPage({ chatGuid: guidOf(f, group), limit: 5 })
      ).turns;

      expect(
        turns.map((t) => ('delivery' in t ? t.delivery : 'absent')),
      ).toEqual([
        'absent',
        { state: 'read', at: at(4) },
        { state: 'failed', at: null, errorCode: 22 },
      ]);
      expect(groupTurn?.delivery).toEqual({ state: 'delivered', at: at(7) });
    });
  });

  describe('dates', () => {
    it('dates a seconds-era row as seconds, and orders it before every modern row', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002091');
      const modern = f.addMessage({ chatId: c.chatId, text: 'now', at: at(1) });
      const old = f.addMessage({ chatId: c.chatId, text: '2016', at: at(2) });
      const seconds = 500_000_000;
      f.db
        .prepare('UPDATE message SET date = ? WHERE ROWID = ?')
        .run(seconds, old.rowid);
      f.db
        .prepare(
          'UPDATE chat_message_join SET message_date = ? WHERE message_id = ?',
        )
        .run(seconds, old.rowid);

      const turns = (
        await readerOver(f).readChatPage({ chatGuid: c.guid, limit: 5 })
      ).turns;

      expect(turns.map((t) => t.guid)).toEqual([old.guid, modern.guid]);
      expect(turns[0]?.at).toBe(
        new Date((978_307_200 + seconds) * 1000).toISOString(),
      );
    });
  });

  describe('paging', () => {
    it('walks every turn exactly once, through a tie, in order', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002101');
      const minutes = [1, 2, 4, 4, 4, 5, 7];
      const added = minutes.map((m, i) =>
        f.addMessage({ chatId: c.chatId, text: `m${String(i)}`, at: at(m) }),
      );
      const reader = readerOver(f);

      const { guids, pages } = await walkAll(reader, c.guid, 2);

      expect(pages).toBe(4);
      expect(guids).toEqual(added.map((m) => m.guid));
    });

    it('a full first page that is the whole chat ends with a null cursor', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002111');
      for (let i = 0; i < 4; i += 1) {
        f.addMessage({ chatId: c.chatId, text: 'x', at: at(i + 1) });
      }

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 4,
      });

      expect(page.turns).toHaveLength(4);
      expect(page.nextBefore).toBeNull();
    });

    it('1,000 turns, 50 arriving mid-walk: the walk is still the 1,000, and a head refetch adds the 50', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002121');
      const original = f.db.transaction(() =>
        Array.from({ length: 1_000 }, (_, i) =>
          f.addMessage({ chatId: c.chatId, text: `old ${String(i)}` }),
        ),
      )();
      const reader = readerOver(f);
      let arrived: string[] = [];

      const { guids } = await walkAll(reader, c.guid, 200, (page) => {
        if (page !== 2) return;
        arrived = f.db
          .transaction(() =>
            Array.from({ length: 50 }, (_, i) =>
              f.addMessage({ chatId: c.chatId, text: `new ${String(i)}` }),
            ),
          )()
          .map((m) => m.guid);
      });
      const head = await reader.readChatPage({ chatGuid: c.guid, limit: 200 });

      expect(guids).toEqual(original.map((m) => m.guid));
      const union = new Set([...guids, ...head.turns.map((t) => t.guid)]);
      expect(union.size).toBe(1_050);
      expect(head.turns.slice(-50).map((t) => t.guid)).toEqual(arrived);
    });

    it('caps a page at 200 turns whatever the caller asks for', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002131');
      f.db.transaction(() => {
        for (let i = 0; i < 205; i += 1) {
          f.addMessage({ chatId: c.chatId, text: 'x' });
        }
      })();

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 10_000,
      });

      expect(page.turns).toHaveLength(200);
      expect(page.nextBefore).not.toBeNull();
    });
  });

  describe('until (date jump)', () => {
    it('ends the page at the newest turn at or before the instant, and pages back from there', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002141');
      const added = [1, 3, 5, 7, 9].map((m) =>
        f.addMessage({ chatId: c.chatId, text: `at ${String(m)}`, at: at(m) }),
      );
      const reader = readerOver(f);

      const page = await reader.readChatPage({
        chatGuid: c.guid,
        limit: 2,
        until: at(6),
      });
      const older = await reader.readChatPage({
        chatGuid: c.guid,
        limit: 2,
        before: page.nextBefore ?? 'missing',
      });

      expect(page.turns.map((t) => t.guid)).toEqual([
        added[1]?.guid,
        added[2]?.guid,
      ]);
      expect(older.turns.map((t) => t.guid)).toEqual([added[0]?.guid]);
      expect(older.nextBefore).toBeNull();
    });

    it('an instant on the exact minute of a turn includes that turn', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002151');
      f.addMessage({ chatId: c.chatId, text: 'early', at: at(1) });
      const exact = f.addMessage({
        chatId: c.chatId,
        text: 'exact',
        at: at(4),
      });
      f.addMessage({ chatId: c.chatId, text: 'later', at: at(8) });

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 1,
        until: at(4),
      });

      expect(page.turns.map((t) => t.guid)).toEqual([exact.guid]);
    });

    it('an instant in the modern era still reaches seconds-era turns behind it', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002161');
      const old = f.addMessage({ chatId: c.chatId, text: '2016', at: at(1) });
      const seconds = 500_000_000;
      f.db
        .prepare('UPDATE message SET date = ? WHERE ROWID = ?')
        .run(seconds, old.rowid);
      f.db
        .prepare(
          'UPDATE chat_message_join SET message_date = ? WHERE message_id = ?',
        )
        .run(seconds, old.rowid);
      f.addMessage({ chatId: c.chatId, text: 'modern', at: at(9) });

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 5,
        until: at(5),
      });

      expect(page.turns.map((t) => t.guid)).toEqual([old.guid]);
    });

    it('an instant before a seconds-era turn does not include it', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002171');
      const old = f.addMessage({ chatId: c.chatId, text: '2016', at: at(1) });
      const seconds = 500_000_000; // 2016-11-05
      f.db
        .prepare('UPDATE message SET date = ? WHERE ROWID = ?')
        .run(seconds, old.rowid);
      f.db
        .prepare(
          'UPDATE chat_message_join SET message_date = ? WHERE message_id = ?',
        )
        .run(seconds, old.rowid);

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 5,
        until: '2015-01-01T00:00:00.000Z',
      });

      expect(page.turns).toEqual([]);
      expect(page.nextBefore).toBeNull();
    });
  });

  describe('refusals', () => {
    it('a chat it has never seen rejects as UnknownChatError', async () => {
      const f = freshFixture();
      oneToOne(f, '+15550002181');

      await expect(
        readerOver(f).readChatPage({
          chatGuid: 'iMessage;-;+15550009999',
          limit: 5,
        }),
      ).rejects.toBeInstanceOf(UnknownChatError);
    });

    it('a chat with no turns yet is an empty page, not an unknown chat', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002191');

      const page = await readerOver(f).readChatPage({
        chatGuid: c.guid,
        limit: 5,
      });

      expect(page).toEqual({ turns: [], nextBefore: null });
    });

    it('refuses any cursor it did not mint, including a conversations-list cursor', async () => {
      const f = freshFixture();
      const c = oneToOne(f, '+15550002201');
      for (let i = 0; i < 3; i += 1) {
        f.addMessage({ chatId: c.chatId, text: 'x', at: at(i + 1) });
      }
      const other = oneToOne(f, '+15550002202');
      f.addMessage({ chatId: other.chatId, text: 'y', at: at(9) });
      const reader = readerOver(f);
      const minted = (await reader.readChatPage({ chatGuid: c.guid, limit: 1 }))
        .nextBefore;
      const listCursor = (await reader.listChats({ limit: 1 })).nextCursor;
      expect(minted).not.toBeNull();
      expect(listCursor).not.toBeNull();

      for (const before of [
        listCursor ?? '',
        `${minted ?? ''}=`,
        'not-a-cursor',
        Buffer.from('t.1', 'utf8').toString('base64url'),
        Buffer.from('t.01.2', 'utf8').toString('base64url'),
        Buffer.from('1.2', 'utf8').toString('base64url'),
        Buffer.from('t.99999999999999999999.1', 'utf8').toString('base64url'),
      ]) {
        await expect(
          reader.readChatPage({ chatGuid: c.guid, limit: 1, before }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
      }
    });
  });
});

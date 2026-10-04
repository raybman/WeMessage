/**
 * s3-execution.md Part 2 Scenario 4 — Post-send verification
 * (ChatDbReader body extension #2, §1.5): `findOutboundMessage`.
 *
 * `findOutboundMessage({chatGuid, text, sinceIso})` answers "does an
 * outbound copy of this exact text already exist in this chat, at/after
 * sendStartedAt" — the read half of the verify-don't-trust-the-exit-code
 * design (§2.2.2 pinned: the AppleScript backend's `accepted:true` is never
 * proof of delivery). Every predicate is load-bearing on its own: an inbound
 * copy of the same text, the same text sent too early, a different text, or
 * a match sitting in a different chat must each independently fail to
 * match.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:30:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

const SEND_STARTED_AT = '2026-01-05T12:00:00.000Z';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshFixture(): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wm-find-outbound-'));
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

function chatGuidOf(fixture: ChatDbFixture, chatId: number): string {
  const row = fixture.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return row.guid;
}

describe('findOutboundMessage (Scenario 4)', () => {
  it('matches an outbound message with exact text at/after sendStartedAt, returning its guid', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    const chatId = fixture.addChat({ identifier: '+15551234567' });
    const sent = fixture.addSelfMessage({
      chatId,
      handleId: h,
      text: 'confirmed for 3pm',
      at: SEND_STARTED_AT, // exactly at sendStartedAt: >= must include the boundary
    });
    const reader = readerOver(fixture);

    const result = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'confirmed for 3pm',
      sinceIso: SEND_STARTED_AT,
    });

    expect(result).toEqual({ guid: sent.guid });
  });

  it('an inbound copy of the same text does not match (is_from_me predicate)', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    const chatId = fixture.addChat({ identifier: '+15551234567' });
    fixture.addMessage({
      chatId,
      handleId: h,
      text: 'confirmed for 3pm',
      at: '2026-01-05T12:00:01.000Z',
      isFromMe: false,
    });
    const reader = readerOver(fixture);

    const result = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'confirmed for 3pm',
      sinceIso: SEND_STARTED_AT,
    });

    expect(result).toBeNull();
  });

  it('the same text sent 5s before sendStartedAt does not match (sinceIso predicate)', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    const chatId = fixture.addChat({ identifier: '+15551234567' });
    fixture.addSelfMessage({
      chatId,
      handleId: h,
      text: 'confirmed for 3pm',
      at: '2026-01-05T11:59:55.000Z', // 5s before SEND_STARTED_AT
    });
    const reader = readerOver(fixture);

    const result = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'confirmed for 3pm',
      sinceIso: SEND_STARTED_AT,
    });

    expect(result).toBeNull();
  });

  it('a different text does not match (exact-text predicate)', async () => {
    // Stored text CONTAINS the queried text as a substring on purpose: a
    // LIKE-prefix/substring relaxation of the exact-text predicate would
    // incorrectly match this row (teeth: relax `=` to LIKE -> this must fail).
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    const chatId = fixture.addChat({ identifier: '+15551234567' });
    fixture.addSelfMessage({
      chatId,
      handleId: h,
      text: 'confirmed for 3pm, see you then',
      at: '2026-01-05T12:00:01.000Z',
    });
    const reader = readerOver(fixture);

    const result = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'confirmed for 3pm',
      sinceIso: SEND_STARTED_AT,
    });

    expect(result).toBeNull();
  });

  it('a matching row in a different chat does not match (chatGuid predicate)', async () => {
    const fixture = freshFixture();
    const h2 = fixture.addHandle('+15559876543');
    const targetChat = fixture.addChat({ identifier: '+15551234567' });
    const otherChat = fixture.addChat({ identifier: '+15559876543' });
    fixture.addSelfMessage({
      chatId: otherChat,
      handleId: h2,
      text: 'confirmed for 3pm',
      at: '2026-01-05T12:00:01.000Z',
    });
    const reader = readerOver(fixture);

    const result = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, targetChat),
      text: 'confirmed for 3pm',
      sinceIso: SEND_STARTED_AT,
    });

    expect(result).toBeNull();
  });
});

/**
 * s10 Slice 1 (P0-a): on macOS 26 the body of an outbound message lives in
 * attributedBody and `text` is NULL (live chat.db, 90 days: 10,238 of 10,264
 * plain outbound rows), and every chat guid is "any;-;". The old predicate
 * bound `m.text = ?` and so never matched a real send. These rows use the
 * real shape: an any;-; chat and a typedstream blob, no text column.
 */
describe('findOutboundMessage on the macOS 26 shape (s10 Slice 1)', () => {
  function any1to1(fixture: ChatDbFixture): {
    chatId: number;
    handleId: number;
  } {
    const handleId = fixture.addHandle('+15550001111');
    const chatId = fixture.addChat({
      identifier: '+15550001111',
      guidPrefix: 'any',
      handleIds: [handleId],
    });
    return { chatId, handleId };
  }

  it('matches a text-NULL row whose attributedBody decodes to the exact body', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    const sent = fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyText: 'see you at 3 \u{1F44D}',
      at: SEND_STARTED_AT,
    });
    const guid = chatGuidOf(fixture, chatId);
    expect(guid.startsWith('any;-;')).toBe(true);
    const row = fixture.db
      .prepare('SELECT text FROM message WHERE guid = ?')
      .get(sent.guid) as { text: string | null };
    expect(row.text).toBeNull();

    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: guid,
      text: 'see you at 3 \u{1F44D}',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toEqual({ guid: sent.guid });
  });

  it('does not match a decoded body that is only a prefix of the draft', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyText: 'see you at 3',
      at: SEND_STARTED_AT,
    });
    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'see you at 3pm',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toBeNull();
  });

  it('does not match a draft that is only a prefix of the decoded body', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyText: 'see you at 3pm',
      at: SEND_STARTED_AT,
    });
    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'see you at 3',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toBeNull();
  });

  it('does not match a decoded body sent before sendStartedAt', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyText: 'see you at 3pm',
      at: '2026-01-05T11:59:59.000Z',
    });
    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'see you at 3pm',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toBeNull();
  });

  it('does not match an INBOUND attributedBody copy of the same text', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    fixture.addMessage({
      chatId,
      handleId,
      attributedBodyText: 'see you at 3pm',
      at: SEND_STARTED_AT,
    });
    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'see you at 3pm',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toBeNull();
  });

  it('treats a malformed attributedBody as no match, never a throw', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyFixture: 'malformed-truncated',
      at: SEND_STARTED_AT,
    });
    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'see you at 3pm',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toBeNull();
  });

  it('finds the OLDEST match in a window crowded by 60 newer outbound rows (no LIMIT)', async () => {
    // Live chat.db: 51 outbound rows in one chat inside one 15 min bucket.
    // A late sweep looks for the first attempt, which is the oldest row.
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    const target = fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyText: 'the one that landed',
      at: '2026-01-05T12:00:01.000Z',
    });
    for (let i = 0; i < 60; i += 1) {
      fixture.addSelfMessage({
        chatId,
        handleId,
        attributedBodyText: `chatter ${i}`,
        at: `2026-01-05T12:0${1 + Math.floor(i / 30)}:${String(10 + (i % 30)).padStart(2, '0')}.000Z`,
      });
    }
    const result = await readerOver(fixture).findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'the one that landed',
      sinceIso: SEND_STARTED_AT,
    });
    expect(result).toEqual({ guid: target.guid });
  });

  it('prefers the text column when both text and attributedBody are present', async () => {
    const fixture = freshFixture();
    const { chatId, handleId } = any1to1(fixture);
    const m = fixture.addSelfMessage({
      chatId,
      handleId,
      attributedBodyText: 'blob says this',
      at: SEND_STARTED_AT,
    });
    fixture.db
      .prepare('UPDATE message SET text = ? WHERE guid = ?')
      .run('column says this', m.guid);
    const reader = readerOver(fixture);
    const byColumn = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'column says this',
      sinceIso: SEND_STARTED_AT,
    });
    const byBlob = await reader.findOutboundMessage({
      chatGuid: chatGuidOf(fixture, chatId),
      text: 'blob says this',
      sinceIso: SEND_STARTED_AT,
    });
    expect(byColumn).toEqual({ guid: m.guid });
    expect(byBlob).toBeNull();
  });
});

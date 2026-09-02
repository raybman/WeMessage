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

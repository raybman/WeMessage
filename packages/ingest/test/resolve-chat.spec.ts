/**
 * s3-execution.md Part 2 Scenario 3 — Conversation resolution + availability
 * (ChatDbReader body extension #1, §1.5).
 *
 * `resolveChat(handle)` answers "does a conversation already exist for this
 * handle, and what does it look like" — purely a read over chat_handle_join,
 * never mints a chat. The send path (Scenario 6+) fails fast as
 * `no-conversation` on `null`; AppleScript cannot start a new-recipient
 * conversation (Scenario 2), so this lookup is the only way in.
 *
 * Given: a fixture chat.db (extended per Scenario 3 with `chat_handle_join`
 * seeding via `addChat({ handleIds })`, reusing Scenario 6's builder).
 * When: `resolveChat` is called with a handle in various presentations.
 * Then: it finds the existing conversation, normalizing the input the same
 * way the S2 rule-matching contact matcher does (`normalizeHandle`, reused
 * verbatim rather than reinvented here), and reports service + group shape.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:00:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshFixture(): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wm-resolve-chat-'));
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

describe('resolveChat (Scenario 3)', () => {
  it('resolves an existing 1:1 iMessage chat by exact handle', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    const chatId = fixture.addChat({
      identifier: '+15551234567',
      handleIds: [h],
    });
    const reader = readerOver(fixture);

    const result = await reader.resolveChat('+15551234567');

    expect(result).toEqual({
      chatGuid: chatGuidOf(fixture, chatId),
      service: 'imessage',
      isGroup: false,
    });
  });

  it('normalizes a formatted phone number to the same chat (reuses S1/S2 normalizeHandle)', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    const chatId = fixture.addChat({
      identifier: '+15551234567',
      handleIds: [h],
    });
    const reader = readerOver(fixture);

    const result = await reader.resolveChat('+1 (555) 123-4567');

    expect(result).toEqual({
      chatGuid: chatGuidOf(fixture, chatId),
      service: 'imessage',
      isGroup: false,
    });
  });

  it('email handles resolve case-insensitively', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('test.user@example.com');
    const chatId = fixture.addChat({
      identifier: 'test.user@example.com',
      handleIds: [h],
    });
    const reader = readerOver(fixture);

    const result = await reader.resolveChat(' Test.User@Example.COM ');

    expect(result).toEqual({
      chatGuid: chatGuidOf(fixture, chatId),
      service: 'imessage',
      isGroup: false,
    });
  });

  it('an SMS-only chat reports service:sms (availability signal, S3 never auto-sends SMS)', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551110000', { service: 'SMS' });
    const chatId = fixture.addChat({
      identifier: '+15551110000',
      service: 'SMS',
      handleIds: [h],
    });
    const reader = readerOver(fixture);

    const result = await reader.resolveChat('+15551110000');

    expect(result).toEqual({
      chatGuid: chatGuidOf(fixture, chatId),
      service: 'sms',
      isGroup: false,
    });
  });

  it('a group chat (3 handles on one chat row) reports isGroup:true', async () => {
    const fixture = freshFixture();
    const h1 = fixture.addHandle('+15552220001');
    const h2 = fixture.addHandle('+15552220002');
    const h3 = fixture.addHandle('+15552220003');
    const chatId = fixture.addGroupChat([h1, h2, h3]);
    const reader = readerOver(fixture);

    const result = await reader.resolveChat('+15552220001');

    expect(result).toEqual({
      chatGuid: chatGuidOf(fixture, chatId),
      service: 'imessage',
      isGroup: true,
    });
  });

  it('no chat row for the handle -> null', async () => {
    const fixture = freshFixture();
    fixture.addHandle('+15551234567');
    fixture.addChat({ identifier: '+15551234567' });
    const reader = readerOver(fixture);

    await expect(reader.resolveChat('+15559999999')).resolves.toBeNull();
  });

  it('multiple chats for one handle: the most-recently-active chat wins', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15553330000');
    const olderChat = fixture.addChat({
      identifier: '+15553330001',
      handleIds: [h],
    });
    const newerChat = fixture.addChat({
      identifier: '+15553330002',
      handleIds: [h],
    });
    fixture.addMessage({
      chatId: olderChat,
      handleId: h,
      text: 'older',
      at: '2026-01-01T00:00:00Z',
    });
    fixture.addMessage({
      chatId: newerChat,
      handleId: h,
      text: 'newer',
      at: '2026-01-02T00:00:00Z',
    });
    const reader = readerOver(fixture);

    const result = await reader.resolveChat('+15553330000');

    expect(result).toEqual({
      chatGuid: chatGuidOf(fixture, newerChat),
      service: 'imessage',
      isGroup: false,
    });
  });

  it('connection stays read-only URI mode: an INSERT through the reader throws (existing invariant re-asserted)', async () => {
    const fixture = freshFixture();
    const h = fixture.addHandle('+15551234567');
    fixture.addChat({ identifier: '+15551234567', handleIds: [h] });
    const reader = readerOver(fixture);

    await reader.resolveChat('+15551234567');

    expect(reader.isReadonly()).toBe(true);
    expect(() =>
      reader.rawDb
        .prepare('INSERT INTO chat_handle_join VALUES (99, 99)')
        .run(),
    ).toThrow(/readonly|read.?only|attempt to write/i);
  });
});

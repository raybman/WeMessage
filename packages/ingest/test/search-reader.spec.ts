/**
 * v2 F2b: the three chat.db reads search needs, all read-only and batched.
 *
 * - chatTitles: the title listChats would show, for the chats on a page of
 *   hits, in one statement.
 * - chatsTitled: the chats an `in:` token names, case and accents folded.
 * - existingGuids: which mirror hits Messages still holds; the rest were
 *   deleted there and are dropped from the page (D-F2-2).
 *
 * Every handle is synthetic (+1555...) or example.com.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';

const NOW = '2026-09-01T12:00:00.000Z';
const clock: Clock = { now: () => NOW, nowMs: () => Date.parse(NOW) };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wm-search-reader-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const f = createChatDb(join(dir, 'chat.db'));
  cleanups.push(() => f.close());
  return f;
}

function reader(f: ChatDbFixture): IngestChatDbReader {
  const r = createChatDbReader(f.path, { clock });
  cleanups.push(() => r.close());
  return r;
}

const guidOf = (f: ChatDbFixture, rowid: number): string =>
  (
    f.db.prepare('SELECT guid FROM chat WHERE ROWID = ?').get(rowid) as {
      guid: string;
    }
  ).guid;

function seed(f: ChatDbFixture) {
  const maya = f.addHandle('+15550100001');
  const theo = f.addHandle('+15550100002');
  const ines = f.addHandle('ines@example.com');
  const solo = f.addChat({ identifier: '+15550100001', handleIds: [maya] });
  const family = f.addGroupChat([maya, theo], { displayName: 'Família Lake' });
  const unnamed = f.addGroupChat([theo, ines]);
  return {
    solo: guidOf(f, solo),
    family: guidOf(f, family),
    unnamed: guidOf(f, unnamed),
    soloId: solo,
  };
}

describe('chat.db reads for search (v2 F2b)', () => {
  it('chatTitles: the listChats title and group-ness, for exactly the guids asked', () => {
    const f = fixture();
    const g = seed(f);
    const titles = reader(f).chatTitles([
      g.solo,
      g.family,
      g.unnamed,
      'iMessage;-;+15550199999',
    ]);
    expect([...titles.entries()].sort()).toEqual(
      [
        [g.solo, { title: '+15550100001', isGroup: false }],
        [g.family, { title: 'Família Lake', isGroup: true }],
        [g.unnamed, { title: '+15550100002, ines@example.com', isGroup: true }],
      ].sort(),
    );
    expect(reader(f).chatTitles([]).size).toBe(0);
  });

  it('chatsTitled: a title substring, case and accents folded', () => {
    const f = fixture();
    const g = seed(f);
    const r = reader(f);
    expect(r.chatsTitled('familia')).toEqual([g.family]);
    expect(r.chatsTitled('LAKE')).toEqual([g.family]);
    expect(r.chatsTitled('example.com')).toEqual([g.unnamed]);
    expect(r.chatsTitled('+1555010000').sort()).toEqual(
      [g.solo, g.unnamed].sort(),
    );
    expect(r.chatsTitled('nobody')).toEqual([]);
  });

  it('existingGuids: a message deleted in Messages is not there', () => {
    const f = fixture();
    const g = seed(f);
    const kept = f.addMessage({ chatId: g.soloId, text: 'the cabin', at: NOW });
    const gone = f.addMessage({ chatId: g.soloId, text: 'the lake', at: NOW });
    f.db
      .prepare('DELETE FROM chat_message_join WHERE message_id = ?')
      .run(gone.rowid);
    f.db.prepare('DELETE FROM message WHERE ROWID = ?').run(gone.rowid);
    const r = reader(f);
    expect(r.existingGuids([kept.guid, gone.guid, 'never-was'])).toEqual(
      new Set([kept.guid]),
    );
    expect(r.existingGuids([]).size).toBe(0);
  });

  it('a guid list of any length is one bound parameter, not a SQL string', () => {
    const f = fixture();
    seed(f);
    const many = Array.from(
      { length: 5000 },
      (_, i) => `x'); DROP TABLE message; --${i}`,
    );
    expect(reader(f).existingGuids(many).size).toBe(0);
    expect(
      (f.db.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number })
        .n,
    ).toBe(0);
  });
});

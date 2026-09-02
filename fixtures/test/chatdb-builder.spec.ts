/**
 * Scenario 6 — Fixture chat.db builder replicates the real schema (spec
 * Part 2 #6; §4.0: "constructs a real SQLite file replicating the chat.db
 * schema (message/chat/handle/attachment join tables, Apple-epoch dates)").
 *
 * Schema fidelity target is the consumed-column contract (Part 3.3), not a
 * byte-perfect clone of Apple's full schema; the [macOS smoke] pragma diff
 * against a real chat.db is deferred to ci-macos.yml (S3) per the spec.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createChatDb,
  appleEpochNs,
  type ChatDbFixture,
} from '@wemessage/fixtures';

const dirs: string[] = [];
const open: ChatDbFixture[] = [];

function freshDb(): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wemessage-chatdb-'));
  dirs.push(dir);
  const fixture = createChatDb(join(dir, 'chat.db'));
  open.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const f of open.splice(0)) f.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('chatdb-builder (Scenario 6)', () => {
  it('creates a real SQLite file with the chat.db tables the ingest path reads', () => {
    const f = freshDb();
    expect(existsSync(f.path)).toBe(true);
    expect(readFileSync(f.path).subarray(0, 15).toString('utf8')).toBe(
      'SQLite format 3',
    );
    const tables = f.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      'message',
      'chat',
      'handle',
      'chat_message_join',
      'chat_handle_join',
      'attachment',
      'message_attachment_join',
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it('message table has every column the spec names (RD §1 / §1.3.8 consumed set)', () => {
    const f = freshDb();
    const cols = f.db
      .prepare('PRAGMA table_info(message)')
      .all()
      .map((r) => (r as { name: string }).name);
    for (const c of [
      'ROWID',
      'guid',
      'text',
      'attributedBody',
      'date',
      'date_edited',
      'date_retracted',
      'is_from_me',
      'is_audio_message',
      'service',
      'handle_id',
      'associated_message_guid',
      'associated_message_type',
      'thread_originator_guid',
      'message_summary_info',
      'cache_has_attachments',
      'cache_roomnames',
      'item_type',
      'balloon_bundle_id',
      'reply_to_guid',
    ]) {
      expect(cols, `missing message.${c}`).toContain(c);
    }
  });

  it('stores Apple-epoch nanoseconds: golden value for a known instant (RD §1 offset)', () => {
    // 2026-01-02T03:04:05Z: unix 1767323045; (1767323045 - 978307200) * 1e9.
    expect(appleEpochNs('2026-01-02T03:04:05Z')).toBe(789015845000000000n);
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addMessage({
      chatId,
      handleId,
      text: 'golden date',
      at: '2026-01-02T03:04:05Z',
    });
    const row = f.db
      .prepare('SELECT date FROM message WHERE ROWID = ?')
      .safeIntegers()
      .get(m.rowid) as { date: bigint };
    expect(row.date).toBe(789015845000000000n);
    // chat_message_join mirrors the date (real schema behavior).
    const jd = f.db
      .prepare(
        'SELECT message_date FROM chat_message_join WHERE message_id = ?',
      )
      .safeIntegers()
      .get(m.rowid) as { message_date: bigint };
    expect(jd.message_date).toBe(789015845000000000n);
  });

  it('embeds a named corpus blob with text = NULL (the Ventura case, §2.2.1)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addMessage({
      chatId,
      handleId,
      attributedBodyFixture: 'plain-ascii',
      at: '2026-01-02T03:04:05Z',
    });
    const row = f.db
      .prepare('SELECT text, attributedBody FROM message WHERE ROWID = ?')
      .get(m.rowid) as { text: string | null; attributedBody: Buffer };
    expect(row.text).toBeNull();
    const corpus = readFileSync(
      join(import.meta.dirname, '..', 'typedstream', 'plain-ascii.bin'),
    );
    expect(Buffer.compare(row.attributedBody, corpus)).toBe(0);
  });

  it('addTapback writes the associated-message columns (§1.3.8 tapbacks)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const target = f.addMessage({ chatId, handleId, text: 'tap me' });
    const tap = f.addTapback(target.guid, 2001, { chatId, handleId });
    const row = f.db
      .prepare(
        'SELECT associated_message_guid, associated_message_type, text FROM message WHERE ROWID = ?',
      )
      .get(tap.rowid) as {
      associated_message_guid: string;
      associated_message_type: number;
    };
    expect(row.associated_message_guid).toBe(`p:0/${target.guid}`);
    expect(row.associated_message_type).toBe(2001);
  });

  it('editMessage sets date_edited, new text, and a summary-info payload (§1.3.8 edits)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addMessage({ chatId, handleId, text: 'before edit' });
    f.editMessage(m.guid, 'after edit', { at: '2026-01-02T04:00:00Z' });
    const row = f.db
      .prepare(
        'SELECT text, date_edited, message_summary_info FROM message WHERE guid = ?',
      )
      .safeIntegers()
      .get(m.guid) as {
      text: string;
      date_edited: bigint;
      message_summary_info: Buffer | null;
    };
    expect(row.text).toBe('after edit');
    expect(row.date_edited).toBe(appleEpochNs('2026-01-02T04:00:00Z'));
    expect(row.message_summary_info).not.toBeNull();
  });

  it('unsendMessage sets date_retracted and clears the body (§1.3.8 unsend)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addMessage({ chatId, handleId, text: 'now you see me' });
    f.unsendMessage(m.guid, { at: '2026-01-02T05:00:00Z' });
    const row = f.db
      .prepare(
        'SELECT text, attributedBody, date_retracted FROM message WHERE guid = ?',
      )
      .safeIntegers()
      .get(m.guid) as {
      text: string | null;
      attributedBody: Buffer | null;
      date_retracted: bigint;
    };
    expect(row.text).toBeNull();
    expect(row.attributedBody).toBeNull();
    expect(row.date_retracted).toBe(appleEpochNs('2026-01-02T05:00:00Z'));
  });

  it('addAudioMessage marks is_audio_message and joins an audio attachment (§1.3.8 audio)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addAudioMessage({ chatId, handleId });
    const row = f.db
      .prepare(
        'SELECT is_audio_message, cache_has_attachments FROM message WHERE ROWID = ?',
      )
      .get(m.rowid) as {
      is_audio_message: number;
      cache_has_attachments: number;
    };
    expect(row.is_audio_message).toBe(1);
    expect(row.cache_has_attachments).toBe(1);
    const att = f.db
      .prepare(
        `SELECT a.uti FROM attachment a
           JOIN message_attachment_join j ON j.attachment_id = a.ROWID
          WHERE j.message_id = ?`,
      )
      .get(m.rowid) as { uti: string };
    expect(att.uti).toContain('audio');
  });

  it('addAttachmentOnly has no body and a joined attachment (§1.3.8 attachment-only)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addAttachmentOnly({ chatId, handleId, mimeType: 'image/png' });
    const row = f.db
      .prepare(
        'SELECT text, attributedBody, cache_has_attachments FROM message WHERE ROWID = ?',
      )
      .get(m.rowid) as {
      text: string | null;
      attributedBody: Buffer | null;
      cache_has_attachments: number;
    };
    expect(row.text).toBeNull();
    expect(row.attributedBody).toBeNull();
    expect(row.cache_has_attachments).toBe(1);
    const att = f.db
      .prepare(
        `SELECT a.mime_type FROM attachment a
           JOIN message_attachment_join j ON j.attachment_id = a.ROWID
          WHERE j.message_id = ?`,
      )
      .get(m.rowid) as { mime_type: string };
    expect(att.mime_type).toBe('image/png');
  });

  it('addSelfMessage is is_from_me = 1 (§1.3.8 self / INV-6 seed data)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const m = f.addSelfMessage({ chatId, text: 'note to self' });
    const row = f.db
      .prepare('SELECT is_from_me FROM message WHERE ROWID = ?')
      .get(m.rowid) as { is_from_me: number };
    expect(row.is_from_me).toBe(1);
  });

  it('addSmsMessage preserves the service column (§1.3.8 SMS vs iMessage)', () => {
    const f = freshDb();
    const chatId = f.addChat({ service: 'SMS' });
    const handleId = f.addHandle('+15555550100', { service: 'SMS' });
    const m = f.addSmsMessage({ chatId, handleId, text: 'green bubble' });
    const row = f.db
      .prepare('SELECT service FROM message WHERE ROWID = ?')
      .get(m.rowid) as { service: string };
    expect(row.service).toBe('SMS');
  });

  it('addGroupChat links participants and group messages carry the room name (§1.3.8 groups)', () => {
    const f = freshDb();
    const a = f.addHandle('+15555550100');
    const b = f.addHandle('+15555550101');
    const chatId = f.addGroupChat([a, b], { displayName: 'Fixture Group' });
    const chat = f.db
      .prepare(
        'SELECT style, room_name, display_name FROM chat WHERE ROWID = ?',
      )
      .get(chatId) as {
      style: number;
      room_name: string;
      display_name: string;
    };
    expect(chat.style).toBe(43); // group chat style in the real schema
    expect(chat.display_name).toBe('Fixture Group');
    const members = f.db
      .prepare('SELECT COUNT(*) AS n FROM chat_handle_join WHERE chat_id = ?')
      .get(chatId) as { n: number };
    expect(members.n).toBe(2);
    const m = f.addMessage({ chatId, handleId: a, text: 'hi group' });
    const row = f.db
      .prepare('SELECT cache_roomnames FROM message WHERE ROWID = ?')
      .get(m.rowid) as { cache_roomnames: string };
    expect(row.cache_roomnames).toBe(chat.room_name);
  });

  it('addMessageBurst appends N rows with ascending ROWIDs (T-9.3 crash-window seeding)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const burst = f.addMessageBurst(5, {
      chatId,
      handleId,
      startAt: '2026-01-02T06:00:00Z',
    });
    expect(burst).toHaveLength(5);
    const rowids = burst.map((m) => m.rowid);
    expect([...rowids].sort((x, y) => Number(x - y))).toEqual(rowids);
    const dates = f.db
      .prepare(
        `SELECT date FROM message WHERE ROWID IN (${rowids.map(() => '?').join(',')}) ORDER BY ROWID`,
      )
      .safeIntegers()
      .all(...rowids)
      .map((r) => (r as { date: bigint }).date);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! > dates[i - 1]!).toBe(true);
    }
  });

  it('each builder is a self-contained file: no shared state between instances', () => {
    const f1 = freshDb();
    const f2 = freshDb();
    const chatId = f1.addChat();
    const handleId = f1.addHandle('+15555550100');
    f1.addMessage({ chatId, handleId, text: 'only in db 1' });
    const n2 = f2.db.prepare('SELECT COUNT(*) AS n FROM message').get() as {
      n: number;
    };
    expect(n2.n).toBe(0);
    expect(f1.path).not.toBe(f2.path);
  });

  it('message guids are unique and deduplicable (§1.3.8 dedup contract)', () => {
    const f = freshDb();
    const chatId = f.addChat();
    const handleId = f.addHandle('+15555550100');
    const m = f.addMessage({ chatId, handleId, text: 'one' });
    expect(() =>
      f.addMessage({ chatId, handleId, text: 'dup', guid: m.guid }),
    ).toThrow(/UNIQUE/i);
  });
});

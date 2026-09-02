/**
 * Fixture chat.db builder (Scenario 6; §4.0; Part 3.3).
 *
 * Constructs a real SQLite file replicating the chat.db schema the ingest
 * path consumes: message/chat/handle + join tables, Apple-epoch nanosecond
 * dates, attributedBody blobs injected from the committed typedstream corpus.
 * Fidelity target is the consumed-column contract (Part 3.3), not Apple's
 * full undocumented schema; the [macOS smoke] pragma diff (ci-macos.yml, S3)
 * guards the gap. Test-only library: @wemessage/fixtures never ships (§2.1).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

/** RD §1: Apple epoch = 2001-01-01T00:00:00Z; column values are nanoseconds. */
export const APPLE_EPOCH_OFFSET_SECONDS = 978307200;

/** ISO instant -> Apple-epoch nanoseconds (BigInt: values exceed 2^53). */
export function appleEpochNs(iso: string): bigint {
  const unixMs = Date.parse(iso);
  if (Number.isNaN(unixMs)) throw new Error(`invalid ISO instant: ${iso}`);
  return (
    (BigInt(unixMs) - BigInt(APPLE_EPOCH_OFFSET_SECONDS) * 1000n) * 1_000_000n
  );
}

// Corpus lives at <fixtures pkg root>/typedstream; this file runs from src/
// (vitest) or dist/ (tsc output), both one level below the package root.
const CORPUS_DIR = join(import.meta.dirname, '..', 'typedstream');

function corpusBlob(name: string): Buffer {
  return readFileSync(join(CORPUS_DIR, `${name}.bin`));
}

const SCHEMA = `
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  text TEXT,
  attributedBody BLOB,
  handle_id INTEGER DEFAULT 0,
  service TEXT,
  error INTEGER DEFAULT 0,
  date INTEGER,
  date_read INTEGER DEFAULT 0,
  date_delivered INTEGER DEFAULT 0,
  is_delivered INTEGER DEFAULT 0,
  is_finished INTEGER DEFAULT 1,
  is_from_me INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 0,
  is_sent INTEGER DEFAULT 0,
  is_empty INTEGER DEFAULT 0,
  is_audio_message INTEGER DEFAULT 0,
  was_downgraded INTEGER DEFAULT 0,
  cache_has_attachments INTEGER DEFAULT 0,
  cache_roomnames TEXT,
  item_type INTEGER DEFAULT 0,
  other_handle INTEGER DEFAULT 0,
  group_title TEXT,
  associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0,
  balloon_bundle_id TEXT,
  message_summary_info BLOB,
  reply_to_guid TEXT,
  thread_originator_guid TEXT,
  thread_originator_part TEXT,
  date_retracted INTEGER DEFAULT 0,
  date_edited INTEGER DEFAULT 0
);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  style INTEGER,
  state INTEGER DEFAULT 3,
  chat_identifier TEXT,
  service_name TEXT,
  room_name TEXT,
  display_name TEXT,
  group_id TEXT,
  is_archived INTEGER DEFAULT 0
);
CREATE TABLE handle (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  country TEXT,
  service TEXT NOT NULL,
  uncanonicalized_id TEXT,
  UNIQUE (id, service)
);
CREATE TABLE chat_message_join (
  chat_id INTEGER,
  message_id INTEGER,
  message_date INTEGER DEFAULT 0,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE chat_handle_join (
  chat_id INTEGER,
  handle_id INTEGER,
  UNIQUE (chat_id, handle_id)
);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  created_date INTEGER DEFAULT 0,
  filename TEXT,
  uti TEXT,
  mime_type TEXT,
  transfer_state INTEGER DEFAULT 5,
  is_outgoing INTEGER DEFAULT 0,
  transfer_name TEXT,
  total_bytes INTEGER DEFAULT 0,
  is_sticker INTEGER DEFAULT 0,
  hide_attachment INTEGER DEFAULT 0
);
CREATE TABLE message_attachment_join (
  message_id INTEGER,
  attachment_id INTEGER
);
`;

export interface AddMessageOptions {
  chatId: number;
  handleId?: number;
  guid?: string;
  text?: string | null;
  /** Named corpus blob (fixtures/typedstream/<name>.bin); forces text NULL. */
  attributedBodyFixture?: string;
  /** ISO instant; stored as Apple-epoch ns. */
  at?: string;
  isFromMe?: boolean;
  service?: string;
  threadOriginatorGuid?: string;
  associatedMessageGuid?: string;
  associatedMessageType?: number;
  isAudioMessage?: boolean;
  cacheHasAttachments?: boolean;
}

export interface MessageRef {
  rowid: number;
  guid: string;
}

export interface AttachmentOptions {
  filename?: string;
  uti?: string;
  mimeType?: string;
  transferName?: string;
  totalBytes?: number;
}

export interface ChatDbFixture {
  readonly path: string;
  /** Raw handle for assertions and ad-hoc seeding. */
  readonly db: Database.Database;
  addHandle(id: string, opts?: { service?: string; country?: string }): number;
  addChat(opts?: {
    identifier?: string;
    service?: string;
    displayName?: string;
    style?: number;
  }): number;
  addGroupChat(handleIds: number[], opts?: { displayName?: string }): number;
  addMessage(opts: AddMessageOptions): MessageRef;
  addTapback(
    targetGuid: string,
    type: number,
    opts: { chatId: number; handleId?: number; at?: string },
  ): MessageRef;
  editMessage(guid: string, newText: string, opts?: { at?: string }): void;
  unsendMessage(guid: string, opts?: { at?: string }): void;
  addAudioMessage(
    opts: Omit<AddMessageOptions, 'isAudioMessage' | 'text'>,
  ): MessageRef;
  addAttachmentOnly(opts: AddMessageOptions & AttachmentOptions): MessageRef;
  addAttachment(messageRowid: number, opts?: AttachmentOptions): number;
  addSelfMessage(opts: Omit<AddMessageOptions, 'isFromMe'>): MessageRef;
  addSmsMessage(opts: Omit<AddMessageOptions, 'service'>): MessageRef;
  /** T-9.3 crash-window seeding: N sequential messages, 1s apart. */
  addMessageBurst(
    count: number,
    opts: AddMessageOptions & { startAt?: string },
  ): MessageRef[];
  close(): void;
}

export function createChatDb(path: string): ChatDbFixture {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  let clockNs = appleEpochNs('2026-01-01T00:00:00Z');
  const nextDate = (): bigint => {
    clockNs += 1_000_000_000n;
    return clockNs;
  };

  const insertMessage = db.prepare(
    `INSERT INTO message (
       guid, text, attributedBody, handle_id, service, date, is_from_me,
       is_audio_message, cache_has_attachments, cache_roomnames,
       associated_message_guid, associated_message_type,
       thread_originator_guid
     ) VALUES (
       @guid, @text, @attributedBody, @handle_id, @service, @date, @is_from_me,
       @is_audio_message, @cache_has_attachments, @cache_roomnames,
       @associated_message_guid, @associated_message_type,
       @thread_originator_guid
     )`,
  );
  const insertChatMessageJoin = db.prepare(
    'INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)',
  );

  const fixture: ChatDbFixture = {
    path,
    db,

    addHandle(id, opts) {
      const info = db
        .prepare(
          'INSERT INTO handle (id, service, country, uncanonicalized_id) VALUES (?, ?, ?, ?)',
        )
        .run(id, opts?.service ?? 'iMessage', opts?.country ?? 'US', id);
      return Number(info.lastInsertRowid);
    },

    addChat(opts) {
      const identifier =
        opts?.identifier ?? `+1555555${randomUUID().slice(0, 4)}`;
      const service = opts?.service ?? 'iMessage';
      const info = db
        .prepare(
          `INSERT INTO chat (guid, style, chat_identifier, service_name, display_name, group_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${service};-;${identifier}`,
          opts?.style ?? 45, // 45 = one-to-one in the real schema
          identifier,
          service,
          opts?.displayName ?? null,
          randomUUID(),
        );
      return Number(info.lastInsertRowid);
    },

    addGroupChat(handleIds, opts) {
      const roomName = `chat${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const info = db
        .prepare(
          `INSERT INTO chat (guid, style, chat_identifier, service_name, room_name, display_name, group_id)
           VALUES (?, 43, ?, 'iMessage', ?, ?, ?)`,
        )
        .run(
          `iMessage;+;${roomName}`,
          roomName,
          roomName,
          opts?.displayName ?? null,
          randomUUID(),
        );
      const chatId = Number(info.lastInsertRowid);
      const link = db.prepare(
        'INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)',
      );
      for (const h of handleIds) link.run(chatId, h);
      return chatId;
    },

    addMessage(opts) {
      const guid = opts.guid ?? randomUUID().toUpperCase();
      const date = opts.at !== undefined ? appleEpochNs(opts.at) : nextDate();
      const attributedBody =
        opts.attributedBodyFixture !== undefined
          ? corpusBlob(opts.attributedBodyFixture)
          : null;
      const chat = db
        .prepare('SELECT room_name FROM chat WHERE ROWID = ?')
        .get(opts.chatId) as { room_name: string | null } | undefined;
      const info = insertMessage.run({
        guid,
        // The Ventura case (§2.2.1): attributedBody-bearing rows have text NULL.
        text: attributedBody !== null ? null : (opts.text ?? null),
        attributedBody,
        handle_id: opts.handleId ?? 0,
        service: opts.service ?? 'iMessage',
        date,
        is_from_me: opts.isFromMe === true ? 1 : 0,
        is_audio_message: opts.isAudioMessage === true ? 1 : 0,
        cache_has_attachments: opts.cacheHasAttachments === true ? 1 : 0,
        cache_roomnames: chat?.room_name ?? null,
        associated_message_guid: opts.associatedMessageGuid ?? null,
        associated_message_type: opts.associatedMessageType ?? 0,
        thread_originator_guid: opts.threadOriginatorGuid ?? null,
      });
      const rowid = Number(info.lastInsertRowid);
      insertChatMessageJoin.run(opts.chatId, rowid, date);
      return { rowid, guid };
    },

    addTapback(targetGuid, type, opts) {
      return fixture.addMessage({
        chatId: opts.chatId,
        ...(opts.handleId !== undefined ? { handleId: opts.handleId } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
        text: null,
        associatedMessageGuid: `p:0/${targetGuid}`,
        associatedMessageType: type,
      });
    },

    editMessage(guid, newText, opts) {
      const when = opts?.at !== undefined ? appleEpochNs(opts.at) : nextDate();
      db.prepare(
        `UPDATE message
            SET text = ?, date_edited = ?, message_summary_info = ?
          WHERE guid = ?`,
      ).run(newText, when, corpusBlob('edited-summary-info'), guid);
    },

    unsendMessage(guid, opts) {
      const when = opts?.at !== undefined ? appleEpochNs(opts.at) : nextDate();
      db.prepare(
        `UPDATE message
            SET text = NULL, attributedBody = NULL, date_retracted = ?
          WHERE guid = ?`,
      ).run(when, guid);
    },

    addAudioMessage(opts) {
      const m = fixture.addMessage({
        ...opts,
        text: null,
        isAudioMessage: true,
        cacheHasAttachments: true,
      });
      fixture.addAttachment(m.rowid, {
        uti: 'com.apple.coreaudio-format',
        mimeType: 'audio/x-caf',
        transferName: 'Audio Message.caf',
        filename: '~/Library/Messages/Attachments/ab/audio-message.caf',
      });
      return m;
    },

    addAttachmentOnly(opts) {
      const m = fixture.addMessage({
        ...opts,
        text: null,
        cacheHasAttachments: true,
      });
      fixture.addAttachment(m.rowid, opts);
      return m;
    },

    addAttachment(messageRowid, opts) {
      const info = db
        .prepare(
          `INSERT INTO attachment (guid, filename, uti, mime_type, transfer_name, total_bytes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID().toUpperCase(),
          opts?.filename ?? '~/Library/Messages/Attachments/00/fixture.png',
          opts?.uti ?? 'public.png',
          opts?.mimeType ?? 'image/png',
          opts?.transferName ?? 'fixture.png',
          opts?.totalBytes ?? 1024,
        );
      const attachmentId = Number(info.lastInsertRowid);
      db.prepare(
        'INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)',
      ).run(messageRowid, attachmentId);
      return attachmentId;
    },

    addSelfMessage(opts) {
      return fixture.addMessage({ ...opts, isFromMe: true });
    },

    addSmsMessage(opts) {
      return fixture.addMessage({ ...opts, service: 'SMS' });
    },

    addMessageBurst(count, opts) {
      // Drop any caller guid: every burst message gets its own.
      const { startAt, guid: _guid, ...rest } = opts;
      void _guid;
      const startNs =
        startAt !== undefined ? appleEpochNs(startAt) : nextDate();
      const out: MessageRef[] = [];
      for (let i = 0; i < count; i++) {
        clockNs = startNs + BigInt(i) * 1_000_000_000n;
        const at = new Date(
          Number(clockNs / 1_000_000n) + APPLE_EPOCH_OFFSET_SECONDS * 1000,
        ).toISOString();
        out.push(fixture.addMessage({ ...rest, at, text: `burst ${i}` }));
      }
      return out;
    },

    close() {
      db.close();
    },
  };
  return fixture;
}

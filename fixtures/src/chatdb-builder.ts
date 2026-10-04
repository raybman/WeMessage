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

/** typedstream integer: literal below 0x80, else 0x81 + 2 bytes LE. */
function typedstreamInt(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n > 0xffff) throw new Error(`typedstreamWithText: length ${n} too long`);
  return Buffer.from([0x81, n & 0xff, (n >> 8) & 0xff]);
}

/** Reads a typedstream integer at `at`; returns [value, bytes consumed]. */
function readTypedstreamInt(b: Buffer, at: number): [number, number] {
  const first = b[at];
  if (first === undefined) throw new Error('typedstreamWithText: short blob');
  if (first < 0x80) return [first, 1];
  if (first === 0x81) return [b.readUInt16LE(at + 1), 3];
  throw new Error(
    `typedstreamWithText: unexpected int tag 0x${first.toString(16)}`,
  );
}

// The NSString "+" value opens with these bytes; the attribute-run array
// ("iI": run index, run length) closes it. Both anchors are read from
// Apple's own plain-ascii.bin, never typed in from memory.
const STRING_OPEN = Buffer.from([0x84, 0x01, 0x2b]);
const RUN_OPEN = Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01]);

/**
 * s10 Slice 1: a macOS 26 attributedBody blob for an arbitrary body, made
 * by splicing it into the real plain-ascii.bin. Two lengths move with the
 * text: the NSString prefix in UTF-8 BYTES and the attribute run in UTF-16
 * CODE UNITS. Proven against three other real blobs byte for byte
 * (fixtures/test/typedstream-encode.spec.ts).
 */
export function typedstreamWithText(text: string): Buffer {
  if (text.length === 0) throw new Error('typedstreamWithText: empty body');
  const base = corpusBlob('plain-ascii');
  const open = base.indexOf(STRING_OPEN);
  if (open === -1) throw new Error('typedstreamWithText: no NSString in base');
  const lenAt = open + STRING_OPEN.length;
  const [oldBytes, oldLenSize] = readTypedstreamInt(base, lenAt);
  const runAt = lenAt + oldLenSize + oldBytes;
  if (!base.subarray(runAt, runAt + RUN_OPEN.length).equals(RUN_OPEN)) {
    throw new Error('typedstreamWithText: no attribute run after the string');
  }
  const runLenAt = runAt + RUN_OPEN.length;
  const [, oldRunSize] = readTypedstreamInt(base, runLenAt);
  const utf8 = Buffer.from(text, 'utf8');
  return Buffer.concat([
    base.subarray(0, lenAt),
    typedstreamInt(utf8.length),
    utf8,
    RUN_OPEN,
    typedstreamInt(text.length),
    base.subarray(runLenAt + oldRunSize),
  ]);
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
  /**
   * s10 Slice 1: the macOS 26 shape for an arbitrary body, an attributedBody
   * built by `typedstreamWithText`; forces text NULL like a real send.
   */
  attributedBodyText?: string;
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
    /**
     * S3 Scenario 3: link participant handle rows via chat_handle_join, the
     * table `resolveChat` reads (a 1:1 chat has no participants wired up by
     * default — chat_message_join alone isn't enough to resolve a chat with
     * no message history yet).
     */
    handleIds?: number[];
    /**
     * s10 Slice 1: the guid prefix. Defaults to the service name (the
     * pre-macOS-26 shape). macOS 26 writes "any" for every chat and keeps
     * the real service only in chat.service_name.
     */
    guidPrefix?: string;
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
  /**
   * s3-execution Scenario 8, Part 3 fixture extension: a test-only
   * `SendBackend` (`LoopbackSendBackend`) only ever has a `chatGuid` string
   * (mirrors the real `SendBackend.send({chatGuid, body})` shape) — never
   * the integer chat ROWID `addSelfMessage`/`addMessage` require. This
   * resolves `chatGuid` -> ROWID via `chat.guid` (throws if no such chat,
   * a programmer error in test setup, never a runtime path) then delegates
   * to `addSelfMessage`, landing an `is_from_me=1` row `findOutboundMessage`
   * can discover — the read half of post-send verification (§2.2.2).
   */
  appendOutbound(opts: {
    chatGuid: string;
    text: string;
    atIso: string;
    /** s10: land the macOS 26 shape (text NULL, attributedBody). */
    asAttributedBody?: boolean;
  }): MessageRef;
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
          `${opts?.guidPrefix ?? service};-;${identifier}`,
          opts?.style ?? 45, // 45 = one-to-one in the real schema
          identifier,
          service,
          opts?.displayName ?? null,
          randomUUID(),
        );
      const chatId = Number(info.lastInsertRowid);
      if (opts?.handleIds !== undefined) {
        const link = db.prepare(
          'INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)',
        );
        for (const h of opts.handleIds) link.run(chatId, h);
      }
      return chatId;
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
          : opts.attributedBodyText !== undefined
            ? typedstreamWithText(opts.attributedBodyText)
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

    appendOutbound(opts) {
      const chat = db
        .prepare('SELECT ROWID as rowid FROM chat WHERE guid = ?')
        .get(opts.chatGuid) as { rowid: number } | undefined;
      if (chat === undefined) {
        throw new Error(`appendOutbound: no chat with guid ${opts.chatGuid}`);
      }
      return fixture.addSelfMessage({
        chatId: chat.rowid,
        ...(opts.asAttributedBody === true
          ? { attributedBodyText: opts.text }
          : { text: opts.text }),
        at: opts.atIso,
      });
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

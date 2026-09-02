/**
 * ChatDbReader over a real chat.db file (Scenario 7; §2.1 port, §2.2.1).
 *
 * Opens strictly read-only and never writes. Rows with ROWID > lastRowid are
 * joined against chat/handle/attachment and normalized into §3.2 Message.
 * Busy/backoff, immutable-URI reopen-per-burst, and cursor persistence are
 * Scenario 8 concerns; this layer is the read+normalize substrate.
 */
import Database from 'better-sqlite3';
import type {
  AttachmentRef,
  ChatDbReader,
  Clock,
  Message,
} from '@wemessage/core';
import {
  normalizeRow,
  type DecodeFailedSignal,
  type RawMessageRow,
} from '../normalize/index.js';

export interface ChatDbReaderOptions {
  clock: Clock;
  /** §2.2.1 degrade signal sink (audit persistence is S2). */
  onDecodeFailed?: (signal: DecodeFailedSignal) => void;
}

export interface IngestChatDbReader extends ChatDbReader {
  /** True when the underlying SQLite handle was opened read-only. */
  isReadonly(): boolean;
  close(): void;
}

const MESSAGES_SQL = `
  SELECT
    m.ROWID                    AS rowid,
    m.guid                     AS guid,
    m.text                     AS text,
    m.attributedBody           AS attributedBody,
    m.date                     AS date,
    m.date_edited              AS dateEdited,
    m.date_retracted           AS dateRetracted,
    m.is_from_me               AS isFromMe,
    m.is_audio_message         AS isAudioMessage,
    m.service                  AS service,
    m.associated_message_guid  AS associatedMessageGuid,
    m.associated_message_type  AS associatedMessageType,
    m.thread_originator_guid   AS threadOriginatorGuid,
    m.message_summary_info     AS messageSummaryInfo,
    m.cache_has_attachments    AS cacheHasAttachments,
    c.guid                     AS chatGuid,
    c.style                    AS chatStyle,
    c.chat_identifier          AS chatIdentifier,
    h.id                       AS handle
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
`;

const ATTACHMENTS_SQL = `
  SELECT
    a.filename      AS path,
    a.mime_type     AS mimeType,
    a.total_bytes   AS bytes,
    a.transfer_name AS transferName
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE maj.message_id = ?
  ORDER BY a.ROWID ASC
`;

interface DbMessageRow {
  rowid: bigint;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: bigint | null;
  dateEdited: bigint | null;
  dateRetracted: bigint | null;
  isFromMe: bigint;
  isAudioMessage: bigint;
  service: string | null;
  associatedMessageGuid: string | null;
  associatedMessageType: bigint;
  threadOriginatorGuid: string | null;
  messageSummaryInfo: Uint8Array | null;
  cacheHasAttachments: bigint;
  chatGuid: string;
  chatStyle: bigint;
  chatIdentifier: string;
  handle: string | null;
}

interface DbAttachmentRow {
  path: string | null;
  mimeType: string | null;
  bytes: bigint | null;
  transferName: string | null;
}

export function createChatDbReader(
  path: string,
  options: ChatDbReaderOptions,
): IngestChatDbReader {
  // Never writable (§2.2.1): readonly open + query_only belt-and-suspenders.
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = 1');

  const messagesStmt = db.prepare(MESSAGES_SQL);
  messagesStmt.safeIntegers(true); // Apple-epoch ns exceed 2^53
  const attachmentsStmt = db.prepare(ATTACHMENTS_SQL);
  attachmentsStmt.safeIntegers(true);

  const readAttachments = (messageRowid: bigint): AttachmentRef[] =>
    (attachmentsStmt.all(messageRowid) as DbAttachmentRow[]).map((a) => ({
      path: a.path ?? '',
      mimeType: a.mimeType ?? 'application/octet-stream',
      bytes: Number(a.bytes ?? 0n),
      transferName: a.transferName ?? '',
    }));

  return {
    isReadonly: () => db.readonly,

    readSince(lastRowid: number): Promise<Message[]> {
      const rows = messagesStmt.all(BigInt(lastRowid)) as DbMessageRow[];
      const messages = rows.map((r) => {
        const raw: RawMessageRow = {
          rowid: Number(r.rowid),
          guid: r.guid,
          text: r.text,
          attributedBody: r.attributedBody,
          date: r.date ?? 0n,
          dateEdited: r.dateEdited ?? 0n,
          dateRetracted: r.dateRetracted ?? 0n,
          isFromMe: r.isFromMe === 1n,
          isAudioMessage: r.isAudioMessage === 1n,
          service: r.service,
          associatedMessageGuid: r.associatedMessageGuid,
          associatedMessageType: Number(r.associatedMessageType),
          threadOriginatorGuid: r.threadOriginatorGuid,
          messageSummaryInfo: r.messageSummaryInfo,
          cacheHasAttachments: r.cacheHasAttachments === 1n,
          chatGuid: r.chatGuid,
          chatStyle: Number(r.chatStyle),
          chatIdentifier: r.chatIdentifier,
          handle: r.handle,
          attachments: readAttachments(r.rowid),
        };
        const { message, decodeFailed } = normalizeRow(raw, {
          clock: options.clock,
        });
        if (decodeFailed !== undefined) options.onDecodeFailed?.(decodeFailed);
        return message;
      });
      return Promise.resolve(messages);
    },

    close() {
      db.close();
    },
  };
}

/**
 * ChatDbReader over a real chat.db file (Scenario 7; §2.1 port, §2.2.1).
 *
 * Opens strictly read-only and never writes. Rows with ROWID > lastRowid are
 * joined against chat/handle/attachment and normalized into §3.2 Message.
 *
 * Open strategy (§2.2.1): attempt `file:...?mode=ro&immutable=1` first, fall
 * back to plain read-only + `PRAGMA query_only = 1`. better-sqlite3 does not
 * accept URI filenames today, so the fallback is the live path on this
 * driver; the attempt stays so a driver upgrade picks immutable up for free.
 * Busy/backoff and cursor persistence live in the scan loop (Scenario 8).
 */
import Database from 'better-sqlite3';
import type {
  AttachmentRef,
  ChatDbReader,
  ChatGuid,
  Clock,
  Handle,
  Message,
  MutatedMessage,
  Service,
} from '@wemessage/core';
import { normalizeHandle } from '@wemessage/core';
import {
  mapService,
  normalizeRow,
  type DecodeFailedSignal,
  type RawMessageRow,
} from '../normalize/index.js';

export interface ChatDbReaderOptions {
  clock: Clock;
  /** §2.2.1 degrade signal sink (persisted to audit since S2 Scenario 9). */
  onDecodeFailed?: (signal: DecodeFailedSignal) => void;
}

/** Which §2.2.1 open path actually engaged. */
export type ChatDbOpenMode = 'immutable' | 'readonly-fallback';

export interface IngestChatDbReader extends ChatDbReader {
  /** True when the underlying SQLite handle was opened read-only. */
  isReadonly(): boolean;
  /** Which §2.2.1 open path engaged (immutable URI vs plain ro fallback). */
  readonly openMode: ChatDbOpenMode;
  /** Underlying handle, exposed so tests can prove writes are impossible. */
  readonly rawDb: Database.Database;
  close(): void;
}

const MESSAGE_SELECT_SQL = `
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
`;

const MESSAGES_SQL = `${MESSAGE_SELECT_SQL}
  WHERE m.ROWID > ?
  ORDER BY m.ROWID ASC
`;

/**
 * Rows mutated in place strictly after the ns watermark (S2 Scenario 8).
 * Strictly greater on BOTH columns: \`>=\` would re-emit the watermark row
 * itself forever. Params are the same watermark bound twice.
 */
const MUTATIONS_SQL = `${MESSAGE_SELECT_SQL}
  WHERE (m.date_edited > ? OR m.date_retracted > ?)
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

/**
 * resolveChat (Scenario 3, §1.5): every (handle, chat) pairing via
 * chat_handle_join, joined out to the owning chat's guid/service. Filtering
 * by normalized-handle equality happens in JS (normalizeHandle mirrors the
 * §1.7 contact-matcher rules; doing it in SQL would mean reimplementing that
 * logic a second time in SQL string functions).
 */
const RESOLVE_CANDIDATES_SQL = `
  SELECT
    h.id           AS handleId,
    c.ROWID        AS chatRowid,
    c.guid         AS chatGuid,
    c.service_name AS service
  FROM chat_handle_join chj
  JOIN handle h ON h.ROWID = chj.handle_id
  JOIN chat c ON c.ROWID = chj.chat_id
`;

/** isGroup is a participant count, not chat.style (teeth: dropping this must fail the group-chat row). */
const PARTICIPANT_COUNT_SQL = `
  SELECT COUNT(*) AS n FROM chat_handle_join WHERE chat_id = ?
`;

/** Apple-epoch ns; exceeds 2^53, so this stmt reads with safeIntegers on. */
const LAST_MESSAGE_DATE_SQL = `
  SELECT MAX(message_date) AS lastDate FROM chat_message_join WHERE chat_id = ?
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

interface ResolveCandidateRow {
  handleId: string;
  chatRowid: number;
  chatGuid: string;
  service: string | null;
}

export function createChatDbReader(
  path: string,
  options: ChatDbReaderOptions,
): IngestChatDbReader {
  // Never writable (§2.2.1): immutable URI attempt, then readonly +
  // query_only fallback (see header comment).
  let db: Database.Database;
  let openMode: ChatDbOpenMode;
  try {
    db = new Database(`file:${path}?mode=ro&immutable=1`, {
      readonly: true,
      fileMustExist: true,
    });
    openMode = 'immutable';
  } catch {
    db = new Database(path, { readonly: true, fileMustExist: true });
    openMode = 'readonly-fallback';
  }
  db.pragma('query_only = 1');

  const messagesStmt = db.prepare(MESSAGES_SQL);
  messagesStmt.safeIntegers(true); // Apple-epoch ns exceed 2^53
  const mutationsStmt = db.prepare(MUTATIONS_SQL);
  mutationsStmt.safeIntegers(true);
  const attachmentsStmt = db.prepare(ATTACHMENTS_SQL);
  attachmentsStmt.safeIntegers(true);
  const resolveCandidatesStmt = db.prepare(RESOLVE_CANDIDATES_SQL);
  const participantCountStmt = db.prepare(PARTICIPANT_COUNT_SQL);
  const lastMessageDateStmt = db.prepare(LAST_MESSAGE_DATE_SQL);
  lastMessageDateStmt.safeIntegers(true);

  const readAttachments = (messageRowid: bigint): AttachmentRef[] =>
    (attachmentsStmt.all(messageRowid) as DbAttachmentRow[]).map((a) => ({
      path: a.path ?? '',
      mimeType: a.mimeType ?? 'application/octet-stream',
      bytes: Number(a.bytes ?? 0n),
      transferName: a.transferName ?? '',
    }));

  const toMessage = (r: DbMessageRow): Message => {
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
  };

  return {
    openMode,
    rawDb: db,
    isReadonly: () => db.readonly,

    readSince(lastRowid: number): Promise<Message[]> {
      const rows = messagesStmt.all(BigInt(lastRowid)) as DbMessageRow[];
      return Promise.resolve(rows.map(toMessage));
    },

    readMutatedSince(sinceNs: string): Promise<MutatedMessage[]> {
      // Decimal-string watermark -> BigInt bind: Number(sinceNs) would
      // truncate past 2^53 and conflate 1ns-apart mutations (Scenario 8).
      const bound = BigInt(sinceNs);
      const rows = mutationsStmt.all(bound, bound) as DbMessageRow[];
      return Promise.resolve(
        rows.map((r) => {
          const edited = r.dateEdited ?? 0n;
          const retracted = r.dateRetracted ?? 0n;
          const mutationNs = edited > retracted ? edited : retracted;
          return { message: toMessage(r), mutationNs: mutationNs.toString() };
        }),
      );
    },

    resolveChat(handle: Handle): Promise<{
      chatGuid: ChatGuid;
      service: Service;
      isGroup: boolean;
    } | null> {
      const target = normalizeHandle(handle);
      const candidates = resolveCandidatesStmt.all() as ResolveCandidateRow[];
      const matches = candidates.filter(
        (c) => normalizeHandle(c.handleId) === target,
      );
      if (matches.length === 0) return Promise.resolve(null);

      const seenChats = new Set<number>();
      let best: ResolveCandidateRow | null = null;
      let bestDate = -1n;
      for (const candidate of matches) {
        if (seenChats.has(candidate.chatRowid)) continue;
        seenChats.add(candidate.chatRowid);
        const row = lastMessageDateStmt.get(candidate.chatRowid) as {
          lastDate: bigint | null;
        };
        const lastDate = row.lastDate ?? 0n;
        if (best === null || lastDate > bestDate) {
          best = candidate;
          bestDate = lastDate;
        }
      }
      if (best === null) return Promise.resolve(null);

      const countRow = participantCountStmt.get(best.chatRowid) as {
        n: number;
      };
      return Promise.resolve({
        chatGuid: best.chatGuid,
        service: mapService(best.service),
        isGroup: countRow.n > 1,
      });
    },

    close() {
      db.close();
    },
  };
}

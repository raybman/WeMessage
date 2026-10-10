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
  ChatSummary,
  ChatsPage,
  ChatsQuery,
  ChatTurn,
  Clock,
  Handle,
  Message,
  MessageGuid,
  MutatedMessage,
  Service,
  TranscriptTurn,
  TurnFile,
  TurnKind,
  TurnReaction,
  TurnsPage,
  TurnsQuery,
} from '@wemessage/core';
import {
  FILES_PER_TURN_MAX,
  InvalidCursorError,
  UnknownChatError,
  normalizeHandle,
  parseChatGuid,
} from '@wemessage/core';
import {
  isoToAppleNs,
  mapService,
  normalizeRow,
  type DecodeFailedSignal,
  type RawMessageRow,
} from '../normalize/index.js';
import {
  chatDbDateToIso,
  deliveryOf,
  fileOf,
  foldReactions,
  type FileDbRow,
  type ReactionRow,
} from './rich-turns.js';
import {
  decodeSummaryInfoLatestText,
  decodeTypedstreamText,
} from '../typedstream/index.js';

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
  /**
   * v2 F2: the title and group-ness of each chat asked about, computed the
   * way listChats computes them. A guid chat.db does not hold is absent from
   * the map. One statement, however many guids.
   */
  chatTitles(guids: readonly string[]): Map<string, ChatTitle>;
  /**
   * v2 F2: every chat whose title contains `needle`, case and diacritics
   * folded. The `in:` search token narrows to these.
   */
  chatsTitled(needle: string): string[];
  /**
   * v2 F2: which of these message guids chat.db still holds. A mirror row
   * whose guid is missing here was deleted in Messages.
   */
  existingGuids(guids: readonly string[]): Set<string>;
  close(): void;
}

/** v2 F2: a chat's title as listChats shows it, and whether it is a group. */
export interface ChatTitle {
  title: string;
  isGroup: boolean;
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

/**
 * findOutboundMessage (Scenario 4, §1.5; s10 Slice 1): every predicate is
 * independently load-bearing: chat scope, direction, exact body, and the
 * since-watermark (teeth: relaxing the body to a prefix or dropping the date
 * bound must each fail their respective negative-case tests).
 *
 * s10: on macOS 26 an outbound row's body lives in attributedBody and
 * `text` is NULL (live chat.db, 90 days: 10,238 of 10,264). SQL can only
 * narrow to candidates; the exact-equality decision is made in JS after
 * decoding, with `text` authoritative when present (the same rule
 * normalizeRow applies). No LIMIT: a late check looks for the FIRST attempt,
 * which is the oldest row in the window, and a busy chat outran a LIMIT 50
 * on live data. The date bound caps the scan; iterate stops at first match.
 */
const FIND_OUTBOUND_SQL = `
  SELECT m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE c.guid = ?
    AND m.is_from_me = 1
    AND (m.text = ? OR (m.text IS NULL AND m.attributedBody IS NOT NULL))
    AND m.date >= ?
  ORDER BY m.ROWID DESC
`;

interface OutboundCandidateRow {
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
}

/** Exact-body test for one candidate: `text` first, else the decoded blob. */
function outboundBodyEquals(row: OutboundCandidateRow, body: string): boolean {
  if (row.text !== null) return row.text === body;
  if (row.attributedBody === null) return false;
  const decoded = decodeTypedstreamText(row.attributedBody);
  return decoded.ok && decoded.text === body;
}

/**
 * readChatTurns (Scenario 6, §1.5 F-46): the tail of one conversation, both
 * directions. Ordered newest-first with a LIMIT so the database does the
 * truncation (a chat with 40k messages must not be read to return 12); the
 * caller reverses to oldest-first.
 */
const CHAT_TURNS_SQL = `${MESSAGE_SELECT_SQL}
  WHERE c.guid = ?
  ORDER BY m.date DESC, m.ROWID DESC
  LIMIT ?
`;

/**
 * listChats (v2 A1): one page of the conversations list AND the size of the
 * whole list, in ONE statement, so both come from the same read snapshot of
 * chat.db and the count on screen can never disagree with the rows under it.
 *
 * `conv` holds one row per conversation: each chat's newest message that is
 * not a reaction. A tapback (`associated_message_guid` set and a nonzero
 * `associated_message_type`, the same test normalizeRow applies) is a
 * reaction TO a message, so it neither dates nor previews a chat, and a chat
 * holding nothing but reactions, or nothing at all, is not a conversation
 * yet. The correlated subquery walks one chat's join rows newest first and
 * stops at the first real message, so a chat costs a read of its own rows,
 * never of the whole message table.
 *
 * Dates are compared RAW. A pre-High Sierra row is seconds since 2001 and a
 * modern one nanoseconds, and every seconds-era value is smaller than every
 * nanosecond-era one, which is also the right chronological order. A NULL or
 * negative date sorts as 0; the same clamped expression orders, filters and
 * mints the cursor, so the keyset stays consistent even then.
 *
 * Paging is keyset on (lastDate DESC, chatRowid DESC): a page boundary that
 * lands inside a tie neither repeats a chat nor skips one, and a newer chat
 * wins a tie. Bound parameters, in order: the cursor date (or NULL for the
 * first page), the same date twice more, the cursor chat ROWID, and the row
 * limit. The total row always comes back, even on an empty page, through the
 * LEFT JOIN, and its page columns are NULL then.
 */
const LIST_CHATS_SQL = `
  WITH last AS MATERIALIZED (
    SELECT
      c.ROWID AS chatRowid,
      (SELECT cmj.message_id
         FROM chat_message_join cmj
         JOIN message m ON m.ROWID = cmj.message_id
        WHERE cmj.chat_id = c.ROWID
          AND NOT (m.associated_message_guid IS NOT NULL
                   AND m.associated_message_type != 0)
        ORDER BY cmj.message_date DESC, cmj.message_id DESC
        LIMIT 1) AS messageRowid
    FROM chat c
  ),
  conv AS MATERIALIZED (
    SELECT
      l.chatRowid AS chatRowid,
      l.messageRowid AS messageRowid,
      MAX(COALESCE(cmj.message_date, 0), 0) AS lastDate
    FROM last l
    JOIN chat_message_join cmj
      ON cmj.chat_id = l.chatRowid AND cmj.message_id = l.messageRowid
    WHERE l.messageRowid IS NOT NULL
  )
  SELECT
    t.total            AS total,
    p.chatRowid        AS chatRowid,
    p.lastDate         AS lastDate,
    p.chatGuid         AS chatGuid,
    p.displayName      AS displayName,
    p.chatIdentifier   AS chatIdentifier,
    p.participants     AS participants,
    p.text             AS text,
    p.attributedBody   AS attributedBody,
    p.isFromMe         AS isFromMe,
    p.dateEdited       AS dateEdited,
    p.dateRetracted    AS dateRetracted,
    p.summaryInfo      AS summaryInfo
  FROM (SELECT COUNT(*) AS total FROM conv) t
  LEFT JOIN (
    SELECT
      conv.chatRowid             AS chatRowid,
      conv.lastDate              AS lastDate,
      c.guid                     AS chatGuid,
      c.display_name             AS displayName,
      c.chat_identifier          AS chatIdentifier,
      (SELECT json_group_array(h.id)
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
        WHERE chj.chat_id = conv.chatRowid) AS participants,
      m.text                     AS text,
      m.attributedBody           AS attributedBody,
      m.is_from_me               AS isFromMe,
      m.date_edited              AS dateEdited,
      m.date_retracted           AS dateRetracted,
      m.message_summary_info     AS summaryInfo
    FROM conv
    JOIN chat c ON c.ROWID = conv.chatRowid
    JOIN message m ON m.ROWID = conv.messageRowid
    WHERE ? IS NULL
       OR conv.lastDate < ?
       OR (conv.lastDate = ? AND conv.chatRowid < ?)
    ORDER BY conv.lastDate DESC, conv.chatRowid DESC
    LIMIT ?
  ) p ON 1
  ORDER BY p.lastDate DESC, p.chatRowid DESC
`;

/** SECONDS_ERA_LIMIT (chatdb/rich-turns.ts) as a SQL literal. */
const SECONDS_ERA_LIMIT_SQL = '100000000000';

/** v2 A2: a chat's ROWID by its guid, or nothing for a chat never seen. */
const CHAT_ROWID_SQL = `SELECT ROWID AS chatRowid, style AS style FROM chat WHERE guid = ?`;

/** chat.style for a group conversation (45 is one-to-one). */
const CHAT_STYLE_GROUP = 43n;

/**
 * The turn test, the keyset and the `until` window over one candidate
 * \`d\` expression (see CHAT_PAGE_SQL). Shared by its two halves.
 */
const pageWindow = (d: string): string => `
      AND m.item_type = 0
      AND NOT (m.associated_message_guid IS NOT NULL
               AND m.associated_message_type != 0)
      AND (@beforeDate IS NULL
           OR ${d} < @beforeDate
           OR (${d} = @beforeDate AND cmj.message_id < @beforeRowid))
      AND (@untilNs IS NULL
           OR (${d} < ${SECONDS_ERA_LIMIT_SQL} AND ${d} <= @untilSeconds)
           OR (${d} >= ${SECONDS_ERA_LIMIT_SQL} AND ${d} <= @untilNs))`;

/**
 * readChatPage (v2 A2): one page of one conversation, newest first.
 *
 * A turn is a message somebody said: not a reaction (the same tapback test
 * listChats and normalizeRow apply) and not a group event such as a rename
 * (\`item_type != 0\`). Paging is keyset on (date DESC, message ROWID DESC)
 * over the chat's own join rows, the way LIST_CHATS_SQL pages chats, so a
 * boundary inside a tie neither repeats a turn nor skips one and a message
 * arriving mid-walk never shifts an older page. The date is clamped (NULL
 * or negative sorts as 0) and that one value orders, filters, dates the
 * turn and mints the cursor.
 *
 * \`until\` compares RAW, per era: a seconds-era row against the instant in
 * seconds, a nanosecond-era row against it in nanoseconds. Every
 * seconds-era value is below every nanosecond-era one, so the ordering is
 * chronological across the two.
 *
 * Attachments are not counted here: v2 F4 reads them once per page
 * (FILES_FOR_PAGE_SQL), and the count is the number of rows that read
 * returns for the turn. A COUNT per row was A2's perf cliff.
 *
 * v2 F4: the clamp is split in two halves so the positive-date half walks
 * the cmj (chat_id, message_date, message_id) index newest first and stops
 * at the LIMIT, instead of materialising and sorting the whole chat. The
 * other half is every row the clamp sends to 0 (NULL or <= 0). Same rows,
 * same order, same cursor as the single clamped expression.
 */
const CHAT_PAGE_SQL = `
  SELECT
    p.rowid                    AS rowid,
    p.d                        AS d,
    m.guid                     AS guid,
    m.text                     AS text,
    m.attributedBody           AS attributedBody,
    m.date_edited              AS dateEdited,
    m.date_retracted           AS dateRetracted,
    m.is_from_me               AS isFromMe,
    m.is_audio_message         AS isAudioMessage,
    m.message_summary_info     AS summaryInfo,
    h.id                       AS handle,
    m.service                  AS service,
    m.error                    AS error,
    m.is_sent                  AS isSent,
    m.is_delivered             AS isDelivered,
    m.date_delivered           AS dateDelivered,
    m.date_read                AS dateRead
  FROM (
    SELECT rowid, d FROM (
      SELECT cmj.message_id AS rowid, cmj.message_date AS d
      FROM chat_message_join cmj
      JOIN message m ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id = @chatRowid
        AND cmj.message_date > 0${pageWindow('cmj.message_date')}
      ORDER BY cmj.message_date DESC, cmj.message_id DESC
      LIMIT @limit
    )
    UNION ALL
    SELECT rowid, d FROM (
      SELECT cmj.message_id AS rowid, 0 AS d
      FROM chat_message_join cmj
      JOIN message m ON m.ROWID = cmj.message_id
      WHERE cmj.chat_id = @chatRowid
        AND (cmj.message_date IS NULL OR cmj.message_date <= 0)${pageWindow('0')}
      ORDER BY cmj.message_id DESC
      LIMIT @limit
    )
  ) p
  JOIN message m ON m.ROWID = p.rowid
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  ORDER BY p.d DESC, p.rowid DESC
  LIMIT @limit
`;

/**
 * v2 F4: the file metadata of every turn on one page, in one read. Never
 * \`filename\`: that column is a path into the user's Library, and the
 * reader has no use for one. \`@rowids\` is a JSON array of message ROWIDs.
 */
const FILES_FOR_PAGE_SQL = `
  SELECT
    maj.message_id   AS messageRowid,
    a.transfer_name  AS transferName,
    a.mime_type      AS mimeType,
    a.uti            AS uti,
    a.total_bytes    AS totalBytes,
    a.is_sticker     AS isSticker,
    a.hide_attachment AS hidden
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE maj.message_id IN (SELECT value FROM json_each(@rowids))
  ORDER BY maj.message_id, maj.attachment_id
`;

/**
 * v2 F4: every tapback row in the chat at or after the page's oldest turn,
 * in one read. A tapback is never older than the turn it reacts to, so the
 * cmj (chat_id, message_date) range bounds the scan to rows newer than the
 * page; the target filter (the page's own guids) runs in JS.
 */
const REACTIONS_FOR_PAGE_SQL = `
  SELECT
    m.ROWID                    AS rowid,
    MAX(COALESCE(cmj.message_date, 0), 0) AS date,
    m.associated_message_type  AS type,
    m.associated_message_guid  AS target,
    m.is_from_me               AS isFromMe,
    h.id                       AS handle
  FROM chat_message_join cmj
  JOIN message m ON m.ROWID = cmj.message_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE cmj.chat_id = @chatRowid
    AND cmj.message_date >= @oldestD
    AND m.associated_message_guid IS NOT NULL
    AND (m.associated_message_type BETWEEN 2000 AND 2007
         OR m.associated_message_type BETWEEN 3000 AND 3007)
`;

/**
 * The three statements one transcript page runs, by name. Exported so the
 * perf spec can EXPLAIN each one and check none of them names \`filename\`.
 */
export const CHAT_PAGE_STATEMENTS = {
  page: CHAT_PAGE_SQL,
  files: FILES_FOR_PAGE_SQL,
  reactions: REACTIONS_FOR_PAGE_SQL,
} as const;

/** The most turns one transcript page holds, whatever the caller asks for. */
const CHAT_PAGE_MAX = 200;
/**
 * A transcript cursor's decoded form. The leading \`t.\` keeps it from ever
 * reading as a conversations-list cursor, and the reverse.
 */
const TURN_CURSOR_RE = /^t\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** The most rows one page holds, whatever the caller asks for. */
const LIST_CHATS_MAX = 200;
/** SQLite INTEGER is a signed 64-bit value; a cursor beyond it was not minted. */
const INT64_MAX = 9_223_372_036_854_775_807n;
/** The attachment placeholder Messages writes into `text`. */
const OBJECT_REPLACEMENT = /\uFFFC/g;
/** A cursor's decoded form: two canonical non-negative integers. */
const CURSOR_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

interface ListChatsDbRow {
  total: bigint;
  chatRowid: bigint | null;
  lastDate: bigint | null;
  chatGuid: string | null;
  displayName: string | null;
  chatIdentifier: string | null;
  participants: string | null;
  text: string | null;
  attributedBody: Uint8Array | null;
  isFromMe: bigint | null;
  dateEdited: bigint | null;
  dateRetracted: bigint | null;
  summaryInfo: Uint8Array | null;
}

/** The opaque cursor for "everything after this row". */
function mintCursor(lastDate: bigint, chatRowid: bigint): string {
  return Buffer.from(
    `${lastDate.toString()}.${chatRowid.toString()}`,
    'utf8',
  ).toString('base64url');
}

/**
 * The keyset a cursor stands for, or an `InvalidCursorError`. Only the exact
 * bytes `mintCursor` writes are accepted: base64url that re-encodes to
 * itself (no padding, no stray characters, valid UTF-8), two canonical
 * decimal integers, each within SQLite's integer range.
 */
function readCursor(cursor: string): { lastDate: bigint; chatRowid: bigint } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    cursor.length === 0 ||
    Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
  ) {
    throw new InvalidCursorError();
  }
  const m = CURSOR_RE.exec(decoded);
  if (m === null) throw new InvalidCursorError();
  const lastDate = BigInt(m[1] ?? '');
  const chatRowid = BigInt(m[2] ?? '');
  if (lastDate > INT64_MAX || chatRowid > INT64_MAX) {
    throw new InvalidCursorError();
  }
  return { lastDate, chatRowid };
}

/** The opaque transcript cursor for "every turn older than this one". */
function mintTurnCursor(date: bigint, rowid: bigint): string {
  return Buffer.from(
    `t.${date.toString()}.${rowid.toString()}`,
    'utf8',
  ).toString('base64url');
}

/**
 * The keyset a transcript cursor stands for, or an \`InvalidCursorError\`.
 * Same strictness as \`readCursor\`: only the exact bytes
 * \`mintTurnCursor\` writes are accepted.
 */
function readTurnCursor(cursor: string): { date: bigint; rowid: bigint } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (
    cursor.length === 0 ||
    Buffer.from(decoded, 'utf8').toString('base64url') !== cursor
  ) {
    throw new InvalidCursorError();
  }
  const m = TURN_CURSOR_RE.exec(decoded);
  if (m === null) throw new InvalidCursorError();
  const date = BigInt(m[1] ?? '');
  const rowid = BigInt(m[2] ?? '');
  if (date > INT64_MAX || rowid > INT64_MAX) throw new InvalidCursorError();
  return { date, rowid };
}

interface ChatPageDbRow {
  rowid: bigint;
  d: bigint;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  dateEdited: bigint | null;
  dateRetracted: bigint | null;
  isFromMe: bigint | null;
  isAudioMessage: bigint | null;
  summaryInfo: Uint8Array | null;
  handle: string | null;
  service: string | null;
  error: bigint | null;
  isSent: bigint | null;
  isDelivered: bigint | null;
  dateDelivered: bigint | null;
  dateRead: bigint | null;
}

/** What one page read adds to each row: from the chat and the per-page reads. */
interface PageContext {
  isGroup: boolean;
  files: ReadonlyMap<bigint, TurnFile[]>;
  reactions: ReadonlyMap<string, TurnReaction[]>;
}

/**
 * One transcript turn from one row. The text is read the way normalizeRow
 * reads it (text column, else the decoded attributedBody, an edit's newest
 * revision when its summary decodes, nothing for an unsend), then the
 * attachment placeholder is dropped and the ends trimmed. A row that fails
 * to decode is no text: it is NOT reported, because a page view is a read
 * and the decode-failure sink writes audit rows.
 */
function turnOf(r: ChatPageDbRow, ctx: PageContext): TranscriptTurn {
  const unsent = (r.dateRetracted ?? 0n) > 0n;
  const edited = (r.dateEdited ?? 0n) > 0n;
  let text: string | null = null;
  if (!unsent) {
    text = r.text;
    if (text === null && r.attributedBody !== null) {
      const decoded = decodeTypedstreamText(r.attributedBody);
      if (decoded.ok) text = decoded.text;
    }
    if (edited && r.summaryInfo !== null) {
      const latest = decodeSummaryInfoLatestText(r.summaryInfo);
      if (latest.ok) text = latest.text;
    }
    if (text !== null) {
      const line = text.replace(OBJECT_REPLACEMENT, '').trim();
      text = line.length > 0 ? line : null;
    }
  }
  const allFiles = ctx.files.get(r.rowid) ?? [];
  const attachments = allFiles.length;
  const fromMe = r.isFromMe === 1n;
  const service = mapService(r.service);
  const delivery = deliveryOf({
    isFromMe: r.isFromMe,
    service,
    isGroup: ctx.isGroup,
    error: r.error,
    isSent: r.isSent,
    isDelivered: r.isDelivered,
    dateDelivered: r.dateDelivered,
    dateRead: r.dateRead,
  });
  const kind: TurnKind =
    r.isAudioMessage === 1n
      ? 'audio'
      : text === null && !unsent && attachments > 0
        ? 'attachment-only'
        : 'text';
  return {
    guid: r.guid,
    from: fromMe ? 'me' : 'them',
    kind,
    text,
    at: chatDbDateToIso(r.d),
    ...(!fromMe && r.handle !== null ? { handle: r.handle } : {}),
    ...(edited && !unsent
      ? { editedAt: chatDbDateToIso(r.dateEdited ?? 0n) }
      : {}),
    ...(unsent ? { unsentAt: chatDbDateToIso(r.dateRetracted ?? 0n) } : {}),
    attachments,
    service,
    ...(delivery !== undefined ? { delivery } : {}),
    reactions: ctx.reactions.get(r.guid) ?? [],
    files: allFiles.slice(0, FILES_PER_TURN_MAX),
  };
}

/**
 * The newest line, as normalizeRow would read it, ready for one row of a
 * list: the text column when present, else the decoded attributedBody; an
 * edit's latest revision when its summary decodes; nothing for an unsend.
 * The attachment placeholder is dropped and the ends trimmed, and what is
 * left empty is no line at all. Internal whitespace is left RAW: collapsing
 * it is presentation, and the renderer owns presentation.
 */
function lastLineOf(row: ListChatsDbRow): string | null {
  if ((row.dateRetracted ?? 0n) > 0n) return null;
  let text = row.text;
  if (text === null && row.attributedBody !== null) {
    const decoded = decodeTypedstreamText(row.attributedBody);
    if (decoded.ok) text = decoded.text;
  }
  if ((row.dateEdited ?? 0n) > 0n && row.summaryInfo !== null) {
    const latest = decodeSummaryInfoLatestText(row.summaryInfo);
    if (latest.ok) text = latest.text;
  }
  if (text === null) return null;
  const line = text.replace(OBJECT_REPLACEMENT, '').trim();
  return line.length > 0 ? line : null;
}

/**
 * v2 F2: the columns titleOf reads, for the chats named in a JSON array of
 * guids (or every chat, when the array parameter is NULL). Same participant
 * subquery as LIST_CHATS_SQL, so a title here is the title in the list.
 */
const CHAT_TITLES_SQL = `
  SELECT
    c.guid            AS chatGuid,
    c.display_name    AS displayName,
    c.chat_identifier AS chatIdentifier,
    (SELECT json_group_array(h.id)
       FROM chat_handle_join chj
       JOIN handle h ON h.ROWID = chj.handle_id
      WHERE chj.chat_id = c.ROWID) AS participants
  FROM chat c
  WHERE @guids IS NULL OR c.guid IN (SELECT value FROM json_each(@guids))
`;

/** v2 F2: the message guids, of those asked about, chat.db still holds. */
const EXISTING_GUIDS_SQL = `
  SELECT guid FROM message WHERE guid IN (SELECT value FROM json_each(?))
`;

interface ChatTitleDbRow {
  chatGuid: string;
  displayName: string | null;
  chatIdentifier: string | null;
  participants: string | null;
}

/** Case and diacritics folded, for the in: match ("Café" finds "cafe"). */
function foldForMatch(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The chat's own name, else (for a group) its participants sorted and
 * comma-separated, else its identifier. chat.db writes "" for an unnamed
 * chat, so a name that is only whitespace is no name.
 */
function titleOf(
  row: Pick<ListChatsDbRow, 'displayName' | 'participants' | 'chatIdentifier'>,
  isGroup: boolean,
): string {
  const named = row.displayName?.trim() ?? '';
  if (named.length > 0) return named;
  if (isGroup) {
    const ids = (JSON.parse(row.participants ?? '[]') as unknown[]).filter(
      (id): id is string => typeof id === 'string',
    );
    // One handle id can appear once per service; it is one participant.
    const people = [...new Set(ids)].sort();
    if (people.length > 0) return people.join(', ');
  }
  return row.chatIdentifier ?? '';
}

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
  const findOutboundStmt = db.prepare(FIND_OUTBOUND_SQL);
  const chatTurnsStmt = db.prepare(CHAT_TURNS_SQL);
  chatTurnsStmt.safeIntegers(true);
  const listChatsStmt = db.prepare(LIST_CHATS_SQL);
  listChatsStmt.safeIntegers(true); // dates exceed 2^53, and so may a cursor
  const chatRowidStmt = db.prepare(CHAT_ROWID_SQL);
  chatRowidStmt.safeIntegers(true);
  const chatPageStmt = db.prepare(CHAT_PAGE_SQL);
  chatPageStmt.safeIntegers(true);
  const filesForPageStmt = db.prepare(FILES_FOR_PAGE_SQL);
  filesForPageStmt.safeIntegers(true);
  const reactionsForPageStmt = db.prepare(REACTIONS_FOR_PAGE_SQL);
  reactionsForPageStmt.safeIntegers(true);
  const chatTitlesStmt = db.prepare(CHAT_TITLES_SQL);
  const existingGuidsStmt = db.prepare(EXISTING_GUIDS_SQL);
  existingGuidsStmt.pluck(true);

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

      // v2 F5: the newest 1:1 wins; a group is the answer only when the
      // handle has no 1:1 at all. "Newest chat containing the handle" would
      // hand a draft to the group the person last spoke in.
      const seenChats = new Set<number>();
      let best: { row: ResolveCandidateRow; date: bigint; n: number } | null =
        null;
      for (const candidate of matches) {
        if (seenChats.has(candidate.chatRowid)) continue;
        seenChats.add(candidate.chatRowid);
        const row = lastMessageDateStmt.get(candidate.chatRowid) as {
          lastDate: bigint | null;
        };
        const date = row.lastDate ?? 0n;
        const { n } = participantCountStmt.get(candidate.chatRowid) as {
          n: number;
        };
        const solo = n <= 1;
        const bestSolo = best !== null && best.n <= 1;
        if (
          best === null ||
          (solo && !bestSolo) ||
          (solo === bestSolo && date > best.date)
        ) {
          best = { row: candidate, date, n };
        }
      }
      if (best === null) return Promise.resolve(null);

      return Promise.resolve({
        chatGuid: best.row.chatGuid,
        service: mapService(best.row.service),
        isGroup: best.n > 1,
      });
    },

    readChatTurns(q: {
      chatGuid: ChatGuid;
      limit: number;
    }): Promise<ChatTurn[]> {
      const rows = chatTurnsStmt.all(
        q.chatGuid,
        BigInt(Math.max(0, q.limit)),
      ) as DbMessageRow[];
      // Reversed here, not in SQL: the LIMIT has to bite on the NEWEST rows,
      // so the query is descending and the presentation order is ours.
      return Promise.resolve(
        rows.reverse().map((r) => {
          const message = toMessage(r);
          return {
            from: message.isFromMe ? ('me' as const) : ('them' as const),
            text: message.text,
            at: message.receivedAt,
          };
        }),
      );
    },

    findOutboundMessage(q: {
      chatGuid: ChatGuid;
      text: string;
      sinceIso: string;
    }): Promise<{ guid: MessageGuid } | null> {
      const sinceNs = isoToAppleNs(q.sinceIso);
      for (const row of findOutboundStmt.iterate(
        q.chatGuid,
        q.text,
        sinceNs,
      ) as IterableIterator<OutboundCandidateRow>) {
        if (outboundBodyEquals(row, q.text)) {
          return Promise.resolve({ guid: row.guid });
        }
      }
      return Promise.resolve(null);
    },

    listChats(q: ChatsQuery): Promise<ChatsPage> {
      // Every failure is a rejection, never a throw: a caller that awaits
      // this sees one error channel whether the cursor was forged or the
      // database went away.
      try {
        const limit = Math.min(
          LIST_CHATS_MAX,
          Math.max(1, Math.trunc(q.limit) || 1),
        );
        const after = q.cursor === undefined ? null : readCursor(q.cursor);
        const rows = listChatsStmt.all(
          after?.lastDate ?? null,
          after?.lastDate ?? null,
          after?.lastDate ?? null,
          after?.chatRowid ?? null,
          BigInt(limit + 1),
        ) as ListChatsDbRow[];
        const total = Number(rows[0]?.total ?? 0n);
        const held = rows.filter(
          (r): r is ListChatsDbRow & { chatRowid: bigint; lastDate: bigint } =>
            r.chatRowid !== null && r.lastDate !== null,
        );
        const pageRows = held.slice(0, limit);
        const chats: ChatSummary[] = pageRows.map((r) => {
          const chatGuid = r.chatGuid ?? '';
          const { isGroup } = parseChatGuid(chatGuid);
          return {
            chatGuid,
            title: titleOf(r, isGroup),
            isGroup,
            lastLine: lastLineOf(r),
            lastFromMe: r.isFromMe === 1n,
            lastAt: chatDbDateToIso(r.lastDate),
          };
        });
        const tail = pageRows[pageRows.length - 1];
        const nextCursor =
          held.length > limit && tail !== undefined
            ? mintCursor(tail.lastDate, tail.chatRowid)
            : null;
        return Promise.resolve({ chats, nextCursor, total });
      } catch (err) {
        return Promise.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },

    readChatPage(q: TurnsQuery): Promise<TurnsPage> {
      // One error channel, as for listChats: every failure is a rejection.
      try {
        const limit = Math.min(
          CHAT_PAGE_MAX,
          Math.max(1, Math.trunc(q.limit) || 1),
        );
        const before = q.before === undefined ? null : readTurnCursor(q.before);
        let untilNs: bigint | null = null;
        if (q.until !== undefined) {
          const ms = Date.parse(q.until);
          if (Number.isNaN(ms)) throw new RangeError('until is not an instant');
          untilNs = isoToAppleNs(new Date(ms).toISOString());
        }
        const chat = chatRowidStmt.get(q.chatGuid) as
          { chatRowid: bigint; style: bigint | null } | undefined;
        if (chat === undefined) throw new UnknownChatError();
        const rows = chatPageStmt.all({
          chatRowid: chat.chatRowid,
          beforeDate: before?.date ?? null,
          beforeRowid: before?.rowid ?? null,
          untilNs,
          // Floor division toward -inf, so a pre-2001 instant stays below 0.
          untilSeconds:
            untilNs === null
              ? null
              : untilNs >= 0n
                ? untilNs / 1_000_000_000n
                : -((-untilNs + 999_999_999n) / 1_000_000_000n),
          limit: BigInt(limit + 1),
        }) as ChatPageDbRow[];
        const pageRows = rows.slice(0, limit);
        const oldest = pageRows[pageRows.length - 1];
        const nextBefore =
          rows.length > limit && oldest !== undefined
            ? mintTurnCursor(oldest.d, oldest.rowid)
            : null;
        // v2 F4: files and reactions for the whole page, one read each.
        const files = new Map<bigint, TurnFile[]>();
        const reactions = new Map<string, TurnReaction[]>();
        if (oldest !== undefined) {
          const fileRows = filesForPageStmt.all({
            rowids: `[${pageRows.map((r) => r.rowid.toString()).join(',')}]`,
          }) as FileDbRow[];
          for (const f of fileRows) {
            const list = files.get(f.messageRowid) ?? [];
            list.push(fileOf(f));
            files.set(f.messageRowid, list);
          }
          const reactionRows = reactionsForPageStmt.all({
            chatRowid: chat.chatRowid,
            oldestD: oldest.d,
          }) as ReactionRow[];
          for (const [guid, list] of foldReactions(
            reactionRows,
            new Set(pageRows.map((r) => r.guid)),
          )) {
            reactions.set(guid, list);
          }
        }
        const ctx: PageContext = {
          isGroup: chat.style === CHAT_STYLE_GROUP,
          files,
          reactions,
        };
        // Fetched newest first so the LIMIT bites on the newest rows; read
        // top to bottom, so handed back oldest first.
        return Promise.resolve({
          turns: pageRows.reverse().map((r) => turnOf(r, ctx)),
          nextBefore,
        });
      } catch (err) {
        return Promise.reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    },

    chatTitles(guids: readonly string[]): Map<string, ChatTitle> {
      const out = new Map<string, ChatTitle>();
      if (guids.length === 0) return out;
      for (const r of chatTitlesStmt.all({
        guids: JSON.stringify(guids),
      }) as ChatTitleDbRow[]) {
        const { isGroup } = parseChatGuid(r.chatGuid);
        out.set(r.chatGuid, { title: titleOf(r, isGroup), isGroup });
      }
      return out;
    },

    chatsTitled(needle: string): string[] {
      const want = foldForMatch(needle);
      const out: string[] = [];
      for (const r of chatTitlesStmt.all({ guids: null }) as ChatTitleDbRow[]) {
        const { isGroup } = parseChatGuid(r.chatGuid);
        if (foldForMatch(titleOf(r, isGroup)).includes(want)) {
          out.push(r.chatGuid);
        }
      }
      return out.sort();
    },

    existingGuids(guids: readonly string[]): Set<string> {
      if (guids.length === 0) return new Set();
      return new Set(existingGuidsStmt.all(JSON.stringify(guids)) as string[]);
    },

    close() {
      db.close();
    },
  };
}

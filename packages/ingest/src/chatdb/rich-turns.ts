/**
 * v2 F4: rich turns, the pure half. Service, delivery, reactions and file
 * metadata for one page of a transcript, folded from rows the reader has
 * already fetched in three statements. No I/O here: every function is value
 * in, value out, so each rule is tested without a database.
 *
 * Claimed only as far as chat.db proves it:
 *  - delivery is a ladder, first match wins, and anything it cannot prove is
 *    null. There is no "sending": in flight and stuck look the same.
 *  - a reaction's emoji (2006) or sticker (2007) is not read: its kind is
 *    `other`.
 *  - a file is a name, a type and a size. Never a path, never dimensions.
 */
import type {
  IsoUtc,
  ReactionKind,
  Service,
  TurnDelivery,
  TurnFile,
  TurnReaction,
} from '@wemessage/core';
import { appleNsToIso } from '../normalize/index.js';

/** The tapback type ranges: an add, and the removal of the same kind. */
export const TAPBACK_ADD = [2000, 2007] as const;
export const TAPBACK_REMOVE = [3000, 3007] as const;

/**
 * Below this a chat.db date is SECONDS since 2001, not nanoseconds: 1e11
 * seconds is the year 5170, and 1e11 nanoseconds is 100 seconds into 2001.
 */
export const SECONDS_ERA_LIMIT = 100_000_000_000n;

/** A chat.db date (seconds or nanoseconds since 2001) as ISO-8601 UTC. */
export function chatDbDateToIso(raw: bigint): IsoUtc {
  return raw < SECONDS_ERA_LIMIT
    ? appleNsToIso(raw * 1_000_000_000n)
    : appleNsToIso(raw);
}

/** The longest file name the wire carries, in UTF-16 code units. */
export const FILE_NAME_MAX = 255;

const KINDS: readonly ReactionKind[] = [
  'love',
  'like',
  'dislike',
  'laugh',
  'emphasize',
  'question',
];

/** 2000..2005 (or the matching 300x removal) by name; anything else `other`. */
export function reactionKind(type: number): ReactionKind {
  const base = type >= TAPBACK_REMOVE[0] ? type - 1000 : type;
  return KINDS[base - TAPBACK_ADD[0]] ?? 'other';
}

function inRange(type: number, [lo, hi]: readonly [number, number]): boolean {
  return type >= lo && type <= hi;
}

/** Tapback targets are stored as `p:<part>/<guid>` or `bp:<guid>`. */
export function tapbackTargetGuid(associated: string): string {
  return associated.replace(/^(?:bp:|p:\d+\/)/, '');
}

/** One tapback row as REACTIONS_FOR_PAGE_SQL reads it. */
export interface ReactionRow {
  rowid: bigint;
  date: bigint | null;
  type: bigint | number | null;
  target: string | null;
  isFromMe: bigint | null;
  handle: string | null;
}

/**
 * The reactions standing on each page turn. For each (target, sender) the
 * latest row by (date, ROWID) wins; a removal clears that sender; a part
 * index folds onto the whole turn. Rows aimed outside the page are ignored.
 * Turns with no standing reaction are absent from the map.
 */
export function foldReactions(
  rows: readonly ReactionRow[],
  pageGuids: ReadonlySet<string>,
): Map<string, TurnReaction[]> {
  const latest = new Map<
    string,
    { target: string; row: ReactionRow; type: number }
  >();
  for (const row of rows) {
    if (row.target === null) continue;
    const type = Number(row.type ?? 0);
    if (!inRange(type, TAPBACK_ADD) && !inRange(type, TAPBACK_REMOVE)) {
      continue;
    }
    const target = tapbackTargetGuid(row.target);
    if (!pageGuids.has(target)) continue;
    const sender = row.isFromMe === 1n ? 'me' : `them:${row.handle ?? ''}`;
    const key = `${target}\u0000${sender}`;
    const held = latest.get(key);
    if (held === undefined || later(row, held.row)) {
      latest.set(key, { target, row, type });
    }
  }
  const standing = [...latest.values()]
    .filter((e) => inRange(e.type, TAPBACK_ADD))
    .sort((a, b) => (later(a.row, b.row) ? 1 : later(b.row, a.row) ? -1 : 0));
  const out = new Map<string, TurnReaction[]>();
  for (const { target, row, type } of standing) {
    const fromMe = row.isFromMe === 1n;
    const reaction: TurnReaction = {
      kind: reactionKind(type),
      from: fromMe ? 'me' : 'them',
      ...(!fromMe && row.handle !== null ? { handle: row.handle } : {}),
    };
    const list = out.get(target);
    if (list === undefined) out.set(target, [reaction]);
    else list.push(reaction);
  }
  return out;
}

/** Is `a` after `b` by (date, ROWID)? */
function later(a: ReactionRow, b: ReactionRow): boolean {
  const da = a.date ?? 0n;
  const db = b.date ?? 0n;
  return da !== db ? da > db : a.rowid > b.rowid;
}

/** The delivery columns of one page row. Any of them may be NULL. */
export interface DeliveryInput {
  isFromMe: bigint | null;
  service: Service;
  isGroup: boolean;
  error: bigint | null;
  isSent: bigint | null;
  isDelivered: bigint | null;
  dateDelivered: bigint | null;
  dateRead: bigint | null;
}

/**
 * The delivery ladder, first match wins. Undefined for an inbound turn
 * (it never carries one); null when no rung is proven.
 *  1. error != 0                                   -> failed
 *  2. date_read > 0, iMessage, 1:1                 -> read
 *  3. is_delivered = 1 or date_delivered > 0       -> delivered
 *  4. is_sent = 1                                  -> sent
 */
export function deliveryOf(r: DeliveryInput): TurnDelivery | null | undefined {
  if (r.isFromMe !== 1n) return undefined;
  const error = r.error ?? 0n;
  if (error !== 0n) {
    return { state: 'failed', at: null, errorCode: Number(error) };
  }
  const dateRead = r.dateRead ?? 0n;
  if (dateRead > 0n && r.service === 'imessage' && !r.isGroup) {
    return { state: 'read', at: chatDbDateToIso(dateRead) };
  }
  const dateDelivered = r.dateDelivered ?? 0n;
  if (r.isDelivered === 1n || dateDelivered > 0n) {
    return {
      state: 'delivered',
      at: dateDelivered > 0n ? chatDbDateToIso(dateDelivered) : null,
    };
  }
  if (r.isSent === 1n) return { state: 'sent', at: null };
  return null;
}

/** One attachment row as FILES_FOR_PAGE_SQL reads it. Never a path. */
export interface FileDbRow {
  messageRowid: bigint;
  transferName: string | null;
  mimeType: string | null;
  uti: string | null;
  totalBytes: bigint | null;
  isSticker: bigint | null;
  hidden: bigint | null;
}

/**
 * The last path component of a transfer name, capped. A name that is only
 * separators, `.` or `..` is no name.
 */
export function baseName(raw: string | null): string | null {
  if (raw === null) return null;
  const last = raw.split('/').pop() ?? '';
  if (last.length === 0 || last === '.' || last === '..') return null;
  return last.length > FILE_NAME_MAX ? last.slice(0, FILE_NAME_MAX) : last;
}

/** One file's metadata. `total_bytes = 0` is an unknown size, not empty. */
export function fileOf(r: FileDbRow): TurnFile {
  const bytes = r.totalBytes ?? 0n;
  return {
    name: baseName(r.transferName),
    mime: r.mimeType,
    uti: r.uti,
    bytes: bytes > 0n ? Number(bytes) : null,
    sticker: r.isSticker === 1n,
    hidden: r.hidden === 1n,
  };
}

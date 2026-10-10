// @wemessage/core/search: message search over the daemon's own mirror (v2 F2).
//
// The mirror (`inbound_messages`) already holds every scanned message's
// decoded text, both directions. The store keeps a contentless trigram FTS5
// index beside it and answers `MirrorQuery`; this module owns the shapes
// that cross that seam and, from F2b, the pure compile step that turns the
// operator's structured tokens into one.
//
// Nothing here touches a database, a clock or a network. sha256 (the
// cursor's query digest) is pure, as it is for core/audit's chain.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { ChatGuid, Handle, IsoUtc, MessageGuid } from '../domain/types.js';
import { InvalidCursorError } from '../threads/index.js';

/** D-F2-4: the most matches one query ever materialises. */
export const SEARCH_MATCH_CAP = 20_000;
/** The largest page a client may ask for. */
export const SEARCH_PAGE_MAX = 100;
/**
 * The trigram tokenizer cannot match anything shorter than this, and a
 * shorter MATCH returns zero rows WITHOUT an error. No term under this
 * length is ever handed to MATCH; the store matches it with `instr()`.
 */
export const TRIGRAM_MIN = 3;
/** Rows one backfill step reads from the mirror. */
export const INDEX_BATCH = 2_000;
/**
 * D-F2-3: with no indexable term to narrow by, a short term is matched in
 * at most this many of the newest candidate rows, and says so.
 */
export const SHORT_TERM_WINDOW = 20_000;
/** The settings key holding the index's through-mark, in chat.db ROWID space. */
export const SETTING_SEARCH_INDEXED_THROUGH = 'search.indexedThroughRowid';

/**
 * The mirror kinds the index holds, when they carry text. Tapbacks and
 * unsends are never search hits. 'edit' is here because an edited message's
 * row carries its latest text and must stay findable by it.
 */
export const SEARCHABLE_KINDS: readonly string[] = [
  'text',
  'edit',
  'audio',
  'attachment-only',
];

export type SearchHas = 'attachment' | 'link' | 'voice';

/** What the store is asked. Every field narrows; absent means "any". */
export interface MirrorQuery {
  /** An FTS5 MATCH expression built only from terms of TRIGRAM_MIN or more. */
  ftsMatch: string | null;
  /** Terms shorter than TRIGRAM_MIN, matched case-insensitively by `instr()`. */
  shortTerms: string[];
  fromMe?: boolean;
  /** from:name — inbound rows whose handle contains this, lowercased. */
  handleNeedle?: string;
  /** from:name — inbound rows from any of these handles (saved names). */
  handles?: Handle[];
  /** in:title — rows in these chats. null means the filter could not run. */
  chatGuids?: ChatGuid[] | null;
  has: SearchHas[];
  /** Exclusive upper bound on `sent_at`, an ISO instant in UTC. */
  before?: IsoUtc;
  /** Inclusive lower bound on `sent_at`, an ISO instant in UTC. */
  after?: IsoUtc;
  cap: number;
}

export interface MirrorMatch {
  guid: MessageGuid;
  chatGuid: ChatGuid;
  handle: Handle;
  isFromMe: boolean;
  isGroup: boolean;
  kind: string;
  text: string | null;
  sentAt: IsoUtc;
  hasAttachment: boolean;
}

/**
 * Sorted newest sent first, ties on guid ascending. `capped` is true when
 * more rows matched than `cap`; `matches` then holds the newest `cap` by
 * arrival (FTS) or by sent time (filter-only), re-sorted.
 * `shortTermWindowed` is true when a short term was matched only inside the
 * SHORT_TERM_WINDOW newest candidates.
 */
export interface MirrorResult {
  matches: MirrorMatch[];
  capped: boolean;
  shortTermWindowed: boolean;
}

export interface MirrorCoverage {
  /** Rows the index holds. */
  indexed: number;
  /** Rows that are, or will be once the backfill catches up, indexed. */
  eligible: number;
  /** The highest chat.db ROWID the backfill has walked past. */
  throughRowid: number;
  /** The cursor's last scan instant: the mirror is current as of then. */
  mirrorAsOf: IsoUtc | null;
}

/* ------------------------------------------------------------------------ */
/* v2 F2b: the operator's query, compiled                                    */
/* ------------------------------------------------------------------------ */

/** The channels a search can name. Only iMessage has a source today. */
export const SEARCH_CHANNELS = [
  'imessage',
  'whatsapp',
  'linkedin',
  'email',
] as const;
export type SearchChannel = (typeof SEARCH_CHANNELS)[number];

/** The longest hit text the wire carries, in UTF-16 code units. */
export const SEARCH_HIT_TEXT_MAX = 4_000;
/** How many senders the facet names. */
export const SEARCH_SENDER_FACETS = 4;

/**
 * What the operator asked, as structured tokens. The app parses the raw
 * string (one parser, in the app); the daemon only ever sees this.
 * `before` and `after` are instants the app computed in its own calendar.
 */
export interface SearchParams {
  terms: string[];
  from?: { me: true } | { name: string };
  in?: string;
  channels: SearchChannel[];
  has: SearchHas[];
  before?: IsoUtc;
  after?: IsoUtc;
}

export type SearchTokenOp =
  'term' | 'from' | 'in' | 'channel' | 'has' | 'before' | 'after';

export type SearchTokenReason =
  'short-term' | 'handles-and-saved-names' | 'source-unavailable' | 'no-source';

/** One token, and how far the daemon could honour it. None is dropped. */
export interface TokenApplied {
  op: SearchTokenOp;
  value: string;
  applied: 'applied' | 'partial' | 'not-applied';
  reason?: SearchTokenReason;
}

/** What the daemon looked up before it compiled. */
export interface SearchResolved {
  /**
   * The chats whose title holds the `in:` text. null: the source could not
   * be read, so the filter could not run.
   */
  chatGuids: ChatGuid[] | null;
  /** Handles whose saved display name holds the `from:` name. */
  savedHandles: Handle[];
}

/**
 * `q` is null when nothing the query names has a source (a channel filter
 * that leaves iMessage out): there is nothing to search, and coverage says
 * so rather than answering from a channel that was not asked for.
 */
export interface CompiledSearch {
  q: MirrorQuery | null;
  tokens: TokenApplied[];
}

/** Length in code points, so an emoji is one character, as the operator sees it. */
function codePoints(s: string): number {
  return [...s].length;
}

/**
 * One term as an FTS5 phrase: quoted, an embedded quote doubled. Only a
 * term the trigram tokenizer can match is ever quoted; a shorter one would
 * MATCH nothing without an error (the silent-zero trap).
 */
export function ftsPhrase(term: string): string {
  if (codePoints(term) < TRIGRAM_MIN) {
    throw new RangeError(
      `a term under ${String(TRIGRAM_MIN)} characters is never an FTS phrase`,
    );
  }
  return `"${term.replaceAll('"', '""')}"`;
}

/** True when a token list has nothing to search by. */
export function isEmptySearch(p: SearchParams): boolean {
  return (
    p.terms.length === 0 &&
    p.from === undefined &&
    p.in === undefined &&
    p.channels.length === 0 &&
    p.has.length === 0 &&
    p.before === undefined &&
    p.after === undefined
  );
}

/**
 * The structured query to a MirrorQuery, and every token's fate.
 *
 *  - term: three or more characters goes to the trigram index; a shorter
 *    one is matched with `instr()`. Beside a long term it narrows the long
 *    term's hits, so it is applied in full. Alone, the store matches it in
 *    the newest SHORT_TERM_WINDOW candidates only, and it says so.
 *  - from:me is `is_from_me`. from:name matches handles and saved names,
 *    never the Contacts app the daemon cannot read: always partial.
 *  - in: needs chat titles from the source. When that read failed the
 *    filter does not run, and the token says not-applied.
 *  - channel: iMessage is the one channel with a source.
 */
export function compileSearch(
  p: SearchParams,
  resolved: SearchResolved,
): CompiledSearch {
  const tokens: TokenApplied[] = [];
  const terms = p.terms;
  const long = terms.filter((t) => codePoints(t) >= TRIGRAM_MIN);
  const short = terms.filter((t) => codePoints(t) < TRIGRAM_MIN);
  for (const t of terms) {
    if (codePoints(t) >= TRIGRAM_MIN || long.length > 0) {
      tokens.push({ op: 'term', value: t, applied: 'applied' });
    } else {
      tokens.push({
        op: 'term',
        value: t,
        applied: 'partial',
        reason: 'short-term',
      });
    }
  }

  const q: MirrorQuery = {
    ftsMatch: long.length > 0 ? long.map(ftsPhrase).join(' ') : null,
    shortTerms: short,
    has: [...p.has],
    cap: SEARCH_MATCH_CAP,
  };

  if (p.from !== undefined) {
    if ('me' in p.from) {
      q.fromMe = true;
      tokens.push({ op: 'from', value: 'me', applied: 'applied' });
    } else {
      q.handleNeedle = p.from.name;
      q.handles = [...resolved.savedHandles];
      tokens.push({
        op: 'from',
        value: p.from.name,
        applied: 'partial',
        reason: 'handles-and-saved-names',
      });
    }
  }

  if (p.in !== undefined) {
    if (resolved.chatGuids === null) {
      tokens.push({
        op: 'in',
        value: p.in,
        applied: 'not-applied',
        reason: 'source-unavailable',
      });
    } else {
      q.chatGuids = [...resolved.chatGuids];
      tokens.push({ op: 'in', value: p.in, applied: 'applied' });
    }
  }

  for (const c of p.channels) {
    tokens.push(
      c === 'imessage'
        ? { op: 'channel', value: c, applied: 'applied' }
        : {
            op: 'channel',
            value: c,
            applied: 'not-applied',
            reason: 'no-source',
          },
    );
  }
  for (const h of p.has) {
    tokens.push({ op: 'has', value: h, applied: 'applied' });
  }
  if (p.before !== undefined) {
    q.before = p.before;
    tokens.push({ op: 'before', value: p.before, applied: 'applied' });
  }
  if (p.after !== undefined) {
    q.after = p.after;
    tokens.push({ op: 'after', value: p.after, applied: 'applied' });
  }

  const imessageAsked =
    p.channels.length === 0 || p.channels.includes('imessage');
  return { q: imessageAsked ? q : null, tokens };
}

/* ------------------------------------------------------------------------ */
/* Cursor                                                                    */
/* ------------------------------------------------------------------------ */

/** The keyset a search page continues after: (sentAt DESC, guid ASC). */
export interface SearchKey {
  sentAt: IsoUtc;
  guid: MessageGuid;
}

/**
 * A digest of everything that decides the match set and its facets, and
 * nothing that only pages it (`limit`, `cursor`). A cursor carries it, so a
 * cursor reused under a different query is refused, not misread.
 */
export function searchQueryHash(p: SearchParams, tz: string): string {
  const canonical = JSON.stringify([
    p.terms,
    p.from === undefined
      ? null
      : 'me' in p.from
        ? { me: true }
        : { name: p.from.name },
    p.in ?? null,
    p.channels,
    p.has,
    p.before ?? null,
    p.after ?? null,
    tz,
  ]);
  return createHash('sha256')
    .update(canonical, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** A page's continuation. Opaque to every client. */
export function mintSearchCursor(k: SearchKey, queryHash: string): string {
  const body = JSON.stringify({ v: 1, s: k.sentAt, g: k.guid, h: queryHash });
  return Buffer.from(body, 'utf8').toString('base64url');
}

/**
 * The key a cursor stands for, or an InvalidCursorError: a cursor this
 * module did not mint, or one minted for a different query.
 */
export function readSearchCursor(cursor: string, queryHash: string): SearchKey {
  if (!BASE64URL.test(cursor)) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCursorError();
  }
  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (
    keys !== 'g,h,s,v' ||
    o['v'] !== 1 ||
    typeof o['s'] !== 'string' ||
    !ISO_UTC_MS.test(o['s']) ||
    typeof o['g'] !== 'string' ||
    o['g'].length === 0 ||
    o['h'] !== queryHash
  ) {
    throw new InvalidCursorError();
  }
  const key: SearchKey = { sentAt: o['s'], guid: o['g'] };
  // Only the exact bytes mintSearchCursor writes.
  if (mintSearchCursor(key, queryHash) !== cursor)
    throw new InvalidCursorError();
  return key;
}

/** True when `m` sorts after `k` in (sentAt DESC, guid ASC). */
export function isAfterKey(m: SearchKey, k: SearchKey): boolean {
  return m.sentAt < k.sentAt || (m.sentAt === k.sentAt && m.guid > k.guid);
}

/* ------------------------------------------------------------------------ */
/* Time zones and facets                                                     */
/* ------------------------------------------------------------------------ */

/** True when Intl knows this IANA zone. */
export function isValidTimeZone(tz: string): boolean {
  if (tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `ms`, in ms (local minus UTC). */
function offsetAt(ms: number, tz: string): number {
  let fmt = zoneFormats.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormats.set(tz, fmt);
  }
  const parts: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts['year'] ?? 1970,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0,
  );
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant local midnight on January 1 of `year` happens in `tz`.
 * Two passes of the offset search settle a DST change between the guess
 * and the answer; no zone moves its clocks at New Year by more than that.
 */
export function yearStartInZone(year: number, tz: string): Date {
  const wall = Date.UTC(year, 0, 1);
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  return new Date(t);
}

/**
 * v2 F7a: the instant local midnight of the day `now` falls on in `tz`.
 * Same two-pass offset search as yearStartInZone, so a DST change between
 * the guess and the answer settles (no zone moves its clocks at midnight by
 * more than that). Status "today" counts from here, never from UTC midnight.
 */
export function dayStartInZone(now: Date, tz: string): Date {
  const ms = now.getTime();
  const local = new Date(ms + offsetAt(ms, tz));
  const wall = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  let t = wall - offsetAt(wall, tz);
  t = wall - offsetAt(t, tz);
  return new Date(t);
}

export interface YearFacet {
  year: number;
  count: number;
}

/**
 * Each match's year in `tz`, counted, newest year first. Compares ISO
 * strings against each year's start, so a match costs two string compares
 * and no formatter call.
 */
export function yearFacets(
  sentAts: readonly IsoUtc[],
  tz: string,
): YearFacet[] {
  const starts = new Map<number, string>();
  const startOf = (y: number): string => {
    let s = starts.get(y);
    if (s === undefined) {
      s = yearStartInZone(y, tz).toISOString();
      starts.set(y, s);
    }
    return s;
  };
  const counts = new Map<number, number>();
  for (const at of sentAts) {
    let y = Number(at.slice(0, 4));
    if (at >= startOf(y + 1)) y += 1;
    else if (at < startOf(y)) y -= 1;
    counts.set(y, (counts.get(y) ?? 0) + 1);
  }
  return [...counts]
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => b.year - a.year);
}

/** v2 F2c: one year of one conversation, for the transcript's scrubber. */
export interface YearCount {
  year: number;
  count: number;
  /** The year's oldest turn, or null for a year with none. */
  first: IsoUtc | null;
  /** The year's newest turn: where a jump to this year lands. */
  last: IsoUtc | null;
}

/**
 * v2 F2c: turns (as Unix milliseconds, any order) counted by their year in
 * `tz`, newest year first. Every year from the oldest turn's to the newest
 * turn's is present, a year with no turns as a count of 0 with null ends,
 * so a scrubber shows the silence instead of skipping over it. A year's
 * start is the instant its local New Year happens in `tz`
 * (yearStartInZone), so a boundary costs two number compares per turn and
 * no formatter call.
 */
export function yearCountsOf(
  turnsMs: readonly number[],
  tz: string,
): YearCount[] {
  if (turnsMs.length === 0) return [];
  const starts = new Map<number, number>();
  const startOf = (y: number): number => {
    let s = starts.get(y);
    if (s === undefined) {
      s = yearStartInZone(y, tz).getTime();
      starts.set(y, s);
    }
    return s;
  };
  const byYear = new Map<
    number,
    { count: number; first: number; last: number }
  >();
  for (const ms of turnsMs) {
    let y = new Date(ms).getUTCFullYear();
    if (ms >= startOf(y + 1)) y += 1;
    else if (ms < startOf(y)) y -= 1;
    const b = byYear.get(y);
    if (b === undefined) byYear.set(y, { count: 1, first: ms, last: ms });
    else {
      b.count += 1;
      if (ms < b.first) b.first = ms;
      if (ms > b.last) b.last = ms;
    }
  }
  const years = [...byYear.keys()];
  const newest = Math.max(...years);
  const oldest = Math.min(...years);
  const out: YearCount[] = [];
  for (let y = newest; y >= oldest; y -= 1) {
    const b = byYear.get(y);
    out.push(
      b === undefined
        ? { year: y, count: 0, first: null, last: null }
        : {
            year: y,
            count: b.count,
            first: new Date(b.first).toISOString(),
            last: new Date(b.last).toISOString(),
          },
    );
  }
  return out;
}

export interface SenderFacet {
  /** A handle, or 'me' for the operator's own messages. */
  handle: string;
  count: number;
}

/** The SEARCH_SENDER_FACETS most frequent senders, ties by handle. */
export function senderFacets(
  matches: readonly Pick<MirrorMatch, 'handle' | 'isFromMe'>[],
): SenderFacet[] {
  const counts = new Map<string, number>();
  for (const m of matches) {
    const key = m.isFromMe ? 'me' : m.handle;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([handle, count]) => ({ handle, count }))
    .sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : a.handle < b.handle
          ? -1
          : a.handle > b.handle
            ? 1
            : 0,
    )
    .slice(0, SEARCH_SENDER_FACETS);
}

/* ------------------------------------------------------------------------ */
/* The wire                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * Why a channel was not searched. `no-source`: this version reads nothing
 * from it. `not-requested`: the query's channel filter left it out.
 */
export type ChannelNotSearchedReason = 'no-source' | 'not-requested';

export type ChannelCoverage =
  | {
      channel: 'imessage';
      state: 'searched';
      indexed: number;
      eligible: number;
      indexedThroughRowid: number;
      mirrorAsOf: IsoUtc | null;
    }
  | {
      channel: SearchChannel;
      state: 'not-searched';
      reason: ChannelNotSearchedReason;
    };

export interface SearchCoverage {
  channels: ChannelCoverage[];
  tokens: TokenApplied[];
  /** More than SEARCH_MATCH_CAP rows matched; the newest were kept. */
  capped: boolean;
  /** Hits on this page dropped because Messages no longer holds them. */
  deletedHidden: number;
  /** false when chat.db could not be asked, so deleted hits may show. */
  deletionsChecked: boolean;
}

/** One hit as the wire carries it. Never `meta`, never a path. */
export interface SearchHitWire {
  guid: MessageGuid;
  chatGuid: ChatGuid;
  /** The chat's title, or null when the source could not be read. */
  title: string | null;
  isGroup: boolean;
  channel: 'imessage';
  from: 'me' | 'them';
  /** The sender's handle; null for the operator's own. */
  handle: string | null;
  text: string | null;
  sentAt: IsoUtc;
  hasAttachment: boolean;
}

export interface SearchFacets {
  years: YearFacet[];
  channels: { channel: SearchChannel; count: number }[];
  senders: SenderFacet[];
}

export interface SearchPageWire {
  hits: SearchHitWire[];
  /** Every match, not just this page's (at most SEARCH_MATCH_CAP). */
  total: number;
  nextCursor: string | null;
  asOf: IsoUtc;
  facets: SearchFacets;
  coverage: SearchCoverage;
}

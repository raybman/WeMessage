// @wemessage/core/search: message search over the daemon's own mirror (v2 F2).
//
// The mirror (`inbound_messages`) already holds every scanned message's
// decoded text, both directions. The store keeps a contentless trigram FTS5
// index beside it and answers `MirrorQuery`; this module owns the shapes
// that cross that seam and, from F2b, the pure compile step that turns the
// operator's structured tokens into one.
//
// Nothing here touches a database, a clock or a network.

import type { ChatGuid, Handle, IsoUtc, MessageGuid } from '../domain/types.js';

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

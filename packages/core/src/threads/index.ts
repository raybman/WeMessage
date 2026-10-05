// @wemessage/core/threads: the conversations list (v2 A1).
//
// A channel source is anything that can answer "which conversations exist,
// newest first, and how many are there". iMessage is the first one, read
// from the Messages database by `@wemessage/ingest`; phase B adds others
// behind the same two members, and the route that serves the list never
// learns which one it is holding beyond the `channel` tag it copies onto
// every row.
//
// Deliberately small. A source answers one question, a page of the list,
// and owns its own cursor: the cursor is opaque to everything above it, so
// a source whose natural order is not a date can still page.

import type { ChatGuid, IsoUtc } from '../domain/types.js';

/** The channels a source can be. Phase B widens this union, nothing else. */
export type ChannelName = 'imessage';

/** One page request. `cursor` is absent on the first page, never empty. */
export interface ChatsQuery {
  /** Rows wanted, 1..200. A source caps rather than trusting the caller. */
  limit: number;
  /** The `nextCursor` of the page before, verbatim. */
  cursor?: string;
}

/**
 * One conversation as the list draws it. Text fields are RAW: control
 * characters are stripped at the wire boundary by the same sanitiser every
 * other outbound shape uses, not here.
 */
export interface ChatSummary {
  chatGuid: ChatGuid;
  /** The chat's own name, else its participants, else its identifier. */
  title: string;
  isGroup: boolean;
  /** The newest readable line, or null when there is none to show. */
  lastLine: string | null;
  /** Whether that newest message was ours. */
  lastFromMe: boolean;
  /** When that newest message was sent. */
  lastAt: IsoUtc;
}

/** One page of the list, with the size of the whole list in the same read. */
export interface ChatsPage {
  chats: ChatSummary[];
  /** Null on the last page. */
  nextCursor: string | null;
  /** Every conversation the source would list, not just this page's. */
  total: number;
}

/** A source of conversations for one channel. */
export interface ChannelSource {
  readonly channel: ChannelName;
  listChats(q: ChatsQuery): Promise<ChatsPage>;
}

/**
 * A cursor this source did not mint, or one that no longer means anything.
 * The route answers it with a 400, distinct from a source that is down.
 */
export class InvalidCursorError extends Error {
  constructor(message = 'invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

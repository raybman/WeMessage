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

import type {
  ChatGuid,
  Handle,
  IsoUtc,
  MessageGuid,
  Service,
} from '../domain/types.js';

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

/**
 * v2 A2: one page of a single conversation's history. Newest first: the
 * first page is the end of the conversation, and each `before` walks back.
 * `until` anchors a date jump instead: the page ends at the newest message
 * sent at or before that instant. A query carries at most one of the two.
 */
export interface TurnsQuery {
  chatGuid: ChatGuid;
  /** Rows wanted, 1..200. A source caps rather than trusting the caller. */
  limit: number;
  /** The `nextBefore` of the page before, verbatim. */
  before?: string;
  /** A date jump: the newest turn on the page is at or before this instant. */
  until?: IsoUtc;
}

/**
 * What a turn mostly is, so the transcript can draw it without guessing:
 * words, an attachment with no words beside it, or a voice message.
 */
export type TurnKind = 'text' | 'attachment-only' | 'audio';

/**
 * One message in a transcript. Text is RAW, as for {@link ChatSummary}: the
 * wire strips control characters, not the source. A reaction is not a turn
 * (it belongs to the message it reacts to), and neither is a group event
 * such as a rename.
 */
export interface TranscriptTurn {
  guid: MessageGuid;
  from: 'me' | 'them';
  kind: TurnKind;
  /** The latest text, an edit's newest revision; null when unsent or none. */
  text: string | null;
  at: IsoUtc;
  /** Who sent it, for a turn from someone else when the source knows. */
  handle?: Handle;
  /** Present when the sender edited it. */
  editedAt?: IsoUtc;
  /** Present when the sender unsent it; `text` is then null. */
  unsentAt?: IsoUtc;
  /** How many attachments it carries. Counted, never opened. */
  attachments: number;
  /**
   * v2 F4: the service it went over. A source that cannot say leaves it
   * absent; the iMessage source always says, `unknown` included.
   */
  service?: Service;
  /**
   * v2 F4: how far an outbound turn is proven to have got. Only ever on a
   * turn `from: 'me'`; null means the source cannot prove any rung.
   */
  delivery?: TurnDelivery | null;
  /**
   * v2 F4: the reactions standing on it, one per sender. Absent means the
   * source does not say; `[]` means none.
   */
  reactions?: TurnReaction[];
  /**
   * v2 F4: metadata for each attachment, never a path. Absent means the
   * source does not say. At most {@link FILES_PER_TURN_MAX} entries, while
   * `attachments` stays the true count.
   */
  files?: TurnFile[];
}

/** v2 F4: what a tapback says. 2006 (emoji) and 2007 (sticker) are `other`. */
export type ReactionKind =
  'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question' | 'other';

/** v2 F4: one sender's reaction standing on a turn. */
export interface TurnReaction {
  kind: ReactionKind;
  from: 'me' | 'them';
  /** Who reacted, for a reaction from someone else when the source knows. */
  handle?: Handle;
}

/**
 * v2 F4: the delivery ladder, claimed only as far as the source proves it.
 * There is no `sending`: in flight and stuck look the same from chat.db.
 */
export type TurnDelivery =
  | { state: 'sent'; at: null }
  | { state: 'delivered'; at: IsoUtc | null }
  | { state: 'read'; at: IsoUtc }
  | { state: 'failed'; at: null; errorCode: number };

/** v2 F4: one attachment's metadata. A name is a basename, never a path. */
export interface TurnFile {
  /**
   * v2 F6: chat.db's attachment.guid, the id the bytes route takes. Never a
   * path; null only when the source row has no guid.
   */
  id: string | null;
  name: string | null;
  mime: string | null;
  uti: string | null;
  /** Null when the source records no size (chat.db's 0). */
  bytes: number | null;
  sticker: boolean;
  hidden: boolean;
}

/** v2 F4: the most file entries one turn carries; the count stays true. */
export const FILES_PER_TURN_MAX = 20;

/** One page of a transcript, oldest turn first so it reads top to bottom. */
export interface TurnsPage {
  turns: TranscriptTurn[];
  /** The cursor for the page of older turns; null when this one is the start. */
  nextBefore: string | null;
}

/** A source of conversations for one channel. */
export interface ChannelSource {
  readonly channel: ChannelName;
  listChats(q: ChatsQuery): Promise<ChatsPage>;
  /** v2 A2: one page of one conversation. Unknown chats reject with {@link UnknownChatError}. */
  readChatPage(q: TurnsQuery): Promise<TurnsPage>;
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

/** v2 A2: a chat this source has never heard of. The route answers 404. */
export class UnknownChatError extends Error {
  constructor(message = 'unknown chat') {
    super(message);
    this.name = 'UnknownChatError';
  }
}

export * from './state.js';

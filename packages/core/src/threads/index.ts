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

import type { ChatGuid, Handle, IsoUtc, MessageGuid } from '../domain/types.js';

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
}

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

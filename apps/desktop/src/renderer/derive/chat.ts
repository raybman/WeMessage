/**
 * What a chat guid says about who is on the other end.
 *
 * A local NARROWING of `parseChatGuid` from `@wemessage/client`, and the
 * duplication is forced rather than chosen: that package imports `ws` and
 * `node:fs` and authenticates a socket with a header a sandboxed renderer
 * cannot set, so it lives in the MAIN process (F-101) and importing it here
 * would drag a Node-only module into a Chromium bundle. `test/unit/derive.
 * spec.ts` imports BOTH and pins them to each other on a table of guids,
 * which is the only place in the app allowed to hold the two side by side.
 *
 * One deliberate difference: the client THROWS for a guid it cannot name a
 * service for, and this answers `'unknown'`. The client's caller is choosing
 * an icon and is better served by a failure; this one is painting a card
 * that has already been drafted against, and an exception mid-render blanks
 * a window over a string the daemon accepted.
 */

export interface ChatParts {
  /** The counterparty, or `''` for a room — a group has no single one. */
  readonly handle: string;
  readonly service: 'imessage' | 'sms' | 'unknown';
  readonly isGroup: boolean;
}

const ONE_ON_ONE = ';-;';

export function chatParts(chatGuid: string): ChatParts {
  const prefix = chatGuid.split(';')[0]?.toLowerCase();
  const service =
    prefix === 'imessage' || prefix === 'sms' ? prefix : 'unknown';
  const idx = chatGuid.indexOf(ONE_ON_ONE);
  // No 1:1 separator means a room, which has no counterparty to name.
  if (idx === -1) return { handle: '', service, isGroup: true };
  // `slice`, not `split`: the FIRST separator ends the prefix and everything
  // after it is the handle verbatim, because a handle may contain anything.
  return {
    handle: chatGuid.slice(idx + ONE_ON_ONE.length),
    service,
    isGroup: false,
  };
}

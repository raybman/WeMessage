/**
 * v2 A2: the messenger's keymap once a conversation can be opened, as pure
 * functions.
 *
 * Focus never leaves the conversations listbox. It is the window's one tab
 * stop in this mode, and the transcript is a `role="log"` with no tab stop
 * of its own, so every stroke arrives at the list and is interpreted HERE
 * according to what the messenger is doing:
 *
 *  - **list**: the A1 navigation verbs, plus Return, which opens the
 *    conversation under the cursor. Escape is still unbound: there is
 *    nothing to go back to.
 *  - **open**: the strokes read the transcript the way a pager does
 *    (`less`, `man`): `j`/`k` and the arrows a line, PageUp/PageDown a
 *    screen, `g`/Home the top and `G`/End the bottom. PageUp at the top is
 *    what reaches for the older page; that decision needs the scroll
 *    position, so it is the composition root's. Escape closes the
 *    transcript and hands the strokes back to the list; ⌘J starts a date
 *    jump.
 *  - **jumping**: the prompt takes digits, Backspace takes one back, Return
 *    commits and Escape cancels. Every other stroke is refused, so a stray
 *    `j` mid-date neither moves anything nor lands in the date.
 *
 * ⌘J is read from `event.code`, like the screen chords, so it is the same
 * physical key on every layout, and it is ⌘ alone: ⌃, ⌥ and ⇧ held with it
 * is a different chord whose meaning on this platform this file cannot see.
 *
 * Pure: no subscription, no DOM, no clock.
 */
import { threadsVerbOf, type ThreadsVerb } from './threads.js';

/** What the messenger is doing, which is what decides what a stroke means. */
export type MessengerMode = 'list' | 'open' | 'jumping';

/** The transcript's reading verbs. */
export type ReadVerb =
  'line-down' | 'line-up' | 'page-down' | 'page-up' | 'top' | 'bottom';

export type MessengerVerb =
  | { readonly kind: 'move'; readonly verb: ThreadsVerb }
  | { readonly kind: 'open' }
  | { readonly kind: 'read'; readonly verb: ReadVerb }
  | { readonly kind: 'close' }
  | { readonly kind: 'jump-start' }
  | { readonly kind: 'jump-digit'; readonly digit: string }
  | { readonly kind: 'jump-erase' }
  | { readonly kind: 'jump-commit' }
  | { readonly kind: 'jump-cancel' };

/** The fields of a `KeyboardEvent` this keymap is allowed to see. */
export interface MessengerStroke {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const READ: Readonly<Record<ThreadsVerb, ReadVerb>> = {
  next: 'line-down',
  previous: 'line-up',
  'page-down': 'page-down',
  'page-up': 'page-up',
  first: 'top',
  last: 'bottom',
};

function plain(stroke: MessengerStroke): boolean {
  return !stroke.metaKey && !stroke.ctrlKey && !stroke.altKey;
}

/** Whether this stroke is ⌘J and nothing else held. */
export function isJumpChord(stroke: MessengerStroke): boolean {
  return (
    stroke.code === 'KeyJ' &&
    stroke.metaKey &&
    !stroke.ctrlKey &&
    !stroke.altKey &&
    !stroke.shiftKey
  );
}

/** The verb for a stroke on the focused list in `mode`, or `null`. */
export function messengerVerbOf(
  stroke: MessengerStroke,
  mode: MessengerMode,
): MessengerVerb | null {
  if (mode === 'jumping') {
    if (!plain(stroke)) return null;
    if (/^[0-9]$/.test(stroke.key))
      return { kind: 'jump-digit', digit: stroke.key };
    if (stroke.key === 'Backspace') return { kind: 'jump-erase' };
    if (stroke.key === 'Enter') return { kind: 'jump-commit' };
    if (stroke.key === 'Escape') return { kind: 'jump-cancel' };
    return null;
  }
  if (mode === 'open') {
    if (isJumpChord(stroke)) return { kind: 'jump-start' };
    if (!plain(stroke)) return null;
    if (stroke.key === 'Escape') return { kind: 'close' };
    const verb = threadsVerbOf(stroke);
    return verb === null ? null : { kind: 'read', verb: READ[verb] };
  }
  if (plain(stroke) && stroke.key === 'Enter' && !stroke.shiftKey)
    return { kind: 'open' };
  const verb = threadsVerbOf(stroke);
  return verb === null ? null : { kind: 'move', verb };
}

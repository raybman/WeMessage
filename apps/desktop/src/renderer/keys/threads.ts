/**
 * v2 A1: the conversations list's keymap, as pure functions.
 *
 * Two decisions live here and nowhere else.
 *
 *  - **The chord that opens the list.** ⇧⌘R, read from `event.code` like
 *    the screen table beside this file, so it is the same physical key on
 *    Dvorak, AZERTY and Colemak. ⌘ and ⇧ both held, ⌃ and ⌥ both NOT: a
 *    chord that also matched ⌃⇧⌘R would be claiming a stroke whose meaning
 *    on this platform it cannot see.
 *  - **What a keystroke does once the list has focus.** Navigation, and
 *    only navigation. The same strokes the queue taught (`j`/`k`, the
 *    arrows, `g`/`G`, Home/End, PageUp/PageDown), so an operator does not
 *    learn two vocabularies for one gesture, and the same arithmetic
 *    (`moveTo`, a page of `PAGE`), so the two lists cannot drift apart on
 *    what "a page" means.
 *
 * What is NOT claimed matters as much, because a claimed key is a key the
 * list calls `preventDefault` on. Enter and Escape are left alone in A1:
 * opening a conversation is a later slice, and a key that half-did it would
 * be worse than a key that does nothing. Space is left alone because the
 * queue's Space expands a card, and a conversation row has nothing to
 * expand. Every stroke carrying ⌘, ⌃ or ⌥ is refused, so the list can
 * never eat a menu, window or system shortcut on its way to deciding it did
 * not want it.
 *
 * Pure: no subscription, no DOM, no clock. The composition root owns the
 * app's one key listener and hands strokes here.
 */
import { moveTo, type KeyStroke } from './index.js';

/** The verbs the conversations list understands. Closed, and navigation only. */
export type ThreadsVerb =
  'next' | 'previous' | 'first' | 'last' | 'page-down' | 'page-up';

/** The fields of a `KeyboardEvent` the chord test is allowed to see. */
export interface ChordStroke {
  readonly code: string;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/** Whether this stroke is ⇧⌘R, the chord that opens the conversations list. */
export function isThreadsChord(stroke: ChordStroke): boolean {
  return (
    stroke.code === 'KeyR' &&
    stroke.metaKey &&
    stroke.shiftKey &&
    !stroke.ctrlKey &&
    !stroke.altKey
  );
}

/**
 * The verb for a keystroke on the focused list, or `null` when the list
 * does not want it.
 *
 * `shiftKey` is not a disqualifier, for the queue's reason: `G` is shift-`g`
 * on every layout, and refusing shift would make the last-row key
 * unreachable.
 */
export function threadsVerbOf(stroke: KeyStroke): ThreadsVerb | null {
  if (stroke.metaKey || stroke.ctrlKey || stroke.altKey) return null;
  switch (stroke.key) {
    case 'j':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'ArrowUp':
      return 'previous';
    case 'g':
    case 'Home':
      return 'first';
    case 'G':
    case 'End':
      return 'last';
    case 'PageDown':
      return 'page-down';
    case 'PageUp':
      return 'page-up';
    default:
      return null;
  }
}

/**
 * Where a verb lands among the rows HELD, clamped, `-1` when none are.
 *
 * Held, not total. "Last" is the last row this window has been handed; the
 * composition root asks for the next page when the cursor arrives there, so
 * End pressed twice walks the list a page at a time instead of jumping to a
 * row nobody has fetched.
 */
export function threadsMoveTo(
  verb: ThreadsVerb,
  index: number,
  held: number,
): number {
  return moveTo(verb, index, held);
}

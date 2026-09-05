/**
 * The queue's keymap, as a pure function.
 *
 * Scenario 8 is a checkpoint that has to triage twenty drafts in under a
 * minute by keyboard alone. That budget is three seconds a draft including
 * reading it, which rules out anything with a modifier and anything that
 * needs the hand to leave the home row. So the verbs are single unmodified
 * letters with `vi` muscle memory (`j`/`k` to move, `a` to approve, SPACE to
 * look closer), with the arrow keys and Home/End as the discoverable
 * synonyms an operator who has never seen `vi` will try first.
 *
 * A FUNCTION rather than a switch inside a handler, for two reasons. It is
 * unit-testable without a DOM, and it is the one place that decides a
 * keystroke is ours: anything with a modifier is refused here, so the app
 * can never eat ⌘Q, ⌘W or ⌃C on its way to deciding it did not want them.
 *
 * There is no typeahead. A "jump to the draft that starts with…" affordance
 * needs a buffer and a timer to clear it, and this app owns exactly one
 * timer, at the composition root. Twenty cards do not need one.
 */

/** The verbs the queue screen understands. Closed (C-6). */
export type QueueVerb =
  | 'next'
  | 'previous'
  | 'first'
  | 'last'
  | 'page-down'
  | 'page-up'
  | 'approve'
  | 'expand';

/**
 * How far a page moves.
 *
 * A CONSTANT rather than the height of the rendered window, and the
 * difference is the whole reason this file has no DOM in it. A page that
 * meant "one viewport" would have to measure one, which would make the
 * keymap depend on layout, on the window size, and on whether a card
 * happened to be expanded — so PageDown would move a different distance on
 * every press and an operator could never build muscle memory for it. Ten is
 * half the twenty-draft seed: two presses cross the checkpoint's queue, and
 * the arithmetic is the same on every screen.
 */
export const PAGE = 10;

/** Only what a keymap needs, so a unit test need not build a KeyboardEvent. */
export interface KeyStroke {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The verb for a keystroke, or `null` if the queue does not want it.
 *
 * `shiftKey` is NOT a disqualifier: `G` is shift-`g` on every layout, and
 * refusing it would make the last-card key unreachable. The other three
 * modifiers are, because every one of them belongs to the system or to the
 * window and none of them belongs to a list.
 */
export function verbOf(stroke: KeyStroke): QueueVerb | null {
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
    // The full ARIA listbox contract, not just the arrows. A screen-reader
    // user who has been taught that a listbox pages is entitled to a listbox
    // that pages, and Sc17's axe run and VoiceOver snapshot are where a
    // partial implementation of the pattern gets found.
    case 'PageDown':
      return 'page-down';
    case 'PageUp':
      return 'page-up';
    case 'a':
      return 'approve';
    // Playwright presses `Space`; a browser delivers `' '`. Both spellings
    // are here because the suite drives this app the way a person does and
    // the difference is a detail of the driver, not of the product.
    case ' ':
    case 'Space':
      return 'expand';
    default:
      return null;
  }
}

/**
 * Where a navigation verb lands, given where we are and how many there are.
 *
 * Pure arithmetic, CLAMPED rather than wrapping. A queue that wrapped from
 * the last card to the first would make `j`-held-down a loop an operator
 * cannot feel the end of, and the twenty-in-a-minute script depends on
 * "pressing `j` past the end does nothing" being true — a wrap would silently
 * re-triage cards that were already dealt with.
 *
 * `-1` for an empty list, which is the one honest answer: there is no index
 * to be at, and returning 0 would name a card that does not exist.
 */
export function moveTo(verb: QueueVerb, index: number, length: number): number {
  if (length === 0) return -1;
  const clamp = (n: number): number => Math.max(0, Math.min(length - 1, n));
  switch (verb) {
    case 'next':
      return clamp(index + 1);
    case 'previous':
      return clamp(index - 1);
    case 'first':
      return 0;
    case 'last':
      return length - 1;
    case 'page-down':
      return clamp(index + PAGE);
    case 'page-up':
      return clamp(index - PAGE);
    // `approve` and `expand` are not navigation and leave the cursor where
    // it is. Listed rather than defaulted so that a verb added to the union
    // in Sc8 fails to compile here until somebody decides whether it moves.
    case 'approve':
    case 'expand':
      return clamp(index);
  }
}

/**
 * The legend, rendered on the ACTIVE card and nowhere else.
 *
 * On the card rather than in a footer because the twenty-in-a-minute story
 * is a person reading one card at a time: a legend two hundred pixels away
 * from the thing it acts on is a legend that gets read once and then
 * mis-remembered. `group` is a caveat rather than a different key — v1
 * cannot send to a room, and the honest place to say so is next to the key
 * that would try.
 */
export function legendFor(options: { readonly group: boolean }): string {
  const approve = options.group ? 'A approve (drafts only in v1)' : 'A approve';
  return `${approve} · SPACE context · J/K move`;
}

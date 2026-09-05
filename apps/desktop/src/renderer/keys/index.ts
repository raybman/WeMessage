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
  | 'expand'
  | 'reject'
  | 'edit'
  | 'undo'
  | 'approve-edited'
  | 'cancel-edit'
  /**
   * s8 Scenario 9. Four verbs for one idea: a selection, and the two things
   * that can be done with one. `select` toggles the card under the cursor;
   * `clear-selection` drops the lot; `bulk-approve` and `bulk-reject` spend
   * it in a single request.
   *
   * Kept in the SAME union rather than given their own, because the screen
   * dispatches on one verb and a second union would mean a second dispatch
   * and a second place for a stroke to fall through unhandled.
   */
  | 'select'
  | 'clear-selection'
  | 'bulk-approve'
  | 'bulk-reject';

/**
 * Which keyboard the operator is at.
 *
 * Not a flag on the stroke: the SAME physical key means different things in
 * these three worlds, and the only way a keymap can be a pure function of
 * its inputs is to be told which world it is in.
 *
 *  - `list`     the queue has focus. Single unmodified letters.
 *  - `editing`  the editor has focus. Two strokes are ours; every other key
 *               is a character somebody is typing, including `a`.
 *  - `offline`  the stream is not connected. Reading is always safe, so
 *               navigation and context still work; every verb that would
 *               WRITE is refused here rather than at the call site, so that
 *               the operator's key does nothing instead of drawing a
 *               hypothesis the store is about to roll back (Sc7).
 */
export type KeyMode = 'list' | 'editing' | 'offline';

/**
 * Everything the keymap is allowed to know beyond the stroke itself.
 *
 * An OBJECT rather than a bare `KeyMode`, deliberately: Scenario 9's `⇧A`
 * needs to know whether anything is selected, and a field added here is one
 * shape to widen, where a second positional argument would change every call
 * site and every row that tests them. (Scenario 8 predicted this would
 * change "no call site". It changed both of them, because the field is
 * REQUIRED — see below — and that is the honest correction.)
 *
 * `selected` is a COUNT, not the set. The only question the keymap asks of a
 * selection is whether there is one, and a count answers it without handing
 * a pure function a collection it could be tempted to read an id out of and
 * start making decisions about particular cards.
 *
 * Required rather than optional, and this is the load-bearing choice. An
 * optional `selected` would make `⇧A` mean `null` at every call site that
 * forgot to pass it, which is the failure that looks like nothing happening
 * and gets diagnosed as a broken key. Required means the composition root
 * cannot build a context without answering the question.
 */
export interface KeyContext {
  readonly mode: KeyMode;
  readonly selected: number;
}

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

/** The navigation verbs, which are exactly what `offline` still allows. */
function navigationOf(key: string): QueueVerb | null {
  switch (key) {
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
 * The two strokes the EDITOR does not get to keep.
 *
 * Both are modified, and that is the whole design. A bare Return has to
 * insert a newline, because the thing being edited is a message body and a
 * message body has paragraphs in it; so the commit is ⌘↩, with ⌃↩ as the
 * same stroke for a keyboard that has no Command key. Escape is the one
 * unmodified exception, because Escape means "out of here" everywhere on
 * this platform and an editor that swallowed it would be a trap.
 */
function editingOf(stroke: KeyStroke): QueueVerb | null {
  if (stroke.key === 'Escape' && !stroke.metaKey && !stroke.ctrlKey)
    return 'cancel-edit';
  if (stroke.key === 'Enter' && (stroke.metaKey || stroke.ctrlKey))
    return 'approve-edited';
  return null;
}

/**
 * The verb for a keystroke in a context, or `null` if the queue does not
 * want it.
 *
 * `null` is the load-bearing half. A key this function claims is a key the
 * screen calls `preventDefault` on, so every wrong `yes` here is a keystroke
 * the operator's browser, menu bar or textarea never sees.
 *
 * The kill switch is the deliberate deviation from the plan, and it is a
 * `null` in all three contexts. ⌘⇧K has to work when this window is not
 * focused and when the queue is not even on screen, which makes it a
 * `globalShortcut` in the MAIN process (Sc16). Claiming it here would bind
 * it twice and make it work once — in exactly the case where the operator
 * needed it least — while `preventDefault`ing the one keystroke whose entire
 * value is that it always works.
 *
 * `shiftKey` is NOT a disqualifier in `list`: `G` is shift-`g` on every
 * layout, and refusing it would make the last-card key unreachable. The
 * other three modifiers are, because every one of them belongs to the
 * system or to the window and none of them belongs to a list.
 */
export function verbOf(
  stroke: KeyStroke,
  context: KeyContext,
): QueueVerb | null {
  // Editing first, and BEFORE the selection is consulted: a person typing a
  // sentence has the whole alphabet, and Escape means "out of this box"
  // whether or not twelve cards are standing selected behind it.
  if (context.mode === 'editing') return editingOf(stroke);
  if (stroke.metaKey || stroke.ctrlKey || stroke.altKey) return null;
  // Offline is untouched by Sc9. Selecting writes nothing by itself, but the
  // only two things a selection is FOR are two verbs the store refuses while
  // the link is down, and a twelve-card selection built offline is a
  // selection the reconnect's refetch throws away without being asked.
  if (context.mode === 'offline') return navigationOf(stroke.key);
  switch (stroke.key) {
    case 'a':
      return 'approve';
    case 'r':
      return 'reject';
    case 'e':
      return 'edit';
    // Unshifted, next to the two shifted keys that spend it, and on the home
    // row's reach. `X` is a different key and stays unbound.
    case 'x':
      return 'select';
    // The two verbs a selection buys. `null` with an empty selection is the
    // point: a shifted key that silently degraded into its unshifted twin is
    // how an operator whose selection was cleared by a refetch approves ONE
    // draft while believing they approved twelve.
    case 'A':
      return context.selected > 0 ? 'bulk-approve' : null;
    case 'R':
      return context.selected > 0 ? 'bulk-reject' : null;
    // Claimed only when there is something to clear. With an empty selection
    // Escape keeps whatever the platform gives it, rather than being eaten
    // by a screen that had nothing to do with it.
    case 'Escape':
      return context.selected > 0 ? 'clear-selection' : null;
    // `z` and not ⌘Z. The system undo is a text-editing verb that belongs to
    // whatever has focus, and this one recalls a message from a send window:
    // binding it to the platform's undo would make ⌘Z mean two different
    // irreversible things depending on where the caret happened to be.
    case 'z':
      return 'undo';
    default:
      // `G` reaches here, and reaching here is what keeps it working. `A`,
      // `R` and `G` are all shifted letters, so a keymap that had claimed
      // the bulk verbs by testing `shiftKey` would have claimed the
      // last-card key along with them.
      return navigationOf(stroke.key);
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
    // None of these is navigation, and none of them moves the cursor BY
    // ITSELF. Listed rather than defaulted so that a verb added to the union
    // fails to compile here until somebody decides whether it moves.
    //
    // The screen advances the cursor after an action lands, which is a
    // different decision made in a different place for a reason: `moveTo` is
    // arithmetic over a list, and "where should the operator be looking now"
    // depends on what the daemon just said. Conflating the two would move
    // the cursor on a keystroke the store went on to refuse.
    case 'approve':
    case 'expand':
    case 'reject':
    case 'edit':
    case 'undo':
    case 'approve-edited':
    case 'cancel-edit':
    // Sc9's four, and the answer for all four is the same. Marking a card
    // does not leave it — an operator picking three cards out of twenty is
    // reading each one, and a cursor that jumped after `x` would make the
    // second `x` land somewhere they were not looking. A batch has no single
    // card to advance TO afterwards, and the cursor staying put is also what
    // makes `z` mean something immediately after `⇧A` (Sc9 row 2).
    case 'select':
    case 'clear-selection':
    case 'bulk-approve':
    case 'bulk-reject':
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
 *
 * `retry` is Scenario 9's, and it REPLACES the approve legend rather than
 * appending to it. A card whose send failed cannot be approved again — the
 * store's `STARTABLE.approve` is `{pending}` and a failed card is not
 * pending — so a legend that offered both would be offering one key two
 * meanings and one of them a lie. The plan asked for an "A retry" button
 * here; there are no buttons under `screens/queue` (an arch row bans them,
 * and its planted offender is that exact button), so the retry affordance
 * takes the shape every other verb on this screen has: a key, legended on
 * the card it acts on.
 */
export function legendFor(options: {
  readonly group: boolean;
  readonly retry: boolean;
}): string {
  const first = options.retry
    ? 'A retry'
    : options.group
      ? 'A approve (drafts only in v1)'
      : 'A approve';
  return `${first} · R reject · E edit · SPACE context · J/K move · X select`;
}

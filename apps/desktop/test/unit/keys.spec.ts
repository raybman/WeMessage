/**
 * s8-execution Scenario 8 row 1 — the triage keymap, without a DOM.
 *
 * The checkpoint's claim is that a person can clear twenty drafts in under a
 * minute using only the keyboard. Everything about whether that is possible
 * is decided in this one pure function, so it is checked here first: no
 * Electron, no daemon, no paint. `verbOf` takes a keystroke and a CONTEXT
 * and returns a verb or `null`, and `null` is the interesting half — a key
 * the queue refuses is a key that reaches the browser, the menu bar, or the
 * textarea the operator is typing into.
 *
 * The context is an OBJECT with one field rather than a bare mode string,
 * deliberately: Scenario 9 adds a selection to it, and an object grows a
 * field where a positional argument would change every call site and every
 * row below.
 *
 * Three modes, and the boundaries between them are the whole design:
 *
 *   `list`     the queue has focus. Single unmodified letters, `vi` muscle
 *              memory, no modifier is ours.
 *   `editing`  the editor has focus. Exactly TWO strokes are ours (⌘↩ and
 *              Escape) and every other key belongs to the textarea, because
 *              a queue that ate `a` while somebody was typing a word with an
 *              `a` in it would be unusable.
 *   `offline`  the stream is not connected. Navigation and context still
 *              work — reading is always safe — and every verb that would
 *              write is refused HERE, at the keymap, so the refusal is one
 *              decision in one place rather than a check at each call site.
 */
import { describe, expect, it } from 'vitest';
import {
  legendFor,
  moveTo,
  PAGE,
  verbOf,
  type KeyContext,
  type KeyMode,
  type KeyStroke,
  type QueueVerb,
} from '../../src/renderer/keys/index.js';

/** A keystroke with no modifiers held. */
function stroke(key: string, mods: Partial<KeyStroke> = {}): KeyStroke {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

/**
 * The three worlds, with NOTHING selected.
 *
 * `selected` is a COUNT and not a set, and it is required rather than
 * optional. The keymap's whole question about a selection is "is there one",
 * and a count answers it without handing a pure function a mutable
 * collection it could be tempted to read an id out of. Required because the
 * alternative — `selected?: number` defaulted to zero — is a screen that
 * forgets to pass it and gets `⇧A does nothing`, silently, for ever: the
 * failure would look exactly like an empty selection, which is the one case
 * that is supposed to do nothing.
 */
const LIST: KeyContext = { mode: 'list', selected: 0 };
const EDITING: KeyContext = { mode: 'editing', selected: 0 };
const OFFLINE: KeyContext = { mode: 'offline', selected: 0 };

/** The same three worlds with a selection standing. */
const LIST_SELECTED: KeyContext = { mode: 'list', selected: 3 };
const EDITING_SELECTED: KeyContext = { mode: 'editing', selected: 3 };
const OFFLINE_SELECTED: KeyContext = { mode: 'offline', selected: 3 };

const MODES: readonly KeyMode[] = ['list', 'editing', 'offline'];

/** Every navigation verb, which is exactly the set `offline` still allows. */
const NAVIGATION: readonly QueueVerb[] = [
  'next',
  'previous',
  'first',
  'last',
  'page-down',
  'page-up',
];

describe('s8 Sc8 — the triage keymap', () => {
  it('binds the five triage verbs to unmodified letters in the list', () => {
    // The home row plus `vi`. Three seconds a draft is the budget, and a
    // modifier is a hand leaving the keys, so none of these has one.
    expect(verbOf(stroke('a'), LIST)).toBe('approve');
    expect(verbOf(stroke('r'), LIST)).toBe('reject');
    expect(verbOf(stroke('e'), LIST)).toBe('edit');
    expect(verbOf(stroke('z'), LIST)).toBe('undo');
    expect(verbOf(stroke(' '), LIST)).toBe('expand');
  });

  it('keeps Sc6 and Sc7 navigation exactly as it was', () => {
    // Widening the keymap must not move a key an operator has already
    // learned. These are the Sc6 bindings, re-asserted through the new
    // two-argument signature.
    expect(verbOf(stroke('j'), LIST)).toBe('next');
    expect(verbOf(stroke('ArrowDown'), LIST)).toBe('next');
    expect(verbOf(stroke('k'), LIST)).toBe('previous');
    expect(verbOf(stroke('ArrowUp'), LIST)).toBe('previous');
    expect(verbOf(stroke('g'), LIST)).toBe('first');
    expect(verbOf(stroke('Home'), LIST)).toBe('first');
    expect(verbOf(stroke('G', { shiftKey: true }), LIST)).toBe('last');
    expect(verbOf(stroke('End'), LIST)).toBe('last');
    expect(verbOf(stroke('PageDown'), LIST)).toBe('page-down');
    expect(verbOf(stroke('PageUp'), LIST)).toBe('page-up');
    // Playwright's spelling of the space bar, which a browser delivers as ' '.
    expect(verbOf(stroke('Space'), LIST)).toBe('expand');
  });

  it('refuses every modified stroke in the list, including the shifted verbs', () => {
    // `shiftKey` alone is not a disqualifier (`G` is shift-`g`), but a
    // SHIFTED LETTER is a different `key`, so ⇧A arrives as 'A' and is
    // simply not bound. That is how the plan's "⇧A with an empty selection
    // returns null" holds here with no selection in the context at all:
    // Scenario 9 gives 'A' and 'R' a meaning, and until it does they are
    // unknown keys like any other.
    expect(verbOf(stroke('A', { shiftKey: true }), LIST)).toBeNull();
    expect(verbOf(stroke('R', { shiftKey: true }), LIST)).toBeNull();
    for (const mods of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }])
      for (const key of ['a', 'r', 'e', 'z', 'j', 'k', ' '])
        expect(verbOf(stroke(key, mods), LIST)).toBeNull();
  });

  it('refuses the kill switch in every context, because it is not the queue’s key', () => {
    // A DELIBERATE deviation from the plan's §1.7, recorded here rather
    // than in a commit message nobody reads back.
    //
    // ⌘⇧K must work when the window is not focused and when the queue is not
    // on screen, which is a `globalShortcut` in the MAIN process (Sc16). If
    // the keymap claimed it, the queue would `preventDefault` the one
    // keystroke whose entire value is that it always works, and it would do
    // so only in the case where the window already had focus — a kill switch
    // that is bound twice and works once. Refusing it here lets the stroke
    // fall through to the accelerator that actually owns it.
    for (const mode of MODES)
      expect(
        verbOf(stroke('K', { metaKey: true, shiftKey: true }), {
          mode,
          selected: 0,
        }),
      ).toBeNull();
  });

  it('gives the editor every key except the two that end the edit', () => {
    // Somebody is typing prose. `a` is a letter, not a verb.
    for (const key of ['a', 'r', 'e', 'z', 'j', 'k', ' ', 'G', 'Home', 'End'])
      expect(verbOf(stroke(key), EDITING)).toBeNull();
    // ⌘↩ commits. ⌃↩ is the same stroke for a keyboard without a Command
    // key, and both are MODIFIED on purpose: a bare Return has to insert a
    // newline, because the thing being edited is a message body.
    expect(verbOf(stroke('Enter', { metaKey: true }), EDITING)).toBe(
      'approve-edited',
    );
    expect(verbOf(stroke('Enter', { ctrlKey: true }), EDITING)).toBe(
      'approve-edited',
    );
    expect(verbOf(stroke('Enter'), EDITING)).toBeNull();
    expect(verbOf(stroke('Escape'), EDITING)).toBe('cancel-edit');
  });

  it('does not leak the editor’s verbs into the list, or the list’s into the editor', () => {
    // The two ends of the same rule. `Escape` in the list is not ours with
    // nothing selected — Sc9 gives it a selection to clear and nothing else,
    // so an empty selection leaves it to the window — and ⌘↩ in the list is
    // a modified stroke like any other.
    expect(verbOf(stroke('Escape'), LIST)).toBeNull();
    expect(verbOf(stroke('Enter', { metaKey: true }), LIST)).toBeNull();
    expect(verbOf(stroke('a'), EDITING)).toBeNull();
  });

  it('allows reading and refuses writing while the stream is down', () => {
    // Navigation and context, and nothing else. The refusal lives HERE so
    // that the optimistic store's own `offline` refusal (Sc7) is a second
    // line rather than the only one: a hypothesis that is written and then
    // rolled back is a card that flickers, and the operator's key should
    // simply do nothing instead.
    expect(verbOf(stroke('j'), OFFLINE)).toBe('next');
    expect(verbOf(stroke('k'), OFFLINE)).toBe('previous');
    expect(verbOf(stroke('G', { shiftKey: true }), OFFLINE)).toBe('last');
    expect(verbOf(stroke('PageDown'), OFFLINE)).toBe('page-down');
    expect(verbOf(stroke(' '), OFFLINE)).toBe('expand');
    for (const key of ['a', 'r', 'e', 'z'])
      expect(verbOf(stroke(key), OFFLINE)).toBeNull();
  });

  it('returns null for keys nobody bound, in every context', () => {
    for (const mode of MODES)
      for (const key of ['q', '1', 'F5', 'Tab', 'Backspace', 'Shift'])
        expect(verbOf(stroke(key), { mode, selected: 0 })).toBeNull();
  });

  it('leaves the cursor where it is for every verb that is not navigation', () => {
    // The exhaustive switch in `moveTo` is the compile-time half of this:
    // a verb added to the union has to be classified before this file
    // builds. The runtime half is that acting on a card does not move the
    // cursor by itself — the SCREEN advances it after the card leaves, and
    // conflating the two would skip a draft on every approve.
    for (const verb of [
      'approve',
      'reject',
      'edit',
      'undo',
      'expand',
      'approve-edited',
      'cancel-edit',
    ] as const)
      expect(moveTo(verb, 3, 20)).toBe(3);
    // Navigation still navigates, clamped, with `-1` for an empty list.
    expect(moveTo('next', 3, 20)).toBe(4);
    expect(moveTo('previous', 0, 20)).toBe(0);
    expect(moveTo('page-down', 3, 20)).toBe(3 + PAGE);
    for (const verb of NAVIGATION) expect(moveTo(verb, 0, 0)).toBe(-1);
  });

  it('legends the keys that exist, and keeps the group caveat on approve', () => {
    // Sc6 asserts the legend CONTAINS 'A approve'; this widens it without
    // moving that substring, which is the shape a growing legend has to have.
    const solo = legendFor({ group: false, retry: false });
    expect(solo).toContain('A approve');
    expect(solo).toContain('R reject');
    expect(solo).toContain('E edit');
    expect(solo).toContain('SPACE context');
    expect(solo).toContain('J/K move');
    expect(legendFor({ group: true, retry: false })).toContain(
      'A approve (drafts only in v1)',
    );
  });
});

/* ── s8 Sc9: the selection verbs ──────────────────────────────────────── */

/**
 * s8-execution Scenario 9 rows 1, 2 and 4 — one batch, at the keymap.
 *
 * Bulk is the sharpest edge in the whole slice: `⇧A` is one keystroke that
 * asks the daemon to approve N drafts, so every question about what it is
 * allowed to mean is decided here, in a pure function, before any of it
 * reaches a screen or a socket.
 *
 * The three decisions this file pins:
 *
 *  - **`⇧A` and `⇧R` mean NOTHING with an empty selection.** Not "act on the
 *    card under the cursor" — that is what `a` and `r` are for, and a
 *    shifted key that silently degrades into the unshifted one is how an
 *    operator whose selection was cleared by a refetch approves one draft
 *    while believing they approved twelve. `null` here means the browser
 *    gets the key back and the screen does not `preventDefault` it.
 *  - **Escape is context-dependent, and only in `list`.** With a selection
 *    it clears it; without one it is not ours at all, so it keeps whatever
 *    meaning the platform gives it. In `editing` it stays `cancel-edit`
 *    whether or not a selection is standing: a person mid-sentence pressing
 *    Escape means "out of this box", never "and also discard the twelve
 *    cards I picked".
 *  - **`offline` is unchanged.** Selection is a WRITE affordance in
 *    disguise: `x` on its own writes nothing, but the only two things a
 *    selection is for are two verbs the store would refuse, and a screen
 *    that let an operator build a twelve-card selection while the link was
 *    down would be a screen that quietly loses it on the reconnect that
 *    refetches the queue.
 */
describe('s8 Sc9 — the selection keymap', () => {
  it('binds x to select, and only in the list', () => {
    expect(verbOf(stroke('x'), LIST)).toBe('select');
    expect(verbOf(stroke('x'), LIST_SELECTED)).toBe('select');
    // A letter in the editor is a letter.
    expect(verbOf(stroke('x'), EDITING)).toBeNull();
    expect(verbOf(stroke('x'), EDITING_SELECTED)).toBeNull();
    // Offline allows reading, and selecting is the first half of writing.
    expect(verbOf(stroke('x'), OFFLINE)).toBeNull();
    expect(verbOf(stroke('x'), OFFLINE_SELECTED)).toBeNull();
    // `X` is a different key and is not bound: the selection verb is one
    // stroke, unshifted, next to the two shifted ones that spend it.
    expect(verbOf(stroke('X', { shiftKey: true }), LIST)).toBeNull();
  });

  it('gives ⇧A and ⇧R a meaning only while something is selected', () => {
    expect(verbOf(stroke('A', { shiftKey: true }), LIST)).toBeNull();
    expect(verbOf(stroke('R', { shiftKey: true }), LIST)).toBeNull();
    expect(verbOf(stroke('A', { shiftKey: true }), LIST_SELECTED)).toBe(
      'bulk-approve',
    );
    expect(verbOf(stroke('R', { shiftKey: true }), LIST_SELECTED)).toBe(
      'bulk-reject',
    );
    // The unshifted verbs are untouched by a standing selection. `a` still
    // approves the card under the cursor, which is what Sc8's checkpoint
    // measures and what an operator's muscle memory expects.
    expect(verbOf(stroke('a'), LIST_SELECTED)).toBe('approve');
    expect(verbOf(stroke('r'), LIST_SELECTED)).toBe('reject');
  });

  it('refuses the bulk verbs in every context that is not the list', () => {
    for (const context of [
      EDITING,
      EDITING_SELECTED,
      OFFLINE,
      OFFLINE_SELECTED,
    ]) {
      expect(verbOf(stroke('A', { shiftKey: true }), context)).toBeNull();
      expect(verbOf(stroke('R', { shiftKey: true }), context)).toBeNull();
    }
  });

  it('still refuses a modified ⇧A, because a modifier is never ours', () => {
    for (const mods of [
      { shiftKey: true, metaKey: true },
      { shiftKey: true, ctrlKey: true },
      { shiftKey: true, altKey: true },
    ])
      expect(verbOf(stroke('A', mods), LIST_SELECTED)).toBeNull();
  });

  it('clears the selection on Escape, and only when there is one', () => {
    expect(verbOf(stroke('Escape'), LIST_SELECTED)).toBe('clear-selection');
    // Nothing selected: Escape is not ours, so it keeps its platform
    // meaning rather than being claimed and thrown away.
    expect(verbOf(stroke('Escape'), LIST)).toBeNull();
    // The editor keeps Escape whatever else is standing.
    expect(verbOf(stroke('Escape'), EDITING)).toBe('cancel-edit');
    expect(verbOf(stroke('Escape'), EDITING_SELECTED)).toBe('cancel-edit');
    expect(verbOf(stroke('Escape'), OFFLINE_SELECTED)).toBeNull();
  });

  it('keeps G as the last-card key, which is also a shifted letter', () => {
    // The one that would break if `A` and `R` had been claimed by matching
    // on `shiftKey` instead of on the key itself.
    expect(verbOf(stroke('G', { shiftKey: true }), LIST_SELECTED)).toBe('last');
    expect(verbOf(stroke('G', { shiftKey: true }), OFFLINE_SELECTED)).toBe(
      'last',
    );
  });

  it('the kill switch is still nobody’s, selection or not', () => {
    for (const context of [LIST_SELECTED, EDITING_SELECTED, OFFLINE_SELECTED])
      expect(
        verbOf(stroke('K', { metaKey: true, shiftKey: true }), context),
      ).toBeNull();
  });

  it('none of the four new verbs moves the cursor by itself', () => {
    // The exhaustive switch in `moveTo` is what forces this decision to be
    // made rather than defaulted, and the answer for all four is the same:
    // selecting a card does not leave it, and a batch has no single card to
    // advance to afterwards.
    for (const verb of [
      'select',
      'clear-selection',
      'bulk-approve',
      'bulk-reject',
    ] as const)
      expect(moveTo(verb, 3, 20)).toBe(3);
    for (const verb of [
      'select',
      'clear-selection',
      'bulk-approve',
      'bulk-reject',
    ] as const)
      expect(moveTo(verb, 0, 0)).toBe(-1);
  });

  it('legends the select key, and swaps approve for retry on a failed card', () => {
    // Sc6's and Sc8's rows assert the legend CONTAINS its substrings, so it
    // can grow without moving them.
    const solo = legendFor({ group: false, retry: false });
    expect(solo).toContain('A approve');
    expect(solo).toContain('X select');
    expect(solo).toContain('J/K move');

    // The plan's row 3 asks for an "A retry" BUTTON. There are no buttons
    // under `screens/queue` — an arch row bans them, and its planted
    // offender is literally the button this plan asked for — so the retry
    // affordance is the same shape every other verb on this screen has: a
    // key, legended on the card it acts on. A failed card's `A` retries it.
    const failed = legendFor({ group: false, retry: true });
    expect(failed).toContain('A retry');
    expect(failed).not.toContain('A approve');
    expect(legendFor({ group: true, retry: false })).toContain(
      'A approve (drafts only in v1)',
    );
  });
});

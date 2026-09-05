/**
 * The one act the operator performed, above the N cards it moved.
 *
 * s8 Scenario 9. A summary, and only ever a summary: it is not an option, it
 * is not inside the listbox, and there is nothing on it an operator could
 * click. All three are structural rather than stylistic.
 *
 * NOT INSIDE THE LISTBOX. Every child of a `role="listbox"` has to be a
 * `role="option"`, and this is not one — a container whose children are not
 * all options is not a listbox whatever its role attribute says. It is also
 * not a place the cursor may land: `aria-activedescendant` names an option,
 * and a summary the cursor could reach would be a row `a` might act on.
 *
 * NOTHING TO CLICK. Sc7's arch row bans `<button`, `<a href`, `<input`,
 * `onClick=` and `tabIndex=` from everything under `screens/queue`, and its
 * planted offender is literally the RETRY NOW button this slice's plan asked
 * for. Scenario 9 is the scenario that would have added it. The affordance
 * it asked for exists — a failed card legends `A` as retry — in the shape
 * every other verb on this screen has: a key, on the card it acts on. That
 * keeps the window at one tab stop and keeps the approval path a keystroke
 * the screen above interprets.
 *
 * NOT COLOURED BY OUTCOME. The tallies are ink, including the failure. §3.10
 * makes colour the third carrier and never the first, and a card that
 * painted its success count one hue and its failure another would make this
 * the one place in the app where the colour IS the semantics. The glyph and
 * the uppercase word carry it; the runtime green sweep checks the rest.
 */
import type { VNode } from 'preact';
import type { BatchModel } from '../../derive/batch.js';

export function BatchCard(props: { readonly batch: BatchModel }): VNode {
  const { batch } = props;
  return (
    <div
      id="batch-card"
      data-action={batch.action}
      // Conditional, never `data-batch-id={undefined}`: under
      // exactOptionalPropertyTypes an absent key and an undefined one are
      // different types, and only one of them leaves the attribute off. The
      // absence is meaningful here — it is the window between the keystroke
      // and the daemon naming the batch, and an empty string would read as
      // a batch whose id is ''.
      {...(batch.batchId === null ? {} : { 'data-batch-id': batch.batchId })}
    >
      <p class="batch-head">{batch.headline}</p>
      {batch.tallies.length === 0 ? null : (
        <div class="batch-tallies">
          {batch.tallies.map((tally) => (
            <span key={tally.key} class="batch-tally">
              {tally.text}
            </span>
          ))}
        </div>
      )}
      <p class="batch-note">{batch.note}</p>
      {batch.footnote === null ? null : (
        <p class="batch-note">{batch.footnote}</p>
      )}
    </div>
  );
}

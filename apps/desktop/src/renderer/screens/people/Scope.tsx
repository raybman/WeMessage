/**
 * The ladder for ONE handle: §2.4.3, resolved and shown as a ladder.
 *
 * Sc10 made rule narrowing visible; this is the same idea one rung lower,
 * and it exists because the segmented control next to it is easy to
 * misread. Choosing AUTO for a person looks like granting them something.
 * It is not: `narrower(mode, ctx.contact.mode)` has no branch that raises,
 * so a contact row can only ever take autonomy AWAY from what the global
 * and the matching rule already allow. An operator who set AUTO here under
 * a `draft-only` global and saw no complaint would reasonably conclude the
 * machine was now answering by itself, and would be wrong.
 *
 * So the pane prints all three rungs, the value each carries, the resolved
 * answer, and the name of the rung that took the decision — and the note
 * says the direction in words, because the ordering alone does not carry
 * it.
 *
 * `RULE` is `PER RULE` rather than a value. §1.7 picks one rule per
 * message, first-match-wins, and that rule's own mode narrows further;
 * there is no single rule-scope number for a CONTACT, and inventing one
 * would be the third lie this screen is trying not to tell.
 *
 * Every string arrives as a prop. This file decides nothing.
 */
import type { VNode } from 'preact';

export interface ScopeRungView {
  readonly label: string;
  readonly value: string;
}

export interface PeopleScopeProps {
  /** The handle whose ladder this is. */
  readonly rowKey: string;
  readonly name: string;
  readonly rungs: readonly ScopeRungView[];
  /** What the three rungs resolve to, together. */
  readonly effective: string;
  /** The rungs strictly narrower than AUTO, joined; `''` when none are. */
  readonly narrowed: string;
  readonly sentence: string;
  readonly note: string;
}

export function PeopleScope(props: PeopleScopeProps): VNode {
  return (
    <aside id="people-scope" class="people-scope" data-key={props.rowKey}>
      <h2 class="people-scope-head">
        {props.name === '' ? props.rowKey : `${props.name} · ${props.rowKey}`}
      </h2>
      <ol class="people-rungs">
        {props.rungs.map((rung) => (
          <li
            key={rung.label}
            class="people-rung"
            data-rung={rung.label}
            data-value={rung.value}
          >
            <span class="people-rung-label">{rung.label}</span>
            <span class="people-rung-value">{rung.value}</span>
          </li>
        ))}
      </ol>
      <p
        id="people-scope-effective"
        class="people-effective"
        data-value={props.effective}
        data-narrowed={props.narrowed}
      >
        {/* The word, then who narrowed it. Never a colour on its own, and
            never the resolved value without the rung that chose it: "why"
            is the half an operator cannot reconstruct. */}
        <span class="people-effective-word">
          {props.effective.toUpperCase()}
        </span>
        <span class="people-effective-why">
          {props.narrowed === ''
            ? 'NO RUNG NARROWS THIS'
            : `NARROWED BY ${props.narrowed}`}
        </span>
      </p>
      <p id="people-scope-sentence" class="people-scope-sentence">
        {props.sentence}
      </p>
      <p id="people-scope-note" class="people-scope-note">
        {props.note}
      </p>
    </aside>
  );
}

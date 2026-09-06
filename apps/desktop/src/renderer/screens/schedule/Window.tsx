/**
 * One window, in the two places a window is visible: as a rectangle on the
 * grid, and as a sentence in the list beside it.
 *
 * Both are here because they have to agree. A block carries `data-window`,
 * which is the index of the window in the array the grid was drawn from, and
 * the list row carries the same index — so "the thing I dragged" and "the
 * thing I am about to delete" are provably the same thing rather than two
 * renderings that happen to line up.
 *
 * A window that crosses a midnight is ONE window and TWO rectangles. The
 * second is marked `data-tail`, both carry the same `data-window`, and both
 * carry the join glyph, because the alternative — two independent bars — is
 * an editor inviting an operator to drag half a window and leave the other
 * half behind.
 *
 * The remove button contributes NO text. `#sched-windows > li` is read as a
 * sentence by the e2e and by anyone using this screen through a reader, and
 * a glyph inside the row would end up in the middle of it; the label is on
 * `aria-label` and the mark is a CSS `::after`. That is the one case where
 * §3.10's "never colour alone" is satisfied by the accessible name rather
 * than by visible text.
 */
import type { VNode } from 'preact';
import type { NoteKind } from '../../derive/projectWindow.js';

export interface BlockView {
  /** Index of the window in the draft array. Shared by both halves. */
  readonly index: number;
  readonly from: number;
  readonly to: number;
  readonly wraps: boolean;
  readonly tail: boolean;
  readonly note: NoteKind;
  /** The seam sentence, or `''` on the other 363 days. */
  readonly title: string;
  /** `HH:MM–HH:MM`, drawn inside the rectangle when it is tall enough. */
  readonly label: string;
}

const DAY_MINUTES = 1440;

/** A share of the column, as a percentage, so the geometry is the CSS's. */
function span(from: number, to: number): { top: string; height: string } {
  return {
    top: `${String((from / DAY_MINUTES) * 100)}%`,
    height: `${String(((to - from) / DAY_MINUTES) * 100)}%`,
  };
}

export function WindowBlock(props: { block: BlockView }): VNode {
  const block = props.block;
  const box = span(block.from, block.to);
  return (
    <div
      class="sched-block"
      data-window={String(block.index)}
      data-from={String(block.from)}
      data-to={String(block.to)}
      data-wraps={block.wraps ? 'yes' : 'no'}
      data-tail={block.tail ? 'yes' : 'no'}
      data-note={block.note}
      // Omitted rather than empty on an ordinary day: a tooltip that is
      // present and says nothing is a tooltip that trains people not to read
      // the one that does.
      {...(block.title === '' ? {} : { title: block.title })}
      style={{ top: box.top, height: box.height }}
    >
      <span class="sched-block-label">{block.label}</span>
      {block.wraps ? (
        <span class="sched-join" aria-hidden="true">
          ∞
        </span>
      ) : null}
    </div>
  );
}

export interface WindowRowProps {
  readonly index: number;
  /** `MON 09:00–17:00`, plus the seam note when this week has one. */
  readonly text: string;
  /** The same thing, for the remove button's accessible name. */
  readonly label: string;
  readonly disabled: boolean;
  readonly onRemove: (index: number) => void;
}

export function WindowRow(props: WindowRowProps): VNode {
  return (
    <li class="sched-window" data-window={String(props.index)}>
      {props.text}
      <button
        id={`sched-window-${String(props.index)}-remove`}
        class="sched-x"
        type="button"
        aria-label={`REMOVE ${props.label}`}
        disabled={props.disabled}
        onClick={() => {
          props.onRemove(props.index);
        }}
      />
    </li>
  );
}

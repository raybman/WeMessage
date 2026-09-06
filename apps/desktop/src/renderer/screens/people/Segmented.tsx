/**
 * The policy control: three segments, and never a toggle.
 *
 * A switch would be the obvious control here, and it would be wrong twice.
 * §2.4.3 has THREE modes and a switch has two, so `draft-only` — the mode
 * this product ships in and the one most rows are actually in — would have
 * to be either the "off" position or invisible. And a switch carries its
 * state in a position rather than in a word, which on this screen is the
 * one thing that must not happen: the difference between DENY and
 * DRAFT-ONLY decides whether a message is answered by a person or not at
 * all, and it may not be legible only to somebody who can see where a knob
 * is sitting.
 *
 * So: three buttons, each with its WORD, each with `data-state` as ON or
 * OFF, and `aria-pressed` for the same fact in the accessibility tree.
 * Colour is decoration on top of three carriers, never the carrier itself.
 *
 * Order is DENY, DRAFT-ONLY, AUTO: narrowest first, so the gesture that
 * widens is the one furthest from the pointer's resting place. §2.4.3 reads
 * the same way, and a control whose order disagreed with the model it edits
 * would be one more thing to hold in mind.
 *
 * No state of its own. It reports a chosen mode and nothing else; whether
 * that becomes a request, and whether the request is asked about first, is
 * the composition root's decision.
 */
import type { VNode } from 'preact';
import type { ContactMode } from '@wemessage/client';

/** Narrowest first. The stored `deny` is a decision, not the absence of one. */
const SEGMENTS: readonly ContactMode[] = ['deny', 'draft-only', 'auto'];

export interface SegmentedProps {
  /** The row this control belongs to, on every button, for the harness. */
  readonly rowKey: string;
  /** The STORED mode, or `null` when this handle has no policy row. */
  readonly mode: ContactMode | null;
  readonly disabled: boolean;
  readonly onMode: (mode: ContactMode) => void;
}

export function Segmented(props: SegmentedProps): VNode {
  return (
    <span class="people-seg" role="group" aria-label="POLICY">
      {SEGMENTS.map((segment) => {
        const on = props.mode === segment;
        return (
          <button
            key={segment}
            type="button"
            class="people-seg-btn"
            // Both attributes on the BUTTON, not just on the row: the row
            // already carries `data-key`, and a selector that had to walk
            // from the row to a nameless child would be describing the
            // markup rather than the control.
            data-key={props.rowKey}
            data-mode-set={segment}
            data-state={on ? 'ON' : 'OFF'}
            aria-pressed={on}
            disabled={props.disabled}
            onClick={() => {
              props.onMode(segment);
            }}
          >
            {segment.toUpperCase()}
          </button>
        );
      })}
    </span>
  );
}

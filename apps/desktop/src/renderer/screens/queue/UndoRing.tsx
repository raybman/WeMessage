/**
 * The undo window, drawn without a clock.
 *
 * §1.7 described this as "a 250 ms display interval comparing the end
 * instant to `Date.now()`". That is a `setInterval`, and this app owns
 * exactly one timer, at the composition root, guarded by an arch row that
 * scans every file under `src/` as raw text. So the interval is not merely
 * inconvenient here, it is banned — and the ban is right: a ring is an
 * animation, and asking JavaScript to repaint one thirty times a second in
 * order to move a shape is how a queue that has to stay responsive under
 * forty-four keystrokes a minute starts dropping frames.
 *
 * What replaces it is CSS, given the two instants the daemon supplied. The
 * keyframes run from a full ring to an empty one over `animationDuration`,
 * and a NEGATIVE `animationDelay` fast-forwards it to wherever it already
 * is — so a ring that started four seconds before this paint resumes at four
 * seconds in, and a window that was reloaded mid-grace draws the same ring
 * the window that watched it start would. The browser owns the tick, the
 * compositor owns the frames, and this file owns no time at all.
 *
 * The number is deliberately NOT on screen. Without a timer it could only be
 * the value computed at the last paint, which changes when an unrelated key
 * is pressed and freezes when none is: a countdown that jumps from 8 to 3
 * because somebody moved the cursor is worse than no countdown. The sweep
 * carries the time visually and the option's `aria-label` carries it in
 * words, once, at the moment the ring appears (`ringOf`, `derive/queue.ts`).
 *
 * The last keyframe hides the ring, so it disappears exactly when the window
 * closes rather than sitting at zero forever waiting for a repaint that may
 * never come. Nothing else happens at zero: the card stays ● APPROVED until
 * the daemon says `draft.sent`, because that is when it is true.
 *
 * §3.10 — the ring is never the only carrier. The word and the key are next
 * to it in text, the state's own glyph and word are above it, and the option
 * carries `data-state`. An operator who sees no animation at all still reads
 * `↺ UNDO · Z`.
 */
import type { VNode } from 'preact';
import type { CardRing } from '../../derive/queue.js';

export interface UndoRingProps {
  readonly ring: CardRing;
}

export function UndoRing(props: UndoRingProps): VNode {
  const { ring } = props;
  return (
    <span
      class="card-ring"
      // The daemon's own arithmetic, exposed so the e2e and a support thread
      // read the same number the operator's ring was drawn from. Both are
      // immutable facts about this approval: neither changes between paints,
      // which is why the REMAINING seconds are not here.
      data-ring-total={String(ring.totalSeconds)}
      style={{
        animationDuration: `${String(ring.totalMs)}ms`,
        animationDelay: `-${String(ring.elapsedMs)}ms`,
      }}
    >
      ↺ UNDO · Z
    </span>
  );
}

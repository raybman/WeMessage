/**
 * The queue, while the app cannot hear the daemon.
 *
 * The rule this exists to enforce is one sentence: an operator must never
 * approve a card the app already knows it may be wrong about. While the link
 * is down every card on screen is a memory, so the screen says so three
 * times over — an overlay with the word, a listbox marked `aria-disabled`,
 * and cards dimmed below full opacity — because a reader who misses one of
 * those still catches the others.
 *
 * NOTHING IN HERE IS INTERACTIVE, and the plan drew two buttons.
 *
 * `RETRY NOW` and `RUN DOCTOR` are rendered as static lines carrying their
 * own status instead. Two reasons, and either alone would be enough. A
 * button is a tab stop, and the whole window has exactly one — Sc8's
 * checkpoint triages twenty drafts by keyboard alone and a stray focusable
 * node in a transient overlay is precisely the thing that makes a `Tab`
 * land somewhere the operator did not expect. And there is nothing for
 * `RETRY NOW` to call: main's reconnect is a backoff ladder that is already
 * running, the stream exposes `start()` and `close()` and no third verb, and
 * a button that re-ran an attempt already in flight would be a control whose
 * only real effect is to make the operator feel busy.
 *
 * So the honest surface is the ATTEMPT NUMBER, which is the retry made
 * visible, plus the age of what is on screen. `RUN DOCTOR` says why it is
 * unavailable rather than offering a probe that has to reach the daemon it
 * cannot reach.
 */
import type { VNode } from 'preact';
import { hhmm } from '../../derive/format.js';

export interface OverlayProps {
  /** Which reconnect attempt is in flight, from main's own ladder. */
  readonly attempt: number;
  /** The last instant a fetch actually answered, or absent if none has. */
  readonly syncedAt: string | undefined;
}

export function DisconnectedOverlay(props: OverlayProps): VNode {
  return (
    <div id="queue-overlay">
      {/* Glyph AND word, before any tint (§3.10). The overlay is the most
          colour-tempting surface in the app and it gets the same rule. */}
      <p id="queue-overlay-head">◌ DISCONNECTED</p>
      <p id="queue-overlay-detail">{`RETRYING · ATTEMPT ${String(props.attempt)}`}</p>
      {/* The refusal, in the same words as the refusal. An overlay that said
          "reconnecting…" and left the operator to discover that `A` does
          nothing would be teaching them that the key is unreliable. */}
      <p id="queue-overlay-refused">APPROVE IS REFUSED WHILE DISCONNECTED</p>
      <p id="queue-overlay-sync">
        {props.syncedAt === undefined
          ? 'NEVER SYNCED'
          : `LAST SYNC ${hhmm(props.syncedAt)}`}
      </p>
      <div id="queue-overlay-actions">
        <span class="queue-overlay-action">RETRY NOW · AUTOMATIC</span>
        <span class="queue-overlay-action">
          RUN DOCTOR · UNAVAILABLE WHILE DISCONNECTED
        </span>
      </div>
    </div>
  );
}

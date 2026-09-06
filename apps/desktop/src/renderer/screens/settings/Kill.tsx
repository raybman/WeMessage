/**
 * The kill switch, and the first thing on the settings screen.
 *
 * It is at the top because it is the control an operator reaches for when
 * they are not sure what is happening — which is exactly the moment they
 * should not have to scroll. Everything below it changes what the daemon
 * will do NEXT; this changes what it will do NOW.
 *
 * The copy is the load-bearing part. `evaluateGate` answers `kill-switch`
 * before it computes anything that clamps, which makes the switch a DENY and
 * not a narrowing: while it is on, a HUMAN pressing approve is refused by
 * the daemon with a 403, and so is everything automatic. A control captioned
 * "pause automatic replies" would be describing the second half of that and
 * lying about the first, so the note says APPROVAL and says REFUSED, and the
 * e2e asserts both words rather than asserting the markup around them.
 *
 * The other half of the honesty is the sentence about turning it OFF.
 * `routes/toggles.ts` says resume means new work may flow again, not replay
 * whatever was just halted; nothing here queues, and nothing here flushes.
 *
 * A LAYOUT and nothing else, like every file under `screens/`: the state,
 * the glyph, the word and the horizon all arrived as props.
 */
import type { VNode } from 'preact';

export interface KillPaneProps {
  /** `armed`, `killed`, or `unknown` when the daemon has not said. */
  readonly state: string;
  /** ● ⊘ ◌ — §1.7, state is carried by the glyph and never by the hue. */
  readonly glyph: string;
  /** `OUTBOUND: ARMED` / `OUTBOUND: KILLED`, uppercase. */
  readonly word: string;
  /** What the switch actually does, in words. */
  readonly note: string;
  /** Which way the button moves it: `on` or `off`. */
  readonly next: string;
  /** The button's own caption. */
  readonly action: string;
  /** The schedule at a glance, so the switch is not read in isolation. */
  readonly horizon: string;
  readonly horizonArmed: string;
  /** The screen-wide sentence, or `''` when there is nothing to say. */
  readonly banner: string;
  /**
   * What the system-wide chord does, in the state the OS actually left it in.
   *
   * On this pane and not somewhere in a preferences list, because the chord
   * lands HERE: an operator who presses it arrives looking at the kill switch
   * and reads, an inch below it, what the key they just pressed did. And when
   * the key did nothing — another application owns the combination, or the
   * platform has no such thing — that is said in the same place, in words,
   * rather than being swallowed into a boolean nobody sees.
   */
  readonly shortcut: string;
  readonly onToggle: () => void;
}

export function KillPane(props: KillPaneProps): VNode {
  return (
    <section id="set-kill" class="set-pane">
      {/* Only while it is on. A banner that is always in the document and
          merely blank is a banner an operator learns to stop reading. */}
      {props.banner === '' ? null : (
        <p id="kill-banner" class="kill-banner">
          {props.banner}
        </p>
      )}
      <h2 class="set-pane-title">OUTBOUND</h2>
      <p id="kill-state" class="kill-state" data-kill={props.state}>
        <span id="kill-glyph" class="kill-glyph">
          {props.glyph}
        </span>
        <span class="kill-word">{props.word}</span>
      </p>
      <p id="kill-horizon" class="kill-horizon" data-armed={props.horizonArmed}>
        {props.horizon}
      </p>
      {/* `aria-disabled` and never `disabled`, and not even that here: this
          control stays live in every posture the daemon can be in. A
          read-only daemon makes it MOOT, not wrong, and an app that refused
          to let somebody turn sending off because sending was already off
          would be arguing with the person holding the queue. */}
      <button
        id="kill-toggle"
        type="button"
        class="kill-toggle"
        data-next={props.next}
        aria-disabled="false"
        onClick={props.onToggle}
      >
        {props.action}
      </button>
      <p id="kill-note" class="set-note">
        {props.note}
      </p>
      {/* The chord, and the honest report of whether it exists. Always in
          the document: "the shortcut is dead" is a fact an operator needs
          BEFORE the moment they reach for it, and a line that only appeared
          on failure would be a line nobody had ever read. */}
      <p id="kill-shortcut" class="set-note">
        {props.shortcut}
      </p>
    </section>
  );
}

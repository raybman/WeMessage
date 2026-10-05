/**
 * v2 A1: the messenger's channel rail.
 *
 * Board 01 puts a rail down the left edge of the messenger: the scopes the
 * list can be read through, "All" first, then one entry per channel. A1
 * draws the two that exist today, All and iMessage, and draws them as WORDS
 * rather than controls. That is the plan's rule while the queue lives: the
 * rail ships keyboard-driven and non-tabbable, because the window's single
 * tab stop is the list beside it, and a rail of buttons would put two more
 * stops in front of every conversation.
 *
 * So nothing here is focusable and nothing here can be clicked. The current
 * scope is carried twice: `aria-current` for assistive technology and
 * `data-current` for the sheet, and the sheet draws it as a bar and a
 * border rather than a fill, the same carrier the lists use for their
 * cursor. Channels that are not connected are a later slice's job, and
 * they will be drawn absent and labelled as such rather than hidden.
 *
 * A view, under the same ban as `components/` and `screens/`: no bridge, no
 * clock, no subscription. The marks come from the derive layer so the rail
 * and every row it scopes spell a channel the same way.
 */
import type { VNode } from 'preact';
import { CHANNEL_MARK } from '../derive/threads.js';

interface RailEntry {
  /** The chip the rail draws: `ALL`, or the channel's own mark. */
  readonly mark: string;
  readonly name: string;
  readonly current: boolean;
}

/** All, then every channel the wire can name, in the board's order. */
const ENTRIES: readonly RailEntry[] = [
  { mark: 'ALL', name: 'All', current: true },
  { mark: CHANNEL_MARK.imessage, name: 'iMessage', current: false },
];

export function Rail(): VNode {
  return (
    <div id="threads-rail">
      <p class="threads-rail-title">Channels</p>
      <ul class="threads-rail-list">
        {ENTRIES.map((entry) => (
          <li
            key={entry.mark}
            class="threads-rail-entry"
            data-current={entry.current ? 'true' : 'false'}
            {...(entry.current ? { 'aria-current': 'true' } : {})}
          >
            <span class="threads-rail-mark">{entry.mark}</span>
            <span class="threads-rail-name">{entry.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The empty queue.
 *
 * An empty list is the state a queue spends most of a good day in, and the
 * blank rectangle it renders by default is the app's worst answer to its
 * most common question. "Nothing waiting" is only reassuring if the operator
 * also knows the machine is still watching — otherwise an empty screen and a
 * broken screen are the same picture.
 *
 * So three facts, in the order a person needs them: nothing is waiting, this
 * is (or is not) a window in which anything would go out, and here is what
 * is being watched. The third is the one that catches a real failure: a
 * queue that is empty AND has no rules watching will stay empty forever, and
 * nothing else on this screen would say so.
 *
 * IT RENDERS BESIDE THE LISTBOX, NEVER INSTEAD OF IT. The list stays mounted
 * with zero options, because it holds the window's only tab stop
 * (`tabIndex={0}` plus `aria-activedescendant`, Sc6). An empty state that
 * unmounted it would drop focus to `<body>` and the operator's next
 * keystroke would go nowhere — the same silent failure the activedescendant
 * decision exists to prevent, arriving through the back door. It also mints
 * no roles: an arch row pins `role="listbox"` and `role="option"` to one
 * file, and a second list here would be a second list to assistive
 * technology whatever it was called.
 *
 * s10 Slice 7 adds a fourth fact: the four keys a day is made of. The card
 * legend only renders on an active card, so before the first draft arrives
 * nothing else says how triage works. Each key is a `<kbd>`, which says
 * "this is a key" without minting a role, and the row is a plain block
 * like the rules row above it, not a list.
 */
import type { VNode } from 'preact';
import { EMPTY_KEYS } from '../../keys/index.js';

export interface EmptyProps {
  /** The schedule glance, already rendered by `derive/armingGlance`. */
  readonly arming: string;
  /** The enabled rules, by name. May be empty, and that is the point. */
  readonly watching: readonly string[];
}

export function Empty(props: EmptyProps): VNode {
  return (
    <div id="queue-empty">
      <p id="queue-empty-head">NO DRAFTS WAITING</p>
      <p id="queue-empty-arming">{props.arming}</p>
      <div id="queue-empty-rules">
        {props.watching.length === 0 ? (
          // Not a blank. A queue with nothing watching it is a queue that
          // cannot fill, and the operator is one screen away from fixing it.
          <span class="watched-none">NO RULES WATCHING · ADD ONE IN RULES</span>
        ) : (
          props.watching.map((name) => (
            <span key={name} class="watched-rule">
              {name.toUpperCase()}
            </span>
          ))
        )}
      </div>
      <div id="queue-empty-keys">
        <span class="empty-keys-lead">WHEN ONE ARRIVES</span>
        {EMPTY_KEYS.map((chip) => (
          <span key={chip.key} class="empty-key">
            <kbd>{chip.key.toUpperCase()}</kbd> {chip.label}
          </span>
        ))}
      </div>
    </div>
  );
}

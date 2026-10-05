/**
 * v2 A2: one conversation, drawn.
 *
 * The third column of the messenger. Turns arrive already grouped under one
 * heading per local day (`derive/transcript.ts`, run by the composition
 * root), so this file draws what it is handed and computes nothing: no
 * grouping, no clock, no zone. That is what keeps the headings in agreement
 * with the list's chip, which the same root dates from the same `asOf`.
 *
 * The pane is a `role="log"` and NOT a second listbox. Its turns are text
 * to be read, not options to be chosen, and it has no tab stop of its own:
 * focus stays on the conversations list, whose keydown reads this pane the
 * way a pager does. `aria-live="off"` because a log is polite by default
 * and the messenger already has its one polite region (the status line in
 * `Messenger.tsx`), which says "new message" once instead of reading the
 * whole turn over whatever the operator is in the middle of.
 *
 * Ours are drawn on the right (`data-from="me"`, laid out in `app.css`).
 * Who said each turn is always in the text, visibly in a group and for a
 * screen reader only in a 1:1, where the side already says it to the eye.
 *
 * Day headings stick with CSS alone. No scroll listener, no timer, no
 * observer: this app keeps those at the composition root, and a sticky
 * header needs none of them.
 *
 * A view, under the same ban as `components/` and `screens/`: no bridge, no
 * clock, no subscription.
 */
import type { VNode } from 'preact';
import type { DayGroup } from '../derive/transcript.js';

/** Where the open conversation is, as its binding reports it. */
export type TranscriptPaneStatus =
  'idle' | 'loading' | 'ready' | 'failed' | 'unavailable' | 'unknown-chat';

export interface TranscriptProps {
  readonly status: TranscriptPaneStatus;
  /** The conversation's title, as its row in the list said it at open. */
  readonly title: string;
  readonly groups: readonly DayGroup[];
  /** An older page is in flight. */
  readonly paging: boolean;
  /** There is nothing older than what is held. */
  readonly atStart: boolean;
  /** The date jumped to, in words, or `''` at the head. */
  readonly jumpedTo: string;
  /** The date prompt's mask while ⌘J is being typed, or `''`. */
  readonly prompt: string;
}

/** The DOM id of the pane, which the composition root scrolls. */
export const TRANSCRIPT_ID = 'transcript';

/** The words for a pane with nothing to draw, or `''` when it has turns. */
function noteFor(props: TranscriptProps, turns: number): string {
  switch (props.status) {
    case 'idle':
    case 'loading':
      return 'Opening the conversation…';
    case 'unavailable':
      return 'The Messages history cannot be read right now. Escape, then Return, asks again.';
    case 'unknown-chat':
      return 'This conversation is no longer in the Messages history.';
    case 'failed':
      return 'The conversation did not load. Escape, then Return, asks again.';
    case 'ready':
      if (turns > 0) return '';
      return props.jumpedTo === ''
        ? 'No messages in this conversation yet.'
        : `Nothing on or before ${props.jumpedTo}. End returns to the latest.`;
  }
}

export function Transcript(props: TranscriptProps): VNode {
  const turns = props.groups.reduce((n, g) => n + g.turns.length, 0);
  const note = noteFor(props, turns);
  return (
    <section
      id={TRANSCRIPT_ID}
      role="log"
      aria-live="off"
      aria-label={`Conversation with ${props.title}`}
      data-status={props.status}
      data-paging={props.paging ? 'yes' : 'no'}
    >
      <h2 id="transcript-title">{props.title}</h2>
      {props.prompt === '' ? null : (
        <p id="transcript-prompt">
          Jump to <span class="transcript-mask">{props.prompt}</span>
        </p>
      )}
      {props.status === 'ready' && props.atStart && turns > 0 ? (
        <p id="transcript-start">Beginning of conversation</p>
      ) : null}
      {props.paging ? (
        <p id="transcript-paging">Reading older messages…</p>
      ) : null}
      {props.groups.map((group, g) => (
        <div
          class="transcript-day"
          key={`${group.date}#${String(g)}`}
          data-date={group.date}
        >
          <h3 class="transcript-day-heading">{group.heading}</h3>
          <ol class="transcript-turns">
            {group.turns.map((turn) => (
              <li
                class="transcript-turn"
                key={turn.key}
                data-guid={turn.key}
                data-from={turn.from}
                data-placeholder={turn.placeholder ? 'yes' : 'no'}
              >
                <span
                  class="transcript-who"
                  data-shown={turn.showWho ? 'yes' : 'no'}
                >
                  {turn.who}
                </span>
                <p class="transcript-body">{turn.body}</p>
                <span class="transcript-meta">
                  {turn.time === '' ? null : (
                    <span class="transcript-time">{turn.time}</span>
                  )}
                  {turn.marks.map((mark) => (
                    <span class="transcript-mark" key={mark}>
                      {mark}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
      {note === '' ? null : <p id="transcript-note">{note}</p>}
    </section>
  );
}

/**
 * v2 A1 and A2: the messenger.
 *
 * Board 01's frame: a rail of scopes on the left, beside it a pane with a
 * header over the conversations list, and (A2) the open conversation in a
 * third column. It is a MODE laid over the queue,
 * not a seventh screen: ⇧⌘R opens it, any screen chord leaves it, and the
 * root's `data-screen` stays "queue" the whole time. The six v1 screens are
 * what later slices retire one at a time, and the registry that names them
 * does not grow on the way.
 *
 * Every fact arrives as a prop and the one action leaves as a callback, so
 * this tree can be read top to bottom without knowing there is a daemon.
 * The status words are decided here because they are presentation; WHICH
 * status the list is in is the binding's answer, passed through as-is.
 *
 * A view, under the same ban as `components/` and `screens/`: no bridge, no
 * clock, no subscription.
 */
import type { VNode } from 'preact';
import type { ThreadRow } from '../derive/threads.js';
import type { MessengerMode, MessengerVerb } from '../keys/transcript.js';
import { Header } from './Header.js';
import { ThreadList } from './List.js';
import { Rail } from './Rail.js';
import { Transcript, type TranscriptProps } from './Transcript.js';

/** Where the list is, as the binding reports it. */
export type MessengerStatus =
  'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';

export interface MessengerProps {
  readonly status: MessengerStatus;
  readonly rows: readonly ThreadRow[];
  readonly total: number;
  /** The dated count, built by the composition root from the page. */
  readonly chip: string;
  readonly activeIndex: number;
  /** A next page is in flight. */
  readonly paging: boolean;
  /** What a stroke on the list means right now (v2 A2). */
  readonly mode: MessengerMode;
  readonly onVerb: (verb: MessengerVerb) => void;
  /** The open conversation, or `null` while none is. */
  readonly transcript: TranscriptProps | null;
  /**
   * The messenger's one polite announcement, or `''`. Decided by the
   * composition root, which is the only thing that sees the edges worth
   * saying ("Opened…", "New message", "Jumping to…").
   */
  readonly announce: string;
}

/**
 * The words for a list with no page to show. `''` once there is one.
 *
 * `unavailable` and `failed` are said differently on purpose. The first is
 * the daemon's own answer (it is running, this window is allowed to ask,
 * and the Messages history cannot be read right now), the second is a
 * request that did not come back, and an operator deciding what to fix
 * needs to know which.
 */
function noteFor(status: MessengerStatus): string {
  switch (status) {
    case 'idle':
    case 'loading':
      return 'Reading conversations…';
    case 'unavailable':
      return 'The Messages history cannot be read right now. ⇧⌘R asks again.';
    case 'failed':
      return 'The conversation list did not load. ⇧⌘R asks again.';
    case 'ready':
      return '';
  }
}

export function Messenger(props: MessengerProps): VNode {
  const ready = props.status === 'ready';
  return (
    <div
      id="threads"
      data-status={props.status}
      data-paging={props.paging ? 'yes' : 'no'}
      data-mode={props.mode}
    >
      <Rail />
      <div id="threads-pane">
        <Header
          title="All Messages"
          lens="Recent"
          chip={ready ? props.chip : ''}
        />
        <ThreadList
          rows={props.rows}
          total={props.total}
          activeIndex={props.activeIndex}
          inert={!ready}
          note={noteFor(props.status)}
          empty={ready && props.rows.length === 0}
          mode={props.mode}
          onVerb={props.onVerb}
        />
      </div>
      {props.transcript === null ? (
        <div id="transcript-closed">
          <p>Return opens the conversation under the cursor.</p>
        </div>
      ) : (
        <Transcript {...props.transcript} />
      )}
      {/*
        The messenger's ONE live region, the queue's rule for the queue's
        reason: the two are never mounted together, so a window always has
        exactly one polite voice. Visually hidden; the pane already shows
        everything it says.
      */}
      <p id="messenger-status" role="status">
        {props.announce}
      </p>
    </div>
  );
}

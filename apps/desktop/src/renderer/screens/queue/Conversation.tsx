/**
 * The right pane: the thread this draft would land in, and the draft itself.
 *
 * Two decisions, both load-bearing for the twenty-in-a-minute checkpoint.
 *
 * VIRTUALIZED. The pane renders a WINDOW of the tail, never the whole
 * conversation, because the count is unbounded and `j` repaints this pane on
 * every keystroke: a pane that mounted five hundred rows would make one
 * keypress cost five hundred nodes, which is the checkpoint failing quietly
 * rather than loudly. The window is a SLICE and the count the operator is
 * told is the exact total, so a truncated render never becomes a smaller
 * number on screen.
 *
 * ALIGNED. The draft is pinned at the end and aligned against the turns —
 * theirs left, ours right — which is the one convention every messaging
 * client on this platform shares. It is also a non-colour carrier: which
 * side a bubble sits on says who wrote it without asking anybody to tell two
 * tints apart.
 *
 * Everything here is OBSERVED. `GET /v1/drafts/:id` carries no conversation
 * and S8 adds no route (F-107), so these turns are the `message.received`
 * frames this window watched arrive. A window opened a minute ago has a
 * minute of context and says so by having less of it.
 */
import type { VNode } from 'preact';
import type { Turn } from '../../store/optimistic.js';

export interface ConversationProps {
  readonly draftId: string;
  /** Everything observed in this thread, not the length of what is rendered. */
  readonly total: number;
  /** Already windowed by the caller. */
  readonly turns: readonly Turn[];
  readonly draftBody: string;
}

export function Conversation(props: ConversationProps): VNode {
  return (
    <section
      id="queue-pane"
      data-draft={props.draftId}
      data-turns={String(props.total)}
    >
      <div id="pane-window">
        {props.turns.map((turn) => (
          <p key={turn.guid} class="turn">
            {turn.text}
          </p>
        ))}
      </div>
      {/* Not a `.turn`: it has not happened. The pane's own count and the
          card's context both mean "messages that arrived", and folding an
          unsent draft into that number would inflate every one of them. */}
      <p id="pane-pinned">{props.draftBody}</p>
    </section>
  );
}

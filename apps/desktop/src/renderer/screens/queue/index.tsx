/**
 * The queue screen: twenty drafts, one listbox, one tab stop.
 *
 * This is the screen Scenario 8's checkpoint runs on — twenty drafts triaged
 * by keyboard in under a minute — so every structural decision here is made
 * for that budget rather than for this scenario's rows.
 *
 * WHY `aria-activedescendant` AND NOT ROVING TABINDEX. Both are valid ARIA
 * listbox patterns and the choice is forced by virtualization. With roving
 * tabindex, DOM focus lives on the active OPTION; this list renders a window
 * of its rows, so the focused node is unmounted the moment it scrolls out of
 * that window, focus falls to `<body>`, and the next keystroke goes nowhere.
 * The failure is silent and it ends the checkpoint run. With
 * `aria-activedescendant` there is exactly one focus holder — the container —
 * scrolling is a paint, and nothing can lose focus. The e2e asserts
 * `tabbables === 1` and reads `document.activeElement.id` after a keystroke,
 * so the claim is behavioural rather than a comment.
 *
 * WHY THE SCREEN HOLDS NO STATE. `activeIndex` and the expanded id live in
 * the composition root and arrive here as props. An arch row bans
 * `window.wm` and `bridge.<member>` from this whole subtree, and a screen
 * that owned its own cursor would be a screen that needs an effect to keep
 * it in step with a list that changes underneath it — which is the bug where
 * a draft leaves the queue and the cursor silently names the wrong card.
 * Data in as props, verbs out as one callback.
 *
 * WHY THERE IS NO TIMER. The app owns exactly one `setTimeout`, at the
 * composition root, and an arch row proves it. So the scroll window is
 * ARITHMETIC over the active index rather than a measured scroll position
 * with a debounce, the relative times are computed from a `now` the root
 * passes in, and there is no typeahead buffer to expire.
 */
import type { VNode } from 'preact';
import { Listbox, type ListboxOption } from '../../components/Listbox.js';
import type { CardModel } from '../../derive/queue.js';
import {
  legendFor,
  verbOf,
  type KeyMode,
  type QueueVerb,
} from '../../keys/index.js';
import type {
  ConnState,
  Conversation as Thread,
  Turn,
} from '../../store/optimistic.js';
import type { BatchModel } from '../../derive/batch.js';
import { Editor } from '../../components/Editor.js';
import { BatchCard } from './BatchCard.js';
import { Card } from './Card.js';
import { Conversation } from './Conversation.js';
import { DisconnectedOverlay } from './DisconnectedOverlay.js';
import { Empty } from './Empty.js';

/**
 * How many options are mounted at once.
 *
 * Comfortably more than the twenty-draft seed, so the checkpoint never pays
 * for a re-window mid-run, and far short of the thousands a busy week could
 * accumulate. The window is a SLICE of the sorted list, which is what keeps
 * every child of the container a `role="option"` — a listbox whose children
 * are two spacers and a group is not a listbox, whatever its role says, so
 * the spacers are siblings of the list and not children of it.
 */
const LIST_WINDOW = 60;

/** How many turns of the thread the right pane mounts. */
const PANE_WINDOW = 40;

/**
 * A nominal card, in pixels, used only to size the virtualization spacers.
 *
 * NOMINAL and not measured. A spacer sized from a real row would need the
 * rows measured, which needs a resize observer, which needs a debounce,
 * which needs a timer — and this app owns exactly one, at the composition
 * root. What the spacers are for is a scrollbar that describes the whole
 * queue instead of the slice on screen, and an approximate one does that;
 * nothing is positioned from this number, so being a few pixels out costs
 * nothing but a slightly wrong thumb size on a queue of thousands.
 */
const ROW_HEIGHT = 78;

/**
 * How many turns a card shows inline when it is expanded.
 *
 * Three, because context is what came JUST BEFORE the thing you are being
 * asked to approve. A card that expanded to the whole thread would push the
 * next nineteen drafts off screen, which is the opposite of what the key is
 * for.
 */
const CARD_TURNS = 3;

export interface QueueScreenProps {
  readonly cards: readonly CardModel[];
  readonly activeIndex: number;
  /** The draft whose context turns are open inline, or none. */
  readonly expandedId: string | null;
  /**
   * The marked cards, by draft id (s8 Sc9).
   *
   * A SET rather than a count, because this screen has to answer the
   * question per row — `aria-selected` is on every option, always present
   * and never inferred — and the count the header and the keymap need is
   * one read of `.size` away. The set is the composition root's; the screen
   * still owns no state.
   */
  readonly selected: ReadonlySet<string>;
  /**
   * The last bulk, summarised, or `null` when there has not been one.
   *
   * Above the list and never inside it: a batch is not a draft, the cursor
   * may not land on it, and every child of a listbox has to be an option.
   */
  readonly batch: BatchModel | null;
  /** The active card's thread, for the right pane. */
  readonly thread: Thread;
  readonly demo: boolean;
  /**
   * The link, as the STORE has it.
   *
   * Deliberately the reducer's `ConnState` and not the stream payload's
   * state, even though both are narrowed from the same push. This value is
   * the one that gates `start()`, so `#queue[data-link]` is a statement
   * about whether a keystroke can reach the wire rather than a second
   * opinion about the socket that could drift from the first.
   */
  readonly link: ConnState;
  /** Which reconnect attempt is in flight; zero while the link is up. */
  readonly attempt: number;
  /** True when the app knows its map may be wrong and is fetching a new one. */
  readonly stale: boolean;
  /** The last instant a fetch actually answered, or absent if none has. */
  readonly syncedAt: string | undefined;
  /** `ARMED`, `ARMED UNTIL hh:mm`, or `DISARMED · QUEUE-ONLY`. */
  readonly arming: string;
  /** The enabled rules, for an empty queue to account for itself with. */
  readonly watching: readonly string[];
  /** What assistive technology is told last happened. May be empty. */
  readonly announcement: string;
  /**
   * The body being edited, or `null` when nobody is editing.
   *
   * `null` and not `''`: an empty string is a body somebody has deleted
   * every character of, which is a real state the editor has to be able to
   * be in, and conflating it with "no editor" would close the box under the
   * operator the moment they selected all and pressed delete.
   */
  readonly editing: string | null;
  readonly onEdit: (next: string) => void;
  readonly onVerb: (verb: QueueVerb) => void;
}

/**
 * The mounted slice, and how far the list is scrolled to reach it.
 *
 * Kept together because they are one decision: the offset is what makes a
 * windowed list scroll correctly, and computing them in two places is how
 * the rows and the scrollbar end up disagreeing.
 */
function windowOf(
  total: number,
  active: number,
): { readonly start: number; readonly end: number } {
  if (total <= LIST_WINDOW) return { start: 0, end: total };
  // Centre the window on the cursor, then clamp it inside the list, so the
  // active option is always mounted and `aria-activedescendant` can never
  // point at a node that is not in the document.
  const half = Math.floor(LIST_WINDOW / 2);
  const start = Math.max(0, Math.min(total - LIST_WINDOW, active - half));
  return { start, end: start + LIST_WINDOW };
}

/** The last `count` turns, which is the tail a person actually reads. */
const tail = (turns: readonly Turn[], count: number): readonly Turn[] =>
  turns.length <= count ? turns : turns.slice(-count);

export default function QueueScreen(props: QueueScreenProps): VNode {
  const { cards, activeIndex } = props;
  const active = activeIndex >= 0 ? cards[activeIndex] : undefined;
  const slice = windowOf(cards.length, activeIndex);
  const mounted = cards.slice(slice.start, slice.end);

  // Disconnected is the one state where the list is INERT rather than
  // merely wrong. Stale is not: a stale queue is a queue the app is already
  // refetching, every card on it was really there a moment ago, and locking
  // an operator out of a list that is about to be confirmed correct trades a
  // small honesty problem for a large one. Stale says so and stays usable;
  // disconnected says so and refuses.
  const inert = props.link !== 'connected';

  /**
   * Which keyboard the operator is at, derived and never stored.
   *
   * The same value that produces `inert`, so a link the screen has dimmed
   * and a link the keymap refuses can never be two different opinions. The
   * editor wins over the link: a person mid-sentence when the socket drops
   * keeps their sentence, and the commit stroke is refused downstream by the
   * store's own `offline` check rather than by yanking the box away.
   */
  const mode: KeyMode =
    props.editing !== null ? 'editing' : inert ? 'offline' : 'list';

  const options: ListboxOption[] = mounted.map((card) => {
    const expanded = props.expandedId === card.draftId;
    return {
      id: card.domId,
      selected: props.selected.has(card.draftId),
      active: card.draftId === active?.draftId,
      label: card.label,
      attrs: {
        'data-draft': card.draftId,
        'data-state': card.state,
        // Always present, both ways: a card that only carried the attribute
        // when open would make "is this expandable" and "is this expanded"
        // the same question, and the e2e waits on the `false` spelling to
        // prove a collapse really happened.
        'aria-expanded': expanded ? 'true' : 'false',
      },
      body: (
        <Card
          card={card}
          legend={
            card.draftId === active?.draftId
              ? legendFor({
                  group: card.isGroup,
                  // A failed card cannot be approved — the store's
                  // `STARTABLE.approve` is `{pending}` — so `A` on one means
                  // retry, and the legend says the word it means rather than
                  // offering a key two meanings and a card one lie.
                  retry: card.state === 'failed',
                })
              : null
          }
          expanded={expanded}
          turns={expanded ? tail(props.thread.recent, CARD_TURNS) : []}
        />
      ),
    };
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    const verb = verbOf(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      },
      // The COUNT, not the set. The only question the keymap asks of a
      // selection is whether there is one, and `⇧A` returning null with an
      // empty selection is what stops a shifted verb degrading into its
      // unshifted twin.
      { mode, selected: props.selected.size },
    );
    if (verb === null) return;
    // Only for keys we claimed. A handler that preventDefault'd everything
    // would eat the browser's own find, and refusing a keystroke we did not
    // want is exactly what `verbOf` returning null means.
    event.preventDefault();
    props.onVerb(verb);
  };

  return (
    <div
      id="queue"
      data-count={String(cards.length)}
      data-link={props.link}
      data-stale={props.stale ? 'yes' : 'no'}
      data-empty={cards.length === 0 ? 'yes' : 'no'}
      // The ACTIVE conversation's observed total, not the length of what the
      // pane mounted. A truncated render must never become a smaller number
      // on screen.
      data-turns={String(props.thread.total)}
    >
      <div id="queue-head">
        <span id="queue-count">{`${String(cards.length)} PENDING`}</span>
        {/*
          The selection, and the two keys that spend it, in the one place
          an operator is already looking. Absent rather than `0 SELECTED`
          when there is nothing marked: a permanent counter reading zero is
          a counter people stop reading, and the header would then be
          claiming a mode the app is not in. Without this line `⇧A` is a
          keystroke whose blast radius the operator is holding in their
          head.
        */}
        {props.selected.size === 0 ? null : (
          <span id="queue-selected">
            {`${String(props.selected.size)} SELECTED · ⇧A/⇧R ONE BATCH`}
          </span>
        )}
        {props.demo ? <span id="demo-badge">DEMO DATA</span> : null}
      </div>
      {/*
        The batch summary, between the header and the list, and a SIBLING of
        the listbox in every sense: the cursor cannot reach it, nothing on
        it is clickable, and it disappears when the next bulk replaces it.
      */}
      {props.batch === null ? null : <BatchCard batch={props.batch} />}
      {/*
        The one live region. `role="status"` rather than `alert`: a draft
        arriving or leaving is not an interruption, and `status` is polite,
        so it does not cut across a card the operator is having read to them.
      */}
      <p id="queue-live" role="status">
        {props.announcement}
      </p>
      {/*
        The stale banner, above the list and not over it. An operator MAY act
        on a stale queue — the rows on it were real when they were fetched
        and the refetch is already in flight — but they may not do it without
        being told, so the fact is on screen at all times rather than
        attached to the card that turns out to be wrong.
      */}
      {props.stale ? (
        <p id="queue-stale">◌ STALE · QUEUE MAY BE OUT OF DATE</p>
      ) : null}
      {props.link === 'reconnecting' ? (
        <DisconnectedOverlay
          attempt={props.attempt}
          syncedAt={props.syncedAt}
        />
      ) : null}
      <div id="queue-body">
        {/*
          The virtualization spacers are SIBLINGS of the listbox, never
          children of it: every child of a `role="listbox"` has to be a
          `role="option"`, and a spacer is not one. The e2e asserts the
          container has zero non-option children.
        */}
        <div id="queue-scroll">
          {slice.start === 0 ? null : (
            <div
              id="queue-spacer-top"
              data-rows={String(slice.start)}
              style={{ height: `${String(slice.start * ROW_HEIGHT)}px` }}
            />
          )}
          <Listbox
            id="queue-list"
            label="Drafts waiting for approval"
            options={options}
            activeId={active?.domId ?? null}
            disabled={inert}
            onKeyDown={onKeyDown}
          />
          {/*
            BESIDE the listbox, never instead of it. An empty state that
            replaced the list would unmount the window's only tab stop, drop
            focus to `<body>`, and make the first draft to arrive land in a
            document where the next keystroke goes nowhere. The list stays,
            with no options in it, and this says what that means.
          */}
          {cards.length === 0 ? (
            <Empty arming={props.arming} watching={props.watching} />
          ) : null}
          {slice.end >= cards.length ? null : (
            <div
              id="queue-spacer-bottom"
              data-rows={String(cards.length - slice.end)}
              style={{
                height: `${String((cards.length - slice.end) * ROW_HEIGHT)}px`,
              }}
            />
          )}
        </div>
        {/*
          The editor, beside the list rather than inside it. An option with
          a focusable child is an ARIA violation and a second focus owner;
          this keeps the listbox's single tab stop intact while it is
          closed, and adds exactly one while it is open.
        */}
        {props.editing === null || active === undefined ? null : (
          <Editor
            value={props.editing}
            label={`Edit draft to ${active.who} before approving`}
            onInput={props.onEdit}
            onKeyDown={onKeyDown}
          />
        )}
        {active === undefined ? null : (
          <Conversation
            draftId={active.draftId}
            total={props.thread.total}
            turns={tail(props.thread.recent, PANE_WINDOW)}
            draftBody={active.body}
          />
        )}
      </div>
    </div>
  );
}

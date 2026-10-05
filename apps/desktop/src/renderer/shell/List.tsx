/**
 * v2 A1: the conversations list.
 *
 * The app's one listbox component, handed a different list. Everything the
 * queue proved about a list that has to stay usable at thousands of rows
 * holds here unchanged, because it is the same component:
 *
 *  - ONE tab stop. The container holds focus and `aria-activedescendant`
 *    names the cursor, so the window can be re-sliced under the operator's
 *    keystrokes without anything losing focus.
 *  - A WINDOW of at most sixty mounted options, centred on the cursor, so
 *    the active row is always in the document. The spacers that stand in
 *    for the rows outside it are siblings of the list, never children: a
 *    listbox's children are its options and nothing else.
 *  - The WHOLE list's size on every option. Four thousand conversations
 *    arrive a hundred at a time and sixty are mounted; `aria-setsize` and
 *    `aria-posinset` are what stop a screen reader announcing "1 of 60".
 *
 * What is new is that this list selects rather than marks. One
 * conversation at a time is the subject of the window, so the listbox says
 * `aria-multiselectable="false"` and selection follows the cursor.
 *
 * The keys are interpreted here and the move is applied by the composition
 * root, the queue's division of labour: this file decides that a stroke is
 * ours (and only then calls `preventDefault`), and `main.tsx` decides where
 * the cursor lands and whether that means asking for the next page.
 *
 * A view, under the same ban as `components/` and `screens/`: no bridge, no
 * clock, no subscription.
 */
import type { VNode } from 'preact';
import { Listbox, type ListboxOption } from '../components/Listbox.js';
import { windowAround, type ThreadRow } from '../derive/threads.js';
import { threadsVerbOf, type ThreadsVerb } from '../keys/threads.js';

/** The most options mounted at once, the queue's number for the queue's reason. */
const LIST_WINDOW = 60;

/**
 * A nominal row, in pixels, used only to size the spacers: the sheet's
 * fixed row height plus the gap between rows. Nominal for the queue's
 * reason too. Measuring would want an observer and a debounce, and the
 * debounce would want a timer this app keeps at the composition root.
 */
const ROW_HEIGHT = 56;

/** The DOM id of the option at `index` in the HELD list. */
export function threadOptionId(index: number): string {
  return `thread-${String(index)}`;
}

export interface ThreadListProps {
  readonly rows: readonly ThreadRow[];
  /** The daemon's count of the whole list, of which `rows` is a prefix. */
  readonly total: number;
  /** The cursor, as an index into `rows`; clamped here. */
  readonly activeIndex: number;
  /** Whether the list is inert because there is no page to vouch for. */
  readonly inert: boolean;
  /** Words BESIDE the list for a state with no rows to show, or `''`. */
  readonly note: string;
  /** Whether the daemon answered and the answer was an empty list. */
  readonly empty: boolean;
  readonly onMove: (verb: ThreadsVerb) => void;
}

export function ThreadList(props: ThreadListProps): VNode {
  const held = props.rows.length;
  const active =
    held === 0 ? -1 : Math.max(0, Math.min(held - 1, props.activeIndex));
  const slice = windowAround(held, Math.max(0, active), LIST_WINDOW);
  const options: ListboxOption[] = props.rows
    .slice(slice.start, slice.end)
    .map((row, offset) => {
      const index = slice.start + offset;
      const on = index === active;
      return {
        id: threadOptionId(index),
        selected: on,
        active: on,
        label: row.label,
        attrs: { 'data-group': row.isGroup ? 'yes' : 'no' },
        position: index + 1,
        body: (
          <>
            <span class="thread-monogram">{row.monogram}</span>
            <span class="thread-mark">{row.mark}</span>
            <span class="thread-title">{row.title}</span>
            <span class="thread-time">{row.time}</span>
            <span class="thread-preview">{row.preview}</span>
          </>
        ),
      };
    });

  const onKeyDown = (event: KeyboardEvent): void => {
    const verb = threadsVerbOf({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });
    if (verb === null) return;
    // Only for keys we claimed. Enter and Escape fall through untouched,
    // which is what "not bound yet" means.
    event.preventDefault();
    props.onMove(verb);
  };

  return (
    <div id="threads-scroll">
      {slice.start === 0 ? null : (
        <div
          id="threads-spacer-top"
          data-rows={String(slice.start)}
          style={{ height: `${String(slice.start * ROW_HEIGHT)}px` }}
        />
      )}
      <Listbox
        id="threads-list"
        label="Conversations"
        options={options}
        activeId={active < 0 ? null : threadOptionId(active)}
        disabled={props.inert}
        onKeyDown={onKeyDown}
        multiselectable={false}
        // Never smaller than what is held: a position past the set's size
        // is a fraction no screen reader can say.
        setSize={Math.max(props.total, held)}
      />
      {/*
        BESIDE the list, never inside it and never instead of it, the
        queue's rule: an empty state that replaced the list would unmount
        the window's only tab stop.
      */}
      {props.empty ? (
        <p id="threads-empty">
          No conversations yet. When this Mac's Messages history has one, it is
          listed here.
        </p>
      ) : null}
      {props.note === '' ? null : <p id="threads-note">{props.note}</p>}
      {slice.end >= held ? null : (
        <div
          id="threads-spacer-bottom"
          data-rows={String(held - slice.end)}
          style={{ height: `${String((held - slice.end) * ROW_HEIGHT)}px` }}
        />
      )}
    </div>
  );
}

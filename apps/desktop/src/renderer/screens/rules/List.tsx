/**
 * The rules list: the priority order, and the way an operator changes it.
 *
 * §1.7's evaluator takes the FIRST matching rule and stops. So this list is
 * not a collection, it is a decision procedure the operator can read top to
 * bottom, and the order is the only place that fact is visible. `#rules-
 * order-note` says it in words rather than leaving it to be inferred from a
 * column of numbers, because "priority 20" tells nobody which of two rules
 * answers a message that matches both.
 *
 * Reordering is a DRAG, and it is delegated:
 *
 *  - `<Listbox>` is untouched. It owns `role="listbox"`/`role="option"`
 *    app-wide and its options carry `data-*` only, so per-option handlers
 *    cannot be passed to it — and should not be. Mouse events bubble, so a
 *    wrapper listens once and asks `closest()` which row it landed on.
 *  - No HTML5 `draggable`. That API mints a drag IMAGE and a data transfer,
 *    both of which are ways for a row to leave the window; a mousedown on
 *    the grip and a mouseup on a row is the whole gesture.
 *  - No timer anywhere near it. There is no drag-hover autoscroll and no
 *    animated settle: the reorder is a paint after the daemon answers.
 *
 * `justDragged` suppresses the click the browser synthesises after a
 * mouse-up. Without it, dropping a row onto another row would also SELECT
 * the row it was dropped on, so a reorder would silently throw away an
 * unsaved edit in the detail pane.
 *
 * The dimming of a disabled rule is opacity AND the word OFF AND
 * `data-enabled="no"`. §3.10: colour, and by extension weight, is never the
 * sole carrier of state.
 */
import type { VNode } from 'preact';
import { Listbox, type ListboxOption } from '../../components/Listbox.js';

export interface RuleRow {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** `AUTO`, `DRAFT-ONLY` or `OFF` — the rule's own rung, uppercase. */
  readonly respond: string;
  readonly today: number;
  readonly priority: number;
}

export interface RulesListProps {
  readonly rows: readonly RuleRow[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** Move `fromId` to where `toId` currently is. Priorities are the caller's. */
  readonly onReorder: (fromId: string, toId: string) => void;
  readonly onNew: () => void;
  readonly busy: boolean;
}

/** The row the pointer went down on, between mousedown and mouseup. */
let dragging: string | null = null;
/** Whether the click that follows this mouse-up is a drag's echo. */
let justDragged = false;

/**
 * The id of the row the event happened inside, if any.
 *
 * Matched on `data-rule-id`, the attribute THIS screen puts on its options,
 * rather than on the option ROLE. The role belongs to `components/Listbox`
 * and an arch row asserts it is declared in that one file: a screen that
 * spelled the role in a selector would be a second place the list's ARIA
 * contract is written down, and the guard is right to say so. The attribute
 * is also the more honest question — this asks which rule, not which role.
 */
function rowIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return (
    target.closest('li[data-rule-id]')?.getAttribute('data-rule-id') ?? null
  );
}

export function RulesList(props: RulesListProps): VNode {
  const options: ListboxOption[] = props.rows.map((row) => ({
    id: `rule-opt-${row.id}`,
    selected: row.id === props.selectedId,
    active: row.id === props.selectedId,
    // Words, in the order they matter: which rule, whether it is on, and how
    // much it did today. An operator listening to this list is triaging.
    label: `${row.name.toUpperCase()}, ${row.respond}, ${String(
      row.today,
    )} MATCHES TODAY, PRIORITY ${String(row.priority)}`,
    attrs: {
      'data-rule-id': row.id,
      'data-enabled': row.enabled ? 'yes' : 'no',
      'data-respond': row.respond,
    },
    body: (
      <div class="rule-row">
        <span class="rule-grip" aria-hidden="true">
          ⠿
        </span>
        <span class="rule-name">{row.name.toUpperCase()}</span>
        <span class="rule-state">{row.respond}</span>
        <span class="rule-today">{String(row.today)} TODAY</span>
      </div>
    ),
  }));
  return (
    <div class="rules-pane">
      <div class="rules-pane-head">
        <h2 class="rules-pane-title">RULES</h2>
        <button
          id="rules-new"
          class="rules-new"
          type="button"
          disabled={props.busy}
          onClick={props.onNew}
        >
          NEW RULE
        </button>
      </div>
      <div
        class="rules-listwrap"
        onMouseDown={(event) => {
          if (!(event.target instanceof Element)) return;
          if (event.target.closest('.rule-grip') === null) return;
          dragging = rowIdAt(event.target);
          // Suppress the text selection a drag across rows would otherwise
          // paint. `user-select: none` on the grip covers the grip itself;
          // this covers everything the pointer crosses on the way.
          if (dragging !== null) event.preventDefault();
        }}
        onMouseUp={(event) => {
          const from = dragging;
          dragging = null;
          if (from === null) return;
          const to = rowIdAt(event.target);
          justDragged = true;
          if (to !== null && to !== from) props.onReorder(from, to);
        }}
        onClick={(event) => {
          if (justDragged) {
            justDragged = false;
            return;
          }
          const id = rowIdAt(event.target);
          if (id !== null) props.onSelect(id);
        }}
      >
        <Listbox
          id="rules-list"
          label="RULES, IN THE ORDER THEY ARE EVALUATED"
          options={options}
          activeId={
            props.selectedId === null ? null : `rule-opt-${props.selectedId}`
          }
          disabled={props.busy}
          onKeyDown={(event) => {
            // Selection by keyboard is the next scenario's problem; what
            // matters today is that the list does not EAT strokes it has no
            // verb for, so ⌘2 and the queue's own keymap still reach the
            // window listener that owns them.
            if (event.key === 'Enter' || event.key === ' ') {
              const id = rowIdAt(event.target);
              if (id !== null) {
                event.preventDefault();
                props.onSelect(id);
              }
            }
          }}
        />
      </div>
      <p id="rules-order-note" class="rules-note">
        FIRST MATCH WINS · DRAG A ROW BY ITS GRIP TO CHANGE THE ORDER
      </p>
    </div>
  );
}

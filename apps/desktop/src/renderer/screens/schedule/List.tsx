/**
 * The schedules, as a list. Fewer decisions than the rules list, and for a
 * reason worth writing down: schedules have no ORDER. §1.7 evaluates rules
 * first-match-wins, so the rules list is a decision procedure and its order
 * is load-bearing; a rule names ONE schedule, so two schedules never compete
 * and there is nothing here to drag.
 *
 * `components/Listbox` is reused untouched. It owns `role="listbox"` and
 * `role="option"` app-wide, its container is the single tab stop, and its
 * options carry `data-*` and no handlers — which is not a limitation to work
 * around but the property that keeps an option one announceable thing. So
 * selection is a click on a WRAPPER that asks `closest()` which row it
 * landed on, exactly as the rules list does it.
 *
 * The row says which zone the schedule is in, because two schedules named
 * "front desk" and "front desk (LA)" are the same mistake as one schedule
 * whose zone nobody checked.
 */
import type { VNode } from 'preact';
import { Listbox, type ListboxOption } from '../../components/Listbox.js';

export interface ScheduleRow {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly enabled: boolean;
  /** How many windows it holds, which is the size of what it decides. */
  readonly windows: number;
  /** How many rules point at it. Zero is a schedule that decides nothing. */
  readonly rules: number;
}

export interface ScheduleListProps {
  readonly rows: readonly ScheduleRow[];
  readonly selectedId: string | null;
  readonly busy: boolean;
  readonly onSelect: (id: string) => void;
}

/** Which schedule an event happened inside, by this screen's own attribute. */
function rowIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return (
    target.closest('li[data-schedule-id]')?.getAttribute('data-schedule-id') ??
    null
  );
}

export function ScheduleList(props: ScheduleListProps): VNode {
  const options: ListboxOption[] = props.rows.map((row) => ({
    id: `sched-opt-${row.id}`,
    selected: row.id === props.selectedId,
    active: row.id === props.selectedId,
    label: `${row.name.toUpperCase()}, ${row.timezone}, ${String(
      row.windows,
    )} WINDOWS, ${String(row.rules)} RULES`,
    attrs: {
      'data-schedule-id': row.id,
      'data-enabled': row.enabled ? 'yes' : 'no',
      'data-rules': String(row.rules),
    },
    body: (
      <div class="sched-row">
        <span class="sched-row-name">{row.name.toUpperCase()}</span>
        <span class="sched-row-zone">{row.timezone}</span>
        <span class="sched-row-count">
          {String(row.rules)} RULES · {String(row.windows)} WINDOWS
        </span>
      </div>
    ),
  }));
  return (
    <div class="rules-pane">
      <div class="rules-pane-head">
        <h2 class="rules-pane-title">SCHEDULES</h2>
      </div>
      <div
        class="sched-listwrap"
        onClick={(event) => {
          const id = rowIdAt(event.target);
          if (id !== null) props.onSelect(id);
        }}
      >
        <Listbox
          id="sched-list"
          label="SCHEDULES"
          options={options}
          activeId={
            props.selectedId === null ? null : `sched-opt-${props.selectedId}`
          }
          disabled={props.busy}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const id = rowIdAt(event.target);
            if (id === null) return;
            event.preventDefault();
            props.onSelect(id);
          }}
        />
      </div>
      <p id="sched-list-note" class="rules-note">
        A RULE NAMES ONE SCHEDULE · SCHEDULES DO NOT COMPETE, SO THIS LIST HAS
        NO ORDER
      </p>
    </div>
  );
}

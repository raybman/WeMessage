/**
 * The contacts grid, and the one file in the renderer that spells the grid
 * ARIA roles.
 *
 * `role="grid"` rather than a list, because this is a table an operator
 * reads ACROSS: the policy in column three only means something next to the
 * service in column four and the count in column five — a handle set to
 * AUTO on SMS is not auto-anything, and a list of one-line summaries would
 * have to say so in prose, per row, forever. An arch row pins `grid`,
 * `row`, `columnheader` and `gridcell` to this file, because a second file
 * spelling `role="row"` is a second file that has to be kept honest about
 * rowcount, order and selection.
 *
 * It draws a WINDOW. `aria-rowcount` and `data-total` both carry the size
 * of the whole book while the DOM holds a page of it, and each drawn row
 * carries `aria-rowindex` so its position in the book travels with it. The
 * two counts are deliberately the same number: they answer the same
 * question, and two counts that can disagree is the drift this grid is
 * trying to avoid. What is NOT drawn is stated in words above the grid.
 *
 * No state, no clock, no bridge. Every string arrives as a prop, already
 * decided, so that what this screen SAYS about the gate is decided in
 * `derive/` where it can be proved without a browser.
 */
import type { VNode } from 'preact';
import type { ContactMode } from '@wemessage/client';
import { Segmented } from './Segmented.js';

export interface PeopleGridRow {
  /** The handle, or the chat guid for a room. */
  readonly key: string;
  /** What the first cell reads: a handle, or a room's guid. */
  readonly handle: string;
  readonly name: string;
  /** `auto`, `draft-only`, `deny` or `none` — the absence IS a value. */
  readonly modeAttr: string;
  /** The stored mode the segmented control reflects, or `null`. */
  readonly mode: ContactMode | null;
  /** Never empty. `derive/peopleRows.ts#modeCell` has no branch that is. */
  readonly modeText: string;
  readonly service: string;
  readonly isGroup: boolean;
  readonly auto: string;
  readonly autoText: string;
  /** A `GateDenyReason`, or `''` when nothing is holding this row back. */
  readonly held: string;
  readonly dim: boolean;
  readonly selected: boolean;
  readonly queued: number;
}

export interface PeopleGridProps {
  /** The page that is drawn. */
  readonly rows: readonly PeopleGridRow[];
  /** The size of the BOOK, not of the page. */
  readonly total: number;
  readonly busy: boolean;
  /** Open the scope pane for this row. */
  readonly onOpen: (key: string) => void;
  /** Add or remove this row from the bulk selection. */
  readonly onPick: (key: string) => void;
  readonly onMode: (key: string, mode: ContactMode) => void;
}

const HEADERS = [
  'HANDLE',
  'NAME',
  'POLICY',
  'AUTO-SENDS · LAST HOUR',
  'QUEUED',
] as const;

export function PeopleGrid(props: PeopleGridProps): VNode {
  return (
    <div
      id="people-grid"
      class="people-grid"
      role="grid"
      aria-label="CONTACTS AND POLICIES"
      aria-rowcount={props.total}
      data-total={String(props.total)}
    >
      <div class="people-row people-headrow" role="row">
        {HEADERS.map((head) => (
          <span key={head} class="people-th" role="columnheader">
            {head}
          </span>
        ))}
      </div>
      {props.rows.map((row, index) => (
        <div
          key={row.key}
          class="people-row"
          role="row"
          aria-rowindex={index + 1}
          data-key={row.key}
          data-mode={row.modeAttr}
          data-service={row.service}
          data-group={row.isGroup ? 'yes' : 'no'}
          data-held={row.held}
          data-dim={row.dim ? 'yes' : 'no'}
          data-selected={row.selected ? 'yes' : 'no'}
        >
          <span class="people-cell people-cell-handle" role="gridcell">
            <button
              type="button"
              class="people-x"
              data-key={row.key}
              data-state={row.selected ? 'ON' : 'OFF'}
              aria-pressed={row.selected}
              aria-label={`SELECT ${row.key}`}
              disabled={props.busy}
              onClick={() => {
                props.onPick(row.key);
              }}
            />
            {/* A room's name is its guid and there is nothing behind it to
                open: INV-5 gives a group thread no counterparty, so it has
                no ladder. A button that opened an empty pane would be a
                control that does nothing, which is worse than none. */}
            {row.isGroup ? (
              <span class="people-handle">{row.handle}</span>
            ) : (
              <button
                type="button"
                class="people-handle"
                aria-label={`SCOPE FOR ${row.key}`}
                onClick={() => {
                  props.onOpen(row.key);
                }}
              >
                {row.handle}
              </button>
            )}
          </span>
          <span class="people-cell people-name" role="gridcell">
            {row.name}
          </span>
          <span class="people-cell people-policy" role="gridcell">
            {/* The WORD first and the control after it. The cell has to be
                readable when nothing is stored, and the segmented control
                has no position for "no row at all". */}
            <span class="people-mode">{row.modeText}</span>
            {row.isGroup ? null : (
              <Segmented
                rowKey={row.key}
                mode={row.mode}
                disabled={props.busy}
                onMode={(mode) => {
                  props.onMode(row.key, mode);
                }}
              />
            )}
          </span>
          <span
            class="people-cell people-auto"
            role="gridcell"
            data-auto={row.auto}
          >
            {row.autoText}
          </span>
          <span class="people-cell people-queued" role="gridcell">
            {String(row.queued)}
          </span>
        </div>
      ))}
    </div>
  );
}

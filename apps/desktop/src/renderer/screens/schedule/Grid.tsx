/**
 * The week, as seven columns of one local day each.
 *
 * A column is EXACTLY 1440 minutes tall and contains nothing else — no
 * header, no padding, no label row — because the pointer arithmetic is
 * `(clientY - top) / height * 1440` and every pixel of chrome inside the
 * canvas would be a pixel of lie in that division. The day names live in a
 * separate row above, which is why they are `.sched-head-cell` rather than
 * part of `.sched-col`.
 *
 * Nothing here reads a clock. An arch row proves it for the whole of
 * `screens/`, and this is the file the row exists for: a NOW marker is the
 * one thing on this screen that wants to read `Date.now()` where it draws,
 * and a marker whose instant is a property of WHEN PREACT HAPPENED TO
 * RENDER is a marker no test can stand still and no operator can check. The
 * instant arrives as a prop, is published as `data-now-iso`, and moves only
 * when somebody asks. There is no timer, and F-117 in the small: nothing is
 * armed for a deadline, so nothing can fire late.
 *
 * The two days a year this grid is not 7×24 are drawn, not hidden. A
 * spring-forward gap is a hole in the day and a fall-back fold is an hour
 * the column holds twice; both are `[from, to)` in the same local-minute
 * vocabulary as everything else, and both are attributes rather than only a
 * pattern, because a hatch is a colour with extra steps.
 *
 * The gesture is a mousedown and a mouseup, and it is deliberately not the
 * HTML5 drag API — that API mints a drag image and a data transfer, both of
 * which are ways for a rectangle to leave the window. Which of the three
 * verbs it means is decided at the DOWN, from where the pointer landed
 * relative to the blocks already on that day: on an edge it resizes, inside
 * a block it moves, and on empty grid it draws. A drag that ends where it
 * started says nothing and is refused, rather than creating a zero-length
 * window the daemon would take and the gate would never open.
 */
import type { VNode } from 'preact';
import type { Weekday } from '@wemessage/client';
import { WEEK, snapTo15, type DayShift } from '../../derive/projectWindow.js';
import { WindowBlock, type BlockView } from './Window.js';

const DAY_MINUTES = 1440;

/**
 * How close to an edge counts as grabbing it, in minutes.
 *
 * Under the quarter hour everything snaps to, so an operator aiming at an
 * edge cannot land on a target that would round somewhere else, and small
 * enough that the middle of even a one-hour window is still a MOVE.
 */
const EDGE_MINUTES = 12;

/** One column: a local day, its seam if it has one, and what is open on it. */
export interface GridColumn {
  readonly day: Weekday;
  /** `YYYY-MM-DD` in the schedule's zone. */
  readonly date: string;
  readonly shift: DayShift | null;
  readonly blocks: readonly BlockView[];
}

/** The instant the composition root last read, placed in the grid's zone. */
export interface NowMarker {
  readonly iso: string;
  readonly zone: string;
  readonly date: string;
  readonly day: Weekday;
  readonly minutes: number;
}

/** What a completed pointer gesture asks for. Applied by the root. */
export type Gesture =
  | {
      readonly kind: 'create';
      readonly day: Weekday;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly kind: 'resize';
      readonly index: number;
      readonly edge: 'start' | 'end';
      readonly minute: number;
    }
  | { readonly kind: 'move'; readonly index: number; readonly delta: number };

export interface GridProps {
  readonly zone: string;
  readonly columns: readonly GridColumn[];
  readonly now: NowMarker | null;
  readonly onGesture: (gesture: Gesture) => void;
}

const LABEL: Readonly<Record<Weekday, string>> = {
  mon: 'MON',
  tue: 'TUE',
  wed: 'WED',
  thu: 'THU',
  fri: 'FRI',
  sat: 'SAT',
  sun: 'SUN',
};

/** The gesture in progress, between one mousedown and its mouseup. */
interface Drag {
  readonly day: Weekday;
  readonly canvas: Element;
  readonly at: number;
  readonly kind: Gesture['kind'];
  readonly index: number;
  readonly edge: 'start' | 'end';
}

let drag: Drag | null = null;

/** Where in the local day a pointer is, read from the element it is over. */
function minuteAt(canvas: Element, clientY: number): number {
  const box = canvas.getBoundingClientRect();
  if (box.height <= 0) return 0;
  const share = (clientY - box.top) / box.height;
  return Math.min(DAY_MINUTES, Math.max(0, share * DAY_MINUTES));
}

/** The column the pointer is in, or `null` when it is over the chrome. */
function columnAt(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.sched-col');
}

export function Grid(props: GridProps): VNode {
  const byDay = new Map<string, readonly BlockView[]>(
    props.columns.map((column) => [column.day, column.blocks]),
  );
  const nowIndex =
    props.now === null
      ? -1
      : props.columns.findIndex((column) => column.date === props.now?.date);
  const now = props.now;
  return (
    <div id="sched-grid" class="sched-grid" data-zone={props.zone}>
      <div class="sched-head">
        {props.columns.map((column) => (
          <div key={column.date} class="sched-head-cell">
            <span class="sched-head-day">{LABEL[column.day]}</span>
            <span class="sched-head-date">{column.date.slice(5)}</span>
          </div>
        ))}
      </div>
      <div
        class="sched-body"
        onMouseDown={(event) => {
          const canvas = columnAt(event.target);
          // Resolved against the closed weekday set rather than cast: the
          // attribute is a string as far as the DOM is concerned, and a
          // column whose day this build does not recognise is a column no
          // gesture should be attributed to.
          const named = canvas?.getAttribute('data-day') ?? null;
          const day = WEEK.find((name) => name === named);
          if (canvas === null || day === undefined) return;
          const at = minuteAt(canvas, event.clientY);
          let kind: Gesture['kind'] = 'create';
          let index = -1;
          let edge: 'start' | 'end' = 'end';
          for (const block of byDay.get(day) ?? []) {
            // A wrapping window's midnight is not one of its edges: the head
            // ends at 24:00 and the tail begins at 00:00 because the DAY
            // ends there, and letting either be grabbed would let an
            // operator resize a boundary the schema does not have.
            const startEdge = !block.tail;
            const endEdge = !(block.wraps && !block.tail);
            if (startEdge && Math.abs(at - block.from) <= EDGE_MINUTES) {
              kind = 'resize';
              index = block.index;
              edge = 'start';
              break;
            }
            if (endEdge && Math.abs(at - block.to) <= EDGE_MINUTES) {
              kind = 'resize';
              index = block.index;
              edge = 'end';
              break;
            }
            if (at > block.from && at < block.to) {
              kind = 'move';
              index = block.index;
              break;
            }
          }
          drag = { day, canvas, at, kind, index, edge };
          // The text selection a drag down a column would otherwise paint
          // across every label it crosses.
          event.preventDefault();
        }}
        onMouseUp={(event) => {
          const started = drag;
          drag = null;
          if (started === null) return;
          // Measured against the column the gesture STARTED in. A pointer
          // that wandered sideways is still editing the day it grabbed, and
          // reading the geometry off wherever it happened to land would make
          // a shaky hand mean a different edit.
          const at = minuteAt(started.canvas, event.clientY);
          if (started.kind === 'create') {
            const from = snapTo15(Math.min(started.at, at));
            const to = snapTo15(Math.max(started.at, at));
            // A drag that ends where it began says nothing. Storing it would
            // be a window of zero minutes: legal to the schema, never open.
            if (to <= from) return;
            props.onGesture({ kind: 'create', day: started.day, from, to });
            return;
          }
          if (started.index === -1) return;
          if (started.kind === 'resize') {
            props.onGesture({
              kind: 'resize',
              index: started.index,
              edge: started.edge,
              minute: snapTo15(at),
            });
            return;
          }
          const delta = snapTo15(at) - snapTo15(started.at);
          if (delta === 0) return;
          props.onGesture({ kind: 'move', index: started.index, delta });
        }}
      >
        {props.columns.map((column) => (
          <div
            key={column.date}
            class="sched-col"
            data-day={column.day}
            data-date={column.date}
            data-shift={String(column.shift?.minutes ?? 0)}
          >
            {column.shift === null ? null : (
              <div
                class={column.shift.minutes > 0 ? 'sched-gap' : 'sched-fold'}
                data-from={String(column.shift.from)}
                data-to={String(column.shift.to)}
                aria-hidden="true"
                style={{
                  top: `${String((column.shift.from / DAY_MINUTES) * 100)}%`,
                  height: `${String(
                    ((column.shift.to - column.shift.from) / DAY_MINUTES) * 100,
                  )}%`,
                }}
              />
            )}
            {column.blocks.map((block) => (
              <WindowBlock
                key={`${String(block.index)}-${String(block.from)}-${
                  block.tail ? 'tail' : 'head'
                }`}
                block={block}
              />
            ))}
          </div>
        ))}
        {now === null || nowIndex === -1 ? null : (
          <div
            id="now-line"
            class="sched-now-line"
            // The instant itself, so the projection beside it can be checked
            // EXACTLY rather than within a tolerance. This attribute is the
            // whole reason the marker is honest: anyone can re-project it.
            data-now-iso={now.iso}
            data-now-zone={now.zone}
            data-now-minutes={String(now.minutes)}
            data-now-day={now.day}
            // Which of the three clocks in this window it is. Not the
            // daemon's, which decides, and not the schedule's, which is a
            // zone rather than a time.
            data-now-source="device"
            aria-hidden="true"
            style={{
              left: `${String((nowIndex / props.columns.length) * 100)}%`,
              width: `${String(100 / props.columns.length)}%`,
              top: `${String((now.minutes / DAY_MINUTES) * 100)}%`,
            }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * One schedule, as a form — and above the form, the three facts an operator
 * needs before they touch it.
 *
 * The order on screen is deliberate:
 *
 *  1. WHAT THE DAEMON SAYS RIGHT NOW. `#sched-armed` is `armingGlance` over
 *     the stream's own arming record, the same helper the empty queue uses,
 *     because a schedule editor that computed its own answer to "is it
 *     armed" would be a second opinion about the one question this screen
 *     exists to change. It is also the OTHER clock: the daemon's, not the
 *     device's, and not the schedule's.
 *  2. WHAT IT COSTS. `#sched-footnote` counts the rules pointing here by
 *     what each of them does when the window is shut. There are exactly two
 *     buckets and this screen did not choose that: F-69's `queue` is in the
 *     published enum so the type stays honest about where the design is
 *     going, and `POST /v1/rules` refuses it with a typed 400, so no stored
 *     rule can be in a third bucket. The count is a fact about the store,
 *     not a GUI folding one mode into another.
 *  3. WHAT A SAVE DOES NOT DO. `#sched-inflight` says, before anything is
 *     changed, that drafts already in the queue are not re-decided. Opening
 *     a window changes what AUTONOMY may do NEXT; `dispatchApproved` wants
 *     an `Approval` row and nothing on this screen can mint one (INV-2). An
 *     editor that let an operator believe otherwise would eventually be
 *     believed.
 *
 * Refusals are the DAEMON's, letter for letter. `[data-issue]` is keyed by
 * the zod `path` the validator produced, joined with dots, and the text is
 * its own `message`. `scheduleProblems` is deliberately incomplete — it does
 * not know that a schedule needs at least one window — so the path from a
 * real 400 to a real field label is exercised by a real refusal rather than
 * by a fixture, and there is no second vocabulary here to drift from zod.
 *
 * The delete is asked ANYWAY. This screen holds the rules catalogue and
 * could pre-check it; guessing is how a GUI ends up refusing something the
 * daemon would have allowed. `DELETE /v1/schedules/:id` answers 409 with a
 * COUNT (F-75) and no names, so the count is the daemon's and the names come
 * from the catalogue, because "which two" is the question a person has.
 */
import type { VNode } from 'preact';
import { Grid, type GridProps } from './Grid.js';
import { TzSelector } from './TzSelector.js';
import { WindowRow } from './Window.js';

export interface WindowEntry {
  readonly index: number;
  /** `MON 09:00–17:00`, plus this week's seam note when there is one. */
  readonly text: string;
}

/** What the daemon said when it refused this schedule's delete. */
export interface ScheduleInUse {
  readonly count: number;
  /** From the catalogue this screen already holds, uppercase. */
  readonly names: readonly string[];
}

export interface ScheduleDetailProps {
  readonly scheduleId: string;
  readonly name: string;
  readonly zone: string;
  readonly hostZone: string;
  /** `YYYY-MM-DD`: any local date in the week the grid is showing. */
  readonly week: string;
  readonly grid: GridProps;
  readonly windows: readonly WindowEntry[];
  readonly dirty: boolean;
  readonly saveDisabled: boolean;
  readonly busy: boolean;
  /** Path → message, daemon's first (`issuesByPath` is first-wins). */
  readonly issues: ReadonlyMap<string, string>;
  /** The daemon's own error code from the last refused write, or `null`. */
  readonly refusal: string | null;
  readonly inUse: ScheduleInUse | null;
  /** `armingGlance` over the stream's arming record. The daemon's word. */
  readonly armed: string;
  readonly footnote: string;
  readonly onName: (next: string) => void;
  readonly onZone: (next: string) => void;
  readonly onWeek: (next: string) => void;
  readonly onNow: () => void;
  readonly onRemoveWindow: (index: number) => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly onDelete: () => void;
}

/** One complaint, addressed by the path whoever produced it named. */
function Issue(props: {
  path: string;
  issues: ReadonlyMap<string, string>;
}): VNode | null {
  const message = props.issues.get(props.path);
  if (message === undefined) return null;
  return (
    <p class="rule-issue" data-issue={props.path}>
      {message}
    </p>
  );
}

export function ScheduleDetail(props: ScheduleDetailProps): VNode {
  const rest = [...props.issues].filter(
    ([path]) => path !== 'name' && path !== 'timezone',
  );
  return (
    <div
      id="sched-detail"
      class="sched-detail"
      data-schedule-id={props.scheduleId}
      data-dirty={props.dirty ? 'yes' : 'no'}
    >
      <section class="rule-block" aria-label="WHAT THIS SCHEDULE IS DOING">
        <h3 class="rule-block-title">WHAT THIS SCHEDULE IS DOING</h3>
        <p id="sched-armed" class="sched-armed">
          {props.armed}
        </p>
        <p id="sched-footnote" class="rule-hint">
          {props.footnote}
        </p>
        <p id="sched-inflight" class="rule-hint">
          DRAFTS ALREADY IN THE QUEUE ARE NOT RE-DECIDED BY A SAVE · OPENING A
          WINDOW CHANGES WHAT AUTONOMY MAY DO NEXT, AND NOTHING ABOUT WORK A
          PERSON HAS ALREADY BEEN ASKED TO DECIDE
        </p>
      </section>

      <section class="rule-block" aria-label="NAME AND ZONE">
        <h3 class="rule-block-title">NAME AND ZONE</h3>
        <div class="sched-field">
          <label class="rule-label" for="sched-name">
            NAME
          </label>
          <input
            id="sched-name"
            class="rule-input"
            type="text"
            aria-label="SCHEDULE NAME"
            value={props.name}
            disabled={props.busy}
            onInput={(event) => {
              props.onName(event.currentTarget.value);
            }}
          />
        </div>
        <Issue path="name" issues={props.issues} />
        <TzSelector
          value={props.zone}
          hostZone={props.hostZone}
          disabled={props.busy}
          onChange={props.onZone}
        />
        <Issue path="timezone" issues={props.issues} />
      </section>

      <section class="rule-block" aria-label="THE WEEK">
        <h3 class="rule-block-title">THE WEEK</h3>
        <div class="sched-weekbar">
          <label class="rule-label" for="sched-week">
            WEEK OF
          </label>
          <input
            id="sched-week"
            class="rule-input rule-mono"
            type="date"
            aria-label="ANY DATE IN THE WEEK TO SHOW"
            value={props.week}
            onInput={(event) => {
              props.onWeek(event.currentTarget.value);
            }}
          />
          {/* The clock is READ HERE, once, when somebody asks. There is no
              interval behind this button: a marker that moved on its own
              would be the app's only piece of unasked-for motion, and it
              would be wrong on exactly the two days this grid is about. */}
          <button
            id="sched-now"
            class="rule-action"
            type="button"
            onClick={props.onNow}
          >
            NOW
          </button>
        </div>
        <Grid {...props.grid} />
        <p class="rule-hint">
          DRAG ON EMPTY GRID TO DRAW A WINDOW · DRAG AN EDGE TO RESIZE ·
          EVERYTHING SNAPS TO THE QUARTER HOUR · NOTHING IS SENT UNTIL SAVE
        </p>
      </section>

      <section class="rule-block" aria-label="WINDOWS">
        <h3 class="rule-block-title">WINDOWS</h3>
        <ul id="sched-windows" class="sched-windows">
          {props.windows.map((entry) => (
            <WindowRow
              key={entry.index}
              index={entry.index}
              text={entry.text}
              label={entry.text}
              disabled={props.busy}
              onRemove={props.onRemoveWindow}
            />
          ))}
        </ul>
        <ul id="sched-issues" class="sched-issues">
          {rest.map(([path, message]) => (
            <li key={path} class="rule-issue" data-issue={path}>
              {message}
            </li>
          ))}
        </ul>
      </section>

      {props.refusal === null ? null : (
        <p id="sched-refuse" class="rule-issue" data-refused={props.refusal}>
          THE DAEMON REFUSED THIS SAVE · {props.refusal.toUpperCase()}
        </p>
      )}
      {props.inUse === null ? null : (
        <p id="sched-inuse" class="rule-issue">
          IN USE BY {String(props.inUse.count)} RULE
          {props.inUse.count === 1 ? '' : 'S'}
          {props.inUse.names.length === 0
            ? ''
            : ` · ${props.inUse.names.join(' · ')}`}
        </p>
      )}

      <div class="rule-actions">
        <button
          id="sched-save"
          class="rule-action"
          type="button"
          disabled={props.saveDisabled}
          onClick={props.onSave}
        >
          SAVE
        </button>
        <button
          id="sched-revert"
          class="rule-action"
          type="button"
          disabled={!props.dirty || props.busy}
          onClick={props.onRevert}
        >
          REVERT
        </button>
        <button
          id="sched-delete"
          class="rule-action"
          type="button"
          disabled={props.scheduleId === '' || props.busy}
          onClick={props.onDelete}
        >
          DELETE
        </button>
      </div>
    </div>
  );
}

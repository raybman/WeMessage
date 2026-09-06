/**
 * The schedule editor's arithmetic: where a rectangle goes, and what to say
 * about it on the two days a year a day is not twenty-four hours long.
 *
 * This is a SECOND implementation of "what time is it there", and that is
 * the design rather than an accident. `packages/core/src/schedule` owns the
 * first one — `isArmed`, `projectToZone`, `windowCloseAfter` — and the
 * daemon calls it to decide whether a message may leave. The renderer
 * physically cannot: `apps/desktop/package.json` does not depend on
 * `@wemessage/core`, and an arch row asserts both halves of that (the
 * manifest, and zero importers under `apps/desktop/src`).
 *
 * So the wall is structural, and the rule that follows from it is the whole
 * discipline of this file: NOTHING HERE DECIDES ANYTHING. It projects, it
 * measures, and it reports what core's documented semantics will do with
 * the window an operator drew. The unit suite pins it against the same four
 * pinned instants `packages/core/test/dst-window.spec.ts` uses, so the two
 * implementations are proved to agree at the seams rather than assumed to.
 *
 * Core's three DST outcomes, restated because they are what the sentences
 * below claim:
 *
 *  - **Spring forward.** A window straddling the gap arms from the gap's
 *    END. It is shorter than it reads, and it opens later than it reads.
 *  - **A window living entirely inside the gap arms for ZERO minutes.**
 *    Clamping it forward would fire a rule at a wall time nobody wrote.
 *  - **Fall back.** BOTH occurrences arm. Somebody expecting an answer at
 *    01:30 that night expects one twice.
 *
 * Zero dependencies. `Intl.DateTimeFormat` plus `formatToParts` is the
 * whole engine (F-57): a timezone library would be a second tz database
 * shipped alongside the runtime's, aging at a different rate, in a repo
 * that already pins every IANA literal in the tree to five zones.
 *
 * NO CLOCK IS READ HERE except by {@link hostZone}, which reads a zone and
 * not an instant. Every projection takes the instant it is given, because
 * the composition root owns the one clock read in this application and a
 * marker that read its own would be a marker no test could stand still.
 */
import type { ScheduleWindowPayload, Weekday } from '@wemessage/client';
import type { FieldIssue } from './form.js';

/**
 * Monday first, which is the order §1.4.1 lists the days in, the order the
 * CLI renders and the order the daemon canonicalises `days[]` into. It is a
 * presentation choice: the gate reads `days` as a set.
 */
export const WEEK: readonly Weekday[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/* ── HH:MM, both ways ─────────────────────────────────────────────────── */

/**
 * A real 24-hour wall clock, or `null`.
 *
 * Strict on purpose: `9:30` is not a spelling this daemon accepts, and an
 * editor that quietly read it as 09:30 would draw a rectangle the gate does
 * not have. A window we cannot read is DROPPED from the drawing, which is
 * at least visibly wrong rather than invisibly different.
 */
export function minutesOf(value: string): number | null {
  const m = HHMM_RE.exec(value);
  if (m === null) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Minutes back to `HH:MM`, zero-padded.
 *
 * 1440 renders as `24:00` and that is deliberate: it is midnight at the FAR
 * end of a day, which is not the same instant as `00:00` on it. A window
 * closing at the end of Friday is drawn to the bottom of Friday's column;
 * the daemon's own vocabulary for it is `00:00`, and the conversion back
 * happens where the payload is built, not here.
 */
export function hhmmOf(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  return `${String(hours).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** A dragged edge, snapped to the quarter hour. */
export function snapTo15(minutes: number): number {
  return Math.round(minutes / 15) * 15;
}

/** Week order, deduped: the same canonical form the daemon stores. */
export function orderedDays(days: readonly Weekday[]): Weekday[] {
  return WEEK.filter((day) => days.includes(day));
}

/* ── projection ───────────────────────────────────────────────────────── */

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: string;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * One formatter per zone, cached.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, because some ICU builds
 * spell midnight as hour `24` under the latter and every minute count in
 * this file would then be a day out for exactly one minute a day.
 *
 * An unknown zone throws `RangeError` and is reported as `null`. The daemon
 * is the only thing entitled to say a zone is invalid — it answers
 * `invalid-timezone` and this module has no opinion — so a zone this
 * runtime cannot project into simply draws nothing.
 */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(zone);
  if (cached !== undefined) return cached;
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return null;
  }
  FORMATTERS.set(zone, made);
  return made;
}

function partsAt(ms: number, zone: string): LocalParts | null {
  if (!Number.isFinite(ms)) return null;
  const formatter = formatterFor(zone);
  if (formatter === null) return null;
  const found: Record<string, string> = {};
  try {
    for (const part of formatter.formatToParts(new Date(ms)))
      found[part.type] = part.value;
  } catch {
    return null;
  }
  const parts: LocalParts = {
    year: Number(found['year']),
    month: Number(found['month']),
    day: Number(found['day']),
    hour: Number(found['hour']),
    minute: Number(found['minute']),
    second: Number(found['second']),
    weekday: found['weekday'] ?? '',
  };
  for (const value of [
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ])
    if (!Number.isFinite(value)) return null;
  return parts;
}

/**
 * The zone's offset from UTC at one instant, in minutes.
 *
 * The `formatToParts` round trip: format the instant into the zone, read the
 * wall clock back as if it were UTC, and the difference is the offset. It
 * is the only way to ask this question without a tz database, and it is
 * correct across every historical rule the runtime knows, including the
 * half-hour and three-quarter-hour ones.
 */
function offsetAtMs(ms: number, zone: string): number | null {
  const parts = partsAt(ms, zone);
  if (parts === null) return null;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - ms) / MS_PER_MINUTE);
}

export function zoneOffsetMinutes(iso: string, zone: string): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return offsetAtMs(ms, zone);
}

/** An instant, placed on a local calendar day and a local minute of it. */
export interface ZonedNow {
  /** `YYYY-MM-DD` in the projected zone. */
  readonly date: string;
  readonly day: Weekday;
  /** Minutes since local midnight, 0–1439. */
  readonly minutes: number;
}

export function nowInZone(iso: string, zone: string): ZonedNow | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const parts = partsAt(ms, zone);
  if (parts === null) return null;
  const short = parts.weekday.slice(0, 3).toLowerCase();
  const day = WEEK.find((name) => name === short);
  if (day === undefined) return null;
  return {
    date: `${String(parts.year).padStart(4, '0')}-${String(
      parts.month,
    ).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    day,
    minutes: parts.hour * 60 + parts.minute,
  };
}

function isoDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayAfter(date: string): string | null {
  if (!DATE_RE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  return isoDateOf(ms + MS_PER_DAY);
}

/**
 * The instant local midnight happens on a given local date.
 *
 * Fixed point rather than arithmetic: guess that the offset is the one at
 * the same wall time UTC, correct, and repeat. Two passes converge for every
 * zone the runtime knows; four is the budget, and a zone that has not
 * settled by then reports its last guess rather than looping.
 *
 * On a spring-forward day this lands on a real instant even when the naive
 * midnight does not exist, because the offset it converges on is the one
 * actually in force there.
 */
function localMidnightMs(date: string, zone: string): number | null {
  if (!DATE_RE.test(date)) return null;
  const base = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return null;
  let guess = base;
  for (let pass = 0; pass < 4; pass += 1) {
    const offset = offsetAtMs(guess, zone);
    if (offset === null) return null;
    const next = base - offset * MS_PER_MINUTE;
    if (next === guess) return guess;
    guess = next;
  }
  return guess;
}

/** What a DST transition did to one local day. */
export interface DayShift {
  /**
   * `1440 - dayMinutes`. POSITIVE means clocks jumped forward and the day is
   * short — the interval `[from, to)` does not exist. NEGATIVE means they
   * went back and `[from, to)` happens twice.
   */
  readonly minutes: number;
  /** Local minute the seam starts at. */
  readonly from: number;
  /** Local minute it ends at. */
  readonly to: number;
  /** How many minutes long the local day actually is. */
  readonly dayMinutes: number;
}

/**
 * The seam in one local day, or `null` for the other 363.
 *
 * The length of the day is measured, not assumed, so a half-hour shift is
 * half an hour: Lord Howe Island moves by thirty minutes and is in the unit
 * suite for exactly that reason. The seam's position is then found by
 * bisecting the day for the instant the offset changes — one binary search
 * over eleven probes, rather than a table this repo would have to maintain.
 */
export function dayShift(date: string, zone: string): DayShift | null {
  const start = localMidnightMs(date, zone);
  if (start === null) return null;
  const next = dayAfter(date);
  if (next === null) return null;
  const end = localMidnightMs(next, zone);
  if (end === null) return null;
  const dayMinutes = Math.round((end - start) / MS_PER_MINUTE);
  if (dayMinutes === MINUTES_PER_DAY) return null;
  const base = offsetAtMs(start, zone);
  if (base === null) return null;
  let lo = 0;
  let hi = dayMinutes;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAtMs(start + mid * MS_PER_MINUTE, zone) === base) lo = mid;
    else hi = mid;
  }
  const at = partsAt(start + hi * MS_PER_MINUTE, zone);
  if (at === null) return null;
  const local = at.hour * 60 + at.minute;
  const minutes = MINUTES_PER_DAY - dayMinutes;
  return minutes > 0
    ? { minutes, from: local - minutes, to: local, dayMinutes }
    : { minutes, from: local, to: local - minutes, dayMinutes };
}

/** One column of the grid. */
export interface WeekDay {
  readonly day: Weekday;
  /** `YYYY-MM-DD`, in the schedule's zone. */
  readonly date: string;
  readonly shift: DayShift | null;
}

/** The Monday-first week containing a local date. */
export function weekFromDate(date: string, zone: string): WeekDay[] {
  if (!DATE_RE.test(date)) return [];
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return [];
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * MS_PER_DAY;
  const out: WeekDay[] = [];
  for (const [index, day] of WEEK.entries()) {
    const on = isoDateOf(monday + index * MS_PER_DAY);
    out.push({ day, date: on, shift: dayShift(on, zone) });
  }
  return out;
}

/** The Monday-first week containing an instant, projected into `zone`. */
export function weekOf(iso: string, zone: string): WeekDay[] {
  const at = nowInZone(iso, zone);
  if (at === null) return [];
  return weekFromDate(at.date, zone);
}

/* ── what to say about a window on a seam day ─────────────────────────── */

export type NoteKind = 'none' | 'gap-never' | 'gap-shortened' | 'fold-twice';

export interface WindowNote {
  readonly kind: NoteKind;
  /** How many REAL minutes the gate will hold this window open. */
  readonly minutes: number;
  /** The short form, for a list. Empty when there is nothing to say. */
  readonly words: string;
}

/**
 * What core will do with `[from, to)` on a day with this seam.
 *
 * Reported, never decided. The three branches are core's three documented
 * outcomes and the arithmetic is the same in both places: the overlap with
 * the seam is subtracted on a spring-forward day and added on a fall-back
 * one, because the fold's minutes happen twice and both arm.
 */
export function windowNote(
  from: number,
  to: number,
  shift: DayShift | null,
): WindowNote {
  const span = to - from;
  if (shift === null) return { kind: 'none', minutes: span, words: '' };
  const overlap = Math.max(
    0,
    Math.min(to, shift.to) - Math.max(from, shift.from),
  );
  if (overlap === 0) return { kind: 'none', minutes: span, words: '' };
  if (shift.minutes > 0) {
    const armed = span - overlap;
    return armed === 0
      ? { kind: 'gap-never', minutes: 0, words: 'NEVER OPENS' }
      : {
          kind: 'gap-shortened',
          minutes: armed,
          words: `SHORT BY ${overlap} MIN`,
        };
  }
  return { kind: 'fold-twice', minutes: span + overlap, words: 'RUNS TWICE' };
}

/**
 * The sentence an operator reads on a seam day, or nothing at all.
 *
 * Mechanical on purpose: a date, two wall times and a verb. This is the one
 * place in the editor that makes a claim about what the GATE will do, and a
 * claim like that should be checkable without a browser — arithmetic dressed
 * up in prose is arithmetic nobody checks.
 *
 * Absent on the other 363 days. A note that appears on every block is a note
 * nobody reads, and reassurance is not information.
 */
export function noteTitle(
  from: number,
  to: number,
  shift: DayShift | null,
  date: string,
): string {
  const note = windowNote(from, to, shift);
  if (shift === null || note.kind === 'none') return '';
  const seam = `${hhmmOf(shift.from)} TO ${hhmmOf(shift.to)}`;
  if (note.kind === 'fold-twice')
    return `RUNS TWICE ON ${date} · CLOCKS REPEAT ${seam}`;
  if (note.kind === 'gap-never')
    return `NEVER OPENS ON ${date} · CLOCKS SKIP ${seam}`;
  // Shortened, and the interesting half is WHICH end moved. A window that
  // opens inside the hour that does not exist opens late, and saying so with
  // the two wall times is more use than saying it lost thirty minutes.
  return from >= shift.from && from < shift.to
    ? `${hhmmOf(from)} DOES NOT OCCUR ON ${date} · ARMS FROM ${hhmmOf(shift.to)}`
    : `${note.words} ON ${date} · CLOCKS SKIP ${seam}`;
}

/* ── windows, as rectangles ───────────────────────────────────────────── */

export interface Block {
  /** The index of the window in the array it was drawn from. */
  readonly index: number;
  readonly day: Weekday;
  readonly from: number;
  readonly to: number;
  readonly wraps: boolean;
  /** True for the piece drawn on the day AFTER the one `days` names. */
  readonly tail: boolean;
}

/**
 * One window, drawn wherever it is open.
 *
 * `end <= start` is a midnight-wrapping window — one window, two rectangles,
 * the SAME index — and `end === start` is twenty-four hours, which is the
 * daemon's own reading of it. Anything that rendered the tail as a separate
 * window would be inventing a boundary the schema does not have, and an
 * operator dragging one of the two halves would find the other one left
 * behind.
 */
export function blocksOf(windows: readonly ScheduleWindowPayload[]): Block[] {
  const out: Block[] = [];
  windows.forEach((window, index) => {
    const start = minutesOf(window.start);
    const end = minutesOf(window.end);
    if (start === null || end === null) return;
    const days = orderedDays(window.days);
    if (days.length === 0) return;
    const wraps = end <= start;
    for (const day of days) {
      out.push({
        index,
        day,
        from: start,
        to: wraps ? MINUTES_PER_DAY : end,
        wraps,
        tail: false,
      });
      if (!wraps || end === 0) continue;
      const next = WEEK[(WEEK.indexOf(day) + 1) % 7];
      if (next !== undefined)
        out.push({
          index,
          day: next,
          from: 0,
          to: end,
          wraps: true,
          tail: true,
        });
    }
  });
  return out;
}

/* ── the union the daemon will not compute ────────────────────────────── */

/**
 * The union of a set of windows, as windows.
 *
 * This is a GUI promise and not a daemon one. `canonicalWindows` in the
 * schedules route dedupes and week-orders `days` and merges NOTHING: two
 * windows that overlap are stored as two overlapping windows. An editor
 * that drew them as two bars stacked on one another would be drawing the
 * STORAGE rather than the behaviour, and the behaviour is what the operator
 * is deciding about.
 *
 * The week is rasterised to its 10,080 minutes and the maximal runs are read
 * back off it. That is not the clever algorithm; it is the one whose
 * correctness is obvious, and the week is small. Two properties fall out of
 * it for free and both matter:
 *
 *  - the timeline is a CIRCLE, so a Sunday-night window merges into Monday
 *    morning exactly as a Friday-night one merges into Saturday;
 *  - a run longer than a day is expressed in the only vocabulary the schema
 *    has — a head to midnight, whole days, and a tail — because nothing in
 *    `ScheduleWindow` can say "Monday 09:00 until Wednesday 17:00".
 *
 * Windows it cannot read are dropped rather than guessed at.
 */
export function mergeWindows(
  windows: readonly ScheduleWindowPayload[],
): ScheduleWindowPayload[] {
  const marks = new Uint8Array(MINUTES_PER_WEEK);
  let marked = 0;
  for (const window of windows) {
    const start = minutesOf(window.start);
    const end = minutesOf(window.end);
    if (start === null || end === null) continue;
    const days = orderedDays(window.days);
    if (days.length === 0) continue;
    const span = end > start ? end - start : MINUTES_PER_DAY - start + end;
    for (const day of days) {
      const base = WEEK.indexOf(day) * MINUTES_PER_DAY + start;
      for (let step = 0; step < span; step += 1) {
        const at = (base + step) % MINUTES_PER_WEEK;
        if (marks[at] === 0) {
          marks[at] = 1;
          marked += 1;
        }
      }
    }
  }
  if (marked === 0) return [];

  // Maximal runs on the circle. Scanning from the minute after a gap is what
  // makes a run that straddles the week's own boundary come out whole.
  const runs: { start: number; length: number }[] = [];
  if (marked === MINUTES_PER_WEEK) runs.push({ start: 0, length: marked });
  else {
    let origin = 0;
    while (marks[origin] === 1) origin += 1;
    let scanned = 0;
    while (scanned < MINUTES_PER_WEEK) {
      const at = (origin + 1 + scanned) % MINUTES_PER_WEEK;
      if (marks[at] === 0) {
        scanned += 1;
        continue;
      }
      let length = 0;
      while (
        length < MINUTES_PER_WEEK &&
        marks[(at + length) % MINUTES_PER_WEEK] === 1
      )
        length += 1;
      runs.push({ start: at, length });
      scanned += length;
    }
  }

  // Runs, cut into pieces one day can hold. A piece that reaches the end of
  // a day closes at `00:00`, which is the daemon's spelling for it.
  const groups: { start: number; end: number; days: Weekday[] }[] = [];
  for (const run of runs) {
    let at = run.start;
    let left = run.length;
    while (left > 0) {
      const day = WEEK[Math.floor(at / MINUTES_PER_DAY) % 7];
      const local = at % MINUTES_PER_DAY;
      // A run that fits in a day is ONE window even when it crosses a
      // midnight: `end <= start` is the schema's own spelling for that, and
      // splitting it would hand back two windows where the operator drew
      // one. Only a run LONGER than a day has to be spelled as pieces,
      // because nothing in `ScheduleWindow` can say "until Wednesday".
      const chunk = left <= MINUTES_PER_DAY ? left : MINUTES_PER_DAY - local;
      if (day !== undefined) {
        const start = local;
        const end = (local + chunk) % MINUTES_PER_DAY;
        const found = groups.find((g) => g.start === start && g.end === end);
        if (found === undefined) groups.push({ start, end, days: [day] });
        else found.days.push(day);
      }
      at = (at + chunk) % MINUTES_PER_WEEK;
      left -= chunk;
    }
  }
  return groups.map((group) => ({
    days: orderedDays(group.days),
    start: hhmmOf(group.start),
    end: hhmmOf(group.end),
  }));
}

/* ── what the form can be sure of on its own ──────────────────────────── */

/** The three fields this editor writes. */
export interface ScheduleValue {
  readonly name: string;
  readonly timezone: string;
  readonly windows: readonly ScheduleWindowPayload[];
}

/**
 * Deliberately INCOMPLETE, and the incompleteness is the point.
 *
 * The daemon runs zod 4.5.4 and its wording is the wording the operator
 * should read; `store/schedule.ts` lifts it off the 400 and it merges
 * FIRST-WINS ahead of this list. A second, fuller validation vocabulary here
 * would drift from the one that actually decides — the first time the daemon
 * bumped zod, the operator would be told two different things about the same
 * field and only one of them would be true.
 *
 * So this names only what the form can be certain of without asking: a
 * schedule with no name, and a window that names no day. `timezone` is
 * absent on purpose. The daemon is the only thing that knows which zones
 * this build's ICU can project into, and it says so as `invalid-timezone`.
 */
export function scheduleProblems(value: ScheduleValue): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (value.name.trim() === '')
    out.push({ path: 'name', message: 'A SCHEDULE NEEDS A NAME' });
  value.windows.forEach((window, index) => {
    if (orderedDays(window.days).length === 0)
      out.push({
        path: `windows.${index}.days`,
        message: 'PICK AT LEAST ONE DAY',
      });
  });
  return out;
}

/**
 * The zone this DEVICE is in, which is almost never the schedule's.
 *
 * Read once by the composition root and handed down, so that the banner
 * saying "these windows are not in your zone" is a prop like any other. It
 * reads a zone and never an instant: nothing about it can make a screen
 * move on its own.
 */
export function hostZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * What the RUNTIME calls a zone, which is not always what the schedule does.
 *
 * The tz database carries decades of renames as LINKS, and ICU resolves
 * every link to one canonical name: a schedule stored under the modern
 * spelling of a zone comes back out of `Intl` under the older one this build
 * happens to canonicalise to. Two spellings of the same zone are the same
 * zone, and an editor that compared them as strings would raise "these
 * windows are not in your zone" over a device that is in exactly that zone —
 * the precise class of lie this screen exists not to tell.
 *
 * So comparisons go through here, and DISPLAY does not: the operator is
 * shown what is stored, and only the question "are these the same place"
 * is asked of the runtime.
 *
 * A zone this build cannot resolve is returned unchanged. Deciding a zone is
 * invalid is the daemon's job (`invalid-timezone`), not this module's.
 */
export function canonicalZone(zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

/**
 * Window math (s6-execution Part 2 Scenario 2, §1.7).
 *
 * One question, asked once: *what wall-clock time is it, in the schedule's
 * zone, at this instant?* Everything else is arithmetic on the answer.
 *
 * The engine is `Intl.DateTimeFormat(zone, {...}).formatToParts()`, an
 * ECMA-402 global. There is no import statement here at all beyond core's
 * own types, so INV-1 ("core has zero package deps") is untouched and
 * `core-no-unresolvable-imports` has nothing to see (F-57). No `Temporal`
 * (not stable in Node 22), no vendored tz-data, no dependency.
 *
 * Deciding in projected space is not a workaround for the missing library;
 * it is the better model, because the DST answers FALL OUT of the
 * projection instead of being coded:
 *
 *   spring forward   no instant projects into the skipped hour, so a window
 *                    opening inside the gap begins arming at the gap's end
 *   fall back        both occurrences project to the same wall clock, so
 *                    both arm — a person expecting a reply at 01:30 that
 *                    night expects one twice
 *   gap-only window  arms for zero minutes that day, deliberately: clamping
 *                    it to 03:00 would fire a rule at a time the operator
 *                    never wrote down
 *
 * The host's zone is not merely outranked by the schedule's, it is never
 * read: `process.env.TZ` has no path into any function below. T-9.5
 * (`packages/core/test/dst-window.spec.ts`) runs its whole suite twice under
 * two different host zones with byte-identical expectations to prove it.
 *
 * Every read here is FAIL-CLOSED (§2.4.2): an unknown zone, a malformed
 * `HH:MM`, a disabled schedule and an empty window list all mean NOT armed.
 * Nothing in this module throws.
 */
import type {
  IsoUtc,
  Schedule,
  ScheduleWindow,
  Weekday,
} from '../domain/types.js';

/** A UTC instant projected into a zone: the only fact arming depends on. */
export interface ZonedProjection {
  day: Weekday;
  /** Minute of the local day, 0..1439. */
  minutes: number;
}

export type TimezoneValidation =
  { ok: true } | { ok: false; error: 'invalid-timezone' };

export type WindowValidation =
  | { ok: true }
  | { ok: false; error: 'invalid-window'; field: 'days' | 'start' | 'end' };

const MINUTE_MS = 60_000;

/**
 * Scan horizon for `nextWindowOpen` / `windowCloseAfter`. Windows repeat
 * weekly, so eight days covers "the same window next week" plus the extra
 * hour a fall-back inserts. A schedule armed for the whole horizon reports
 * `null`, which is the honest answer: there is no close to count down to.
 */
const MAX_SCAN_MINUTES = 8 * 24 * 60;

const WEEKDAY_BY_SHORT_NAME: Readonly<Record<string, Weekday>> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const WEEK_ORDER: readonly Weekday[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

/**
 * One `Intl.DateTimeFormat` per zone. Constructing a formatter is the
 * expensive part; `formatToParts` on a cached one is cheap enough that the
 * minute-resolution scans below stay well under a frame.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const cached = FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  let made: Intl.DateTimeFormat | null = null;
  try {
    made = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    // RangeError for an unknown IANA zone. Caught here so no caller of
    // `isArmed` has to defend itself: an unreadable zone is not armed.
    made = null;
  }
  FORMATTERS.set(timezone, made);
  return made;
}

/** `true` when the string names an IANA zone this runtime can project into. */
export function validateTimezone(timezone: string): TimezoneValidation {
  if (formatterFor(timezone) === null) {
    return { ok: false, error: 'invalid-timezone' };
  }
  return { ok: true };
}

/** Strict `HH:MM`, 00:00–23:59. Minute of the local day, or `null`. */
function parseHhMm(value: string): number | null {
  if (!/^[0-9]{2}:[0-9]{2}$/.test(value)) return null;
  const hours = Number(value.slice(0, 2));
  const minutes = Number(value.slice(3, 5));
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** §1.6: a malformed `HH:MM` or an empty `days[]` is `invalid-window`. */
export function validateWindow(window: ScheduleWindow): WindowValidation {
  if (window.days.length === 0) {
    return { ok: false, error: 'invalid-window', field: 'days' };
  }
  if (parseHhMm(window.start) === null) {
    return { ok: false, error: 'invalid-window', field: 'start' };
  }
  if (parseHhMm(window.end) === null) {
    return { ok: false, error: 'invalid-window', field: 'end' };
  }
  return { ok: true };
}

/**
 * Project a UTC instant into a zone's wall clock. `null` when the instant
 * or the zone is unreadable — never a throw, and never a fallback to the
 * host zone, which would be the one wrong answer that looks right locally.
 */
export function projectToZone(
  nowIso: IsoUtc,
  timezone: string,
): ZonedProjection | null {
  const formatter = formatterFor(timezone);
  if (formatter === null) return null;
  const at = new Date(nowIso);
  if (Number.isNaN(at.getTime())) return null;

  let day: Weekday | undefined;
  let hour: number | undefined;
  let minute: number | undefined;
  for (const part of formatter.formatToParts(at)) {
    if (part.type === 'weekday') day = WEEKDAY_BY_SHORT_NAME[part.value];
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  if (day === undefined || hour === undefined || minute === undefined) {
    return null;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // `hour12: false` resolves to the h23 cycle on every ICU this project
  // supports, but older ICU builds render local midnight as "24" under the
  // h24 cycle. Folding it costs one modulo and removes a class of
  // once-a-day, host-dependent wrongness.
  return { day, minutes: (hour % 24) * 60 + minute };
}

function previousDay(day: Weekday): Weekday {
  const index = WEEK_ORDER.indexOf(day);
  return WEEK_ORDER[(index + WEEK_ORDER.length - 1) % WEEK_ORDER.length] ?? day;
}

/**
 * Membership for one window. The day is matched against the window's START
 * day, which is what makes a Friday 22:00–02:00 window arm until Saturday
 * 02:00 without a Saturday entry in `days`.
 *
 * `end <= start` wraps midnight (§1.7). Equality therefore describes a
 * 24-hour window opening at `start`, which is the reading that keeps the
 * wrap rule a single comparison.
 */
function windowArmed(window: ScheduleWindow, at: ZonedProjection): boolean {
  if (validateWindow(window).ok !== true) return false;
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === null || end === null) return false;

  if (end > start) {
    return (
      window.days.includes(at.day) && at.minutes >= start && at.minutes < end
    );
  }
  // Wrapped: the tail belongs to the start day, the head to the day after.
  if (window.days.includes(at.day) && at.minutes >= start) return true;
  return window.days.includes(previousDay(at.day)) && at.minutes < end;
}

/**
 * Is autonomy's window open at this instant? A schedule is armed when ANY
 * of its windows is (union semantics). A disabled schedule and a schedule
 * with no windows are never armed — the fail-closed reading, never the
 * "no constraints, so always" one.
 */
export function isArmed(schedule: Schedule, nowIso: IsoUtc): boolean {
  if (!schedule.enabled) return false;
  if (schedule.windows.length === 0) return false;
  const at = projectToZone(nowIso, schedule.timezone);
  if (at === null) return false;
  return schedule.windows.some((window) => windowArmed(window, at));
}

function floorToMinute(nowIso: IsoUtc): number | null {
  const ms = Date.parse(nowIso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant the currently-armed window ends, or `null` when nothing is
 * armed. Minute-resolution forward scan in projected space: DST is handled
 * because the projection handles it, so a window that gains or loses an
 * hour to a transition reports the close an operator's clock would show.
 */
export function windowCloseAfter(
  schedule: Schedule,
  nowIso: IsoUtc,
): IsoUtc | null {
  if (!isArmed(schedule, nowIso)) return null;
  const floor = floorToMinute(nowIso);
  if (floor === null) return null;
  for (let step = 1; step <= MAX_SCAN_MINUTES; step += 1) {
    const at = new Date(floor + step * MINUTE_MS).toISOString();
    if (!isArmed(schedule, at)) return at;
  }
  return null;
}

/**
 * The next instant at which the schedule TRANSITIONS to armed, or `null`
 * when it can never arm. Called from inside an armed window it reports the
 * opening after this one closes, never the instant the caller is standing
 * on: "next" is a countdown target, and a countdown to now is not one.
 */
export function nextWindowOpen(
  schedule: Schedule,
  nowIso: IsoUtc,
): IsoUtc | null {
  if (!schedule.enabled) return null;
  if (schedule.windows.length === 0) return null;
  const floor = floorToMinute(nowIso);
  if (floor === null) return null;

  let seenClosed = !isArmed(schedule, nowIso);
  for (let step = 0; step <= MAX_SCAN_MINUTES; step += 1) {
    const at = new Date(floor + step * MINUTE_MS).toISOString();
    if (isArmed(schedule, at)) {
      if (seenClosed) return at;
    } else {
      seenClosed = true;
    }
  }
  return null;
}

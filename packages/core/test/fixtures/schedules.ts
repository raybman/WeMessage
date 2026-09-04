/**
 * s6-execution Part 3 — synthetic schedules for Scenario 2's window math.
 *
 * Every zone in this file is one of the five pinned by `test/arch.spec.ts`
 * row (f), and each is here for a DST or offset *shape*, never because
 * anyone lives there:
 *
 *   America/Los_Angeles  whole-hour DST, northern hemisphere (gap + fold)
 *   Pacific/Chatham      +12:45/+13:45, southern hemisphere (quarter-hour DST)
 *   Asia/Kolkata         +05:30 fixed (half-hour offset, no DST)
 *   UTC / Australia/Lord_Howe   host zones only (see dst-window.spec.ts)
 *
 * The zone literals live in exactly one module so that a future fixture
 * cannot smuggle a sixth zone past review by spelling it inline.
 */
import type { Schedule, ScheduleWindow, Weekday } from '@wemessage/core';

export const PINNED_ZONES = {
  utc: 'UTC',
  losAngeles: 'America/Los_Angeles',
  lordHowe: 'Australia/Lord_Howe',
  chatham: 'Pacific/Chatham',
  kolkata: 'Asia/Kolkata',
} as const;

export const EVERY_DAY: readonly Weekday[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

export function makeSchedule(
  id: string,
  name: string,
  timezone: string,
  windows: ScheduleWindow[],
  enabled = true,
): Schedule {
  return { id, name, timezone, windows, enabled };
}

/** mon–fri 09:00–17:00 — the ordinary case. */
export const businessHours = makeSchedule(
  '01SCHEDBIZ',
  'business-hours',
  PINNED_ZONES.losAngeles,
  [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }],
);

/** Spec row 1's "plain window": a single day, so day membership is testable. */
export const mondayOnly = makeSchedule(
  '01SCHEDMON',
  'monday-only',
  PINNED_ZONES.losAngeles,
  [{ days: ['mon'], start: '09:00', end: '17:00' }],
);

/** Row 1's day-flip probe: not armed Sunday 23:59, armed one minute later. */
export const mondayFirstHour = makeSchedule(
  '01SCHEDMON1',
  'monday-first-hour',
  PINNED_ZONES.losAngeles,
  [{ days: ['mon'], start: '00:00', end: '01:00' }],
);

/** fri 22:00–02:00 — one window that wraps midnight; no 'sat' entry. */
export const nightOwl = makeSchedule(
  '01SCHEDNIGHT',
  'night-owl',
  PINNED_ZONES.losAngeles,
  [{ days: ['fri'], start: '22:00', end: '02:00' }],
);

/** T-9.5 row 1: opens *inside* the spring-forward gap, closes after it. */
export const springOpen = makeSchedule(
  '01SCHEDSPRINGOPEN',
  'spring-open',
  PINNED_ZONES.losAngeles,
  [{ days: ['sun'], start: '02:30', end: '04:00' }],
);

/** T-9.5 row 2: lives entirely inside the spring-forward gap. */
export const springGap = makeSchedule(
  '01SCHEDSPRINGGAP',
  'spring-gap',
  PINNED_ZONES.losAngeles,
  [{ days: ['sun'], start: '02:15', end: '02:45' }],
);

/** T-9.5 row 3: the repeated hour on fall-back Sunday. */
export const fallFold = makeSchedule(
  '01SCHEDFALLFOLD',
  'fall-fold',
  PINNED_ZONES.losAngeles,
  [{ days: ['sun'], start: '01:00', end: '02:00' }],
);

/** Half-hour offset, no DST: proves :30 boundaries are honoured. */
export const halfOffset = makeSchedule(
  '01SCHEDHALF',
  'half-offset',
  PINNED_ZONES.kolkata,
  [{ days: [...EVERY_DAY], start: '09:00', end: '09:30' }],
);

/** T-9.5 row 6: spans Chatham's quarter-hour southern-hemisphere shift. */
export const antipodean = makeSchedule(
  '01SCHEDANTI',
  'antipodean',
  PINNED_ZONES.chatham,
  [{ days: [...EVERY_DAY], start: '01:30', end: '03:30' }],
);

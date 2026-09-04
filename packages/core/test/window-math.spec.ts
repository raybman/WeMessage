/**
 * s6-execution Part 2 Scenario 2 — window math in core.
 *
 * `packages/core/src/schedule/index.ts` answers one question, asked once:
 * *what wall-clock time is it, in the schedule's zone, at this instant?*
 * Everything else (half-open boundaries, midnight wrap, union, fail-closed
 * reads) is arithmetic on that projection. The DST consequences of the same
 * projection are pinned separately by `dst-window.spec.ts` (T-9.5).
 *
 * Pure core, no I/O, no clock: every row states an explicit UTC instant and
 * the schedule that has to be judged against it.
 */
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@wemessage/core';
import {
  isArmed,
  nextWindowOpen,
  projectToZone,
  validateTimezone,
  validateWindow,
  windowCloseAfter,
} from '@wemessage/core';
import {
  businessHours,
  EVERY_DAY,
  halfOffset,
  makeSchedule,
  mondayFirstHour,
  mondayOnly,
  nightOwl,
  PINNED_ZONES,
} from './fixtures/schedules.js';

// Every instant below was verified against the projection it names; the
// comment is the wall clock in the schedule's own zone, never the host's.
const MON_0900 = '2027-09-06T16:00:00.000Z'; // Mon 09:00 America/Los_Angeles
const MON_1659 = '2027-09-06T23:59:00.000Z'; // Mon 16:59
const MON_1700 = '2027-09-07T00:00:00.000Z'; // Mon 17:00
const SUN_2359 = '2027-09-06T06:59:00.000Z'; // Sun 23:59
const MON_0000 = '2027-09-06T07:00:00.000Z'; // Mon 00:00
const THU_2300 = '2027-09-03T06:00:00.000Z'; // Thu 23:00
const FRI_2200 = '2027-09-04T05:00:00.000Z'; // Fri 22:00
const FRI_2300 = '2027-09-04T06:00:00.000Z'; // Fri 23:00
const FRI_2359 = '2027-09-04T06:59:00.000Z'; // Fri 23:59
const SAT_0000 = '2027-09-04T07:00:00.000Z'; // Sat 00:00
const SAT_0159 = '2027-09-04T08:59:00.000Z'; // Sat 01:59
const SAT_0200 = '2027-09-04T09:00:00.000Z'; // Sat 02:00
const SAT_0500 = '2027-09-04T12:00:00.000Z'; // Sat 05:00
const NEXT_FRI_2200 = '2027-09-11T05:00:00.000Z'; // Fri 22:00, one week on

describe('isArmed — plain window (s6 Sc 2 row 1)', () => {
  it('is half-open on [start, end) at the boundary minutes', () => {
    expect(isArmed(mondayOnly, MON_0900)).toBe(true);
    expect(isArmed(mondayOnly, MON_1659)).toBe(true);
    expect(isArmed(mondayOnly, MON_1700)).toBe(false);
  });

  it('matches the projected day, not the UTC day', () => {
    // 2027-09-06T16:00Z is a Monday in both zones; 2027-09-07T00:00Z is
    // already Tuesday in UTC while still Monday 17:00 in the schedule's.
    expect(isArmed(mondayOnly, SUN_2359)).toBe(false);
    expect(isArmed(mondayOnly, MON_0000)).toBe(false);
    expect(isArmed(mondayOnly, MON_0900)).toBe(true);
  });

  it('flips at local midnight: not armed Sunday 23:59, armed one minute later', () => {
    expect(isArmed(mondayFirstHour, SUN_2359)).toBe(false);
    expect(isArmed(mondayFirstHour, MON_0000)).toBe(true);
  });
});

describe('isArmed — midnight wrap is ONE window (s6 Sc 2 row 2)', () => {
  it('arms from the start day into the following morning', () => {
    expect(isArmed(nightOwl, FRI_2200)).toBe(true);
    expect(isArmed(nightOwl, FRI_2359)).toBe(true);
    expect(isArmed(nightOwl, SAT_0000)).toBe(true);
    expect(isArmed(nightOwl, SAT_0159)).toBe(true);
  });

  it('closes at the wrapped end and never arms the day before', () => {
    expect(isArmed(nightOwl, SAT_0200)).toBe(false);
    expect(isArmed(nightOwl, THU_2300)).toBe(false);
  });

  it('needs no Saturday entry: the day is matched against the START day', () => {
    expect(nightOwl.windows[0]?.days).toEqual(['fri']);
  });
});

describe('isArmed — union and emptiness (s6 Sc 2 rows 3 and 4)', () => {
  const overlapping = makeSchedule(
    '01SCHEDUNION',
    'overlapping',
    PINNED_ZONES.losAngeles,
    [
      { days: ['mon'], start: '09:00', end: '12:00' },
      { days: ['mon'], start: '11:00', end: '15:00' },
    ],
  );
  const MON_1130 = '2027-09-06T18:30:00.000Z'; // Mon 11:30
  const MON_1459 = '2027-09-06T21:59:00.000Z'; // Mon 14:59
  const MON_1500 = '2027-09-06T22:00:00.000Z'; // Mon 15:00

  it('arms the union of overlapping windows', () => {
    expect(isArmed(overlapping, MON_0900)).toBe(true);
    expect(isArmed(overlapping, MON_1130)).toBe(true);
    expect(isArmed(overlapping, MON_1459)).toBe(true);
    expect(isArmed(overlapping, MON_1500)).toBe(false);
  });

  it('is never armed with no windows at all', () => {
    const empty = makeSchedule(
      '01SCHEDEMPTY',
      'empty',
      PINNED_ZONES.losAngeles,
      [],
    );
    expect(isArmed(empty, MON_0900)).toBe(false);
    expect(isArmed(empty, SAT_0200)).toBe(false);
  });

  it('is never armed when disabled (fail-closed, §2.4.2)', () => {
    const off: Schedule = { ...mondayOnly, enabled: false };
    expect(isArmed(off, MON_0900)).toBe(false);
  });

  it('does not accept a null schedule: the caller owns "always armed"', () => {
    // Type-level row (s6 Sc 2 RED row 4): a null schedule means "no
    // schedule", which is the rule's business (a null `rule.scheduleId` is
    // always armed), never the evaluator's. The probe is never invoked —
    // tsc checks its body, vitest's typecheck mode enforces the directive,
    // and nothing here depends on what a null would do at runtime.
    // @ts-expect-error — isArmed(null, ...) must not compile
    const probe = (): boolean => isArmed(null, MON_0900);
    expect(typeof probe).toBe('function');
  });
});

describe('timezone validation and half-hour offsets (s6 Sc 2 row 5)', () => {
  it('returns an error for an unknown zone instead of throwing', () => {
    expect(() => validateTimezone('Not/AZone')).not.toThrow();
    expect(validateTimezone('Not/AZone')).toEqual({
      ok: false,
      error: 'invalid-timezone',
    });
    expect(validateTimezone('')).toEqual({
      ok: false,
      error: 'invalid-timezone',
    });
  });

  it('accepts the pinned half-hour-offset zone', () => {
    expect(validateTimezone(PINNED_ZONES.kolkata)).toEqual({ ok: true });
    expect(validateTimezone(PINNED_ZONES.utc)).toEqual({ ok: true });
  });

  it('arms correctly at :30 boundaries in a half-hour-offset zone', () => {
    expect(isArmed(halfOffset, '2027-09-06T03:30:00.000Z')).toBe(true); // 09:00
    expect(isArmed(halfOffset, '2027-09-06T03:59:00.000Z')).toBe(true); // 09:29
    expect(isArmed(halfOffset, '2027-09-06T04:00:00.000Z')).toBe(false); // 09:30
  });

  it('is never armed on an unreadable zone, and never throws out of the module', () => {
    const broken = makeSchedule('01SCHEDBAD', 'broken', 'Not/AZone', [
      { days: [...EVERY_DAY], start: '00:00', end: '23:59' },
    ]);
    expect(() => isArmed(broken, MON_0900)).not.toThrow();
    expect(isArmed(broken, MON_0900)).toBe(false);
    expect(projectToZone(MON_0900, 'Not/AZone')).toBeNull();
  });
});

describe('windowCloseAfter / nextWindowOpen (s6 Sc 2 row 6)', () => {
  it('reports the close of the window that is armed right now', () => {
    expect(windowCloseAfter(businessHours, MON_0900)).toBe(MON_1700);
  });

  it('reports the close across a midnight wrap', () => {
    expect(windowCloseAfter(nightOwl, FRI_2300)).toBe(SAT_0200);
    expect(windowCloseAfter(nightOwl, FRI_2200)).toBe(SAT_0200);
    expect(windowCloseAfter(nightOwl, SAT_0159)).toBe(SAT_0200);
  });

  it('reports null when nothing is armed', () => {
    expect(windowCloseAfter(nightOwl, SAT_0500)).toBeNull();
    expect(windowCloseAfter(mondayOnly, SUN_2359)).toBeNull();
  });

  it('reports the next opening across a wrap, from inside and from outside', () => {
    expect(nextWindowOpen(nightOwl, SAT_0500)).toBe(NEXT_FRI_2200);
    // From inside the current run: autonomy is armed now, so "next" is the
    // opening after this one closes, never the instant we are standing on.
    expect(nextWindowOpen(nightOwl, FRI_2300)).toBe(NEXT_FRI_2200);
  });

  it('reports null when the schedule can never arm', () => {
    const empty = makeSchedule(
      '01SCHEDEMPTY2',
      'empty',
      PINNED_ZONES.losAngeles,
      [],
    );
    const off: Schedule = { ...nightOwl, enabled: false };
    expect(nextWindowOpen(empty, SAT_0500)).toBeNull();
    expect(nextWindowOpen(off, SAT_0500)).toBeNull();
    expect(windowCloseAfter(off, FRI_2300)).toBeNull();
  });
});

describe('validateWindow (s6 Sc 2 row 7)', () => {
  it('accepts a well-formed window', () => {
    expect(
      validateWindow({ days: ['mon'], start: '09:00', end: '17:00' }),
    ).toEqual({ ok: true });
    expect(
      validateWindow({ days: ['fri'], start: '22:00', end: '02:00' }),
    ).toEqual({ ok: true });
  });

  it.each([
    ['9:00', 'start'],
    ['25:00', 'start'],
    ['', 'start'],
    ['09:60', 'start'],
    ['0900', 'start'],
  ] as const)('rejects a malformed start %j on field %s', (start, field) => {
    expect(validateWindow({ days: ['mon'], start, end: '17:00' })).toEqual({
      ok: false,
      error: 'invalid-window',
      field,
    });
  });

  it('discriminates a malformed end from a malformed start', () => {
    expect(
      validateWindow({ days: ['mon'], start: '09:00', end: '25:00' }),
    ).toEqual({ ok: false, error: 'invalid-window', field: 'end' });
  });

  it('rejects an empty days[]', () => {
    expect(validateWindow({ days: [], start: '09:00', end: '17:00' })).toEqual({
      ok: false,
      error: 'invalid-window',
      field: 'days',
    });
  });
});

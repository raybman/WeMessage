/**
 * s8-execution Scenario 11 — the schedule editor's arithmetic, without a DOM.
 *
 * A schedule editor is a DST trap wearing a grid, and the trap has a
 * specific shape: the daemon decides whether a window is open using
 * `packages/core/src/schedule`, and the renderer draws a rectangle. Those
 * are two implementations of "what time is it there", and the renderer
 * physically cannot call the first one — `apps/desktop/package.json` does
 * not depend on `@wemessage/core`, and `test/arch.spec.ts` now says so out
 * loud. So the second one has to be right on its own, and the only way it
 * is right on its own is if it is tested against the SAME pinned instants
 * the core suite uses.
 *
 * Those instants are lifted from `packages/core/test/dst-window.spec.ts`
 * deliberately, not re-derived:
 *
 *  - **2027-03-14, America/Los_Angeles.** 02:00 becomes 03:00. Local minutes
 *    120–179 do not exist. A window that opens at 02:30 opens at 03:00
 *    instead; a window that opens at 02:15 and closes at 02:45 opens for
 *    ZERO minutes, because clamping it to 03:00 would fire a rule at a time
 *    the operator never wrote down.
 *  - **2027-11-07, America/Los_Angeles.** 02:00 becomes 01:00. Local minutes
 *    60–119 happen twice, and both arm, because a person expecting a reply
 *    at 01:30 that night expects one twice.
 *  - **2027-10-03 and 2027-04-04, Australia/Lord_Howe.** The same two
 *    events with a THIRTY minute shift, which is the case that catches an
 *    implementation that hard-coded an hour.
 *
 * Zones are drawn from the five this repo pins (`test/arch.spec.ts` row (f)),
 * chosen for DST shapes rather than for anybody's location.
 *
 * The other half of this file is `mergeWindows`, which is a GUI promise and
 * not a daemon one: `canonicalWindows` in the schedules route dedupes and
 * week-orders `days` and merges NOTHING. Two windows that overlap are
 * stored as two overlapping windows, and an editor that drew them as two
 * bars stacked on one another would be drawing the storage rather than the
 * behaviour. The union is computed here, sent as the PATCH body, and the
 * e2e proves the wire carries it.
 */
import { describe, expect, it } from 'vitest';
import type { ScheduleWindowPayload } from '@wemessage/client';
import {
  WEEK,
  blocksOf,
  canonicalZone,
  dayShift,
  hhmmOf,
  mergeWindows,
  minutesOf,
  noteTitle,
  nowInZone,
  scheduleProblems,
  snapTo15,
  weekOf,
  windowNote,
  zoneOffsetMinutes,
} from '../../src/renderer/derive/projectWindow.js';

const LA = 'America/Los_Angeles';
const LORD_HOWE = 'Australia/Lord_Howe';
const KOLKATA = 'Asia/Kolkata';
const UTC = 'UTC';

function win(
  days: ScheduleWindowPayload['days'],
  start: string,
  end: string,
): ScheduleWindowPayload {
  return { days, start, end };
}

describe('HH:MM, both ways', () => {
  it('parses only a real 24-hour wall clock', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('09:30')).toBe(570);
    expect(minutesOf('23:59')).toBe(1439);
    for (const bad of ['24:00', '9:30', '09:60', '0930', '', '09:3o'])
      expect(minutesOf(bad), bad).toBeNull();
  });

  it('renders minutes back, zero-padded', () => {
    expect(hhmmOf(0)).toBe('00:00');
    expect(hhmmOf(570)).toBe('09:30');
    expect(hhmmOf(1439)).toBe('23:59');
    // 1440 is midnight at the FAR end of a day. A block that closes there
    // is not a block that closes at the start of the same day.
    expect(hhmmOf(1440)).toBe('24:00');
  });

  it('snaps a dragged edge to the quarter hour', () => {
    expect(snapTo15(0)).toBe(0);
    expect(snapTo15(7)).toBe(0);
    expect(snapTo15(8)).toBe(15);
    expect(snapTo15(532)).toBe(525);
    expect(snapTo15(1439)).toBe(1440);
  });
});

describe('projection into the schedule`s own zone', () => {
  it('reads the zone it is given, and never the host`s', () => {
    const at = '2027-03-14T18:30:00.000Z';
    expect(zoneOffsetMinutes(at, UTC)).toBe(0);
    expect(zoneOffsetMinutes(at, KOLKATA)).toBe(330);
    expect(zoneOffsetMinutes(at, LA)).toBe(-420);
    // The host zone is a different answer from all three, and appears in
    // none of them. `process.env.TZ` has no path into this module.
    expect(zoneOffsetMinutes(at, 'Mars/Olympus')).toBeNull();
  });

  it('places an instant on a local day and a local minute', () => {
    // 18:30Z on a Sunday in March is 11:30 the same Sunday in LA…
    expect(nowInZone('2027-03-14T18:30:00.000Z', LA)).toEqual({
      date: '2027-03-14',
      day: 'sun',
      minutes: 690,
    });
    // …and midnight-and-a-bit on the MONDAY in Kolkata, which is the whole
    // reason the marker is labelled with the zone it was projected into.
    expect(nowInZone('2027-03-14T18:30:00.000Z', KOLKATA)).toEqual({
      date: '2027-03-15',
      day: 'mon',
      minutes: 0,
    });
    expect(nowInZone('nonsense', LA)).toBeNull();
  });

  it('a week starts on Monday and contains the instant', () => {
    const week = weekOf('2027-03-14T18:30:00.000Z', LA);
    expect(week.map((d) => d.day)).toEqual([...WEEK]);
    expect(week.map((d) => d.date)).toEqual([
      '2027-03-08',
      '2027-03-09',
      '2027-03-10',
      '2027-03-11',
      '2027-03-12',
      '2027-03-13',
      '2027-03-14',
    ]);
    expect(week[6]?.shift?.minutes).toBe(60);
    expect(week.filter((d) => d.shift !== null)).toHaveLength(1);
  });
});

describe('the two days a year the grid is not 7x24', () => {
  it('spring forward: an hour of Sunday does not exist', () => {
    const shift = dayShift('2027-03-14', LA);
    expect(shift).toEqual({
      minutes: 60,
      from: 120,
      to: 180,
      dayMinutes: 1380,
    });
  });

  it('fall back: an hour of Sunday happens twice', () => {
    const shift = dayShift('2027-11-07', LA);
    expect(shift).toEqual({
      minutes: -60,
      from: 60,
      to: 120,
      dayMinutes: 1500,
    });
  });

  it('an ordinary day shifts by nothing at all', () => {
    expect(dayShift('2027-03-13', LA)).toBeNull();
    expect(dayShift('2027-11-08', LA)).toBeNull();
    expect(dayShift('2027-03-14', UTC)).toBeNull();
    expect(dayShift('2027-03-14', KOLKATA)).toBeNull();
  });

  it('a half-hour shift is half an hour, not an assumed one', () => {
    expect(dayShift('2027-10-03', LORD_HOWE)).toEqual({
      minutes: 30,
      from: 120,
      to: 150,
      dayMinutes: 1410,
    });
    expect(dayShift('2027-04-04', LORD_HOWE)).toEqual({
      minutes: -30,
      from: 90,
      to: 120,
      dayMinutes: 1470,
    });
  });

  it('an unreadable zone shifts by nothing rather than throwing', () => {
    expect(dayShift('2027-03-14', 'Mars/Olympus')).toBeNull();
    expect(dayShift('not-a-date', LA)).toBeNull();
  });
});

describe('what the editor says about a window on one of those days', () => {
  const spring = dayShift('2027-03-14', LA);
  const fall = dayShift('2027-11-07', LA);

  it('a window that only exists inside the gap opens for zero minutes', () => {
    // `springGap`, 02:15–02:45. The core suite samples 360 instants across
    // this day and finds it armed for none of them.
    const note = windowNote(135, 165, spring);
    expect(note.kind).toBe('gap-never');
    expect(note.minutes).toBe(0);
    expect(note.words).toBe('NEVER OPENS');
  });

  it('a window straddling the gap opens late and is shorter', () => {
    // `springOpen`, 02:30–04:00: armed 03:00–04:00, sixty minutes of a
    // ninety-minute window.
    const note = windowNote(150, 240, spring);
    expect(note.kind).toBe('gap-shortened');
    expect(note.minutes).toBe(60);
    expect(note.words).toBe('SHORT BY 30 MIN');
  });

  it('a window over the fold opens twice and is longer', () => {
    // `fallFold`, 01:00–02:00: sixty local minutes, one hundred and twenty
    // real ones.
    const note = windowNote(60, 120, fall);
    expect(note.kind).toBe('fold-twice');
    expect(note.minutes).toBe(120);
    expect(note.words).toBe('RUNS TWICE');
  });

  it('a window nowhere near either has nothing to say', () => {
    for (const shift of [spring, fall, null]) {
      const note = windowNote(540, 1020, shift);
      expect(note.kind).toBe('none');
      expect(note.minutes).toBe(480);
      expect(note.words).toBe('');
    }
  });

  it('the sentence is a length, so half-hour shifts read correctly', () => {
    const howeSpring = dayShift('2027-10-03', LORD_HOWE);
    expect(windowNote(120, 150, howeSpring)).toEqual({
      kind: 'gap-never',
      minutes: 0,
      words: 'NEVER OPENS',
    });
    expect(windowNote(60, 180, howeSpring)).toEqual({
      kind: 'gap-shortened',
      minutes: 90,
      words: 'SHORT BY 30 MIN',
    });
    const howeFall = dayShift('2027-04-04', LORD_HOWE);
    expect(windowNote(60, 180, howeFall)).toEqual({
      kind: 'fold-twice',
      minutes: 150,
      words: 'RUNS TWICE',
    });
  });
});

describe('windows, as rectangles', () => {
  it('a plain window is one block on each day it names', () => {
    expect(blocksOf([win(['mon', 'wed'], '09:00', '17:00')])).toEqual([
      { index: 0, day: 'mon', from: 540, to: 1020, wraps: false, tail: false },
      { index: 0, day: 'wed', from: 540, to: 1020, wraps: false, tail: false },
    ]);
  });

  it('a midnight-wrapping window is one window drawn in two places', () => {
    // Friday 22:00–02:00 is ONE window. It arms until Saturday 02:00
    // without Saturday appearing in `days`, so the Saturday rectangle
    // carries the same index: selecting either selects the window.
    expect(blocksOf([win(['fri'], '22:00', '02:00')])).toEqual([
      { index: 0, day: 'fri', from: 1320, to: 1440, wraps: true, tail: false },
      { index: 0, day: 'sat', from: 0, to: 120, wraps: true, tail: true },
    ]);
  });

  it('the week wraps too: a Sunday window tails onto Monday', () => {
    expect(blocksOf([win(['sun'], '23:00', '01:00')])).toEqual([
      { index: 0, day: 'sun', from: 1380, to: 1440, wraps: true, tail: false },
      { index: 0, day: 'mon', from: 0, to: 60, wraps: true, tail: true },
    ]);
  });

  it('end equal to start is twenty-four hours, per the daemon', () => {
    expect(blocksOf([win(['tue'], '09:00', '09:00')])).toEqual([
      { index: 0, day: 'tue', from: 540, to: 1440, wraps: true, tail: false },
      { index: 0, day: 'wed', from: 0, to: 540, wraps: true, tail: true },
    ]);
  });

  it('a malformed window draws nothing rather than drawing a guess', () => {
    expect(blocksOf([win(['mon'], '9:00', '17:00')])).toEqual([]);
    expect(blocksOf([win([], '09:00', '17:00')])).toEqual([]);
  });
});

describe('the union the daemon will not compute for us', () => {
  it('two overlapping windows on one day become one', () => {
    expect(
      mergeWindows([
        win(['mon'], '09:00', '12:00'),
        win(['mon'], '11:00', '17:00'),
      ]),
    ).toEqual([win(['mon'], '09:00', '17:00')]);
  });

  it('windows that merely touch become one; windows with a gap do not', () => {
    expect(
      mergeWindows([
        win(['mon'], '09:00', '12:00'),
        win(['mon'], '12:00', '17:00'),
      ]),
    ).toEqual([win(['mon'], '09:00', '17:00')]);
    expect(
      mergeWindows([
        win(['mon'], '09:00', '12:00'),
        win(['mon'], '12:01', '17:00'),
      ]),
    ).toEqual([win(['mon'], '09:00', '12:00'), win(['mon'], '12:01', '17:00')]);
  });

  it('identical spans on different days become one entry, week-ordered', () => {
    expect(
      mergeWindows([
        win(['wed'], '09:00', '17:00'),
        win(['mon', 'tue'], '09:00', '17:00'),
        win(['tue'], '09:00', '17:00'),
      ]),
    ).toEqual([win(['mon', 'tue', 'wed'], '09:00', '17:00')]);
  });

  it('a wrap merges across the midnight it crosses', () => {
    expect(
      mergeWindows([
        win(['fri'], '22:00', '02:00'),
        win(['sat'], '01:00', '06:00'),
      ]),
    ).toEqual([win(['fri'], '22:00', '06:00')]);
  });

  it('the week is a circle: Sunday night merges into Monday morning', () => {
    expect(
      mergeWindows([
        win(['sun'], '23:00', '01:00'),
        win(['mon'], '00:30', '03:00'),
      ]),
    ).toEqual([win(['sun'], '23:00', '03:00')]);
  });

  it('a run longer than a day is whole days plus a head and a tail', () => {
    // Nothing in the schema can say "Monday 09:00 until Wednesday 17:00",
    // so the union says it in the only vocabulary the daemon has: a head
    // window that runs to midnight, a full day, and a tail.
    expect(
      mergeWindows([
        win(['mon'], '09:00', '00:00'),
        win(['tue'], '00:00', '00:00'),
        win(['wed'], '00:00', '17:00'),
      ]),
    ).toEqual([
      win(['mon'], '09:00', '00:00'),
      win(['tue'], '00:00', '00:00'),
      win(['wed'], '00:00', '17:00'),
    ]);
  });

  it('a schedule armed all week is seven twenty-four-hour windows', () => {
    expect(
      mergeWindows([
        win([...WEEK], '00:00', '12:00'),
        win([...WEEK], '11:00', '00:00'),
      ]),
    ).toEqual([win([...WEEK], '00:00', '00:00')]);
  });

  it('merging is idempotent, and drops what it cannot read', () => {
    const once = mergeWindows([
      win(['mon'], '09:00', '12:00'),
      win(['mon'], '11:00', '17:00'),
      win(['mon'], '9:00', '17:00'),
    ]);
    expect(once).toEqual([win(['mon'], '09:00', '17:00')]);
    expect(mergeWindows(once)).toEqual(once);
    expect(mergeWindows([])).toEqual([]);
  });
});

describe('what the form complains about before the daemon does', () => {
  /**
   * Deliberately INCOMPLETE. The daemon runs zod 4.5.4 and its wording is
   * the wording the operator should read; `store/schedule.ts#refusalOf`
   * lifts it off the 400 and it merges FIRST-WINS ahead of this list. A
   * second, fuller validation vocabulary here would drift from the one that
   * actually decides, and the operator would be told two different things.
   *
   * So this only names what the form can be sure of without asking: a
   * schedule with no name and a window that names no day. `timezone` is
   * absent on purpose — the daemon is the only thing that knows which zones
   * this build's ICU can project into.
   */
  it('names an empty name and a dayless window, and nothing else', () => {
    expect(
      scheduleProblems({
        name: '   ',
        timezone: 'Mars/Olympus',
        windows: [win([], '09:00', '17:00'), win(['mon'], '9:00', 'x')],
      }),
    ).toEqual([
      { path: 'name', message: 'A SCHEDULE NEEDS A NAME' },
      { path: 'windows.0.days', message: 'PICK AT LEAST ONE DAY' },
    ]);
  });

  it('is silent about a schedule it cannot fault', () => {
    expect(
      scheduleProblems({
        name: 'front desk',
        timezone: 'Mars/Olympus',
        windows: [win(['mon'], '09:00', '17:00')],
      }),
    ).toEqual([]);
  });
});

/**
 * The sentence the operator reads on a DST day.
 *
 * It lives here rather than in the component for one reason: it is the only
 * place in this scenario where the editor makes a claim about what the GATE
 * will do, and a claim like that should be checkable without a browser. The
 * wording is deliberately mechanical — a date, two wall times, and a verb —
 * because the interesting content is the ARITHMETIC, and arithmetic dressed
 * up in prose is arithmetic nobody checks.
 *
 * `packages/core/src/schedule` decides all three outcomes; these sentences
 * only report them. Spring forward: the window arms from the gap's end. A
 * window living entirely inside the gap arms for zero minutes. Fall back:
 * both occurrences arm.
 */
describe('noteTitle', () => {
  const spring = dayShift('2027-03-14', LA);
  const fall = dayShift('2027-11-07', LA);

  it('names the hour that does not exist, and when the window really opens', () => {
    expect(noteTitle(150, 240, spring, '2027-03-14')).toBe(
      '02:30 DOES NOT OCCUR ON 2027-03-14 · ARMS FROM 03:00',
    );
  });

  it('says a window inside the gap never opens, and where the gap is', () => {
    expect(noteTitle(135, 165, spring, '2027-03-14')).toBe(
      'NEVER OPENS ON 2027-03-14 · CLOCKS SKIP 02:00 TO 03:00',
    );
  });

  it('says an hour that repeats runs twice, and which hour', () => {
    expect(noteTitle(60, 120, fall, '2027-11-07')).toBe(
      'RUNS TWICE ON 2027-11-07 · CLOCKS REPEAT 01:00 TO 02:00',
    );
  });

  it('says nothing at all on an ordinary day, or away from the seam', () => {
    // No shift: 363 days a year, and the tooltip is absent rather than
    // reassuring. A note that appears on every block is a note nobody reads.
    expect(noteTitle(540, 1020, null, '2027-06-15')).toBe('');
    expect(noteTitle(540, 1020, spring, '2027-03-14')).toBe('');
    expect(noteTitle(540, 1020, fall, '2027-11-07')).toBe('');
  });

  it('a window shortened from the OTHER end names the length, not a time', () => {
    // 01:00–03:00 on the spring day: the window opens at a wall time that
    // really exists, so "02:00 does not occur" would be answering a question
    // nobody asked. What it lost is the interesting fact.
    expect(noteTitle(60, 180, spring, '2027-03-14')).toBe(
      'SHORT BY 60 MIN ON 2027-03-14 · CLOCKS SKIP 02:00 TO 03:00',
    );
  });

  it('reads the half-hour seams the same way', () => {
    expect(
      noteTitle(140, 300, dayShift('2027-10-03', LORD_HOWE), '2027-10-03'),
    ).toBe('02:20 DOES NOT OCCUR ON 2027-10-03 · ARMS FROM 02:30');
    expect(
      noteTitle(90, 200, dayShift('2027-04-04', LORD_HOWE), '2027-04-04'),
    ).toBe('RUNS TWICE ON 2027-04-04 · CLOCKS REPEAT 01:30 TO 02:00');
  });
});

/* ── the alias trap: one zone, two spellings ──────────────────────────── */

describe('canonicalZone', () => {
  /**
   * The tz database carries its renames as LINKS and ICU resolves every link
   * to one name, which is not necessarily the one a schedule was stored
   * under. `KOLKATA` is a live example on the runtime this suite pins: the
   * schedule says one thing, `Intl` says the other, and they are the same
   * place.
   *
   * That matters here and nowhere else in the app, because the ONLY question
   * this screen asks about two zone strings is "are these the same place" —
   * the mismatch banner. Comparing the spellings would raise "these windows
   * are not in your zone" over a device that is in exactly that zone, which
   * is the same class of lie as drawing a window the gate will never open.
   *
   * No canonical name is written down. A literal would be a sixth zone in a
   * tree that pins five, and it would be a claim about which ICU is running
   * that rots the next time the database moves a link.
   */
  it('resolves an alias to whatever this build calls it, and is idempotent', () => {
    const canon = canonicalZone(KOLKATA);
    expect(canonicalZone(canon)).toBe(canon);
    // The alias is REAL on this build — otherwise the row below proves
    // nothing — and the canonical name is the one the menu will offer.
    expect(Intl.supportedValuesOf('timeZone')).toContain(canon);
    // …and the projection agrees about the place, whichever name it is
    // given, which is what makes them substitutable in a comparison.
    const at = '2027-03-14T12:00:00.000Z';
    expect(zoneOffsetMinutes(at, canon)).toBe(zoneOffsetMinutes(at, KOLKATA));
    expect(zoneOffsetMinutes(at, canon)).not.toBeNull();
  });

  it('leaves a zone this build cannot resolve exactly as it found it', () => {
    // Deciding a zone is invalid is the DAEMON's job — it answers
    // `invalid-timezone` — so an unresolvable string is passed through
    // rather than swallowed, and the comparison it feeds simply says the two
    // strings differ.
    expect(canonicalZone('Nowhere/In_Particular')).toBe(
      'Nowhere/In_Particular',
    );
    expect(canonicalZone('')).toBe('');
  });

  it('leaves an already-canonical zone alone', () => {
    for (const zone of [LA, LORD_HOWE]) expect(canonicalZone(zone)).toBe(zone);
  });
});

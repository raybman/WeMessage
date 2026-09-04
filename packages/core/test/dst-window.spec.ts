/**
 * ★ CHECKPOINT T-9.5 — s6-execution Part 2 Scenario 2.
 *
 * The §1.3.6 DST rules are not implemented as rules. They fall out of one
 * decision: project the UTC instant into the schedule's zone with
 * `Intl.formatToParts` and decide arming in projected space (F-57). This
 * file is the proof, and it is written as assertions over armed *runs*
 * rather than hand-picked instants so a subtly wrong projection cannot pass
 * by landing between two samples.
 *
 * The whole suite runs TWICE, under two different host `TZ` values, with
 * byte-identical expectations. That is the strongest available form of
 * "the schedule's zone wins": the host zone is not merely outranked, it is
 * never read. `Australia/Lord_Howe` is the second host zone because its DST
 * shift is 30 minutes, which would corrupt any accidental host-zone
 * arithmetic in a way a whole-hour zone might hide.
 *
 * Recorded deviation from the spec's row 3 wording. `fall-fold`
 * (01:00–02:00) covers the entire repeated hour, so its two occurrences
 * ABUT in UTC rather than being disjoint: the first ends at the exact
 * instant the second begins. Both 60-minute occurrences are asserted, and a
 * second window (01:30–02:00) that does NOT cover the whole folded hour is
 * asserted to produce two genuinely disjoint runs — which is only possible
 * if the fold is real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isArmed, projectToZone } from '@wemessage/core';
import {
  antipodean,
  businessHours,
  fallFold,
  makeSchedule,
  PINNED_ZONES,
  springGap,
  springOpen,
} from './fixtures/schedules.js';
import { fakeZoneSweep, localLabel } from './helpers/zone-sweep.js';

const HOST_ZONES = [PINNED_ZONES.utc, PINNED_ZONES.lordHowe] as const;
const MINUTE_MS = 60_000;

/** Every projected wall clock in a UTC range, armed or not. */
function projectedLabels(
  fromIso: string,
  toIso: string,
  zone: string,
): string[] {
  const out: string[] = [];
  for (let t = Date.parse(fromIso); t < Date.parse(toIso); t += MINUTE_MS) {
    const p = projectToZone(new Date(t).toISOString(), zone);
    if (p !== null) out.push(localLabel(p.day, p.minutes));
  }
  return out;
}

describe.each(HOST_ZONES)('T-9.5 DST window math — host TZ=%s', (hostZone) => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = hostZone;
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  // ---- row 1: spring forward, window STARTING in the gap ----------------
  describe('spring forward, window starting in the gap', () => {
    // 2027-03-14, America/Los_Angeles: 01:59 PST is followed by 03:00 PDT.
    const FROM = '2027-03-14T08:00:00.000Z'; // Sun 00:00 local
    const TO = '2027-03-14T14:00:00.000Z'; // Sun 07:00 local

    it('opens at the gap end, not at the wall-clock time nobody lived', () => {
      const sweep = fakeZoneSweep(springOpen, FROM, TO);
      expect(sweep.runs).toEqual([
        {
          start: '2027-03-14T10:00:00.000Z', // Sun 03:00 local
          end: '2027-03-14T11:00:00.000Z', // Sun 04:00 local
          minutes: 60,
        },
      ]);
      expect(sweep.armedLocal[0]).toBe('sun 03:00');
      expect(sweep.armedLocal.at(-1)).toBe('sun 03:59');
    });

    it('never arms an instant projecting into the skipped hour', () => {
      const sweep = fakeZoneSweep(springOpen, FROM, TO);
      expect(sweep.armedLocal.filter((l) => l.startsWith('sun 02:'))).toEqual(
        [],
      );
      // Stronger, and the reason projection is the right model: no instant
      // in the whole range projects into [02:00, 03:00) at all.
      const all = projectedLabels(FROM, TO, springOpen.timezone);
      expect(all.filter((l) => l.startsWith('sun 02:'))).toEqual([]);
      expect(all).toContain('sun 01:59');
      expect(all).toContain('sun 03:00');
    });
  });

  // ---- row 2: spring forward, window ENTIRELY inside the gap ------------
  describe('spring forward, window entirely inside the gap', () => {
    it('arms for zero minutes on the transition day (F-57, deliberate)', () => {
      const sweep = fakeZoneSweep(
        springGap,
        '2027-03-14T08:00:00.000Z',
        '2027-03-14T14:00:00.000Z',
      );
      expect(sweep.runs).toEqual([]);
      expect(sweep.armedLocal).toEqual([]);
      expect(sweep.samples).toBe(360);
    });

    it('arms normally on the following Sunday', () => {
      const sweep = fakeZoneSweep(
        springGap,
        '2027-03-21T08:00:00.000Z',
        '2027-03-21T12:00:00.000Z',
      );
      expect(sweep.runs).toEqual([
        {
          start: '2027-03-21T09:15:00.000Z', // Sun 02:15 local
          end: '2027-03-21T09:45:00.000Z', // Sun 02:45 local
          minutes: 30,
        },
      ]);
    });
  });

  // ---- row 3: fall back, BOTH occurrences ------------------------------
  describe('fall back, both occurrences', () => {
    // 2027-11-07, America/Los_Angeles: 01:59 PDT is followed by 01:00 PST.
    const FROM = '2027-11-07T07:00:00.000Z'; // Sun 00:00 local
    const TO = '2027-11-07T12:00:00.000Z'; // Sun 04:00 local
    const FOLD = '2027-11-07T09:00:00.000Z'; // the repeat instant

    it('arms for 120 UTC minutes on a 60-minute window', () => {
      const sweep = fakeZoneSweep(fallFold, FROM, TO);
      expect(sweep.runs).toEqual([
        {
          start: '2027-11-07T08:00:00.000Z',
          end: '2027-11-07T10:00:00.000Z',
          minutes: 120,
        },
      ]);
    });

    it('projects each local minute of the repeated hour exactly twice', () => {
      const sweep = fakeZoneSweep(fallFold, FROM, TO);
      const counts = new Map<string, number>();
      for (const label of sweep.armedLocal) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      expect(counts.size).toBe(60);
      expect([...counts.values()]).toEqual(Array<number>(60).fill(2));
      expect(counts.get('sun 01:00')).toBe(2);
      expect(counts.get('sun 01:59')).toBe(2);
    });

    it('is two 60-minute occurrences, split at the fold instant', () => {
      const first = fakeZoneSweep(fallFold, FROM, FOLD);
      const second = fakeZoneSweep(fallFold, FOLD, TO);
      expect(first.runs).toEqual([
        {
          start: '2027-11-07T08:00:00.000Z',
          end: FOLD,
          minutes: 60,
        },
      ]);
      expect(second.runs).toEqual([
        {
          start: FOLD,
          end: '2027-11-07T10:00:00.000Z',
          minutes: 60,
        },
      ]);
      expect(first.armedLocal[0]).toBe('sun 01:00');
      expect(second.armedLocal[0]).toBe('sun 01:00');
    });

    it('gives two DISJOINT runs for a window inside the folded hour', () => {
      const fallFoldLate = makeSchedule(
        '01SCHEDFOLDLATE',
        'fall-fold-late',
        PINNED_ZONES.losAngeles,
        [{ days: ['sun'], start: '01:30', end: '02:00' }],
      );
      const sweep = fakeZoneSweep(fallFoldLate, FROM, TO);
      expect(sweep.runs).toEqual([
        {
          start: '2027-11-07T08:30:00.000Z', // 01:30 PDT
          end: '2027-11-07T09:00:00.000Z', // 01:00 PST — not armed
          minutes: 30,
        },
        {
          start: '2027-11-07T09:30:00.000Z', // 01:30 PST
          end: '2027-11-07T10:00:00.000Z', // 02:00 PST
          minutes: 30,
        },
      ]);
    });
  });

  // ---- row 4: the schedule's zone wins, always --------------------------
  it('schedule zone beats system zone', () => {
    // The host zone really is what this pass claims, so a projection that
    // silently fell back to it would be visibly wrong rather than a tie.
    expect(process.env.TZ).toBe(hostZone);
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(hostZone);

    // Byte-identical under both host zones: the schedule's own zone decides.
    expect(
      projectToZone('2027-03-14T10:00:00.000Z', springOpen.timezone),
    ).toEqual({ day: 'sun', minutes: 3 * 60 });
    expect(
      projectToZone('2027-03-14T09:59:00.000Z', springOpen.timezone),
    ).toEqual({ day: 'sun', minutes: 1 * 60 + 59 });
    expect(
      projectToZone('2027-09-06T16:00:00.000Z', businessHours.timezone),
    ).toEqual({ day: 'mon', minutes: 9 * 60 });
    expect(
      projectToZone('2027-09-25T12:45:00.000Z', antipodean.timezone),
    ).toEqual({ day: 'sun', minutes: 1 * 60 + 30 });

    expect(isArmed(springOpen, '2027-03-14T10:00:00.000Z')).toBe(true);
    expect(isArmed(springOpen, '2027-03-14T09:59:00.000Z')).toBe(false);
    expect(isArmed(businessHours, '2027-09-06T16:00:00.000Z')).toBe(true);
    expect(isArmed(businessHours, '2027-09-07T00:00:00.000Z')).toBe(false);
    expect(isArmed(antipodean, '2027-09-25T12:45:00.000Z')).toBe(true);
    expect(isArmed(antipodean, '2027-09-25T14:00:00.000Z')).toBe(false);
  });

  // ---- row 5: mid-window host timezone change --------------------------
  it('does not change its answer when the host zone changes mid-window', () => {
    const other = HOST_ZONES.find((z) => z !== hostZone) ?? PINNED_ZONES.utc;
    const INSIDE = '2027-09-06T17:00:00.000Z'; // Mon 10:00 America/Los_Angeles

    const before = isArmed(businessHours, INSIDE);
    const projectedBefore = projectToZone(INSIDE, businessHours.timezone);
    try {
      process.env.TZ = other;
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(other);
      expect(isArmed(businessHours, INSIDE)).toBe(before);
      expect(projectToZone(INSIDE, businessHours.timezone)).toEqual(
        projectedBefore,
      );
    } finally {
      process.env.TZ = hostZone;
    }
    expect(before).toBe(true);
    expect(projectedBefore).toEqual({ day: 'mon', minutes: 10 * 60 });
  });

  // ---- row 6: southern hemisphere, quarter-hour DST ---------------------
  it('arms across a southern-hemisphere quarter-hour shift with no gap or double', () => {
    // 2027-09-26 Pacific/Chatham (+12:45 -> +13:45): 02:44 is followed by
    // 03:45, so a 01:30-03:30 window loses its tail and keeps its head.
    const sweep = fakeZoneSweep(
      antipodean,
      '2027-09-25T10:00:00.000Z', // Sat 22:45 local
      '2027-09-25T18:00:00.000Z', // Sun 07:45 local
    );
    expect(sweep.runs).toEqual([
      {
        start: '2027-09-25T12:45:00.000Z', // Sun 01:30 local
        end: '2027-09-25T14:00:00.000Z', // Sun 03:45 local — past the end
        minutes: 75,
      },
    ]);
    // No double: every armed minute is a distinct local wall clock.
    expect(new Set(sweep.armedLocal).size).toBe(sweep.armedLocal.length);
    expect(sweep.armedLocal[0]).toBe('sun 01:30');
    expect(sweep.armedLocal.at(-1)).toBe('sun 02:44');
  });
});

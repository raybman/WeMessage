/**
 * s6-execution Part 3 — `fakeZoneSweep`.
 *
 * The T-9.5 rows are written as assertions over *runs*, not over hand-picked
 * instants: a subtly wrong projection can always find a gap between two
 * chosen samples, but it cannot hide from the boundaries of a contiguous
 * armed interval.
 *
 * Deviation from the spec's parameter sketch (`fakeZoneSweep(zone, from, to,
 * step)`), recorded here rather than silently: the sweep takes the
 * **schedule**, whose `timezone` is the zone. Passing a zone alongside a
 * schedule would let the two disagree, and the whole point of Scenario 2 is
 * that exactly one zone decides the answer.
 */
import type { IsoUtc, Schedule, Weekday } from '@wemessage/core';
import { isArmed, projectToZone } from '@wemessage/core';

export interface ArmedRun {
  /** First armed sample in the run. */
  start: IsoUtc;
  /** First sample after the run that is NOT armed (exclusive end). */
  end: IsoUtc;
  /** Armed samples in the run × `stepMinutes`. */
  minutes: number;
}

export interface ZoneSweep {
  runs: ArmedRun[];
  /** Projected wall clock of every armed sample, e.g. `'sun 03:00'`. */
  armedLocal: string[];
  /** Total samples taken (armed or not). */
  samples: number;
}

const MINUTE_MS = 60_000;

export function localLabel(day: Weekday, minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

export function fakeZoneSweep(
  schedule: Schedule,
  fromIso: IsoUtc,
  toIso: IsoUtc,
  stepMinutes = 1,
): ZoneSweep {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || stepMinutes <= 0) {
    throw new Error('fakeZoneSweep: bad range');
  }

  const runs: ArmedRun[] = [];
  const armedLocal: string[] = [];
  let samples = 0;
  let open: { start: IsoUtc; count: number } | null = null;

  for (let t = from; t < to; t += stepMinutes * MINUTE_MS) {
    const at = new Date(t).toISOString();
    samples += 1;
    if (isArmed(schedule, at)) {
      const projected = projectToZone(at, schedule.timezone);
      if (projected !== null) {
        armedLocal.push(localLabel(projected.day, projected.minutes));
      }
      if (open === null) open = { start: at, count: 1 };
      else open.count += 1;
    } else if (open !== null) {
      runs.push({
        start: open.start,
        end: at,
        minutes: open.count * stepMinutes,
      });
      open = null;
    }
  }
  if (open !== null) {
    runs.push({
      start: open.start,
      end: new Date(to).toISOString(),
      minutes: open.count * stepMinutes,
    });
  }
  return { runs, armedLocal, samples };
}

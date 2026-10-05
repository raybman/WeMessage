/**
 * v2 A1: the conversations list's words, without a DOM.
 *
 * Board 01.B draws every row the same way: a monogram, the channel's mark,
 * a title, a time, and the last line, prefixed "You: " when it was ours. The
 * chrome above the list dates its own number ("as of 16:42"), because every
 * number in this product's chrome is dated. Each of those strings is a pure
 * function of what `GET /v1/threads` answered, so they are proved here and
 * the e2e spends its Electron launch proving they reach a window.
 *
 * Four claims:
 *
 *  - **A row's time is relative to the LIST, not to the wall.** The daemon
 *    stamps every page with `asOf`, and "Yest" means "the calendar day before
 *    the day this list was read". A row that compared against a clock the
 *    renderer read for itself would say "9:41" under a chip saying the list
 *    is from yesterday. So no instant below is read from a clock: each is an
 *    argument, by the same ban every other derive file lives under.
 *  - **Days are calendar days in a named zone.** "Yest" is the previous local
 *    date, not "between 24 and 48 hours ago": 23:59 last night is Yest at
 *    16:42 today, and a 23-hour spring-forward day is still one day.
 *  - **The short form is for eyes, the label for ears.** `Yest` and `Fri` are
 *    glyphs as far as a screen reader is concerned; the option's label says
 *    "yesterday" and "Friday", computed from the same projection so the two
 *    can never disagree about which day it was.
 *  - **Nothing is invented.** No preview for a chat whose last line is
 *    unreadable, no time for an instant that does not parse, and a channel
 *    this renderer has never heard of is drawn under `?` with its own name,
 *    not dropped and not renamed.
 *
 * Board 01 specifies today, Yest and weekday. It does not specify a row
 * older than a week; `Aug 28` this year and `2025-12-31` before it are this
 * slice's choice, and the rows below are what pin it.
 *
 * Fixed zones only (`America/Los_Angeles`, `UTC`), never the host's. 2026-09-04
 * is a Friday. Synthetic handles only (`+1555…`, example.com), as everywhere
 * in this PUBLIC repo.
 */
import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from '@wemessage/client';
import {
  CHANNEL_MARK,
  UNKNOWN_MARK,
  clockLabel,
  monogram,
  previewLine,
  scopeChip,
  threadRows,
  timeLabel,
  windowAround,
} from '../../src/renderer/derive/threads.js';

const LA = 'America/Los_Angeles';
const UTC = 'UTC';
/** Friday 2026-09-04, 16:42 in Los Angeles (PDT, UTC-7). */
const NOW = '2026-09-04T23:42:00.000Z';

const short = (at: string, ref = NOW, zone = LA): string =>
  timeLabel(at, ref, zone).short;
const spoken = (at: string, ref = NOW, zone = LA): string =>
  timeLabel(at, ref, zone).spoken;

describe('clockLabel (v2 A1)', () => {
  it('is a 24-hour H:MM in the named zone, no leading zero on the hour', () => {
    expect(clockLabel(NOW, LA)).toBe('16:42');
    expect(clockLabel('2026-09-04T16:41:00.000Z', LA)).toBe('9:41');
    expect(clockLabel('2026-09-04T07:05:00.000Z', LA)).toBe('0:05');
    expect(clockLabel(NOW, UTC)).toBe('23:42');
  });

  it('says nothing for an instant or a zone it cannot read', () => {
    expect(clockLabel('not a date', LA)).toBe('');
    expect(clockLabel(NOW, 'Not/AZone')).toBe('');
  });
});

describe('timeLabel: the row time, relative to the list (v2 A1)', () => {
  it('draws a time for today, as board 01 does', () => {
    expect(short('2026-09-04T16:41:00.000Z')).toBe('9:41');
    expect(short('2026-09-04T22:05:00.000Z')).toBe('15:05');
    expect(short('2026-09-04T07:05:00.000Z')).toBe('0:05');
    expect(spoken('2026-09-04T16:41:00.000Z')).toBe('9:41');
  });

  it('says Yest for anything on the previous local date, midnight to midnight', () => {
    // 23:59 last night, seventeen hours ago.
    expect(short('2026-09-04T06:59:00.000Z')).toBe('Yest');
    // 00:01 yesterday, forty hours ago.
    expect(short('2026-09-03T07:01:00.000Z')).toBe('Yest');
    expect(spoken('2026-09-04T06:59:00.000Z')).toBe('yesterday');
  });

  it('names the weekday from two to six days back', () => {
    expect(short('2026-09-03T06:59:00.000Z')).toBe('Wed');
    expect(spoken('2026-09-03T06:59:00.000Z')).toBe('Wednesday');
    expect(short('2026-08-29T19:00:00.000Z')).toBe('Sat');
    expect(spoken('2026-08-29T19:00:00.000Z')).toBe('Saturday');
  });

  it('dates anything a week or more back, with the year only when it differs', () => {
    expect(short('2026-08-28T19:00:00.000Z')).toBe('Aug 28');
    expect(spoken('2026-08-28T19:00:00.000Z')).toBe('August 28');
    expect(short('2025-12-31T20:00:00.000Z')).toBe('2025-12-31');
    expect(spoken('2025-12-31T20:00:00.000Z')).toBe('December 31, 2025');
  });

  it('dates a day after the list rather than calling it today', () => {
    // A sender's clock ahead of ours is a real row, and "12:00" under a chip
    // saying 16:42 would read as earlier today.
    expect(short('2026-09-05T19:00:00.000Z')).toBe('Sep 5');
  });

  it('decides the day in the zone it is given, not in UTC', () => {
    const ref = '2026-09-04T03:00:00.000Z'; // Sep 4 in UTC, Sep 3 in LA
    const at = '2026-09-03T23:00:00.000Z'; // Sep 3 in both
    expect(short(at, ref, UTC)).toBe('Yest');
    expect(short(at, ref, LA)).toBe('16:00');
  });

  it('counts calendar days, so a 23-hour spring-forward day is still one', () => {
    // 2026-03-08 is 23 hours long in Los Angeles. 00:15 PST that day to
    // 00:30 PDT the next is 23h15m of elapsed time and exactly one date.
    expect(short('2026-03-08T08:15:00.000Z', '2026-03-09T07:30:00.000Z')).toBe(
      'Yest',
    );
  });

  it('says nothing, rather than a wrong thing, when it cannot read an input', () => {
    const blank = { short: '', spoken: '' };
    expect(timeLabel('not a date', NOW, LA)).toEqual(blank);
    expect(timeLabel(NOW, 'not a date', LA)).toEqual(blank);
    expect(timeLabel(NOW, NOW, 'Not/AZone')).toEqual(blank);
  });
});

describe('scopeChip: the dated count above the list (v2 A1)', () => {
  it('counts conversations and dates the count with the list, not the wall', () => {
    expect(scopeChip(3, NOW, LA)).toBe('All · 3 conversations · as of 16:42');
    expect(scopeChip(1, NOW, LA)).toBe('All · 1 conversation · as of 16:42');
    expect(scopeChip(0, NOW, LA)).toBe('All · 0 conversations · as of 16:42');
    expect(scopeChip(4000, NOW, LA)).toBe(
      'All · 4,000 conversations · as of 16:42',
    );
  });

  it('still dates the number when it cannot read the instant, and says so', () => {
    expect(scopeChip(3, 'not a date', LA)).toBe(
      'All · 3 conversations · as of --:--',
    );
  });
});

describe('previewLine: the last line, one line tall (v2 A1)', () => {
  it('prefixes what we sent with "You: ", as board 01 does', () => {
    expect(previewLine("I'll send the address", true)).toBe(
      "You: I'll send the address",
    );
    expect(previewLine('see you at six', false)).toBe('see you at six');
  });

  it('collapses every run of whitespace, so a row is never two lines', () => {
    expect(previewLine('two\n\nlines\tand  tabs ', false)).toBe(
      'two lines and tabs',
    );
  });

  it('draws no preview, and no orphaned "You:", for a line it does not have', () => {
    expect(previewLine(null, true)).toBe('');
    expect(previewLine(null, false)).toBe('');
    expect(previewLine('   \n ', true)).toBe('');
  });
});

describe('monogram (v2 A1)', () => {
  it('takes the first and last initials of a name', () => {
    expect(monogram('Jordan Lee')).toBe('JL');
    expect(monogram('Mary Ann Smith')).toBe('MS');
    expect(monogram('Mom')).toBe('M');
    expect(monogram('  padded  name ')).toBe('PN');
    expect(monogram('josé álvarez')).toBe('JÁ');
  });

  it('reads only words that start with a letter', () => {
    expect(monogram('friend@example.com')).toBe('F');
    expect(monogram('Alex, Sam, +15550000001')).toBe('AS');
    expect(monogram('🎉 Party')).toBe('P');
  });

  it('draws # for a title that is only a number', () => {
    expect(monogram('+15550000201')).toBe('#');
    expect(monogram('+15550000201, +15550000202')).toBe('#');
    expect(monogram('')).toBe('#');
  });
});

describe('threadRows: one row per conversation, in the order the daemon sent (v2 A1)', () => {
  const ONE: ThreadSummary = {
    chatGuid: 'iMessage;-;+15550000201',
    channel: 'imessage',
    title: '+15550000201',
    isGroup: false,
    lastLine: 'see you at six',
    lastFromMe: false,
    lastAt: '2026-09-04T16:41:00.000Z',
  };
  const ROOM: ThreadSummary = {
    chatGuid: 'any;+;chat789',
    channel: 'imessage',
    title: 'Thursday Crew',
    isGroup: true,
    lastLine: 'Booked the venue',
    lastFromMe: true,
    lastAt: '2026-09-03T19:00:00.000Z',
  };

  it('marks the channel the way board 01 does', () => {
    expect(CHANNEL_MARK['imessage']).toBe('iM');
  });

  it('builds every field from the payload, and the label in words', () => {
    expect(threadRows([ONE, ROOM], NOW, LA)).toEqual([
      {
        key: 'iMessage;-;+15550000201',
        title: '+15550000201',
        mark: 'iM',
        monogram: '#',
        time: '9:41',
        preview: 'see you at six',
        isGroup: false,
        label: '+15550000201 · iMessage · 9:41 · see you at six',
      },
      {
        key: 'any;+;chat789',
        title: 'Thursday Crew',
        mark: 'iM',
        monogram: 'TC',
        time: 'Yest',
        preview: 'You: Booked the venue',
        isGroup: true,
        label:
          'Thursday Crew · iMessage group · yesterday · You: Booked the venue',
      },
    ]);
  });

  it('keeps the order it was given: the daemon sorted, the renderer does not', () => {
    expect(threadRows([ROOM, ONE], NOW, LA).map((r) => r.key)).toEqual([
      'any;+;chat789',
      'iMessage;-;+15550000201',
    ]);
  });

  it('leaves out of the label what it left off the row', () => {
    const [row] = threadRows(
      [{ ...ONE, lastLine: null, lastAt: 'not a date' }],
      NOW,
      LA,
    );
    expect(row?.preview).toBe('');
    expect(row?.time).toBe('');
    expect(row?.label).toBe('+15550000201 · iMessage');
  });

  it('draws a channel it has never heard of under ? and its own name', () => {
    const odd = { ...ONE, channel: 'smoke-signal' } as unknown as ThreadSummary;
    const [row] = threadRows([odd], NOW, LA);
    expect(row?.mark).toBe(UNKNOWN_MARK);
    expect(UNKNOWN_MARK).toBe('?');
    expect(row?.label).toBe(
      '+15550000201 · smoke-signal · 9:41 · see you at six',
    );
  });
});

describe('windowAround: the mounted slice follows the cursor (v2 A1)', () => {
  it('mounts everything when the held list fits', () => {
    expect(windowAround(0, -1, 60)).toEqual({ start: 0, end: 0 });
    expect(windowAround(40, 39, 60)).toEqual({ start: 0, end: 40 });
  });

  it('centres on the cursor and clamps at both ends, so the active row is always mounted', () => {
    expect(windowAround(100, 0, 60)).toEqual({ start: 0, end: 60 });
    expect(windowAround(200, 99, 60)).toEqual({ start: 69, end: 129 });
    expect(windowAround(300, 199, 60)).toEqual({ start: 169, end: 229 });
    expect(windowAround(300, 299, 60)).toEqual({ start: 240, end: 300 });
    for (const active of [0, 1, 29, 30, 31, 150, 269, 270, 299]) {
      const { start, end } = windowAround(300, active, 60);
      expect(end - start).toBe(60);
      expect(active >= start && active < end, String(active)).toBe(true);
    }
  });
});

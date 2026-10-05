/**
 * v2 A2: one conversation's words, without a DOM.
 *
 * The transcript pane groups turns under a heading per local day, draws
 * ours on the right, and spells out every placeholder. Each of those is a
 * pure function of the pages `GET /v1/threads/:guid/messages` answered, so
 * they are proved here and the e2e spends its Electron launch proving they
 * reach a window.
 *
 * Fixed zones only (`America/Los_Angeles`, `Asia/Kolkata`, `UTC`), never the
 * host's. Synthetic handles only (`+1555…`), as everywhere in this PUBLIC
 * repo.
 */
import { describe, expect, it } from 'vitest';
import type { ThreadTurn } from '@wemessage/client';
import {
  dayGroups,
  jumpMask,
  jumpUntil,
  mergeHead,
  prependOlder,
} from '../../src/renderer/derive/transcript.js';

const LA = 'America/Los_Angeles';
const KOLKATA = 'Asia/Kolkata';
/** Friday 2026-09-04, 16:42 in Los Angeles (PDT, UTC-7). */
const NOW = '2026-09-04T23:42:00.000Z';

let seq = 0;
function turn(at: string, extra: Partial<ThreadTurn> = {}): ThreadTurn {
  seq += 1;
  return {
    guid: `G-${String(seq)}`,
    from: 'them',
    kind: 'text',
    text: `line ${String(seq)}`,
    at,
    attachments: 0,
    ...extra,
  };
}

const headings = (turns: ThreadTurn[], asOf = NOW, zone = LA): string[] =>
  dayGroups(turns, asOf, zone, 'Ada', false).map((g) => g.heading);

describe('dayGroups: one heading per local day, relative to the page (v2 A2)', () => {
  it('says Today, Yesterday, a weekday, then the date', () => {
    expect(
      headings([
        turn('2026-08-20T19:00:00.000Z'), // Thu Aug 20
        turn('2026-08-31T19:00:00.000Z'), // Mon Aug 31
        turn('2026-09-03T19:00:00.000Z'), // Thu Sep 3
        turn('2026-09-04T19:00:00.000Z'), // Fri Sep 4
      ]),
    ).toEqual(['August 20', 'Monday', 'Yesterday', 'Today']);
  });

  it('puts the year on a date only when it is not the page year', () => {
    expect(headings([turn('2025-12-31T20:00:00.000Z')])).toEqual([
      'December 31, 2025',
    ]);
  });

  it('dates a turn after the page rather than calling it today', () => {
    expect(headings([turn('2026-09-06T19:00:00.000Z')])).toEqual([
      'September 6',
    ]);
  });

  it('keeps consecutive turns of one local day under one heading', () => {
    const groups = dayGroups(
      [
        turn('2026-09-04T07:00:00.000Z'), // 00:00 PDT, exactly local midnight
        turn('2026-09-04T06:59:59.000Z'), // 23:59:59 the day before
      ].reverse(),
      NOW,
      LA,
      'Ada',
      false,
    );
    expect(groups.map((g) => [g.heading, g.turns.length])).toEqual([
      ['Yesterday', 1],
      ['Today', 1],
    ]);
    expect(groups[1]?.turns[0]?.time).toBe('0:00');
  });

  it('decides the day in the zone it is given, not in UTC', () => {
    // 2026-09-04T19:00Z is Sep 5 00:30 in Kolkata and Sep 4 12:00 in LA.
    const at = '2026-09-04T19:00:00.000Z';
    expect(headings([turn(at)], '2026-09-05T14:00:00.000Z', KOLKATA)).toEqual([
      'Today',
    ]);
    expect(headings([turn(at)], '2026-09-05T14:00:00.000Z', LA)).toEqual([
      'Yesterday',
    ]);
  });

  it('DST: a 23-hour spring-forward day is one heading, and the next is Yesterday', () => {
    // 2026-03-08 is 23 hours long in Los Angeles: 00:15 PST and 23:45 PDT
    // are 22.5 hours apart and on the same local date.
    const groups = dayGroups(
      [turn('2026-03-08T08:15:00.000Z'), turn('2026-03-09T06:45:00.000Z')],
      '2026-03-09T16:00:00.000Z',
      LA,
      'Ada',
      false,
    );
    expect(groups.map((g) => [g.date, g.heading, g.turns.length])).toEqual([
      ['2026-03-08', 'Yesterday', 2],
    ]);
    expect(groups[0]?.turns.map((t) => t.time)).toEqual(['0:15', '23:45']);
  });

  it('DST: a 25-hour fall-back day is one heading too', () => {
    // 2026-11-01 is 25 hours long in Los Angeles.
    const groups = dayGroups(
      [turn('2026-11-01T07:30:00.000Z'), turn('2026-11-02T07:30:00.000Z')],
      '2026-11-02T12:00:00.000Z',
      LA,
      'Ada',
      false,
    );
    expect(groups.map((g) => [g.date, g.turns.length])).toEqual([
      ['2026-11-01', 2],
    ]);
  });

  it('keeps a turn whose instant does not parse, under the day before it', () => {
    const groups = dayGroups(
      [turn('2026-09-04T19:00:00.000Z'), turn('not an instant')],
      NOW,
      LA,
      'Ada',
      false,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.turns.map((t) => t.time)).toEqual(['12:00', '']);
    expect(headings([turn('nope')])).toEqual(['Undated']);
  });
});

describe('turn rows: who, what, and what stands in for it (v2 A2)', () => {
  const one = (t: ThreadTurn, isGroup = false) =>
    dayGroups([t], NOW, LA, 'Ada Lovelace', isGroup)[0]?.turns[0];

  it('ours says You and is from me; theirs is the conversation in a 1:1', () => {
    expect(one(turn(NOW, { from: 'me' }))).toMatchObject({
      from: 'me',
      who: 'You',
      showWho: false,
    });
    expect(one(turn(NOW))).toMatchObject({
      from: 'them',
      who: 'Ada Lovelace',
      showWho: false,
    });
  });

  it('a group draws the sender of every turn that is not ours', () => {
    expect(one(turn(NOW, { handle: '+15550000201' }), true)).toMatchObject({
      who: '+15550000201',
      showWho: true,
    });
  });

  it('spells out unsent, audio and attachment-only turns as placeholders', () => {
    expect(
      one(turn(NOW, { text: null, unsentAt: NOW, editedAt: NOW })),
    ).toMatchObject({
      body: 'This message was unsent.',
      placeholder: true,
      marks: [],
    });
    expect(one(turn(NOW, { kind: 'audio', text: null }))).toMatchObject({
      body: 'Audio message',
      placeholder: true,
    });
    expect(
      one(turn(NOW, { kind: 'attachment-only', text: null, attachments: 2 })),
    ).toMatchObject({ body: '2 attachments', placeholder: true });
  });

  it('marks an edit and the attachments that came with the words', () => {
    expect(
      one(turn(NOW, { text: 'hi', editedAt: NOW, attachments: 1 })),
    ).toMatchObject({
      body: 'hi',
      placeholder: false,
      marks: ['+ 1 attachment', 'Edited'],
    });
  });
});

describe('mergeHead: a re-read head over what is held (v2 A2)', () => {
  const ids = (turns: readonly ThreadTurn[]) => turns.map((t) => t.guid);

  it('appends what is new after what is held, and takes the head copy of a re-read turn', () => {
    const held = [turn(NOW), turn(NOW), turn(NOW)];
    const edited = { ...held[2]!, text: 'edited', editedAt: NOW };
    const fresh = turn(NOW);
    const out = mergeHead(held, [held[1]!, edited, fresh]);
    expect(out.continuous).toBe(true);
    expect(ids(out.turns)).toEqual([...ids(held), fresh.guid]);
    expect(out.turns[2]?.text).toBe('edited');
  });

  it('replaces, and says so, when the head shares nothing with what is held', () => {
    const held = [turn(NOW), turn(NOW)];
    const head = [turn(NOW), turn(NOW)];
    expect(mergeHead(held, head)).toEqual({ turns: head, continuous: false });
  });

  it('prependOlder never draws a guid twice', () => {
    const held = [turn(NOW), turn(NOW)];
    const older = [turn(NOW), held[0]!];
    expect(ids(prependOlder(held, older))).toEqual([
      older[0]!.guid,
      ...ids(held),
    ]);
  });
});

describe('jumpUntil: a typed day becomes the last instant of that day (v2 A2)', () => {
  it('ends the local day one millisecond before the next local midnight', () => {
    expect(jumpUntil('20260904', LA)).toEqual({
      ok: true,
      date: '2026-09-04',
      until: '2026-09-05T06:59:59.999Z',
      spoken: 'September 4, 2026',
    });
    expect(jumpUntil('20260904', KOLKATA)).toMatchObject({
      until: '2026-09-04T18:29:59.999Z',
    });
  });

  it('DST: the spring-forward day ends where it really ends', () => {
    // 2026-03-08 in LA: starts PST (UTC-8), ends PDT (UTC-7).
    expect(jumpUntil('20260308', LA)).toMatchObject({
      until: '2026-03-09T06:59:59.999Z',
    });
    expect(jumpUntil('20260307', LA)).toMatchObject({
      until: '2026-03-08T07:59:59.999Z',
    });
  });

  it('refuses fewer than eight digits and a date that rolls over', () => {
    expect(jumpUntil('202609', LA)).toMatchObject({ ok: false });
    expect(jumpUntil('20260230', LA)).toEqual({
      ok: false,
      reason: '2026-02-30 is not a date.',
    });
  });

  it('masks what is typed so far', () => {
    expect(jumpMask('')).toBe('____-__-__');
    expect(jumpMask('202603')).toBe('2026-03-__');
    expect(jumpMask('20260314')).toBe('2026-03-14');
  });
});

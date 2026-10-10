/**
 * v2 F2b: the pure half of search. The operator's structured tokens compile
 * to one MirrorQuery, and every token comes back with its fate: applied,
 * partial or not-applied, with a reason. None is dropped silently.
 *
 * Every handle here is synthetic (+1555...).
 */
import { describe, expect, it } from 'vitest';
import {
  compileSearch,
  dayStartInZone,
  ftsPhrase,
  InvalidCursorError,
  isAfterKey,
  isEmptySearch,
  isValidTimeZone,
  mintSearchCursor,
  readSearchCursor,
  SEARCH_MATCH_CAP,
  searchQueryHash,
  senderFacets,
  yearCountsOf,
  yearFacets,
  yearStartInZone,
  type SearchParams,
} from '@wemessage/core';

const NONE = { chatGuids: [], savedHandles: [] };
const base = (over: Partial<SearchParams> = {}): SearchParams => ({
  terms: [],
  channels: [],
  has: [],
  ...over,
});

describe('compileSearch (v2 F2b)', () => {
  it('a long term goes to FTS as a quoted phrase, terms AND together', () => {
    const { q, tokens } = compileSearch(
      base({ terms: ['cabin', 'lake'] }),
      NONE,
    );
    expect(q?.ftsMatch).toBe('"cabin" "lake"');
    expect(q?.shortTerms).toEqual([]);
    expect(q?.cap).toBe(SEARCH_MATCH_CAP);
    expect(tokens).toEqual([
      { op: 'term', value: 'cabin', applied: 'applied' },
      { op: 'term', value: 'lake', applied: 'applied' },
    ]);
  });

  it('a short term alone is matched by instr() and reads partial: short-term', () => {
    const { q, tokens } = compileSearch(base({ terms: ['ok'] }), NONE);
    expect(q?.ftsMatch).toBeNull();
    expect(q?.shortTerms).toEqual(['ok']);
    expect(tokens).toEqual([
      { op: 'term', value: 'ok', applied: 'partial', reason: 'short-term' },
    ]);
  });

  it('a short term beside a long one narrows its hits and is applied in full', () => {
    const { q, tokens } = compileSearch(base({ terms: ['ok', 'cabin'] }), NONE);
    expect(q?.ftsMatch).toBe('"cabin"');
    expect(q?.shortTerms).toEqual(['ok']);
    expect(tokens.map((t) => t.applied)).toEqual(['applied', 'applied']);
  });

  it('counts code points, so a three-emoji term is long enough for the index', () => {
    const { q } = compileSearch(base({ terms: ['🏔️🌲'] }), NONE);
    // 🏔️ is two code points (the mountain and VS16), 🌲 one.
    expect(q?.ftsMatch).toBe('"🏔️🌲"');
    const short = compileSearch(base({ terms: ['🌲'] }), NONE);
    expect(short.q?.shortTerms).toEqual(['🌲']);
  });

  it('from:me is is_from_me, applied', () => {
    const { q, tokens } = compileSearch(base({ from: { me: true } }), NONE);
    expect(q?.fromMe).toBe(true);
    expect(tokens).toEqual([{ op: 'from', value: 'me', applied: 'applied' }]);
  });

  it('from:name matches handles and saved names, always partial', () => {
    const { q, tokens } = compileSearch(base({ from: { name: 'Jordan' } }), {
      chatGuids: [],
      savedHandles: ['+15550100004'],
    });
    expect(q?.handleNeedle).toBe('Jordan');
    expect(q?.handles).toEqual(['+15550100004']);
    expect(tokens).toEqual([
      {
        op: 'from',
        value: 'Jordan',
        applied: 'partial',
        reason: 'handles-and-saved-names',
      },
    ]);
  });

  it('in: narrows to the resolved chats; a source that could not be read is not-applied', () => {
    const ok = compileSearch(base({ in: 'Family' }), {
      chatGuids: ['iMessage;+;chat0001'],
      savedHandles: [],
    });
    expect(ok.q?.chatGuids).toEqual(['iMessage;+;chat0001']);
    expect(ok.tokens).toEqual([
      { op: 'in', value: 'Family', applied: 'applied' },
    ]);

    const down = compileSearch(base({ in: 'Family' }), {
      chatGuids: null,
      savedHandles: [],
    });
    expect(down.q).not.toBeNull();
    expect(down.q?.chatGuids).toBeUndefined();
    expect(down.tokens).toEqual([
      {
        op: 'in',
        value: 'Family',
        applied: 'not-applied',
        reason: 'source-unavailable',
      },
    ]);
  });

  it('channels: imessage is applied, the others have no source', () => {
    const { q, tokens } = compileSearch(
      base({ terms: ['cabin'], channels: ['imessage', 'whatsapp'] }),
      NONE,
    );
    expect(q).not.toBeNull();
    expect(tokens.slice(1)).toEqual([
      { op: 'channel', value: 'imessage', applied: 'applied' },
      {
        op: 'channel',
        value: 'whatsapp',
        applied: 'not-applied',
        reason: 'no-source',
      },
    ]);
  });

  it('a channel filter that leaves iMessage out searches nothing', () => {
    const { q, tokens } = compileSearch(
      base({ terms: ['cabin'], channels: ['email'] }),
      NONE,
    );
    expect(q).toBeNull();
    expect(tokens).toHaveLength(2);
  });

  it('has:, before and after are applied and carried through', () => {
    const { q, tokens } = compileSearch(
      base({
        has: ['attachment', 'link'],
        before: '2020-01-01T08:00:00.000Z',
        after: '2019-01-01T08:00:00.000Z',
      }),
      NONE,
    );
    expect(q?.has).toEqual(['attachment', 'link']);
    expect(q?.before).toBe('2020-01-01T08:00:00.000Z');
    expect(q?.after).toBe('2019-01-01T08:00:00.000Z');
    expect(tokens.map((t) => `${t.op}:${t.applied}`)).toEqual([
      'has:applied',
      'has:applied',
      'before:applied',
      'after:applied',
    ]);
  });

  it('every token comes back, one entry each, in the order asked', () => {
    const p = base({
      terms: ['cabin', 'ok'],
      from: { name: 'maya' },
      in: 'Family',
      channels: ['imessage', 'linkedin'],
      has: ['voice'],
      before: '2020-01-01T08:00:00.000Z',
      after: '2019-01-01T08:00:00.000Z',
    });
    const { tokens } = compileSearch(p, NONE);
    expect(tokens.map((t) => t.op)).toEqual([
      'term',
      'term',
      'from',
      'in',
      'channel',
      'channel',
      'has',
      'before',
      'after',
    ]);
  });

  it('an empty query is empty; any one token is not', () => {
    expect(isEmptySearch(base())).toBe(true);
    expect(isEmptySearch(base({ has: ['voice'] }))).toBe(false);
    expect(isEmptySearch(base({ channels: ['email'] }))).toBe(false);
  });
});

describe('ftsPhrase (v2 F2b)', () => {
  it('quotes, doubling an embedded quote, so FTS5 syntax is never live', () => {
    expect(ftsPhrase('cabin')).toBe('"cabin"');
    expect(ftsPhrase('say "hi"')).toBe('"say ""hi"""');
    expect(ftsPhrase('a OR b')).toBe('"a OR b"');
    expect(ftsPhrase('NEAR(x y)')).toBe('"NEAR(x y)"');
  });

  it('refuses a term the trigram tokenizer would silently match nothing for', () => {
    expect(() => ftsPhrase('ok')).toThrow(RangeError);
  });
});

describe('search cursor (v2 F2b)', () => {
  const p = base({ terms: ['cabin'] });
  const h = searchQueryHash(p, 'America/Los_Angeles');
  const key = { sentAt: '2019-07-04T20:00:00.000Z', guid: 'g-1' };

  it('round-trips under the same query', () => {
    expect(readSearchCursor(mintSearchCursor(key, h), h)).toEqual(key);
  });

  it('a cursor reused under a different query or zone is invalid', () => {
    const c = mintSearchCursor(key, h);
    const other = searchQueryHash(
      base({ terms: ['lake'] }),
      'America/Los_Angeles',
    );
    const zone = searchQueryHash(p, 'Asia/Kolkata');
    expect(() => readSearchCursor(c, other)).toThrow(InvalidCursorError);
    expect(() => readSearchCursor(c, zone)).toThrow(InvalidCursorError);
  });

  it('the hash ignores nothing that decides the match set', () => {
    const hashes = new Set([
      h,
      searchQueryHash(
        base({ terms: ['cabin'], from: { me: true } }),
        'America/Los_Angeles',
      ),
      searchQueryHash(
        base({ terms: ['cabin'], from: { name: 'me' } }),
        'America/Los_Angeles',
      ),
      searchQueryHash(
        base({ terms: ['cabin'], in: 'x' }),
        'America/Los_Angeles',
      ),
      searchQueryHash(
        base({ terms: ['cabin'], has: ['voice'] }),
        'America/Los_Angeles',
      ),
      searchQueryHash(
        base({ terms: ['cabin'], channels: ['imessage'] }),
        'America/Los_Angeles',
      ),
      searchQueryHash(
        base({ terms: ['cabin'], before: '2020-01-01T00:00:00.000Z' }),
        'America/Los_Angeles',
      ),
      searchQueryHash(
        base({ terms: ['cabin'], after: '2020-01-01T00:00:00.000Z' }),
        'America/Los_Angeles',
      ),
    ]);
    expect(hashes.size).toBe(8);
  });

  it('refuses garbage, padding, a forged key set and a non-instant', () => {
    const forge = (o: unknown): string =>
      Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    for (const bad of [
      '',
      'nope!',
      `${mintSearchCursor(key, h)}=`,
      forge({ v: 1, s: key.sentAt, g: 'g-1', h, x: 1 }),
      forge({ v: 2, s: key.sentAt, g: 'g-1', h }),
      forge({ v: 1, s: '2019-07-04', g: 'g-1', h }),
      forge({ v: 1, s: key.sentAt, g: '', h }),
      forge([1, 2]),
    ]) {
      expect(() => readSearchCursor(bad, h), bad).toThrow(InvalidCursorError);
    }
  });

  it('isAfterKey is (sentAt DESC, guid ASC)', () => {
    expect(
      isAfterKey({ sentAt: '2019-07-04T19:00:00.000Z', guid: 'a' }, key),
    ).toBe(true);
    expect(isAfterKey({ sentAt: key.sentAt, guid: 'g-2' }, key)).toBe(true);
    expect(isAfterKey({ sentAt: key.sentAt, guid: 'g-0' }, key)).toBe(false);
    expect(isAfterKey(key, key)).toBe(false);
  });
});

describe('time zones and facets (v2 F2b)', () => {
  it('validates zones with Intl', () => {
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('yearStartInZone is local midnight on January 1', () => {
    expect(yearStartInZone(2025, 'America/Los_Angeles').toISOString()).toBe(
      '2025-01-01T08:00:00.000Z',
    );
    // A half-hour zone (the repo's pinned five, arch S6 (f)).
    expect(yearStartInZone(2025, 'Asia/Kolkata').toISOString()).toBe(
      '2024-12-31T18:30:00.000Z',
    );
    expect(yearStartInZone(2025, 'UTC').toISOString()).toBe(
      '2025-01-01T00:00:00.000Z',
    );
    // Southern-hemisphere summer time is in force at New Year (Lord Howe's
    // is a half-hour shift: +10:30 standard, +11 in summer).
    expect(yearStartInZone(2025, 'Australia/Lord_Howe').toISOString()).toBe(
      '2024-12-31T13:00:00.000Z',
    );
    expect(yearStartInZone(2025, 'Pacific/Chatham').toISOString()).toBe(
      '2024-12-31T10:15:00.000Z',
    );
  });

  it('dayStartInZone is local midnight of the day now falls on (v2 F7a)', () => {
    // 09-02 09:00 UTC is 09-02 02:00 in Los Angeles (PDT, -7).
    expect(
      dayStartInZone(
        new Date('2026-09-02T09:00:00.000Z'),
        'America/Los_Angeles',
      ).toISOString(),
    ).toBe('2026-09-02T07:00:00.000Z');
    // 09-02 06:30 UTC is still 09-01 23:30 in Los Angeles.
    expect(
      dayStartInZone(
        new Date('2026-09-02T06:30:00.000Z'),
        'America/Los_Angeles',
      ).toISOString(),
    ).toBe('2026-09-01T07:00:00.000Z');
    expect(
      dayStartInZone(new Date('2026-09-02T23:59:59.999Z'), 'UTC').toISOString(),
    ).toBe('2026-09-02T00:00:00.000Z');
    expect(
      dayStartInZone(
        new Date('2026-09-02T20:00:00.000Z'),
        'Asia/Kolkata',
      ).toISOString(),
    ).toBe('2026-09-02T18:30:00.000Z');
    // The DST spring-forward day in Los Angeles: midnight is still PST (-8).
    expect(
      dayStartInZone(
        new Date('2026-03-08T20:00:00.000Z'),
        'America/Los_Angeles',
      ).toISOString(),
    ).toBe('2026-03-08T08:00:00.000Z');
  });

  it('a message at 23:30 on Dec 31 in Los Angeles is that year, not the next', () => {
    expect(
      yearFacets(
        ['2025-01-01T07:30:00.000Z', '2025-01-01T08:00:00.000Z'],
        'America/Los_Angeles',
      ),
    ).toEqual([
      { year: 2025, count: 1 },
      { year: 2024, count: 1 },
    ]);
    expect(yearFacets(['2024-12-31T18:30:00.000Z'], 'Asia/Kolkata')).toEqual([
      { year: 2025, count: 1 },
    ]);
    expect(yearFacets(['2024-12-31T18:29:59.999Z'], 'Asia/Kolkata')).toEqual([
      { year: 2024, count: 1 },
    ]);
  });

  it('senders: the four busiest, ties by handle, mine as "me"', () => {
    const m = (handle: string, isFromMe = false) => ({ handle, isFromMe });
    expect(
      senderFacets([
        m('+15550100003'),
        m('+15550100001'),
        m('+15550100002'),
        m('+15550100002'),
        m('+15550100001', true),
        m('+15550100001', true),
        m('+15550100005'),
        m('+15550100004'),
      ]),
    ).toEqual([
      { handle: '+15550100002', count: 2 },
      { handle: 'me', count: 2 },
      { handle: '+15550100001', count: 1 },
      { handle: '+15550100003', count: 1 },
    ]);
  });
});

describe('yearCountsOf (v2 F2c)', () => {
  const ms = (iso: string): number => Date.parse(iso);

  it('nothing said is no years at all', () => {
    expect(yearCountsOf([], 'UTC')).toEqual([]);
  });

  it('newest year first, each with its first and last turn, empty years kept', () => {
    const years = yearCountsOf(
      [
        ms('2019-03-01T10:00:00.000Z'),
        ms('2019-11-30T10:00:00.000Z'),
        ms('2022-06-01T10:00:00.000Z'),
      ],
      'UTC',
    );
    expect(years).toEqual([
      {
        year: 2022,
        count: 1,
        first: '2022-06-01T10:00:00.000Z',
        last: '2022-06-01T10:00:00.000Z',
      },
      { year: 2021, count: 0, first: null, last: null },
      { year: 2020, count: 0, first: null, last: null },
      {
        year: 2019,
        count: 2,
        first: '2019-03-01T10:00:00.000Z',
        last: '2019-11-30T10:00:00.000Z',
      },
    ]);
  });

  it("a year is the zone's year: 23:30 on New Year's Eve in LA is still 2024", () => {
    const t = [ms('2025-01-01T07:30:00.000Z')];
    expect(yearCountsOf(t, 'America/Los_Angeles').map((y) => y.year)).toEqual([
      2024,
    ]);
    expect(yearCountsOf(t, 'UTC').map((y) => y.year)).toEqual([2025]);
    expect(yearCountsOf(t, 'Pacific/Chatham').map((y) => y.year)).toEqual([
      2025,
    ]);
  });

  it('the boundary instant belongs to the year it opens', () => {
    const start = yearStartInZone(2025, 'Asia/Kolkata').getTime();
    const years = yearCountsOf([start - 1, start], 'Asia/Kolkata');
    expect(years.map((y) => [y.year, y.count])).toEqual([
      [2025, 1],
      [2024, 1],
    ]);
  });
});

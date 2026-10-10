/**
 * v2 F2c: `yearCounts`, one conversation's turns counted by year in the
 * operator's zone, for the transcript's year scrubber.
 *
 * A turn here is exactly a turn on a transcript page (the page reader's own
 * turn test): a tapback is not one and neither is a group event. So the
 * counts always add up to what walking every page shows, and a jump to a
 * year's `last` lands on a turn the page will show.
 *
 * Every chat.db here is a synthetic fixture in tmp; every handle is +1555.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  appleEpochNs,
  createChatDb,
  type ChatDbFixture,
} from '@wemessage/fixtures';
import { createChatDbReader, type IngestChatDbReader } from '@wemessage/ingest';
import { UnknownChatError, type Clock } from '@wemessage/core';

const FIXED_NOW = '2026-10-10T12:00:00.000Z';
const clock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function freshFixture(): ChatDbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wm-read-years-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = createChatDb(join(dir, 'chat.db'));
  cleanups.push(() => fixture.close());
  return fixture;
}

function readerOver(f: ChatDbFixture): IngestChatDbReader {
  const reader = createChatDbReader(f.path, { clock });
  cleanups.push(() => reader.close());
  return reader;
}

function oneToOne(
  f: ChatDbFixture,
  handle: string,
): { chatId: number; guid: string } {
  const handleId = f.addHandle(handle);
  const chatId = f.addChat({ identifier: handle, handleIds: [handleId] });
  const row = f.db
    .prepare('SELECT guid FROM chat WHERE ROWID = ?')
    .get(chatId) as { guid: string };
  return { chatId, guid: row.guid };
}

/** Every turn a full walk of the transcript shows, oldest first. */
async function walkAll(
  reader: IngestChatDbReader,
  chatGuid: string,
): Promise<string[]> {
  const out: string[] = [];
  let before: string | null = null;
  do {
    const page = await reader.readChatPage({
      chatGuid,
      limit: 50,
      ...(before !== null ? { before } : {}),
    });
    out.unshift(...page.turns.map((t) => t.at));
    before = page.nextBefore;
  } while (before !== null);
  return out;
}

describe('yearCounts (v2 F2c)', () => {
  it('countsSumToWalkAll: tapbacks and group events are not turns, here or on the page', async () => {
    const f = freshFixture();
    const c = oneToOne(f, '+15550003001');
    const other = oneToOne(f, '+15550003002');
    const said: { guid: string }[] = [];
    for (let i = 0; i < 120; i += 1) {
      said.push(
        f.addMessage({
          chatId: c.chatId,
          text: `turn ${String(i)}`,
          at: new Date(
            Date.parse('2020-02-01T00:00:00.000Z') + i * 9 * 86_400_000,
          ).toISOString(),
        }),
      );
    }
    for (let i = 0; i < 30; i += 1) {
      const target = said[i * 4];
      if (target === undefined) throw new Error('no target');
      f.addTapback(target.guid, 2000 + (i % 6), {
        chatId: c.chatId,
        at: new Date(
          Date.parse('2020-02-01T00:00:00.000Z') + i * 36 * 86_400_000 + 1000,
        ).toISOString(),
      });
    }
    const rename = f.addMessage({
      chatId: c.chatId,
      text: null,
      at: '2021-05-05T05:05:05.000Z',
    });
    f.db
      .prepare('UPDATE message SET item_type = 2 WHERE ROWID = ?')
      .run(rename.rowid);
    // Another conversation's turns are never counted here.
    f.addMessage({
      chatId: other.chatId,
      text: 'elsewhere',
      at: '2021-01-01T00:00:00.000Z',
    });

    const reader = readerOver(f);
    const years = reader.yearCounts(c.guid, 'America/Los_Angeles');
    const walked = await walkAll(reader, c.guid);

    expect(years.reduce((n, y) => n + y.count, 0)).toBe(walked.length);
    expect(walked).toHaveLength(120);
    // first and last are turns the page shows, by the page's own dating.
    const seen = new Set(walked);
    for (const y of years) {
      if (y.first !== null) expect(seen.has(y.first)).toBe(true);
      if (y.last !== null) expect(seen.has(y.last)).toBe(true);
    }
    expect(years[0]?.last).toBe(walked[walked.length - 1]);
    expect(years[years.length - 1]?.first).toBe(walked[0]);
  });

  it('emptyYearsKept: a silent year between two is there, with a count of 0', () => {
    const f = freshFixture();
    const c = oneToOne(f, '+15550003011');
    f.addMessage({
      chatId: c.chatId,
      text: 'a',
      at: '2019-07-04T18:00:00.000Z',
    });
    f.addMessage({
      chatId: c.chatId,
      text: 'b',
      at: '2022-08-01T18:00:00.000Z',
    });

    expect(readerOver(f).yearCounts(c.guid, 'UTC')).toEqual([
      {
        year: 2022,
        count: 1,
        first: '2022-08-01T18:00:00.000Z',
        last: '2022-08-01T18:00:00.000Z',
      },
      { year: 2021, count: 0, first: null, last: null },
      { year: 2020, count: 0, first: null, last: null },
      {
        year: 2019,
        count: 1,
        first: '2019-07-04T18:00:00.000Z',
        last: '2019-07-04T18:00:00.000Z',
      },
    ]);
  });

  it('secondsEraRowsCounted: a pre-High Sierra row dates as seconds, in its own year', () => {
    const f = freshFixture();
    const c = oneToOne(f, '+15550003021');
    f.addMessage({
      chatId: c.chatId,
      text: 'now',
      at: '2018-01-02T00:00:00.000Z',
    });
    const old = f.addMessage({
      chatId: c.chatId,
      text: 'then',
      at: '2018-01-03T00:00:00.000Z',
    });
    const seconds = 500_000_000; // 2016-11-05T00:53:20Z
    f.db
      .prepare('UPDATE message SET date = ? WHERE ROWID = ?')
      .run(seconds, old.rowid);
    f.db
      .prepare(
        'UPDATE chat_message_join SET message_date = ? WHERE message_id = ?',
      )
      .run(seconds, old.rowid);

    const years = readerOver(f).yearCounts(c.guid, 'UTC');
    expect(years.map((y) => [y.year, y.count])).toEqual([
      [2018, 1],
      [2017, 0],
      [2016, 1],
    ]);
    expect(years[2]?.first).toBe(
      new Date((978_307_200 + seconds) * 1000).toISOString(),
    );
  });

  it("yearBoundaryHonoursTz: 23:30 on New Year's Eve in LA is 2024 there, 2025 in UTC", () => {
    const f = freshFixture();
    const c = oneToOne(f, '+15550003031');
    // 2024-12-31T23:30-08:00
    f.addMessage({
      chatId: c.chatId,
      text: 'nye',
      at: '2025-01-01T07:30:00.000Z',
    });
    const reader = readerOver(f);

    expect(reader.yearCounts(c.guid, 'America/Los_Angeles')).toEqual([
      {
        year: 2024,
        count: 1,
        first: '2025-01-01T07:30:00.000Z',
        last: '2025-01-01T07:30:00.000Z',
      },
    ]);
    expect(reader.yearCounts(c.guid, 'UTC').map((y) => y.year)).toEqual([2025]);
  });

  it('a conversation with no turns has no years; one chat.db never held is UnknownChatError', () => {
    const f = freshFixture();
    const c = oneToOne(f, '+15550003041');
    const reader = readerOver(f);
    expect(reader.yearCounts(c.guid, 'UTC')).toEqual([]);
    expect(() => reader.yearCounts('iMessage;-;+15550003049', 'UTC')).toThrow(
      UnknownChatError,
    );
  });
});

/**
 * The F2c budget: years on a 61,000-row thread (55,000 turns over fifteen
 * years, 6,000 tapbacks) in <= 50 ms, median of five.
 */
describe('yearCounts perf on a 61k-row thread (v2 F2c)', () => {
  const TURNS = 55_000;
  const TAPBACKS = 6_000;
  const BUDGET_MS = 50;
  const RUNS = 5;
  let dir = '';
  let fixture: ChatDbFixture | undefined;
  let reader: IngestChatDbReader | undefined;
  let chatGuid = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-read-years-perf-'));
    const f = createChatDb(join(dir, 'chat.db'));
    fixture = f;
    const c = oneToOne(f, '+15550003101');
    chatGuid = c.guid;
    const handleId = (
      f.db.prepare('SELECT ROWID AS id FROM handle').get() as { id: number }
    ).id;
    const start = appleEpochNs('2012-01-01T00:00:00Z');
    const step = 8_600_000_000_000n; // about 2.4 hours: fifteen years in all
    const insertMessage = f.db.prepare(
      `INSERT INTO message (guid, text, handle_id, service, date, is_from_me,
         associated_message_guid, associated_message_type)
       VALUES (?, ?, ?, 'iMessage', ?, ?, ?, ?)`,
    );
    const insertJoin = f.db.prepare(
      'INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)',
    );
    f.db.transaction(() => {
      for (let i = 0; i < TURNS; i += 1) {
        const date = start + BigInt(i) * step;
        const guid = `YEARS-${String(i)}`;
        const info = insertMessage.run(
          guid,
          `turn ${String(i)}`,
          i % 2 === 0 ? handleId : 0,
          date,
          i % 2,
          null,
          0,
        );
        insertJoin.run(c.chatId, info.lastInsertRowid, date);
        if (i % Math.floor(TURNS / TAPBACKS) === 0 && i / 9 < TAPBACKS) {
          const t = insertMessage.run(
            `YEARS-T-${String(i)}`,
            null,
            handleId,
            date + 1_000_000_000n,
            0,
            `p:0/${guid}`,
            2000,
          );
          insertJoin.run(c.chatId, t.lastInsertRowid, date + 1_000_000_000n);
        }
      }
    })();
    reader = createChatDbReader(f.path, { clock });
  }, 120_000);

  afterAll(() => {
    reader?.close();
    fixture?.close();
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it(`answers in <= ${String(BUDGET_MS)} ms and counts every turn`, () => {
    if (reader === undefined) throw new Error('no reader');
    const r = reader;
    const years = r.yearCounts(chatGuid, 'America/Los_Angeles'); // warm
    expect(years.reduce((n, y) => n + y.count, 0)).toBe(TURNS);
    expect(years.length).toBeGreaterThanOrEqual(15);

    const samples: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = performance.now();
      r.yearCounts(chatGuid, 'America/Los_Angeles');
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const med = samples[Math.floor(samples.length / 2)] ?? Infinity;
    console.info(
      `[perf] yearCounts on ${String(TURNS)} turns: median ${med.toFixed(1)} ms, max ${(samples[samples.length - 1] ?? Infinity).toFixed(1)} ms`,
    );
    expect(med).toBeLessThanOrEqual(BUDGET_MS);
  });
});

/**
 * v2 F4: the A2 budget, restored at the ingest layer. A2's row was "first
 * page <= 150 ms on a 61k-message thread; the per-row attachment read is the
 * perf cliff". It lived in the desktop e2e that S6c deleted, so it returns
 * here, where the SQL runs.
 *
 * One 61,000-row thread (55,000 turns, 6,000 tapbacks, 3,000 attachments),
 * built once for the file. Page 1 and the oldest page each read in 150 ms
 * or less, median of five. The oldest page is the worst case for reactions:
 * every tapback in the chat is newer than it.
 *
 * Plus two structural rows that do not depend on the runner's speed: no
 * page statement scans `message` or `message_attachment_join`, and none of
 * them so much as names `filename`, the column that holds a file's path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appleEpochNs,
  createChatDb,
  type ChatDbFixture,
} from '@wemessage/fixtures';
import {
  CHAT_PAGE_STATEMENTS,
  createChatDbReader,
  type IngestChatDbReader,
} from '@wemessage/ingest';
import type { Clock } from '@wemessage/core';

const TURNS = 55_000;
const TAPBACKS = 6_000;
const ATTACHMENTS = 3_000;
const BUDGET_MS = 150;
const RUNS = 5;

const clock: Clock = {
  now: () => '2026-03-02T12:00:00.000Z',
  nowMs: () => Date.parse('2026-03-02T12:00:00.000Z'),
};

let dir = '';
let fixture: ChatDbFixture | undefined;
let reader: IngestChatDbReader | undefined;
let chatGuid = '';
let oldestUntil = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wm-chat-page-perf-'));
  const f = createChatDb(join(dir, 'chat.db'));
  fixture = f;
  const handleId = f.addHandle('+15550004001');
  const chatId = f.addChat({
    identifier: '+15550004001',
    handleIds: [handleId],
  });
  chatGuid = (
    f.db.prepare('SELECT guid FROM chat WHERE ROWID = ?').get(chatId) as {
      guid: string;
    }
  ).guid;
  const start = appleEpochNs('2025-01-01T00:00:00Z');
  const insertMessage = f.db.prepare(
    `INSERT INTO message (guid, text, handle_id, service, date, is_from_me,
       is_sent, is_delivered, date_delivered, associated_message_guid,
       associated_message_type)
     VALUES (?, ?, ?, 'iMessage', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertJoin = f.db.prepare(
    'INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)',
  );
  const insertAttachment = f.db.prepare(
    `INSERT INTO attachment (guid, filename, uti, mime_type, transfer_name, total_bytes)
     VALUES (?, '~/Library/Messages/Attachments/00/perf.png', 'public.png', 'image/png', ?, 4096)`,
  );
  const insertMaj = f.db.prepare(
    'INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)',
  );
  // Spread evenly over the whole thread, so page 1 and the oldest page
  // both carry some: true on exactly `n` of the `TURNS` turns.
  const spread = (i: number, n: number): boolean =>
    Math.floor((i * n) / TURNS) !== Math.floor(((i + 1) * n) / TURNS);
  f.db.transaction(() => {
    let tapbacks = 0;
    for (let i = 0; i < TURNS; i += 1) {
      const date = start + BigInt(i) * 2_000_000_000n;
      const guid = `PERF-${String(i)}`;
      const fromMe = i % 2 === 1 ? 1 : 0;
      const info = insertMessage.run(
        guid,
        `turn ${String(i)}`,
        fromMe === 1 ? 0 : handleId,
        date,
        fromMe,
        fromMe,
        fromMe,
        fromMe === 1 ? date + 500_000_000n : 0n,
        null,
        0,
      );
      insertJoin.run(chatId, info.lastInsertRowid, date);
      if (spread(i, ATTACHMENTS)) {
        const a = insertAttachment.run(
          `PERF-A-${String(i)}`,
          `perf ${String(i)}.png`,
        );
        insertMaj.run(info.lastInsertRowid, a.lastInsertRowid);
      }
      if (spread(i, TAPBACKS)) {
        const tDate = date + 1_000_000_000n;
        const type = tapbacks % 10 === 9 ? 3000 : 2000 + (tapbacks % 6);
        const t = insertMessage.run(
          `PERF-T-${String(i)}`,
          null,
          handleId,
          tDate,
          0,
          0,
          0,
          0n,
          `p:0/${guid}`,
          type,
        );
        insertJoin.run(chatId, t.lastInsertRowid, tDate);
        tapbacks += 1;
      }
    }
  })();
  // The oldest page: 200 turns ending at turn 199.
  oldestUntil = new Date(
    Number((start + 199n * 2_000_000_000n) / 1_000_000n) + 978_307_200_000,
  ).toISOString();
  reader = createChatDbReader(f.path, { clock });
}, 120_000);

afterAll(() => {
  reader?.close();
  fixture?.close();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

async function medianMs(read: () => Promise<unknown>): Promise<number> {
  await read(); // warm the page cache once, untimed
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    await read();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('readChatPage perf (v2 F4, the A2 budget)', () => {
  it('the fixture is the size the row claims', () => {
    const n = (sql: string): number =>
      (fixture?.db.prepare(sql).get() as { n: number }).n;
    expect(n('SELECT COUNT(*) AS n FROM message')).toBe(TURNS + TAPBACKS);
    expect(n('SELECT COUNT(*) AS n FROM message_attachment_join')).toBe(
      ATTACHMENTS,
    );
  });

  it(`page 1 of a 61k-message thread reads in <= ${String(BUDGET_MS)} ms`, async () => {
    const r = reader;
    if (r === undefined) throw new Error('no reader');
    const page = await r.readChatPage({ chatGuid, limit: 200 });
    expect(page.turns).toHaveLength(200);
    expect(page.turns.some((t) => (t.reactions?.length ?? 0) > 0)).toBe(true);
    expect(page.turns.some((t) => (t.files?.length ?? 0) > 0)).toBe(true);

    const ms = await medianMs(() => r.readChatPage({ chatGuid, limit: 200 }));
    console.info(`[perf] page 1 median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it(`the oldest page, where every tapback is newer, reads in <= ${String(BUDGET_MS)} ms`, async () => {
    const r = reader;
    if (r === undefined) throw new Error('no reader');
    const page = await r.readChatPage({
      chatGuid,
      limit: 200,
      until: oldestUntil,
    });
    expect(page.turns[0]?.guid).toBe('PERF-0');
    expect(page.nextBefore).toBeNull();
    expect(page.turns.some((t) => (t.reactions?.length ?? 0) > 0)).toBe(true);

    const ms = await medianMs(() =>
      r.readChatPage({ chatGuid, limit: 200, until: oldestUntil }),
    );
    console.info(`[perf] oldest page median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET_MS);
  });

  it('EXPLAIN: no page statement scans message or message_attachment_join', () => {
    const db = fixture?.db;
    if (db === undefined) throw new Error('no fixture');
    const params = {
      chatRowid: 1,
      beforeDate: null,
      beforeRowid: null,
      untilNs: null,
      untilSeconds: null,
      limit: 201,
      rowids: '[1,2,3]',
      oldestD: 0,
    };
    const statements = Object.entries(CHAT_PAGE_STATEMENTS);
    expect(statements.map(([name]) => name).sort()).toEqual([
      'files',
      'page',
      'reactions',
    ]);
    for (const [name, sql] of statements) {
      const used = Object.fromEntries(
        Object.entries(params).filter(([k]) => sql.includes(`@${k}`)),
      );
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(used) as {
          detail: string;
        }[]
      ).map((r) => r.detail);
      expect(
        plan.filter((d) =>
          /\bSCAN (m|maj|message|message_attachment_join)\b/.test(d),
        ),
        `${name}: ${plan.join(' | ')}`,
      ).toEqual([]);
    }
  });

  it('arch: no page statement names filename, the column that holds a path', () => {
    for (const [name, sql] of Object.entries(CHAT_PAGE_STATEMENTS)) {
      expect(sql, name).not.toMatch(/filename/i);
    }
  });
});

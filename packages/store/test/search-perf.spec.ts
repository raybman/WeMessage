/**
 * v2 F2a: the search budgets, on a synthetic 530,000-message mirror.
 *
 * Built once for the file, in tmp, by a deterministic generator: nothing
 * here reads ~/Library/Messages. The mirror is written the way every store
 * in the field was, by a build that shipped 0001 and 0002 only, so the
 * first row can time 0003 itself landing on it.
 *
 *   measured                              budget
 *   0003 on a 530k mirror                 <= 3 s
 *   one backfill batch of 2,000 rows      <= 50 ms (median over every batch)
 *   full 530k backfill, summed batch time <= 40 s
 *   index size                            <= 4x the eligible text bytes
 *   rare-term query                       <= 40 ms
 *   common term (30% of rows, cap hit)    <= 300 ms
 *   filter-only query (from:me after:)    <= 60 ms
 *
 * Query rows are the median of five, after one untimed warm-up. The page-2
 * cursor row lives with the cursor, in the daemon's search-routes spec.
 *
 * Plus the EXPLAIN rows, which do not depend on the runner's speed: no
 * term query scans `inbound_messages`, and a filter-only query walks
 * `inbound_sent`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INDEX_BATCH,
  SEARCH_MATCH_CAP,
  type Clock,
  type MirrorQuery,
} from '@wemessage/core';
import { DB_FILENAME, openStore, type SqliteStore } from '@wemessage/store';

const ROWS = 530_000;
const CHATS = 2_000;
const RARE = 'zephyrine';
const COMMON = 'okay';
const RUNS = 5;

const BUDGET = {
  migrateMs: 3_000,
  batchMs: 50,
  backfillMs: 40_000,
  sizeRatio: 4,
  rareMs: 40,
  commonMs: 300,
  filterOnlyMs: 60,
} as const;

const clock: Clock = {
  now: () => '2026-10-10T12:00:00.000Z',
  nowMs: () => Date.parse('2026-10-10T12:00:00.000Z'),
};

const migrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

const WORDS = [
  'lake',
  'dinner',
  'tomorrow',
  'running',
  'late',
  'flight',
  'landed',
  'photos',
  'weekend',
  'call',
  'later',
  'coffee',
  'meeting',
  'moved',
  'thanks',
  'again',
  'kids',
  'school',
  'pickup',
  'traffic',
  'garden',
  'movie',
  'tickets',
  'birthday',
  'party',
  'saturday',
  'train',
  'station',
];

/** Deterministic PRNG, so every run builds the same mirror. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

let dir = '';
let store: SqliteStore | undefined;
let migrateMs = Number.NaN;
let eligibleTextBytes = 0;
let rareCount = 0;
let commonCount = 0;
const batchMs: number[] = [];

function built(): SqliteStore {
  if (store === undefined) throw new Error('no store');
  return store;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wm-search-perf-'));
  const raw = new Database(join(dir, DB_FILENAME));
  raw.pragma('journal_mode = WAL');
  raw.exec(
    'CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
  );
  for (const id of ['0001_init.sql', '0002_thread_state.sql']) {
    raw.exec(readFileSync(join(migrations, id), 'utf8'));
    raw
      .prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
      .run(id, '2026-08-01T00:00:00.000Z');
  }
  const insert = raw.prepare(
    'INSERT INTO inbound_messages (guid, rowid_src, chat_guid, handle, ' +
      'is_from_me, is_group, service, kind, text, sent_at, received_at, ' +
      "edited_at, meta) VALUES (?, ?, ?, ?, ?, 0, 'imessage', ?, ?, ?, ?, NULL, ?)",
  );
  const next = rng(20_261_010);
  const start = Date.parse('2012-01-01T00:00:00.000Z');
  const span = Date.parse('2026-10-01T00:00:00.000Z') - start;
  raw.transaction(() => {
    for (let i = 1; i <= ROWS; i += 1) {
      const chat = Math.floor(next() * CHATS);
      const handle = `+1555${String(1_000_000 + chat).slice(1)}`;
      const r = next();
      const kind =
        r < 0.05
          ? 'tapback'
          : r < 0.08
            ? 'attachment-only'
            : r < 0.1
              ? 'audio'
              : 'text';
      const words: string[] = [];
      const n = 3 + Math.floor(next() * 10);
      for (let w = 0; w < n; w += 1) {
        words.push(WORDS[Math.floor(next() * WORDS.length)] ?? 'lake');
      }
      if (next() < 0.3)
        words.splice(Math.floor(next() * words.length), 0, COMMON);
      if (i % 53_000 === 0) words.push(RARE);
      const text =
        kind === 'attachment-only' && next() < 0.5 ? null : words.join(' ');
      if (kind !== 'tapback' && text !== null) {
        eligibleTextBytes += Buffer.byteLength(text, 'utf8');
        if (text.includes(RARE)) rareCount += 1;
        if (text.includes(COMMON)) commonCount += 1;
      }
      // Sent order is NOT rowid order: jitter by up to a day either way.
      const sentAt = new Date(
        start +
          Math.floor((i / ROWS) * span) +
          Math.floor((next() - 0.5) * 86_400_000 * 2),
      ).toISOString();
      insert.run(
        `PERF-${String(i).padStart(7, '0')}`,
        i,
        `iMessage;-;${handle}`,
        handle,
        next() < 0.5 ? 1 : 0,
        kind,
        text,
        sentAt,
        sentAt,
        kind === 'attachment-only'
          ? '{"tapback":null,"threadOriginatorGuid":null,"attachments":[{"path":"Attachments/00/p.jpg","mimeType":"image/jpeg","bytes":1,"transferName":"p.jpg"}]}'
          : '{"tapback":null,"threadOriginatorGuid":null,"attachments":[]}',
      );
    }
  })();
  raw
    .prepare(
      'INSERT INTO cursor (id, last_rowid, last_scan_at) VALUES (1, ?, ?)',
    )
    .run(ROWS, '2026-10-10T11:59:00.000Z');
  raw.close();

  // Row 1's measurement: this build opening that store runs 0003 once.
  const t0 = performance.now();
  store = openStore({ dir, clock });
  migrateMs = performance.now() - t0;

  // The backfill, exactly as the tick drives it: bounded steps until done.
  for (;;) {
    const t = performance.now();
    const step = built().indexPending(INDEX_BATCH);
    const ms = performance.now() - t;
    if (step.indexed === 0 && step.throughRowid >= ROWS) break;
    batchMs.push(ms);
  }
}, 600_000);

afterAll(() => {
  store?.close();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function medianMs(run: () => unknown): number {
  run(); // warm the page cache once, untimed
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function q(partial: Partial<MirrorQuery>): MirrorQuery {
  return {
    ftsMatch: null,
    shortTerms: [],
    has: [],
    cap: SEARCH_MATCH_CAP,
    ...partial,
  };
}

describe('search perf on a synthetic 530k mirror (v2 F2a)', () => {
  it('the mirror is the size the rows claim', () => {
    const n = (sql: string): number =>
      (built().db.prepare(sql).get() as { n: number }).n;
    expect(n('SELECT COUNT(*) AS n FROM inbound_messages')).toBe(ROWS);
    expect(rareCount).toBe(10);
    expect(commonCount / ROWS).toBeGreaterThan(0.25);
    expect(built().searchCoverage()).toMatchObject({
      indexed: n('SELECT COUNT(*) AS n FROM search_doc'),
      throughRowid: ROWS,
    });
    expect(built().searchCoverage().indexed).toBe(
      built().searchCoverage().eligible,
    );
  });

  it(`0003 lands on a 530k mirror in <= ${String(BUDGET.migrateMs)} ms`, () => {
    console.info(
      `[perf] 0003 on ${String(ROWS)} rows ${migrateMs.toFixed(0)} ms`,
    );
    expect(migrateMs).toBeLessThanOrEqual(BUDGET.migrateMs);
  });

  it(`one backfill batch of ${String(INDEX_BATCH)} rows takes <= ${String(BUDGET.batchMs)} ms`, () => {
    // Every batch walks at most INDEX_BATCH mirror rows, so the walk is a
    // whole number of bounded steps, never one long one.
    expect(batchMs.length).toBeGreaterThanOrEqual(
      Math.ceil(ROWS / INDEX_BATCH),
    );
    const med = median(batchMs);
    const max = Math.max(...batchMs);
    console.info(
      `[perf] backfill batches ${String(batchMs.length)}, median ${med.toFixed(1)} ms, max ${max.toFixed(1)} ms`,
    );
    expect(med).toBeLessThanOrEqual(BUDGET.batchMs);
  });

  it(`the full backfill sums to <= ${String(BUDGET.backfillMs)} ms`, () => {
    const total = batchMs.reduce((a, b) => a + b, 0);
    console.info(`[perf] full backfill ${total.toFixed(0)} ms`);
    expect(total).toBeLessThanOrEqual(BUDGET.backfillMs);
  });

  it(`the index is <= ${String(BUDGET.sizeRatio)}x the eligible text bytes`, () => {
    const bytes = (like: string): number =>
      (
        built()
          .db.prepare(
            'SELECT COALESCE(SUM(pgsize), 0) AS n FROM dbstat WHERE name LIKE ?',
          )
          .get(like) as { n: number }
      ).n;
    const fts = bytes('message_fts%');
    const docMap = bytes('search_doc') + bytes('sqlite_autoindex_search_doc_1');
    const ratio = fts / eligibleTextBytes;
    console.info(
      `[perf] index ${(fts / 1e6).toFixed(1)} MB over ${(eligibleTextBytes / 1e6).toFixed(1)} MB text = ${ratio.toFixed(2)}x; doc map ${(docMap / 1e6).toFixed(1)} MB`,
    );
    expect(ratio).toBeLessThanOrEqual(BUDGET.sizeRatio);
  });

  it(`a rare term answers in <= ${String(BUDGET.rareMs)} ms`, () => {
    const query = q({ ftsMatch: `"${RARE}"` });
    expect(built().searchMirror(query).matches).toHaveLength(rareCount);
    const ms = medianMs(() => built().searchMirror(query));
    console.info(`[perf] rare term median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET.rareMs);
  });

  it(`a common term (30% of rows) hits the cap in <= ${String(BUDGET.commonMs)} ms`, () => {
    const query = q({ ftsMatch: `"${COMMON}"` });
    const r = built().searchMirror(query);
    expect(r.capped).toBe(true);
    expect(r.matches).toHaveLength(SEARCH_MATCH_CAP);
    const ms = medianMs(() => built().searchMirror(query));
    console.info(`[perf] common term median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET.commonMs);
  });

  it(`a filter-only query (from:me after:) answers in <= ${String(BUDGET.filterOnlyMs)} ms`, () => {
    const query = q({ fromMe: true, after: '2025-06-01T00:00:00.000Z' });
    const r = built().searchMirror(query);
    expect(r.matches.length).toBeGreaterThan(1_000);
    expect(r.matches.every((m) => m.isFromMe && m.sentAt >= '2025-06-01')).toBe(
      true,
    );
    const ms = medianMs(() => built().searchMirror(query));
    console.info(`[perf] filter-only median ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET.filterOnlyMs);
  });

  it('EXPLAIN: no term query scans inbound_messages; filter-only walks inbound_sent', () => {
    const s = built();
    const termQueries: MirrorQuery[] = [
      q({ ftsMatch: `"${RARE}"` }),
      q({ ftsMatch: `"${COMMON}"`, fromMe: true, has: ['link'] }),
      q({
        ftsMatch: `"${COMMON}"`,
        shortTerms: ['ok'],
        chatGuids: ['iMessage;-;+15550000001'],
      }),
      q({
        ftsMatch: `"${COMMON}"`,
        handleNeedle: '0001',
        handles: ['+15550000002'],
      }),
      q({
        ftsMatch: `"${COMMON}"`,
        after: '2020-01-01T00:00:00.000Z',
        before: '2021-01-01T00:00:00.000Z',
      }),
    ];
    for (const query of termQueries) {
      const plan = s.explainSearch(query);
      expect(plan.length).toBeGreaterThan(0);
      for (const line of plan) {
        expect(line, JSON.stringify(query)).not.toMatch(
          /^SCAN (m|inbound_messages)\b/u,
        );
      }
    }
    const filterOnly = s.explainSearch(
      q({ fromMe: true, after: '2025-06-01T00:00:00.000Z' }),
    );
    expect(filterOnly.join('\n')).toMatch(/inbound_sent/u);
    expect(filterOnly.join('\n')).not.toMatch(/^SCAN (m|inbound_messages)$/mu);
  });
});

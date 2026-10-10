/**
 * v2 F2b: the page-2 budget, at the route, on a synthetic 530,000-message
 * mirror.
 *
 *   measured                                         budget
 *   GET /v1/search, a common term, page 2 by cursor  <= 300 ms (median of 5)
 *
 * Page 2 is the worst page a cursor can ask for cheaply: the route re-runs
 * the capped query and continues after the cursor's key, so it pays for the
 * whole match set plus the cursor filter. The store spec
 * (packages/store/test/search-perf.spec.ts) holds the query budgets on their
 * own; this row holds the route's work on top of them (parse, compile,
 * facets, coverage, the page, the wire).
 *
 * The mirror is generated in tmp by a deterministic PRNG and written through
 * the store; nothing here reads ~/Library/Messages. The chat.db closures are
 * stubs: titles empty, every guid still held, no `in:` lookup.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INDEX_BATCH,
  SEARCH_MATCH_CAP,
  type Clock,
  type SearchPageWire,
} from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';
import { registerSearchRoutes } from '@wemessage/daemon';

const ROWS = 530_000;
const CHATS = 2_000;
const COMMON = 'okay';
const RUNS = 5;
const BUDGET_PAGE2_MS = 300;

const clock: Clock = {
  now: () => '2026-10-10T12:00:00.000Z',
  nowMs: () => Date.parse('2026-10-10T12:00:00.000Z'),
};

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
let app: FastifyInstance | undefined;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wm-search-route-perf-'));
  const s = openStore({ dir, clock });
  store = s;
  const insert = s.db.prepare(
    'INSERT INTO inbound_messages (guid, rowid_src, chat_guid, handle, ' +
      'is_from_me, is_group, service, kind, text, sent_at, received_at, ' +
      "edited_at, meta) VALUES (?, ?, ?, ?, ?, 0, 'imessage', 'text', ?, ?, ?, NULL, ?)",
  );
  const next = rng(20_261_010);
  const start = Date.parse('2012-01-01T00:00:00.000Z');
  const span = Date.parse('2026-10-01T00:00:00.000Z') - start;
  s.db.transaction(() => {
    for (let i = 1; i <= ROWS; i += 1) {
      const chat = Math.floor(next() * CHATS);
      const handle = `+1555${String(1_000_000 + chat).slice(1)}`;
      const words: string[] = [];
      const n = 3 + Math.floor(next() * 10);
      for (let w = 0; w < n; w += 1) {
        words.push(WORDS[Math.floor(next() * WORDS.length)] ?? 'lake');
      }
      if (next() < 0.3)
        words.splice(Math.floor(next() * words.length), 0, COMMON);
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
        words.join(' '),
        sentAt,
        sentAt,
        '{"tapback":null,"threadOriginatorGuid":null,"attachments":[]}',
      );
    }
  })();
  s.setCursor({ lastRowid: ROWS, lastScanAt: '2026-10-10T11:59:00.000Z' });
  let mark = -1;
  for (;;) {
    const step = s.indexPending(INDEX_BATCH);
    if (step.throughRowid === mark) break;
    mark = step.throughRowid;
  }

  const a = Fastify();
  registerSearchRoutes(a, {
    clock,
    store: s,
    chatTitles: () => new Map(),
    chatsTitled: () => [],
    existingGuids: (guids) => new Set(guids),
  });
  await a.ready();
  app = a;
}, 600_000);

afterAll(async () => {
  await app?.close();
  store?.close();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

async function get(qs: string): Promise<SearchPageWire> {
  if (app === undefined) throw new Error('no app');
  const res = await app.inject({ method: 'GET', url: `/v1/search?${qs}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SearchPageWire;
}

describe('search route perf on a synthetic 530k mirror (v2 F2b)', () => {
  it(`a common term's page 2, by cursor, answers in <= ${String(BUDGET_PAGE2_MS)} ms`, async () => {
    const base = `term=${COMMON}&tz=America%2FLos_Angeles&limit=50`;
    const first = await get(base);
    expect(first.coverage.capped).toBe(true);
    expect(first.total).toBe(SEARCH_MATCH_CAP);
    expect(first.hits).toHaveLength(50);
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const page2 = `${base}&cursor=${encodeURIComponent(cursor ?? '')}`;

    const second = await get(page2); // warm, untimed
    expect(second.hits).toHaveLength(50);
    const firstGuids = new Set(first.hits.map((h) => h.guid));
    expect(second.hits.some((h) => firstGuids.has(h.guid))).toBe(false);

    const samples: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = performance.now();
      await get(page2);
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    const med = samples[Math.floor(samples.length / 2)] ?? Infinity;
    console.info(
      `[perf] route page 2 (common term, ${String(SEARCH_MATCH_CAP)} cap) median ${med.toFixed(1)} ms, max ${(samples[samples.length - 1] ?? Infinity).toFixed(1)} ms`,
    );
    expect(med).toBeLessThanOrEqual(BUDGET_PAGE2_MS);
  });
});

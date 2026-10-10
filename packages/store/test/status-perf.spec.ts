/**
 * v2 F7a: the status budgets the store owns, on a synthetic 530,000-message
 * mirror built once in tmp by a deterministic generator. Nothing here reads
 * ~/Library/Messages.
 *
 *   measured                                         budget
 *   countSentSince, 5,000 rows sent today            <= 2 ms
 *   mirrorCounts (the status recount's store half)   <= 60 ms
 *
 * Median of five after one untimed warm-up. Plus the EXPLAIN rows, which do
 * not depend on the runner's speed: "today" is a covering range count over
 * inbound_sent, and the conversation count is an index skip-scan (one seek
 * per chat), so neither walks the 530k rows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayStartInZone, type Clock } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

const ROWS = 530_000;
const TODAY_ROWS = 5_000;
const CHATS = 2_000;
const RUNS = 5;
const BUDGET = { todayMs: 2, mirrorCountsMs: 60 } as const;

const NOW = '2026-10-10T12:00:00.000Z';
const clock: Clock = { now: () => NOW, nowMs: () => Date.parse(NOW) };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

let dir = '';
let store: SqliteStore | undefined;
let firstSent = '';

function built(): SqliteStore {
  if (store === undefined) throw new Error('no store');
  return store;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wm-status-perf-'));
  store = openStore({ dir, clock });
  const insert = built().db.prepare(
    'INSERT INTO inbound_messages (guid, rowid_src, chat_guid, handle, ' +
      'is_from_me, is_group, service, kind, text, sent_at, received_at, ' +
      "edited_at, meta) VALUES (?, ?, ?, ?, ?, 0, 'imessage', 'text', ?, ?, ?, NULL, ?)",
  );
  const next = rng(20_261_010);
  const start = Date.parse('2014-03-02T08:15:00.000Z');
  const todayStart = Date.parse('2026-10-10T00:00:00.000Z');
  const span = todayStart - 3_600_000 - start;
  const old = ROWS - TODAY_ROWS;
  built().db.transaction(() => {
    for (let i = 1; i <= ROWS; i += 1) {
      const chat = Math.floor(next() * CHATS);
      const handle = `+1555${String(1_000_000 + chat).slice(1)}`;
      const sentMs =
        i <= old
          ? start + Math.floor(((i - 1) / old) * span)
          : todayStart + (i - old) * 5_000;
      const sentAt = new Date(sentMs).toISOString();
      if (i === 1) firstSent = sentAt;
      insert.run(
        `STATUS-${String(i).padStart(7, '0')}`,
        i,
        `iMessage;-;${handle}`,
        handle,
        next() < 0.5 ? 1 : 0,
        'lake dinner tomorrow',
        sentAt,
        // Every row copied "today": the copy-time trap the count must avoid.
        NOW,
        '{"tapback":null,"threadOriginatorGuid":null,"attachments":[]}',
      );
    }
  })();
}, 600_000);

afterAll(() => {
  store?.close();
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function medianMs(run: () => unknown): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    run();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

describe('status perf on a synthetic 530k mirror (v2 F7a)', () => {
  const since = dayStartInZone(new Date(NOW), 'UTC').toISOString();

  it('"today" is a covering range count over inbound_sent', () => {
    const plan = built().explainStatusCounts(since).today.join(' | ');
    expect(plan).toContain('USING COVERING INDEX inbound_sent');
    expect(plan).not.toMatch(/SCAN inbound_messages/);
  });

  it('the conversation count seeks inbound_chat_sent, it never walks it', () => {
    const plan = built().explainStatusCounts(since).chats.join(' | ');
    expect(plan).toContain(
      'USING COVERING INDEX inbound_chat_sent (chat_guid>?)',
    );
    expect(plan).not.toMatch(/SCAN inbound_messages/);
  });

  it(`countSentSince with ${String(TODAY_ROWS)} rows today <= ${String(BUDGET.todayMs)} ms`, () => {
    expect(built().countSentSince(since)).toBe(TODAY_ROWS);
    const ms = medianMs(() => built().countSentSince(since));
    console.info(`[perf] countSentSince ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET.todayMs);
  });

  it(`mirrorCounts on ${String(ROWS)} rows <= ${String(BUDGET.mirrorCountsMs)} ms`, () => {
    const counts = built().mirrorCounts();
    expect(counts.messages).toBe(ROWS);
    expect(counts.chats).toBeLessThanOrEqual(CHATS);
    expect(counts.chats).toBeGreaterThan(CHATS * 0.95);
    expect(counts.historyFrom).toBe(firstSent);
    const ms = medianMs(() => built().mirrorCounts());
    console.info(`[perf] mirrorCounts ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(BUDGET.mirrorCountsMs);
  });
});

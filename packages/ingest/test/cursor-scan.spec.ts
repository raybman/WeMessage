/**
 * Scenario 8 — Cursor scan: incremental, deduped, resumable (spec Part 2 #8;
 * plan §1.3.8 "Dedup on restart", §2.2.1 cursor, §2.3 inbound_messages).
 *
 * Given a fixture DB with 20 messages and a real Store (temp dir) with no
 * cursor, the scan loop emits all 20 in ROWID order, advances
 * cursor.last_rowid to max ROWID, and mirrors them into inbound_messages
 * (minimal mirror; chat.db stays canonical). Appended rows are picked up by a
 * triggered scan (re-open per burst). A rewound cursor re-scans but
 * guid-dedups: zero duplicate emissions, zero duplicate mirror rows.
 * SQLITE_BUSY backs off exponentially 50ms -> 2s (fake sleep), never writes,
 * never holds a long transaction; the reader never opens writable.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { openStore, type SqliteStore } from '@wemessage/store';
import {
  createChatDbReader,
  createScanLoop,
  type ChatDbReaderOptions,
  type IngestChatDbReader,
  type ScanLoop,
} from '@wemessage/ingest';
import type { Clock, Message } from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:00:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

interface Ctx {
  fixture: ChatDbFixture;
  chatId: number;
  handleId: number;
  store: SqliteStore;
  emitted: Message[];
  sleeps: number[];
  opens: number;
  scanner: ScanLoop;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function ctx(
  opts: {
    busyFailures?: number;
    maxBusyRetries?: number;
  } = {},
): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'wm-cursor-scan-'));
  const fixture = createChatDb(join(dir, 'chat.db'));
  const chatId = fixture.addChat({ identifier: '+15555550133' });
  const handleId = fixture.addHandle('+15555550133');
  const store = openStore({ dir: join(dir, 'store'), clock: fakeClock });
  const emitted: Message[] = [];
  const sleeps: number[] = [];
  let busyLeft = opts.busyFailures ?? 0;
  const c: Ctx = {
    fixture,
    chatId,
    handleId,
    store,
    emitted,
    sleeps,
    opens: 0,
    scanner: undefined as unknown as ScanLoop,
  };
  c.scanner = createScanLoop({
    chatDbPath: fixture.path,
    store,
    clock: fakeClock,
    onMessage: (m) => emitted.push(m),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    openReader: (path: string, o: ChatDbReaderOptions): IngestChatDbReader => {
      c.opens += 1;
      if (busyLeft > 0) {
        busyLeft -= 1;
        const err = new Error('database is locked') as Error & {
          code: string;
        };
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      return createChatDbReader(path, o);
    },
    ...(opts.maxBusyRetries !== undefined
      ? { maxBusyRetries: opts.maxBusyRetries }
      : {}),
  });
  cleanups.push(() => {
    store.close();
    fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return c;
}

function seed(c: Ctx, n: number, startAt: string): { guid: string }[] {
  return c.fixture.addMessageBurst(n, {
    chatId: c.chatId,
    handleId: c.handleId,
    startAt,
  });
}

function mirrorGuids(store: SqliteStore): string[] {
  return (
    store.db
      .prepare('SELECT guid FROM inbound_messages ORDER BY rowid_src')
      .all() as { guid: string }[]
  ).map((r) => r.guid);
}

describe('cursor-scan (Scenario 8, §1.3.8 / §2.2.1 / §2.3)', () => {
  it('fresh scan: all 20 emitted in ROWID order, cursor = max ROWID, inbound_messages mirrors them', async () => {
    const c = ctx();
    const refs = seed(c, 20, '2026-01-03T00:00:00Z');
    const out = await c.scanner.scanOnce();

    expect(out.map((m) => m.guid)).toEqual(refs.map((r) => r.guid));
    const rowids = out.map((m) => m.sourceRowid);
    expect([...rowids].sort((a, b) => a - b)).toEqual(rowids);
    expect(c.emitted).toHaveLength(20);

    const cursor = c.store.getCursor();
    expect(cursor?.lastRowid).toBe(Math.max(...rowids));
    expect(cursor?.lastScanAt).toBe(FIXED_NOW);

    expect(mirrorGuids(c.store)).toEqual(refs.map((r) => r.guid));
  });

  it('triggered scan after 5 appended rows emits exactly the 5 new ones (re-open per burst)', async () => {
    const c = ctx();
    seed(c, 20, '2026-01-03T00:00:00Z');
    await c.scanner.scanOnce();
    expect(c.opens).toBe(1);

    const extra = seed(c, 5, '2026-01-03T01:00:00Z');
    const out = await c.scanner.scanOnce();
    expect(c.opens).toBe(2); // fresh reader per scan burst (§2.2.1)
    expect(out.map((m) => m.guid)).toEqual(extra.map((r) => r.guid));
    expect(c.emitted).toHaveLength(25);
    expect(mirrorGuids(c.store)).toHaveLength(25);
  });

  it('rewound cursor re-scans but guid-dedups: zero duplicate emissions, zero duplicate mirror rows', async () => {
    const c = ctx();
    seed(c, 20, '2026-01-03T00:00:00Z');
    await c.scanner.scanOnce();
    const max = c.store.getCursor()?.lastRowid ?? 0;

    // Simulate the §1.3.8 restart re-scan window.
    c.store.setCursor({ lastRowid: max - 10, lastScanAt: FIXED_NOW });
    const out = await c.scanner.scanOnce();

    expect(out).toHaveLength(0);
    expect(c.emitted).toHaveLength(20);
    const counts = c.store.db
      .prepare(
        'SELECT COUNT(*) AS total, COUNT(DISTINCT guid) AS distinctGuids FROM inbound_messages',
      )
      .get() as { total: number; distinctGuids: number };
    expect(counts.total).toBe(20);
    expect(counts.distinctGuids).toBe(20);
    expect(c.store.getCursor()?.lastRowid).toBe(max);
  });

  it('SQLITE_BUSY backs off exponentially from 50ms and recovers', async () => {
    const c = ctx({ busyFailures: 3 });
    const refs = seed(c, 4, '2026-01-03T00:00:00Z');
    const out = await c.scanner.scanOnce();
    expect(c.sleeps).toEqual([50, 100, 200]);
    expect(out.map((m) => m.guid)).toEqual(refs.map((r) => r.guid));
  });

  it('SQLITE_BUSY backoff caps at 2s and gives up after maxBusyRetries with the busy error', async () => {
    const c = ctx({ busyFailures: 100, maxBusyRetries: 8 });
    seed(c, 1, '2026-01-03T00:00:00Z');
    await expect(c.scanner.scanOnce()).rejects.toThrow(/locked|busy/i);
    expect(c.sleeps).toEqual([50, 100, 200, 400, 800, 1600, 2000, 2000]);
  });

  it('non-busy errors are not retried', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-cursor-scan-'));
    const store = openStore({ dir: join(dir, 'store'), clock: fakeClock });
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const sleeps: number[] = [];
    const scanner = createScanLoop({
      chatDbPath: join(dir, 'does-not-exist.db'),
      store,
      clock: fakeClock,
      onMessage: () => {},
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await expect(scanner.scanOnce()).rejects.toThrow();
    expect(sleeps).toEqual([]);
  });

  it('the reader never opens writable: write through the handle fails (§2.2.1)', async () => {
    const c = ctx();
    seed(c, 1, '2026-01-03T00:00:00Z');
    const reader = createChatDbReader(c.fixture.path, { clock: fakeClock });
    cleanups.push(() => reader.close());
    expect(reader.isReadonly()).toBe(true);
    expect(['immutable', 'readonly-fallback']).toContain(reader.openMode);
    expect(() =>
      reader.rawDb.prepare('CREATE TABLE wm_write_probe (x)').run(),
    ).toThrow(/readonly|read.?only|attempt to write/i);
    expect(() => reader.rawDb.prepare('DELETE FROM message').run()).toThrow(
      /readonly|read.?only|attempt to write/i,
    );
  });

  it('scan holds no long transaction on the store and leaves none open', async () => {
    const c = ctx();
    seed(c, 20, '2026-01-03T00:00:00Z');
    await c.scanner.scanOnce();
    expect(c.store.db.inTransaction).toBe(false);
  });
});

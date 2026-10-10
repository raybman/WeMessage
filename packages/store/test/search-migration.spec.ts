/**
 * v2 F2a: 0003_search.sql lands on a store that already has a mirror.
 *
 * Every store in the field was written by a build that shipped 0001 and
 * 0002 only, and every one of them already holds a full mirror of the
 * operator's messages. This row builds exactly that store by hand, then
 * opens it with this build. The index must appear EMPTY (the migration
 * never copies text; the backfill does, on the tick, time-boxed), every
 * mirror row must still be there byte for byte, and the backfill must then
 * make those rows findable.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, MirrorQuery } from '@wemessage/core';
import {
  INDEX_BATCH,
  SEARCH_MATCH_CAP,
  SETTING_SEARCH_INDEXED_THROUGH,
} from '@wemessage/core';
import { DB_FILENAME, openStore } from '@wemessage/store';

const SEEDED_AT = '2026-08-01T00:00:00.000Z';
const OPENED_AT = '2026-09-01T12:00:00.000Z';

function fakeClock(iso: string): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

const migrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

const ROWS = [
  ['g-1', 1, 'text', 'the cabin in 2019'],
  ['g-2', 2, 'tapback', 'Loved “the cabin in 2019”'],
  ['g-3', 3, 'text', 'see you at the lake'],
] as const;

describe('0003_search on a 0002 store with a mirror (v2 F2a)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-f2-migrate-'));
    const raw = new Database(join(dir, DB_FILENAME));
    try {
      raw.pragma('journal_mode = WAL');
      raw.exec(
        'CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
      );
      for (const id of ['0001_init.sql', '0002_thread_state.sql']) {
        raw.exec(readFileSync(join(migrations, id), 'utf8'));
        raw
          .prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
          .run(id, SEEDED_AT);
      }
      const insert = raw.prepare(
        'INSERT INTO inbound_messages (guid, rowid_src, chat_guid, handle, ' +
          'is_from_me, is_group, service, kind, text, sent_at, received_at, ' +
          "edited_at, meta) VALUES (?, ?, 'iMessage;-;+15550100001', " +
          "'+15550100001', 0, 0, 'imessage', ?, ?, ?, ?, NULL, '{}')",
      );
      for (const [guid, rowid, kind, text] of ROWS) {
        insert.run(guid, rowid, kind, text, SEEDED_AT, SEEDED_AT);
      }
      raw
        .prepare(
          'INSERT INTO cursor (id, last_rowid, last_scan_at) VALUES (1, 3, ?)',
        )
        .run(SEEDED_AT);
    } finally {
      raw.close();
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies 0003 once, keeps every mirror row, and starts with an empty index', () => {
    const store = openStore({ dir, clock: fakeClock(OPENED_AT) });
    try {
      expect(
        store.db
          .prepare('SELECT id, applied_at FROM _migrations ORDER BY id')
          .all(),
      ).toEqual([
        { id: '0001_init.sql', applied_at: SEEDED_AT },
        { id: '0002_thread_state.sql', applied_at: SEEDED_AT },
        { id: '0003_search.sql', applied_at: OPENED_AT },
      ]);

      // Every mirror row is intact.
      const rows = store.db
        .prepare(
          'SELECT guid, rowid_src, kind, text FROM inbound_messages ORDER BY rowid_src',
        )
        .all();
      expect(rows).toEqual(
        ROWS.map(([guid, rowid_src, kind, text]) => ({
          guid,
          rowid_src,
          kind,
          text,
        })),
      );

      // The migration copied nothing: no doc, no FTS row, no through-mark.
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM search_doc').get(),
      ).toEqual({ n: 0 });
      expect(store.getSetting(SETTING_SEARCH_INDEXED_THROUGH)).toBeNull();
      expect(store.searchCoverage()).toEqual({
        indexed: 0,
        eligible: 2,
        throughRowid: 0,
        mirrorAsOf: SEEDED_AT,
      });
      const q: MirrorQuery = {
        ftsMatch: '"cabin"',
        shortTerms: [],
        has: [],
        cap: SEARCH_MATCH_CAP,
      };
      expect(store.searchMirror(q).matches).toEqual([]);

      // Secure-delete is on, so an unsent row leaves no bytes in the index.
      const cfg = store.db
        .prepare("SELECT v FROM message_fts_config WHERE k = 'secure-delete'")
        .get() as { v: number } | undefined;
      expect(cfg?.v).toBe(1);

      // The backfill makes the old mirror findable, tapbacks excluded.
      expect(store.indexPending(INDEX_BATCH)).toEqual({
        indexed: 2,
        throughRowid: 3,
      });
      expect(store.searchMirror(q).matches.map((m) => m.guid)).toEqual(['g-1']);
    } finally {
      store.close();
    }

    const again = openStore({
      dir,
      clock: fakeClock('2026-09-03T00:00:00.000Z'),
    });
    try {
      expect(
        again.db.prepare('SELECT COUNT(*) AS n FROM _migrations').get(),
      ).toEqual({ n: 3 });
      expect(again.searchCoverage().indexed).toBe(2);
    } finally {
      again.close();
    }
  });
});

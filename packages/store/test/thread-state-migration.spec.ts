/**
 * v2 F3a: 0002_thread_state.sql lands on a store that already has data.
 *
 * Every store in the field was written by a build that shipped only
 * 0001_init.sql. This row builds exactly that store by hand (0001 applied,
 * `_migrations` stamped with it alone, a contact policy and a draft in it),
 * then opens it with this build. The new table must appear, the runner must
 * stamp 0002 with the injected clock, and every row 0001 held must still be
 * there, byte for byte.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@wemessage/core';
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

describe('0002_thread_state on a 0001-only store (v2 F3a)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-f3-migrate-'));
    const raw = new Database(join(dir, DB_FILENAME));
    try {
      raw.pragma('journal_mode = WAL');
      raw.exec(
        'CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
      );
      raw.exec(readFileSync(join(migrations, '0001_init.sql'), 'utf8'));
      raw
        .prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
        .run('0001_init.sql', SEEDED_AT);
      raw
        .prepare(
          'INSERT INTO contact_policies (handle, display_name, mode, updated_at) ' +
            'VALUES (?, ?, ?, ?)',
        )
        .run('+15550100001', 'Maya', 'draft-only', SEEDED_AT);
      raw
        .prepare(
          "INSERT INTO adapters (id, kind, display_name) VALUES ('echo', 'generic', 'Echo')",
        )
        .run();
      raw
        .prepare(
          `INSERT INTO drafts (id, chat_guid, adapter_id, idempotency_key, body,
             original_body, state_changed_at, expires_at, created_at)
           VALUES ('d1', 'any;-;+15550100001', 'echo', 'k1', 'see you at 3',
             'see you at 3', ?, ?, ?)`,
        )
        .run(SEEDED_AT, SEEDED_AT, SEEDED_AT);
    } finally {
      raw.close();
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies 0002 once, stamped by the clock, and keeps every 0001 row', () => {
    const store = openStore({ dir, clock: fakeClock(OPENED_AT) });
    try {
      const applied = store.db
        .prepare('SELECT id, applied_at FROM _migrations ORDER BY id')
        .all();
      expect(applied).toEqual([
        { id: '0001_init.sql', applied_at: SEEDED_AT },
        { id: '0002_thread_state.sql', applied_at: OPENED_AT },
      ]);

      // The new table is there and empty: rows are lazy, nothing backfills.
      expect(store.listThreadStates()).toEqual([]);

      // The old rows are intact.
      expect(store.getContactPolicy('+15550100001')).toEqual({
        handle: '+15550100001',
        displayName: 'Maya',
        mode: 'draft-only',
        updatedAt: SEEDED_AT,
      });
      const draft = store.getDraft('d1');
      expect(draft?.body).toBe('see you at 3');
      expect(draft?.chatGuid).toBe('any;-;+15550100001');
      expect(draft?.state).toBe('pending');

      // And the new table is usable on the migrated store.
      store.putThreadState({
        chatGuid: 'any;-;+15550100001',
        act: 'done',
        actAt: OPENED_AT,
        snoozedUntil: null,
        attention: null,
      });
      expect(store.getThreadState('any;-;+15550100001')?.act).toBe('done');
    } finally {
      store.close();
    }

    // Reopening applies nothing new.
    const again = openStore({
      dir,
      clock: fakeClock('2026-09-03T00:00:00.000Z'),
    });
    try {
      expect(
        again.db.prepare('SELECT COUNT(*) AS n FROM _migrations').get(),
      ).toEqual({ n: 2 });
      expect(again.getThreadState('any;-;+15550100001')?.act).toBe('done');
    } finally {
      again.close();
    }
  });
});

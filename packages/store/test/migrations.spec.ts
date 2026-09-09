/**
 * Scenario 3 — Store migrations create the §2.3 schema.
 * Spec s1-execution Part 2 Scenario 3; plan §2.3 (`migrations/0001_init.sql`,
 * verbatim) is the authority. Asserts: every table with exact columns
 * (pragma table_info), journal_mode=wal, POSIX file mode 0600, idempotent
 * re-open (no re-apply), and drafts UNIQUE(adapter_id, idempotency_key).
 */
import { readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@wemessage/core';
import {
  DB_FILENAME,
  openStore,
  SchemaNewerThanBuildError,
  type SqliteStore,
} from '@wemessage/store';

/** Fake Clock (§4.0: hand-rolled fakes, no mocking library). */
function fakeClock(iso = '2026-09-01T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Exact §2.3 column contract, in declaration order. */
const EXPECTED_COLUMNS: Record<string, string[]> = {
  settings: ['key', 'value', 'updated_at', 'version'],
  cursor: ['id', 'last_rowid', 'last_scan_at'],
  inbound_messages: [
    'guid',
    'rowid_src',
    'chat_guid',
    'handle',
    'is_from_me',
    'is_group',
    'service',
    'kind',
    'text',
    'sent_at',
    'received_at',
    'edited_at',
    'meta',
  ],
  rules: [
    'id',
    'name',
    'enabled',
    'matcher',
    'adapter_id',
    'respond_mode',
    'schedule_id',
    'outside_window',
    'allow_group_drafts',
    'draft_ttl_minutes',
    'priority',
    'created_at',
    'updated_at',
  ],
  schedules: ['id', 'name', 'timezone', 'windows', 'enabled'],
  contact_policies: ['handle', 'display_name', 'mode', 'updated_at'],
  adapters: [
    'id',
    'kind',
    'display_name',
    'enabled',
    'token_hash',
    'config',
    'last_seen_at',
    'health',
  ],
  drafts: [
    'id',
    'inbound_guid',
    'chat_guid',
    'rule_id',
    'adapter_id',
    'idempotency_key',
    'body',
    'original_body',
    'state',
    'state_changed_at',
    'expires_at',
    'send_not_before',
    'sent_message_guid',
    'proactive_reason',
    'error',
    'created_at',
  ],
  approvals: [
    'id',
    'draft_id',
    'action',
    'actor',
    'batch_id',
    'edited_body',
    'at',
  ],
  send_ledger: [
    'draft_id',
    'attempt',
    'backend',
    'started_at',
    'verified_guid',
    'finished_at',
  ],
  audit_log: ['seq', 'at', 'event', 'actor', 'prev_hash', 'hash'],
  theme_cache: ['message_guid', 'theme', 'confidence', 'model', 'at'],
  rate_counters: ['scope', 'bucket_start', 'count'],
};

describe('store migrations (§2.3 schema)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-store-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates every §2.3 table with the exact columns, in order', () => {
    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      const info = store.db.pragma(`table_info(${table})`) as ColumnInfo[];
      expect(
        info.map((c) => c.name),
        `columns of ${table}`,
      ).toEqual(expected);
    }
    // No §2.3 table is missing and none beyond §2.3 + the runner's ledger exist.
    const tables = (
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' " +
            "AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables.sort()).toEqual(
      [...Object.keys(EXPECTED_COLUMNS), '_migrations'].sort(),
    );
  });

  it('enforces the §2.3 constraints the S1 slices depend on', () => {
    // cursor: single-row CHECK (id = 1)
    store.db
      .prepare(
        "INSERT INTO cursor (id, last_rowid, last_scan_at) VALUES (1, 5, 't')",
      )
      .run();
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO cursor (id, last_rowid, last_scan_at) VALUES (2, 9, 't')",
        )
        .run(),
    ).toThrow(/CHECK/i);

    // audit_log.seq is AUTOINCREMENT (append-only ordering substrate)
    const auditSql = (
      store.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'audit_log'")
        .get() as { sql: string }
    ).sql;
    expect(auditSql).toMatch(/AUTOINCREMENT/);

    // settings defaults: version defaults to 0
    store.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('k', 'v', 't')",
      )
      .run();
    const row = store.db
      .prepare("SELECT version FROM settings WHERE key = 'k'")
      .get() as { version: number };
    expect(row.version).toBe(0);
  });

  it('rejects a duplicate (adapter_id, idempotency_key) draft insert', () => {
    store.db
      .prepare(
        "INSERT INTO adapters (id, kind, display_name) VALUES ('echo', 'generic', 'Echo')",
      )
      .run();
    const insertDraft = store.db.prepare(
      `INSERT INTO drafts (id, chat_guid, adapter_id, idempotency_key, body,
         original_body, state_changed_at, expires_at, created_at)
       VALUES (?, 'c1', 'echo', 'key-1', 'b', 'b', 't', 't', 't')`,
    );
    insertDraft.run('d1');
    expect(() => insertDraft.run('d2')).toThrow(/UNIQUE/i);
  });

  it('sets journal_mode = wal', () => {
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('creates the DB file with POSIX mode 0600', () => {
    const mode = statSync(join(dir, DB_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('re-opening is idempotent: migration is not re-applied', () => {
    // Row survival across re-open proves CREATE TABLE did not run twice
    // (a re-apply would throw "table already exists" or reset state).
    store.setCursor({ lastRowid: 30, lastScanAt: '2026-09-01T12:00:00.000Z' });
    store.close();

    const reopened = openStore({
      dir,
      clock: fakeClock('2026-09-02T00:00:00.000Z'),
    });
    try {
      expect(reopened.getCursor()).toEqual({
        lastRowid: 30,
        lastScanAt: '2026-09-01T12:00:00.000Z',
      });
      const applied = reopened.db
        .prepare('SELECT id, applied_at FROM _migrations ORDER BY id')
        .all() as Array<{ id: string; applied_at: string }>;
      expect(applied).toEqual([
        { id: '0001_init.sql', applied_at: '2026-09-01T12:00:00.000Z' },
      ]);
    } finally {
      reopened.close();
    }
  });

  it('records migration timestamps from the injected Clock, not wall time', () => {
    const applied = store.db
      .prepare('SELECT applied_at FROM _migrations')
      .get() as { applied_at: string };
    expect(applied.applied_at).toBe('2026-09-01T12:00:00.000Z');
  });

  it('refuses to open a store written by a newer build', () => {
    // s9: forward-only cuts both ways. The runner applies what it ships and
    // never looks at what it does not, so a store carrying a migration from a
    // future build opened silently: every shipped migration is already in
    // `_migrations`, the loop is a no-op, and this build then serves a schema
    // it does not understand and writes rows the newer build must reconcile.
    store.setCursor({ lastRowid: 77, lastScanAt: '2026-09-01T12:00:00.000Z' });
    store.db
      .prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
      .run('9999_future.sql', '2027-01-01T00:00:00.000Z');
    store.close();

    expect(() => openStore({ dir, clock: fakeClock() })).toThrow(
      SchemaNewerThanBuildError,
    );
    // Names the id: an operator has to be able to tell WHICH build wrote it.
    expect(() => openStore({ dir, clock: fakeClock() })).toThrow(
      /9999_future\.sql/,
    );

    // The remedy is necessarily raw sqlite: `openStore` is exactly what
    // refuses, so it cannot also be the tool that clears the refusal. That is
    // the point -- the only ways out are running the newer build again or an
    // operator deliberately reaching past the guard.
    const raw = new Database(join(dir, DB_FILENAME));
    try {
      raw
        .prepare('DELETE FROM _migrations WHERE id = ?')
        .run('9999_future.sql');
    } finally {
      raw.close();
    }

    // And the database it refused is byte-for-byte the one it was handed: the
    // check runs before a single migration does, so nothing was written.
    store = openStore({ dir, clock: fakeClock() });
    expect(store.getCursor()).toEqual({
      lastRowid: 77,
      lastScanAt: '2026-09-01T12:00:00.000Z',
    });
  });

  it('ships exactly these migration ids, and they are append-only', () => {
    // The refusal above reads "an id I do not ship is an id a newer build
    // applied". That sentence is only true while ids are immutable once
    // released. Squash `0001_init.sql` into a `0001_base.sql`, or rename it,
    // and every store already in the field claims to come from the future --
    // under a supervisor that restarts on the refusal, so the machine simply
    // stops, and the one line it prints is a lie about which build is newer.
    //
    // Nothing else in the build could have caught that: renaming a file the
    // loader reads by `readdirSync` type-checks, lints, and passes every
    // other row here, because a fresh database does not care what the file
    // was called. So the list is written down. The way past this row is to
    // ADD a file and add its name here; it is not to edit a name.
    const migrations = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../migrations',
    );
    expect(
      readdirSync(migrations)
        .filter((f) => f.endsWith('.sql'))
        .sort(),
    ).toEqual(['0001_init.sql']);
  });
});

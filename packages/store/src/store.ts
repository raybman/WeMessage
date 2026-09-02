import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Clock, CursorState, Message, Store } from '@wemessage/core';
import { applyMigrations } from './migrate.js';

/** Our store filename inside the WeMessage config dir (§2.3). */
export const DB_FILENAME = 'wemessage.db';

export interface OpenStoreOptions {
  /** Directory holding `wemessage.db` (e.g. the WeMessage Application Support dir). */
  dir: string;
  clock: Clock;
}

interface CursorRow {
  last_rowid: number;
  last_scan_at: string;
}
interface SettingRow {
  value: string;
}

/**
 * SQLite-backed `Store` (§2.1). WAL mode, `foreign_keys` on, DB file mode `0600`
 * (§2.3). The raw `db` handle is exposed for wiring and tests; the `Store` port
 * itself (in core) stays free of any better-sqlite3 type (INV-1).
 */
export class SqliteStore implements Store {
  readonly db: Database.Database;
  readonly path: string;
  readonly #clock: Clock;
  readonly #getCursor: Database.Statement;
  readonly #setCursor: Database.Statement;
  readonly #getSetting: Database.Statement;
  readonly #setSetting: Database.Statement;
  readonly #hasInbound: Database.Statement;
  readonly #insertInbound: Database.Statement;

  constructor(opts: OpenStoreOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.path = join(opts.dir, DB_FILENAME);
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    applyMigrations(this.db, opts.clock.now());
    chmodSync(this.path, 0o600);

    this.#clock = opts.clock;
    this.#getCursor = this.db.prepare(
      'SELECT last_rowid, last_scan_at FROM cursor WHERE id = 1',
    );
    this.#setCursor = this.db.prepare(
      'INSERT INTO cursor (id, last_rowid, last_scan_at) VALUES (1, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET last_rowid = excluded.last_rowid, ' +
        'last_scan_at = excluded.last_scan_at',
    );
    this.#getSetting = this.db.prepare(
      'SELECT value FROM settings WHERE key = ?',
    );
    this.#setSetting = this.db.prepare(
      'INSERT INTO settings (key, value, updated_at, version) VALUES (?, ?, ?, 0) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, ' +
        'updated_at = excluded.updated_at, version = settings.version + 1',
    );
    this.#hasInbound = this.db.prepare(
      'SELECT 1 FROM inbound_messages WHERE guid = ?',
    );
    // Idempotent on guid: the §1.3.8 restart re-scan dedup substrate.
    this.#insertInbound = this.db.prepare(
      'INSERT INTO inbound_messages (guid, rowid_src, chat_guid, handle, ' +
        'is_from_me, is_group, service, kind, text, sent_at, received_at, ' +
        'edited_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(guid) DO NOTHING',
    );
  }

  getCursor(): CursorState | null {
    const row = this.#getCursor.get() as CursorRow | undefined;
    return row
      ? { lastRowid: row.last_rowid, lastScanAt: row.last_scan_at }
      : null;
  }

  setCursor(next: CursorState): void {
    this.#setCursor.run(next.lastRowid, next.lastScanAt);
  }

  getSetting(key: string): string | null {
    const row = this.#getSetting.get(key) as SettingRow | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.#setSetting.run(key, value, this.#clock.now());
  }

  hasInboundMessage(guid: string): boolean {
    return this.#hasInbound.get(guid) !== undefined;
  }

  insertInboundMessage(message: Message): void {
    this.#insertInbound.run(
      message.guid,
      message.sourceRowid,
      message.chatGuid,
      message.handle,
      message.isFromMe ? 1 : 0,
      message.isGroup ? 1 : 0,
      message.service,
      message.kind,
      message.text,
      message.sentAt,
      message.receivedAt,
      message.editedAt ?? null,
      JSON.stringify({
        tapback: message.tapback ?? null,
        threadOriginatorGuid: message.threadOriginatorGuid ?? null,
        attachments: message.attachments,
      }),
    );
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(opts: OpenStoreOptions): SqliteStore {
  return new SqliteStore(opts);
}

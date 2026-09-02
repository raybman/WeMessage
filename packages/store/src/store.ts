import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type {
  AttachmentRef,
  Clock,
  CursorState,
  DraftError,
  IsoUtc,
  Message,
  MessageGuid,
  Rule,
  RuleMatcher,
  SendingDraft,
  Store,
  Ulid,
} from '@wemessage/core';
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

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  matcher: string;
  adapter_id: string;
  respond_mode: string;
  schedule_id: string | null;
  outside_window: string;
  allow_group_drafts: number;
  draft_ttl_minutes: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface InboundRow {
  guid: string;
  rowid_src: number;
  chat_guid: string;
  handle: string;
  is_from_me: number;
  is_group: number;
  service: string;
  kind: string;
  text: string | null;
  sent_at: string;
  received_at: string;
  edited_at: string | null;
  meta: string | null;
}

/**
 * Persisted shape of the `rules.matcher` TEXT column. The §2.3 DDL has no
 * `match_attachment_only` column and S2 adds no migration (s2-execution §1.1),
 * so `matchAttachmentOnly` travels "through the JSON matcher column"
 * (s2-execution Part 2 Scenario 5) inside this envelope. Reads also accept a
 * bare `RuleMatcher` object (distinguished by its `kind` key) defensively.
 */
interface MatcherColumn {
  matcher: RuleMatcher;
  matchAttachmentOnly: boolean;
}

function parseMatcherColumn(json: string): MatcherColumn {
  const parsed = JSON.parse(json) as MatcherColumn | RuleMatcher;
  if ('kind' in parsed) {
    return { matcher: parsed, matchAttachmentOnly: false };
  }
  return parsed;
}

function ruleFromRow(row: RuleRow): Rule {
  const col = parseMatcherColumn(row.matcher);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    matcher: col.matcher,
    adapterId: row.adapter_id,
    respondMode: row.respond_mode as Rule['respondMode'],
    scheduleId: row.schedule_id,
    outsideWindow: row.outside_window as Rule['outsideWindow'],
    allowGroupDrafts: row.allow_group_drafts === 1,
    matchAttachmentOnly: col.matchAttachmentOnly,
    draftTtlMinutes: row.draft_ttl_minutes,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface InboundMeta {
  tapback: Message['tapback'] | null;
  threadOriginatorGuid: string | null;
  attachments: AttachmentRef[];
}

/**
 * Rebuild a full `Message` from mirror row + `meta` JSON (s2 Scenario 5:
 * load-bearing for dry-run fidelity). Optional keys are OMITTED, never set to
 * `undefined` (exactOptionalPropertyTypes round-trip fidelity).
 */
function messageFromRow(row: InboundRow): Message {
  const meta: InboundMeta = row.meta
    ? (JSON.parse(row.meta) as InboundMeta)
    : { tapback: null, threadOriginatorGuid: null, attachments: [] };
  return {
    guid: row.guid,
    sourceRowid: row.rowid_src,
    chatGuid: row.chat_guid,
    handle: row.handle,
    isFromMe: row.is_from_me === 1,
    isGroup: row.is_group === 1,
    service: row.service as Message['service'],
    kind: row.kind as Message['kind'],
    text: row.text,
    attachments: meta.attachments,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    ...(row.edited_at !== null ? { editedAt: row.edited_at } : {}),
    ...(meta.tapback ? { tapback: meta.tapback } : {}),
    ...(meta.threadOriginatorGuid
      ? { threadOriginatorGuid: meta.threadOriginatorGuid }
      : {}),
  };
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
  readonly #countInboundSince: Database.Statement;
  readonly #listRules: Database.Statement;
  readonly #getRule: Database.Statement;
  readonly #insertRule: Database.Statement;
  readonly #updateRule: Database.Statement;
  readonly #deleteRule: Database.Statement;
  readonly #listRecentInbound: Database.Statement;
  readonly #getInbound: Database.Statement;
  readonly #updateInbound: Database.Statement;

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
    this.#countInboundSince = this.db.prepare(
      'SELECT COUNT(*) AS n FROM inbound_messages WHERE received_at >= ?',
    );
    // Deterministic order: priority ASC, id ASC tiebreak (s2 §1.5, F-12).
    this.#listRules = this.db.prepare(
      'SELECT * FROM rules ORDER BY priority ASC, id ASC',
    );
    this.#getRule = this.db.prepare('SELECT * FROM rules WHERE id = ?');
    this.#insertRule = this.db.prepare(
      'INSERT INTO rules (id, name, enabled, matcher, adapter_id, ' +
        'respond_mode, schedule_id, outside_window, allow_group_drafts, ' +
        'draft_ttl_minutes, priority, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.#updateRule = this.db.prepare(
      'UPDATE rules SET name = ?, enabled = ?, matcher = ?, adapter_id = ?, ' +
        'respond_mode = ?, schedule_id = ?, outside_window = ?, ' +
        'allow_group_drafts = ?, draft_ttl_minutes = ?, priority = ?, ' +
        'created_at = ?, updated_at = ? WHERE id = ?',
    );
    this.#deleteRule = this.db.prepare('DELETE FROM rules WHERE id = ?');
    this.#listRecentInbound = this.db.prepare(
      'SELECT * FROM inbound_messages ORDER BY received_at DESC LIMIT ?',
    );
    this.#getInbound = this.db.prepare(
      'SELECT * FROM inbound_messages WHERE guid = ?',
    );
    // Edit/unsend refresh (s2 §1.5): full-row refresh in place, guid stable.
    this.#updateInbound = this.db.prepare(
      'UPDATE inbound_messages SET rowid_src = ?, chat_guid = ?, handle = ?, ' +
        'is_from_me = ?, is_group = ?, service = ?, kind = ?, text = ?, ' +
        'sent_at = ?, received_at = ?, edited_at = ?, meta = ? WHERE guid = ?',
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

  countInboundMessagesSince(since: IsoUtc): number {
    const row = this.#countInboundSince.get(since) as { n: number };
    return row.n;
  }

  listSendingDrafts(): SendingDraft[] {
    const rows = this.db
      .prepare(
        'SELECT d.id, d.chat_guid, d.body, l.started_at FROM drafts d ' +
          "LEFT JOIN send_ledger l ON l.draft_id = d.id WHERE d.state = 'sending'",
      )
      .all() as {
      id: string;
      chat_guid: string;
      body: string;
      started_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      chatGuid: r.chat_guid,
      body: r.body,
      ledgerStartedAt: r.started_at,
    }));
  }

  markDraftSent(id: string, sentMessageGuid: string, at: string): void {
    this.db
      .prepare(
        "UPDATE drafts SET state = 'sent', sent_message_guid = ?, state_changed_at = ? WHERE id = ?",
      )
      .run(sentMessageGuid, at, id);
    this.db
      .prepare(
        'UPDATE send_ledger SET verified_guid = ?, finished_at = ? WHERE draft_id = ?',
      )
      .run(sentMessageGuid, at, id);
  }

  markDraftFailed(id: string, error: DraftError, at: string): void {
    this.db
      .prepare(
        "UPDATE drafts SET state = 'failed', error = ?, state_changed_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(error), at, id);
    this.db
      .prepare('UPDATE send_ledger SET finished_at = ? WHERE draft_id = ?')
      .run(at, id);
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

  listRules(): Rule[] {
    return (this.#listRules.all() as RuleRow[]).map(ruleFromRow);
  }

  getRule(id: Ulid): Rule | null {
    const row = this.#getRule.get(id) as RuleRow | undefined;
    return row ? ruleFromRow(row) : null;
  }

  insertRule(rule: Rule): void {
    this.#insertRule.run(
      rule.id,
      rule.name,
      rule.enabled ? 1 : 0,
      serializeMatcherColumn(rule),
      rule.adapterId,
      rule.respondMode,
      rule.scheduleId,
      rule.outsideWindow,
      rule.allowGroupDrafts ? 1 : 0,
      rule.draftTtlMinutes,
      rule.priority,
      rule.createdAt,
      rule.updatedAt,
    );
  }

  updateRule(rule: Rule): void {
    const info = this.#updateRule.run(
      rule.name,
      rule.enabled ? 1 : 0,
      serializeMatcherColumn(rule),
      rule.adapterId,
      rule.respondMode,
      rule.scheduleId,
      rule.outsideWindow,
      rule.allowGroupDrafts ? 1 : 0,
      rule.draftTtlMinutes,
      rule.priority,
      rule.createdAt,
      rule.updatedAt,
      rule.id,
    );
    if (info.changes === 0) {
      throw new Error(`updateRule: no such rule: ${rule.id}`);
    }
  }

  deleteRule(id: Ulid): boolean {
    return this.#deleteRule.run(id).changes > 0;
  }

  listRecentInboundMessages(limit: number): Message[] {
    return (this.#listRecentInbound.all(limit) as InboundRow[]).map(
      messageFromRow,
    );
  }

  getInboundMessage(guid: MessageGuid): Message | null {
    const row = this.#getInbound.get(guid) as InboundRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  updateInboundMessage(message: Message): void {
    this.#updateInbound.run(
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
      message.guid,
    );
  }

  close(): void {
    this.db.close();
  }
}

function serializeMatcherColumn(rule: Rule): string {
  const col: MatcherColumn = {
    matcher: rule.matcher,
    matchAttachmentOnly: rule.matchAttachmentOnly,
  };
  return JSON.stringify(col);
}

export function openStore(opts: OpenStoreOptions): SqliteStore {
  return new SqliteStore(opts);
}

-- migrations/0001_init.sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0            -- bumped on every write; gates re-read
);
CREATE TABLE cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_rowid INTEGER NOT NULL, last_scan_at TEXT NOT NULL
);
CREATE TABLE inbound_messages (               -- minimal mirror; chat.db stays canonical
  guid TEXT PRIMARY KEY, rowid_src INTEGER NOT NULL,
  chat_guid TEXT NOT NULL, handle TEXT NOT NULL,
  is_from_me INTEGER NOT NULL, is_group INTEGER NOT NULL,
  service TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT, sent_at TEXT NOT NULL, received_at TEXT NOT NULL,
  edited_at TEXT, meta TEXT                    -- JSON: tapback target, thread guid, attachments
);
CREATE TABLE rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  matcher TEXT NOT NULL,                       -- JSON RuleMatcher
  adapter_id TEXT NOT NULL, respond_mode TEXT NOT NULL DEFAULT 'draft-only',
  schedule_id TEXT REFERENCES schedules(id),
  outside_window TEXT NOT NULL DEFAULT 'draft-only',
  allow_group_drafts INTEGER NOT NULL DEFAULT 0,
  draft_ttl_minutes INTEGER NOT NULL DEFAULT 240,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE schedules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  timezone TEXT NOT NULL,                      -- IANA, required
  windows TEXT NOT NULL,                       -- JSON ScheduleWindow[]
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE contact_policies (
  handle TEXT PRIMARY KEY,                     -- normalized E.164 or lowercase email
  display_name TEXT, mode TEXT NOT NULL DEFAULT 'draft-only',  -- deny|draft-only|auto
  updated_at TEXT NOT NULL
);
CREATE TABLE adapters (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,     -- sol|hermes|luna|openclaw|generic
  display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  token_hash TEXT,                             -- NULL => adapter disabled (fail closed)
  config TEXT NOT NULL DEFAULT '{}',           -- JSON, per-kind
  last_seen_at TEXT, health TEXT NOT NULL DEFAULT 'unknown'
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, inbound_guid TEXT REFERENCES inbound_messages(guid),
  chat_guid TEXT NOT NULL, rule_id TEXT REFERENCES rules(id),
  adapter_id TEXT NOT NULL REFERENCES adapters(id),
  idempotency_key TEXT NOT NULL,
  body TEXT NOT NULL, original_body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  state_changed_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  send_not_before TEXT, sent_message_guid TEXT,
  proactive_reason TEXT,                       -- set for agent-initiated proposals
  error TEXT,                                  -- JSON {code,message,at}
  created_at TEXT NOT NULL,
  UNIQUE (adapter_id, idempotency_key)         -- dedup for agent retries
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL REFERENCES drafts(id),
  action TEXT NOT NULL,                        -- approve|reject|recall
  actor TEXT NOT NULL,                         -- JSON Actor
  batch_id TEXT, edited_body TEXT, at TEXT NOT NULL
);
CREATE TABLE send_ledger (                     -- replay-send prevention (test T-9.3)
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id),
  attempt INTEGER NOT NULL, backend TEXT NOT NULL,
  started_at TEXT NOT NULL, verified_guid TEXT, finished_at TEXT
);
CREATE TABLE audit_log (                       -- append-only, hash-chained
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, event TEXT NOT NULL,       -- JSON AuditEvent
  actor TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE theme_cache (
  message_guid TEXT NOT NULL, theme TEXT NOT NULL, confidence REAL NOT NULL,
  model TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (message_guid, theme)
);
CREATE TABLE rate_counters (
  scope TEXT NOT NULL, bucket_start TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket_start)            -- scope: 'global' | 'contact:<handle>'
);

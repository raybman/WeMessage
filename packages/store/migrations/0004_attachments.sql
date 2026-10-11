-- v2 F6d: staged outbound files and the content-bound approval.
--
-- staged_files: one row per file the operator staged, keyed by the sha256 of
-- its bytes (the outbox folder is named by the same hash). `removed_at` is
-- set when the housekeeping sweep deletes the bytes; the row is kept, so a
-- draft that sent the file still names what it sent. Staging the same bytes
-- again clears it.
--
-- draft_files: at most one file per draft (D-F6-3). Written only by
-- POST /v1/send, in the same transaction as the draft (D-F6-4: agents cannot
-- attach).
--
-- approval_files: the hash an approval authorised, written in the same
-- transaction as the approval row. At send time the dispatcher requires
-- approval hash = draft hash = hash of the outbox file on disk.
--
-- New tables only, never a change to an earlier one (C-3).
CREATE TABLE staged_files (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  name TEXT NOT NULL CHECK (length(name) > 0),
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  staged_at TEXT NOT NULL,
  removed_at TEXT );
CREATE TABLE draft_files (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id),
  sha256 TEXT NOT NULL REFERENCES staged_files(sha256),
  bound_at TEXT NOT NULL );
CREATE TABLE approval_files (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64) );
CREATE INDEX draft_files_sha ON draft_files(sha256);

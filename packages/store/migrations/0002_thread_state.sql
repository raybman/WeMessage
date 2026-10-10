-- v2 F3 (G-06a): thread state, the daemon's record of Done, Snooze and Mute.
--
-- One row per conversation, written lazily: absence is the default (no act,
-- and an attention mode the client derives, 1:1 queue and group stream), so
-- nothing is backfilled and a record that clears both columns is deleted.
-- Snooze wake is computed on read against the daemon clock; no column here
-- says "awake". A new table, never a change to a 0001 one (C-3).
CREATE TABLE thread_state (
  chat_guid TEXT PRIMARY KEY,
  act TEXT CHECK (act IN ('done','snoozed','muted')),
  act_at TEXT, snoozed_until TEXT,
  attention TEXT CHECK (attention IN ('queue','stream','muted')),
  updated_at TEXT NOT NULL,
  CHECK ((act IS NULL) = (act_at IS NULL)),
  CHECK ((act = 'snoozed') = (snoozed_until IS NOT NULL)) );

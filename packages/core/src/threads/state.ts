// @wemessage/core/threads/state: thread state (v2 F3, G-06a).
//
// The daemon's record of what the operator did to a conversation: Done,
// Snooze or Mute, plus an optional attention mode (06.B). One record per
// conversation, keyed by chat guid, and only when there is something to
// say: a conversation with no record has no act and the attention mode the
// client derives (1:1 queue, group stream).
//
// Snooze wake is NOT stored. It is computed on read against the daemon's
// clock (`snoozedUntil <= now`), so there is no timer, no sweep and no write
// when a snooze ends.
//
// "attention", not "mode": `contact_policies.mode` and `rules.respond_mode`
// already mean the AGENT's mode on the wire, and this is the operator's.

import type { ChatGuid, IsoUtc } from '../domain/types.js';

/** What the operator did. Reading a conversation is never one of these. */
export type ThreadActKind = 'done' | 'snoozed' | 'muted';

/** The 06.B attention mode. Null on a record means "the derived default". */
export type ThreadAttention = 'queue' | 'stream' | 'muted';

export interface ThreadStateRecord {
  chatGuid: ChatGuid;
  act: ThreadActKind | null;
  /** When the act was taken; null exactly when `act` is null. */
  actAt: IsoUtc | null;
  /** RFC 3339 with offset, as the operator chose it; set exactly on a snooze. */
  snoozedUntil: string | null;
  attention: ThreadAttention | null;
  /** Stamped by the store's clock on every write; the concurrency token. */
  updatedAt: IsoUtc;
}

/** What a writer hands the store: everything but the stamp the store adds. */
export type ThreadStateWrite = Omit<ThreadStateRecord, 'updatedAt'>;

/**
 * Is a snoozed conversation due back? Judged against the instant the caller
 * passes, which in the daemon is always `clock.now()`, never wall time.
 */
export function isSnoozeAwake(r: ThreadStateRecord, nowMs: number): boolean {
  return (
    r.act === 'snoozed' &&
    r.snoozedUntil !== null &&
    Date.parse(r.snoozedUntil) <= nowMs
  );
}

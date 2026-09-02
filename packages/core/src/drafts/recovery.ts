/**
 * Startup recovery (T-9.3; §2.5 "cursor + send-ledger recovery before
 * serving"; F-2 resolution): a pure function over the Store / ChatDbReader /
 * SendBackend / Clock ports. S4's full draft transition table must refactor
 * ONTO this (subsume, not bypass).
 *
 * - Cursor: heals a cursor pointing past chat.db head (restored-backup case)
 *   down to max ROWID, and resets torn/corrupt cursor state to 0 (fail safe:
 *   the rescan is absorbed by guid dedup, §1.3.8).
 * - Drafts stuck in 'sending' (§1.3.3 "terminal-bound; reconciled at startup
 *   via send ledger"): verified against chat.db with the §2.2.2 predicate
 *   (is_from_me row, same chat, exact text, date >= started_at) ->
 *   sending->sent with the guid recorded; otherwise sending->failed with
 *   error.code='unverified'. NEVER re-sent: SendBackend is present only so
 *   S4 subsumes this signature; this function must not call it (§4.0).
 * - Outcomes are audited in-memory on the result; the daemon persists them
 *   to audit_log since S2 Scenario 9.
 */
import type { DraftError, IsoUtc, MessageGuid, Ulid } from '../domain/types.js';
import type {
  ChatDbReader,
  Clock,
  SendBackend,
  Store,
} from '../ports/index.js';

export interface StartupRecoveryDeps {
  store: Store;
  reader: ChatDbReader;
  /** Must-not-call in recovery (§4.0 T-9.3); in the signature for S4. */
  sendBackend: SendBackend;
  clock: Clock;
}

export type CursorHealReason = 'ahead-of-chatdb' | 'corrupt';

export interface CursorRecovery {
  healed: boolean;
  reason?: CursorHealReason;
  lastRowid: number;
}

export interface DraftRecoveryOutcome {
  draftId: Ulid;
  outcome: 'sent' | 'failed';
  sentMessageGuid?: MessageGuid;
}

export interface RecoveryAuditEvent {
  event: 'cursor.recovery' | 'draft.recovery';
  at: IsoUtc;
  detail: { draftId?: string; [key: string]: unknown };
}

export interface StartupRecoveryResult {
  cursor: CursorRecovery;
  drafts: DraftRecoveryOutcome[];
  /** In-memory audit trail; persisted by the daemon since S2 Scenario 9. */
  audit: RecoveryAuditEvent[];
}

function isValidRowid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export async function runStartupRecovery(
  deps: StartupRecoveryDeps,
): Promise<StartupRecoveryResult> {
  const { store, reader, clock } = deps;
  const audit: RecoveryAuditEvent[] = [];

  // One full read serves both halves: chat.db head for cursor healing and
  // the §2.2.2 verification corpus for ledger reconciliation.
  const all = await reader.readSince(0);
  const maxRowid = all.reduce((max, m) => Math.max(max, m.sourceRowid), 0);

  const persisted = store.getCursor();
  let cursor: CursorRecovery;
  if (persisted === null) {
    cursor = { healed: false, lastRowid: 0 };
  } else if (!isValidRowid(persisted.lastRowid)) {
    // Torn/corrupt cursor: fail safe to a full rescan (dedup absorbs it).
    store.setCursor({ lastRowid: 0, lastScanAt: clock.now() });
    cursor = { healed: true, reason: 'corrupt', lastRowid: 0 };
  } else if (persisted.lastRowid > maxRowid) {
    // Restored-backup case: cursor points past chat.db head; without the
    // heal, rows appended after the restore would be silently skipped.
    store.setCursor({ lastRowid: maxRowid, lastScanAt: clock.now() });
    cursor = { healed: true, reason: 'ahead-of-chatdb', lastRowid: maxRowid };
  } else {
    cursor = { healed: false, lastRowid: persisted.lastRowid };
  }
  if (cursor.healed) {
    audit.push({
      event: 'cursor.recovery',
      at: clock.now(),
      detail: { reason: cursor.reason, lastRowid: cursor.lastRowid },
    });
  }

  const drafts: DraftRecoveryOutcome[] = [];
  for (const draft of store.listSendingDrafts()) {
    const match = all.find(
      (m) =>
        m.isFromMe &&
        m.chatGuid === draft.chatGuid &&
        m.text === draft.body &&
        (draft.ledgerStartedAt === null || m.sentAt >= draft.ledgerStartedAt),
    );
    if (match !== undefined) {
      store.markDraftSent(draft.id, match.guid, clock.now());
      drafts.push({
        draftId: draft.id,
        outcome: 'sent',
        sentMessageGuid: match.guid,
      });
      audit.push({
        event: 'draft.recovery',
        at: clock.now(),
        detail: {
          draftId: draft.id,
          outcome: 'sent',
          sentMessageGuid: match.guid,
        },
      });
    } else {
      const error: DraftError = {
        code: 'unverified',
        message:
          'send not verified in chat.db during startup recovery (§2.2.2); parked for S4 retry flow',
        at: clock.now(),
      };
      store.markDraftFailed(draft.id, error, clock.now());
      drafts.push({ draftId: draft.id, outcome: 'failed' });
      audit.push({
        event: 'draft.recovery',
        at: clock.now(),
        detail: { draftId: draft.id, outcome: 'failed', code: error.code },
      });
    }
  }

  return { cursor, drafts, audit };
}

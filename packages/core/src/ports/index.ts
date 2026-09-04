/**
 * Port interfaces (§1.5 / §2.1 / §4.0). All seven seam names are locked here in S1
 * even where only a subset is consumed, so implementations never retrofit the seam.
 *
 * §3.2 domain types are verbatim; these port bodies are S1 designs (the plan names
 * the seams, not their signatures). Ranges consumed in S1: Clock, Store (implemented),
 * ChatDbReader/FsWatcher (implemented by ingest — full impl S1 Track A, out of this
 * scope), SendBackend (interface only, must-not-call fake, F-2), AdapterTransport /
 * Classifier (interface declarations only, S5 / S2+).
 */
import type {
  AdapterRecord,
  Approval,
  ChatGuid,
  ContactPolicy,
  Draft,
  DraftError,
  DraftState,
  Handle,
  IsoUtc,
  Message,
  MessageGuid,
  Rule,
  Schedule,
  Service,
  Ulid,
} from '../domain/types.js';

/** Injected time source — "never Date.now in core" (§3.2 GateContext comment). */
export interface Clock {
  /** Wall-clock instant as ISO-8601 UTC (for domain timestamps). */
  now(): IsoUtc;
  /** Monotonic-ish epoch milliseconds for backoff/timers. */
  nowMs(): number;
}

/** Persisted cursor position over chat.db ROWIDs (§2.3 `cursor`). */
export interface CursorState {
  lastRowid: number;
  lastScanAt: IsoUtc;
}

/** Our SQLite store (§2.1, schema §2.3). Implemented by `@wemessage/store`. */
export interface Store {
  getCursor(): CursorState | null;
  setCursor(next: CursorState): void;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  /**
   * s6 Scenario 7. Back to "never set", not to a sentinel value: the circuit
   * breaker's state IS the presence of `send.circuitOpenedAt`, so resuming it
   * has to remove the row rather than write something that means "not open".
   * A sentinel would be a second reading of the same key that every future
   * consumer has to remember. Idempotent — deleting an absent key is a no-op.
   */
  deleteSetting(key: string): void;
  /** §2.3 `inbound_messages` mirror (minimal; chat.db stays canonical). */
  hasInboundMessage(guid: string): boolean;
  /** Idempotent on guid — the §1.3.8 restart re-scan dedup substrate. */
  insertInboundMessage(message: Message): void;
  /** Mirror rows received at/after `since` — F-5 status `counts.messagesToday`. */
  countInboundMessagesSince(since: IsoUtc): number;
  /**
   * s4 Scenario 7 (§1.5 extension): attempts already burned against this
   * draft, 0 when it has never been dispatched. The retry route needs to
   * refuse at the C-10 ceiling BEFORE it moves the draft back to 'approved'
   * — otherwise a retry past the limit parks a draft in 'approved' that the
   * scheduler will pick up and immediately re-fail, which reads to a user
   * as "retry worked" right up until it didn't.
   */
  sendAttemptCount(draftId: Ulid): number;
  /** Drafts stuck in 'sending' + their ledger row (T-9.3 reconciliation). */
  listSendingDrafts(): SendingDraft[];
  /** sending -> sent: records the verified guid on draft + ledger (§2.2.2). */
  markDraftSent(id: Ulid, sentMessageGuid: MessageGuid, at: IsoUtc): void;
  /** sending -> failed (F-2 park, e.g. code 'unverified'); closes the ledger. */
  markDraftFailed(id: Ulid, error: DraftError, at: IsoUtc): void;

  // --- rules (§2.3 `rules`; CRUD surface §3.8; s2-execution §1.5) ---
  /** All rules, priority ASC, id ASC tiebreak (F-12 deterministic order). */
  listRules(): Rule[];
  getRule(id: Ulid): Rule | null;
  insertRule(rule: Rule): void;
  /** Full-row update keyed on id; throws if absent. */
  updateRule(rule: Rule): void;
  /** False when absent. */
  deleteRule(id: Ulid): boolean;

  // --- schedules (§2.3 `schedules`; s6-execution §1.5 body extensions,
  // Scenario 3). The table has existed UNUSED since migration 0001, so this
  // is a body extension and not a migration (F-61: no ALTER TABLE, ever).
  // `rules.schedule_id` is a real FOREIGN KEY onto it, which is what makes
  // the delete path a route-level 409 rather than a caught SQL error. ---
  /** All schedules, id ASC (the `listRules` F-12 deterministic-order rule). */
  listSchedules(): Schedule[];
  /**
   * Null when absent — including for a DANGLING `rules.schedule_id`, which a
   * hand-edited or partially restored database can produce. `null` is the
   * store's honest answer and it means NEVER ARMED at the gate (§2.4.2
   * fail-closed), never "unconstrained".
   */
  getSchedule(id: Ulid): Schedule | null;
  insertSchedule(schedule: Schedule): void;
  /** Full-row update keyed on id; throws if absent (the `updateRule` rule). */
  updateSchedule(schedule: Schedule): void;
  /**
   * Idempotent: deleting an absent id is a no-op, not an error. Deliberately
   * UNGUARDED against referencing rules — callers 409 first (F-75), because
   * the route is the only layer that can say how many rules are in the way.
   * The FK stays underneath as the backstop it is.
   */
  deleteSchedule(id: Ulid): void;
  /**
   * The 409 predicate (F-75). Counts DISABLED referencing rules too: a
   * disabled rule still holds the foreign key, so a count that skipped it
   * would promise a delete SQLite then refuses.
   */
  countRulesUsingSchedule(id: Ulid): number;

  // --- rate counters (§2.3 `rate_counters`; s6 §1.5, Scenario 6) ---
  /**
   * UPSERT `count = count + 1` on the composite PK. `bucketStart` is a
   * minute-floored ISO instant produced by `rateBucketStart` — the store is a
   * ledger of counts and never a source of time (INV: every instant in this
   * system comes from the injected Clock).
   *
   * `scope` is `'global'` or `'contact:<handle>'`, exactly the two shapes
   * `0001_init.sql`'s column comment pins. It is a plain string rather than a
   * union because the contact half is open-ended, and the two call sites that
   * build one (`RATE_SCOPE_GLOBAL`, `contactRateScope`) are the pin.
   */
  bumpRateCounter(scope: string, bucketStart: IsoUtc): void;
  /** Sum of every bucket at or after `sinceInclusive`; 0 when there are none. */
  sumRateCounter(scope: string, sinceInclusive: IsoUtc): number;

  // --- circuit breaker history (s6 §1.5, Scenario 7; F-62 derived) ---
  /**
   * Sent-attempt failures in a window, EXCLUDING gate denials (F-65).
   *
   * Derived from `drafts` rather than stored: a draft parked 'failed' already
   * records both the instant and the cause, so a second ledger would be a
   * second source of truth for a fact we have (F-62 — no new table, column or
   * index; C-8 keeps the repo index-free and a recent-window scan on a
   * single-operator daemon is small).
   *
   * The exclusion is the whole point. A gate denial at the send moment parks a
   * draft 'failed' with `{code:'gate-denied'}` and is indistinguishable in the
   * ledger from a backend that stopped working. Counting it would mean an
   * operator flipping the kill switch trips the breaker, cascading one
   * deliberate action into a fifteen-minute outage — safety turning on more
   * safety. The breaker exists for a BROKEN SEND PATH, and a switch working
   * correctly is not one.
   */
  countSendFailuresSince(sinceInclusive: IsoUtc): number;

  // --- inbound mirror (dry-run replay + mutation visibility; s2 §1.5) ---
  /** received_at DESC, `Message` fully rebuilt from mirror+meta JSON. */
  listRecentInboundMessages(limit: number): Message[];
  getInboundMessage(guid: MessageGuid): Message | null;
  /** Edit/unsend refresh in place (the S1 insert stays DO-NOTHING). */
  updateInboundMessage(message: Message): void;

  // --- audit (§2.3 `audit_log`; §2.4.4; s2 §1.5) ---
  /**
   * Hash-chained append. prev_hash/hash are computed internally with
   * core/audit's pure `chainHash` (F-13 frozen encoding) inside ONE
   * transaction (read-last + insert atomically; the daemon is the single
   * writer, §2.1). The Store exposes NO update/delete path for audit_log —
   * append-only is an API property, not a convention.
   */
  appendAudit(entry: {
    at: IsoUtc;
    eventJson: string;
    actorJson: string;
  }): AuditAppendResult;
  /**
   * F-19 pagination: reverse-chron (seq DESC); `sinceSeq` exclusive lower
   * bound, `sinceAt` inclusive ISO lower bound, `event` exact type filter
   * (the stored event JSON's "type"); filters AND-compose. Route-level
   * default 100 / max 1000 live in the daemon (§1.6 route 8).
   */
  listAudit(filter: {
    sinceSeq?: number;
    sinceAt?: IsoUtc;
    event?: string;
    limit: number;
  }): AuditRow[];
  /** Chain-walk pagination: seq > afterSeq, seq ASC, at most `limit` rows. */
  readAuditRows(afterSeq: number, limit: number): AuditRow[];

  // --- drafts, approvals, send ledger (§2.3; s3-execution §1.5 body
  // extensions, Scenario 5). The §2.3 schema already has every table these
  // need (drafts/approvals/send_ledger/adapters, all S1) — no migration. ---
  /** Insert a new §3.2 `Draft` (verbatim) row. */
  insertDraft(draft: Draft): void;
  /** Null when absent. */
  getDraft(id: Ulid): Draft | null;
  /**
   * Requires an existing draft (FK); records `actor` JSON verbatim (mirrors
   * the audit_log actor convention, F-13).
   */
  insertApproval(approval: Approval): void;
  /**
   * S3 Scenario 6 body extension (spec adaptation: the §1.5 list omitted the
   * read half that §1.7 step 3a requires — "load + validate Approval").
   * The dispatcher's INV-2 validation reads the row back: exists, action
   * 'approve', draftId matches. Null when absent. Without this,
   * `insertApproval` is write-only and approval validation collapses into
   * the draft-state check, which cannot detect a mismatched approval id.
   */
  getApproval(id: Ulid): Approval | null;
  /**
   * approved -> sending: mints the `send_ledger` row and flips draft state.
   *
   * S4 body extension (C-10, plan §1.3.3): when a ledger row already exists
   * for this draft (a failed→approved retry), `attempt` INCREMENTS instead
   * of throwing, to a ceiling of 3 (1 first try + 2 retries). At the ceiling
   * it throws `'retry limit exhausted'` and the caller leaves the draft
   * terminal-`failed`. Signature unchanged.
   * Throws if the draft is not currently 'approved' — most notably a second
   * call on a draft already 'sending' — via a state assertion made INSIDE
   * the same transaction as the write, the persistent backstop against a
   * double-begin racing the in-memory send mutex.
   */
  beginSendAttempt(
    draftId: Ulid,
    backend: string,
    at: IsoUtc,
  ): { attempt: number };
  // --- S4 draft lifecycle + contact ladder (s4-execution §1.5 body
  // extensions, Scenario 3). Additive only; §2.3 already has every table
  // and index these need (drafts UNIQUE(adapter_id, idempotency_key),
  // contact_policies, settings.version) — no migration. ---
  /**
   * Queue + history read (§3.8 filter flags). `contact` filters on the
   * chat_guid's parsed handle; `batchId` joins through approvals. With NO
   * filter this returns the QUEUE: terminal states
   * (sent|rejected|expired|superseded|recalled|failed) are excluded, per
   * §1.3.3 — "expired stays visible in history, excluded from the queue" is
   * a filter default, never a delete. An explicit `state` filter overrides
   * that default (that is how history is read).
   */
  listDrafts(filter?: {
    state?: DraftState;
    ruleId?: Ulid;
    contact?: Handle;
    batchId?: Ulid;
  }): Draft[];
  /**
   * The generalized in-transaction transition (roadmap risk #1). ONE
   * table-driven method: callers pass the transition they already validated
   * against core's pure `applyDraftTransition` table; the store re-asserts
   * `from` INSIDE the transaction and throws on mismatch, so persistence can
   * never drift from the table and two racing transitions cannot both win.
   * Returns the post-transition row.
   */
  applyDraftTransition(input: {
    id: Ulid;
    from: DraftState | DraftState[];
    to: DraftState;
    at: IsoUtc;
    /** Set on approve; explicitly cleared (null) on recall/reject. */
    sendNotBefore?: IsoUtc | null;
    /** Set on failed. */
    error?: DraftError;
    /** Approve-with-edit; `original_body` is never written. */
    body?: string;
  }): Draft;
  /**
   * Body edit, legal only while 'pending' (asserted in-transaction).
   * `original_body` is never written — the pre-edit text is evidence.
   */
  updateDraftBody(id: Ulid, body: string, at: IsoUtc): void;
  /**
   * F-15 closure read path: "did this (adapter, key) already draft?", asked
   * before minting. Survives a store close/reopen — cross-restart dedup is
   * the UNIQUE constraint plus this read, not in-memory state.
   */
  findDraftByIdempotencyKey(adapterId: string, key: string): Draft | null;
  /**
   * The scheduler needs the real approvalId to hand `dispatchApproved`
   * (INV-2: never synthesize an approval). Latest `action:'approve'` row for
   * the draft, or null.
   */
  /**
   * s4 Scenario 5 (deliberate §1.5 extension beyond Scenario 3's list): the
   * full approval history for one draft, oldest first, for
   * `GET /v1/drafts/:id`. Distinct from `latestApproveApproval`, which
   * answers "what authorizes THIS send" — this answers "what happened to
   * this draft," rejects and recalls included.
   */
  listApprovals(draftId: Ulid): Approval[];

  latestApproveApproval(draftId: Ulid): Approval | null;
  /**
   * Grace-elapsed sweep: state='approved' AND send_not_before IS NOT NULL
   * AND send_not_before <= now, oldest first. Direct-send drafts
   * (send_not_before NULL) are structurally excluded (C-2) — without that
   * NULL guard the scheduler would double-dispatch a direct send.
   */
  listGraceElapsed(now: IsoUtc): Array<{ draftId: Ulid; approvalId: Ulid }>;
  /** TTL sweep: state='pending' AND expires_at <= now. */
  listExpiredPending(now: IsoUtc): Draft[];
  /**
   * Kill-flip cancel (§1.3.5): every approved draft still inside its grace
   * (send_not_before IS NOT NULL AND send_not_before > at) → 'rejected' in
   * ONE transaction. Returns the affected rows so the caller can emit the
   * per-draft audit/WS. Drafts whose grace already elapsed are deliberately
   * untouched: they are the scheduler's race to lose, and the mutex-held
   * re-gate denies them anyway.
   */
  cancelGraceApproved(at: IsoUtc, error: DraftError): Draft[];
  /** Derived by joining approvals(batch_id) → drafts.state; no new table. */
  batchReport(batchId: Ulid): {
    sent: number;
    failed: number;
    recalled: number;
    approved: number;
    sending: number;
  };
  // Contact policies (§2.4.3 ladder; handle normalized E.164 / lowercase email).
  getContactPolicy(handle: Handle): ContactPolicy | null;
  /** Upsert keyed on the normalized handle. */
  setContactPolicy(policy: ContactPolicy): void;
  /** Back to unknown (= deny-all). False when the handle had no policy. */
  deleteContactPolicy(handle: Handle): boolean;
  listContactPolicies(): ContactPolicy[];
  /** Per-key write counter (C-7); -1 when the key has never been set. */
  getSettingVersion(key: string): number;

  /**
   * F-22: NULLs `token_hash` on every adapter row that currently has one set
   * (adapter rows themselves are never deleted — audit trail keeps adapter
   * identity). Returns the count of rows actually cleared; the reserved
   * 'human' row (already NULL, §2.6 fail-closed) is never counted.
   */
  // --- s5 §1.5 adapter registry (§2.3 `adapters`; no migration, C-3) ---
  /** Excludes the reserved 'human' row, ordered by id. */
  listAdapters(): AdapterRecord[];
  /** 'human' returns null (F-22 posture): it is a FK anchor, not an adapter. */
  getAdapter(id: string): AdapterRecord | null;
  insertAdapter(a: AdapterRecord): void;
  /** Full-row update; throws when the id is absent. */
  updateAdapter(a: AdapterRecord): void;
  /** Throws `adapter-referenced` while a rule points at it (409 upstream). */
  deleteAdapter(id: string): boolean;
  /**
   * Sets the current hash and, on rotation, parks the outgoing hash with its
   * expiry (F-42, one carry-over slot). `null, null` revokes.
   */
  setAdapterTokenHash(
    id: string,
    hash: string | null,
    prev: { hash: string; expiresAt: IsoUtc } | null,
  ): void;
  /**
   * Rotation done inside the store, because the outgoing hash must move into
   * the carry-over slot without ever being handed to a caller: the hash does
   * not leave here, so neither does the decision about what was live.
   */
  rotateAdapterTokenHash(id: string, hash: string, prevExpiresAt: IsoUtc): void;
  /**
   * Answers "whose token is this", including for a DISABLED adapter — the
   * transport refuses it, and it can only audit the refusal if it knows who.
   * A NULL hash matches nothing, ever (§2.6 fail-closed).
   */
  findAdapterByToken(token: string, now: IsoUtc): AdapterRecord | null;
  setAdapterHealth(
    id: string,
    health: AdapterRecord['health'],
    at: IsoUtc,
  ): void;
  /**
   * Forensic sweep: every row of every table, stringified, filtered by
   * substring. Exists so "the plaintext token is nowhere in the database" can
   * be asserted as a property rather than column by column.
   */
  rawScanForToken(needle: string): string[];

  clearAdapterTokens(): number;

  close(): void;
}

/** A draft in state 'sending' joined with its send-ledger attempt (§2.3). */
export interface SendingDraft {
  id: Ulid;
  chatGuid: ChatGuid;
  body: string;
  /** Ledger `started_at`; null when no ledger row exists. */
  ledgerStartedAt: IsoUtc | null;
}

/** Result of a hash-chained audit append (§2.3 audit_log; s2-execution §1.5). */
export interface AuditAppendResult {
  seq: number;
  hash: string;
}

/**
 * One stored audit_log row (§2.3). `eventJson`/`actorJson` are the TEXT
 * columns VERBATIM — they are the exact bytes that were hashed (F-13:
 * hash-what-is-stored; verification never re-serializes).
 */
export interface AuditRow {
  seq: number;
  at: IsoUtc;
  eventJson: string;
  actorJson: string;
  prevHash: string;
  hash: string;
}

/**
 * Read-only chat.db access (§2.1). Implemented by `@wemessage/ingest`; opens
 * `mode=ro&immutable=1` and never writes.
 */
export interface ChatDbReader {
  /** Normalized messages with ROWID strictly greater than `lastRowid`, ROWID order. */
  readSince(lastRowid: number): Promise<Message[]>;
  /**
   * Rows mutated in place (edit/unsend) strictly after the given watermark
   * (S2 Scenario 8; §1.3.8). `sinceNs` and `mutationNs` are Apple-epoch ns
   * as DECIMAL STRINGS: real values (~8e17) exceed 2^53, so a number here
   * silently conflates adjacent mutations.
   */
  readMutatedSince(sinceNs: string): Promise<MutatedMessage[]>;
  /**
   * S3 §1.5 body extension (Scenario 3): resolve a handle to an existing
   * conversation via chat_handle_join, availability-only (never mints a
   * chat). `null` means no existing conversation, which the send path
   * fails fast as `no-conversation` (§2.2.2) — AppleScript cannot start a
   * new-recipient conversation. Multiple chats sharing one handle resolve
   * to the most-recently-active chat (by last message date).
   */
  resolveChat(
    handle: Handle,
  ): Promise<{ chatGuid: ChatGuid; service: Service; isGroup: boolean } | null>;
  /**
   * S3 §1.5 body extension (Scenario 4): does an outbound copy of this exact
   * text already exist in this chat, at/after `sinceIso`? The read half of
   * post-send verification (§2.2.2 pinned) — the send backend's `accepted`
   * flag is never trusted as proof of delivery; only a real row is. `null`
   * means no match yet (caller keeps polling or gives up on budget).
   */
  findOutboundMessage(q: {
    chatGuid: ChatGuid;
    text: string;
    sinceIso: IsoUtc;
  }): Promise<{ guid: MessageGuid } | null>;
  /**
   * s5 §1.5 body extension (Scenario 6, F-46 — the ONE non-Store port growth
   * this slice takes): the last `limit` turns of a conversation, OLDEST
   * FIRST, both directions.
   *
   * It reads chat.db rather than our `inbound_messages` mirror because the
   * mirror holds inbound only, and an agent that cannot see its own prior
   * replies re-answers the same question forever. `text` is the decoded
   * message text, still RAW — control-stripping happens at the wire boundary
   * with the same sanitizer every other outbound shape uses, not here.
   */
  readChatTurns(q: { chatGuid: ChatGuid; limit: number }): Promise<ChatTurn[]>;
}

/** One prior turn of a conversation ({@link ChatDbReader.readChatTurns}). */
export interface ChatTurn {
  from: 'them' | 'me';
  text: string | null;
  at: IsoUtc;
}

/** One in-place mutation surfaced by {@link ChatDbReader.readMutatedSince}. */
export interface MutatedMessage {
  /** Re-normalized message reflecting the post-mutation row. */
  message: Message;
  /** max(date_edited, date_retracted) for the row, decimal Apple-epoch ns. */
  mutationNs: string;
}

/**
 * Filesystem change source (§4.0). Real impl watches both `chat.db` and
 * `chat.db-wal` (§2.2.1); faked in tests.
 */
export interface FsWatcher {
  /** Begin watching the given paths; returns an unsubscribe function. */
  watch(paths: string[], onChange: () => void): () => void;
}

export interface SendInput {
  chatGuid: ChatGuid;
  body: string;
}

export interface SendOutcome {
  /** True when the backend accepted the send (verification is core's concern). */
  accepted: boolean;
  /**
   * S3 §1.5 body extension: failure vocabulary, a subset of DraftError's
   * codes (§3.2 is verbatim-locked; this is additive to the port, not the
   * locked type). Present only when accepted is false.
   */
  errorCode?: 'messages-not-running' | 'backend-error';
  /** Sanitized stderr tail (home-dir paths stripped, length-capped). */
  detail?: string;
}

/**
 * Outbound send seam (§2.1 sendkit). Interface only in S1 — consumed solely as a
 * must-not-call fake by the T-9.3 recovery path (§1.5, F-2).
 */
export interface SendBackend {
  isAvailable(): Promise<boolean>;
  send(input: SendInput): Promise<SendOutcome>;
}

/** Theme classification seam (§2.1). Interface declaration only in S1 (S2+). */
export interface ThemeScore {
  theme: string;
  confidence: number;
}
export interface Classifier {
  classify(text: string, themes: string[]): Promise<ThemeScore[]>;
}

/**
 * Adapter transport seam (§2.1 / §3.3). Interface declaration only in S1 (S5).
 * Frames are typed in `@wemessage/protocol`; kept `unknown` here to preserve INV-1
 * (core has zero package deps, cannot import protocol).
 */
export interface AdapterTransport {
  send(frame: unknown): Promise<void>;
  onFrame(handler: (frame: unknown) => void): void;
}

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
  Approval,
  ChatGuid,
  Draft,
  DraftError,
  Handle,
  IsoUtc,
  Message,
  MessageGuid,
  Rule,
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
  /** §2.3 `inbound_messages` mirror (minimal; chat.db stays canonical). */
  hasInboundMessage(guid: string): boolean;
  /** Idempotent on guid — the §1.3.8 restart re-scan dedup substrate. */
  insertInboundMessage(message: Message): void;
  /** Mirror rows received at/after `since` — F-5 status `counts.messagesToday`. */
  countInboundMessagesSince(since: IsoUtc): number;
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
   * approved -> sending: mints the `send_ledger` row (attempt 1; S3 specs no
   * retry path, so attempt never advances past 1) and flips draft state.
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
  /**
   * F-22: NULLs `token_hash` on every adapter row that currently has one set
   * (adapter rows themselves are never deleted — audit trail keeps adapter
   * identity). Returns the count of rows actually cleared; the reserved
   * 'human' row (already NULL, §2.6 fail-closed) is never counted.
   */
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

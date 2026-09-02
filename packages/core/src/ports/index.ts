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
  ChatGuid,
  DraftError,
  IsoUtc,
  Message,
  MessageGuid,
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
  /** Drafts stuck in 'sending' + their ledger row (T-9.3 reconciliation). */
  listSendingDrafts(): SendingDraft[];
  /** sending -> sent: records the verified guid on draft + ledger (§2.2.2). */
  markDraftSent(id: Ulid, sentMessageGuid: MessageGuid, at: IsoUtc): void;
  /** sending -> failed (F-2 park, e.g. code 'unverified'); closes the ledger. */
  markDraftFailed(id: Ulid, error: DraftError, at: IsoUtc): void;
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

/**
 * Read-only chat.db access (§2.1). Implemented by `@wemessage/ingest`; opens
 * `mode=ro&immutable=1` and never writes.
 */
export interface ChatDbReader {
  /** Normalized messages with ROWID strictly greater than `lastRowid`, ROWID order. */
  readSince(lastRowid: number): Promise<Message[]>;
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

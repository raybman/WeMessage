export type Ulid = string;
export type MessageGuid = string;          // Apple GUID from chat.db
export type ChatGuid = string;             // e.g. "iMessage;-;+15551234567"
export type Handle = string;               // E.164 phone or lowercase email
export type IsoUtc = string;               // ISO-8601, UTC
export type Service = 'imessage' | 'sms' | 'rcs' | 'unknown';

export interface AttachmentRef {
  path: string; mimeType: string; bytes: number; transferName: string;
}

export interface Message {
  guid: MessageGuid;
  sourceRowid: number;                     // chat.db ROWID (cursor basis)
  chatGuid: ChatGuid;
  handle: Handle;                          // counterparty (sender if inbound)
  isFromMe: boolean;
  isGroup: boolean;
  service: Service;
  kind: 'text' | 'tapback' | 'edit' | 'unsend' | 'audio' | 'attachment-only';
  text: string | null;                     // decoded text OR attributedBody typedstream
  attachments: AttachmentRef[];
  sentAt: IsoUtc;                          // converted from Apple epoch ns
  receivedAt: IsoUtc;
  editedAt?: IsoUtc;
  tapback?: { targetGuid: MessageGuid; type: number };
  threadOriginatorGuid?: MessageGuid;
}

export type RuleMatcher =
  | { kind: 'keyword'; keywords: string[]; mode: 'any' | 'all';
      caseSensitive?: boolean; wholeWord?: boolean }
  | { kind: 'regex'; pattern: string }                      // RE2 subset only
  | { kind: 'theme'; themes: string[]; minConfidence: number }
  | { kind: 'contact'; handles: Handle[] }
  | { kind: 'all-of'; matchers: RuleMatcher[] }
  | { kind: 'any-of'; matchers: RuleMatcher[] };

export type RespondMode = 'draft-only' | 'auto';

export interface Rule {
  id: Ulid; name: string; enabled: boolean;
  matcher: RuleMatcher;
  adapterId: string;                       // which agent drafts
  respondMode: RespondMode;
  scheduleId: Ulid | null;                 // null => always armed
  outsideWindow: 'draft-only' | 'queue' | 'ignore';
  allowGroupDrafts: boolean;               // auto in groups impossible (INV-5)
  matchAttachmentOnly: boolean;
  draftTtlMinutes: number;
  priority: number;                        // lower fires first
  createdAt: IsoUtc; updatedAt: IsoUtc;
}

export type DraftState =
  | 'pending' | 'approved' | 'sending' | 'sent'
  | 'rejected' | 'expired' | 'superseded' | 'recalled' | 'failed';

export interface DraftError { code:
  | 'no-conversation' | 'messages-not-running' | 'unverified'
  | 'backend-error' | 'rate-limited' | 'circuit-open' | 'group-send-disabled'
  // F-30 (s3-execution Scenario 6, coordinator-confirmed): additive per the
  // F-16/F-28 precedent (§2.3 `drafts.error` is uncheck'd JSON; protocol
  // re-exports DraftError type-only, so widening here has zero SQL/wire
  // impact). Dispatch-time gate denial (kill-switch/disconnected/read-only,
  // §2.4.1) parks a draft the backend never saw — none of the seven
  // pre-existing literals describes that. message carries the
  // GateDenyReason verbatim, e.g. "gate denied: kill-switch".
  | 'gate-denied';
  message: string; at: IsoUtc;
}

export interface Draft {
  id: Ulid;
  inboundGuid: MessageGuid | null;         // null for proactive proposals
  chatGuid: ChatGuid;
  ruleId: Ulid | null;                     // null for proactive proposals
  adapterId: string;
  idempotencyKey: string;                  // unique per adapter (agent retries dedup)
  body: string;                            // human-editable while pending
  originalBody: string;                    // agent's untouched text
  proactiveReason?: string;                // shown in queue for proactive drafts
  state: DraftState;
  stateChangedAt: IsoUtc;
  expiresAt: IsoUtc;
  sendNotBefore?: IsoUtc;                  // approval time + undo grace
  sentMessageGuid?: MessageGuid;           // post-send verification result
  error?: DraftError;
  createdAt: IsoUtc;
}

export type Actor =
  | { kind: 'human'; via: 'gui' | 'cli' | 'api' }
  | { kind: 'agent'; adapterId: string }
  | { kind: 'system';
      reason: 'expiry' | 'supersede' | 'kill-switch' | 'circuit-breaker'
            | 'auto-respond' | 'inbound-unsent' | 'disconnect'
            // F-16 (s2-execution Open flags, coordinator-confirmed): additive
            // extension for the persisted audit log's system actors
            // (recovery/ingest/rule-engine events, §2.4.4). No pre-existing
            // variant touched.
            | 'recovery' | 'ingest' | 'rule-engine'
            // F-28 (s3-execution Scenario 7, coordinator-confirmed): additive
            // extension, same precedent as F-16. Probe-driven connection-state
            // flips (§2.2.3) need an actor; nothing pre-existing touched.
            | 'capability-probe' };

export interface Approval {
  id: Ulid; draftId: Ulid;
  action: 'approve' | 'reject' | 'recall';
  actor: Actor;
  batchId?: Ulid;                          // bulk operations share one
  editedBody?: string;
  at: IsoUtc;
}

export type Weekday = 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun';

export interface ScheduleWindow {
  days: Weekday[];
  start: string;                           // "HH:MM" in schedule.timezone
  end: string;                             // end < start wraps past midnight
}

export interface Schedule {
  id: Ulid; name: string;
  timezone: string;                        // IANA, required — never floating
  windows: ScheduleWindow[];               // union = armed
  enabled: boolean;
}

export type ContactMode = 'deny' | 'draft-only' | 'auto';
export interface ContactPolicy {
  handle: Handle; displayName?: string; mode: ContactMode; updatedAt: IsoUtc;
}

// s3-execution Scenario 7, §2.2.3: the doctor engine's derived connection
// state. 'unsupported' (macOS <13) is additive vs. GateContext.settings'
// existing inline 3-value literal below, which Scenario 6 already shipped
// and pins on its own (read-write fail-closed default is 'disconnected';
// 'unsupported' fails closed there too, no gate change needed).
export type ConnectionState =
  | 'fully-connected' | 'read-only' | 'disconnected' | 'unsupported';

export type GateDenyReason =
  | 'kill-switch' | 'disconnected' | 'read-only' | 'contact-denied'
  | 'group-auto-forbidden' | 'outside-window' | 'rate-limited'
  | 'circuit-open' | 'loop-detected' | 'unapproved' | 'adapter-disabled'
  | 'sms-auto-forbidden';

/**
 * s5 Scenario 3 (F-43, additive under the F-16/F-28/F-30 precedent).
 *
 * `hasToken` is a boolean and never the hash: the hash does not leave the
 * store, so no route, DTO or log can leak it by accident. `lastSeenAt` is
 * omitted, not `undefined`, when the column is NULL (exactOptionalPropertyTypes).
 */
export interface AdapterRecord {
  id: string;
  kind: 'sol' | 'hermes' | 'luna' | 'openclaw' | 'echo' | 'generic';
  displayName: string;
  enabled: boolean;
  hasToken: boolean;
  health: 'unknown' | 'connected' | 'disconnected' | 'unhealthy';
  lastSeenAt?: IsoUtc;
  config: Record<string, unknown>;
}

export type GateDecision =
  | { allow: true; mode: RespondMode }
  | { allow: false; reason: GateDenyReason };

export interface GateContext {
  now: IsoUtc;                             // injected Clock (never Date.now in core)
  settings: { killSwitch: boolean; globalMode: RespondMode;
              connectionState: 'fully-connected'|'read-only'|'disconnected';
              allowSmsAuto: boolean };
  rule: Rule | null; schedule: Schedule | null;
  /**
   * F-50 (s5 Scenario 9): this decision is being made ON BEHALF OF AN AGENT
   * rather than a human at the keyboard. Additive and optional, under the
   * F-30 precedent: every pre-existing caller omits it and gets the v1
   * decision byte for byte.
   *
   * It exists because §2.4.3's ladder hangs off `rule !== null`, and a
   * proactive proposal has `ruleId: null` — so without a second way to say
   * "an agent chose this audience" the deny-all default would not bind the
   * one path where an adapter picks who gets written to. It is an ORIGIN
   * FLAG, not an adapter: core still has never heard of one (INV-1).
   */
  agentOrigin?: boolean;
  contact: ContactPolicy | null;           // null => unknown => deny (deny-all default, §1.3.5/§2.4.3)
  message: Pick<Message, 'isGroup' | 'service' | 'handle' | 'chatGuid'>;
  counters: { contactAutoLastHour: number; globalAutoLastHour: number;
              consecutiveAutoInChat: number; circuitOpen: boolean };
}

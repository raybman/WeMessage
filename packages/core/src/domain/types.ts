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
  | 'backend-error' | 'rate-limited' | 'circuit-open' | 'group-send-disabled';
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
            | 'auto-respond' | 'inbound-unsent' | 'disconnect' };

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

export type GateDenyReason =
  | 'kill-switch' | 'disconnected' | 'read-only' | 'contact-denied'
  | 'group-auto-forbidden' | 'outside-window' | 'rate-limited'
  | 'circuit-open' | 'loop-detected' | 'unapproved' | 'adapter-disabled'
  | 'sms-auto-forbidden';

export type GateDecision =
  | { allow: true; mode: RespondMode }
  | { allow: false; reason: GateDenyReason };

export interface GateContext {
  now: IsoUtc;                             // injected Clock (never Date.now in core)
  settings: { killSwitch: boolean; globalMode: RespondMode;
              connectionState: 'fully-connected'|'read-only'|'disconnected';
              allowSmsAuto: boolean };
  rule: Rule | null; schedule: Schedule | null;
  contact: ContactPolicy | null;           // null => unknown => deny (deny-all default, §1.3.5/§2.4.3)
  message: Pick<Message, 'isGroup' | 'service' | 'handle' | 'chatGuid'>;
  counters: { contactAutoLastHour: number; globalAutoLastHour: number;
              consecutiveAutoInChat: number; circuitOpen: boolean };
}

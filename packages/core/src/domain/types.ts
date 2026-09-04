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
            | 'capability-probe'
            // F-72 (s6 Scenario 10), additive under the same precedent. The
            // ONE actor allowed to drive `approved + window-closed ->
            // pending`: when a rule's schedule shuts during an auto
            // approval's grace, the send-moment re-gate returns the draft to
            // the queue instead of failing it. It is not the approver (the
            // machine that approved is not the machine that withdrew), and it
            // is not 'expiry' or 'circuit-breaker' (nothing expired and
            // nothing broke). One reason, one row, one meaning.
            | 'window-closed' };

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
// state. s6 Scenario 11 (F-73) makes GateContext.settings share this exact
// type instead of the narrower inline literal it used to carry, so a Mac on
// macOS <13 is now CARRIED into the gate rather than flattened to
// 'disconnected' on the way in. It is still refused there — 'unsupported' is
// not a GateDenyReason and this slice mints nothing into that taxonomy — but
// the distinction survives as far as the operator-facing ArmingReason below,
// which is the only place a person ever reads it.
export type ConnectionState =
  | 'fully-connected' | 'read-only' | 'disconnected' | 'unsupported';

/**
 * s6 Scenario 11 (§1.7 "Arming"): WHY this daemon may or may not speak on
 * its own right now, in the operator's vocabulary.
 *
 * Deliberately not `GateDenyReason`. The two overlap on four words and
 * diverge on the two that matter: 'armed' is not a denial of anything, and
 * 'unsupported' is a fact about the host rather than a policy the gate can
 * enforce. Everything a person is shown lives here; everything the gate
 * enforces lives there; the mapping between them is written down once, in
 * `resolveArming`, instead of being re-derived by every reader.
 *
 * The order below is the precedence order (§1.3.6): a host that cannot send
 * at all outranks a switch, which outranks a pause, which outranks a
 * schedule, which outranks a breaker.
 */
export type ArmingReason =
  | 'disconnected' | 'read-only' | 'unsupported'
  | 'kill-switch' | 'paused' | 'outside-window' | 'circuit-open'
  | 'armed';

/**
 * The whole posture in three fields, DERIVED on every read and stored
 * nowhere (§1.7). No table has a column called `armed`, which is precisely
 * why a restart cannot resurrect a stale "yes" and no timer can drift out of
 * agreement with it.
 *
 * `until` is the earliest REAL horizon among the pause deadline, the current
 * window's close and the breaker's expiry — independent of which reason won.
 * An operator watching a countdown wants to know when something will next
 * change, not which of several holds happens to own the clock. `null` means
 * nothing bounds the posture: not "unknown", and never a sentinel date.
 */
export interface ArmingState {
  armed: boolean;
  until: IsoUtc | null;
  reason: ArmingReason;
}

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

/**
 * F-64 (s6 Scenario 4), additive under the F-16/F-28/F-30/F-43 precedent.
 *
 * `clampedBy` is how the allow-variant says "allowed, but not autonomously,
 * and here is why". It exists because the gate is ONE pure function called
 * at two moments (§2.4.1), and the two moments disagree only about what a
 * withheld autonomy MEANS: at the draft moment the caller still creates the
 * draft, at the send moment `dispatchApproved` turns the same clamp on an
 * auto approval into a denial. A `moment: 'draft' | 'send'` parameter would
 * let the two drift apart silently; a clamp channel cannot, because both
 * moments read the identical decision.
 *
 * The literal is REUSED from the deny taxonomy rather than given its own
 * union, so a clamp and a deny for the same cause are the same word in two
 * places — which is what makes the audit trail readable. A clamp is never
 * audited as `gate.denied`: nothing was denied and a draft was still
 * produced, and conflating the two would poison the deny counts an operator
 * reads to understand their own system.
 *
 * Omitted, never `undefined`-valued (`exactOptionalPropertyTypes`): callers
 * spread it conditionally, and `'clampedBy' in decision` is a truthful test.
 */
export type GateDecision =
  | { allow: true; mode: RespondMode; clampedBy?: GateDenyReason }
  | { allow: false; reason: GateDenyReason };

/**
 * The three rate caps (§1.7, F-66). Every one is default-on with a floor of
 * 1 applied on read: there is no value that disables any of them, because a
 * cap that can be switched off is a cap that will be, first in a harness and
 * then in production.
 *
 * The two `contact*` caps are PACING — they bound how often the machine
 * speaks to one person, and they count auto-decided sends only. `globalPerHour`
 * is a different kind of number: the blast-radius bound for the whole daemon,
 * counting every send it originates including the ones a human approved. That
 * asymmetry is F-71 and it is deliberate: a bound with an exception is not a
 * bound.
 */
export interface RateCaps {
  /** Auto sends to one handle in a rolling 2 minutes. */
  contactPer2Min: number;
  /** Auto sends to one handle in a rolling hour. */
  contactPerHour: number;
  /** ALL sends this daemon originates, human or auto, in a rolling hour. */
  globalPerHour: number;
}

/**
 * The two loop-breaker limits (§1.7, F-62). Same posture as `RateCaps`:
 * default-on, floored at 1 on read, with no value that disables either.
 *
 * `consecutiveAutoMax` bounds how many times in a row the machine may answer
 * one chat without a person in the loop; `duplicateLookback` bounds how far
 * back the near-duplicate comparison reaches. Both are counts, not durations:
 * the one duration in this mechanism is `LOOP_STREAK_RESET_MS`, and it is a
 * constant rather than a setting because it is a claim about how humans and
 * bots differ, not an operator preference.
 */
export interface LoopLimits {
  /** Consecutive machine turns in one chat before autonomy is withheld. */
  consecutiveAutoMax: number;
  /** How many of our own recent sends a candidate body is compared against. */
  duplicateLookback: number;
}

export interface GateContext {
  now: IsoUtc;                             // injected Clock (never Date.now in core)
  settings: { killSwitch: boolean; globalMode: RespondMode;
              /**
               * s6 Scenario 11 (F-73): widened from the inline 3-value
               * literal Scenario 6 shipped to the full `ConnectionState`, so
               * an 'unsupported' host reaches the gate as itself. The gate
               * denies it under the 'disconnected' literal (a daemon that
               * cannot send is a daemon that cannot send), but flattening it
               * at the READER meant no caller downstream could ever tell an
               * unplugged Mac from an unsupported one.
               */
              connectionState: ConnectionState;
              allowSmsAuto: boolean;
              /**
               * s6 Scenario 11 (F-68): the RAW pause deadline, exactly as it
               * sits in `settings`, or the key omitted when there is no
               * pause. Raw rather than a pre-computed boolean because
               * `readGateSettings` has no clock — the comparison against
               * `now` belongs in `evaluateGate`, where `now` already is —
               * and because a deadline the gate can read is a deadline a
               * crash cannot lose. An unparseable value is treated as a live
               * pause: fail-closed, and always clearable by resuming.
               */
              pausedUntil?: IsoUtc;
              /**
               * s6 Scenario 8 (F-62), additive and optional on the same
               * precedent as `caps` directly below: `readGateSettings`
               * always populates it, and a context that omits it is measured
               * against `DEFAULT_LOOP_LIMITS`, so a forgotten field can only
               * withhold autonomy and never grant it.
               */
              loop?: LoopLimits;
              /**
               * s6 Scenario 6 (F-66), additive and optional under the F-30
               * precedent: `readGateSettings` always populates it, and a
               * context that omits it is evaluated against
               * `DEFAULT_RATE_CAPS` — the strictest shipped values, so a
               * forgotten caps field can only ever withhold autonomy, never
               * grant it.
               */
              caps?: RateCaps };
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
  /**
   * The autonomy history this decision is measured against (§1.7). Every
   * field is a COUNT the caller read from the store, never a store handle:
   * `evaluateGate` stays a pure function of its argument, which is what lets
   * the same function serve the draft moment and the send moment.
   *
   * `globalSentLastHour` counts human-approved sends as well as auto ones
   * (§2.4.3, F-71) — it is named `Sent` rather than `Auto` for exactly that
   * reason, because the two `contactAuto*` fields beside it genuinely do
   * exclude humans and a reader must not have to guess which is which.
   */
  counters: { contactAutoLast2Min: number; contactAutoLastHour: number;
              globalSentLastHour: number;
              consecutiveAutoInChat: number; circuitOpen: boolean };
  /**
   * s6 Scenario 8 (F-62): what we are about to SAY, and the last few things
   * we already said in this chat. Additive and optional under the `caps` /
   * `agentOrigin` precedent.
   *
   * It is a field of its own rather than part of `message` because `message`
   * is the INBOUND one — the thing somebody else wrote — and the near-
   * duplicate check is about our own output. It is optional because at the
   * INBOUND draft moment there is genuinely nothing to compare: no draft
   * body exists yet, so `adapters/dispatch.ts` omits it and only the streak
   * half of the loop breaker can fire there. Sc 9's auto-approval and Sc 10's
   * send-moment re-gate both run after a body exists, and both populate it
   * through `readLoopCandidate`.
   *
   * `recentSentBodies` is raw, not pre-normalised: normalisation is the
   * gate's own business (§1.7), and a caller that normalised for us could
   * silently disagree with the function doing the comparing.
   */
  candidate?: { body: string; recentSentBodies: readonly string[] };
}

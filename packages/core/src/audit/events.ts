/**
 * S2 audit-event vocabulary (s2-execution §1.8; plan §2.4.4 enumerates the
 * full v1 list — S2 ships the events that can occur by S2) + actor helpers.
 *
 * Actors (recorded decisions, s2 §1.8):
 *  - CRUD routes record { kind: 'human', via: 'api' } — the daemon cannot
 *    distinguish CLI from raw API behind the bearer.
 *  - Pipeline/recovery/ingest events record a system actor using the F-16
 *    additive reasons ('recovery' | 'ingest' | 'rule-engine').
 *
 * ---------------------------------------------------------------------------
 * GATE-REASON TAXONOMY PIN (UI §3 S6 + UI §4 item 1 — documentation only in
 * S2; emission lands with the gate in S4, NO_SEND_FRAME with S5 transport).
 * The wireframe's 7-value taxonomy maps onto §3.2 `GateDenyReason` (or its
 * neighbors) as follows — S4/S5 MUST emit against this pinned vocabulary:
 *
 *   wireframe s6        →  domain value
 *   ------------------     -----------------------------------------------
 *   RATE_CAP            →  GateDenyReason 'rate-limited'
 *   OUTSIDE_WINDOW      →  GateDenyReason 'outside-window'
 *   KILL_SWITCH         →  GateDenyReason 'kill-switch'
 *   DENY_CONTACT        →  GateDenyReason 'contact-denied'
 *   LOOP_BREAKER        →  GateDenyReason 'loop-detected'
 *   TTL_EXPIRED         →  not a gate deny: draft expiry (DraftState
 *                          'expired', system actor reason 'expiry')
 *   NO_SEND_FRAME       →  not a gate deny: adapter attempted a send frame
 *                          (structurally impossible, logged as evidence) —
 *                          S5 WS-transport audit event
 * ---------------------------------------------------------------------------
 */
import type {
  Actor,
  Draft,
  DraftError,
  MessageGuid,
  Rule,
  Ulid,
} from '../domain/types.js';
import type { CursorHealReason } from '../drafts/recovery.js';

export type AuditEvent =
  | {
      type: 'rule.matched';
      guid: MessageGuid;
      ruleId: Ulid;
      adapterId: string;
      ruleName: string;
    }
  | { type: 'rule.created'; ruleId: Ulid; rule: Rule } // full rule snapshot
  | { type: 'rule.updated'; ruleId: Ulid; rule: Rule }
  | { type: 'rule.deleted'; ruleId: Ulid }
  | { type: 'rule.enabled'; ruleId: Ulid }
  | { type: 'rule.disabled'; ruleId: Ulid }
  | {
      type: 'ingest.decode-failed'; // S1 deviation #1 (persisted by Scenario 9)
      guid: MessageGuid;
      sourceRowid: number;
      reason: string;
    }
  | { type: 'message.edited'; guid: MessageGuid } // mutation sweep hit
  | { type: 'message.unsent'; guid: MessageGuid }
  | {
      type: 'recovery.cursor'; // persisted S1 F-2 trail
      reason: CursorHealReason;
      lastRowid: number;
    }
  | {
      type: 'recovery.draft';
      draftId: Ulid;
      outcome: 'sent' | 'failed';
      sentMessageGuid?: MessageGuid;
      code?: DraftError['code'];
    }
  // S3 §1.5 audit variants (s3-execution Scenario 5). Shapes echo the plan's
  // §3.4 GatewayEventPayload WS twins where one exists (draft.sent,
  // draft.failed) — a different, unrelated type (that one's the live-event
  // wire frame; this is the persisted, hash-chained record) but there is no
  // reason for the payload fields to diverge.
  | { type: 'draft.created'; draftId: Ulid; draft: Draft } // full snapshot, mirrors rule.created
  | {
      type: 'draft.approved';
      draftId: Ulid;
      approvalId: Ulid;
      actor: Actor;
    }
  | { type: 'send.attempted'; draftId: Ulid; attempt: number; backend: string }
  | { type: 'draft.sent'; draftId: Ulid; sentMessageGuid: MessageGuid }
  | { type: 'draft.failed'; draftId: Ulid; error: DraftError };

export type AuditEventType = AuditEvent['type'];

/** CRUD-route actor (s2 §1.8 recorded decision). */
export function humanApiActor(): Actor {
  return { kind: 'human', via: 'api' };
}

type SystemReason = Extract<Actor, { kind: 'system' }>['reason'];

/** System actor for pipeline/recovery/ingest events (F-16 reasons). */
export function systemActor(reason: SystemReason): Actor {
  return { kind: 'system', reason };
}

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
  ConnectionState,
  ContactMode,
  Draft,
  DraftError,
  DraftState,
  GateDenyReason,
  Handle,
  MessageGuid,
  Rule,
  Ulid,
} from '../domain/types.js';
import type { CursorHealReason } from '../drafts/recovery.js';
import type { DraftEvent } from '../drafts/transitions.js';

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
  | { type: 'draft.failed'; draftId: Ulid; error: DraftError }
  // s3-execution Scenario 7, §2.2.3 (Fable design consult): the doctor
  // engine's only-on-change connection-state flip. Just {from,to} — the
  // full checks/remediation breakdown lives in the DoctorReport returned to
  // the caller, not the persisted audit log.
  | {
      type: 'connection.state-changed';
      from: ConnectionState | null;
      to: ConnectionState;
    }
  // s3-execution Scenario 9 (Fable design consult): the disconnect
  // orchestration's own summary row, distinct from the WS wire event of the
  // same name (`GatewayEventPayload`'s `gateway.disconnected` — a courtesy
  // broadcast, not the persisted record). `connection.state-changed` (above)
  // already covers the fully-connected/read-only -> disconnected transition
  // itself; this row is the "what else happened" ledger entry: how many
  // adapter tokens were revoked and whether the operator also asked to purge.
  | {
      type: 'gateway.disconnected';
      reason: 'user-disconnect';
      revokedAdapterTokens: number;
      purge: boolean;
    }
  // s4-execution §1.7/§1.8 (Part 2 Scenario 2): the pending-draft lifecycle's
  // remaining audit variants. Emission (the daemon actually calling
  // sink.append with these) lands scenario-by-scenario as the routes/
  // scheduler/gate revisions that produce them are built (Sc 4, 5, 6, 8, 9,
  // 10); the vocabulary itself ships now so the transition table (Scenario 2)
  // and its tests have somewhere to land every outcome.
  // s5 Scenario 4: adapter registry lifecycle. Separate variants rather than
  // one 'adapter.changed' with a verb field, matching the rule.* precedent:
  // the audit reader greps for what happened, not for a payload discriminator.
  | { type: 'adapter.created'; adapterId: string; kind: string }
  | {
      type: 'adapter.updated';
      adapterId: string;
      from: { enabled: boolean; displayName: string };
      to: { enabled: boolean; displayName: string };
    }
  | { type: 'adapter.token-rotated'; adapterId: string }
  | { type: 'adapter.deleted'; adapterId: string }
  // s5 Scenario 5: the WS transport's own vocabulary (F-51). `no-send-frame`
  // is deliberately NOT a gate deny — the C-6 taxonomy pin at the top of this
  // file says so in as many words: a send frame is structurally impossible,
  // so an attempt at one is evidence about the adapter, not a decision about
  // a message. Giving it its own variant is what keeps `gate.denied` meaning
  // "the gate said no" rather than "something adapter-ish went wrong".
  | { type: 'adapter.connected'; adapterId: string }
  | {
      type: 'adapter.disconnected';
      adapterId: string;
      reason: 'closed' | 'revoked' | 'unhealthy';
    }
  // `adapterId` is OMITTED, never undefined, when the socket never named a
  // real adapter (exactOptionalPropertyTypes; the row is still written —
  // fail-closed refusals are exactly the ones worth keeping).
  | {
      type: 'adapter.auth-failed';
      adapterId?: string;
      reason: 'unknown-adapter' | 'bad-token' | 'disabled';
    }
  | { type: 'adapter.protocol-violation'; adapterId?: string; reason: string }
  | { type: 'adapter.no-send-frame'; adapterId: string; frameType: string }
  // s5 Scenario 6 (F-45): a rule matched, the adapter is registered, enabled
  // and credentialed — and nobody is on the socket. The request is DROPPED,
  // not queued: replaying yesterday's texts at reconnect would be worse than
  // silence, and this row is what makes the drop visible after the fact.
  // Distinct from `gate.denied` on purpose (C-6): nothing was refused, the
  // agent simply was not there.
  | { type: 'adapter.unreachable'; adapterId: string; guid: MessageGuid }
  // s5 Scenario 8: the return leg could not be delivered. Feedback is
  // best-effort and off the human's critical path, so a wedged or absent
  // adapter costs a log line and nothing else — and there is no outbox, so
  // this row is the ONLY trace that the agent will never learn what happened
  // to its draft. Deliberately not `adapter.unreachable`: that row is about
  // a request we never asked, this one about an answer we could not return.
  | {
      type: 'adapter.feedback-dropped';
      adapterId: string;
      draftId: Ulid;
      kind: string;
    }
  | { type: 'draft.rejected'; draftId: Ulid; approvalId?: Ulid } // human reject or system kill/disconnect/circuit
  | { type: 'draft.recalled'; draftId: Ulid; approvalId: Ulid }
  | { type: 'draft.expired'; draftId: Ulid } // system actor 'expiry', NEVER gate.denied (C-6 taxonomy pin)
  | { type: 'draft.superseded'; draftId: Ulid; supersededBy?: Ulid }
  // s5 Scenario 7: the agent answered and declined to propose anything. The
  // row exists because "the agent said nothing" and "the agent was never
  // asked" are different facts, and only one of them is a bug.
  | { type: 'draft.declined'; adapterId: string; requestId: string }
  | { type: 'draft.edited'; draftId: Ulid; approvalId?: Ulid } // body change only, no state change
  | { type: 'draft.redrafted'; fromDraftId: Ulid; toDraftId: Ulid } // F-40: link lives here, no schema change
  | {
      type: 'draft.illegal-transition';
      draftId: Ulid;
      from: DraftState;
      event: DraftEvent;
    }
  // F-35: audited before the throw. s5 Scenario 6 widens the anchor fields:
  // the first `adapter-disabled` denial happens at DISPATCH time, before any
  // draft exists, so `draftId` becomes optional and the inbound guid +
  // adapter id identify the refusal instead. Additive under the F-16/F-28/
  // F-30 precedent; every pre-existing emitter still writes `draftId`, and
  // (exactOptionalPropertyTypes) an absent one is an OMITTED key, not
  // `undefined`.
  | {
      type: 'gate.denied';
      reason: GateDenyReason;
      draftId?: Ulid;
      guid?: MessageGuid;
      adapterId?: string;
    }
  | { type: 'toggle.changed'; key: string; on: boolean } // kill-switch flips
  | {
      type: 'contact.policy-changed';
      handle: Handle;
      from: ContactMode | null; // null = was unknown (deny-all default)
      to: ContactMode | null; // null = deleted back to unknown
    };

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

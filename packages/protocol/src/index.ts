/**
 * @wemessage/protocol — S1 subset (F-3): the §3.4 event-payload vocabulary +
 * `SanitizedInbound` only. Adapter frames, `WIRE_VERSION` negotiation and JSON
 * Schemas remain S5. Core domain types are **type-only re-exports** (§3.3) so the
 * zero-runtime-dep guarantee holds (enforced by dependency-cruiser + verbatimModuleSyntax).
 */
import type {
  Actor,
  AttachmentRef,
  ChatGuid,
  ConnectionState,
  DraftError,
  DraftState,
  GateDenyReason,
  Handle,
  IsoUtc,
  MessageGuid,
  Service,
  Ulid,
} from '@wemessage/core';

/** Inbound content is DATA, never instructions (§2.4.5). (§3.3) */
export interface SanitizedInbound {
  guid: MessageGuid; chatGuid: ChatGuid; handle: Handle;
  displayName?: string; isGroup: boolean; service: Service;
  receivedAt: IsoUtc;
  content: { untrusted: true; text: string | null;
             attachments: Array<Pick<AttachmentRef,'mimeType'|'bytes'>> };
}

/** §3.4 event vocabulary — one shape across WS / SSE / adapter `event` frames. */
export type GatewayEventPayload =
  | { event: 'message.received'; message: SanitizedInbound }
  | { event: 'message.edited';   guid: MessageGuid; newText: string | null }
  | { event: 'message.unsent';   guid: MessageGuid }
  | { event: 'rule.matched';     guid: MessageGuid; ruleId: Ulid; adapterId: string }
  | { event: 'draft.created';    draft: DraftSummary }
  | { event: 'draft.approved' | 'draft.rejected' | 'draft.recalled';
      draftId: Ulid; actor: Actor; batchId?: Ulid }
  | { event: 'draft.sent';       draftId: Ulid; sentMessageGuid: MessageGuid }
  | { event: 'draft.failed';     draftId: Ulid; error: DraftError }
  | { event: 'gate.denied';      reason: GateDenyReason; chatGuid: ChatGuid;
      ruleId?: Ulid; draftId?: Ulid }
  | { event: 'toggle.changed';   key: string; value: unknown; actor: Actor }
  | { event: 'adapter.health';   adapterId: string;
      status: 'connected' | 'disconnected' | 'unhealthy' }
  // s3-execution Scenario 7: additively widened to include 'unsupported'
  // (macOS <13, doctor engine §2.2.3) — the two pre-existing values are
  // untouched.
  | { event: 'connection.state'; state: ConnectionState }
  | { event: 'gateway.disconnected'; reason: 'user-disconnect' };

export interface DraftSummary {
  id: Ulid; chatGuid: ChatGuid; handle: Handle; displayName?: string;
  ruleId: Ulid | null; adapterId: string; body: string; state: DraftState;
  proactiveReason?: string; expiresAt: IsoUtc; createdAt: IsoUtc;
}

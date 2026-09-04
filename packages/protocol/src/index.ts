/**
 * @wemessage/protocol — S1 subset (F-3): the §3.4 event-payload vocabulary +
 * `SanitizedInbound` only. Adapter frames, `WIRE_VERSION` negotiation and JSON
 * Schemas remain S5. Core domain types are **type-only re-exports** (§3.3) so the
 * zero-runtime-dep guarantee holds (enforced by dependency-cruiser + verbatimModuleSyntax).
 */
import type {
  Actor,
  ArmingReason,
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
  // s5 Scenario 7 (F-44): THE one protocol addition of this slice. A
  // streaming preview has to reach `wemessage watch`, and the client bus had
  // no frame for it. Nothing here is persisted — the draft exists only once
  // `draft.submit` lands, so a preview may legitimately evaporate.
  | { event: 'draft.delta';      correlation: Correlation; seq: number;
      textDelta: string }
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
  // s6 Scenario 11 (F-67): THE one protocol addition of this slice, and the
  // `connection.state` twin one line up — same shape of fact (a posture an
  // operator's screen is showing), same on-change-only discipline, so a
  // subscriber can render an arming badge without polling `/v1/status`.
  //
  // The reason is the `ArmingReason` TYPE rather than the literals spelled
  // out. Two of that union's words are also gate deny literals that
  // `test/arch.spec.ts` (g) tracks by file, and a vocabulary copy here would
  // put them in a third home for no gain — this file included, which is why
  // even this comment declines to name them. The union is defined once in
  // core and this is the same set by construction.
  | { event: 'arming.changed'; armed: boolean; until: IsoUtc | null;
      reason: ArmingReason }
  | { event: 'gateway.disconnected'; reason: 'user-disconnect' };

export interface DraftSummary {
  id: Ulid; chatGuid: ChatGuid; handle: Handle; displayName?: string;
  ruleId: Ulid | null; adapterId: string; body: string; state: DraftState;
  proactiveReason?: string; expiresAt: IsoUtc; createdAt: IsoUtc;
}

/* ------------------------------------------------------------------------ *
 * s5 Scenario 2 — the §3.3 adapter wire, version 1.
 *
 * Everything below is types plus hand-written guards. No schema validator is
 * imported: `protocol-zero-runtime-deps` is a live dependency-cruiser rule,
 * and the JSON Schemas in `src/schemas/` exist for third parties, not for us.
 * The parity test pins the two representations to each other so the schema a
 * stranger validates against cannot drift from the guard we enforce.
 *
 * There is no send frame, and there never will be. An adapter drafts; a human
 * approves; the daemon sends (INV-2).
 * ------------------------------------------------------------------------ */

export const WIRE_VERSION = 1;

/** Every frame on the wire is exactly these five keys. */
export interface Envelope<T extends string, P> {
  v: number;
  id: string;
  type: T;
  ts: IsoUtc;
  payload: P;
}

/**
 * Ties a frame to the request that caused it. `draftId` appears only once a
 * draft exists, and is OMITTED before then — never `undefined`-valued, which
 * JSON would drop on the wire and break round-trip equality.
 */
export interface Correlation {
  requestId: string;
  chatGuid: ChatGuid;
  inboundGuid?: MessageGuid;
  draftId?: Ulid;
}

/** Prior conversation, oldest-first, so an agent does not re-answer itself. */
export interface ConversationTurn {
  from: 'them' | 'me';
  text: string | null;
  at: IsoUtc;
}

export type HelloFrame = Envelope<
  'hello',
  { adapterId: string; token: string; wire: number; features?: string[] }
>;

export type DraftRequestFrame = Envelope<
  'draft.request',
  {
    correlation: Correlation;
    message: SanitizedInbound;
    context: ConversationTurn[];
    rule: { id: Ulid; name: string; respondMode: string };
    constraints: { maxChars: number; deadlineMs: number };
  }
>;

export type DraftSubmitFrame = Envelope<
  'draft.submit',
  {
    correlation: Correlation;
    idempotencyKey: string;
    body?: string;
    declined?: boolean;
    confidence?: number;
  }
>;

export type DraftDeltaFrame = Envelope<
  'draft.delta',
  { correlation: Correlation; seq: number; textDelta: string }
>;

export type FeedbackKind =
  | 'draft_rejected'
  | 'draft_expired'
  | 'draft_edited'
  | 'send_verified'
  | 'send_failed'
  | 'draft_recalled';

export type DraftFeedbackFrame = Envelope<
  'draft.feedback',
  {
    correlation: Correlation;
    kind: FeedbackKind;
    actor: Actor;
    reason?: string;
    finalBody?: string;
    error?: DraftError;
  }
>;

export type ProactiveProposeFrame = Envelope<
  'proactive.propose',
  {
    idempotencyKey: string;
    target: { chatGuid?: ChatGuid; handle?: Handle };
    body: string;
    reason: string;
  }
>;

export type EventFrame = Envelope<'event', GatewayEventPayload>;
export type PingFrame = Envelope<'ping', Record<string, never>>;
export type PongFrame = Envelope<'pong', Record<string, never>>;

/** Agent → gateway. Nothing here reaches the send path. */
export type AgentToGateway =
  | HelloFrame
  | DraftSubmitFrame
  | DraftDeltaFrame
  | ProactiveProposeFrame
  | PongFrame;

/** Gateway → agent. */
export type GatewayToAgent =
  | DraftRequestFrame
  | DraftFeedbackFrame
  | EventFrame
  | PingFrame;

export type Frame = AgentToGateway | GatewayToAgent;

export interface FrameSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly direction: 'agent->gateway' | 'gateway->agent';
}

/**
 * The single source of truth for frame shape. The guards read it, the schema
 * parity test reads it, and the JSON Schemas are checked against it.
 */
export const FRAME_SPECS = {
  hello: {
    required: ['adapterId', 'token', 'wire'],
    optional: ['features'],
    direction: 'agent->gateway',
  },
  'draft.submit': {
    required: ['correlation', 'idempotencyKey'],
    optional: ['body', 'declined', 'confidence'],
    direction: 'agent->gateway',
  },
  'draft.delta': {
    required: ['correlation', 'seq', 'textDelta'],
    optional: [],
    direction: 'agent->gateway',
  },
  'proactive.propose': {
    required: ['idempotencyKey', 'target', 'body', 'reason'],
    optional: [],
    direction: 'agent->gateway',
  },
  pong: { required: [], optional: [], direction: 'agent->gateway' },
  'draft.request': {
    required: ['correlation', 'message', 'context', 'rule', 'constraints'],
    optional: [],
    direction: 'gateway->agent',
  },
  'draft.feedback': {
    required: ['correlation', 'kind', 'actor'],
    optional: ['reason', 'finalBody', 'error'],
    direction: 'gateway->agent',
  },
  // `event` carries the §3.4 vocabulary, whose variants each bring their own
  // keys. Rather than opening the frame to arbitrary properties, the optional
  // list is the union of every key any variant can contribute: still a closed
  // set, and it changes only when the vocabulary does.
  event: {
    required: ['event'],
    optional: [
      'message',
      'guid',
      'newText',
      'ruleId',
      'adapterId',
      'draft',
      'draftId',
      'actor',
      'batchId',
      'sentMessageGuid',
      'error',
      'reason',
      'chatGuid',
      'key',
      'value',
      'status',
      'state',
      // s5 Scenario 7 (F-44): the `draft.delta` vocabulary variant's keys.
      'correlation',
      'seq',
      'textDelta',
      // s6 Scenario 11 (F-67): the `arming.changed` variant's own two keys.
      // Its `reason` is the pre-existing entry four lines up — the same word
      // the `gate.denied` and `gateway.disconnected` variants already use,
      // which is what keeps this a closed set rather than a growing one.
      'armed',
      'until',
    ],
    direction: 'gateway->agent',
  },
  ping: { required: [], optional: [], direction: 'gateway->agent' },
} as const satisfies Record<string, FrameSpec>;

export type FrameType = keyof typeof FRAME_SPECS;

export const FRAME_TYPES = Object.keys(FRAME_SPECS) as FrameType[];

export type ParseError =
  | { kind: 'envelope' }
  | { kind: 'version'; expected: typeof WIRE_VERSION }
  | { kind: 'unknown-type' }
  | { kind: 'direction' }
  | { kind: 'payload'; detail?: string };

export type ParseResult =
  | { ok: true; frame: Frame }
  | { ok: false; error: ParseError };

const ENVELOPE_KEYS = ['v', 'id', 'type', 'ts', 'payload'];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function payloadKeysOk(spec: FrameSpec, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const keys = Object.keys(payload);
  // Excess keys are rejected here, not merely un-typed: an unknown key is how
  // a v2 peer's new field would arrive, and guessing at it is worse than a
  // clean refusal.
  if (keys.some((k) => !spec.required.includes(k) && !spec.optional.includes(k)))
    return false;
  return spec.required.every((k) => keys.includes(k));
}

function parseWith(input: unknown, direction: FrameSpec['direction'] | null): ParseResult {
  if (!isRecord(input)) return { ok: false, error: { kind: 'envelope' } };
  const keys = Object.keys(input).sort();
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    !ENVELOPE_KEYS.every((k) => keys.includes(k)) ||
    typeof input['id'] !== 'string' ||
    typeof input['ts'] !== 'string' ||
    typeof input['type'] !== 'string' ||
    typeof input['v'] !== 'number'
  ) {
    return { ok: false, error: { kind: 'envelope' } };
  }
  if (input['v'] !== WIRE_VERSION)
    return { ok: false, error: { kind: 'version', expected: WIRE_VERSION } };

  const type = input['type'];
  if (!Object.prototype.hasOwnProperty.call(FRAME_SPECS, type))
    return { ok: false, error: { kind: 'unknown-type' } };

  const spec: FrameSpec = FRAME_SPECS[type as FrameType];
  if (direction !== null && spec.direction !== direction)
    return { ok: false, error: { kind: 'direction' } };
  if (!payloadKeysOk(spec, input['payload']))
    return { ok: false, error: { kind: 'payload', detail: type } };

  return { ok: true, frame: input as unknown as Frame };
}

/** Direction-agnostic parse. Used for round-trips and by the testkit. */
export function parseFrame(input: unknown): ParseResult {
  return parseWith(input, null);
}

/** What the gateway runs on bytes arriving from an adapter. */
export function parseAgentFrame(input: unknown): ParseResult {
  return parseWith(input, 'agent->gateway');
}

/** What an adapter runs on bytes arriving from the gateway. */
export function parseGatewayFrame(input: unknown): ParseResult {
  return parseWith(input, 'gateway->agent');
}

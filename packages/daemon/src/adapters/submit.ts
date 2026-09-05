/**
 * s5-execution Scenario 7 — `draft.submit` / `draft.delta`: what an agent
 * proposes becomes a draft a human owns.
 *
 * The design principle of this file is that there is NOTHING special about an
 * agent's draft once it exists. It is inserted with the same `insertDraft`,
 * it appears in the same `GET /v1/drafts` queue, it is approved by the same
 * route, and it is sent by the same scheduler running the same
 * `dispatchApproved`. The only agent-shaped code is the part that decides
 * whether a draft may be minted at all — everything downstream is S4,
 * untouched. If an agent's draft ever needed its own send path, INV-2 would
 * already be broken.
 *
 * What this file refuses, and why:
 *
 *  - **Forged correlation.** A submit is accepted only against a request THIS
 *    gateway issued to THIS adapter, for the chatGuid we issued it for. An
 *    adapter may not draft into a conversation it was never asked about, and
 *    it may not spend another adapter's request.
 *    `adapter.protocol-violation {reason:'correlation'}`.
 *  - **Over-limit body.** `constraints.maxChars` is a limit, not a target to
 *    trim toward: truncating would put words in a draft that no author wrote
 *    and no human would notice were missing. Refused whole.
 *  - **Superseding an approved draft** (F-49). Supersede exists so a better
 *    answer can replace a stale one while it is still a proposal. Once a
 *    human approves, the decision is theirs; letting an agent overwrite it
 *    would be an autonomy escalation through the back door. The attempt is
 *    audited as `draft.illegal-transition` and the new proposal is still
 *    minted, so the human sees both the attempt and the alternative.
 *  - **Replays** (F-15). `(adapterId, idempotencyKey)` is read from the STORE
 *    before minting, so dedup survives a restart — the UNIQUE index plus this
 *    read, never process memory.
 *
 * Deltas persist nothing. `draft.delta` is relayed to the client bus and
 * dropped on the floor: out-of-order and duplicate `seq` are discarded rather
 * than reordered (a preview assembled out of order shows text the agent never
 * wrote), and a stream that never submits leaves zero rows and zero audit
 * entries.
 *
 * §1.8 holds throughout: `sink.append` precedes `sink.broadcast`, which
 * precedes any other observable effect.
 */
import { ulid } from 'ulid';
import type {
  Actor,
  ChatDbReader,
  ChatGuid,
  Clock,
  Draft,
  GateDenyReason,
  Handle,
  MessageGuid,
  Store,
  Ulid,
} from '@wemessage/core';
import {
  applyDraftTransition,
  evaluateGate,
  IllegalDraftActor,
  IllegalDraftTransition,
  maybeAutoApprove,
  normalizeHandle,
  parseChatGuid,
  readGateSettings,
  systemActor,
} from '@wemessage/core';
import type { DraftSummary } from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';
import type { DraftRefusalTap } from './feedback.js';
import { DRAFT_REQUEST_CONSTRAINTS } from './dispatch.js';

/** §2.3 rules-DDL default, used only when the rule row has vanished. */
const FALLBACK_TTL_MINUTES = 240;

/**
 * How many issued requests stay answerable. An agent answers within its
 * `deadlineMs` (60s); this is generous by orders of magnitude and still
 * bounded, because an unbounded map fed by inbound traffic is a memory leak
 * with a schedule.
 */
const MAX_TRACKED_REQUESTS = 500;

/** One `draft.request` this gateway put on the wire, and to whom. */
export interface IssuedRequest {
  adapterId: string;
  requestId: string;
  chatGuid: ChatGuid;
  inboundGuid: MessageGuid;
  ruleId: Ulid;
  /**
   * s8 Sc3 (F-64, F-107): the gate's clamp, carried from the decision that
   * authorised this request to the `draft.created` frame the answer mints.
   *
   * It has to be carried because the two moments are separated by an agent
   * round trip: `adapters/dispatch.ts` evaluates the gate and issues the
   * request, then an adapter thinks, then `mint` runs — by which time the
   * decision is long out of scope and re-evaluating would answer a different
   * question (the counters have moved, the window may have shut).
   *
   * F-108 holds by construction: this registry is an in-process Map that
   * dies with the daemon, so a clamp reason is LIVE-ONLY. Nothing persists
   * it, no column stores it, and a restart correctly forgets why a card that
   * is still in the queue was clamped an hour ago — because by then it may
   * not be any more.
   *
   * Optional under `exactOptionalPropertyTypes`: an unclamped decision omits
   * the key rather than carrying an explicit `undefined`.
   */
  clampedBy?: GateDenyReason;
}

interface Tracked extends IssuedRequest {
  /** Highest relayed delta seq; deltas at or below it are dropped. */
  lastSeq: number;
}

export interface AgentRequests {
  /** Called by the dispatcher AFTER the frame actually left. */
  issue(req: IssuedRequest): void;
  /** The issued request, or null when this adapter was never asked. */
  lookup(adapterId: string, requestId: string): Tracked | null;
}

/**
 * In-process only, deliberately. A correlation outlives neither the daemon
 * nor the socket that would answer it, and persisting request ids would let a
 * restart accept proposals nobody is waiting for any more (F-45's sibling).
 */
export function createAgentRequests(): AgentRequests {
  const byKey = new Map<string, Tracked>();
  const key = (adapterId: string, requestId: string): string =>
    `${adapterId} ${requestId}`;
  return {
    issue(req) {
      byKey.set(key(req.adapterId, req.requestId), { ...req, lastSeq: 0 });
      while (byKey.size > MAX_TRACKED_REQUESTS) {
        // Map iteration is insertion-ordered: the oldest request goes first.
        const oldest = byKey.keys().next();
        if (oldest.done === true) break;
        byKey.delete(oldest.value);
      }
    },
    lookup(adapterId, requestId) {
      return byKey.get(key(adapterId, requestId)) ?? null;
    },
  };
}

/** The frame payloads this handler owns (the wire guards ran upstream). */
interface WireCorrelation {
  requestId?: unknown;
  chatGuid?: unknown;
}

interface SubmitPayload {
  correlation?: WireCorrelation;
  idempotencyKey?: unknown;
  body?: unknown;
  declined?: unknown;
}

interface ProactivePayload {
  idempotencyKey?: unknown;
  target?: unknown;
  body?: unknown;
  reason?: unknown;
}

interface DeltaPayload {
  correlation?: WireCorrelation;
  seq?: unknown;
  textDelta?: unknown;
}

export interface AgentSubmitDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  requests: AgentRequests;
  /**
   * s5 Sc 9: resolves a `{handle}` target to an EXISTING conversation
   * (availability-only — it never mints a chat). Optional because a server
   * booted without a chat.db reader still serves every other adapter frame;
   * without it a handle target simply cannot be resolved and is refused,
   * which is the fail-closed direction.
   */
  reader?: Pick<ChatDbReader, 'resolveChat'>;
  /** s5 Sc 9: tell an adapter its proposal was refused before it existed. */
  refuse?: DraftRefusalTap;
}

export interface AgentSubmitHandler {
  onSubmit(adapterId: string, payload: unknown): void;
  onDelta(adapterId: string, payload: unknown): void;
  /** s5 Sc 9. Async only because resolving a handle is a chat.db read. */
  onProactive(adapterId: string, payload: unknown): Promise<void>;
}

function agentActor(adapterId: string): Actor {
  return { kind: 'agent', adapterId };
}

/**
 * The WS-facing projection of a draft (identical to routes/drafts.ts's).
 *
 * `clampedBy` is a parameter rather than a field of `Draft` because it is
 * not a property of the draft at all: it is why the GATE declined to let
 * this particular draft speak for the operator, a fact about a decision that
 * is true now and may not be in a minute (F-64/F-108). A `Draft` is what the
 * store holds; this is what the screen shows.
 */
function draftFrame(draft: Draft, clampedBy?: GateDenyReason): DraftSummary {
  return {
    id: draft.id,
    chatGuid: draft.chatGuid,
    handle: parseChatGuid(draft.chatGuid).handle,
    ruleId: draft.ruleId,
    adapterId: draft.adapterId,
    body: draft.body,
    state: draft.state,
    expiresAt: draft.expiresAt,
    createdAt: draft.createdAt,
    ...(clampedBy !== undefined ? { clampedBy } : {}),
  };
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function createAgentSubmitHandler(
  deps: AgentSubmitDeps,
): AgentSubmitHandler {
  const { store, clock, sink, requests, reader } = deps;
  // A server with no feedback wiring still refuses correctly; it just cannot
  // say so out loud. Never a reason to skip the refusal itself.
  const refuse: DraftRefusalTap = deps.refuse ?? ((): void => {});

  const violate = (adapterId: string, reason: string): void => {
    sink.append(
      { type: 'adapter.protocol-violation', adapterId, reason },
      agentActor(adapterId),
    );
  };

  /**
   * The gate every agent-originated write passes. Returns the request WE
   * issued, or null having audited the refusal. The chatGuid comparison is
   * the load-bearing half: a requestId alone would let an adapter redirect a
   * legitimate request at a different conversation.
   */
  const authorize = (
    adapterId: string,
    correlation: WireCorrelation,
  ): Tracked | null => {
    const requestId = correlation.requestId;
    if (typeof requestId !== 'string') {
      violate(adapterId, 'correlation');
      return null;
    }
    const issued = requests.lookup(adapterId, requestId);
    if (issued === null || issued.chatGuid !== correlation.chatGuid) {
      violate(adapterId, 'correlation');
      return null;
    }
    return issued;
  };

  /**
   * F-49's supersede trigger, run against every live draft for this
   * `(ruleId, inboundGuid)`. A refusal is NOT fatal to the submit: the human
   * keeps their approved draft AND gets the agent's newer proposal, and the
   * attempt is on the record either way.
   */
  const supersedeLive = (
    issued: Tracked,
    newDraftId: Ulid,
    at: string,
  ): void => {
    const live = store
      .listDrafts({ ruleId: issued.ruleId })
      .filter((d) => d.inboundGuid === issued.inboundGuid);
    const actor = systemActor('supersede');
    for (const old of live) {
      let to;
      try {
        to = applyDraftTransition({
          from: old.state,
          event: 'superseded',
          actor,
        });
      } catch (err) {
        if (
          err instanceof IllegalDraftTransition ||
          err instanceof IllegalDraftActor
        ) {
          // The human already decided (approved / sending / sent). Evidence,
          // then carry on — the refusal is the product behaviour, not a bug.
          sink.append(
            {
              type: 'draft.illegal-transition',
              draftId: old.id,
              from: old.state,
              event: 'superseded',
            },
            actor,
          );
          continue;
        }
        throw err;
      }
      store.applyDraftTransition({ id: old.id, from: old.state, to, at });
      // §1.8 at THIS site: the row, then the frame. The audit row and the
      // frame deliberately spell the link differently — `supersededBy` in
      // the ledger, `byDraftId` on the wire — because a ledger entry has two
      // equal ids and no subject, while a frame is addressed at a card on a
      // screen that is about to disappear.
      sink.append(
        { type: 'draft.superseded', draftId: old.id, supersededBy: newDraftId },
        actor,
      );
      sink.broadcast({
        event: 'draft.superseded',
        draftId: old.id,
        byDraftId: newDraftId,
      });
    }
  };

  const mint = async (
    adapterId: string,
    issued: Tracked,
    idempotencyKey: string,
    body: string,
  ): Promise<void> => {
    const at = clock.now();
    const id = ulid();
    // Supersede BEFORE the insert: the new draft is the reason the old one is
    // stale, so its id belongs in the audit row that retires the old one.
    supersedeLive(issued, id, at);
    // F-48: the rule's own TTL. The 240 fallback applies only when the rule
    // row is gone, which means the answer outlived the question.
    const rule = store.getRule(issued.ruleId);
    const draft: Draft = {
      id,
      inboundGuid: issued.inboundGuid,
      chatGuid: issued.chatGuid,
      ruleId: issued.ruleId,
      adapterId,
      idempotencyKey,
      body,
      originalBody: body,
      state: 'pending',
      stateChangedAt: at,
      expiresAt: addMinutes(at, rule?.draftTtlMinutes ?? FALLBACK_TTL_MINUTES),
      createdAt: at,
    };
    store.insertDraft(draft);
    // §1.8, and exactly the two lines the human compose route runs.
    sink.append(
      { type: 'draft.created', draftId: draft.id, draft },
      agentActor(adapterId),
    );
    sink.broadcast({
      event: 'draft.created',
      draft: draftFrame(draft, issued.clampedBy),
    });
    // s6 Sc 9, §1.7: the ONE auto-approval call site in the product. It
    // runs INSIDE the mint, after the draft is durable and after its
    // creation has been announced, so the ordering a reader sees in the
    // audit log is always draft.created -> auto.approved -> draft.approved
    // and never the other way round.
    //
    // Everything that decides whether this draft may speak for the operator
    // lives behind this one call, in core, where `test/arch.spec.ts` can pin
    // it to a single file. Nothing about autonomy is decided HERE: this
    // module knows only that a rule-borne draft now exists, which is the
    // only fact it is in a position to know. `maybeAutoApprove` returns
    // 'withheld' for every reason it declines, and the draft simply stays in
    // the human's queue — the outcome is deliberately not branched on.
    await maybeAutoApprove({ store, clock, sink, newId: ulid }, draft.id);
  };

  /**
   * `{chatGuid}` is taken as addressed (the same handle-style address
   * `POST /v1/send` accepts); `{handle}` must resolve to a conversation that
   * ALREADY EXISTS. An adapter does not get to open a first contact with a
   * stranger, and with no reader wired there is no way to know one exists —
   * both refuse. Returns null having audited the refusal.
   */
  const resolveTarget = async (
    adapterId: string,
    target: unknown,
  ): Promise<ChatGuid | null> => {
    const t = (target ?? {}) as { chatGuid?: unknown; handle?: unknown };
    if (typeof t.chatGuid === 'string' && t.chatGuid.length > 0) {
      return t.chatGuid;
    }
    if (typeof t.handle !== 'string' || t.handle.length === 0) {
      violate(adapterId, 'target');
      return null;
    }
    if (reader === undefined) {
      violate(adapterId, 'target');
      return null;
    }
    const handle: Handle = normalizeHandle(t.handle);
    const resolved = await reader.resolveChat(handle);
    if (resolved === null) {
      violate(adapterId, 'target');
      return null;
    }
    return resolved.chatGuid;
  };

  /**
   * s5 Scenario 9 — `proactive.propose`. The one frame where an adapter
   * chooses the AUDIENCE rather than answering a question we asked, which is
   * why it is the one frame that consults the gate before minting anything.
   *
   * Order is deliberate and fail-closed: shape (a body nobody can read and a
   * reason nobody stated are refusals, not drafts) -> target resolution ->
   * dedup -> gate. The gate runs last because it is the only check that
   * needs a resolved conversation, and a refusal that named the wrong
   * conversation would be worse evidence than none.
   *
   * `agentOrigin: true` (F-50) is what makes §2.4.3's ladder bind here at
   * all: a proposal has `rule: null`, and without the discriminator the gate
   * would apply the HUMAN pin to an agent. It also clamps the decision to
   * 'draft-only', so a proposal can never be auto-sent — but nothing here
   * reads that mode, because a proposal is only ever minted `pending`. The
   * clamp is what S6 will inherit when auto-send exists.
   */
  const onProactive = async (
    adapterId: string,
    raw: unknown,
  ): Promise<void> => {
    const payload = (raw ?? {}) as ProactivePayload;

    const idempotencyKey = payload.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      violate(adapterId, 'idempotency-key');
      return;
    }
    const body = payload.body;
    if (typeof body !== 'string' || body.length === 0) {
      violate(adapterId, 'body');
      return;
    }
    if (body.length > DRAFT_REQUEST_CONSTRAINTS.maxChars) {
      violate(adapterId, 'max-chars');
      return;
    }
    // A proposal with no stated reason is unreviewable: the human is being
    // asked to write to somebody who did not write first, and "why" is the
    // entire content of that decision.
    const reason = payload.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      violate(adapterId, 'reason-required');
      return;
    }

    const chatGuid = await resolveTarget(adapterId, payload.target);
    if (chatGuid === null) return;

    // F-15, the same closure `draft.submit` gets and for the same reason:
    // read from the STORE, so a retry across a restart still dedups.
    if (store.findDraftByIdempotencyKey(adapterId, idempotencyKey) !== null) {
      return;
    }

    const parsed = parseChatGuid(chatGuid);
    const decision = evaluateGate({
      now: clock.now(),
      settings: readGateSettings(store),
      rule: null,
      agentOrigin: true,
      schedule: null,
      contact: store.getContactPolicy(parsed.handle),
      message: {
        isGroup: parsed.isGroup,
        service: parsed.service,
        handle: parsed.handle,
        chatGuid,
      },
      // Zeros: a proactive proposal is clamped to 'draft-only' by
      // `agentOrigin` before any counter could narrow it further, so a rate
      // read here could not change the decision. The budget is spent where
      // F-71 says it is — when a human approves the resulting draft.
      counters: {
        contactAutoLast2Min: 0,
        contactAutoLastHour: 0,
        globalSentLastHour: 0,
        consecutiveAutoInChat: 0,
        circuitOpen: false,
      },
    });
    if (!decision.allow) {
      // §1.8: the log is the record, the agent's copy is the courtesy.
      sink.append(
        { type: 'gate.denied', reason: decision.reason, adapterId },
        agentActor(adapterId),
      );
      refuse({
        adapterId,
        chatGuid,
        kind: 'draft_rejected',
        actor: agentActor(adapterId),
        reason: decision.reason,
      });
      return;
    }

    const at = clock.now();
    const draft: Draft = {
      id: ulid(),
      // Both null by §3.2: a proposal answers no message and serves no rule,
      // and saying so honestly is what lets the queue show it as what it is.
      inboundGuid: null,
      chatGuid,
      ruleId: null,
      adapterId,
      idempotencyKey,
      body,
      originalBody: body,
      proactiveReason: reason,
      state: 'pending',
      stateChangedAt: at,
      // No rule means no rule TTL (F-48 has nothing to read here), so the
      // §2.3 DDL default is the honest answer rather than a borrowed one.
      expiresAt: addMinutes(at, FALLBACK_TTL_MINUTES),
      createdAt: at,
    };
    store.insertDraft(draft);
    sink.append(
      { type: 'draft.created', draftId: draft.id, draft },
      agentActor(adapterId),
    );
    // The decision is still in scope here — a proactive proposal is minted
    // in the same turn it is gated — so the clamp goes straight on the
    // frame with no registry in between.
    sink.broadcast({
      event: 'draft.created',
      draft: draftFrame(draft, decision.clampedBy),
    });
  };

  return {
    onSubmit(adapterId, raw) {
      const payload = (raw ?? {}) as SubmitPayload;
      const issued = authorize(adapterId, payload.correlation ?? {});
      if (issued === null) return;

      const idempotencyKey = payload.idempotencyKey;
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        violate(adapterId, 'idempotency-key');
        return;
      }
      if (payload.declined === true) {
        // No draft, and no broadcast: there is nothing for a human to review.
        sink.append(
          { type: 'draft.declined', adapterId, requestId: issued.requestId },
          agentActor(adapterId),
        );
        return;
      }
      const body = payload.body;
      if (typeof body !== 'string' || body.length === 0) {
        violate(adapterId, 'body');
        return;
      }
      if (body.length > DRAFT_REQUEST_CONSTRAINTS.maxChars) {
        // Refused whole. Truncating here would send words nobody wrote.
        violate(adapterId, 'max-chars');
        return;
      }
      // F-15's closure, read from the STORE so it survives a restart.
      if (store.findDraftByIdempotencyKey(adapterId, idempotencyKey) !== null) {
        return;
      }
      // `void` on the same precedent as `transport.ts`'s proactive dispatch:
      // this handler's contract is synchronous, and the decision inside the
      // mint performs no awaits of its own, so every effect above has
      // already landed by the time this statement returns.
      void mint(adapterId, issued, idempotencyKey, body);
    },

    onProactive,

    onDelta(adapterId, raw) {
      const payload = (raw ?? {}) as DeltaPayload;
      const issued = authorize(adapterId, payload.correlation ?? {});
      if (issued === null) return;
      const { seq, textDelta } = payload;
      if (typeof seq !== 'number' || typeof textDelta !== 'string') {
        violate(adapterId, 'delta-shape');
        return;
      }
      // Dropped, never reordered.
      if (seq <= issued.lastSeq) return;
      issued.lastSeq = seq;
      // Persists NOTHING and audits nothing: the draft begins at submit.
      sink.broadcast({
        event: 'draft.delta',
        correlation: {
          requestId: issued.requestId,
          chatGuid: issued.chatGuid,
          inboundGuid: issued.inboundGuid,
        },
        seq,
        textDelta,
      });
    },
  };
}

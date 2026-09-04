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
  ChatGuid,
  Clock,
  Draft,
  MessageGuid,
  Store,
  Ulid,
} from '@wemessage/core';
import {
  applyDraftTransition,
  IllegalDraftActor,
  IllegalDraftTransition,
  parseChatGuid,
  systemActor,
} from '@wemessage/core';
import type { DraftSummary } from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';
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
}

export interface AgentSubmitHandler {
  onSubmit(adapterId: string, payload: unknown): void;
  onDelta(adapterId: string, payload: unknown): void;
}

function agentActor(adapterId: string): Actor {
  return { kind: 'agent', adapterId };
}

/** The WS-facing projection of a draft (identical to routes/drafts.ts's). */
function draftFrame(draft: Draft): DraftSummary {
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
  };
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export function createAgentSubmitHandler(
  deps: AgentSubmitDeps,
): AgentSubmitHandler {
  const { store, clock, sink, requests } = deps;

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
      sink.append(
        { type: 'draft.superseded', draftId: old.id, supersededBy: newDraftId },
        actor,
      );
    }
  };

  const mint = (
    adapterId: string,
    issued: Tracked,
    idempotencyKey: string,
    body: string,
  ): void => {
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
    sink.broadcast({ event: 'draft.created', draft: draftFrame(draft) });
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
      mint(adapterId, issued, idempotencyKey, body);
    },

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

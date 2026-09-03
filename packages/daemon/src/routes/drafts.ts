/**
 * §1.6 draft routes, first half (s4-execution Scenario 5): create, list,
 * show, approve, reject. The compose surface the product exists for — a
 * human reviewing what will be said before it is said.
 *
 * Three postures inherited from the S2/S3 route precedent and NOT re-decided
 * here:
 *  - §1.8 "the log is the record, the event is the courtesy": every state
 *    change appends its audit row via `sink.append` BEFORE the WS broadcast.
 *    A dropped socket loses a courtesy, never a record.
 *  - Legality is decided ONCE, by core's pure transition table
 *    (`applyDraftTransition`), and only then persisted by the store's
 *    same-named method, which re-asserts the from-state inside its
 *    transaction. Two layers, one table. An illegal transition arriving over
 *    HTTP is a 409 + a `draft.illegal-transition` audit row, never a 500.
 *  - Gate denial is an HTTP-level refusal (403 {error:'gate-denied',
 *    reason}), matching POST /v1/send. The request was well-formed; policy
 *    refused it. F-34: the denial is audited, because "someone tried to
 *    approve while the kill switch was on" is exactly the sort of thing an
 *    operator needs to find later.
 *
 * The undo grace stamp (`sendNotBefore = now + send.undoGraceSeconds`,
 * default 10s) is written HERE on approve; Scenario 6's scheduler is what
 * eventually picks the draft up. An explicit '0' means "no grace," which
 * must stamp `now` rather than falling back to the default — a user who
 * turned the undo window off gets no undo window.
 */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  applyDraftTransition,
  evaluateGate,
  humanApiActor,
  IllegalDraftActor,
  IllegalDraftTransition,
  parseChatGuid,
  readGateSettings,
  SETTING_UNDO_GRACE_SECONDS,
  type Clock,
  type Draft,
  type DraftState,
  type Store,
  type Ulid,
} from '@wemessage/core';
import type { DraftSummary } from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';

/** Outcome of one draft-level operation, shared by the single and bulk paths. */
type ApplyResult =
  | { ok: true; draft: Draft; approvalId: Ulid }
  | { ok: false; status: 403 | 409; body: Record<string, unknown> };

export interface DraftRouteDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/** F-22: the reserved, permanently-disabled adapter row humans draft under. */
const HUMAN_ADAPTER_ID = 'human';
/** §2.3 rules-DDL default, reused for a hand-composed draft's TTL. */
const DEFAULT_TTL_MINUTES = 240;
/** §1.3.3 default undo window when `send.undoGraceSeconds` is unset. */
const DEFAULT_UNDO_GRACE_SECONDS = 10;
/** C-10 (§1.3.3): one first try plus two retries, then the draft is done. */
const RETRY_CEILING = 3;
/**
 * The terminal, never-sent states a draft may be redrafted from. 'failed'
 * is deliberately absent: that draft has a retry path with a ledger and a
 * ceiling, and redrafting it would be a way to launder past C-10.
 */
const REDRAFTABLE: ReadonlySet<DraftState> = new Set<DraftState>([
  'expired',
  'rejected',
  'recalled',
  'superseded',
]);

const createBody = z.strictObject({
  chatGuid: z.string().min(1),
  body: z.string().min(1),
  ttlMinutes: z.number().int().positive().optional(),
});

const approveBody = z.strictObject({
  editedBody: z.string().min(1).optional(),
});

/**
 * Bulk selection is EITHER an explicit id list OR a filter, never both: a
 * request that carries both is ambiguous about which one wins, and guessing
 * on an operation that can approve dozens of messages is not acceptable.
 * `{all:true}` is required to be explicit for the same reason — an empty
 * filter object must not silently mean "everything pending."
 */
const bulkBody = z
  .strictObject({
    action: z.enum(['approve', 'recall']),
    ids: z.array(z.string().min(1)).min(1).optional(),
    filter: z
      .strictObject({
        all: z.literal(true).optional(),
        rule: z.string().min(1).optional(),
        contact: z.string().min(1).optional(),
      })
      .optional(),
  })
  .refine(
    (b) => (b.ids === undefined) !== (b.filter === undefined),
    'exactly one of ids or filter',
  );

const rejectBody = z.strictObject({
  reason: z.string().min(1).optional(),
});

const listQuery = z.strictObject({
  state: z.string().optional(),
  ruleId: z.string().optional(),
  contact: z.string().optional(),
  batchId: z.string().optional(),
});

const DRAFT_STATES: readonly string[] = [
  'pending',
  'approved',
  'sending',
  'sent',
  'rejected',
  'expired',
  'superseded',
  'recalled',
  'failed',
];

/**
 * Unset -> the 10s default. Set-but-garbage -> also the default: a
 * corrupted settings row must not silently mean "send instantly."
 * Explicit '0' -> zero, the one value that legitimately disables the window.
 */
function undoGraceSeconds(store: Pick<Store, 'getSetting'>): number {
  const raw = store.getSetting(SETTING_UNDO_GRACE_SECONDS);
  if (raw === null) return DEFAULT_UNDO_GRACE_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_UNDO_GRACE_SECONDS;
  }
  return parsed;
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

/** The WS-facing projection of a draft (mirrors routes/send.ts's shape). */
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

export function registerDraftRoutes(
  app: FastifyInstance,
  deps: DraftRouteDeps,
): void {
  const { store, clock, sink } = deps;
  const actor = humanApiActor();

  // ---- POST /v1/drafts (F-33 compose/dev surface) -----------------------
  app.post('/v1/drafts', async (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-draft',
        detail: { issues: parsed.error.issues },
      });
    }
    const { chatGuid, body, ttlMinutes } = parsed.data;
    const at = clock.now();
    const draft: Draft = {
      id: ulid(),
      inboundGuid: null,
      chatGuid,
      ruleId: null,
      adapterId: HUMAN_ADAPTER_ID,
      // One request, one draft. Agent-retry dedup (F-15) keys off an
      // adapter-supplied key; a human pressing the button twice means it.
      idempotencyKey: ulid(),
      body,
      originalBody: body,
      state: 'pending',
      stateChangedAt: at,
      expiresAt: addSeconds(at, (ttlMinutes ?? DEFAULT_TTL_MINUTES) * 60),
      createdAt: at,
    };
    store.insertDraft(draft);
    sink.append({ type: 'draft.created', draftId: draft.id, draft }, actor);
    sink.broadcast({ event: 'draft.created', draft: draftFrame(draft) });
    return reply.code(201).send({ draft });
  });

  // ---- GET /v1/drafts ---------------------------------------------------
  app.get('/v1/drafts', async (req, reply) => {
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-filter',
        detail: { issues: parsed.error.issues },
      });
    }
    const q = parsed.data;
    if (q.state !== undefined && !DRAFT_STATES.includes(q.state)) {
      return reply.code(400).send({ error: 'invalid-filter', detail: q.state });
    }
    // Omitted filters are OMITTED, not passed as undefined: the store's
    // queue default (exclude the six terminal states) is what "no state
    // filter" means, and exactOptionalPropertyTypes makes that explicit.
    const drafts = store.listDrafts({
      ...(q.state !== undefined ? { state: q.state as DraftState } : {}),
      ...(q.ruleId !== undefined ? { ruleId: q.ruleId } : {}),
      ...(q.contact !== undefined ? { contact: q.contact } : {}),
      ...(q.batchId !== undefined ? { batchId: q.batchId } : {}),
    });
    return reply.send({ drafts });
  });

  // ---- GET /v1/drafts/:id ----------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/drafts/:id', async (req, reply) => {
    const draft = store.getDraft(req.params.id);
    if (draft === null) {
      return reply.code(404).send({ error: 'not-found' });
    }
    // The full record: originalBody and error ride on the Draft itself, and
    // the approval history is what makes an after-the-fact review possible.
    return reply.send({
      draft,
      approvals: store.listApprovals(draft.id),
    });
  });

  /**
   * Shared by approve and reject: decide legality against the pure table.
   * Returns the target state, or null after auditing the refusal — the
   * caller owns the 409 body, because only it holds a typed `reply`.
   *
   * BOTH refusal modes are 409s, never 500s. The state table's row can be
   * absent (`sent + approve`), or present but closed to this actor
   * (`approved + reject` is §1.7's system-only row: a human RECALLS their
   * own approved draft, they do not reject it). From the caller's side both
   * are the same fact — "the draft is not in a state where you may do that"
   * — and both are audited, so an operator can see the attempt.
   */
  const decide = (
    draft: Draft,
    event: 'approve' | 'reject' | 'recall' | 'retry',
    retriesUsed?: number,
  ): DraftState | null => {
    try {
      return applyDraftTransition({
        from: draft.state,
        event,
        actor,
        // 'retry' is the one event the pure table cannot decide from state
        // alone: §1.7 folds C-10's ceiling into it, and it REQUIRES the
        // count. Omitting it reads as "unknown retries" and is refused, so
        // this must be threaded through rather than defaulted.
        ...(retriesUsed !== undefined ? { retriesUsed } : {}),
      });
    } catch (err) {
      if (
        err instanceof IllegalDraftTransition ||
        err instanceof IllegalDraftActor
      ) {
        sink.append(
          {
            type: 'draft.illegal-transition',
            draftId: draft.id,
            from: draft.state,
            event,
          },
          actor,
        );
        return null;
      }
      throw err;
    }
  };

  /**
   * The whole of "approve this draft," extracted so the single-draft route
   * and the bulk handler run the SAME code. A bulk approve that took a
   * shortcut past the gate, or stamped grace differently, would be a second
   * approval path with second-class safety properties — exactly the sort of
   * divergence that survives review because both halves look fine alone.
   */
  const approveOne = (
    draft: Draft,
    opts: { editedBody?: string; batchId?: Ulid } = {},
  ): ApplyResult => {
    // Legality BEFORE policy: a draft that was already sent is a 409
    // whatever the kill switch says, because the request is incoherent
    // rather than merely refused.
    const to = decide(draft, 'approve');
    if (to === null) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'illegal-transition',
          from: draft.state,
          requested: 'approve',
        },
      };
    }

    const parsedGuid = parseChatGuid(draft.chatGuid);
    const gate = evaluateGate({
      now: clock.now(),
      settings: readGateSettings(store),
      rule: draft.ruleId === null ? null : store.getRule(draft.ruleId),
      schedule: null,
      contact: store.getContactPolicy(parsedGuid.handle),
      message: {
        isGroup: parsedGuid.isGroup,
        service: parsedGuid.service,
        handle: parsedGuid.handle,
        chatGuid: draft.chatGuid,
      },
      counters: {
        contactAutoLastHour: 0,
        globalAutoLastHour: 0,
        consecutiveAutoInChat: 0,
        circuitOpen: false,
      },
    });
    if (!gate.allow) {
      // F-34: audited, and the draft stays exactly where it was.
      sink.append(
        { type: 'gate.denied', draftId: draft.id, reason: gate.reason },
        actor,
      );
      sink.broadcast({
        event: 'gate.denied',
        reason: gate.reason,
        chatGuid: draft.chatGuid,
        draftId: draft.id,
      });
      return {
        ok: false,
        status: 403,
        body: { error: 'gate-denied', reason: gate.reason },
      };
    }

    const at = clock.now();
    const updated = store.applyDraftTransition({
      id: draft.id,
      from: draft.state,
      to,
      at,
      sendNotBefore: addSeconds(at, undoGraceSeconds(store)),
      ...(opts.editedBody !== undefined ? { body: opts.editedBody } : {}),
    });
    const approvalId = ulid();
    store.insertApproval({
      id: approvalId,
      draftId: draft.id,
      action: 'approve',
      actor,
      ...(opts.editedBody !== undefined ? { editedBody: opts.editedBody } : {}),
      ...(opts.batchId !== undefined ? { batchId: opts.batchId } : {}),
      at,
    });
    sink.append(
      { type: 'draft.approved', draftId: draft.id, approvalId, actor },
      actor,
    );
    sink.broadcast({
      event: 'draft.approved',
      draftId: draft.id,
      actor,
      ...(opts.batchId !== undefined ? { batchId: opts.batchId } : {}),
    });
    return { ok: true, draft: updated, approvalId };
  };

  /** Same extraction for recall; see approveOne. */
  const recallOne = (draft: Draft, batchId?: Ulid): ApplyResult => {
    const to = decide(draft, 'recall');
    if (to === null) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'illegal-transition',
          from: draft.state,
          requested: 'recall',
        },
      };
    }

    // The window is a fact about time, not about state, so the table cannot
    // express it: an approved draft whose sendNotBefore has passed is
    // legally recallable right up until the tick that sends it, and
    // pretending otherwise would be a lie the moment the scheduler wins the
    // race. Refuse at the boundary instead. With send.undoGraceSeconds='0'
    // (F-32) this refuses immediately, the honest reading of "no undo."
    const at = clock.now();
    if (
      draft.sendNotBefore === undefined ||
      draft.sendNotBefore === null ||
      Date.parse(at) >= Date.parse(draft.sendNotBefore)
    ) {
      sink.append(
        {
          type: 'draft.illegal-transition',
          draftId: draft.id,
          from: draft.state,
          event: 'recall',
        },
        actor,
      );
      return {
        ok: false,
        status: 409,
        body: {
          error: 'grace-elapsed',
          from: draft.state,
          requested: 'recall',
        },
      };
    }

    const updated = store.applyDraftTransition({
      id: draft.id,
      from: draft.state,
      to,
      at,
      // Clearing the stamp is what actually stops the next tick.
      sendNotBefore: null,
    });
    const approvalId = ulid();
    store.insertApproval({
      id: approvalId,
      draftId: draft.id,
      action: 'recall',
      actor,
      ...(batchId !== undefined ? { batchId } : {}),
      at,
    });
    sink.append(
      { type: 'draft.recalled', draftId: draft.id, approvalId },
      actor,
    );
    sink.broadcast({
      event: 'draft.recalled',
      draftId: draft.id,
      actor,
      ...(batchId !== undefined ? { batchId } : {}),
    });
    return { ok: true, draft: updated, approvalId };
  };

  // ---- POST /v1/drafts/:id/approve -------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/drafts/:id/approve',
    async (req, reply) => {
      const parsed = approveBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid-approval',
          detail: { issues: parsed.error.issues },
        });
      }
      const draft = store.getDraft(req.params.id);
      if (draft === null) return reply.code(404).send({ error: 'not-found' });

      const result = approveOne(draft, {
        ...(parsed.data.editedBody !== undefined
          ? { editedBody: parsed.data.editedBody }
          : {}),
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply.send({
        draft: result.draft,
        approvalId: result.approvalId,
      });
    },
  );

  // ---- POST /v1/drafts/:id/recall (the undo window) --------------------
  app.post<{ Params: { id: string } }>(
    '/v1/drafts/:id/recall',
    async (req, reply) => {
      const draft = store.getDraft(req.params.id);
      if (draft === null) return reply.code(404).send({ error: 'not-found' });
      const result = recallOne(draft);
      if (!result.ok) return reply.code(result.status).send(result.body);
      return reply.send({
        draft: result.draft,
        approvalId: result.approvalId,
      });
    },
  );

  // ---- POST /v1/drafts/bulk --------------------------------------------
  /**
   * Always 200. A bulk operation over N drafts is not one atomic act, it is
   * N acts reported honestly: `applied` are the ones that moved, `refused`
   * carry the reason each one didn't. Failing the whole request because one
   * of fifty drafts was already sent would make the endpoint unusable
   * exactly when a queue has drifted, which is when you most want it.
   *
   * The batchId is minted here and stamped on every Approval row, which is
   * what makes GET /v1/batches/:id possible without a batches table.
   */
  app.post('/v1/drafts/bulk', async (req, reply) => {
    const parsed = bulkBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-bulk',
        detail: { issues: parsed.error.issues },
      });
    }
    const { action, ids, filter } = parsed.data;

    // Selection. An id list is taken verbatim (an unknown id is a refusal,
    // not a silent omission — the caller named it and deserves an answer).
    const targets: Array<{ id: string; draft: Draft | null }> = [];
    if (ids !== undefined) {
      for (const id of ids) targets.push({ id, draft: store.getDraft(id) });
    } else {
      const f = filter as NonNullable<typeof filter>;
      // Bulk approve wants the pending queue; bulk recall wants what is
      // sitting in its grace window. Selecting on the state each action can
      // actually consume keeps `refused` meaningful instead of listing every
      // unrelated draft in the store.
      const state: DraftState = action === 'approve' ? 'pending' : 'approved';
      const matched = store.listDrafts({
        state,
        ...(f.rule !== undefined ? { ruleId: f.rule } : {}),
        ...(f.contact !== undefined ? { contact: f.contact } : {}),
      });
      for (const draft of matched) targets.push({ id: draft.id, draft });
    }

    const batchId = ulid();
    const applied: string[] = [];
    const refused: Array<{ id: string; error: string }> = [];
    for (const target of targets) {
      if (target.draft === null) {
        refused.push({ id: target.id, error: 'not-found' });
        continue;
      }
      const result =
        action === 'approve'
          ? approveOne(target.draft, { batchId })
          : recallOne(target.draft, batchId);
      if (result.ok) applied.push(target.id);
      else refused.push({ id: target.id, error: String(result.body.error) });
    }
    return reply.send({
      batchId,
      matched: targets.length,
      applied: applied.length,
      appliedIds: applied,
      refused,
    });
  });

  // ---- GET /v1/batches/:id ---------------------------------------------
  app.get<{ Params: { id: string } }>('/v1/batches/:id', async (req, reply) => {
    // Derived by joining approvals(batch_id) -> drafts.state, so the report
    // is always the drafts' CURRENT truth rather than a counter that has to
    // be kept in sync with every later transition.
    return reply.send({
      batchId: req.params.id,
      ...store.batchReport(req.params.id),
    });
  });

  // ---- POST /v1/drafts/:id/retry ---------------------------------------
  /**
   * failed -> approved with a FRESH grace window. Fresh is the whole point:
   * reusing the old sendNotBefore would hand back a window that is already
   * in the past, so the retry would fire on the very next tick with no undo
   * at all — the user asked to try again, not to send instantly.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/drafts/:id/retry',
    async (req, reply) => {
      const draft = store.getDraft(req.params.id);
      if (draft === null) return reply.code(404).send({ error: 'not-found' });

      // C-10: refuse at the ceiling BEFORE the transition, so the user
      // gets 'retry-limit' rather than the table's generic
      // 'illegal-transition'. Both refuse the same act; only one of them
      // tells an operator why. Moving the draft first would be worse
      // still: it would show a retry that looked like it worked right up
      // until the next tick failed it again.
      const attempts = store.sendAttemptCount(draft.id);
      if (attempts >= RETRY_CEILING) {
        return reply.code(409).send({ error: 'retry-limit', attempts });
      }

      // One first try burns no retry, hence the -1 (floored at 0 for a
      // draft that somehow reached 'failed' without a ledger row).
      const to = decide(draft, 'retry', Math.max(0, attempts - 1));
      if (to === null) {
        return reply.code(409).send({
          error: 'illegal-transition',
          from: draft.state,
          requested: 'retry',
        });
      }

      const at = clock.now();
      const updated = store.applyDraftTransition({
        id: draft.id,
        from: draft.state,
        to,
        at,
        sendNotBefore: addSeconds(at, undoGraceSeconds(store)),
      });
      const approvalId = ulid();
      store.insertApproval({
        id: approvalId,
        draftId: draft.id,
        // 'approve', not a new verb: the scheduler looks up the latest
        // approve row to authorize the send (INV-2), and a retry that wrote
        // some other action would leave the draft approved but unsendable.
        action: 'approve',
        actor,
        at,
      });
      sink.append(
        { type: 'draft.approved', draftId: draft.id, approvalId, actor },
        actor,
      );
      sink.broadcast({ event: 'draft.approved', draftId: draft.id, actor });
      return reply.send({ draft: updated, approvalId });
    },
  );

  // ---- POST /v1/drafts/:id/redraft -------------------------------------
  /**
   * F-40: a redraft is a NEW draft, never a resurrection. Fresh id, fresh
   * idempotency key, fresh TTL, `state:'pending'`; the source is left
   * exactly where it was, because "this expired and then someone tried
   * again" is a different fact from "this eventually went out."
   *
   * It copies `originalBody`, not `body`: the point of redrafting an
   * expired draft is to restore what was actually proposed, not to revive a
   * half-finished human edit that was already left to lapse.
   *
   * The {fromDraftId, toDraftId} link lives in the audit row and this
   * response. §2.3's drafts table has no parent column, and a derived
   * idempotency key ('<old>#r1') would collide with the UNIQUE dedup
   * semantics agents depend on in S5.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/drafts/:id/redraft',
    async (req, reply) => {
      const source = store.getDraft(req.params.id);
      if (source === null) return reply.code(404).send({ error: 'not-found' });

      // Only a draft that is DONE and unsent may be redrafted. Redrafting a
      // pending draft would silently double the queue for one inbound
      // message; redrafting a sent one would invite saying it twice.
      if (!REDRAFTABLE.has(source.state)) {
        return reply.code(409).send({
          error: 'illegal-redraft',
          from: source.state,
        });
      }

      const at = clock.now();
      const draft: Draft = {
        id: ulid(),
        inboundGuid: source.inboundGuid,
        chatGuid: source.chatGuid,
        ruleId: source.ruleId,
        adapterId: source.adapterId,
        idempotencyKey: ulid(),
        body: source.originalBody,
        originalBody: source.originalBody,
        state: 'pending',
        stateChangedAt: at,
        // Fresh TTL from now. Inheriting the source's long-dead deadline
        // would create a draft that is born expired.
        expiresAt: addSeconds(at, DEFAULT_TTL_MINUTES * 60),
        createdAt: at,
      };
      store.insertDraft(draft);
      sink.append({ type: 'draft.created', draftId: draft.id, draft }, actor);
      sink.append(
        {
          type: 'draft.redrafted',
          fromDraftId: source.id,
          toDraftId: draft.id,
        },
        actor,
      );
      // F-39: no WS event for the redraft itself. Protocol has no such
      // frame in S4, and a client that sees draft.created has everything it
      // needs to render the new row.
      sink.broadcast({ event: 'draft.created', draft: draftFrame(draft) });
      return reply.send({ fromDraftId: source.id, draft });
    },
  );

  // ---- POST /v1/drafts/:id/reject --------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/drafts/:id/reject',
    async (req, reply) => {
      const parsed = rejectBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid-rejection',
          detail: { issues: parsed.error.issues },
        });
      }
      const draft = store.getDraft(req.params.id);
      if (draft === null) return reply.code(404).send({ error: 'not-found' });

      const to = decide(draft, 'reject');
      if (to === null) {
        return reply.code(409).send({
          error: 'illegal-transition',
          from: draft.state,
          requested: 'reject',
        });
      }

      // No gate on reject. Refusing to say something is always allowed —
      // the kill switch exists to stop sends, not to trap drafts.
      const at = clock.now();
      const updated = store.applyDraftTransition({
        id: draft.id,
        from: draft.state,
        to,
        at,
        // Clearing the grace stamp is what makes rejecting an approved
        // draft actually stop the scheduler from picking it up.
        sendNotBefore: null,
      });
      const approvalId = ulid();
      store.insertApproval({
        id: approvalId,
        draftId: draft.id,
        action: 'reject',
        actor,
        at,
      });
      sink.append(
        { type: 'draft.rejected', draftId: draft.id, approvalId },
        actor,
      );
      // The reason, if given, lives in the audit row's approval, not on the
      // wire frame: GatewayEvent's draft.* shape is deliberately narrow.
      sink.broadcast({ event: 'draft.rejected', draftId: draft.id, actor });
      return reply.send({ draft: updated, approvalId });
    },
  );
}

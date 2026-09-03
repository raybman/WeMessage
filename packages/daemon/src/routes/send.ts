/**
 * §1.6 route: POST /v1/send (s3-execution Scenario 8). The only S3 path that
 * mints a Draft/Approval outside the not-yet-built (S4) rule-match draft
 * pipeline: a human, via the API, names a target `chatGuid` (a handle-style
 * address, e.g. "iMessage;-;+15551234567" — never a real backing chat guid,
 * which `dispatchApproved`'s `reader.resolveChat` resolves) + a body. This
 * route mints an already-'approved' Draft (`insertDraft` writes `state`
 * verbatim — §1.5 body extension, Scenario 5) against the F-22 reserved
 * 'human' adapter row, mints a matching Approval (actor
 * {kind:'human', via:'api'}), then dispatches immediately.
 *
 * §1.8 "the log is the record, the event is the courtesy" governs the MINT
 * half exactly as everywhere else: draft.created / draft.approved audit rows
 * append (`sink.append`) before `dispatchApproved` is ever called, WS
 * broadcasts follow each append. `dispatchApproved` (core, Scenario 6) owns
 * the send.attempted / draft.sent / draft.failed audit rows AND the ONE
 * re-gate check at send moment — this route never duplicates that; it only
 * adds the WS broadcasts core's `DispatchOutcome` cannot produce itself
 * (INV-1: core never imports @wemessage/protocol).
 *
 * Gate denial is the one outcome treated as an HTTP-level refusal (403
 * {error:'gate-denied', reason}) rather than 200 {outcome:'failed'}: every
 * other `DraftError` code (no-conversation, group-send-disabled, unverified,
 * messages-not-running, backend-error) is a legitimate, documented send
 * outcome the caller asked for and got an honest answer about — the request
 * itself succeeded (200).
 */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  dispatchApproved,
  humanApiActor,
  parseChatGuid,
  type ChatDbReader,
  type Clock,
  type DispatchGateDenied,
  type Draft,
  type SendBackend,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';

export interface SendRouteDeps {
  store: Store;
  reader: ChatDbReader;
  backend: SendBackend;
  backendName: string;
  clock: Clock;
  /** Injected sleep, threaded straight through to dispatchApproved's verify-poll. */
  delay: (ms: number) => Promise<void>;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
}

/** F-22: the reserved, permanently-disabled adapter row humans send under. */
const HUMAN_ADAPTER_ID = 'human';

const sendBody = z.strictObject({
  chatGuid: z.string().min(1),
  body: z.string().min(1),
});

export function registerSendRoutes(
  app: FastifyInstance,
  deps: SendRouteDeps,
): void {
  const { store, reader, backend, backendName, clock, delay, sink } = deps;

  app.post('/v1/send', async (req, reply) => {
    const parsed = sendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-send',
        detail: { issues: parsed.error.issues },
      });
    }
    const { chatGuid, body } = parsed.data;
    const handle = parseChatGuid(chatGuid).handle;
    const actor = humanApiActor();
    const mintedAt = clock.now();

    const draft: Draft = {
      id: ulid(),
      inboundGuid: null,
      chatGuid,
      ruleId: null,
      adapterId: HUMAN_ADAPTER_ID,
      idempotencyKey: ulid(), // one request, one draft — no agent-retry dedup here
      body,
      originalBody: body,
      state: 'approved', // insertDraft writes state verbatim (no separate approve step)
      stateChangedAt: mintedAt,
      expiresAt: mintedAt, // moot: dispatched synchronously below, never sits pending
      createdAt: mintedAt,
    };
    store.insertDraft(draft);
    sink.append({ type: 'draft.created', draftId: draft.id, draft }, actor);
    sink.broadcast({
      event: 'draft.created',
      draft: {
        id: draft.id,
        chatGuid: draft.chatGuid,
        handle,
        ruleId: draft.ruleId,
        adapterId: draft.adapterId,
        body: draft.body,
        state: draft.state,
        expiresAt: draft.expiresAt,
        createdAt: draft.createdAt,
      },
    });

    const approvalId = ulid();
    store.insertApproval({
      id: approvalId,
      draftId: draft.id,
      action: 'approve',
      actor,
      at: clock.now(),
    });
    sink.append(
      { type: 'draft.approved', draftId: draft.id, approvalId, actor },
      actor,
    );
    sink.broadcast({ event: 'draft.approved', draftId: draft.id, actor });

    let gateDenial: DispatchGateDenied | null = null;
    const outcome = await dispatchApproved(
      {
        store,
        reader,
        backend,
        clock,
        delay,
        backendName,
        emit: (event) => {
          gateDenial = event;
        },
      },
      draft.id,
      approvalId,
    );

    if (outcome.outcome === 'sent') {
      sink.broadcast({
        event: 'draft.sent',
        draftId: draft.id,
        sentMessageGuid: outcome.sentMessageGuid,
      });
      return reply.send({
        draftId: draft.id,
        outcome: 'sent',
        sentMessageGuid: outcome.sentMessageGuid,
      });
    }

    if (outcome.error.code === 'gate-denied') {
      // dispatchApproved's contract: emit() fires exactly once, only on a
      // gate denial, always before returning that outcome — this cannot be
      // null here. Guarded, not assumed (never trust a closure blindly).
      if (gateDenial === null) {
        throw new Error(
          'invariant violated: gate-denied outcome with no captured gate.denied event',
        );
      }
      const denial: DispatchGateDenied = gateDenial;
      sink.broadcast({
        event: 'gate.denied',
        reason: denial.reason,
        chatGuid: draft.chatGuid,
        draftId: draft.id,
      });
      return reply
        .code(403)
        .send({ error: 'gate-denied', reason: denial.reason });
    }

    sink.broadcast({
      event: 'draft.failed',
      draftId: draft.id,
      error: outcome.error,
    });
    return reply.send({
      draftId: draft.id,
      outcome: 'failed',
      error: outcome.error,
    });
  });
}

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
  type DispatchOutbox,
  type Draft,
  type SendBackend,
  type Store,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';
import { runDoctor, type DoctorProbes } from '../doctor.js';
import type { Supervisor } from '../launchd/contract.js';
import { attachmentsEnabled, STAGE_ID } from '../attachments/outbox.js';

/**
 * s3-execution Scenario 11 (§2.2.3 row 2, "send capability lost mid-run"):
 * two consecutive `messages-not-running` failures re-probe immediately
 * rather than waiting for the next GET /v1/doctor / POST /v1/connect — one
 * failure alone is too noisy a signal (Messages can take a moment to relaunch
 * under autoLaunch); two in a row without an intervening success means the
 * capability is actually gone. Any `sent` outcome resets the counter
 * unconditionally; any OTHER failure code leaves it unchanged (only this one
 * code means "the thing doctor actually checks" went away).
 */
const NOT_RUNNING_REPROBE_THRESHOLD = 2;

export interface SendRouteDeps {
  store: Store;
  reader: ChatDbReader;
  backend: SendBackend;
  backendName: string;
  clock: Clock;
  /** Injected sleep, threaded straight through to dispatchApproved's verify-poll. */
  delay: (ms: number) => Promise<void>;
  /** s3-execution Scenario 11: re-probe trigger for the row-2 counter above. */
  doctorProbes: DoctorProbes;
  sink: Pick<AuditSink, 'append' | 'broadcast'>;
  /**
   * s9 Sc4: threaded through solely so the re-probe below produces a doctor
   * report that says the same thing `GET /v1/doctor` would. A report that
   * disagreed with itself depending on which route triggered it would be
   * worse than no field at all.
   */
  supervisor: Supervisor;
  /**
   * v2 F6d: the outbox the dispatcher re-hashes a file draft's bytes from.
   * Absent, a file draft fails 'attachment-missing' and nothing is sent.
   */
  outbox?: DispatchOutbox;
}

/** F-22: the reserved, permanently-disabled adapter row humans send under. */
const HUMAN_ADAPTER_ID = 'human';

/**
 * v2 F6d: text OR one staged file, never both and never neither (D-F6-3).
 * One strict object with both fields optional and a refinement that wants
 * exactly one, rather than a `z.union`: the contract ratchet requires every
 * request schema to be a closed object at its root (`type: object`,
 * `additionalProperties: false`), and a union publishes as a bare `anyOf`.
 * `{chatGuid, body, file}` and `{chatGuid}` are both a 400. A caption is a
 * second, text, send.
 */
const sendBody = z
  .strictObject({
    chatGuid: z.string().min(1),
    body: z.string().min(1).optional(),
    file: z.string().regex(STAGE_ID).optional(),
  })
  .refine((b) => (b.body === undefined) !== (b.file === undefined), {
    message: 'exactly one of body or file',
  });

export function registerSendRoutes(
  app: FastifyInstance,
  deps: SendRouteDeps,
): void {
  const {
    store,
    reader,
    backend,
    backendName,
    clock,
    delay,
    doctorProbes,
    supervisor,
    sink,
  } = deps;
  // s3-execution Scenario 11 row 2: in-process counter, reset on any `sent`
  // outcome or any failure code other than `messages-not-running`.
  let consecutiveNotRunning = 0;

  app.post('/v1/send', async (req, reply) => {
    const parsed = sendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-send',
        detail: { issues: parsed.error.issues },
      });
    }
    const { chatGuid } = parsed.data;
    const file = parsed.data.file ?? null;
    const body = parsed.data.body ?? '';
    if (file !== null) {
      // D-F6-1: off until one real file send has been verified by hand.
      if (!attachmentsEnabled(store)) {
        return reply.code(409).send({ error: 'attachments-unproven' });
      }
      const staged = store.getStagedFile(file);
      if (staged === null || staged.removedAt !== null) {
        return reply.code(404).send({ error: 'stage-not-found' });
      }
    }
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
    if (file === null) {
      store.insertDraft(draft);
    } else {
      // The draft and its file in one transaction: a file draft (empty
      // body) never exists without the hash it carries. The only caller
      // (arch row): agents cannot attach (D-F6-4).
      store.bindDraftFile(draft, file, mintedAt);
    }
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
        ...(deps.outbox !== undefined ? { outbox: deps.outbox } : {}),
        emit: (event) => {
          gateDenial = event;
        },
      },
      draft.id,
      approvalId,
    );

    if (outcome.outcome === 'sent') {
      consecutiveNotRunning = 0;
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

    /**
     * s6 Sc 10 (F-72). Unreachable from this route, twice over: the draft it
     * mints carries `ruleId: null`, so no schedule binds it and no window
     * clamp can arise; and its approval is `{kind:'human', via:'api'}`,
     * while the requeue path is scoped to the machine. Narrowed explicitly
     * rather than folded into the failure branch below, because "put back in
     * the queue" is not a failure and this route's 200 {outcome:'failed'}
     * body would say it was. If this ever throws, one of those two facts
     * changed and the response shape has to be decided on purpose.
     */
    if (outcome.outcome === 'requeued') {
      throw new Error(
        `invariant violated: POST /v1/send draft requeued (${outcome.reason})`,
      );
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

    if (outcome.error.code === 'messages-not-running') {
      consecutiveNotRunning += 1;
      if (consecutiveNotRunning >= NOT_RUNNING_REPROBE_THRESHOLD) {
        consecutiveNotRunning = 0;
        await runDoctor({
          probes: doctorProbes,
          store,
          sink,
          clock,
          supervisor,
        });
      }
    } else {
      consecutiveNotRunning = 0;
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

/**
 * v2 S0: this module's request schemas, by name, for `contract.ts`'s
 * REQUEST_SCHEMAS and the contract ratchet. The same objects the handlers
 * above parse with: nothing is copied, so the published shape cannot drift
 * from the enforced one.
 */
export const sendSchemas = {
  sendBody,
} as const;

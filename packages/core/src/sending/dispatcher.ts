/**
 * Dispatch an approved draft to the send backend (s3-execution Scenario 6,
 * §1.7 step 3 "dispatchApproved"). INV-2 (a draft is sent only via a valid,
 * matching Approval) becomes code here — see the three named-teeth proofs
 * in dispatcher.spec.ts.
 *
 * Call order, REVISED in s4-execution Scenario 4: approval-validate ->
 * [mutex] gate -> auto-approval check -> group short-circuit -> resolve
 * conversation -> beginSendAttempt -> backend.send -> verify-poll -> mark
 * sent/failed.
 *
 * S3 evaluated the gate OUTSIDE the mutex on the theory that it was a cheap
 * read-only call. That was a TOCTOU hole: two dispatches queued behind the
 * mutex both read the settings before either acquired it, so a kill-switch
 * flip landing between them was invisible to the second one and it sent
 * anyway. The whole point of a re-gate is that it reads state as late as
 * possible, so the settings read now happens strictly AFTER mutex
 * acquisition. resolveChat and the group short-circuit moved in with it
 * because they must stay ordered behind the gate. Approval validation stays
 * outside: it reads only the draft and approval rows the caller named, and a
 * caller-error throw should not queue behind a live send.
 *
 * §2.4.1 numbered ordering is therefore now: approval(1) -> mutex(2) ->
 * gate(3) -> ledger(4) -> backend(5). dispatcher.spec.ts pins the move with
 * a flip-between-two-queued-dispatches test that is impossible to pass with
 * a pre-mutex gate read.
 */
import type { AuditEvent } from '../audit/events.js';
import type {
  Actor,
  ChatGuid,
  DraftError,
  GateDenyReason,
  Handle,
  IsoUtc,
  MessageGuid,
  Service,
  Ulid,
} from '../domain/types.js';
import { evaluateGate, readGateSettings } from '../gate/index.js';
import type {
  ChatDbReader,
  Clock,
  SendBackend,
  Store,
} from '../ports/index.js';

/**
 * Mirrors (does NOT import — INV-1, core has zero package deps and cannot
 * depend on @wemessage/protocol) the wire shape of a live gate-denial
 * notification. Bespoke to core; the daemon's WS layer reshapes this onto
 * the real wire frame when it's wired up (S5).
 */
export interface DispatchGateDenied {
  type: 'gate.denied';
  draftId: Ulid;
  reason: GateDenyReason;
  at: IsoUtc;
}

export interface DispatchApprovedDeps {
  store: Store;
  reader: ChatDbReader;
  backend: SendBackend;
  clock: Clock;
  /** Injected sleep — never a real timer in core (mirrors sendkit's verifySend). */
  delay: (ms: number) => Promise<void>;
  /** Backend identity recorded on the send_ledger row (§2.3 send_ledger.backend). */
  backendName: string;
  /** Fired exactly once, only on a gate denial; never on any other failure path. */
  emit: (event: DispatchGateDenied) => void;
}

export type DispatchOutcome =
  | { outcome: 'sent'; sentMessageGuid: MessageGuid }
  | { outcome: 'failed'; error: DraftError };

// Deliberately duplicated from packages/sendkit/src/verify.ts (INV-1: core
// has zero package deps, cannot import sendkit). Keep these two constants
// and the loop shape in lockstep by hand — do NOT "clean up" by importing
// sendkit into core; that arrow is illegal (sendkit -> core only).
const VERIFY_BUDGET_MS = 10_000;
const INITIAL_INTERVAL_MS = 250;

async function verifyPoll(
  reader: Pick<ChatDbReader, 'findOutboundMessage'>,
  clock: Clock,
  delay: (ms: number) => Promise<void>,
  input: { chatGuid: ChatGuid; body: string; sendStartedAt: IsoUtc },
): Promise<{ verified: true; guid: MessageGuid } | { verified: false }> {
  const startMs = clock.nowMs();
  let interval = INITIAL_INTERVAL_MS;
  for (;;) {
    const found = await reader.findOutboundMessage({
      chatGuid: input.chatGuid,
      text: input.body,
      sinceIso: input.sendStartedAt,
    });
    if (found !== null) return { verified: true, guid: found.guid };
    const elapsed = clock.nowMs() - startMs;
    const remaining = VERIFY_BUDGET_MS - elapsed;
    if (remaining <= 0) return { verified: false };
    await delay(Math.min(interval, remaining));
    interval *= 2;
  }
}

/**
 * Apple 1:1 chat guids are "service;-;handle" (the only format any fixture
 * uses); group guids ("service;+;roomName") carry no single counterparty
 * handle at all. Used to (a) populate GateContext.message ahead of the gate
 * call and (b) short-circuit group sends before wasting a resolveChat call
 * (S3 ships no group-send path).
 */
export function parseChatGuid(chatGuid: ChatGuid): {
  handle: Handle;
  service: Service;
  isGroup: boolean;
} {
  const ONE_ON_ONE_SEP = ';-;';
  const prefix = chatGuid.split(';')[0]?.toLowerCase();
  const service: Service =
    prefix === 'imessage' ? 'imessage' : prefix === 'sms' ? 'sms' : 'unknown';
  const idx = chatGuid.indexOf(ONE_ON_ONE_SEP);
  if (idx === -1) {
    return { handle: '', service, isGroup: true };
  }
  return {
    handle: chatGuid.slice(idx + ONE_ON_ONE_SEP.length),
    service,
    isGroup: false,
  };
}

// Process-wide send mutex (§2.4.1: "one physical Messages.app, one send at a
// time"). A promise-chain queue, not a real lock — deliberately serializes
// beginSendAttempt -> backend.send -> verify -> mark across ALL concurrent
// dispatchApproved calls, different drafts included. Module scope is
// intentional: two dispatchApproved calls anywhere in the process must
// queue behind each other.
let sendQueue: Promise<void> = Promise.resolve();
function withSendMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(fn, fn);
  sendQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function appendAudit(
  store: Store,
  clock: Clock,
  actor: Actor,
  event: AuditEvent,
): void {
  store.appendAudit({
    at: clock.now(),
    eventJson: JSON.stringify(event),
    actorJson: JSON.stringify(actor),
  });
}

/** Park the draft (no state-assertion guard on markDraftFailed — safe pre-ledger too) and audit it. */
function fail(
  store: Store,
  clock: Clock,
  actor: Actor,
  draftId: Ulid,
  error: DraftError,
): DispatchOutcome {
  store.markDraftFailed(draftId, error, clock.now());
  appendAudit(store, clock, actor, { type: 'draft.failed', draftId, error });
  return { outcome: 'failed', error };
}

/**
 * Send an approved draft. Throws — never returns a DispatchOutcome — for a
 * missing/mismatched approval or a draft not currently 'approved': that is
 * a caller/programmer error (INV-2 violation attempt), not a runtime send
 * failure (§1.7 step 3a). Every OTHER failure (gate deny, no conversation,
 * group chat, backend rejection, unverified) parks the draft as 'failed'
 * and resolves normally.
 */
export async function dispatchApproved(
  deps: DispatchApprovedDeps,
  draftId: Ulid,
  approvalId: Ulid,
): Promise<DispatchOutcome> {
  const { store, reader, backend, clock, delay, backendName, emit } = deps;

  // F-35: every INV-2 validation failure now leaves an audit row before it
  // throws. S3 threw silently, which meant the one event an operator most
  // wants to see after a suspicious dispatch attempt ("something tried to
  // send an unapproved draft") left no trace. The actor on the row is the
  // system, not the (possibly absent, possibly forged) approval's actor.
  const unapproved = (message: string): Error => {
    appendAudit(
      store,
      clock,
      { kind: 'system', reason: 'rule-engine' },
      { type: 'gate.denied', draftId, reason: 'unapproved' },
    );
    return new Error(message);
  };

  const draft = store.getDraft(draftId);
  if (draft === null || draft.state !== 'approved') {
    throw unapproved(
      `dispatchApproved: draft ${draftId} is not in state 'approved'`,
    );
  }
  const approval = store.getApproval(approvalId);
  if (
    approval === null ||
    approval.draftId !== draftId ||
    approval.action !== 'approve'
  ) {
    throw unapproved(
      `dispatchApproved: approval ${approvalId} does not authorize draft ${draftId}`,
    );
  }
  // An agent may DRAFT, never approve (§1.7's actor constraint, same rule
  // the pure transition table enforces on the approve edge). An agent-actor
  // approval row is a forged authorization, so it takes the same path.
  if (approval.actor.kind === 'agent') {
    throw unapproved(
      `dispatchApproved: approval ${approvalId} was made by an agent actor, which may not approve`,
    );
  }
  const actor = approval.actor;
  /** §1.7: the system 'auto-respond' actor is the only auto-approval there is. */
  const isAutoApproval =
    actor.kind === 'system' && actor.reason === 'auto-respond';

  const parsed = parseChatGuid(draft.chatGuid);

  return withSendMutex(async () => {
    // THE re-gate, read after mutex acquisition (see the header note).
    const gate = evaluateGate({
      now: clock.now(),
      settings: readGateSettings(store),
      rule: null,
      schedule: null,
      contact: null,
      message: {
        isGroup: parsed.isGroup,
        service: parsed.service,
        handle: parsed.handle,
        chatGuid: draft.chatGuid,
      },
      // Zeros: the send-moment re-gate reads the deny rules, and rate is a
      // clamp rather than a deny. Converting a clamp into a send-moment
      // refusal is S6 Sc 10's job (F-59), and it needs the approval's own
      // provenance to do it — an approval a human made must not be refused
      // by a cap that only ever bound the machine.
      counters: {
        contactAutoLast2Min: 0,
        contactAutoLastHour: 0,
        globalSentLastHour: 0,
        consecutiveAutoInChat: 0,
        circuitOpen: false,
      },
    });
    const gateDeny = (reason: GateDenyReason): DispatchOutcome => {
      const error: DraftError = {
        code: 'gate-denied',
        message: `gate denied: ${reason}`,
        at: clock.now(),
      };
      const outcome = fail(store, clock, actor, draftId, error);
      appendAudit(store, clock, actor, {
        type: 'gate.denied',
        draftId,
        reason,
      });
      emit({ type: 'gate.denied', draftId, reason, at: clock.now() });
      return outcome;
    };
    if (!gate.allow) {
      return gateDeny(gate.reason);
    }
    // An auto-approval is only honored if the gate ALSO resolved to auto.
    // The commonest way it does not is INV-5's group clamp, which is exactly
    // the 'group-auto-forbidden' reason. A HUMAN approval on a group falls
    // through to the S3 'group-send-disabled' path below, unchanged (F-36:
    // both rows are pinned side by side in dispatcher.spec.ts).
    if (isAutoApproval && gate.mode !== 'auto') {
      return gateDeny(parsed.isGroup ? 'group-auto-forbidden' : 'unapproved');
    }

    if (parsed.isGroup) {
      return fail(store, clock, actor, draftId, {
        code: 'group-send-disabled',
        message: 'group sends are not supported (S3)',
        at: clock.now(),
      });
    }
    const resolved = await reader.resolveChat(parsed.handle);
    if (resolved === null) {
      return fail(store, clock, actor, draftId, {
        code: 'no-conversation',
        message: `no existing conversation for handle ${parsed.handle}`,
        at: clock.now(),
      });
    }
    if (resolved.isGroup) {
      return fail(store, clock, actor, draftId, {
        code: 'group-send-disabled',
        message: 'group sends are not supported (S3)',
        at: clock.now(),
      });
    }

    const attempt = store.beginSendAttempt(draftId, backendName, clock.now());
    appendAudit(store, clock, actor, {
      type: 'send.attempted',
      draftId,
      attempt: attempt.attempt,
      backend: backendName,
    });

    const sendStartedAt = clock.now();
    const sendResult = await backend.send({
      chatGuid: resolved.chatGuid,
      body: draft.body,
    });
    if (!sendResult.accepted) {
      return fail(store, clock, actor, draftId, {
        code: sendResult.errorCode ?? 'backend-error',
        message: sendResult.detail ?? 'send backend did not accept the send',
        at: clock.now(),
      });
    }

    const verified = await verifyPoll(reader, clock, delay, {
      chatGuid: resolved.chatGuid,
      body: draft.body,
      sendStartedAt,
    });
    if (!verified.verified) {
      return fail(store, clock, actor, draftId, {
        code: 'unverified',
        message:
          'send accepted but could not confirm in Messages history within 10s',
        at: clock.now(),
      });
    }

    store.markDraftSent(draftId, verified.guid, clock.now());
    appendAudit(store, clock, actor, {
      type: 'draft.sent',
      draftId,
      sentMessageGuid: verified.guid,
    });
    return { outcome: 'sent', sentMessageGuid: verified.guid };
  });
}

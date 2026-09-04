/**
 * s5-execution Scenario 8 — `draft.feedback`: the return leg of the loop.
 *
 * An agent proposes; a human, a clock, or the send path disposes. This file
 * is what closes that circuit: every terminal outcome of an agent-originated
 * draft becomes exactly one `draft.feedback` frame delivered to the adapter
 * that wrote it, carrying the acting `Actor` verbatim. Without it an agent
 * cannot tell a draft that was loved from one that was binned, which is the
 * difference between a system that converges and one that repeats itself.
 *
 * Four decisions, each of which is a test row:
 *
 *  - **Addressed, not announced.** The frame goes to `draft.adapterId` and
 *    nowhere else. Several adapters on one machine are several operators'
 *    agents; broadcasting a rejection reason to all of them would leak one
 *    conversation's contents to every agent on the box. Teeth
 *    T8-broadcast-feedback exists precisely to keep this honest.
 *  - **Best-effort, off the critical path.** Nothing here is awaited by an
 *    HTTP route, and every write to the socket is wrapped: a wedged or
 *    half-dead adapter must not be able to hold a human's `reject` hostage,
 *    or turn it into a 500. The failure mode of feedback is a log line.
 *  - **Dropped, never queued** (F-45's posture, reused). An adapter that is
 *    not connected gets `adapter.feedback-dropped {draftId, kind}` and
 *    nothing else — and gets nothing retroactively when it returns. An
 *    outbox that replays yesterday's rejections at reconnect would be a
 *    second, worse product.
 *  - **Humans are not agents** (F-22). A draft with `adapterId:'human'` is
 *    the reserved, permanently-disconnected anchor row. It produces no frame
 *    and not even a drop row: there is no addressee to have missed one.
 *
 * `correlation.requestId` is a FRESH id, not the id of the `draft.request`
 * that started this. That registry is in-process and bounded (see
 * `submit.ts`), and a draft can expire hours after its request fell out of
 * it; handing back a requestId nobody can still resolve would imply a
 * correlation we do not have. `correlation.draftId` is the one that matters
 * here, and it is always set — that is what row 1 asserts on every kind.
 *
 * INV-1 holds by construction: core never learns that adapters exist. The
 * send path's outcome reaches this file through `observeDispatch`, a
 * daemon-side wrapper around the `dispatchApproved` closure the scheduler
 * already takes as an injected dependency.
 */
import { ulid } from 'ulid';
import type { Actor, Clock, DraftError, Store, Ulid } from '@wemessage/core';
import {
  WIRE_VERSION,
  type DraftFeedbackFrame,
  type FeedbackKind,
} from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';

/** F-22: the reserved adapter row humans draft under. Never an addressee. */
const HUMAN_ADAPTER_ID = 'human';

/** The slice of the transport feedback needs. Nothing here can send iMessage. */
export interface FeedbackTransport {
  sendTo(adapterId: string, frame: unknown): boolean;
}

export interface FeedbackInput {
  draftId: Ulid;
  kind: FeedbackKind;
  actor: Actor;
  reason?: string;
  finalBody?: string;
  error?: DraftError;
}

/**
 * What the draft routes and the scheduler are given. Deliberately a bare
 * function: a route that could reach the transport could do more than tell
 * an agent what happened, and the narrowest possible seam is the point.
 */
export type DraftFeedbackTap = (input: FeedbackInput) => void;

/** The dispatch closure shape the scheduler already takes (s4 Scenario 6). */
export type DispatchFn = (draftId: Ulid, approvalId: Ulid) => Promise<unknown>;

export interface AgentFeedbackDeps {
  store: Store;
  clock: Clock;
  sink: Pick<AuditSink, 'append'>;
  transport: FeedbackTransport;
}

export interface AgentFeedback {
  /** Tell the originating adapter what became of its draft. Never throws. */
  emit: DraftFeedbackTap;
  /**
   * Wrap the `dispatchApproved` closure so a send outcome becomes feedback.
   * The wrapper lives HERE rather than in core because core has never heard
   * of an adapter and must not start now (INV-1).
   */
  observeDispatch(dispatch: DispatchFn): DispatchFn;
}

export function createAgentFeedback(deps: AgentFeedbackDeps): AgentFeedback {
  const { store, clock, sink, transport } = deps;

  const emit: DraftFeedbackTap = (input) => {
    const draft = store.getDraft(input.draftId);
    // A draft that is gone has no adapter to answer to. Nothing to record:
    // the caller's own audit row is the record that the thing happened.
    if (draft === null) return;
    const adapterId = draft.adapterId;
    if (adapterId === HUMAN_ADAPTER_ID) return;

    const frame: DraftFeedbackFrame = {
      v: WIRE_VERSION,
      id: ulid(),
      type: 'draft.feedback',
      ts: clock.now(),
      payload: {
        correlation: {
          requestId: ulid(),
          chatGuid: draft.chatGuid,
          // Omitted, never undefined (exactOptionalPropertyTypes), and
          // absent for a proactive draft that answers no inbound message.
          ...(draft.inboundGuid !== null
            ? { inboundGuid: draft.inboundGuid }
            : {}),
          draftId: draft.id,
        },
        kind: input.kind,
        actor: input.actor,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.finalBody !== undefined
          ? { finalBody: input.finalBody }
          : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
    };

    let delivered = false;
    try {
      delivered = transport.sendTo(adapterId, frame);
    } catch {
      // A socket that is present but unwritable is a socket that is not
      // there, as far as this frame is concerned. Same row, same posture.
      delivered = false;
    }
    if (!delivered) {
      sink.append(
        {
          type: 'adapter.feedback-dropped',
          adapterId,
          draftId: draft.id,
          kind: input.kind,
        },
        input.actor,
      );
    }
  };

  return {
    emit,
    observeDispatch(dispatch) {
      return async (draftId, approvalId) => {
        // An INV-2 validation throw propagates untouched: nothing was
        // decided about the draft, so there is nothing to report.
        const result = await dispatch(draftId, approvalId);
        const outcome = (result as { outcome?: unknown } | null)?.outcome;
        if (outcome !== 'sent' && outcome !== 'failed') return result;
        // The approving human is the actor: they are who acted on the
        // draft, and the send is the consequence of that act.
        const actor: Actor = store.getApproval(approvalId)?.actor ?? {
          kind: 'system',
          reason: 'rule-engine',
        };
        const draft = store.getDraft(draftId);
        if (outcome === 'sent') {
          emit({
            draftId,
            kind: 'send_verified',
            actor,
            // What actually went, which after an approve-with-edit is NOT
            // what the agent proposed.
            ...(draft !== null ? { finalBody: draft.body } : {}),
          });
        } else {
          emit({
            draftId,
            kind: 'send_failed',
            actor,
            ...(draft?.error != null ? { error: draft.error } : {}),
          });
        }
        return result;
      };
    },
  };
}

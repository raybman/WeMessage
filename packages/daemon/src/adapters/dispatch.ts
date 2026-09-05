/**
 * s5-execution Scenario 6 — inbound dispatch: `rule.matched` -> `draft.request`.
 *
 * The daemon's match pipeline used to end at an audit row. This is the step
 * that follows it: resolve the winning rule's adapter and hand the agent a
 * request. Everything here is written to make the failure modes boring.
 *
 *  - §2.4.3, ingestion is never gated. The message is already mirrored and
 *    `rule.matched` is already durable before a single adapter check runs;
 *    every refusal below aborts the DISPATCH, never the record.
 *  - §2.4.5, the agent sees `sanitizeInbound(message)` and nothing else. The
 *    raw `Message` (sourceRowid, isFromMe, attachment paths) and the rule's
 *    internals (matcher, schedule, TTL) stay on our side of the wire: an
 *    agent has no business seeing how it was selected, only that it was.
 *  - F-45, there is no queue. An adapter that is registered but has no live
 *    socket gets `adapter.unreachable` and the frame is dropped. A dropped
 *    request is honest; an outbox that replays yesterday's texts when an
 *    agent restarts is a second, worse product.
 *  - F-31, single winner. `evaluateRules` returns the full ordered list and
 *    this file takes the head, exactly as `daemon.ts` did — moving the
 *    policy but not changing it.
 *  - F-47, `hasDraftForMessage` is a real store read now. An edit whose draft
 *    is still live must not mint a second request; an edit whose draft was
 *    rejected must.
 *  - C-6 taxonomy: a dead adapter row is `gate.denied {adapter-disabled}` (a
 *    decision was made about this message); an absent socket is
 *    `adapter.unreachable` (nobody decided anything). Collapsing the two
 *    would make `gate.denied` mean "something adapter-ish went wrong".
 *
 * s6 Scenario 5 (F-60, closing C-3) adds the one thing this file was missing:
 * it consults `evaluateGate`. Through S5 it checked the adapter row and the
 * socket and then shipped a stranger's text to an agent, because §2.4.3's
 * deny-all default was enforced at the human draft route, at `draft.submit`
 * and at `proactive.propose` — every path EXCEPT the one an outsider can
 * trigger unaided. That was a security hole, not a missing feature, and the
 * consult below is the whole of the fix:
 *
 *  - a DENY means no frame, no draft, one `gate.denied` row. Ingestion is
 *    still never gated: the mirror and `rule.matched` are already durable.
 *  - a CLAMP (F-64) still builds the frame, but with the RESOLVED mode, so
 *    an agent is never told 'auto' for a message that structurally cannot
 *    auto-send. A clamp is not a denial and writes no `gate.denied` row.
 *  - the one variance is `outsideWindow: 'ignore'` plus a window clamp,
 *    which drops the message entirely (§1.7) — the rule author's explicit
 *    opt-in to not drafting at all, audited all the same because a message
 *    that produced nothing still deserves a row saying why.
 *
 * Ordering is load-bearing twice over. The consult sits AFTER the adapter-row
 * check, per F-60: two facts are true of a stranger texting a disabled
 * adapter, and the operator is told the one they can act on. It sits BEFORE
 * the connectivity check, per the C-6 reading above: `adapter.unreachable`
 * means nobody decided anything, and once the gate has refused somebody very
 * much did.
 *
 * This is the ONE file this slice adds to `PORT_IMPORTER_ALLOWLIST`
 * (ratchet update #16, F-46): it holds a `ChatDbReader` for `readChatTurns`,
 * because the conversation an agent needs to see includes our own replies and
 * the `inbound_messages` mirror holds inbound only.
 */
import { ulid } from 'ulid';
import type {
  ChatDbReader,
  Clock,
  GateDenyReason,
  Message,
  MessageGuid,
  Rule,
  Store,
} from '@wemessage/core';
import {
  evaluateGate,
  readGateCounters,
  evaluateRules,
  readGateSettings,
  systemActor,
} from '@wemessage/core';
import {
  WIRE_VERSION,
  type ConversationTurn,
  type DraftRequestFrame,
} from '@wemessage/protocol';
import type { AuditSink } from '../audit-sink.js';
import type { IssuedRequest } from './submit.js';
import { sanitizeInbound, stripControlChars } from '../sanitize.js';

/** §3.3 plan constants; not per-rule in v1 (F-48 governs draft TTL, not these). */
export const DRAFT_REQUEST_CONSTRAINTS = {
  maxChars: 2000,
  deadlineMs: 60_000,
} as const;

/** Plan §3.3: how much conversation an agent is given, at most. */
export const CONTEXT_TURN_LIMIT = 12;

/** The slice of the transport dispatch needs. Nothing here can send a message. */
export interface DispatchTransport {
  isConnected(adapterId: string): boolean;
  sendTo(adapterId: string, frame: unknown): boolean;
}

export interface InboundDispatchDeps {
  store: Store;
  clock: Clock;
  sink: AuditSink;
  reader: ChatDbReader;
  transport: DispatchTransport;
  /**
   * s5 Scenario 7: record the correlation we just put on the wire, so the
   * submit handler can tell a real answer from a forged one. Optional
   * because Scenario 6's dispatch is complete without it — a gateway with
   * no submit surface issues requests nobody can answer, which is exactly
   * what the S5 scenario order builds.
   */
  issueRequest?: (req: IssuedRequest) => void;
  /** Test seam for the correlation id; production mints a real ulid. */
  newRequestId?: () => string;
}

/**
 * s5 Scenario 8: the "put a `draft.request` on the wire for this rule and
 * this message" half of dispatch, extracted so the F-40 redraft route can
 * re-ask an agent without re-running rule evaluation. A redraft is not a
 * match — the rule already won, hours ago — so it must not consult
 * `evaluateRules`, the seen-set, or `hasDraftForMessage` (the S4 body copy
 * it was minted alongside would suppress it every time).
 */
export interface RequestSender {
  /** True when the frame actually left. Every refusal is audited here. */
  send(rule: Rule, message: Message): Promise<boolean>;
}

export interface InboundDispatch {
  /**
   * Match, record, then dispatch. Every observable side effect that must
   * survive a crash (the `rule.matched` append, its broadcast, the seen-set
   * entry) happens SYNCHRONOUSLY before the first `await`, so a caller that
   * fires this without awaiting still gets the §1.8 ordering.
   */
  emitWinner(message: Message, rules: readonly Rule[]): Promise<void>;
}

export function createRequestSender(deps: InboundDispatchDeps): RequestSender {
  const { store, clock, sink, reader, transport } = deps;
  const newRequestId = deps.newRequestId ?? ulid;

  const dispatch = async (rule: Rule, message: Message): Promise<boolean> => {
    const adapterId = rule.adapterId;
    /** One shape for every refusal on this path, so the taxonomy cannot drift. */
    const refuse = (reason: GateDenyReason): false => {
      sink.append(
        { type: 'gate.denied', reason, adapterId, guid: message.guid },
        systemActor('rule-engine'),
      );
      return false;
    };
    const adapter = store.getAdapter(adapterId);
    // Fail-closed on the row itself (§2.4.2). `hasToken` is the credential
    // check that matters here: a registered adapter whose token was revoked
    // could not authenticate anyway, and pretending otherwise would mean
    // building a frame for a socket that can never exist.
    if (adapter === null || !adapter.enabled || !adapter.hasToken) {
      return refuse('adapter-disabled');
    }

    // F-60: the draft-moment consult. The gate is ONE pure function called at
    // two moments (§2.4.1) and this is the first of them; the send moment is
    // `dispatchApproved`'s re-gate. Context is real, not a placeholder: the
    // winning rule (which carries the third scope, F-63), its schedule, and
    // the SENDER's contact policy — `message.handle` rather than the chat
    // guid's, because in a group it is this person who wrote, and core is
    // handed the message's own fields rather than a re-parse of its guid.
    // s6 Sc 6: `counters` are real here. This is the moment autonomy is
    // decided, so it is the moment the rate windows have to be read — and
    // `readGateCounters` reads them against the SAME instant the gate is
    // evaluated at, because a window edge that moved between the read and the
    // decision would be a cap that is off by whatever the two calls cost.
    const now = clock.now();
    const decision = evaluateGate({
      now,
      settings: readGateSettings(store),
      rule,
      schedule:
        rule.scheduleId === null ? null : store.getSchedule(rule.scheduleId),
      contact: store.getContactPolicy(message.handle),
      message: {
        isGroup: message.isGroup,
        service: message.service,
        handle: message.handle,
        chatGuid: message.chatGuid,
      },
      counters: readGateCounters(store, {
        now,
        handle: message.handle,
        chatGuid: message.chatGuid,
      }),
      // No `candidate`: at the INBOUND moment no draft body exists yet, so
      // only the streak half of the loop breaker can clamp here (s6 Sc 8).
      // The duplicate half needs a body and belongs to the send moment.
    });
    if (!decision.allow) return refuse(decision.reason);
    // The §1.7 variance, and the only place a CLAMP stops anything at this
    // moment: the rule author asked for silence outside its window. F-69's
    // unsupported 'queue' is deliberately not this branch — it falls through
    // and drafts, which is the safer of the two readings.
    if (
      decision.clampedBy === 'outside-window' &&
      rule.outsideWindow === 'ignore'
    ) {
      return refuse(decision.clampedBy);
    }

    if (!transport.isConnected(adapterId)) {
      sink.append(
        { type: 'adapter.unreachable', adapterId, guid: message.guid },
        systemActor('rule-engine'),
      );
      return false;
    }

    const turns = await reader.readChatTurns({
      chatGuid: message.chatGuid,
      limit: CONTEXT_TURN_LIMIT,
    });
    const context: ConversationTurn[] = turns.map((turn) => ({
      from: turn.from,
      // Same sanitizer as the message body: history is untrusted input too,
      // and a control character smuggled through a prior turn would be the
      // obvious way around a clean `message`.
      text: turn.text === null ? null : stripControlChars(turn.text),
      at: turn.at,
    }));

    const requestId = newRequestId();
    const frame: DraftRequestFrame = {
      v: WIRE_VERSION,
      id: ulid(),
      type: 'draft.request',
      ts: clock.now(),
      payload: {
        correlation: {
          requestId,
          chatGuid: message.chatGuid,
          inboundGuid: message.guid,
          // `draftId` is OMITTED: no draft exists yet, and an
          // `undefined`-valued key would not survive JSON round-trip anyway.
        },
        message: sanitizeInbound(message),
        context,
        // Identity, not internals: name and mode are what an agent needs to
        // answer well; the matcher and schedule are how we decided to ask.
        //
        // F-60: the RESOLVED mode, never the rule's declared one. A rule set
        // to 'auto' whose contact is 'draft-only', or whose window is shut,
        // cannot auto-send; telling the agent 'auto' would be telling it
        // something false about its own draft's future.
        rule: { id: rule.id, name: rule.name, respondMode: decision.mode },
        constraints: {
          maxChars: DRAFT_REQUEST_CONSTRAINTS.maxChars,
          deadlineMs: DRAFT_REQUEST_CONSTRAINTS.deadlineMs,
        },
      },
    };

    // The socket can close between the check above and here (a real race, not
    // a theoretical one: reading chat.db is the await). Same posture, same
    // row — dropped and recorded, never parked.
    if (!transport.sendTo(adapterId, frame)) {
      sink.append(
        { type: 'adapter.unreachable', adapterId, guid: message.guid },
        systemActor('rule-engine'),
      );
      return false;
    }
    // Only a request that actually LEFT is answerable. Recording it before
    // the send would make a dropped frame's requestId a valid credential.
    deps.issueRequest?.({
      adapterId,
      requestId,
      chatGuid: message.chatGuid,
      inboundGuid: message.guid,
      ruleId: rule.id,
    });
    return true;
  };

  return { send: dispatch };
}

export function createInboundDispatch(
  deps: InboundDispatchDeps,
): InboundDispatch {
  const { store, sink } = deps;
  const sender = createRequestSender(deps);
  // F-15: in-process (ruleId, guid) seen-set; a restart may re-audit a match.
  const seenMatches = new Set<string>();

  /**
   * F-47. The store's default `listDrafts()` IS the queue: terminal states
   * (rejected/expired/superseded/sent/...) are already excluded, so "a live
   * draft exists for this message" is exactly a non-empty match here. A
   * rejected draft leaves the queue, and the edit is free to re-match.
   */
  const hasDraftForMessage = (guid: MessageGuid): boolean =>
    store.listDrafts().some((draft) => draft.inboundGuid === guid);

  return {
    emitWinner(message, rules) {
      // F-12: core returns the FULL ordered list (priority ASC, id ASC); the
      // daemon enforces single winner by taking the head.
      const winner = evaluateRules(rules, message, { hasDraftForMessage })[0];
      if (winner === undefined) return Promise.resolve();
      // NUL as the separator because it is the one byte that cannot occur
      // in either half: a ULID is Crockford base32 and a chat.db GUID is
      // printable ASCII, so `a\u0000b` can only ever mean one pairing.
      // Written as the ESCAPE, not the byte (s7 Sc1, F-81): a raw 0x00 in
      // the source made `file(1)` call this module `data` and made plain
      // `grep` skip it. Same string at runtime, readable on disk.
      const seenKey = `${winner.id}\u0000${message.guid}`;
      if (seenMatches.has(seenKey)) return Promise.resolve();
      seenMatches.add(seenKey);
      // §1.8: the log is the record, the event is the courtesy — append
      // first, broadcast second, and only then talk to a third party.
      sink.append(
        {
          type: 'rule.matched',
          guid: message.guid,
          ruleId: winner.id,
          adapterId: winner.adapterId,
          ruleName: winner.name,
        },
        systemActor('rule-engine'),
      );
      sink.broadcast({
        event: 'rule.matched',
        guid: message.guid,
        ruleId: winner.id,
        adapterId: winner.adapterId,
      });
      return sender.send(winner, message).then(() => undefined);
    },
  };
}

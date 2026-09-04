/**
 * s3-execution.md Part 2 Scenario 6 — Gate v0 + `dispatchApproved`: INV-2
 * becomes code. Covers `packages/core/src/sending/dispatcher.ts` end to end
 * against pure fakes (object-literal ports, domain-types.spec.ts convention
 * — no real store/chat.db; `gate.spec.ts` covers `evaluateGate` in
 * isolation).
 *
 * Three named teeth (proven-then-reverted, see commit message):
 *  T1. delete the gate call inside dispatchApproved -> the kill-flip test
 *      ("re-gate on kill-switch") must fail.
 *  T2. move beginSendAttempt to AFTER backend.send -> the happy-path
 *      ordering assertion must fail.
 *  T3. mark sent immediately on accepted:true without awaiting verifyPoll
 *      -> the verify-timeout ("unverified") test must fail.
 */
import { describe, expect, it } from 'vitest';
import type {
  AdapterRecord,
  Approval,
  AuditEvent,
  ChatDbReader,
  Clock,
  ContactPolicy,
  Draft,
  DraftError,
  Rule,
  Schedule,
  SendBackend,
  SendOutcome,
  Store,
} from '@wemessage/core';
import {
  dispatchApproved,
  humanApiActor,
  parseChatGuid,
  type DispatchApprovedDeps,
  type DispatchGateDenied,
} from '@wemessage/core';

const NOW = '2026-09-01T12:00:00.000Z';
const ALLOW_SETTINGS: Record<string, string> = {
  'send.killSwitch': '0',
  'connection.state': 'fully-connected',
};

function makeDraft(partial: Partial<Draft> & { id: string }): Draft {
  return {
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15551234567',
    ruleId: null,
    adapterId: 'human',
    idempotencyKey: `idem-${partial.id}`,
    body: 'hello there',
    originalBody: 'hello there',
    state: 'approved',
    stateChangedAt: NOW,
    expiresAt: '2026-09-01T16:00:00.000Z',
    createdAt: NOW,
    ...partial,
  };
}

function makeApproval(
  partial: Partial<Approval> & { id: string; draftId: string },
): Approval {
  return {
    action: 'approve',
    actor: humanApiActor(),
    at: NOW,
    ...partial,
  };
}

/** Records every call as a `port.method:label` string; filterable per test. */
function makeStore(cfg: {
  draft: Draft | null;
  approval: Approval | null;
  settings?: Record<string, string>;
  calls: string[];
  auditEvents: AuditEvent[];
  /** s4 Scenario 4: the ledger attempt beginSendAttempt reports (retry threading). */
  attempt?: number;
  /**
   * s6 Sc 10: what `getAdapter(draft.adapterId)` answers. Defaults to null
   * — "no such adapter", the fail-closed answer — because that is what the
   * registry says about the F-22 'human' row every human-approved draft in
   * this suite carries, and because a fake that invents a credential is a
   * fake that hides the check. Only the rows exercising an AUTO approval
   * hand one over, since only they reach the check.
   */
  adapter?: AdapterRecord | null;
  /** s6 Sc 10: the draft's own rule/schedule/contact, rebuilt at send. */
  rule?: Rule | null;
  schedule?: Schedule | null;
  contact?: ContactPolicy | null;
}): Store {
  const settings = cfg.settings ?? {};
  return {
    getCursor: () => null,
    setCursor: () => undefined,
    getSetting: (key: string) => {
      cfg.calls.push(`getSetting:${key}`);
      return settings[key] ?? null;
    },
    setSetting: () => undefined,
    hasInboundMessage: () => false,
    insertInboundMessage: () => undefined,
    countInboundMessagesSince: () => 0,
    listSendingDrafts: () => [],
    markDraftSent: (id) => {
      cfg.calls.push(`markDraftSent:${id}`);
    },
    markDraftFailed: (id) => {
      cfg.calls.push(`markDraftFailed:${id}`);
    },
    listRules: () => [],
    getRule: (id: string) => {
      cfg.calls.push(`getRule:${id}`);
      return cfg.rule ?? null;
    },
    insertRule: () => undefined,
    updateRule: () => undefined,
    deleteRule: () => false,
    // s6 Scenario 3: the schedules half of the port. Read by the send-moment
    // re-gate since Sc 10 (F-59), and only through the draft's own rule, so
    // a fixture without a rule never reaches it. Absent a fixture the answer
    // is "no such schedule", which the gate treats as shut (fail-closed).
    listSchedules: () => [],
    getSchedule: (id: string) => {
      cfg.calls.push(`getSchedule:${id}`);
      return cfg.schedule ?? null;
    },
    insertSchedule: () => undefined,
    updateSchedule: () => undefined,
    deleteSchedule: () => undefined,
    countRulesUsingSchedule: () => 0,
    bumpRateCounter: () => undefined,
    sumRateCounter: () => 0,
    deleteSetting: () => undefined,
    countSendFailuresSince: () => 0,
    consecutiveAutoInChat: () => 0,
    recentSentBodies: () => [],
    lastAutoSentAt: () => null,
    listRecentInboundMessages: () => [],
    getInboundMessage: () => null,
    updateInboundMessage: () => undefined,
    appendAudit: (entry) => {
      const event = JSON.parse(entry.eventJson) as AuditEvent;
      cfg.auditEvents.push(event);
      cfg.calls.push(`appendAudit:${event.type}`);
      return { seq: cfg.auditEvents.length, hash: '0'.repeat(64) };
    },
    listAudit: () => [],
    readAuditRows: () => [],
    insertDraft: () => undefined,
    getDraft: (id) => {
      cfg.calls.push(`getDraft:${id}`);
      return cfg.draft !== null && cfg.draft.id === id ? cfg.draft : null;
    },
    insertApproval: () => undefined,
    getApproval: (id) => {
      cfg.calls.push(`getApproval:${id}`);
      return cfg.approval !== null && cfg.approval.id === id
        ? cfg.approval
        : null;
    },
    beginSendAttempt: (draftId) => {
      cfg.calls.push(`beginSendAttempt:${draftId}`);
      return { attempt: cfg.attempt ?? 1 };
    },
    // S4 Scenario 3 body extensions (§1.5). Unused by this suite; present so
    // the fake stays a real `Store` and the interface keeps its teeth.
    listDrafts: () => [],
    // s6 Sc 10: was `throw new Error('not used in this suite')` through S4
    // and S5, which was true until the send moment gained a transition of
    // its own (F-72's requeue). Records rather than throws now, including
    // the `sendNotBefore` key, because clearing that column is half of what
    // makes a requeued draft invisible to the scheduler.
    applyDraftTransition: (input) => {
      cfg.calls.push(
        `applyDraftTransition:${input.id}:${input.from}->${input.to}:snb=${
          'sendNotBefore' in input ? String(input.sendNotBefore) : 'absent'
        }`,
      );
      if (cfg.draft === null) throw new Error('no draft to transition');
      // The port hands back the row as it now stands. `sendNotBefore` is
      // dropped rather than echoed, since the only transition this suite
      // drives is the one that clears it, and under
      // exactOptionalPropertyTypes "cleared" means the key is gone.
      const next = { ...cfg.draft, state: input.to, stateChangedAt: input.at };
      delete next.sendNotBefore;
      return next;
    },
    updateDraftBody: () => undefined,
    findDraftByIdempotencyKey: () => null,
    // s4 Scenario 5: the approval history read behind GET /v1/drafts/:id.
    listApprovals: () => [],
    sendAttemptCount: () => 0,
    latestApproveApproval: () => null,
    listGraceElapsed: () => [],
    listExpiredPending: () => [],
    cancelGraceApproved: () => [],
    batchReport: () => ({
      sent: 0,
      failed: 0,
      recalled: 0,
      approved: 0,
      sending: 0,
    }),
    getContactPolicy: (handle: string) => {
      cfg.calls.push(`getContactPolicy:${handle}`);
      return cfg.contact ?? null;
    },
    setContactPolicy: () => undefined,
    deleteContactPolicy: () => false,
    listContactPolicies: () => [],
    getSettingVersion: () => -1,
    // s5 Scenario 3: adapter registry additions to the Store port.
    listAdapters: () => [],
    getAdapter: (id: string) => {
      cfg.calls.push(`getAdapter:${id}`);
      return cfg.adapter ?? null;
    },
    insertAdapter: () => undefined,
    updateAdapter: () => undefined,
    deleteAdapter: () => false,
    setAdapterTokenHash: () => undefined,
    rotateAdapterTokenHash: () => undefined,
    findAdapterByToken: () => null,
    setAdapterHealth: () => undefined,
    rawScanForToken: () => [],
    clearAdapterTokens: () => 0,
    close: () => undefined,
  };
}

function makeReader(cfg: {
  resolveChatResult: {
    chatGuid: string;
    service: 'imessage' | 'sms' | 'rcs' | 'unknown';
    isGroup: boolean;
  } | null;
  calls: string[];
  /** Sequence of results returned across successive poll calls; last value repeats past its end. */
  findOutboundQueue?: ({ guid: string } | null)[];
}): ChatDbReader {
  let pollIndex = 0;
  return {
    readSince: () => Promise.resolve([]),
    readMutatedSince: () => Promise.resolve([]),
    resolveChat: (handle) => {
      cfg.calls.push(`resolveChat:${handle}`);
      return Promise.resolve(cfg.resolveChatResult);
    },
    findOutboundMessage: () => {
      cfg.calls.push('findOutboundMessage');
      const queue = cfg.findOutboundQueue ?? [];
      const result =
        queue.length === 0
          ? null
          : (queue[Math.min(pollIndex, queue.length - 1)] ?? null);
      pollIndex++;
      return Promise.resolve(result);
    },
    // s5 Scenario 6 (F-46): dispatch-time conversation context. The send
    // path never reads it; present so the fake still satisfies the port.
    readChatTurns: () => Promise.resolve([]),
  };
}

function makeBackend(cfg: {
  result: SendOutcome;
  calls: string[];
  delayMs?: number;
}): SendBackend {
  return {
    isAvailable: () => Promise.resolve(true),
    send: (input) => {
      cfg.calls.push(`send:${input.body}`);
      if (cfg.delayMs === undefined) return Promise.resolve(cfg.result);
      return new Promise((resolve) =>
        setTimeout(() => resolve(cfg.result), cfg.delayMs),
      );
    },
  };
}

/** Injected clock + `delay` that advances the SAME virtual instant — verify-poll budget tests run instantly, deterministically. */
function makeVirtualClock(startIso = NOW): {
  clock: Clock;
  delay: (ms: number) => Promise<void>;
} {
  let ms = Date.parse(startIso);
  const clock: Clock = {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
  };
  const delay = (deltaMs: number): Promise<void> => {
    ms += deltaMs;
    return Promise.resolve();
  };
  return { clock, delay };
}

describe('parseChatGuid', () => {
  it('parses a 1:1 guid into handle/service/isGroup:false', () => {
    expect(parseChatGuid('iMessage;-;+15551234567')).toEqual({
      handle: '+15551234567',
      service: 'imessage',
      isGroup: false,
    });
    expect(parseChatGuid('SMS;-;+15559998888')).toEqual({
      handle: '+15559998888',
      service: 'sms',
      isGroup: false,
    });
  });

  it('parses a group-style guid (no ;-; separator) as isGroup:true, empty handle', () => {
    expect(parseChatGuid('iMessage;+;chat123456789')).toEqual({
      handle: '',
      service: 'imessage',
      isGroup: true,
    });
  });
});

describe('dispatchApproved (s3 Scenario 6)', () => {
  it('throws — zero backend calls — when the draft is absent', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({ draft: null, approval: null, calls, auditEvents }),
      reader: makeReader({ resolveChatResult: null, calls: [] }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    await expect(dispatchApproved(deps, 'nope', 'A1')).rejects.toThrow();
    expect(backendCalls).toEqual([]);
  });

  it('throws — zero backend calls — when the draft is not in state approved', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const draft = makeDraft({ id: 'D1', state: 'pending' });
    const approval = makeApproval({ id: 'A1', draftId: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({ draft, approval, calls, auditEvents }),
      reader: makeReader({ resolveChatResult: null, calls: [] }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    await expect(dispatchApproved(deps, 'D1', 'A1')).rejects.toThrow();
    expect(backendCalls).toEqual([]);
  });

  it.each([
    ['approval absent', null] as const,
    [
      'approval.draftId mismatches',
      makeApproval({ id: 'A1', draftId: 'OTHER-DRAFT' }),
    ] as const,
    [
      'approval.action is not approve',
      makeApproval({ id: 'A1', draftId: 'D1', action: 'reject' }),
    ] as const,
  ])('throws — zero backend calls — when %s', async (_label, approval) => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const draft = makeDraft({ id: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({ draft, approval, calls, auditEvents }),
      reader: makeReader({ resolveChatResult: null, calls: [] }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    await expect(dispatchApproved(deps, 'D1', 'A1')).rejects.toThrow();
    expect(backendCalls).toEqual([]);
  });

  it('happy path: exact call ordering + audit order, ends sent', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const draft = makeDraft({ id: 'D1' });
    const approval = makeApproval({ id: 'A1', draftId: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({
        draft,
        approval,
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      }),
      reader: makeReader({
        resolveChatResult: {
          chatGuid: 'iMessage;-;+15551234567',
          service: 'imessage',
          isGroup: false,
        },
        calls,
        findOutboundQueue: [{ guid: 'MSG-1' }],
      }),
      backend: makeBackend({
        result: { accepted: true },
        // Shared `calls` log (NOT a separate array) — the whole point of
        // this test is proving beginSendAttempt precedes backend.send;
        // routing both into one ordered log is what makes teeth T2
        // (swap that order) actually observable here.
        calls,
      }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    const outcome = await dispatchApproved(deps, 'D1', 'A1');

    expect(outcome).toEqual({ outcome: 'sent', sentMessageGuid: 'MSG-1' });
    const macroCalls = calls.filter(
      (c) => !c.startsWith('getSetting:') && !c.startsWith('appendAudit:'),
    );
    // s6 Sc 10 (F-59) added the contact read: the send-moment re-gate now
    // rebuilds the draft's own context instead of passing nulls. This draft
    // is rule-less, so `getRule` and `getSchedule` are absent from the trace
    // — which is the F-20 human pin visible as a call sequence rather than
    // as an outcome. The read sits before `resolveChat` because the gate
    // decides whether to send before anything reaches for the chat.
    expect(macroCalls).toEqual([
      'getDraft:D1',
      'getApproval:A1',
      'getContactPolicy:+15551234567',
      'resolveChat:+15551234567',
      'beginSendAttempt:D1',
      'send:hello there',
      'findOutboundMessage',
      'markDraftSent:D1',
    ]);
    expect(calls.filter((c) => c.startsWith('send:'))).toEqual([
      'send:hello there',
    ]);
    expect(auditEvents.map((e) => e.type)).toEqual([
      'send.attempted',
      'draft.sent',
    ]);
  });

  it('re-gate: kill-switch set at dispatch time -> gate-denied failure, emit fired once, backend never called', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const emitted: DispatchGateDenied[] = [];
    const draft = makeDraft({ id: 'D1' });
    const approval = makeApproval({ id: 'A1', draftId: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({
        draft,
        approval,
        settings: {
          'send.killSwitch': '1',
          'connection.state': 'fully-connected',
        },
        calls,
        auditEvents,
      }),
      reader: makeReader({ resolveChatResult: null, calls }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      clock,
      delay,
      backendName: 'applescript',
      emit: (event) => emitted.push(event),
    };
    const outcome = await dispatchApproved(deps, 'D1', 'A1');
    expect(outcome.outcome).toBe('failed');
    const error = (outcome as { error: DraftError }).error;
    expect(error.code).toBe('gate-denied');
    expect(error.message).toContain('kill-switch');
    expect(backendCalls).toEqual([]);
    expect(calls.filter((c) => c.startsWith('resolveChat:'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('beginSendAttempt:'))).toEqual([]);
    expect(emitted).toEqual([
      { type: 'gate.denied', draftId: 'D1', reason: 'kill-switch', at: NOW },
    ]);
    // ADJUSTED in s4 Scenario 4 (planned conflict #5): S3 asserted
    // ['draft.failed'] alone. F-35 adds an explicit `gate.denied` audit row
    // to every denial so the reason survives in the log, not just in the
    // DraftError message. The draft.failed row and its ordering are
    // unchanged; this is strictly an addition.
    expect(auditEvents.map((e) => e.type)).toEqual([
      'draft.failed',
      'gate.denied',
    ]);
  });

  it('two concurrent dispatchApproved calls on different drafts never interleave their send-critical-sections', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const draft1 = makeDraft({
      id: 'D1',
      chatGuid: 'iMessage;-;+15551110001',
      body: 'msg-one',
    });
    const draft2 = makeDraft({
      id: 'D2',
      chatGuid: 'iMessage;-;+15551110002',
      body: 'msg-two',
    });
    const approval1 = makeApproval({ id: 'A1', draftId: 'D1' });
    const approval2 = makeApproval({ id: 'A2', draftId: 'D2' });

    function harnessFor(draft: Draft, approval: Approval) {
      const { clock, delay } = makeVirtualClock();
      const store = makeStore({
        draft,
        approval,
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      });
      const reader = makeReader({
        resolveChatResult: {
          chatGuid: draft.chatGuid,
          service: 'imessage',
          isGroup: false,
        },
        calls,
        findOutboundQueue: [{ guid: `MSG-${draft.id}` }],
      });
      const backend = makeBackend({
        result: { accepted: true },
        calls: backendCalls,
        delayMs: 15,
      });
      const deps: DispatchApprovedDeps = {
        store,
        reader,
        backend,
        clock,
        delay,
        backendName: 'applescript',
        emit: () => undefined,
      };
      return deps;
    }

    const deps1 = harnessFor(draft1, approval1);
    const deps2 = harnessFor(draft2, approval2);

    const [o1, o2] = await Promise.all([
      dispatchApproved(deps1, 'D1', 'A1'),
      dispatchApproved(deps2, 'D2', 'A2'),
    ]);
    expect(o1).toEqual({ outcome: 'sent', sentMessageGuid: 'MSG-D1' });
    expect(o2).toEqual({ outcome: 'sent', sentMessageGuid: 'MSG-D2' });

    // The critical section per draft is begin -> send -> mark; assert those
    // three markers never interleave across drafts (mutex serialization).
    const critical = calls.filter(
      (c) =>
        c.startsWith('beginSendAttempt:') || c.startsWith('markDraftSent:'),
    );
    const sendOrder = backendCalls.map((c) =>
      c === 'send:msg-one' ? 'D1' : 'D2',
    );
    // Reconstruct interleaved (begin, send, mark) triples per draft and
    // check no OTHER draft's begin appears between one draft's begin/mark.
    const beginIdxD1 = critical.indexOf('beginSendAttempt:D1');
    const markIdxD1 = critical.indexOf('markDraftSent:D1');
    const beginIdxD2 = critical.indexOf('beginSendAttempt:D2');
    const markIdxD2 = critical.indexOf('markDraftSent:D2');
    const d1Start = Math.min(beginIdxD1, markIdxD1);
    const d1End = Math.max(beginIdxD1, markIdxD1);
    const d2Start = Math.min(beginIdxD2, markIdxD2);
    const d2End = Math.max(beginIdxD2, markIdxD2);
    const overlaps = d1Start <= d2End && d2Start <= d1End;
    expect(overlaps).toBe(false);
    expect(sendOrder).toHaveLength(2);
  });

  it('resolveChat returns null -> no-conversation failure, backend never called', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const draft = makeDraft({ id: 'D1' });
    const approval = makeApproval({ id: 'A1', draftId: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({
        draft,
        approval,
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      }),
      reader: makeReader({ resolveChatResult: null, calls }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    const outcome = await dispatchApproved(deps, 'D1', 'A1');
    expect(outcome).toMatchObject({
      outcome: 'failed',
      error: { code: 'no-conversation' },
    });
    expect(backendCalls).toEqual([]);
  });

  it.each([
    [
      'draft.chatGuid is group-style (short-circuits before resolveChat)',
      makeDraft({ id: 'D1', chatGuid: 'iMessage;+;chat123456789' }),
      {
        chatGuid: 'iMessage;+;chat123456789',
        service: 'imessage' as const,
        isGroup: false,
      },
      false, // resolveChat should NOT be called
    ] as const,
    [
      'resolveChat itself reports isGroup:true',
      makeDraft({ id: 'D1' }),
      {
        chatGuid: 'iMessage;-;+15551234567',
        service: 'imessage' as const,
        isGroup: true,
      },
      true, // resolveChat SHOULD be called
    ] as const,
  ])(
    '%s -> group-send-disabled failure',
    async (_label, draft, resolveChatResult, expectResolveChatCalled) => {
      const calls: string[] = [];
      const auditEvents: AuditEvent[] = [];
      const backendCalls: string[] = [];
      const approval = makeApproval({ id: 'A1', draftId: 'D1' });
      const { clock, delay } = makeVirtualClock();
      const deps: DispatchApprovedDeps = {
        store: makeStore({
          draft,
          approval,
          settings: ALLOW_SETTINGS,
          calls,
          auditEvents,
        }),
        reader: makeReader({ resolveChatResult, calls }),
        backend: makeBackend({
          result: { accepted: true },
          calls: backendCalls,
        }),
        clock,
        delay,
        backendName: 'applescript',
        emit: () => undefined,
      };
      const outcome = await dispatchApproved(deps, 'D1', 'A1');
      expect(outcome).toMatchObject({
        outcome: 'failed',
        error: { code: 'group-send-disabled' },
      });
      expect(backendCalls).toEqual([]);
      expect(calls.some((c) => c.startsWith('resolveChat:'))).toBe(
        expectResolveChatCalled,
      );
    },
  );

  it('backend rejects the send -> failed with the backend errorCode, no verify poll attempted', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const draft = makeDraft({ id: 'D1' });
    const approval = makeApproval({ id: 'A1', draftId: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({
        draft,
        approval,
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      }),
      reader: makeReader({
        resolveChatResult: {
          chatGuid: 'iMessage;-;+15551234567',
          service: 'imessage',
          isGroup: false,
        },
        calls,
      }),
      backend: makeBackend({
        result: { accepted: false, errorCode: 'messages-not-running' },
        calls: backendCalls,
      }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    const outcome = await dispatchApproved(deps, 'D1', 'A1');
    expect(outcome).toMatchObject({
      outcome: 'failed',
      error: { code: 'messages-not-running' },
    });
    expect(calls.filter((c) => c === 'findOutboundMessage')).toEqual([]);
    expect(auditEvents.map((e) => e.type)).toEqual([
      'send.attempted',
      'draft.failed',
    ]);
  });

  it('backend accepts but verify never finds the outbound row within budget -> unverified failure, never marked sent', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const draft = makeDraft({ id: 'D1' });
    const approval = makeApproval({ id: 'A1', draftId: 'D1' });
    const { clock, delay } = makeVirtualClock();
    const deps: DispatchApprovedDeps = {
      store: makeStore({
        draft,
        approval,
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      }),
      reader: makeReader({
        resolveChatResult: {
          chatGuid: 'iMessage;-;+15551234567',
          service: 'imessage',
          isGroup: false,
        },
        calls,
        findOutboundQueue: [], // always null
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      clock,
      delay,
      backendName: 'applescript',
      emit: () => undefined,
    };
    const outcome = await dispatchApproved(deps, 'D1', 'A1');
    expect(outcome).toMatchObject({
      outcome: 'failed',
      error: { code: 'unverified' },
    });
    expect(calls.filter((c) => c.startsWith('markDraftSent:'))).toEqual([]);
    expect(auditEvents.map((e) => e.type)).toEqual([
      'send.attempted',
      'draft.failed',
    ]);
  });
});

/**
 * s4-execution.md Part 2 Scenario 4 — dispatcher revisions.
 *
 * Teeth: move the re-gate back outside the mutex -> the
 * flip-between-two-queued-dispatches row fails; drop the group clamp in
 * gate v1 -> the INV-5 auto-on-a-group row fails.
 */
const AUTO_ACTOR = { kind: 'system' as const, reason: 'auto-respond' as const };
const GROUP_GUID = 'iMessage;+;chat123456789';

/**
 * s6 Sc 10. Every AUTO fixture below now names a registered adapter and
 * hands the fake a row for it. Before Sc 10 they all inherited
 * `adapterId: 'human'` and the dispatcher never looked, which was harmless
 * while nothing read the registry and became a lie the moment it did: an
 * autonomous send is made ON BEHALF of a credential, and a fixture that
 * skips the credential is not testing the autonomous path.
 */
const AUTO_ADAPTER_ID = 'a-bot';
const LIVE_ADAPTER: AdapterRecord = {
  id: AUTO_ADAPTER_ID,
  kind: 'generic',
  displayName: 'bot',
  enabled: true,
  hasToken: true,
  health: 'connected',
  config: {},
};

function baseDeps(over: Partial<DispatchApprovedDeps>): DispatchApprovedDeps {
  const { clock, delay } = makeVirtualClock();
  return {
    reader: makeReader({ resolveChatResult: null, calls: [] }),
    backend: makeBackend({ result: { accepted: true }, calls: [] }),
    clock,
    delay,
    backendName: 'applescript',
    emit: () => undefined,
    ...over,
  } as DispatchApprovedDeps;
}

describe('dispatchApproved (s4 Scenario 4 revisions)', () => {
  it('the re-gate settings read happens AFTER mutex acquisition', async () => {
    // Two dispatches queue behind the send mutex; the kill switch flips
    // between them. With a PRE-mutex gate read, the second dispatch reads
    // settings at call time (before the flip) and sends anyway. Only a gate
    // read taken after acquiring the mutex can see the flip.
    const settings: Record<string, string> = { ...ALLOW_SETTINGS };
    const mk = (
      id: string,
      backendCalls: string[],
      auditEvents: AuditEvent[],
      delayMs?: number,
    ): DispatchApprovedDeps => {
      const draft = makeDraft({ id });
      const approval = makeApproval({ id: `A-${id}`, draftId: id });
      const { clock, delay } = makeVirtualClock();
      return {
        store: makeStore({
          draft,
          approval,
          settings,
          calls: [],
          auditEvents,
        }),
        reader: makeReader({
          resolveChatResult: {
            chatGuid: draft.chatGuid,
            service: 'imessage',
            isGroup: false,
          },
          calls: [],
          findOutboundQueue: [{ guid: `guid-${id}` }],
        }),
        backend: makeBackend({
          result: { accepted: true },
          calls: backendCalls,
          ...(delayMs !== undefined ? { delayMs } : {}),
        }),
        clock,
        delay,
        backendName: 'applescript',
        emit: () => undefined,
      };
    };

    const firstBackend: string[] = [];
    const secondBackend: string[] = [];
    const secondAudit: AuditEvent[] = [];
    const first = dispatchApproved(
      mk('D1', firstBackend, [], 20),
      'D1',
      'A-D1',
    );
    // Let D1 actually acquire the mutex and pass its own gate (the mutex body
    // starts in a microtask, so without this the flip would deny D1 too and
    // the test would prove nothing).
    await new Promise((resolve) => setTimeout(resolve, 5));

    // D2 is CALLED before the flip. Its synchronous prefix runs immediately,
    // so a pre-mutex gate read would happen here, on pre-flip settings, and
    // D2 would send. Only a post-mutex read sees what happens next.
    const second = dispatchApproved(
      mk('D2', secondBackend, secondAudit),
      'D2',
      'A-D2',
    );
    settings['send.killSwitch'] = '1';

    expect(await first).toEqual({
      outcome: 'sent',
      sentMessageGuid: 'guid-D1',
    });
    expect(firstBackend).toHaveLength(1);

    const secondResult = await second;
    expect(secondResult).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'gate-denied',
        message: 'gate denied: kill-switch',
      }),
    });
    expect(secondBackend).toEqual([]);
    expect(secondAudit.map((e) => e.type)).toEqual([
      'draft.failed',
      'gate.denied',
    ]);
  });

  it('a mismatched approval throws AND audits exactly one gate.denied:unapproved', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const readerCalls: string[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft: makeDraft({ id: 'D1' }),
        // Approval points at a DIFFERENT draft: forged authorization.
        approval: makeApproval({ id: 'A1', draftId: 'D-other' }),
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      }),
      reader: makeReader({ resolveChatResult: null, calls: readerCalls }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
    });

    await expect(dispatchApproved(deps, 'D1', 'A1')).rejects.toThrow(
      /does not authorize/,
    );
    expect(auditEvents).toEqual([
      { type: 'gate.denied', draftId: 'D1', reason: 'unapproved' },
    ]);
    // Nothing downstream of validation ran.
    expect(readerCalls).toEqual([]);
    expect(backendCalls).toEqual([]);
    expect(calls.filter((c) => c.startsWith('beginSendAttempt'))).toEqual([]);
  });

  it('an AGENT-actor approval takes the same throw+audit path (agents may draft, never approve)', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft: makeDraft({ id: 'D1' }),
        approval: makeApproval({
          id: 'A1',
          draftId: 'D1',
          actor: { kind: 'agent', adapterId: 'echo' },
        }),
        settings: ALLOW_SETTINGS,
        calls,
        auditEvents,
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
    });

    await expect(dispatchApproved(deps, 'D1', 'A1')).rejects.toThrow(
      /agent actor/,
    );
    expect(auditEvents).toEqual([
      { type: 'gate.denied', draftId: 'D1', reason: 'unapproved' },
    ]);
    expect(backendCalls).toEqual([]);
    expect(calls.filter((c) => c.startsWith('beginSendAttempt'))).toEqual([]);
  });

  it('INV-5: a system-auto approval on a GROUP -> failed, gate.denied:group-auto-forbidden', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const emitted: DispatchGateDenied[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft: makeDraft({
          id: 'D1',
          chatGuid: GROUP_GUID,
          adapterId: AUTO_ADAPTER_ID,
        }),
        approval: makeApproval({ id: 'A1', draftId: 'D1', actor: AUTO_ACTOR }),
        // Global auto and a live credential: the ONLY thing standing
        // between this and a send is the group clamp.
        settings: { ...ALLOW_SETTINGS, 'send.globalMode': 'auto' },
        adapter: LIVE_ADAPTER,
        calls,
        auditEvents,
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
      emit: (e) => emitted.push(e),
    });

    const result = await dispatchApproved(deps, 'D1', 'A1');
    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'gate-denied',
        message: 'gate denied: group-auto-forbidden',
      }),
    });
    expect(auditEvents).toEqual([
      { type: 'draft.failed', draftId: 'D1', error: expect.anything() },
      { type: 'gate.denied', draftId: 'D1', reason: 'group-auto-forbidden' },
    ]);
    expect(emitted.map((e) => e.reason)).toEqual(['group-auto-forbidden']);
    expect(backendCalls).toEqual([]);
  });

  it('F-36: a HUMAN approval on a group still gets the S3 group-send-disabled error, unchanged', async () => {
    // Pinned side by side with the row above: same group guid, same auto
    // global, different actor, materially different outcome.
    const backendCalls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft: makeDraft({ id: 'D1', chatGuid: GROUP_GUID }),
        approval: makeApproval({ id: 'A1', draftId: 'D1' }),
        settings: { ...ALLOW_SETTINGS, 'send.globalMode': 'auto' },
        calls: [],
        auditEvents,
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
    });

    const result = await dispatchApproved(deps, 'D1', 'A1');
    expect(result).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({ code: 'group-send-disabled' }),
    });
    expect(auditEvents.map((e) => e.type)).toEqual(['draft.failed']);
    expect(backendCalls).toEqual([]);
  });

  it('a system-auto approval on a 1:1 chat at global auto DOES send (the clamp is group-only)', async () => {
    const draft = makeDraft({ id: 'D1', adapterId: AUTO_ADAPTER_ID });
    const backendCalls: string[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft,
        approval: makeApproval({ id: 'A1', draftId: 'D1', actor: AUTO_ACTOR }),
        settings: { ...ALLOW_SETTINGS, 'send.globalMode': 'auto' },
        adapter: LIVE_ADAPTER,
        calls: [],
        auditEvents: [],
      }),
      reader: makeReader({
        resolveChatResult: {
          chatGuid: draft.chatGuid,
          service: 'imessage',
          isGroup: false,
        },
        calls: [],
        findOutboundQueue: [{ guid: 'guid-1' }],
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
    });

    expect(await dispatchApproved(deps, 'D1', 'A1')).toEqual({
      outcome: 'sent',
      sentMessageGuid: 'guid-1',
    });
    expect(backendCalls).toHaveLength(1);
  });

  it('a system-auto approval at DRAFT-ONLY global is refused even 1:1', async () => {
    // An auto approval is only honored if the gate also resolved to auto.
    const backendCalls: string[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft: makeDraft({ id: 'D1', adapterId: AUTO_ADAPTER_ID }),
        approval: makeApproval({ id: 'A1', draftId: 'D1', actor: AUTO_ACTOR }),
        settings: ALLOW_SETTINGS,
        adapter: LIVE_ADAPTER,
        calls: [],
        auditEvents: [],
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
    });

    // s6 Sc 10 sharpened the assertion from a bare `code: 'gate-denied'` to
    // the reason: with an adapter check now sitting in front of the mode
    // check, a row that only asserts the code would pass for entirely the
    // wrong reason if the fixture's credential ever went missing.
    expect(await dispatchApproved(deps, 'D1', 'A1')).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({
        code: 'gate-denied',
        message: 'gate denied: unapproved',
      }),
    });
    expect(backendCalls).toEqual([]);
  });

  it('threads the ledger attempt into the send.attempted audit payload', async () => {
    const draft = makeDraft({ id: 'D1' });
    const auditEvents: AuditEvent[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft,
        approval: makeApproval({ id: 'A1', draftId: 'D1' }),
        settings: ALLOW_SETTINGS,
        calls: [],
        auditEvents,
        // A re-approved draft on its second try (C-10).
        attempt: 2,
      }),
      reader: makeReader({
        resolveChatResult: {
          chatGuid: draft.chatGuid,
          service: 'imessage',
          isGroup: false,
        },
        calls: [],
        findOutboundQueue: [{ guid: 'guid-1' }],
      }),
      backend: makeBackend({ result: { accepted: true }, calls: [] }),
    });

    await dispatchApproved(deps, 'D1', 'A1');
    expect(auditEvents).toContainEqual({
      type: 'send.attempted',
      draftId: 'D1',
      attempt: 2,
      backend: 'applescript',
    });
  });
});

/**
 * s6-execution Part 2 Scenario 10 — the send-moment re-gate becomes
 * context-bearing (F-59), at the unit level.
 *
 * `outside-window.spec.ts` owns this scenario end to end against a real
 * store, a real scheduler and real HTTP. These rows exist for the half of
 * the behaviour that is a property of `dispatchApproved` itself and is
 * cheaper to state without a daemon around it: WHICH ports the rebuilt
 * context reads, and the fact that every consequence of a clamp is scoped
 * to a machine approver. A denial that binds a person is a different
 * product, and it should take more than an inattentive edit to ship one.
 */
describe('s6 Sc 10: the context-bearing re-gate (F-59)', () => {
  const RULE_ID = '01J0000000000000000000RULE';
  const SCHEDULE_ID = '01J0000000000000000000SCHD';
  const HANDLE = '+15551234567';
  const shutRule: Rule = {
    id: RULE_ID,
    name: 'r',
    enabled: true,
    // Never evaluated here: the matcher chose this rule long before the
    // grace began, and the send moment only reads what the rule PERMITS.
    matcher: { kind: 'keyword', keywords: ['hello'], mode: 'any' },
    adapterId: AUTO_ADAPTER_ID,
    respondMode: 'auto',
    scheduleId: SCHEDULE_ID,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 240,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  /**
   * §1.3.5's deny-all default means a rule-borne draft to a handle with NO
   * contact row is denied 'contact-denied' before any clamp is reached, so
   * every rule-borne fixture here has to carry an allowing policy to be
   * testing what it says it is testing. Overridden only by the row that
   * wants the deny.
   */
  const allowedContact: ContactPolicy = {
    handle: HANDLE,
    mode: 'auto',
    updatedAt: NOW,
  };
  // NOW is 12:00Z; this window shut two hours ago.
  const shutSchedule: Schedule = {
    id: SCHEDULE_ID,
    name: 's',
    timezone: 'UTC',
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '09:00',
        end: '10:00',
      },
    ],
    enabled: true,
  };

  const autoDeps = (over: {
    calls: string[];
    auditEvents: AuditEvent[];
    backendCalls: string[];
    adapter?: AdapterRecord | null;
    rule?: Rule | null;
    schedule?: Schedule | null;
    contact?: ContactPolicy | null;
    actor?: Approval['actor'];
    emitted?: DispatchGateDenied[];
  }): DispatchApprovedDeps => {
    const draft = makeDraft({
      id: 'D1',
      adapterId: AUTO_ADAPTER_ID,
      ...(over.rule === undefined || over.rule === null
        ? {}
        : { ruleId: over.rule.id }),
    });
    return baseDeps({
      store: makeStore({
        draft,
        approval: makeApproval({
          id: 'A1',
          draftId: 'D1',
          actor: over.actor ?? AUTO_ACTOR,
        }),
        settings: { ...ALLOW_SETTINGS, 'send.globalMode': 'auto' },
        adapter: over.adapter === undefined ? LIVE_ADAPTER : over.adapter,
        ...(over.rule === undefined ? {} : { rule: over.rule }),
        ...(over.schedule === undefined ? {} : { schedule: over.schedule }),
        contact: over.contact === undefined ? allowedContact : over.contact,
        calls: over.calls,
        auditEvents: over.auditEvents,
      }),
      reader: makeReader({
        resolveChatResult: {
          chatGuid: draft.chatGuid,
          service: 'imessage',
          isGroup: false,
        },
        calls: [],
        findOutboundQueue: [{ guid: 'guid-1' }],
      }),
      backend: makeBackend({
        result: { accepted: true },
        calls: over.backendCalls,
      }),
      ...(over.emitted === undefined
        ? {}
        : { emit: (e: DispatchGateDenied) => over.emitted?.push(e) }),
    });
  };

  it("rebuilds the DRAFT'S context: rule, then that rule's schedule, then the contact", async () => {
    const calls: string[] = [];
    await dispatchApproved(
      autoDeps({
        calls,
        auditEvents: [],
        backendCalls: [],
        rule: { ...shutRule, scheduleId: null },
      }),
      'D1',
      'A1',
    );
    // The schedule is reached THROUGH the rule and never independently: a
    // rule with no schedule is always armed, so there is nothing to look up.
    expect(calls.filter((c) => c.startsWith('getRule:'))).toEqual([
      `getRule:${RULE_ID}`,
    ]);
    expect(calls.filter((c) => c.startsWith('getSchedule:'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('getContactPolicy:'))).toEqual([
      `getContactPolicy:${HANDLE}`,
    ]);
  });

  it('a window that shut during the grace requeues instead of failing (F-72)', async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const backendCalls: string[] = [];
    const emitted: DispatchGateDenied[] = [];

    const outcome = await dispatchApproved(
      autoDeps({
        calls,
        auditEvents,
        backendCalls,
        emitted,
        rule: shutRule,
        schedule: shutSchedule,
      }),
      'D1',
      'A1',
    );

    expect(outcome).toEqual({ outcome: 'requeued', reason: 'outside-window' });
    // The state change and the cleared deadline are ONE statement: a
    // requeued draft that kept its `send_not_before` would be picked up by
    // the very next grace sweep, which is a resurrection, not a requeue.
    expect(calls.filter((c) => c.startsWith('applyDraftTransition:'))).toEqual([
      'applyDraftTransition:D1:approved->pending:snb=null',
    ]);
    // Neither the ledger nor the backend was touched: nothing was attempted,
    // so nothing may be counted as an attempt.
    expect(calls.filter((c) => c.startsWith('beginSendAttempt'))).toEqual([]);
    expect(backendCalls).toEqual([]);
    expect(auditEvents).toEqual([
      { type: 'draft.requeued', draftId: 'D1', reason: 'outside-window' },
      { type: 'gate.denied', draftId: 'D1', reason: 'outside-window' },
    ]);
    expect(emitted.map((e) => e.reason)).toEqual(['outside-window']);
  });

  it('a human approval on that same shut-window draft sends anyway', async () => {
    // The whole point of F-72's requeue is to put the decision back in front
    // of a person. A person then making it must not hit the same wall.
    const calls: string[] = [];
    const backendCalls: string[] = [];
    const outcome = await dispatchApproved(
      autoDeps({
        calls,
        auditEvents: [],
        backendCalls,
        rule: shutRule,
        schedule: shutSchedule,
        actor: humanApiActor(),
      }),
      'D1',
      'A1',
    );
    expect(outcome).toEqual({ outcome: 'sent', sentMessageGuid: 'guid-1' });
    expect(backendCalls).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('applyDraftTransition:'))).toEqual(
      [],
    );
  });

  it('a contact flipped to deny binds BOTH approvers (a deny is not a clamp)', async () => {
    const denied: ContactPolicy = {
      handle: HANDLE,
      mode: 'deny',
      updatedAt: NOW,
    };
    for (const actor of [AUTO_ACTOR, humanApiActor()]) {
      const backendCalls: string[] = [];
      const outcome = await dispatchApproved(
        autoDeps({
          calls: [],
          auditEvents: [],
          backendCalls,
          // Rule-borne on purpose: the F-20 human pin means a rule-less
          // draft never consults the ladder at all, so a rule-less fixture
          // could not tell a working deny from a skipped one.
          rule: shutRule,
          schedule: { ...shutSchedule, windows: [] },
          contact: denied,
          actor,
        }),
        'D1',
        'A1',
      );
      expect(outcome).toMatchObject({
        outcome: 'failed',
        error: { message: 'gate denied: contact-denied' },
      });
      expect(backendCalls).toEqual([]);
    }
  });

  for (const [label, adapter] of [
    ['deregistered', null],
    ['disabled', { ...LIVE_ADAPTER, enabled: false }],
    ['token-revoked', { ...LIVE_ADAPTER, hasToken: false }],
  ] as const) {
    it(`an AUTO approval whose adapter was ${label} mid-grace fails adapter-disabled`, async () => {
      const backendCalls: string[] = [];
      const auditEvents: AuditEvent[] = [];
      const outcome = await dispatchApproved(
        autoDeps({ calls: [], auditEvents, backendCalls, adapter }),
        'D1',
        'A1',
      );
      expect(outcome).toMatchObject({
        outcome: 'failed',
        error: {
          code: 'gate-denied',
          message: 'gate denied: adapter-disabled',
        },
      });
      expect(backendCalls).toEqual([]);
      expect(auditEvents.map((e) => e.type)).toEqual([
        'draft.failed',
        'gate.denied',
      ]);
    });

    it(`a HUMAN approval is unaffected by a ${label} adapter`, async () => {
      // The asymmetry, stated once per revocation shape. Withdrawing an
      // agent's credential withdraws the agent's authority to act; it does
      // not reach back and undo a decision a person already made. A person
      // who wants that has the kill switch, which binds everyone.
      const backendCalls: string[] = [];
      const outcome = await dispatchApproved(
        autoDeps({
          calls: [],
          auditEvents: [],
          backendCalls,
          adapter,
          actor: humanApiActor(),
        }),
        'D1',
        'A1',
      );
      expect(outcome).toEqual({ outcome: 'sent', sentMessageGuid: 'guid-1' });
      expect(backendCalls).toHaveLength(1);
    });
  }
});

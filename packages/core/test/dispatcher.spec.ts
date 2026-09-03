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
  Approval,
  AuditEvent,
  ChatDbReader,
  Clock,
  Draft,
  DraftError,
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
    getRule: () => null,
    insertRule: () => undefined,
    updateRule: () => undefined,
    deleteRule: () => false,
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
    applyDraftTransition: () => {
      throw new Error('not used in this suite');
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
    getContactPolicy: () => null,
    setContactPolicy: () => undefined,
    deleteContactPolicy: () => false,
    listContactPolicies: () => [],
    getSettingVersion: () => -1,
    // s5 Scenario 3: adapter registry additions to the Store port.
    listAdapters: () => [],
    getAdapter: () => null,
    insertAdapter: () => undefined,
    updateAdapter: () => undefined,
    deleteAdapter: () => false,
    setAdapterTokenHash: () => undefined,
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
    expect(macroCalls).toEqual([
      'getDraft:D1',
      'getApproval:A1',
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
        draft: makeDraft({ id: 'D1', chatGuid: GROUP_GUID }),
        approval: makeApproval({ id: 'A1', draftId: 'D1', actor: AUTO_ACTOR }),
        // Global auto: the ONLY thing standing between this and a send is
        // the group clamp.
        settings: { ...ALLOW_SETTINGS, 'send.globalMode': 'auto' },
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
    const draft = makeDraft({ id: 'D1' });
    const backendCalls: string[] = [];
    const deps = baseDeps({
      store: makeStore({
        draft,
        approval: makeApproval({ id: 'A1', draftId: 'D1', actor: AUTO_ACTOR }),
        settings: { ...ALLOW_SETTINGS, 'send.globalMode': 'auto' },
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
        draft: makeDraft({ id: 'D1' }),
        approval: makeApproval({ id: 'A1', draftId: 'D1', actor: AUTO_ACTOR }),
        settings: ALLOW_SETTINGS,
        calls: [],
        auditEvents: [],
      }),
      backend: makeBackend({ result: { accepted: true }, calls: backendCalls }),
    });

    expect(await dispatchApproved(deps, 'D1', 'A1')).toEqual({
      outcome: 'failed',
      error: expect.objectContaining({ code: 'gate-denied' }),
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

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
      return { attempt: 1 };
    },
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
    expect(auditEvents.map((e) => e.type)).toEqual(['draft.failed']);
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

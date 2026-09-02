/**
 * Scenario 2 — Domain types are the plan's types, exactly.
 * Spec s1-execution Part 2 Scenario 2; plan §3.2 is the locked source for
 * packages/core/src/domain/types.ts (verbatim, character-for-character).
 *
 * This file runs twice: as a runtime spec (instantiation sanity) and under
 * vitest typecheck mode (tsc validates the @ts-expect-error probes — see
 * packages/core/vitest.config.ts). A probe that stops erroring, or a valid
 * instantiation that stops compiling, fails the suite.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Actor,
  AdapterTransport,
  Approval,
  AttachmentRef,
  ChatDbReader,
  Classifier,
  Clock,
  ContactMode,
  ContactPolicy,
  CursorState,
  Draft,
  DraftError,
  DraftState,
  FsWatcher,
  GateContext,
  GateDecision,
  GateDenyReason,
  Message,
  Rule,
  RuleMatcher,
  Schedule,
  ScheduleWindow,
  SendBackend,
  Service,
  Store,
  Ulid,
  Weekday,
} from '@wemessage/core';

const at: string = '2026-09-01T00:00:00.000Z';

describe('§3.2 domain types (verbatim contract)', () => {
  it('instantiates a valid Message (required fields + all optionals)', () => {
    const attachment: AttachmentRef = {
      path: '/tmp/a.heic',
      mimeType: 'image/heic',
      bytes: 1024,
      transferName: 'a.heic',
    };
    const msg: Message = {
      guid: 'ABC-123',
      sourceRowid: 42,
      chatGuid: 'iMessage;-;+15551234567',
      handle: '+15551234567',
      isFromMe: false,
      isGroup: false,
      service: 'imessage',
      kind: 'text',
      text: 'hello',
      attachments: [attachment],
      sentAt: at,
      receivedAt: at,
      editedAt: at,
      tapback: { targetGuid: 'DEF-456', type: 2000 },
      threadOriginatorGuid: 'DEF-456',
    };
    expect(msg.kind).toBe('text');

    // text is nullable, attachments may be empty
    const minimal: Message = {
      guid: 'g',
      sourceRowid: 1,
      chatGuid: 'c',
      handle: 'h',
      isFromMe: true,
      isGroup: true,
      service: 'sms',
      kind: 'attachment-only',
      text: null,
      attachments: [],
      sentAt: at,
      receivedAt: at,
    };
    expect(minimal.text).toBeNull();

    // @ts-expect-error — kind outside the §3.2 union
    const bad: Message = { ...minimal, kind: 'sticker' };
    expect(bad).toBeDefined();

    expectTypeOf<Service>().toEqualTypeOf<
      'imessage' | 'sms' | 'rcs' | 'unknown'
    >();
    // @ts-expect-error — service outside the union
    const badService: Service = 'mms';
    expect(badService).toBeDefined();
  });

  it('instantiates every RuleMatcher variant (recursive combinators included)', () => {
    const keyword: RuleMatcher = {
      kind: 'keyword',
      keywords: ['urgent'],
      mode: 'any',
      caseSensitive: false,
      wholeWord: true,
    };
    const regex: RuleMatcher = { kind: 'regex', pattern: 'a+b' };
    const theme: RuleMatcher = {
      kind: 'theme',
      themes: ['scheduling'],
      minConfidence: 0.8,
    };
    const contact: RuleMatcher = { kind: 'contact', handles: ['+15551234567'] };
    const allOf: RuleMatcher = { kind: 'all-of', matchers: [keyword, regex] };
    const anyOf: RuleMatcher = {
      kind: 'any-of',
      matchers: [theme, contact, allOf],
    };
    expect(
      [keyword, regex, theme, contact, allOf, anyOf].map((m) => m.kind),
    ).toEqual(['keyword', 'regex', 'theme', 'contact', 'all-of', 'any-of']);

    // @ts-expect-error — unknown matcher kind
    const bad: RuleMatcher = { kind: 'glob', pattern: '*' };
    expect(bad).toBeDefined();
  });

  it('instantiates Rule, Schedule, ScheduleWindow, ContactPolicy', () => {
    const window: ScheduleWindow = {
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '09:00',
      end: '17:00',
    };
    const schedule: Schedule = {
      id: 'sch1',
      name: 'work hours',
      timezone: 'America/Los_Angeles',
      windows: [window],
      enabled: true,
    };
    const rule: Rule = {
      id: 'r1',
      name: 'urgent keywords',
      enabled: true,
      matcher: { kind: 'keyword', keywords: ['urgent'], mode: 'any' },
      adapterId: 'echo',
      respondMode: 'draft-only',
      scheduleId: null,
      outsideWindow: 'draft-only',
      allowGroupDrafts: false,
      matchAttachmentOnly: false,
      draftTtlMinutes: 240,
      priority: 100,
      createdAt: at,
      updatedAt: at,
    };
    const policy: ContactPolicy = {
      handle: '+15551234567',
      displayName: 'Test User',
      mode: 'draft-only',
      updatedAt: at,
    };
    expect(rule.scheduleId).toBeNull();
    expect(schedule.windows).toHaveLength(1);
    expect(policy.mode).toBe('draft-only');

    // @ts-expect-error — weekday outside the union
    const badDay: Weekday = 'monday';
    expect(badDay).toBeDefined();
    // @ts-expect-error — contact mode outside the union
    const badMode: ContactMode = 'allow';
    expect(badMode).toBeDefined();
  });

  it('instantiates Draft / DraftError / Approval / Actor; DraftState union is exact', () => {
    const error: DraftError = {
      code: 'unverified',
      message: 'no matching is_from_me row',
      at,
    };
    const draft: Draft = {
      id: 'd1',
      inboundGuid: null,
      chatGuid: 'iMessage;-;+15551234567',
      ruleId: null,
      adapterId: 'echo',
      idempotencyKey: 'k1',
      body: 'edited',
      originalBody: 'original',
      proactiveReason: 'follow-up',
      state: 'failed',
      stateChangedAt: at,
      expiresAt: at,
      sendNotBefore: at,
      sentMessageGuid: 'G1',
      error,
      createdAt: at,
    };
    const humanActor: Actor = { kind: 'human', via: 'cli' };
    const agentActor: Actor = { kind: 'agent', adapterId: 'echo' };
    const systemActor: Actor = { kind: 'system', reason: 'kill-switch' };
    const approval: Approval = {
      id: 'a1',
      draftId: draft.id,
      action: 'approve',
      actor: humanActor,
      batchId: 'b1',
      editedBody: 'edited',
      at,
    };
    expect(draft.state).toBe('failed');
    expect([humanActor, agentActor, systemActor].map((a) => a.kind)).toEqual([
      'human',
      'agent',
      'system',
    ]);
    expect(approval.action).toBe('approve');

    expectTypeOf<DraftState>().toEqualTypeOf<
      | 'pending'
      | 'approved'
      | 'sending'
      | 'sent'
      | 'rejected'
      | 'expired'
      | 'superseded'
      | 'recalled'
      | 'failed'
    >();
    // @ts-expect-error — 'draft' is not a DraftState (spec Part 2 Scenario 2 probe)
    const badState: DraftState = 'draft';
    expect(badState).toBeDefined();
    // @ts-expect-error — error code outside the §3.2 union
    const badError: DraftError = { code: 'timeout', message: 'x', at };
    expect(badError).toBeDefined();
    // @ts-expect-error — system reason outside the union
    const badActor: Actor = { kind: 'system', reason: 'reboot' };
    expect(badActor).toBeDefined();
  });

  it('instantiates GateContext and both GateDecision arms', () => {
    const allow: GateDecision = { allow: true, mode: 'auto' };
    const deny: GateDecision = { allow: false, reason: 'outside-window' };
    const ctx: GateContext = {
      now: at,
      settings: {
        killSwitch: false,
        globalMode: 'draft-only',
        connectionState: 'fully-connected',
        allowSmsAuto: false,
      },
      rule: null,
      schedule: null,
      contact: null,
      message: {
        isGroup: false,
        service: 'imessage',
        handle: '+15551234567',
        chatGuid: 'iMessage;-;+15551234567',
      },
      counters: {
        contactAutoLastHour: 0,
        globalAutoLastHour: 0,
        consecutiveAutoInChat: 0,
        circuitOpen: false,
      },
    };
    expect(ctx.contact).toBeNull();
    expect(allow.allow).toBe(true);
    expect(deny.allow).toBe(false);

    // @ts-expect-error — GateDenyReason outside the union (spec Part 2 Scenario 2 probe)
    const badReason: GateDenyReason = 'because';
    expect(badReason).toBeDefined();
    // @ts-expect-error — allow:true arm carries mode, not reason
    const badDecision: GateDecision = { allow: true, reason: 'outside-window' };
    expect(badDecision).toBeDefined();
  });
});

describe('§1.5 port interfaces — all seven exported from core', () => {
  it('Clock / Store / ChatDbReader / FsWatcher / SendBackend / AdapterTransport / Classifier are implementable', async () => {
    const clock: Clock = { now: () => at, nowMs: () => 0 };
    const cursor: CursorState = { lastRowid: 10, lastScanAt: at };
    const store: Store = {
      getCursor: () => cursor,
      setCursor: () => undefined,
      getSetting: () => null,
      setSetting: () => undefined,
      hasInboundMessage: () => false,
      insertInboundMessage: () => undefined,
      countInboundMessagesSince: () => 0,
      listSendingDrafts: () => [],
      markDraftSent: () => undefined,
      markDraftFailed: () => undefined,
      // S2 additive body extensions (s2-execution §1.5): rules CRUD + mirror.
      listRules: () => [],
      getRule: () => null,
      insertRule: () => undefined,
      updateRule: () => undefined,
      deleteRule: () => false,
      listRecentInboundMessages: () => [],
      getInboundMessage: () => null,
      updateInboundMessage: () => undefined,
      close: () => undefined,
    };
    const reader: ChatDbReader = { readSince: () => Promise.resolve([]) };
    const watcher: FsWatcher = { watch: () => () => undefined };
    const backend: SendBackend = {
      isAvailable: () => Promise.resolve(false),
      send: () => Promise.resolve({ accepted: false }),
    };
    const transport: AdapterTransport = {
      send: () => Promise.resolve(),
      onFrame: () => undefined,
    };
    const classifier: Classifier = { classify: () => Promise.resolve([]) };

    expect(clock.now()).toBe(at);
    expect(store.getCursor()).toEqual({ lastRowid: 10, lastScanAt: at });
    await expect(reader.readSince(0)).resolves.toEqual([]);
    expect(
      watcher.watch(['chat.db', 'chat.db-wal'], () => undefined),
    ).toBeTypeOf('function');
    await expect(backend.isAvailable()).resolves.toBe(false);
    await expect(transport.send({})).resolves.toBeUndefined();
    await expect(classifier.classify('hi', ['t'])).resolves.toEqual([]);

    expectTypeOf<Ulid>().toEqualTypeOf<string>();
  });
});

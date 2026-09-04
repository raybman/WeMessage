/**
 * s6-execution Part 2 Scenario 9 ★ CHECKPOINT — the auto path: the ONE mint
 * site. Spec rows 3-11; §1.7 "Auto-approval (Sc 9)"; flags F-58 (C-1 widens
 * by exactly one disjunct), F-70 (the SMS clamp), F-74 (the mint allowlist
 * grows to two files and no further), F-78 (autonomy gets a REAL grace, with
 * a five-second floor, never zero).
 *
 * **What this scenario actually adds.** Everything needed to send a message
 * without a human has existed since S4: a draft, an `Approval` row, a
 * persisted `sendNotBefore`, a grace sweep, `dispatchApproved`, a send
 * ledger. The only missing piece was somebody willing to write the approval.
 * `maybeAutoApprove` is that somebody, and it is deliberately the ONLY one:
 * `test/arch.spec.ts` S6 rows (a) and (b) pin it by path, so a second file
 * that mints a system `auto-respond` actor or writes an approval beside one
 * fails the build rather than shipping a second autonomy.
 *
 * **INV-2 is not weakened, it is fed.** The auto path never calls
 * `dispatchApproved`, never names the send port, never holds a port at all.
 * It writes the same `Approval` row the human approve route writes, and then
 * stops. The scheduler that finds it, the dispatcher that runs it and the
 * mutex-held re-gate that can still refuse it are the S4 ones, byte for
 * byte, which is why row 5 below is titled "the send is the ordinary send"
 * and asserts the ledger and the backend spy rather than anything new.
 *
 * **Most of this suite is negatives, on purpose.** One row proves a machine
 * can speak. Every other row proves a machine still cannot speak through: a
 * shut schedule, a saturated cap, an open breaker, a loop, a group, a
 * non-iMessage service, a proposal with no rule, a kill switch thrown
 * mid-grace, a narrowed scope at any of the three levels, or a disconnected
 * Messages.app. A single positive is only as trustworthy as the fence around
 * it, so the negative table below covers all three `allow: false` denies and
 * all three scope narrowings as well as the six clamps §1.7 enumerates.
 *
 * **What is deferred, named.** A clamp is still not a denial (§1.7): nothing
 * here writes `gate.denied` for a withheld auto-approval, because there is
 * nobody to deny — no approval was minted, so no send was refused. Turning
 * the send-moment clamps into denials carrying the approval's own provenance
 * is Sc 10's work (F-59), and the re-gate `dispatchApproved` holds stays
 * context-blind until then. Rows below assert the honest inverse: zero
 * `Approval` rows, zero `auto.approved` rows, zero backend calls.
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type {
  Approval,
  AuditEvent,
  ChatGuid,
  Draft,
  GateDecision,
  Handle,
  Message,
  Rule,
  Schedule,
  Service,
  Ulid,
} from '@wemessage/core';
import {
  evaluateGate,
  maybeAutoApprove,
  parseChatGuid,
  readAutoGraceSeconds,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  AUTO_GRACE_FLOOR_SECONDS,
  SETTING_ALLOW_SMS_AUTO,
  SETTING_AUTO_GRACE_SECONDS,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_CONNECTION_STATE,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  SETTING_LOOP_CONSECUTIVE_AUTO_MAX,
  SETTING_UNDO_GRACE_SECONDS,
  RATE_SCOPE_GLOBAL,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditActors,
  auditEvents,
  boot,
  CHAT,
  HANDLE,
  post,
  T0,
  type Harness,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAuthed,
  waitUntil,
  type AgentHarness,
  type FakeAdapterSocket,
} from './helpers/agent-harness.js';

afterEach(cleanupAgentHarness);

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
const SCHEDULE_ID = `${'0'.repeat(24)}S1`;
/** The same conversation over a service that is not iMessage (F-70). */
const SMS_CHAT: ChatGuid = 'SMS;-;+15551234567';
/** A prefix `parseChatGuid` cannot name, which IS `service: 'unknown'`. */
const UNKNOWN_CHAT: ChatGuid = 'Signal;-;+15551234567';
/** No `;-;` separator is what makes a chat guid a GROUP (INV-5). */
const GROUP_CHAT: ChatGuid = 'iMessage;+;chat9990001112223334';
/** F-78's default: `send.autoGraceSeconds` inherits `send.undoGraceSeconds`. */
const GRACE_MS = 10_000;

const newUlid = monotonicFactory();

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    // All three scopes say auto, so any 'draft-only' below is a CLAMP and
    // never a narrow scope in the §2.4.3 ladder.
    respondMode: 'auto',
    scheduleId: SCHEDULE_ID,
    outsideWindow: 'draft-only',
    allowGroupDrafts: true,
    matchAttachmentOnly: false,
    draftTtlMinutes: 45,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** Always open. UTC is one of the five zones `test/arch.spec.ts` (f) pins. */
function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    name: 'business-hours',
    timezone: 'UTC',
    // Every day, so no test depends on which weekday T0 lands on, but a
    // window that genuinely CLOSES: a 00:00-23:59 window never closes, and
    // `windowCloseAfter` would answer `null` for it, which would quietly
    // turn row 4's `armedUntil` assertion into a test of nothing. T0 is
    // 12:00Z and the largest clock advance in this file is 20 seconds, so
    // every test in it runs inside the window.
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '09:00',
        end: '17:00',
      },
    ],
    enabled: true,
    ...over,
  };
}

interface ArmOptions {
  rule?: Partial<Rule>;
  schedule?: Partial<Schedule> | null;
}

/**
 * A booted daemon whose three scopes ALL say auto and whose schedule is
 * armed: the only starting line from which `maybeAutoApprove` can ever say
 * 'approved'. Every negative row below takes exactly one thing away from it,
 * which is what makes each negative attributable to the thing it removed.
 */
async function armed(opts: ArmOptions = {}): Promise<Harness> {
  const h = await boot();
  // `drafts.adapter_id` is a real foreign key (§2.3), so the adapter that
  // will own these drafts is registered through its own route rather than
  // conjured into the table.
  const res = await post(h, '/v1/adapters', {
    id: ADAPTER,
    kind: 'echo',
    displayName: ADAPTER,
  });
  expect(res.statusCode).toBe(201);
  // Schedules first: `rules.schedule_id` references them.
  if (opts.schedule !== null)
    h.store.insertSchedule(makeSchedule(opts.schedule));
  h.store.insertRule(makeRule(opts.rule ?? {}));
  h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
  h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
  return h;
}

/**
 * The default per-contact pacing cap is one auto send per two minutes
 * (F-66), so a suite that auto-sends twice would be measuring Sc 6 rather
 * than Sc 9. Raised by name at every call site, visible in review, never a
 * test-only bypass inside the production reader.
 */
function capsOutOfTheWay(h: Harness): void {
  h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
  h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '100');
  h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '100');
}

let seq = 0;

/** A synthetic inbound, mirrored so a draft can point at it. */
function inbound(h: Harness, over: Partial<Message> = {}): Message {
  seq += 1;
  const at = h.clockCtl.clock.now();
  const message: Message = {
    guid: `GUID-SC9-${String(seq)}`,
    sourceRowid: 9_000 + seq,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'tacos tonight?',
    attachments: [],
    sentAt: at,
    receivedAt: at,
    ...over,
  };
  h.store.insertInboundMessage(message);
  return message;
}

interface PendingOptions {
  body?: string;
  chatGuid?: ChatGuid;
  /** The service the INBOUND carried, which is the one F-70 judges. */
  service?: Service;
  isGroup?: boolean;
  ruleId?: string | null;
}

/**
 * A rule-borne `pending` draft, inserted exactly as `adapters/submit.ts`
 * inserts one, and pointed at a real mirrored inbound. Straight into the
 * store rather than over a socket, because every row here is about what the
 * DECISION does with a draft that already exists; the call site itself is
 * proven end to end in its own describe at the bottom of this file.
 */
function pending(h: Harness, opts: PendingOptions = {}): Draft {
  const chatGuid = opts.chatGuid ?? CHAT;
  const source = inbound(h, {
    chatGuid,
    ...(opts.service === undefined ? {} : { service: opts.service }),
    ...(opts.isGroup === undefined ? {} : { isGroup: opts.isGroup }),
  });
  seq += 1;
  const at = h.clockCtl.clock.now();
  const draft: Draft = {
    id: newUlid(Date.parse(at)),
    inboundGuid: source.guid,
    chatGuid,
    ruleId: opts.ruleId === undefined ? RULE_ID : opts.ruleId,
    adapterId: ADAPTER,
    idempotencyKey: `idem-sc9-${String(seq)}`,
    body: opts.body ?? 'on my way',
    originalBody: opts.body ?? 'on my way',
    state: 'pending',
    stateChangedAt: at,
    expiresAt: new Date(Date.parse(at) + 45 * 60_000).toISOString(),
    createdAt: at,
  };
  h.store.insertDraft(draft);
  return draft;
}

/** The production decision, with the daemon's own dependencies. */
function auto(h: Harness, draftId: Ulid): Promise<'approved' | 'withheld'> {
  return maybeAutoApprove(
    {
      store: h.store,
      clock: h.clockCtl.clock,
      sink: h.sink,
      // Core has zero package dependencies (INV-1) and so cannot mint a ULID
      // itself; the id generator is injected on the same precedent as
      // `DispatchApprovedDeps`' `delay` and `emit`.
      newId: () => newUlid(Date.parse(h.clockCtl.clock.now())) as Ulid,
    },
    draftId,
  );
}

function approvals(h: Harness, draftId: Ulid): Approval[] {
  return h.store.listApprovals(draftId);
}

function events(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

type AutoApprovedEvent = Extract<AuditEvent, { type: 'auto.approved' }>;

function autoRows(h: Harness): AutoApprovedEvent[] {
  return events(h, 'auto.approved') as AutoApprovedEvent[];
}

/**
 * The gate as `maybeAutoApprove` itself builds it, so a negative row can
 * name the cause it is testing rather than merely observe an outcome. The
 * handle and the service come from the mirrored INBOUND when the draft has
 * one (a group chat guid carries no counterparty handle at all, and `rcs`
 * is a service no chat-guid prefix can spell); `isGroup` comes from the chat
 * guid, because that is what the SEND path parses.
 */
function decisionFor(h: Harness, draft: Draft): GateDecision {
  const now = h.clockCtl.clock.now();
  const rule = draft.ruleId === null ? null : h.store.getRule(draft.ruleId);
  const scheduleId = rule?.scheduleId ?? null;
  const parsed = parseChatGuid(draft.chatGuid);
  const source =
    draft.inboundGuid === null || draft.inboundGuid === undefined
      ? null
      : h.store.getInboundMessage(draft.inboundGuid);
  const handle: Handle = source?.handle ?? parsed.handle;
  return evaluateGate({
    now,
    settings: readGateSettings(h.store),
    rule,
    schedule: scheduleId === null ? null : h.store.getSchedule(scheduleId),
    contact: h.store.getContactPolicy(handle),
    message: {
      isGroup: parsed.isGroup,
      service: source?.service ?? parsed.service,
      handle,
      chatGuid: draft.chatGuid,
    },
    counters: readGateCounters(h.store, {
      now,
      handle,
      chatGuid: draft.chatGuid,
    }),
    candidate: readLoopCandidate(h.store, {
      chatGuid: draft.chatGuid,
      body: draft.body,
    }),
  });
}

/** The whole autonomous round trip: decide, wait out the grace, send. */
async function autoSend(h: Harness, draft: Draft): Promise<void> {
  expect(await auto(h, draft.id)).toBe('approved');
  h.clockCtl.advance(GRACE_MS);
  await h.scheduler.tick();
  expect(h.store.getDraft(draft.id)?.state).toBe('sent');
}

// --- Row 3: the happy path -------------------------------------------------

describe('s6 Sc9 row 3: a fully-auto ladder mints exactly one approval', () => {
  it('approves under the system auto-respond actor and arms the grace', async () => {
    const h = await armed();
    const draft = pending(h);
    const at = h.clockCtl.clock.now();

    expect(decisionFor(h, draft)).toEqual({ allow: true, mode: 'auto' });
    expect(await auto(h, draft.id)).toBe('approved');

    // The draft moved through the ONE transition table, not around it.
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');
    // F-78: a real grace, not zero. The deadline is PERSISTED — no timer was
    // armed, which is what lets a restart mid-grace still send, and a kill
    // flip mid-grace still stop it.
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBe(
      new Date(Date.parse(at) + GRACE_MS).toISOString(),
    );

    // Exactly one approval, and it is the system one.
    const rows = approvals(h, draft.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('approve');
    expect(rows[0]?.actor).toEqual({ kind: 'system', reason: 'auto-respond' });
    expect(rows[0]?.at).toBe(at);
    // No human touched it: no edited body, no batch.
    expect(rows[0] === undefined ? true : 'editedBody' in rows[0]).toBe(false);
    expect(rows[0] === undefined ? true : 'batchId' in rows[0]).toBe(false);
  });

  it('appends auto.approved IMMEDIATELY followed by draft.approved', async () => {
    const h = await armed();
    const draft = pending(h);
    await auto(h, draft.id);

    const types = auditEvents(h.store).map((e) => e.type);
    const i = types.indexOf('auto.approved');
    expect(i).toBeGreaterThanOrEqual(0);
    // Adjacent, not merely both present: the reason a machine decided and
    // the decision it made are one event split across two rows, and anything
    // interleaved between them is a second writer nobody reviewed.
    expect(types[i + 1]).toBe('draft.approved');
    expect(types.filter((t) => t === 'auto.approved')).toHaveLength(1);
    expect(types.filter((t) => t === 'draft.approved')).toHaveLength(1);

    // Both rows are recorded under the auto actor, never under a human.
    expect(auditActors(h.store, 'auto.approved')).toEqual([
      { kind: 'system', reason: 'auto-respond' },
    ]);
    expect(auditActors(h.store, 'draft.approved')).toEqual([
      { kind: 'system', reason: 'auto-respond' },
    ]);
  });

  it('§1.8: both rows are durable before the broadcast leaves', async () => {
    const h = await armed();
    const draft = pending(h);
    await auto(h, draft.id);

    const frames = h.broadcasts.filter(
      (b) => (b.frame as { event?: string }).event === 'draft.approved',
    );
    expect(frames).toHaveLength(1);
    // The witness records the audit log AS IT STOOD when the frame went out.
    // Both rows already durable is the only ordering a crash cannot lose.
    expect(frames[0]?.auditAtBroadcast).toContain('auto.approved');
    expect(frames[0]?.auditAtBroadcast).toContain('draft.approved');
    expect(frames[0]?.frame).toEqual({
      event: 'draft.approved',
      draftId: draft.id,
      actor: { kind: 'system', reason: 'auto-respond' },
    });
  });
});

// --- Row 4: the decision is reconstructible --------------------------------

describe('s6 Sc9 row 4: auto.approved records why, not just that', () => {
  it('names all three resolved scopes, the rule, the adapter and the window', async () => {
    const h = await armed();
    const draft = pending(h);
    await auto(h, draft.id);

    const [row] = autoRows(h);
    expect(row).toMatchObject({
      type: 'auto.approved',
      draftId: draft.id,
      ruleId: RULE_ID,
      adapterId: ADAPTER,
      scopes: { global: 'auto', contact: 'auto', rule: 'auto' },
      scheduleId: SCHEDULE_ID,
    });
    // The approval it minted, by id: the audit row and the approvals table
    // point at each other, so neither can be read without the other.
    expect(row?.approvalId).toBe(approvals(h, draft.id)[0]?.id);
    // The window's close, so "was it really open" is answerable months later
    // from the log alone, without re-deriving a schedule that may since have
    // been edited or deleted.
    expect(row?.armedUntil).toBe('2026-09-01T17:00:00.000Z');
  });

  it('the scopes are the RESOLVED ones, not the rule copied three times', async () => {
    // Global auto, contact auto, rule auto is the only combination that
    // approves — so the only way to prove `scopes` is read rather than
    // assumed is a run where a NARROWER scope withholds and no row is
    // written at all, beside a run where all three genuinely are auto.
    const h = await armed({ rule: { respondMode: 'draft-only' } });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(autoRows(h)).toEqual([]);
  });

  it('armedUntil is OMITTED, not undefined, when the rule has no schedule', async () => {
    const h = await armed({ rule: { scheduleId: null }, schedule: null });
    const draft = pending(h);
    await auto(h, draft.id);

    const [row] = autoRows(h);
    expect(row?.scheduleId).toBeNull();
    // exactOptionalPropertyTypes: an absent optional is an absent KEY. The
    // JSON round trip through the audit log makes the difference permanent,
    // so asserting the key's absence is asserting what a reader will see.
    expect(row === undefined ? true : 'armedUntil' in row).toBe(false);
    expect(JSON.stringify(row)).not.toContain('armedUntil');
  });
});

// --- Row 5: the send is the ordinary send ----------------------------------

describe('s6 Sc9 row 5: an auto approval is sent by the S4 send path', () => {
  it('one dispatch, one backend call, one ledger row, under the auto actor', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');

    // Nothing has been sent yet: the grace is real and it has not elapsed.
    h.clockCtl.advance(GRACE_MS - 1);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');

    // The scheduler finds it by the SAME grace sweep that finds a human's,
    // and it carries the approval id `maybeAutoApprove` minted.
    h.clockCtl.advance(1);
    expect(h.store.listGraceElapsed(h.clockCtl.clock.now())).toEqual([
      { draftId: draft.id, approvalId: approvals(h, draft.id)[0]?.id },
    ]);

    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');

    // The `send_ledger` row is keyed by draft (§2.3 — it has no approval
    // column, and C-8 forbids adding one), so the link back to the approval
    // is the ACTOR every send row was written under: the auto approval's own.
    const ledger = h.store.db
      .prepare('SELECT draft_id, attempt, backend FROM send_ledger')
      .all() as Array<{ draft_id: string; attempt: number; backend: string }>;
    expect(ledger).toEqual([
      { draft_id: draft.id, attempt: 1, backend: 'loopback' },
    ]);
    expect(auditActors(h.store, 'draft.sent')).toEqual([
      { kind: 'system', reason: 'auto-respond' },
    ]);
    expect(auditActors(h.store, 'send.attempted')).toEqual([
      { kind: 'system', reason: 'auto-respond' },
    ]);
    // A clamp is not a denial, and a send that worked is not a refusal.
    expect(events(h, 'gate.denied')).toEqual([]);
  });

  it('a second and third tick send nothing again (the ledger is the guard)', async () => {
    const h = await armed();
    await autoSend(h, pending(h));
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
  });

  it('the auto path itself never reaches the backend', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    // INV-2: the ONLY path to a send backend is `dispatchApproved` with a
    // validated approval row. `maybeAutoApprove` writes the row and stops;
    // until the scheduler runs, nothing has been sent.
    expect(h.backend.callCount()).toBe(0);
    expect(events(h, 'send.attempted')).toEqual([]);
  });
});

// --- Row 6: withheld on every clamp, and on every narrowed scope -----------

interface Negative {
  what: string;
  clampedBy?: string;
  allow?: false;
  reason?: string;
  arm?: ArmOptions;
  draft?: PendingOptions;
  /** Applied after `armed()`, before the draft is minted. */
  break?: (h: Harness) => void | Promise<void>;
}

/**
 * Every route to a system approval that is NOT the one legal route, one row
 * each. Thinning this table is how a widened predicate ships unnoticed, so
 * it deliberately covers more than the six clamps §1.7 enumerates: the three
 * `allow: false` denies, the three scope narrowings in §2.4.3's ladder and
 * the five reachable `clampedBy` clamps are all here, because "withheld" has
 * to mean withheld for every one of them and not only for the ones a clamp
 * happens to name.
 */
const NEGATIVES: Negative[] = [
  {
    what: 'the kill switch is thrown',
    allow: false,
    reason: 'kill-switch',
    break: (h) => h.store.setSetting(SETTING_KILL_SWITCH, '1'),
  },
  {
    what: 'Messages.app is disconnected',
    allow: false,
    reason: 'disconnected',
    break: (h) => h.store.setSetting(SETTING_CONNECTION_STATE, 'disconnected'),
  },
  {
    what: 'the connection is read-only',
    allow: false,
    reason: 'read-only',
    break: (h) => h.store.setSetting(SETTING_CONNECTION_STATE, 'read-only'),
  },
  {
    what: 'the contact is denied',
    allow: false,
    reason: 'contact-denied',
    break: (h) =>
      h.store.setContactPolicy({ handle: HANDLE, mode: 'deny', updatedAt: T0 }),
  },
  {
    what: 'the contact has no policy at all (the deny-all default)',
    allow: false,
    reason: 'contact-denied',
    break: (h) => {
      h.store.deleteContactPolicy(HANDLE);
    },
  },
  {
    what: 'the GLOBAL scope says draft-only',
    break: (h) => h.store.setSetting(SETTING_GLOBAL_MODE, 'draft-only'),
  },
  {
    what: 'the CONTACT scope says draft-only',
    break: (h) =>
      h.store.setContactPolicy({
        handle: HANDLE,
        mode: 'draft-only',
        updatedAt: T0,
      }),
  },
  {
    what: 'the RULE scope says draft-only',
    arm: { rule: { respondMode: 'draft-only' } },
  },
  {
    what: "the rule's schedule is shut",
    clampedBy: 'outside-window',
    arm: { schedule: { windows: [] } },
  },
  {
    what: "the rule's schedule has been disabled",
    clampedBy: 'outside-window',
    arm: { schedule: { enabled: false } },
  },
  {
    what: 'a rate cap is saturated',
    clampedBy: 'rate-limited',
    break: (h) => {
      h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '1');
      h.store.bumpRateCounter(RATE_SCOPE_GLOBAL, T0);
    },
  },
  {
    what: 'the circuit breaker is open',
    clampedBy: 'circuit-open',
    break: (h) =>
      h.store.setSetting(SETTING_CIRCUIT_OPENED_AT, h.clockCtl.clock.now()),
  },
  {
    what: 'the chat is in a machine-turn loop',
    clampedBy: 'loop-detected',
    break: async (h) => {
      capsOutOfTheWay(h);
      await autoSend(h, pending(h, { body: 'an earlier reply' }));
      // One machine turn behind us is a streak of one, which is a loop the
      // moment the operator says a streak of one is.
      h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, '1');
    },
  },
  {
    what: 'the body repeats what we just said in this chat',
    clampedBy: 'loop-detected',
    draft: { body: 'an earlier reply' },
    break: async (h) => {
      capsOutOfTheWay(h);
      h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, '100');
      await autoSend(h, pending(h, { body: 'an earlier reply' }));
    },
  },
  {
    what: 'the service is SMS and SMS autonomy is off (F-70)',
    clampedBy: 'sms-auto-forbidden',
    draft: { chatGuid: SMS_CHAT, service: 'sms' },
  },
  {
    what: 'the service is RCS and SMS autonomy is off (F-70)',
    clampedBy: 'sms-auto-forbidden',
    draft: { chatGuid: SMS_CHAT, service: 'rcs' },
  },
  {
    what: 'the service is unrecognised and SMS autonomy is off (F-70)',
    clampedBy: 'sms-auto-forbidden',
    draft: { chatGuid: UNKNOWN_CHAT, service: 'unknown' },
  },
  {
    what: 'the draft is a group draft (INV-5)',
    draft: { chatGuid: GROUP_CHAT, isGroup: true },
  },
  {
    what: 'the draft carries no rule at all (a proactive proposal)',
    draft: { ruleId: null },
  },
];

describe('s6 Sc9 row 6: nothing is minted when anything withholds', () => {
  for (const neg of NEGATIVES) {
    it(`withholds when ${neg.what}`, async () => {
      const h = await armed(neg.arm ?? {});
      await neg.break?.(h);
      const draft = pending(h, neg.draft ?? {});

      // The gate agrees with the row's stated cause, so a row that passes
      // for the wrong reason is visible rather than merely green.
      const decision = decisionFor(h, draft);
      if (neg.allow === false) {
        expect(decision).toEqual({ allow: false, reason: neg.reason });
      } else if (neg.clampedBy !== undefined) {
        expect(decision).toEqual({
          allow: true,
          mode: 'draft-only',
          clampedBy: neg.clampedBy,
        });
      } else if (neg.draft?.ruleId !== null) {
        expect(decision).toEqual({ allow: true, mode: 'draft-only' });
      }

      const backendBefore = h.backend.callCount();
      const autoBefore = autoRows(h).length;
      expect(await auto(h, draft.id)).toBe('withheld');

      // Nothing was written, nothing was sent, and the draft is still a
      // proposal a human can act on.
      expect(h.store.getDraft(draft.id)?.state).toBe('pending');
      expect(h.store.getDraft(draft.id)?.sendNotBefore).toBeUndefined();
      expect(approvals(h, draft.id)).toEqual([]);
      expect(autoRows(h)).toHaveLength(autoBefore);

      // And a tick cannot find it, because the grace sweep selects on
      // 'approved' and nobody approved anything.
      h.clockCtl.advance(GRACE_MS * 2);
      await h.scheduler.tick();
      expect(h.store.getDraft(draft.id)?.state).not.toBe('sent');
      expect(h.backend.callCount()).toBe(backendBefore);
    });
  }

  it('a withheld decision writes NO gate.denied row (a clamp is not a denial)', async () => {
    const h = await armed();
    h.store.setSetting(SETTING_GLOBAL_MODE, 'draft-only');
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('withheld');
    // §1.7, and Sc 7 and Sc 8 recorded the same deferral: turning a clamp
    // into a send-moment refusal is Sc 10's job (F-59). Nobody was refused
    // here — no approval existed to refuse.
    expect(events(h, 'gate.denied')).toEqual([]);
    // And nothing was broadcast either: a withheld draft is not an event.
    expect(h.broadcasts).toEqual([]);
  });

  it('a draft that is no longer pending is never approved twice', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    // Idempotent by refusal rather than by luck: the second call finds a
    // draft that is no longer 'pending' and declines, rather than minting a
    // second approval for the same send.
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(approvals(h, draft.id)).toHaveLength(1);
    expect(autoRows(h)).toHaveLength(1);
  });

  it('an unknown draft id is withheld, not thrown', async () => {
    const h = await armed();
    expect(await auto(h, `${'0'.repeat(24)}ZZ`)).toBe('withheld');
  });

  it('a rule pointing at a schedule that failed to load is NOT armed', async () => {
    // `schedules.id` is a real foreign key, so a rule can never reference a
    // row that is gone — which is exactly why this branch has to be pinned
    // on the pure function instead. It is the fail-closed half of §3.2: a
    // schedule that could not be read withdraws autonomy rather than
    // granting it, and a caller that forgets to load one gets a clamp.
    const h = await armed();
    expect(
      evaluateGate({
        now: h.clockCtl.clock.now(),
        settings: readGateSettings(h.store),
        rule: makeRule(),
        schedule: null,
        contact: h.store.getContactPolicy(HANDLE),
        message: {
          isGroup: false,
          service: 'imessage',
          handle: HANDLE,
          chatGuid: CHAT,
        },
        counters: readGateCounters(h.store, {
          now: h.clockCtl.clock.now(),
          handle: HANDLE,
          chatGuid: CHAT,
        }),
      }),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
  });
});

// --- Row 7: F-78, the grace floor ------------------------------------------

describe('s6 Sc9 row 7: autonomy gets a real grace, floored at 5s (F-78)', () => {
  it('defaults to the undo grace and can never reach zero', async () => {
    const h = await armed();
    // Unset: inherits `send.undoGraceSeconds`, whose own default is 10.
    expect(readAutoGraceSeconds(h.store)).toBe(10);
    expect(AUTO_GRACE_FLOOR_SECONDS).toBe(5);

    // The operator's undo grace is the default, so raising it raises both.
    h.store.setSetting(SETTING_UNDO_GRACE_SECONDS, '30');
    expect(readAutoGraceSeconds(h.store)).toBe(30);

    // F-78 refused a zero: an autonomous send a human cannot catch is not a
    // grace, it is a fait accompli. Every value below the floor IS the floor,
    // and so is every value that is not a number at all.
    for (const raw of ['0', '1', '4', '-7', 'nonsense', '', '4.9']) {
      h.store.setSetting(SETTING_AUTO_GRACE_SECONDS, raw);
      expect(readAutoGraceSeconds(h.store), raw).toBe(5);
    }
    h.store.setSetting(SETTING_AUTO_GRACE_SECONDS, '45');
    expect(readAutoGraceSeconds(h.store)).toBe(45);
  });

  it('a configured grace of 0 still holds the send for five seconds', async () => {
    const h = await armed();
    h.store.setSetting(SETTING_AUTO_GRACE_SECONDS, '0');
    const draft = pending(h);
    const at = h.clockCtl.clock.now();
    expect(await auto(h, draft.id)).toBe('approved');
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBe(
      new Date(Date.parse(at) + 5_000).toISOString(),
    );

    // Four seconds in: not due, not sent, still catchable.
    h.clockCtl.advance(4_000);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');

    // Five: due.
    h.clockCtl.advance(1_000);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
  });

  it('the auto grace is its own key: raising it does not move the undo grace', async () => {
    const h = await armed();
    h.store.setSetting(SETTING_AUTO_GRACE_SECONDS, '60');
    const draft = pending(h);
    const at = h.clockCtl.clock.now();
    expect(await auto(h, draft.id)).toBe('approved');
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBe(
      new Date(Date.parse(at) + 60_000).toISOString(),
    );
    // A human's approve still gets the undo grace, untouched.
    const human = pending(h, { body: 'human reply' });
    const res = await post(h, `/v1/drafts/${human.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(h.store.getDraft(human.id)?.sendNotBefore).toBe(
      new Date(Date.parse(h.clockCtl.clock.now()) + GRACE_MS).toISOString(),
    );
  });
});

// --- Row 8: the kill switch dominates the grace ----------------------------

describe('s6 Sc9 row 8: a kill flip inside the auto grace stops the send', () => {
  it('the draft dies, one way or the other, and never reaches the backend', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');

    // Mid-grace. This is the interval F-78 refused to let reach zero, and
    // this row is what the interval is FOR.
    h.clockCtl.advance(GRACE_MS / 2);
    const res = await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(res.statusCode).toBe(200);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    const final = h.store.getDraft(draft.id);
    const denials = events(h, 'gate.denied') as Array<
      Extract<AuditEvent, { type: 'gate.denied' }>
    >;
    // Two legitimate mechanisms, asserted as the disjunction they are: the
    // toggle route cancels every draft still inside its grace, and anything
    // that slips past it dies at the mutex-held re-gate instead. Which one
    // wins is a question about WHERE it is stopped, never about WHETHER.
    const cancelled =
      final?.state === 'rejected' &&
      auditActors(h.store, 'draft.rejected').some(
        (a) =>
          JSON.stringify(a) ===
          JSON.stringify({ kind: 'system', reason: 'kill-switch' }),
      );
    const reGated =
      final?.state === 'failed' &&
      denials.some((d) => d.reason === 'kill-switch' && d.draftId === draft.id);
    expect(cancelled || reGated).toBe(true);

    // The only assertion that matters either way.
    expect(h.backend.callCount()).toBe(0);
  });

  it('the switch cannot be beaten by re-running the auto decision', async () => {
    const h = await armed();
    h.store.setSetting(SETTING_KILL_SWITCH, '1');
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(approvals(h, draft.id)).toEqual([]);
  });
});

// --- Row 9: INV-5, groups are never auto -----------------------------------

describe('s6 Sc9 row 9: a group is never auto, and the auto path knows nothing about groups', () => {
  it('withholds a fully-auto group draft on the gate clamp alone', async () => {
    const h = await armed();
    const draft = pending(h, { chatGuid: GROUP_CHAT, isGroup: true });

    // The rule ALLOWS group drafts, the contact says auto and so does the
    // global mode: the only thing standing between this draft and a send is
    // INV-5's clamp inside `evaluateGate`.
    expect(h.store.getRule(RULE_ID)?.allowGroupDrafts).toBe(true);
    expect(h.store.getContactPolicy(HANDLE)?.mode).toBe('auto');
    expect(decisionFor(h, draft)).toEqual({ allow: true, mode: 'draft-only' });

    expect(await auto(h, draft.id)).toBe('withheld');
    expect(approvals(h, draft.id)).toEqual([]);
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.backend.callCount()).toBe(0);
  });

  it('the auto path adds no group logic of its own', () => {
    // The clamp lives in `evaluateGate` and nowhere else. If the auto path
    // grew its own group branch there would be two places deciding what a
    // group is, and the one that is easier to forget is the new one.
    const src = readFileSync(
      new URL('../../core/src/sending/auto-approve.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/isGroup\s*(\?|&&|\|\||===|!==)/);
  });
});

// --- Row 10: F-70, the SMS clamp -------------------------------------------

describe('s6 Sc9 row 10: SMS autonomy is off until an operator says otherwise (F-70)', () => {
  it('approves an SMS draft only once `send.allowSmsAuto` is on', async () => {
    const h = await armed();
    const first = pending(h, { chatGuid: SMS_CHAT, service: 'sms' });
    expect(decisionFor(h, first)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'sms-auto-forbidden',
    });
    expect(await auto(h, first.id)).toBe('withheld');

    // The operator turns it on. Nothing else changes.
    h.store.setSetting(SETTING_ALLOW_SMS_AUTO, '1');
    capsOutOfTheWay(h);
    const second = pending(h, { chatGuid: SMS_CHAT, service: 'sms' });
    expect(decisionFor(h, second)).toEqual({ allow: true, mode: 'auto' });
    expect(await auto(h, second.id)).toBe('approved');
    expect(approvals(h, second.id)).toHaveLength(1);
  });

  it("'rcs' and 'unknown' are treated exactly as 'sms', and iMessage is not", async () => {
    const h = await armed();
    const base = {
      now: h.clockCtl.clock.now(),
      settings: readGateSettings(h.store),
      rule: makeRule({ scheduleId: null }),
      schedule: null,
      contact: h.store.getContactPolicy(HANDLE),
      counters: readGateCounters(h.store, {
        now: h.clockCtl.clock.now(),
        handle: HANDLE,
        chatGuid: CHAT,
      }),
    };
    for (const service of ['sms', 'rcs', 'unknown'] as const) {
      expect(
        evaluateGate({
          ...base,
          message: { isGroup: false, service, handle: HANDLE, chatGuid: CHAT },
        }),
        service,
      ).toEqual({
        allow: true,
        mode: 'draft-only',
        clampedBy: 'sms-auto-forbidden',
      });
    }
    expect(
      evaluateGate({
        ...base,
        message: {
          isGroup: false,
          service: 'imessage',
          handle: HANDLE,
          chatGuid: CHAT,
        },
      }),
    ).toEqual({ allow: true, mode: 'auto' });
  });

  it('the SMS clamp is LAST in the §1.7 chain: an earlier cause still wins', async () => {
    const h = await armed({ schedule: { windows: [] } });
    const draft = pending(h, { chatGuid: SMS_CHAT, service: 'sms' });
    // Both a shut window and a forbidden service apply. `clampedBy` is one
    // field on one else-if chain, and §1.7 fixes which cause is reported.
    expect(decisionFor(h, draft)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
    expect(await auto(h, draft.id)).toBe('withheld');
  });

  it('the clamp does not touch the human send path', async () => {
    const h = await armed();
    h.store.setSetting(SETTING_GLOBAL_MODE, 'draft-only');
    const draft = pending(h, { chatGuid: SMS_CHAT, service: 'sms' });
    // A human approving an SMS draft is not autonomy and F-70 says nothing
    // about it: the setting governs whether a MACHINE may choose to speak.
    const res = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');
  });
});

// --- Row 11: one mint site -------------------------------------------------

describe('s6 Sc9 row 11: exactly one system approval per autonomous send', () => {
  it('three autonomous sends leave three approvals, one each', async () => {
    const h = await armed();
    capsOutOfTheWay(h);
    // A streak of three would clamp on the shipped loop default, and this
    // row is about counting approvals, not about Sc 8.
    h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, '100');

    const drafts: Draft[] = [];
    for (let i = 0; i < 3; i += 1) {
      const draft = pending(h, { body: `reply ${String(i)}` });
      await autoSend(h, draft);
      drafts.push(draft);
    }

    const rows = autoRows(h);
    expect(rows).toHaveLength(3);
    const auditRows = h.store
      .readAuditRows(0, 2000)
      .filter(
        (r) =>
          (JSON.parse(r.eventJson) as { type: string }).type ===
          'auto.approved',
      );
    for (const draft of drafts) {
      const mine = approvals(h, draft.id);
      expect(mine, draft.id).toHaveLength(1);
      expect(mine[0]?.actor).toEqual({
        kind: 'system',
        reason: 'auto-respond',
      });
      const row = rows.find((r) => r.draftId === draft.id);
      expect(row?.approvalId).toBe(mine[0]?.id);
      // The audit row and the approvals table agree about WHEN, to the
      // millisecond: one decision recorded twice, never two decisions.
      const audited = auditRows.find(
        (r) =>
          (JSON.parse(r.eventJson) as { draftId?: string }).draftId ===
          draft.id,
      );
      expect(audited?.at).toBe(mine[0]?.at);
    }

    // And nobody else wrote one: every approval in the database belongs to
    // one of these three sends.
    expect(drafts.flatMap((d) => approvals(h, d.id))).toHaveLength(3);
    expect(h.backend.callCount()).toBe(3);
    expect(events(h, 'draft.sent')).toHaveLength(3);
  });

  it('a human approval and an auto approval never both exist for one draft', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    // The route refuses: the draft is no longer pending, so C-1's table
    // rejects the human's approve edge exactly as it rejects a second auto.
    const res = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(approvals(h, draft.id)).toHaveLength(1);
  });
});

// --- The one call site -----------------------------------------------------

describe('s6 Sc9: the ONE call site is `adapters/submit.ts`', () => {
  it('a rule-borne draft.submit auto-approves with nobody calling the decision by hand', async () => {
    const h: AgentHarness = await bootAgent();
    const cred = await addAdapter(h, ADAPTER);
    const sock: FakeAdapterSocket = await connectAuthed(h, cred);
    h.store.insertSchedule(makeSchedule());
    h.store.insertRule(makeRule());
    h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');

    // The daemon's own `deliver`, composed exactly as `daemon.ts` composes it.
    const dispatch = createInboundDispatch({
      store: h.store,
      clock: h.clockCtl.clock,
      sink: h.sink,
      reader: h.reader,
      transport: {
        isConnected: (id) => h.server.agentTransport?.isConnected(id) ?? false,
        sendTo: (id, frame) =>
          h.server.agentTransport?.sendTo(id, frame) ?? false,
      },
      issueRequest: (req) => h.server.agentRequests?.issue(req),
    });
    const message = inbound(h);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());

    interface RequestFrame {
      type: string;
      payload: { rule: { respondMode: string }; correlation: unknown };
    }
    const requests = (): RequestFrame[] =>
      (sock.frames as RequestFrame[]).filter((f) => f.type === 'draft.request');
    await waitUntil(() => requests().length > 0, 'draft.request');
    const frame = requests()[0] as RequestFrame;
    // The gate resolved 'auto' on the way out, which is the precondition the
    // auto path re-checks for itself on the way back in.
    expect(frame.payload.rule.respondMode).toBe('auto');

    sock.sendFrame('draft.submit', {
      correlation: frame.payload.correlation,
      idempotencyKey: 'idem-callsite',
      body: 'see you at seven',
    });
    await waitUntil(
      () => h.store.listDrafts().length === 1,
      'draft minted by the real submit path',
    );
    const draft = h.store.listDrafts()[0] as Draft;

    // The decision ran INSIDE the mint, in the same turn the draft was
    // created: by the time anyone can observe the row it is already approved
    // and its grace is already armed. No test called `maybeAutoApprove`.
    await waitUntil(
      () => h.store.getDraft(draft.id)?.state === 'approved',
      'auto-approved by the call site',
    );
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);
    expect(h.store.listApprovals(draft.id)[0]?.actor).toEqual({
      kind: 'system',
      reason: 'auto-respond',
    });
    const types = auditEvents(h.store).map((e) => e.type);
    expect(types.indexOf('draft.created')).toBeLessThan(
      types.indexOf('auto.approved'),
    );

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
  });
});

/**
 * s6-execution Part 2 Scenario 10 ★ CHECKPOINT — outside-window behaviours
 * and the context-bearing re-gate. Spec rows 1-9; §1.7 "Send-moment re-gate,
 * now context-bearing"; flags F-59 (the re-gate stops being blind), F-72 (a
 * closing window REQUEUES rather than fails), F-20 (the human pin survives
 * it), F-69 (`outsideWindow: 'queue'` is refused at the edge and degrades to
 * 'draft-only' if a row ever carries it anyway).
 *
 * **What this scenario actually adds.** Since S3 the send-moment re-gate has
 * been evaluated with `rule: null, schedule: null, contact: null` and five
 * zeroed counters. That was honest at the time — nothing downstream read a
 * clamp — but it made four of the six §1.7 clamps structurally unreachable at
 * the send moment: a draft could be authorised at 09:59 and still go out at
 * 14:00 through a schedule that had shut four hours earlier, because the only
 * thing the re-gate could still see was the kill switch. Sc 10 hands the
 * re-gate the same context the draft moment builds, and then decides what a
 * clamp MEANS to an approval that already exists.
 *
 * **Denies bind everyone; clamps bind only autonomy.** That is the whole
 * shape of this commit and it is not a new rule — §2.4.1 has said "steps 1-2
 * deny at both gate moments; the clamps are what the two moments read
 * differently" since S3. So a contact flipped to `deny` mid-grace kills the
 * send whoever approved it (row 1), while a saturated cap, an open breaker or
 * a loop still cannot veto a person (Sc 6 row 7 and Sc 8 row 7 stay green,
 * unedited). The one clamp that stops an AUTO approval and does not fail it
 * is the window: the draft goes back to `pending` and a human decides.
 *
 * **Rate counters are read as zero at the send moment, deliberately** (F-71,
 * and the one place this suite departs from the plan's literal "live
 * counters"). `bumpSendCounters` runs at APPROVAL, not at send, so an auto
 * approval has already spent its own budget by the time the grace elapses:
 * with the shipped `contactPer2Min: 1`, a live read would find
 * `contactAutoLast2Min === 1 >= 1` and refuse every autonomous send that the
 * cap had just authorised — and, because step 7 is an else-if chain, it would
 * mask the circuit, loop and SMS clamps behind a `rate-limited` that is an
 * artefact of our own bookkeeping. The cap governs how often the machine
 * DECIDES to speak. Row 6's auto draft sends nothing only because its adapter
 * was revoked, and rows 2-4 requeue only because the window shut; if the rate
 * fields were live, every one of those rows would pass for the wrong reason,
 * which is why this is stated here rather than buried in a comment.
 *
 * **A requeue is not a failure, and the type says so.** `DispatchOutcome`
 * grows a third variant, `{outcome: 'requeued', reason}`. Returning 'failed'
 * would contradict F-72 in the one place a machine reads it: the daemon's
 * `observeDispatch` turns a 'failed' outcome into a `send_failed` feedback
 * frame, and telling an agent its draft failed when the draft is sitting in
 * the queue awaiting a human is a lie with a retry loop attached.
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type {
  AuditEvent,
  ChatGuid,
  Draft,
  GateDecision,
  Handle,
  Message,
  Rule,
  Schedule,
  Ulid,
} from '@wemessage/core';
import {
  evaluateGate,
  maybeAutoApprove,
  parseChatGuid,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_GLOBAL_MODE,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditActors,
  auditEvents,
  auditTypes,
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
/** F-78's default: `send.autoGraceSeconds` inherits `send.undoGraceSeconds`. */
const GRACE_MS = 10_000;
/**
 * Comfortably inside the morning window: an eleven-hour clock advance would
 * still not reach its close, so nothing here can requeue by accident.
 */
const T_INSIDE = '2026-09-01T09:30:00.000Z';
/**
 * One second before the morning window shuts. An auto-approval taken HERE
 * arms its grace at 10:00:09, which is F-72's whole scenario in two numbers.
 */
const T_EDGE = '2026-09-01T09:59:59.000Z';
/** Between the two windows: armed for nothing, which is not the same as disabled. */
const T_SHUT = '2026-09-01T10:30:00.000Z';
/** Inside the SECOND window, so a re-open is a real event and not a fiction. */
const T_NEXT = '2026-09-01T11:30:00.000Z';
/**
 * Eight hours, so the requeue rows prove the requeue rather than the TTL. §1.7 is
 * explicit that a requeued draft keeps its original `expiresAt` and may well
 * expire before its window reopens; that is a different row's fact, and a
 * 45-minute default would silently make rows 3 and 4 assert it instead.
 */
const TTL_MINUTES = 480;

const newUlid = monotonicFactory();

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    // All three scopes say auto, so every 'draft-only' below is a CLAMP and
    // never a narrow scope in the §2.4.3 ladder.
    respondMode: 'auto',
    scheduleId: SCHEDULE_ID,
    outsideWindow: 'draft-only',
    allowGroupDrafts: true,
    matchAttachmentOnly: false,
    draftTtlMinutes: TTL_MINUTES,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/**
 * TWO windows on the same day, 09:00-10:00 and 11:00-12:00, UTC (one of the
 * five zones `test/arch.spec.ts` (f) pins). One window could only ever prove
 * "it shut"; two prove the stronger thing rows 3 and 4 are about — that a
 * requeued draft is still not auto-approved when the schedule genuinely comes
 * back, and that a human can act on it there. Every day of the week, so no
 * row depends on which weekday 2026-09-01 lands on.
 */
function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    name: 'business-hours',
    timezone: 'UTC',
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '09:00',
        end: '10:00',
      },
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '11:00',
        end: '12:00',
      },
    ],
    enabled: true,
    ...over,
  };
}

interface ArmOptions {
  startIso?: string;
  rule?: Partial<Rule>;
  schedule?: Partial<Schedule>;
  /** The contact ladder's middle rung. 'auto' unless a row is about narrowing it. */
  contact?: 'auto' | 'draft-only' | 'deny';
}

/**
 * A booted daemon whose three scopes all say auto and whose rule points at
 * the two-window schedule. Every row below changes exactly one thing about
 * it — the clock, the contact policy, the adapter's token, the rule's
 * `outsideWindow` — which is what makes each outcome attributable.
 */
async function armed(opts: ArmOptions = {}): Promise<Harness> {
  const h = await boot({ startIso: opts.startIso ?? T_INSIDE });
  const res = await post(h, '/v1/adapters', {
    id: ADAPTER,
    kind: 'echo',
    displayName: ADAPTER,
  });
  expect(res.statusCode).toBe(201);
  h.store.insertSchedule(makeSchedule(opts.schedule));
  h.store.insertRule(makeRule(opts.rule ?? {}));
  h.store.setContactPolicy({
    handle: HANDLE,
    mode: opts.contact ?? 'auto',
    updatedAt: T0,
  });
  h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
  return h;
}

/**
 * The default per-contact pacing cap is one auto send per two minutes (F-66),
 * so a row that approves twice inside two fake-clock minutes would be
 * measuring Sc 6. Raised by name at the call sites that need it, visible in
 * review, never a test-only bypass inside a production reader.
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
    guid: `GUID-SC10-${String(seq)}`,
    sourceRowid: 10_000 + seq,
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
  ruleId?: string | null;
  ttlMinutes?: number;
}

/**
 * A rule-borne `pending` draft, inserted exactly as `adapters/submit.ts`
 * inserts one and pointed at a real mirrored inbound. Straight into the store
 * rather than over a socket, because every row here is about what the SEND
 * MOMENT does with a draft that already exists; the composed path is proven
 * end to end in row 7's describe.
 */
function pending(h: Harness, opts: PendingOptions = {}): Draft {
  const chatGuid = opts.chatGuid ?? CHAT;
  const source = inbound(h, { chatGuid });
  seq += 1;
  const at = h.clockCtl.clock.now();
  const draft: Draft = {
    id: newUlid(Date.parse(at)),
    inboundGuid: source.guid,
    chatGuid,
    ruleId: opts.ruleId === undefined ? RULE_ID : opts.ruleId,
    adapterId: ADAPTER,
    idempotencyKey: `idem-sc10-${String(seq)}`,
    body: opts.body ?? 'on my way',
    originalBody: opts.body ?? 'on my way',
    state: 'pending',
    stateChangedAt: at,
    expiresAt: new Date(
      Date.parse(at) + (opts.ttlMinutes ?? TTL_MINUTES) * 60_000,
    ).toISOString(),
    createdAt: at,
  };
  h.store.insertDraft(draft);
  return draft;
}

/** The production auto decision, with the daemon's own dependencies. */
function auto(h: Harness, draftId: Ulid): Promise<'approved' | 'withheld'> {
  return maybeAutoApprove(
    {
      store: h.store,
      clock: h.clockCtl.clock,
      sink: h.sink,
      newId: () => newUlid(Date.parse(h.clockCtl.clock.now())) as Ulid,
    },
    draftId,
  );
}

/** The gate at the context the DRAFT moment builds, for rows that name a cause. */
function decisionFor(h: Harness, draft: Draft): GateDecision {
  const now = h.clockCtl.clock.now();
  const rule = draft.ruleId === null ? null : h.store.getRule(draft.ruleId);
  const scheduleId = rule?.scheduleId ?? null;
  const parsed = parseChatGuid(draft.chatGuid);
  const handle: Handle = parsed.handle;
  return evaluateGate({
    now,
    settings: readGateSettings(h.store),
    rule,
    schedule: scheduleId === null ? null : h.store.getSchedule(scheduleId),
    contact: h.store.getContactPolicy(handle),
    message: {
      isGroup: parsed.isGroup,
      service: parsed.service,
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

function events(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

type Denial = Extract<AuditEvent, { type: 'gate.denied' }>;

function denials(h: Harness, draftId?: Ulid): Denial[] {
  return (events(h, 'gate.denied') as Denial[]).filter(
    (e) => draftId === undefined || e.draftId === draftId,
  );
}

/**
 * F-72's whole sequence in one helper: auto-approved one second before the
 * window shuts, grace elapsing nine seconds after it did.
 */
async function requeue(h: Harness): Promise<Draft> {
  const draft = pending(h);
  expect(await auto(h, draft.id)).toBe('approved');
  h.clockCtl.advance(GRACE_MS);
  await h.scheduler.tick();
  return draft;
}

// --- Row 1: the re-gate sees the world -------------------------------------

describe('s6 Sc10 row 1: the send-moment re-gate sees the world (F-59)', () => {
  it('a contact flipped to deny mid-grace fails the send with contact-denied', async () => {
    // The contact starts at 'draft-only', so autonomy withholds and the
    // approval below is a HUMAN's. That is the point: a contact deny is a
    // DENY and not a clamp, so it binds the send whoever authorised it.
    const h = await armed({ contact: 'draft-only' });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('withheld');

    const approve = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');

    // Revocation lands INSIDE the grace, which is the only interval in which
    // a re-gate can be the thing that catches it.
    h.store.setContactPolicy({
      handle: HANDLE,
      mode: 'deny',
      updatedAt: h.clockCtl.clock.now(),
    });
    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(h.backend.callCount()).toBe(0);
    expect(denials(h, draft.id).map((e) => e.reason)).toEqual([
      'contact-denied',
    ]);
    const failed = events(h, 'draft.failed')[0] as Extract<
      AuditEvent,
      { type: 'draft.failed' }
    >;
    expect(failed.error.code).toBe('gate-denied');
    expect(failed.error.message).toContain('contact-denied');
    // The ledger was never opened: refusal happens before the attempt, so a
    // denied draft cannot look like a send that went wrong.
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
  });

  it('the SAME draft sends when the policy is left alone (the deny is attributable)', async () => {
    const h = await armed({ contact: 'draft-only' });
    const draft = pending(h);
    const approve = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(approve.statusCode).toBe(200);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
    expect(denials(h)).toEqual([]);
  });

  it('the rebuilt context is the DRAFT: a rule-less draft to the same denied handle still sends', async () => {
    // The ladder binds because the draft carries a rule (§2.4.3), not because
    // the handle is denied. Same store, same deny row, no rule: F-20's pin,
    // re-asserted at the send moment rather than at the route.
    const h = await armed({ contact: 'deny' });
    const draft = pending(h, { ruleId: null });
    const approve = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(approve.statusCode).toBe(200);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
  });
});

// --- Row 2: a closing window requeues --------------------------------------

describe('s6 Sc10 row 2: a window closing during the grace requeues (F-72)', () => {
  it('returns the draft to pending, clears sendNotBefore, leaves expiresAt alone', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    // 09:59:59 + 10s: the two numbers this row exists for.
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBe(
      '2026-09-01T10:00:09.000Z',
    );

    h.clockCtl.advance(GRACE_MS);
    expect(h.clockCtl.clock.now()).toBe('2026-09-01T10:00:09.000Z');
    await h.scheduler.tick();

    const after = h.store.getDraft(draft.id);
    expect(after?.state).toBe('pending');
    // Cleared, and cleared means OMITTED — a NULL column round-trips as an
    // absent key under exactOptionalPropertyTypes, never as `undefined`.
    expect(after?.sendNotBefore).toBeUndefined();
    expect(
      after === null || after === undefined ? true : 'sendNotBefore' in after,
    ).toBe(false);
    // The TTL is the draft's own clock and the requeue does not restart it.
    expect(after?.expiresAt).toBe(draft.expiresAt);
    expect(h.backend.callCount()).toBe(0);
  });

  it('audits draft.requeued and gate.denied, in that order, under the window-closed actor', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = await requeue(h);

    // The state change first, then the reason for it: the same order `fail`
    // has always used (`draft.failed` then `gate.denied`), because a reader
    // scanning for what happened to a draft should find it before the
    // explanation.
    // `adapter.created` is the harness registering the adapter through its
    // own route; everything after it is this draft's whole life.
    expect(auditTypes(h.store).filter((t) => t !== 'adapter.created')).toEqual([
      'auto.approved',
      'draft.approved',
      'draft.requeued',
      'gate.denied',
    ]);
    expect(events(h, 'draft.requeued')).toEqual([
      { type: 'draft.requeued', draftId: draft.id, reason: 'outside-window' },
    ]);
    expect(denials(h, draft.id).map((e) => e.reason)).toEqual([
      'outside-window',
    ]);
    // Not the approval's actor: the machine that requeued is not the machine
    // that approved, and §1.7 gives the row exactly one legal actor.
    expect(auditActors(h.store, 'draft.requeued')).toEqual([
      { kind: 'system', reason: 'window-closed' },
    ]);
    expect(auditActors(h.store, 'gate.denied')).toEqual([
      { kind: 'system', reason: 'window-closed' },
    ]);
  });

  it('nothing FAILED: no draft.failed row, no ledger attempt, no send feedback', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = await requeue(h);

    expect(events(h, 'draft.failed')).toEqual([]);
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    // The approval it was minted with is NOT deleted: it recorded a decision
    // that really was made, and the audit log does not get to un-happen. What
    // makes it inert is the draft's state, so `listGraceElapsed`'s inner join
    // can never surface this pair again.
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);
    expect(h.store.listGraceElapsed('2100-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('the outcome is `requeued`, not `failed`', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    const approvalId = h.store.listApprovals(draft.id)[0]?.id;
    expect(approvalId).toBeTypeOf('string');
    h.clockCtl.advance(GRACE_MS);

    // Straight at the dispatcher the scheduler itself runs, so the third
    // `DispatchOutcome` variant is asserted rather than inferred.
    const outcome = await h.dispatch(draft.id, approvalId as Ulid);
    expect(outcome).toEqual({ outcome: 'requeued', reason: 'outside-window' });
  });

  it('the scheduler cannot find it again: ten more ticks are a no-op', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = await requeue(h);
    const before = auditTypes(h.store).length;

    for (let i = 0; i < 10; i += 1) {
      h.clockCtl.advance(1_000);
      await h.scheduler.tick();
    }
    expect(auditTypes(h.store)).toHaveLength(before);
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.backend.callCount()).toBe(0);
  });
});

// --- Row 3: a requeued draft is never re-auto-approved ---------------------

describe('s6 Sc10 row 3: autonomy had one moment and missed it', () => {
  it('ten further ticks produce no Approval row and no send', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = await requeue(h);
    // One approval exists: the one autonomy spent on the moment it missed.
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);

    for (let i = 0; i < 10; i += 1) {
      h.clockCtl.advance(60_000);
      await h.scheduler.tick();
    }

    expect(h.store.listApprovals(draft.id)).toHaveLength(1);
    expect(events(h, 'auto.approved')).toHaveLength(1); // the one that got requeued
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
  });

  it('not even inside the next window, when the schedule genuinely re-opens', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = await requeue(h);

    h.clockCtl.set(T_NEXT);
    // The window really is open again — this is the assertion that stops the
    // row above from passing for the trivial reason.
    expect(decisionFor(h, draft)).toEqual({ allow: true, mode: 'auto' });

    for (let i = 0; i < 10; i += 1) {
      h.clockCtl.advance(1_000);
      await h.scheduler.tick();
    }

    // `maybeAutoApprove` runs once, at mint. Nothing re-runs it, and the
    // scheduler has no path back to it: `listGraceElapsed` only ever joins
    // drafts that are already 'approved' with an armed deadline.
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);
    expect(events(h, 'auto.approved')).toHaveLength(1);
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
  });
});

// --- Row 4: a human can still act on it ------------------------------------

describe('s6 Sc10 row 4: a requeue is a return to the queue', () => {
  it('a human approves it inside the next window and it sends normally', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = await requeue(h);

    h.clockCtl.set(T_NEXT);
    const approve = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(approve.statusCode).toBe(200);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');
    // Two approvals now: the machine's, spent and inert, and the person's.
    // The scheduler dispatches the LATEST approve row, so the send that
    // follows is authorised by the human and judged as a human's.
    const rows = h.store.listApprovals(draft.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.actor).toEqual({ kind: 'system', reason: 'auto-respond' });
    expect(rows[1]?.actor).toEqual({ kind: 'human', via: 'api' });

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
    expect(h.backend.calls()[0]?.body).toBe(draft.body);
    // One requeue, one send, and no second denial: the draft's whole life.
    expect(denials(h, draft.id)).toHaveLength(1);
  });
});

// --- Row 5: the human pin -------------------------------------------------

describe('s6 Sc10 row 5: F-20 survives the context-bearing re-gate', () => {
  it('POST /v1/send to a handle with NO contact policy still sends', async () => {
    const h = await boot({ send: true, startIso: T_INSIDE });
    // No policy at all, which is the DENY-ALL default the ladder applies to
    // anything rule-borne. The operator texting from their own Mac is not
    // rule-borne: `ruleId` is null, so the ladder is never consulted and no
    // schedule can clamp a draft that points at no rule.
    expect(h.store.getContactPolicy(HANDLE)).toBeNull();

    const res = await post(h, '/v1/send', {
      chatGuid: CHAT,
      body: 'my own phone, my own message',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { outcome: string }).outcome).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
    expect(auditTypes(h.store)).not.toContain('gate.denied');
  });

  it('and still sends at an hour no schedule in the store is armed for', async () => {
    // The same call, made at 10:30 — dead between the two windows — with a
    // real armed-for-nothing schedule and an enabled rule sitting in the
    // store. A re-gate that read the schedule without first reading whether
    // THIS draft has a rule would refuse here.
    const h = await boot({ send: true, startIso: T_SHUT });
    h.store.insertSchedule(makeSchedule());
    h.store.insertRule(makeRule({ adapterId: 'human' }));
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');

    const res = await post(h, '/v1/send', {
      chatGuid: CHAT,
      body: 'still my own phone',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { outcome: string }).outcome).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
  });
});

// --- Row 6: revocation asymmetry -------------------------------------------

describe('s6 Sc10 row 6: revocation collapses autonomy, not a human decision', () => {
  it('same revocation, two drafts: the auto one dies, the human one sends', async () => {
    const h = await armed();
    capsOutOfTheWay(h);

    const machine = pending(h, { body: 'the machine speaks' });
    expect(await auto(h, machine.id)).toBe('approved');

    const person = pending(h, { body: 'the person speaks' });
    const approve = await post(h, `/v1/drafts/${person.id}/approve`);
    expect(approve.statusCode).toBe(200);

    // ONE revocation, mid-grace, covering BOTH drafts: they share the rule,
    // the adapter and the deadline, so the only difference left between them
    // is who decided.
    h.store.setAdapterTokenHash(ADAPTER, null, null);
    expect(h.store.getAdapter(ADAPTER)?.hasToken).toBe(false);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(machine.id)?.state).toBe('failed');
    expect(denials(h, machine.id).map((e) => e.reason)).toEqual([
      'adapter-disabled',
    ]);

    expect(h.store.getDraft(person.id)?.state).toBe('sent');
    expect(denials(h, person.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(1);
    expect(h.backend.calls()[0]?.body).toBe('the person speaks');
  });

  it('a DISABLED adapter bites the same way (fail-closed on the row itself)', async () => {
    const h = await armed();
    const machine = pending(h, { body: 'the machine speaks' });
    expect(await auto(h, machine.id)).toBe('approved');

    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/adapters/${ADAPTER}`,
      headers: h.headers,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(machine.id)?.state).toBe('failed');
    expect(denials(h, machine.id).map((e) => e.reason)).toEqual([
      'adapter-disabled',
    ]);
    expect(h.backend.callCount()).toBe(0);
  });
});

// --- Row 7: the two supported outsideWindow modes, composed ----------------

describe('s6 Sc10 row 7: ignore drops, draft-only waits (Sc 5, re-asserted composed)', () => {
  async function composed(
    outsideWindow: Rule['outsideWindow'],
    startIso: string,
  ): Promise<{ h: AgentHarness; sock: FakeAdapterSocket; message: Message }> {
    const h: AgentHarness = await bootAgent({ startIso });
    const cred = await addAdapter(h, ADAPTER);
    const sock: FakeAdapterSocket = await connectAuthed(h, cred);
    h.store.insertSchedule(makeSchedule());
    h.store.insertRule(makeRule({ outsideWindow }));
    h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');

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
    return { h, sock, message };
  }

  function requests(sock: FakeAdapterSocket): unknown[] {
    return sock.frames.filter(
      (f) => (f as { type?: string }).type === 'draft.request',
    );
  }

  it("'ignore' outside the window produces NO draft and never asks the agent", async () => {
    const { h, sock, message } = await composed('ignore', T_SHUT);

    expect(requests(sock)).toEqual([]);
    expect(h.store.listDrafts()).toEqual([]);
    const denied = events(h, 'gate.denied') as Denial[];
    expect(denied.map((e) => e.reason)).toEqual(['outside-window']);
    expect(denied[0]?.guid).toBe(message.guid);
    expect(denied[0]?.adapterId).toBe(ADAPTER);
  });

  it("'draft-only' outside the window produces a draft that simply waits", async () => {
    const { h, sock } = await composed('draft-only', T_SHUT);

    await waitUntil(() => requests(sock).length > 0, 'draft.request');
    const frame = requests(sock)[0] as {
      payload: { rule: { respondMode: string }; correlation: unknown };
    };
    // F-60: the RESOLVED mode. The rule says 'auto'; the shut window is why
    // the agent is told otherwise.
    expect(frame.payload.rule.respondMode).toBe('draft-only');

    sock.sendFrame('draft.submit', {
      correlation: frame.payload.correlation,
      idempotencyKey: 'idem-sc10-waits',
      body: 'whenever you are ready',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'draft minted');
    const draft = h.store.listDrafts()[0] as Draft;

    for (let i = 0; i < 10; i += 1) {
      h.clockCtl.advance(1_000);
      await h.scheduler.tick();
    }

    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBeUndefined();
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
  });
});

// --- Row 8: 'queue' is refused, and degrades safely -------------------------

describe("s6 Sc10 row 8: 'queue' is refused at the edge and never deferred (F-69)", () => {
  it('POST /v1/rules still rejects it with 400 unsupported-outside-window', async () => {
    const h = await boot({ rules: true, startIso: T_INSIDE });
    expect(
      (
        await post(h, '/v1/adapters', {
          id: ADAPTER,
          kind: 'echo',
          displayName: ADAPTER,
        })
      ).statusCode,
    ).toBe(201);

    const res = await post(h, '/v1/rules', {
      name: 'tacos',
      matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
      adapterId: ADAPTER,
      outsideWindow: 'queue',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toStrictEqual({
      error: 'unsupported-outside-window',
      detail: { mode: 'queue' },
    });
    expect(h.store.listRules()).toEqual([]);
  });

  it('a hand-written queue row reads as draft-only and is never a deferred send', async () => {
    // The route is the only door, but a row can arrive by restore, by an
    // older build, or by somebody with a sqlite3 prompt. Fail-closed: the
    // evaluator treats the unknown third mode exactly as 'draft-only'.
    const h = await armed({
      startIso: T_SHUT,
      rule: { outsideWindow: 'queue' },
    });
    expect(h.store.getRule(RULE_ID)?.outsideWindow).toBe('queue');

    const draft = pending(h);
    expect(decisionFor(h, draft)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
    expect(await auto(h, draft.id)).toBe('withheld');

    // Not deferred: no approval, no armed deadline, and no tick anywhere in
    // the next hour turns it into a send.
    for (let i = 0; i < 60; i += 1) {
      h.clockCtl.advance(60_000);
      await h.scheduler.tick();
    }
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBeUndefined();
    // Still pending an hour later, having crossed the next window's opening
    // without anything picking it up. That is what 'draft-only' means: a
    // draft waiting for a person. A queue would have sent it at 11:00.
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
  });
});

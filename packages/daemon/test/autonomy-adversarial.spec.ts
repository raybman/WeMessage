/**
 * s6-execution Part 2 Scenario 13 ★ CHECKPOINT — the autonomy adversarial
 * suite. T-9.4 rows (a)-(f) re-attacked in their S6 form, plus five attacks
 * that only exist once a machine can approve its own drafts.
 *
 * **This file's deliverable is proof, not features.** Every mechanism it
 * attacks shipped in Scenarios 1-12; nothing here is supposed to be RED on
 * arrival, and nothing here was made to pass. Where an attack succeeds by
 * DESIGN — the loop normaliser is exact-after-normalisation and always was —
 * the row says so out loud and pins the boundary rather than quietly picking
 * a payload the product happens to catch.
 *
 * **The eleven rows.**
 *
 *   (a) auto-send while the kill switch is on, on the real auto path: all
 *       three scopes auto, the schedule armed, and the switch flipped both
 *       BEFORE the mint and after an approval whose grace has already
 *       elapsed. Withheld at the mint, denied at the re-gate.
 *   (b) send out-of-window — the literal S4 could not reach. Approved one
 *       second before a window shuts, grace elapsing nine seconds after it
 *       did: F-72 requeues, and the attacker's two follow-ups (re-run the
 *       auto decision, re-use the old approval id) are both refused.
 *   (c) forged approval authority (INV-4), three shapes: an agent-actor
 *       `Approval`, a hand-written system `auto-respond` `Approval` for a
 *       draft whose gate says draft-only, and a frame typed `draft.approve`
 *       on a live adapter socket.
 *   (d) approve-then-flip-kill during the grace, against an AUTO approval
 *       rather than a human one.
 *   (e) group-chat auto with all three scopes auto — withheld at the mint
 *       with no `Approval` row at all, then denied at the send moment when
 *       the attacker forges one anyway (INV-5, both halves).
 *   (f) unapproved direct dispatch: a mismatched approval id, an
 *       approval-LESS draft parked in `approved` with an elapsed deadline
 *       (INV-2's INNER JOIN), and the compile-time half re-pinned.
 *   (g) a 200-message rate-cap flood across 200 distinct handles.
 *   (h) a bot-to-bot echo storm, both halves of the loop breaker, plus the
 *       normaliser's honest boundary.
 *   (i) a pause with every OTHER arming input flipped to its most permissive
 *       value at once.
 *   (j) an adapter revoked mid-grace, through all three revocation surfaces.
 *   (k) the injected clock jumping backward two hours between approval and
 *       tick.
 *
 * **Two places this file departs from the plan's table, both stated rather
 * than silently absorbed.**
 *
 *  1. The plan's rows (g) and (h) expect `gate.denied {rate-limited}` "exactly
 *     170 times" and `gate.denied {loop-detected}`. §1.7 is explicit that a
 *     CLAMP is never audited as a denial: a withheld auto-approval refused
 *     nobody, minted nothing and writes no audit row. Softening the attack to
 *     produce those rows would mean approving 170 messages we should not have
 *     approved. So (g) and (h) assert the honest inverse — the exact count of
 *     approvals minted, the exact count withheld, the `clampedBy` on each —
 *     and then reach a REAL audited denial the only two ways the product
 *     offers one: (g) through the global cap's refusal of a HUMAN at the
 *     approve route (§2.4.3, the one rate limit in this product that tells a
 *     person no), and (h) through the send-moment re-gate, when the echo
 *     lands during the grace of an approval that had already been minted.
 *     Both are the plan's named literals, reached without weakening anything.
 *
 *  2. The plan's row (a) reads "clamp at mint". The kill switch is step 1 of
 *     §1.7 — a DENY, not one of the six clamps — so at the mint it produces
 *     `{allow: false, reason: 'kill-switch'}` and the auto path withholds on
 *     `!decision.allow`. The audited `gate.denied {kill-switch}` the row
 *     promises comes from the re-gate, which is where a denial belongs. The
 *     attack is unchanged; the wording is corrected.
 *
 * **The echo storm's history is planted, and that makes it stronger.** Both
 * halves of the loop breaker read `drafts WHERE state = 'sent'`
 * (`consecutiveAutoInChat` and `recentSentBodies`), so a storm that made the
 * machine EARN its three turns would need three real sends — and this file's
 * single strongest claim is that `SendBackend.send` was called zero times
 * across all of it. So row (h) hands the attacker the history for free: three
 * `sent` drafts with system `auto-respond` approvals, written straight
 * through the store, exactly as the S4 suite hands the attacker forged
 * approvals rather than making it earn those either. The attacker starts
 * already three turns into a runaway loop and the breaker still holds. That
 * is a harder starting position than the product could ever reach on its own,
 * which is the point: making the attack stronger is the only honest way to
 * keep the assertion.
 *
 * **Standing negatives, asserted over every hostile session at the end.** The
 * audit hash chain still verifies; no row produced a reason string outside
 * the pinned twelve (C-6: the five S6 clamp literals plus the seven that
 * predate them); exactly one `Approval` row in the file carries an agent
 * actor and this file forged it by hand; and `SendBackend.send` was called
 * ZERO times by every attack here.
 *
 * That last sweep has one named exception, and naming it is the point. Row
 * (j)'s final test is a CONTROL rather than an attack: it approves a draft as
 * a HUMAN and lets it go out, because the three revocation denials above it
 * would otherwise read as "a revoked adapter stops sending" instead of "an
 * auto approval does not outlive the credential it was taken under". It is
 * the only send in the file, it is swept under its own label, and the closing
 * assertion lists it by name with its count. Quietly leaving it out of the
 * sweep to keep a rounder number would be precisely the softening this file
 * exists to refuse.
 *
 * Handles are synthetic (`+1555…`); no real iMessage content. Time comes from
 * the injected clock at every point, including backwards.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type {
  Actor,
  AuditEvent,
  ChatGuid,
  Draft,
  GateDecision,
  GateDenyReason,
  Handle,
  Message,
  Rule,
  Schedule,
  Ulid,
} from '@wemessage/core';
import {
  contactRateScope,
  evaluateGate,
  maybeAutoApprove,
  parseChatGuid,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  readLoopLimits,
  readRateCaps,
  verifyChain,
  DEFAULT_LOOP_LIMITS,
  RATE_SCOPE_GLOBAL,
  SETTING_ALLOW_SMS_AUTO,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CONNECTION_STATE,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
  SETTING_LOOP_CONSECUTIVE_AUTO_MAX,
  SETTING_LOOP_DUPLICATE_LOOKBACK,
} from '@wemessage/core';
import { resolveArming } from '@wemessage/daemon';
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
import { PORT_IMPORTER_ALLOWLIST } from './transport-surface.snapshot.js';

/* ── constants ─────────────────────────────────────────────────────────── */

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
const SCHEDULE_ID = `${'0'.repeat(24)}S1`;
/** F-78's default: `send.autoGraceSeconds` inherits `send.undoGraceSeconds`. */
const GRACE_MS = 10_000;
/** Comfortably inside the morning window; no advance here reaches its close. */
const T_INSIDE = '2026-09-01T09:30:00.000Z';
/** One second before the morning window shuts: F-72's whole scenario. */
const T_EDGE = '2026-09-01T09:59:59.000Z';
/** One minute before the SECOND window shuts, for the clock-rewind row. */
const T_LATE = '2026-09-01T11:59:00.000Z';
/** Two hours before `T_LATE`, and outside a single 11:00-12:00 window. */
const T_REWOUND = '2026-09-01T09:59:00.000Z';
/** No `;-;` separator is what makes a chat guid a GROUP (INV-5). */
const GROUP_CHAT: ChatGuid = 'iMessage;+;chat9990001112223334';
/** Long enough that no row below is secretly asserting the TTL. */
const TTL_MINUTES = 480;
/**
 * `sumRateCounter` is bounded from BELOW only, so a row asking "how much did
 * the whole session spend" has to ask from before the session began. The
 * harness's own `T0` is NOON and every row here runs in the morning, so
 * passing `T0` would silently return zero and the flood row would pass by
 * measuring nothing.
 */
const DAY_START = '2026-09-01T00:00:00.000Z';

/** §1.7's one auto-approval actor. Minted HERE only by the attacker. */
const AUTO_ACTOR: Actor = { kind: 'system', reason: 'auto-respond' };
const AGENT_ACTOR: Actor = { kind: 'agent', adapterId: ADAPTER };

const newUlid = monotonicFactory();

afterEach(cleanupAgentHarness);

/* ── ambient sweep ─────────────────────────────────────────────────────── */

interface Snapshot {
  label: string;
  rows: ReturnType<Harness['store']['readAuditRows']>;
  events: AuditEvent[];
  approvalActors: Actor[];
  sends: number;
}
const sessions: Snapshot[] = [];

/**
 * Snapshot rather than a live harness: `cleanupAgentHarness` closes each store
 * in afterEach, long before the sweep rows run. A sweep holding a handle would
 * be asserting against a closed database.
 */
function sweep(h: Harness, label: string): void {
  sessions.push({
    label,
    rows: h.store.readAuditRows(0, 20_000),
    events: auditEvents(h.store),
    approvalActors: h.store
      .listDrafts()
      .flatMap((d) => h.store.listApprovals(d.id))
      .map((a) => a.actor),
    sends: h.backend.callCount(),
  });
}

/* ── fixtures ──────────────────────────────────────────────────────────── */

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    // All three scopes say auto, so every 'draft-only' below is a CLAMP and
    // never a narrow scope in the §2.4.3 ladder. An attacker handed the most
    // permissive configuration the product can express is the only attacker
    // worth testing.
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
 * five zones `test/arch.spec.ts` (f) pins). Every day of the week, so no row
 * depends on which weekday 2026-09-01 lands on.
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
  /** `null` inserts no schedule row at all. */
  noSchedule?: boolean;
  contact?: 'auto' | 'draft-only' | 'deny';
}

/**
 * A booted daemon whose three scopes all say auto and whose schedule is
 * armed: the only starting line from which autonomy can ever act. Each row
 * below changes exactly one thing about it, which is what makes every outcome
 * attributable to the thing that changed.
 */
async function armed(opts: ArmOptions = {}): Promise<Harness> {
  const h = await boot({ startIso: opts.startIso ?? T_INSIDE });
  // `drafts.adapter_id` is a real foreign key (§2.3), so the adapter that will
  // own these drafts is registered through its own route rather than conjured
  // into the table — and it gets a real token, which row (j) later revokes.
  const res = await post(h, '/v1/adapters', {
    id: ADAPTER,
    kind: 'echo',
    displayName: ADAPTER,
  });
  expect(res.statusCode).toBe(201);
  if (opts.noSchedule !== true)
    h.store.insertSchedule(makeSchedule(opts.schedule ?? {}));
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
    guid: `GUID-SC13-${String(seq)}`,
    sourceRowid: 13_000 + seq,
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
  handle?: Handle;
  ruleId?: string | null;
  isGroup?: boolean;
}

/**
 * A rule-borne `pending` draft, inserted exactly as `adapters/submit.ts`
 * inserts one and pointed at a real mirrored inbound. Straight into the store
 * rather than over a socket, because every row here is about what the
 * DECISION does with a draft that already exists; the socket path is proven
 * end to end by Sc 9's own call-site row and re-attacked at the frame level
 * in row (c) below.
 */
function pending(h: Harness, opts: PendingOptions = {}): Draft {
  const chatGuid = opts.chatGuid ?? CHAT;
  const source = inbound(h, {
    chatGuid,
    ...(opts.handle === undefined ? {} : { handle: opts.handle }),
    ...(opts.isGroup === undefined ? {} : { isGroup: opts.isGroup }),
  });
  seq += 1;
  const at = h.clockCtl.clock.now();
  const draft: Draft = {
    id: newUlid(Date.parse(at)) as Ulid,
    inboundGuid: source.guid,
    chatGuid,
    ruleId: opts.ruleId === undefined ? RULE_ID : opts.ruleId,
    adapterId: ADAPTER,
    idempotencyKey: `idem-sc13-${String(seq)}`,
    body: opts.body ?? 'on my way',
    originalBody: opts.body ?? 'on my way',
    state: 'pending',
    stateChangedAt: at,
    expiresAt: new Date(Date.parse(at) + TTL_MINUTES * 60_000).toISOString(),
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

/**
 * The gate as `maybeAutoApprove` itself builds it, so a row can name the
 * cause it is testing rather than merely observe an outcome. The handle and
 * the service come from the mirrored INBOUND when the draft has one; `isGroup`
 * comes from the chat guid, because that is what the SEND path parses.
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

/**
 * Plant an approval row the product would never mint, and hand it straight to
 * the dispatcher. Every row that uses this assumes the attacker already has
 * write access to the approvals table and asserts the gate still refuses: a
 * test that could only attack through the routes would be testing the routes.
 */
function forgeApproval(h: Harness, draftId: Ulid, actor: Actor): Ulid {
  const id = newUlid(Date.parse(h.clockCtl.clock.now())) as Ulid;
  h.store.insertApproval({
    id,
    draftId,
    action: 'approve',
    actor,
    at: h.clockCtl.clock.now(),
  });
  return id;
}

/**
 * A machine turn that has already been SENT, written straight through the
 * store: a `sent` draft plus the system `auto-respond` approval behind it.
 * This is row (h)'s hostile history and the file header explains why it is
 * planted rather than earned — both halves of the loop breaker read
 * `drafts WHERE state = 'sent'`, and earning three of those would cost three
 * real backend calls, which is the one thing this file claims never happened.
 * The attacker is handed a harder starting position, not an easier one.
 */
function plantSentAuto(h: Harness, body: string, chatGuid: ChatGuid): Ulid {
  const at = h.clockCtl.clock.now();
  seq += 1;
  const id = newUlid(Date.parse(at)) as Ulid;
  h.store.insertDraft({
    id,
    inboundGuid: null,
    chatGuid,
    ruleId: RULE_ID,
    adapterId: ADAPTER,
    idempotencyKey: `idem-echo-${String(seq)}`,
    body,
    originalBody: body,
    state: 'sent',
    stateChangedAt: at,
    expiresAt: new Date(Date.parse(at) + TTL_MINUTES * 60_000).toISOString(),
    createdAt: at,
  });
  h.store.insertApproval({
    id: newUlid(Date.parse(at)) as Ulid,
    draftId: id,
    action: 'approve',
    actor: AUTO_ACTOR,
    at,
  });
  return id;
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

function denyReasons(h: Harness, draftId?: Ulid): GateDenyReason[] {
  return denials(h, draftId).map((e) => e.reason);
}

/**
 * The id of the approval the product actually minted — never a fallback. An
 * earlier draft of this file reached for the id with an optional chain and an
 * empty-string default, which meant a build that had stopped minting
 * approvals altogether would still see its dispatch refused (for the wrong
 * reason) and every row here would stay green. A suite whose subject is "only
 * a valid Approval authorises a send" has to fail loudly when there is no
 * Approval to be found: that is the difference between this file proving the
 * mint and merely surviving it.
 */
function mintedApprovalId(h: Harness, draftId: Ulid): Ulid {
  const approval = h.store.latestApproveApproval(draftId);
  if (approval === null || approval === undefined)
    throw new Error(`no approval was minted for draft ${draftId}`);
  return approval.id;
}

/** The gate's verdict flattened to one comparable string, for table rows. */
function clampOf(h: Harness, draft: Draft): string {
  const decision = decisionFor(h, draft);
  if (!decision.allow) return `denied:${decision.reason}`;
  return decision.clampedBy ?? 'none';
}

/** Let every queued socket callback run before asserting a NEGATIVE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(setImmediate);
}

/* ── (a) auto-send while the kill switch is on ─────────────────────────── */

describe('s6 Sc13 (a): auto-send under a kill switch', () => {
  it('withholds at the mint, with no approval and no audit row to show for it', async () => {
    const h = await armed();
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);
    const draft = pending(h);

    // Step 1 of §1.7 is a DENY, not one of the six clamps (see the header's
    // note 2): there is no `clampedBy` here because nothing was clamped, the
    // decision was refused outright.
    expect(decisionFor(h, draft)).toEqual({
      allow: false,
      reason: 'kill-switch',
    });
    expect(await auto(h, draft.id)).toBe('withheld');

    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(events(h, 'auto.approved')).toEqual([]);
    // A withheld decision refused nobody, so it writes no denial. The only
    // `gate.denied` in this store would have to have come from somewhere else.
    expect(denials(h, draft.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'a.withheld-at-mint');
  });

  it('denies at the re-gate when the switch lands after the grace has elapsed', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');

    // The grace must ELAPSE before the flip, or the toggle route's
    // `cancelGraceApproved` rejects the draft and the dispatcher refuses it
    // one layer earlier as "not in state 'approved'". That refusal is real,
    // but it belongs to row (d): to attack the kill switch itself the draft
    // has to still be 'approved' when the mutex-held re-gate reads the world.
    h.clockCtl.advance(GRACE_MS + 1_000);
    const res = await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(res.statusCode).toBe(200);
    // Nothing was cancelled, which is what makes the next assertion
    // attributable to the re-gate rather than to the route.
    expect((res.json() as { cancelled: string[] }).cancelled).toEqual([]);
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');

    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(denyReasons(h, draft.id)).toEqual(['kill-switch']);
    // Refusal happens before the attempt, so a denied draft can never be
    // mistaken for a send that went wrong.
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'a.denied-at-re-gate');
  });

  it('cannot be beaten by re-running the auto decision under the switch', async () => {
    const h = await armed();
    h.store.setSetting(SETTING_KILL_SWITCH, '1');
    const draft = pending(h);

    // Ten attempts, because a decision that is idempotent under attack is a
    // different claim from a decision that happened to say no once.
    for (let i = 0; i < 10; i += 1)
      expect(await auto(h, draft.id)).toBe('withheld');
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'a.replayed-mint');
  });
});

/* ── (b) send out-of-window ────────────────────────────────────────────── */

describe('s6 Sc13 (b): a window that shuts during the grace', () => {
  it('requeues rather than sends, and both follow-up attacks are refused', async () => {
    const h = await armed({ startIso: T_EDGE });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    // 09:59:59 + 10s: the two numbers this row exists for.
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBe(
      '2026-09-01T10:00:09.000Z',
    );
    const approvalId = mintedApprovalId(h, draft.id);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    const after = h.store.getDraft(draft.id);
    expect(after?.state).toBe('pending');
    // Cleared, and cleared means OMITTED — a NULL column round-trips as an
    // absent key under exactOptionalPropertyTypes, never as `undefined`.
    expect(
      after === null || after === undefined ? true : 'sendNotBefore' in after,
    ).toBe(false);
    expect(after?.expiresAt).toBe(draft.expiresAt);
    expect(denyReasons(h, draft.id)).toEqual(['outside-window']);
    expect(auditActors(h.store, 'draft.requeued')).toEqual([
      { kind: 'system', reason: 'window-closed' },
    ]);

    // Attack 1: re-run the auto decision on the requeued draft. The window is
    // shut, so the clamp is the same one that sent it back.
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(decisionFor(h, draft)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
    // Exactly one approval ever existed for this draft: the requeue did not
    // mint a second, and the re-run did not either.
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);

    // Attack 2: re-use the ORIGINAL approval id, which is a real row, signed
    // by the real auto actor, for this exact draft. It authorises nothing
    // because the draft is no longer 'approved'.
    await expect(h.dispatch(draft.id, approvalId)).rejects.toThrow(
      /is not in state 'approved'/,
    );
    expect(denyReasons(h, draft.id)).toEqual(['outside-window', 'unapproved']);
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'b.requeued');
  });
});

/* ── (c) forged approval authority (INV-4) ─────────────────────────────── */

describe('s6 Sc13 (c): forged approval authority', () => {
  it('an agent-actor approval throws and changes nothing', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    const forged = forgeApproval(h, draft.id, AGENT_ACTOR);

    await expect(h.dispatch(draft.id, forged)).rejects.toThrow(/agent actor/);

    expect(h.store.getDraft(draft.id)?.state).toBe('approved');
    expect(denyReasons(h, draft.id)).toEqual(['unapproved']);
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.agent-actor');
  });

  it("a hand-written system 'auto-respond' approval on a draft-only draft is denied unapproved", async () => {
    // The contact rung says draft-only, so the gate resolves 'draft-only' and
    // autonomy is not on the table. The attacker mints §1.7's one auto actor
    // anyway, which is the strongest forgery the taxonomy can express.
    const h = await armed({ contact: 'draft-only' });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(decisionFor(h, draft)).toEqual({ allow: true, mode: 'draft-only' });

    // A human moves it to 'approved' through the real route, which is the
    // only legitimate way this draft can be sent at all.
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    const forged = forgeApproval(h, draft.id, AUTO_ACTOR);

    h.clockCtl.advance(GRACE_MS);
    await h.dispatch(draft.id, forged).catch(() => undefined);

    // The re-gate believed the actor — and then asked whether THIS draft was
    // one an auto approval could have been minted for. It was not.
    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(h.store.getDraft(draft.id)?.error?.message).toContain('unapproved');
    expect(denyReasons(h, draft.id)).toEqual(['unapproved']);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.forged-auto-actor');
  });

  it('a frame typed draft.approve audits adapter.no-send-frame and never gate.denied (C-6)', async () => {
    const h: AgentHarness = await bootAgent({ startIso: T_INSIDE });
    const cred = await addAdapter(h, ADAPTER);
    const sock: FakeAdapterSocket = await connectAuthed(h, cred);
    h.store.insertSchedule(makeSchedule());
    h.store.insertRule(makeRule());
    h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');

    // Three shapes of the same forgery, under a fully-auto ladder — the world
    // in which an adapter has the most to gain by claiming approval authority.
    // `draft.approve` is not in the protocol, and that absence is the design.
    sock.sendFrame('draft.approve', {
      draftId: '01DRAFTNEVERMINTED',
      approve: true,
    });
    sock.sendFrame('send', { chatGuid: CHAT, body: 'straight out the door' });
    sock.sendFrame('toggle.set', { key: SETTING_KILL_SWITCH, on: false });
    await waitUntil(
      () => events(h, 'adapter.no-send-frame').length === 3,
      'three forbidden frames audited',
    );
    await settle();

    expect(
      events(h, 'adapter.no-send-frame').map((e) =>
        'frameType' in e ? String(e.frameType) : '<none>',
      ),
    ).toEqual(['draft.approve', 'send', 'toggle.set']);
    // C-6, stated as a negative: a wire-level refusal is never a gate deny.
    expect(denyReasons(h)).toEqual([]);
    expect(h.store.listDrafts()).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.forged-frame');
  });
});

/* ── (d) approve-then-flip-kill during the grace ───────────────────────── */

describe('s6 Sc13 (d): a kill flip inside an AUTO approval’s grace', () => {
  it('kills the draft one way or the other, and the retry is refused too', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    const approvalId = mintedApprovalId(h, draft.id);
    expect(h.store.latestApproveApproval(draft.id)?.actor).toEqual(AUTO_ACTOR);

    // Mid-grace. This is the interval F-78 refused to let reach zero, and
    // this row is what the interval is FOR — against a machine's own
    // approval rather than a person's.
    h.clockCtl.advance(GRACE_MS / 2);
    const res = await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(res.statusCode).toBe(200);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    const final = h.store.getDraft(draft.id);
    // Two legitimate mechanisms, asserted as the disjunction they are: the
    // toggle route cancels every draft still inside its grace, and anything
    // that slips past dies at the mutex-held re-gate instead. Which one wins
    // is a question about WHERE it is stopped, never about WHETHER — and
    // demanding one outcome would eventually be "fixed" by making the product
    // lie about the other.
    const cancelled =
      final?.state === 'rejected' &&
      auditActors(h.store, 'draft.rejected').some(
        (a) =>
          JSON.stringify(a) ===
          JSON.stringify({ kind: 'system', reason: 'kill-switch' }),
      );
    const reGated =
      final?.state === 'failed' &&
      denyReasons(h, draft.id).includes('kill-switch');
    expect(cancelled || reGated).toBe(true);

    // The attacker retries with the REAL auto approval id, which is a valid
    // row for this exact draft. The draft is no longer 'approved', so it
    // authorises nothing.
    await expect(h.dispatch(draft.id, approvalId)).rejects.toThrow(
      /is not in state 'approved'/,
    );
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'd.kill-mid-grace');
  });
});

/* ── (e) group-chat auto (INV-5) ───────────────────────────────────────── */

describe('s6 Sc13 (e): a group chat with all three scopes auto', () => {
  it('is withheld at the mint with no Approval row, then denied when one is forged', async () => {
    const h = await armed();
    const draft = pending(h, { chatGuid: GROUP_CHAT, isGroup: true });

    // The rule ALLOWS group drafts, the contact says auto and so does the
    // global mode. The only thing between this draft and a send is INV-5.
    expect(h.store.getRule(RULE_ID)?.allowGroupDrafts).toBe(true);
    expect(h.store.getContactPolicy(HANDLE)?.mode).toBe('auto');
    // No `clampedBy`, and that absence is the point: INV-5 narrows the MODE
    // before step 7 runs, so it is not one of the six clamps and never gets
    // reported as one.
    expect(decisionFor(h, draft)).toEqual({ allow: true, mode: 'draft-only' });

    expect(await auto(h, draft.id)).toBe('withheld');
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(events(h, 'auto.approved')).toEqual([]);
    // It never reached the gate's deny path, so there is nothing to audit.
    expect(denials(h, draft.id)).toEqual([]);

    // The human route refuses it too, and for a reason worth naming: the
    // approve route reads the contact policy for the handle it parses out of
    // the CHAT GUID, and a group's parsed handle is the group id, which no
    // operator has ever set a policy for. With a rule attached, that is the
    // contact ladder's `contact-denied` rung. Fail-safe, and not this row's
    // subject, so the attacker removes the obstacle rather than leaning on it.
    const denied = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      error: 'gate-denied',
      reason: 'contact-denied',
    });

    // Now the attacker supplies what the mint refused to: an auto policy on
    // the group's own derived handle — so that every scope the product has,
    // including this one, says auto — a human approval through the real
    // route, and a forged auto actor on top of it.
    h.store.setContactPolicy({
      handle: parseChatGuid(GROUP_CHAT).handle,
      mode: 'auto',
      updatedAt: T0,
    });
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    const forged = forgeApproval(h, draft.id, AUTO_ACTOR);
    h.clockCtl.advance(GRACE_MS);
    await h.dispatch(draft.id, forged).catch(() => undefined);

    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(h.store.getDraft(draft.id)?.error?.message).toContain(
      'group-auto-forbidden',
    );
    // Two refusals, in the order they happened: the route's contact rung
    // (F-34 audits it even though the draft did not move) and then INV-5 at
    // the send moment.
    expect(denyReasons(h, draft.id)).toEqual([
      'contact-denied',
      'group-auto-forbidden',
    ]);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'e.group-auto');
  });
});

/* ── (f) unapproved direct dispatch (INV-2) ────────────────────────────── */

describe('s6 Sc13 (f): dispatch without an approval that authorises it', () => {
  it("another draft's approval id is unapproved, not authority", async () => {
    const h = await armed();
    capsOutOfTheWay(h);
    const victim = pending(h, { body: 'the draft that gets sent' });
    const other = pending(h, { body: 'the draft that was approved' });
    expect(await auto(h, victim.id)).toBe('approved');
    expect(await auto(h, other.id)).toBe('approved');
    const othersApprovalId = mintedApprovalId(h, other.id);

    await expect(h.dispatch(victim.id, othersApprovalId)).rejects.toThrow(
      /does not authorize/,
    );

    expect(h.store.getDraft(victim.id)?.state).toBe('approved');
    expect(denyReasons(h, victim.id)).toEqual(['unapproved']);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'f.mismatched-approval');
  });

  it('an approval-LESS draft parked in approved with an elapsed deadline is invisible to the scheduler', async () => {
    const h = await armed();
    const at = h.clockCtl.clock.now();
    const id = newUlid(Date.parse(at)) as Ulid;
    // The strongest form of this attack: the attacker writes the drafts row
    // by hand, in exactly the shape the grace sweep looks for — state
    // 'approved', a deadline already in the past — and simply omits the
    // approval. `#listGraceElapsed` INNER JOINs `approvals`, so there is no
    // row for this draft to be found in.
    h.store.insertDraft({
      id,
      inboundGuid: null,
      chatGuid: CHAT,
      ruleId: null,
      adapterId: ADAPTER,
      idempotencyKey: 'idem-sc13-invisible',
      body: 'sent by nobody',
      originalBody: 'sent by nobody',
      state: 'approved',
      stateChangedAt: at,
      sendNotBefore: new Date(Date.parse(at) - 60_000).toISOString(),
      expiresAt: new Date(Date.parse(at) + TTL_MINUTES * 60_000).toISOString(),
      createdAt: at,
    });

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(id)?.state).toBe('approved');
    expect(h.store.sendAttemptCount(id)).toBe(0);
    expect(h.backend.callCount()).toBe(0);
    // Not "denied" — never even considered. The join is the invariant.
    expect(denials(h, id)).toEqual([]);

    // Handing it to the dispatcher directly, with an approval id that does
    // not exist, is the same refusal one layer down.
    const bogus = newUlid(Date.parse(h.clockCtl.clock.now())) as Ulid;
    await expect(h.dispatch(id, bogus)).rejects.toThrow(/does not authorize/);
    expect(denyReasons(h, id)).toEqual(['unapproved']);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'f.approval-less-draft');
  });

  it('the compile-time half is still fifteen files (INV-2, INV-3)', () => {
    // The runtime half above says an approval is required. This says nobody
    // outside the allowlist can reach `SendBackend` to try. `test/arch.spec.ts`
    // rows (a)-(c) enforce it against the real dependency graph; naming the
    // number here is what makes an adversarial suite notice a sixteenth file.
    expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(15);
  });
});

/* ── (g) rate-cap flood ────────────────────────────────────────────────── */

describe('s6 Sc13 (g): a two-hundred message flood', () => {
  it('mints exactly thirty approvals and withholds the other hundred and seventy', async () => {
    // No schedule at all, so the ONLY thing standing between two hundred
    // auto-eligible messages and two hundred sends is the global cap. A
    // window closing halfway through would clamp `outside-window` and this
    // row would silently stop measuring the blast-radius bound.
    const h = await armed({ rule: { scheduleId: null }, noSchedule: true });
    // The shipped defaults, asserted rather than set: 30/hour is the blast
    // radius this row exists to pin.
    expect(readRateCaps(h.store)).toEqual({
      contactPer2Min: 1,
      contactPerHour: 10,
      globalPerHour: 30,
    });

    // Two hundred DISTINCT synthetic handles, one message each. Nothing is
    // raised and nothing is relaxed: with one message per contact, neither
    // per-contact cap can ever bind, which leaves the global bound as the
    // only possible explanation for anything that gets withheld. Spreading
    // the flood makes the attack stronger, not weaker — it removes an earlier
    // defence rather than an argument.
    const drafts: Draft[] = [];
    for (let i = 0; i < 200; i += 1) {
      const handle = `+1555${String(i).padStart(7, '0')}` as Handle;
      const chatGuid = `iMessage;-;${handle}` as ChatGuid;
      h.store.setContactPolicy({ handle, mode: 'auto', updatedAt: T0 });
      drafts.push(pending(h, { chatGuid, handle, body: `reply ${String(i)}` }));
      // Fifteen seconds apart: fifty minutes for the whole flood, so every
      // bucket it writes is still inside the rolling hour at the end of it.
      h.clockCtl.advance(15_000);
    }

    const outcomes: string[] = [];
    for (const draft of drafts) outcomes.push(await auto(h, draft.id));

    const approved = outcomes.filter((o) => o === 'approved').length;
    expect(`${String(approved)}/${String(outcomes.length)}`).toBe('30/200');
    // The first thirty, in order, and then nothing: the cap is a bound on the
    // hour, not a sampling.
    expect(outcomes.indexOf('withheld')).toBe(30);
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, DAY_START)).toBe(30);

    // Attributable: the thirty-first is a CLAMP naming the cap, on a message
    // whose own contact has never been written to.
    const first = drafts[30] as Draft;
    expect(decisionFor(h, first)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'rate-limited',
    });
    expect(
      h.store.sumRateCounter(
        contactRateScope(parseChatGuid(first.chatGuid).handle),
        DAY_START,
      ),
    ).toBe(0);

    // §1.7, stated as the count it actually is: a hundred and seventy
    // withheld decisions refused nobody and wrote nothing. See the file
    // header's note 1 — the plan's table expected a hundred and seventy
    // `gate.denied {rate-limited}` rows here, and producing them would have
    // required approving a hundred and seventy messages first.
    expect(denials(h)).toEqual([]);
    expect(events(h, 'auto.approved')).toHaveLength(30);
    // Not one of the thirty is ever ticked past its grace, so the flood
    // reaches the wire zero times.
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'g.flood');
  });

  it('the saturated bound then refuses a HUMAN, and that refusal IS audited', async () => {
    // The other half of F-71 and the plan's named literal, reached honestly:
    // the global cap is the one rate limit in this product that tells a
    // person no, so a flood that has spent the hour's budget locks out the
    // manual path too. This is the blast-radius bound working as designed.
    const h = await armed({ rule: { scheduleId: null }, noSchedule: true });
    for (let i = 0; i < 200; i += 1) {
      const handle = `+1555${String(i).padStart(7, '0')}` as Handle;
      const chatGuid = `iMessage;-;${handle}` as ChatGuid;
      h.store.setContactPolicy({ handle, mode: 'auto', updatedAt: T0 });
      const draft = pending(h, {
        chatGuid,
        handle,
        body: `reply ${String(i)}`,
      });
      await auto(h, draft.id);
      h.clockCtl.advance(15_000);
    }
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, DAY_START)).toBe(30);

    const victim = pending(h, { body: 'a person, deciding' });
    const res = await post(h, `/v1/drafts/${victim.id}/approve`);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'gate-denied',
      reason: 'rate-limited',
    });
    expect(denyReasons(h, victim.id)).toEqual(['rate-limited']);
    expect(h.store.getDraft(victim.id)?.state).toBe('pending');
    expect(h.store.listApprovals(victim.id)).toEqual([]);
    // The refusal did not spend budget either.
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, DAY_START)).toBe(30);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'g.flood-locks-out-the-human');
  });
});

/* ── (h) bot-to-bot echo storm ─────────────────────────────────────────── */

describe('s6 Sc13 (h): an echo storm against both halves of the loop breaker', () => {
  it('clamps the fourth machine turn in a row', async () => {
    const h = await armed();
    capsOutOfTheWay(h);
    expect(readLoopLimits(h.store)).toEqual(DEFAULT_LOOP_LIMITS);

    // Three machine turns already sent, planted (see the file header). The
    // attacker starts three turns into the runaway.
    for (let i = 1; i <= 3; i += 1) plantSentAuto(h, `turn ${String(i)}`, CHAT);
    expect(h.store.consecutiveAutoInChat(CHAT)).toBe(3);

    const fourth = pending(h, { body: 'turn 4' });
    expect(decisionFor(h, fourth)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });
    expect(await auto(h, fourth.id)).toBe('withheld');
    expect(h.store.listApprovals(fourth.id)).toEqual([]);

    // And it stays clamped however many times the counterpart replies. Every
    // one of these is a fresh inbound with a fresh body, which is exactly the
    // shape a scripted bot produces.
    for (let i = 5; i <= 12; i += 1) {
      const turn = pending(h, { body: `turn ${String(i)}` });
      expect(await auto(h, turn.id), `turn ${String(i)}`).toBe('withheld');
    }
    expect(events(h, 'auto.approved')).toEqual([]);
    expect(denials(h)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'h.streak');
  });

  it('clamps a repeated body even when the streak is nowhere near its limit', async () => {
    const h = await armed();
    capsOutOfTheWay(h);
    plantSentAuto(h, 'We are on our way!', CHAT);
    // One machine turn: a third of the streak limit, so anything withheld
    // below is the DUPLICATE half and cannot be the streak half.
    expect(h.store.consecutiveAutoInChat(CHAT)).toBe(1);

    const echo = pending(h, { body: 'we are on our way' });
    expect(decisionFor(h, echo)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });
    expect(await auto(h, echo.id)).toBe('withheld');
    expect(h.store.listApprovals(echo.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'h.duplicate');
  });

  it('converts to gate.denied {loop-detected} when the echo lands during the grace', async () => {
    // The plan's named audited row, reached the only way §1.7 allows: the
    // approval already existed when the duplicate appeared, so there IS
    // somebody to refuse.
    const h = await armed();
    capsOutOfTheWay(h);
    const draft = pending(h, { body: 'we are on our way' });
    expect(await auto(h, draft.id)).toBe('approved');

    // Mid-grace, the counterpart's echo lands and is answered by a machine
    // turn that goes out. One planted turn, so the streak is 1 and the
    // denial below can only be the duplicate half.
    h.clockCtl.advance(GRACE_MS / 2);
    plantSentAuto(h, 'We are on our way!!', CHAT);
    expect(h.store.consecutiveAutoInChat(CHAT)).toBe(1);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(denyReasons(h, draft.id)).toEqual(['loop-detected']);
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'h.duplicate-at-send-moment');
  });

  it('is exact after normalisation, and these are the payloads that slip through by design', async () => {
    // §2.4.3 chose exact-after-normalisation over edit distance deliberately:
    // a fuzzy matcher would withhold autonomy from two people who happen to
    // say similar things, and "the machine went quiet because your sentence
    // resembled its last one" is a worse failure than one extra reply. This
    // row does not argue with that. It pins the boundary so a future change
    // to `normalizeBody` cannot move it silently, and it names every payload
    // that gets through so nobody has to discover the list under attack.
    const h = await armed();
    capsOutOfTheWay(h);
    h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, '100');
    plantSentAuto(h, 'we are on our way', CHAT);

    // Written as escapes, not as literal characters: half of these are
    // invisible, and a table a reviewer cannot see is a table a reviewer
    // cannot check. Escapes also survive an editor that would helpfully
    // normalise a zero-width joiner out of existence on save.
    const caught: Array<[string, string]> = [
      ['upper case', 'WE ARE ON OUR WAY'],
      ['collapsed whitespace', '  we  are\t\ton   our way  '],
      ['trailing punctuation', 'we are on our way!!!'],
      ['wrapping punctuation', '"we are on our way."'],
      [
        'fullwidth forms (NFKC)',
        '\uFF57\uFF45 \uFF41\uFF52\uFF45 \uFF4F\uFF4E \uFF4F\uFF55\uFF52 \uFF57\uFF41\uFF59',
      ],
      ['non-breaking space (U+00A0)', 'we are on\u00A0our way'],
    ];
    const slips: Array<[string, string]> = [
      ['cyrillic homoglyph (U+0435)', 'w\u0435 are on our way'],
      ['zero-width joiner (U+200D)', 'we are on\u200D our way'],
      ['zero-width space (U+200B)', 'we are on\u200B our way'],
      ['right-to-left mark (U+200F)', 'we are on our way\u200F'],
      ['combining acute (U+0301)', 'we\u0301 are on our way'],
      ['soft hyphen (U+00AD)', 'we are on our\u00ADway'],
      ['one word added', 'we are on our way now'],
      ['one character dropped', 'we are on our wa'],
    ];

    for (const [label, body] of caught) {
      const draft = pending(h, { body });
      expect(`${label}:${clampOf(h, draft)}`).toBe(`${label}:loop-detected`);
      expect(await auto(h, draft.id), label).toBe('withheld');
    }
    for (const [label, body] of slips) {
      const draft = pending(h, { body });
      expect(`${label}:${clampOf(h, draft)}`).toBe(`${label}:none`);
      // Not clamped, and therefore approved: these are the payloads a
      // determined attacker uses, and the honest answer is that the loop
      // breaker does not stop them. What DOES stop them is everything else
      // in §1.7 — the streak half counts machine turns whatever they say,
      // and the caps bound the hour regardless of content.
      expect(`${label}:${await auto(h, draft.id)}`).toBe(`${label}:approved`);
      // Each one spends real budget, which is the bound that survives
      // whatever the body says.
      h.clockCtl.advance(3 * 60_000);
    }
    expect(h.store.sumRateCounter(RATE_SCOPE_GLOBAL, DAY_START)).toBe(
      slips.length,
    );

    // Not one of them ever reached the wire: nothing here is ticked past its
    // grace, so "approved" is as far as any of these payloads got.
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'h.normaliser-boundary');
  });
});

/* ── (i) pause bypass ──────────────────────────────────────────────────── */

describe('s6 Sc13 (i): a pause with every other input at its most permissive', () => {
  it('stays withheld across the whole run, with no Approval row anywhere', async () => {
    const h = await armed({ rule: { scheduleId: null }, noSchedule: true });
    expect(
      (await post(h, '/v1/toggles/pause', { until: '1h' })).statusCode,
    ).toBe(200);

    // Every OTHER arming input, flipped to the value that grants the most
    // autonomy, all at once. If any of them could beat a pause, one of the
    // twenty attempts below would mint an approval.
    h.store.setSetting(SETTING_KILL_SWITCH, '0');
    h.store.setSetting(SETTING_CONNECTION_STATE, 'fully-connected');
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
    h.store.setSetting(SETTING_ALLOW_SMS_AUTO, '1');
    h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '5000');
    h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '5000');
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '5000');
    h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, '5000');
    h.store.setSetting(SETTING_LOOP_DUPLICATE_LOOKBACK, '1');
    h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });

    for (let i = 0; i < 20; i += 1) {
      const draft = pending(h, { body: `attempt ${String(i)}` });
      // F-68: the pause reuses the 'outside-window' literal rather than
      // minting 'paused' into the deny taxonomy, which is what makes a paused
      // auto-approval requeue instead of fail.
      expect(decisionFor(h, draft)).toEqual({
        allow: true,
        mode: 'draft-only',
        clampedBy: 'outside-window',
      });
      expect(await auto(h, draft.id), `attempt ${String(i)}`).toBe('withheld');
      h.clockCtl.advance(60_000);
    }

    expect(
      h.store.listDrafts().flatMap((d) => h.store.listApprovals(d.id)),
    ).toEqual([]);
    expect(events(h, 'auto.approved')).toEqual([]);
    expect(
      resolveArming({ store: h.store, clock: h.clockCtl.clock }),
    ).toMatchObject({
      armed: false,
      reason: 'paused',
    });
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'i.pause-bypass');
  });

  it('is outranked only by the two holds above it (§1.3.6 precedence)', async () => {
    const h = await armed({ rule: { scheduleId: null }, noSchedule: true });
    await post(h, '/v1/toggles/pause', { until: '1h' });
    const armingReason = (): string =>
      resolveArming({ store: h.store, clock: h.clockCtl.clock }).reason;

    expect(armingReason()).toBe('paused');
    // A kill switch outranks a hand.
    h.store.setSetting(SETTING_KILL_SWITCH, '1');
    expect(armingReason()).toBe('kill-switch');
    // And a host that cannot send at all outranks the switch.
    h.store.setSetting(SETTING_CONNECTION_STATE, 'disconnected');
    expect(armingReason()).toBe('disconnected');
    h.store.setSetting(SETTING_CONNECTION_STATE, 'fully-connected');
    h.store.setSetting(SETTING_KILL_SWITCH, '0');
    // Nothing below it can lift it: the schedule is absent and the breaker
    // is closed, and it is still the hand that holds.
    expect(armingReason()).toBe('paused');
    sweep(h, 'i.precedence');
  });

  it('the pause is what held: lifting it lets the same configuration approve', async () => {
    // Attributability, the same way row 1 of Sc 10 proves its deny. Without
    // this the row above would pass just as well against a daemon that had
    // simply stopped working.
    const h = await armed({ rule: { scheduleId: null }, noSchedule: true });
    await post(h, '/v1/toggles/pause', { until: '1h' });
    const held = pending(h);
    expect(await auto(h, held.id)).toBe('withheld');

    expect(
      (await post(h, '/v1/toggles/pause', { until: null })).statusCode,
    ).toBe(200);
    const freed = pending(h, { body: 'after the pause was lifted' });
    expect(await auto(h, freed.id)).toBe('approved');
    // Approved, never ticked: the point is that the decision changed, not
    // that a message went out.
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'i.pause-lifted');
  });
});

/* ── (j) a revoked adapter mid-grace ───────────────────────────────────── */

describe('s6 Sc13 (j): revoking the adapter inside the grace', () => {
  it('refuses the DELETE outright while a rule still points at the adapter', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');

    const res = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/adapters/${ADAPTER}`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'adapter-referenced',
      ruleIds: [RULE_ID],
    });
    expect(h.store.getAdapter(ADAPTER)).not.toBeNull();
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'j.delete-refused');
  });

  it('denies at the re-gate when the adapter is disabled mid-grace', async () => {
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');

    const res = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/adapters/${ADAPTER}`,
      headers: h.headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(denyReasons(h, draft.id)).toEqual(['adapter-disabled']);
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'j.adapter-disabled');
  });

  it('denies at the re-gate when only the TOKEN is revoked, below the route', async () => {
    // The adapter is still enabled and still present; only its credential is
    // gone, written straight through the store rather than through any
    // surface an operator has. An auto approval is not allowed to outlive the
    // credential it was taken under.
    const h = await armed();
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    h.store.setAdapterTokenHash(ADAPTER, null, null);
    expect(h.store.getAdapter(ADAPTER)?.enabled).toBe(true);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
    expect(denyReasons(h, draft.id)).toEqual(['adapter-disabled']);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'j.token-revoked');
  });

  it('a HUMAN approval survives all three, because an adapter is not a human’s authority', async () => {
    // The asymmetry, asserted so the three rows above cannot be read as "a
    // revoked adapter stops sending". The adapter check in the re-gate is
    // guarded by `isAutoApproval`: it asks whether the MACHINE still has the
    // credential it decided under. A person who approved a draft does not
    // lose their decision because a token rotated.
    const h = await armed({ contact: 'draft-only' });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('withheld');
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.store.setAdapterTokenHash(ADAPTER, null, null);

    h.clockCtl.advance(GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(denials(h, draft.id)).toEqual([]);
    // Swept under its own name, and named again in the closing sweep. This
    // is the ONE send in the file, and leaving it out of the sweep to keep a
    // rounder number would be exactly the kind of quiet exclusion this suite
    // exists to catch.
    expect(h.backend.callCount()).toBe(1);
    sweep(h, 'j.human-approval-survives');
  });
});

/* ── (k) clock manipulation ────────────────────────────────────────────── */

describe('s6 Sc13 (k): the injected clock jumps backward two hours', () => {
  it('sends nothing, re-evaluates the window against the new now, and refunds no budget', async () => {
    // A single 11:00-12:00 window, so a two-hour rewind lands outside it.
    const h = await armed({
      startIso: T_LATE,
      schedule: {
        windows: [
          {
            days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
            start: '11:00',
            end: '12:00',
          },
        ],
      },
    });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBe(
      '2026-09-01T11:59:10.000Z',
    );
    const approvalId = mintedApprovalId(h, draft.id);

    h.clockCtl.set(T_REWOUND);
    expect(h.clockCtl.clock.now()).toBe(T_REWOUND);

    // The grace sweep selects on `send_not_before <= now`, so a deadline two
    // hours in the future is simply not elapsed. Nothing is found, nothing
    // runs, nothing is audited.
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('approved');
    expect(denials(h, draft.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);

    // Handed to the dispatcher by hand, the re-gate reads the world at the
    // REWOUND instant — which is outside the window — and F-72 takes the
    // approval back rather than sending against a schedule that says no.
    await h.dispatch(draft.id, approvalId);

    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(denyReasons(h, draft.id)).toEqual(['outside-window']);
    // The one assertion the plan names: no attempt was ever opened.
    expect(h.store.sendAttemptCount(draft.id)).toBe(0);
    expect(events(h, 'send.attempted')).toEqual([]);
    expect(h.backend.callCount()).toBe(0);

    // And the budget the approval spent at 11:59 is still spent at 09:59.
    // `sumRateCounter` bounds the window from BELOW only, so a bucket in the
    // future still counts — which is the fail-safe direction: rewinding the
    // clock cannot refund an hour's allowance. Asserted because it is a
    // property of the SQL rather than of anything named in a spec, and a
    // future upper bound would silently turn a clock rewind into free budget.
    expect(
      readGateCounters(h.store, {
        now: h.clockCtl.clock.now(),
        handle: HANDLE,
        chatGuid: CHAT,
      }).globalSentLastHour,
    ).toBe(1);
    sweep(h, 'k.clock-rewind');
  });

  it('cannot resurrect a draft the kill switch already rejected', async () => {
    const h = await armed({ startIso: T_LATE });
    const draft = pending(h);
    expect(await auto(h, draft.id)).toBe('approved');
    const approvalId = mintedApprovalId(h, draft.id);
    await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(h.store.getDraft(draft.id)?.state).toBe('rejected');

    // Rewind to before the approval was ever taken, lift the switch, and tick.
    h.clockCtl.set(T_REWOUND);
    await post(h, '/v1/toggles/kill-switch', { on: false });
    await h.scheduler.tick();
    await expect(h.dispatch(draft.id, approvalId)).rejects.toThrow(
      /is not in state 'approved'/,
    );

    expect(h.store.getDraft(draft.id)?.state).toBe('rejected');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'k.rewind-after-reject');
  });
});

/* ── the three sweeps ──────────────────────────────────────────────────── */

describe('s6 Sc13: standing negatives over every hostile session', () => {
  it('the audit hash chain still verifies across the whole hostile session', () => {
    expect(sessions.length).toBeGreaterThanOrEqual(11);
    for (const s of sessions) {
      expect(`${s.label}:${String(s.rows.length > 0)}`).toBe(`${s.label}:true`);
      expect(`${s.label}:${String(verifyChain(s.rows).ok)}`).toBe(
        `${s.label}:true`,
      );
    }
  });

  it('no row produced a reason string outside the pinned taxonomy (C-6)', () => {
    // The five s6 clamp literals plus the seven that predate them. A thirteenth
    // reason reaching an audit row fails here before it reaches an operator's
    // dashboard, which is what "the taxonomy is pinned" has to mean.
    const PINNED: readonly GateDenyReason[] = [
      'kill-switch',
      'disconnected',
      'read-only',
      'contact-denied',
      'group-auto-forbidden',
      'unapproved',
      'adapter-disabled',
      'outside-window',
      'rate-limited',
      'circuit-open',
      'loop-detected',
      'sms-auto-forbidden',
    ];
    const seen = sessions.flatMap((s) =>
      s.events
        .filter((e): e is Denial => e.type === 'gate.denied')
        .map((e) => `${s.label}:${e.reason}`),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) {
      const reason = entry.slice(entry.indexOf(':') + 1) as GateDenyReason;
      expect(entry).toBe(`${entry.slice(0, entry.indexOf(':'))}:${reason}`);
      expect(PINNED).toContain(reason);
    }
    // Stated as a negative too: the wire-level refusal vocabulary is NOT part
    // of the gate's, and row (c)'s three forbidden frames must not have leaked
    // into it.
    for (const entry of seen) {
      expect(entry).not.toContain('no-send-frame');
      expect(entry).not.toContain('protocol-violation');
    }
  });

  it('the only agent-actor Approval in the file is the one row (c) forged (INV-4)', () => {
    // Not "none anywhere": row (c) plants one on purpose, because an attacker
    // with write access to the approvals table is the threat INV-4 exists
    // for. So the claim is the exact one that matters — there is precisely
    // ONE agent-actor approval in this entire file, this file wrote it by
    // hand, and the sweep below proves it authorised nothing. A product that
    // ever minted one of its own would make this a two.
    expect(
      sessions.flatMap((s) =>
        s.approvalActors.filter((a) => a.kind === 'agent').map(() => s.label),
      ),
    ).toEqual(['c.agent-actor']);
  });

  it('SendBackend.send was called ZERO times by every attack in the file', () => {
    // The strongest claim this suite makes, asserted once, at the end, over
    // one spy. Eleven attacks, four hundred and some drafts, a flood, a
    // storm, a forged actor, a rewound clock — and not one byte left for a
    // wire.
    //
    // The exception is named here rather than omitted: row (j)'s last test
    // is a CONTROL, not an attack. It approves a draft as a human and lets
    // it go out, because without it the three (j) denials above could be
    // read as "revoking an adapter stops sending" rather than "an auto
    // approval does not outlive the credential it was taken under". Dropping
    // it from the sweep to keep a rounder number would be the softening this
    // file is supposed to refuse; so it is listed, by name, with its count.
    expect(
      sessions
        .filter((s) => s.sends !== 0)
        .map((s) => `${s.label}:${String(s.sends)}`),
    ).toEqual(['j.human-approval-survives:1']);
    expect(sessions.filter((s) => s.sends === 0).length).toBe(
      sessions.length - 1,
    );
  });
});

/**
 * s6-execution Part 2 Scenario 8 ★ CHECKPOINT — loop prevention.
 * Spec rows 1-9; §1.7 "Loop prevention (Sc 8)"; flag F-62 (autonomy history
 * is DERIVED from tables that already hold the facts — no new table, no new
 * column, no index — and "near-duplicate" means exact equality AFTER
 * normalisation, never an edit distance).
 *
 * **Two mechanisms, one word.** A runaway conversation looks like one of two
 * things: the machine answering every message in a chat forever, or the
 * machine answering with the same sentence forever. The first is counted
 * (`consecutiveAutoInChat`), the second is compared (`recentSentBodies` +
 * `normalizeBody`). Both clamp with the SAME literal, `loop-detected`,
 * because from the operator's side they are one symptom and splitting them
 * into two reasons would only mean two half-populated deny counts.
 *
 * **Why exact-after-normalisation and not similarity.** F-62 ratified this
 * deliberately. A threshold is a tunable nobody can reason about at 3am, and
 * the failure this must catch — an agent re-emitting the sentence it just
 * emitted — is exact. Normalisation (NFKC, casefold, collapse whitespace,
 * strip leading/trailing punctuation) exists so that "Sure!" and "  SURE  "
 * are the same sentence, which they are, and "Sure thing" is not, which it
 * is not. Row 5 asserts that boundary directly on the pure function rather
 * than only through the gate, because a normaliser is the kind of thing that
 * is much easier to review than to infer from four end-to-end outcomes.
 *
 * **Where a clamp is observable in THIS scenario, and what is deferred.** The
 * auto-approve path (Sc 9) does not exist yet, so "this message would have
 * auto-sent" is read exactly where Sc 5 and Sc 6 already read it: the
 * RESOLVED mode in the `draft.request` frame the adapter actually receives
 * (F-60). A loop clamp therefore shows up on the wire as `respondMode:
 * 'draft-only'`, and the reason it clamped is read off the gate's own
 * decision through `decisionAt`, which builds the same context
 * `adapters/dispatch.ts` builds, from the same store, at the same instant.
 *
 * The plan's rows 1 and 9 ask for "exactly one `gate.denied {loop-detected}`
 * row". §1.7 is explicit that a clamp is NEVER audited as `gate.denied`, so
 * every row below asserts the honest inverse — ZERO `gate.denied` rows —
 * plus the fact the plan is actually after: exactly one clamp, singular by
 * construction because `clampedBy` is one field on one else-if chain, and
 * the §1.7 order decides which cause wins.
 *
 * **The deferral, discharged (s6 Sc 10).** Every assertion below was written
 * against a re-gate that could not see a clamp, and every one of them is
 * unchanged now that it can. That is not luck: F-59's conversion is scoped
 * to an approval the MACHINE made, and this suite's traffic is either
 * clamped before any approval exists (no send, nothing to deny) or approved
 * by a person, whom a loop breaker may not veto (Sc 8 row 7). The rows that
 * DO watch a loop clamp kill a send live in `outside-window.spec.ts`, where
 * there is an auto approval to refuse. `circuit-breaker.spec.ts` recorded
 * the same deferral for the same reason and discharged it the same way.
 *
 * **The stand-in is gone (s6 Sc 9).** This suite shipped with one hand-built
 * helper, `autoApproveAndSend`, which wrote the `{kind:'system',
 * reason:'auto-respond'}` approval itself because the function that makes
 * that decision did not exist yet. Sc 9 landed `maybeAutoApprove` and wired
 * it into the mint, so the helper's entire first half became not just
 * unnecessary but WRONG: the real auto-approval now happens inside
 * `draft.submit`, before `turn()` can return, and the stand-in's
 * `pending -> approved` transition started failing with "draft is
 * 'approved'". Rather than route around the production path, the helper was
 * inverted. It is now `autoSend`, and it ASSERTS what it used to fake: the
 * draft is already approved by the time anyone looks, and the approval bears
 * the system actor. Then it does what it always did, which was never faked,
 * advance past the undo grace and let the REAL scheduler, the REAL
 * `dispatchApproved` and the REAL verify poll carry the send out.
 *
 * That inversion is worth more than the nine call sites it touches: every
 * `consecutiveAutoInChat` count and every `recentSentBodies` entry this
 * suite measures is now produced by the code that will produce them in the
 * field, so Sc 8's loop defences are being fed by Sc 9's autonomy rather
 * than by a test's impression of it.
 *
 * Every cap and limit this suite moves is written visibly in the test body or
 * in a helper named at its call site (F-66 — a raise that is invisible in
 * review is a cap nobody is enforcing). Three auto sends to one handle would
 * otherwise trip `send.capContactPer2Min` long before any streak reached
 * three, and a rate clamp standing in for a loop clamp would make this whole
 * suite prove the wrong thing.
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AuditEvent,
  ChatGuid,
  Draft,
  GateDecision,
  Handle,
  Message,
  Rule,
} from '@wemessage/core';
import {
  evaluateGate,
  evaluateRules,
  normalizeBody,
  readGateCounters,
  readGateSettings,
  readLoopCandidate,
  readLoopLimits,
  DEFAULT_LOOP_LIMITS,
  LOOP_STREAK_RESET_MS,
  SETTING_CAP_CONTACT_PER_2MIN,
  SETTING_CAP_CONTACT_PER_HOUR,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_CIRCUIT_OPENED_AT,
  SETTING_GLOBAL_MODE,
  SETTING_LOOP_CONSECUTIVE_AUTO_MAX,
  SETTING_LOOP_DUPLICATE_LOOKBACK,
} from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
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
/** A second 1:1 conversation, so "per chat" can mean something (row 4). */
const HANDLE_B: Handle = '+15557654321';
const CHAT_B: ChatGuid = 'iMessage;-;+15557654321';
/** `DEFAULT_UNDO_GRACE_SECONDS` (routes/drafts.ts) in ms; F-78 gives autonomy
 *  a real grace rather than zero, and `send.autoGraceSeconds` defaults to the
 *  operator's own, so one constant covers both paths in this suite. */
const GRACE_MS = 10_000;

function makeRule(): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    // Rule, contact and global mode all say auto, so a 'draft-only' below can
    // only ever be a CLAMP — never a narrow scope in the §2.4.3 ladder.
    respondMode: 'auto',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 45,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
  };
}

let guidSeq = 0;
function inbound(
  at: string,
  opts: { chatGuid?: ChatGuid; handle?: Handle; isFromMe?: boolean } = {},
): Message {
  guidSeq += 1;
  return {
    guid: `GUID-LOOP-${String(guidSeq)}`,
    sourceRowid: 5_000 + guidSeq,
    chatGuid: opts.chatGuid ?? CHAT,
    handle: opts.handle ?? HANDLE,
    isFromMe: opts.isFromMe ?? false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'tacos tonight?',
    attachments: [],
    sentAt: at,
    receivedAt: at,
  };
}

/** The daemon's `deliver` in miniature — mirror, broadcast, then match. */
function deliverer(h: AgentHarness): (message: Message) => Promise<void> {
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
    // Without this the correlation is never TRACKED, and every `draft.submit`
    // below would be refused as a forged one — the S5 Sc 7 wiring, not an
    // optional extra.
    issueRequest: (req) => h.server.agentRequests?.issue(req),
  });
  return async (message: Message): Promise<void> => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

interface RequestFrame {
  type: string;
  payload: { rule: { respondMode: string }; correlation: unknown };
}

function requests(sock: FakeAdapterSocket): RequestFrame[] {
  return (sock.frames as RequestFrame[]).filter(
    (f) => f.type === 'draft.request',
  );
}

function auditOf(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function approve(h: Harness, draftId: string) {
  return post(h, `/v1/drafts/${draftId}/approve`);
}

/**
 * Three auto sends to one handle saturate `send.capContactPer2Min` (default
 * 1) several times over, and a rate clamp firing first would make every row
 * in this suite prove Sc 6's point instead of Sc 8's. Raised here, by name,
 * at every call site (F-66): visible in review, no NODE_ENV branch, no
 * test-only bypass inside the production reader.
 */
function capsOutOfTheWay(h: Harness): void {
  h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '100');
  h.store.setSetting(SETTING_CAP_CONTACT_PER_HOUR, '100');
  h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '100');
}

/**
 * The other half of the same discipline, for the duplicate rows: raise the
 * STREAK limit so the only thing that can clamp is the body comparison. Six
 * auto sends in one chat is a streak of six, and a streak clamp standing in
 * for a duplicate clamp would be the same mistake in the other direction.
 */
function streakOutOfTheWay(h: Harness): void {
  h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, '100');
}

interface Armed {
  h: AgentHarness;
  sock: FakeAdapterSocket;
  deliver: (message: Message) => Promise<void>;
}

/**
 * Boot + a connected adapter + a fully-`auto` three-scope ladder for BOTH
 * conversations. Chat B is set up identically to chat A on purpose: row 4's
 * claim is that the STREAK is per chat, and the only way that claim means
 * anything is if nothing else about the two chats differs.
 */
async function armed(): Promise<Armed> {
  const h = await bootAgent();
  const cred = await addAdapter(h, ADAPTER);
  const sock = await connectAuthed(h, cred);
  h.store.insertRule(makeRule());
  h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
  h.store.setContactPolicy({ handle: HANDLE_B, mode: 'auto', updatedAt: T0 });
  h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
  const handleB = h.fixture.addHandle(HANDLE_B);
  h.fixture.addChat({ identifier: HANDLE_B, handleIds: [handleB] });
  return { h, sock, deliver: deliverer(h) };
}

interface Turn {
  /** The RESOLVED mode the adapter was told: 'draft-only' here IS the clamp. */
  mode: string;
  draft: Draft;
}

function pendingWithBody(h: Harness, body: string): Draft | undefined {
  return h.store.listDrafts().find((d) => d.body === body);
}

/**
 * One full round trip: an inbound arrives, the gate resolves a mode, the
 * adapter is asked, and the adapter answers. Every step is the real one.
 */
async function turn(
  a: Armed,
  body: string,
  opts: { chatGuid?: ChatGuid; handle?: Handle } = {},
): Promise<Turn> {
  const before = requests(a.sock).length;
  await a.deliver(inbound(a.h.clockCtl.clock.now(), opts));
  await waitUntil(
    () => requests(a.sock).length > before,
    `draft.request for "${body}"`,
  );
  const frame = requests(a.sock)[before] as RequestFrame;
  a.sock.sendFrame('draft.submit', {
    correlation: frame.payload.correlation,
    idempotencyKey: `idem-${body}`,
    body,
  });
  await waitUntil(
    () => pendingWithBody(a.h, body) !== undefined,
    `pending draft "${body}"`,
  );
  return {
    mode: frame.payload.rule.respondMode,
    draft: pendingWithBody(a.h, body) as Draft,
  };
}

/**
 * The auto path, end to end and entirely real (s6 Sc 9) — see the header.
 *
 * Nothing here decides anything. `maybeAutoApprove` already ran, inside the
 * mint, in the same turn as the `draft.submit` frame, which is why the two
 * assertions at the top are safe to make without waiting: by the time
 * `turn()` observed the draft row at all, the decision behind it had already
 * been written. Both are asserted at every call site on purpose. A row that
 * expects an auto SEND is only measuring what it thinks it is if the send was
 * auto-DECIDED, and a suite about runaway autonomy would be hollow if its
 * "machine turns" had quietly become human ones.
 *
 * The auto grace is `send.autoGraceSeconds`, which defaults to
 * `send.undoGraceSeconds` (F-78), so `GRACE_MS` remains the right advance.
 */
async function autoSend(h: Harness, draftId: string): Promise<void> {
  expect(h.store.getDraft(draftId)?.state, 'auto-approved at the mint').toBe(
    'approved',
  );
  expect(h.store.listApprovals(draftId).map((a) => a.actor)).toEqual([
    { kind: 'system', reason: 'auto-respond' },
  ]);
  h.clockCtl.advance(GRACE_MS);
  await h.scheduler.tick();
  expect(h.store.getDraft(draftId)?.state).toBe('sent');
}

/** A human deciding, through the real route and the real scheduler. */
async function humanApproveAndSend(h: Harness, draftId: string): Promise<void> {
  expect((await approve(h, draftId)).statusCode).toBe(200);
  h.clockCtl.advance(GRACE_MS);
  await h.scheduler.tick();
  expect(h.store.getDraft(draftId)?.state).toBe('sent');
}

/** The gate's own counters, read exactly where dispatch.ts reads them. */
function counters(
  h: Harness,
  opts: { chatGuid?: ChatGuid; handle?: Handle } = {},
): ReturnType<typeof readGateCounters> {
  return readGateCounters(h.store, {
    now: h.clockCtl.clock.now(),
    handle: opts.handle ?? HANDLE,
    chatGuid: opts.chatGuid ?? CHAT,
  });
}

/**
 * The whole decision, built from the same store, the same instant and the
 * same shape `adapters/dispatch.ts` builds at the draft moment. `candidate`
 * is the one field dispatch cannot populate — at the inbound moment there is
 * no draft body yet to compare — so it is supplied here exactly as Sc 9's
 * auto path will supply it, through the production reader.
 */
function decisionAt(
  h: Harness,
  opts: {
    chatGuid?: ChatGuid;
    handle?: Handle;
    rule?: Rule | null;
    candidateBody?: string;
  } = {},
): GateDecision {
  const chatGuid = opts.chatGuid ?? CHAT;
  const handle = opts.handle ?? HANDLE;
  const now = h.clockCtl.clock.now();
  return evaluateGate({
    now,
    settings: readGateSettings(h.store),
    rule: opts.rule === undefined ? makeRule() : opts.rule,
    schedule: null,
    contact: h.store.getContactPolicy(handle),
    message: { isGroup: false, service: 'imessage', handle, chatGuid },
    counters: readGateCounters(h.store, { now, handle, chatGuid }),
    ...(opts.candidateBody === undefined
      ? {}
      : {
          candidate: readLoopCandidate(h.store, {
            chatGuid,
            body: opts.candidateBody,
          }),
        }),
  });
}

/** Three machine turns in chat A, distinct bodies, no cap in the way. */
async function threeAutoTurns(a: Armed): Promise<void> {
  capsOutOfTheWay(a.h);
  for (let i = 1; i <= 3; i += 1) {
    const t = await turn(a, `reply ${String(i)}`);
    expect(t.mode, `turn ${String(i)}`).toBe('auto');
    await autoSend(a.h, t.draft.id);
  }
}

// --- RED row 1 (the teeth row, TN-loop-off) --------------------------------

describe('s6 Sc8 row 1: the consecutive-auto streak', () => {
  it('consecutive-auto trips at 3', async () => {
    const a = await armed();
    // The shipped default, asserted rather than set: this row is what pins it.
    expect(readLoopLimits(a.h.store).consecutiveAutoMax).toBe(3);

    await threeAutoTurns(a);

    // The fourth. A counterpart replying instantly, three machine turns
    // behind it, in the same chat: autonomy is withheld and the message still
    // gets a draft a human can look at.
    const fourth = await turn(a, 'reply 4');
    expect(fourth.mode).toBe('draft-only');
    expect(a.h.store.getDraft(fourth.draft.id)?.state).toBe('pending');
    expect(decisionAt(a.h)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });

    // A clamp is not a denial (§1.7). Sc 10 gave the send-moment re-gate
    // the context to convert this one into `gate.denied {loop-detected}`,
    // and it still does not fire here: the fourth draft was never approved,
    // so there is no send to refuse and nobody to refuse it to.
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
    // Three sends attempted, three verified, and the fourth never reached the
    // backend at all because nobody approved it.
    expect(a.h.backend.callCount()).toBe(3);
  });

  it('the streak reads exactly the run of machine turns behind it', async () => {
    const a = await armed();
    capsOutOfTheWay(a.h);
    expect(counters(a.h).consecutiveAutoInChat).toBe(0);
    for (let i = 1; i <= 3; i += 1) {
      const t = await turn(a, `reply ${String(i)}`);
      await autoSend(a.h, t.draft.id);
      expect(counters(a.h).consecutiveAutoInChat, `after ${String(i)}`).toBe(i);
    }
    // Derived, not stored (F-62): nothing was written to hold this number.
    // The count is a walk over `drafts` and `approvals`, which is why the
    // schema this scenario ships is the schema it inherited.
    //
    // `sql IS NOT NULL` is load-bearing — it filters out the implicit
    // `sqlite_autoindex_*` entries SQLite creates for every TEXT primary key
    // and UNIQUE constraint in `0001_init.sql`. Thirteen of those predate
    // this slice, so a name match alone would have caught them and proved
    // nothing about what we added.
    const declared = a.h.store.db
      .prepare('SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL')
      .all() as { type: string; name: string }[];
    // C-8: this repo ships zero indexes, and a derived counter does not get
    // to be the first one. An index here would be the tell that somebody
    // decided the walk was too slow and reached for schema instead of for
    // the bound.
    expect(declared.filter((o) => o.type === 'index')).toEqual([]);
    // And nothing exists to HOLD a streak, a lookback or a send history.
    expect(
      declared.filter((o) => /loop|streak|consecutive|history/iu.test(o.name)),
    ).toEqual([]);
  });
});

// --- RED row 2 -------------------------------------------------------------

describe('s6 Sc8 row 2: a human approval resets the streak', () => {
  it('breaks the run, and the next machine turn starts again at 1', async () => {
    const a = await armed();
    await threeAutoTurns(a);
    const fourth = await turn(a, 'reply 4');
    expect(fourth.mode).toBe('draft-only');

    // A person decides. Not a reset switch, not a counter being cleared: the
    // run of system approvals simply stops at the row a human wrote, which is
    // why nothing has to remember to reset anything.
    await humanApproveAndSend(a.h, fourth.draft.id);
    expect(counters(a.h).consecutiveAutoInChat).toBe(0);

    const fifth = await turn(a, 'reply 5');
    expect(fifth.mode).toBe('auto');
    await autoSend(a.h, fifth.draft.id);
    // One, rather than four. The streak is the LEADING run, newest first.
    expect(counters(a.h).consecutiveAutoInChat).toBe(1);
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
  });
});

// --- RED row 3 -------------------------------------------------------------

describe('s6 Sc8 row 3: a 30-second inbound pause resets the streak', () => {
  it('clamps at 29 and at 30, and lets the fourth through at 31', async () => {
    const a = await armed();
    // F-62's ratified reading of §2.4.3, pinned as a constant so the boundary
    // is one number in one place rather than a literal in three tests.
    expect(LOOP_STREAK_RESET_MS).toBe(30_000);
    await threeAutoTurns(a);

    // 29 seconds after the last verified auto send: still a storm.
    a.h.clockCtl.advance(29_000);
    expect(counters(a.h).consecutiveAutoInChat).toBe(3);
    expect(decisionAt(a.h)).toMatchObject({ clampedBy: 'loop-detected' });

    // Exactly 30. "More than 30 seconds" is strict, so this is still a storm:
    // the boundary belongs to the clamp, which is the fail-closed reading.
    a.h.clockCtl.advance(1_000);
    expect(counters(a.h).consecutiveAutoInChat).toBe(3);
    expect(decisionAt(a.h)).toMatchObject({ clampedBy: 'loop-detected' });

    // 31. Bots reply instantly and people pause; a pause is the signal that
    // separates a conversation from a runaway.
    a.h.clockCtl.advance(1_000);
    expect(counters(a.h).consecutiveAutoInChat).toBe(0);
    expect(decisionAt(a.h)).toEqual({ allow: true, mode: 'auto' });

    const fourth = await turn(a, 'reply 4');
    expect(fourth.mode).toBe('auto');
    await autoSend(a.h, fourth.draft.id);
    // And the reset is a reset, not an erasure: the run behind this send is
    // four long in the table and reads as four again, because the gap that
    // suppressed it has now been closed by a fresh auto send.
    expect(counters(a.h).consecutiveAutoInChat).toBe(4);
  });
});

// --- RED row 4 -------------------------------------------------------------

describe('s6 Sc8 row 4: the streak is per chat', () => {
  it('three autos in chat A do not clamp chat B', async () => {
    const a = await armed();
    await threeAutoTurns(a);

    expect(counters(a.h).consecutiveAutoInChat).toBe(3);
    expect(
      counters(a.h, { chatGuid: CHAT_B, handle: HANDLE_B })
        .consecutiveAutoInChat,
    ).toBe(0);
    expect(decisionAt(a.h, { chatGuid: CHAT_B, handle: HANDLE_B })).toEqual({
      allow: true,
      mode: 'auto',
    });

    // On the wire, which is the only place it counts: the second
    // conversation is still autonomous while the first is clamped.
    const other = await turn(a, 'other reply', {
      chatGuid: CHAT_B,
      handle: HANDLE_B,
    });
    expect(other.mode).toBe('auto');
    expect(decisionAt(a.h)).toMatchObject({ clampedBy: 'loop-detected' });
  });
});

// --- RED row 5 (the second teeth row: normalised vs raw equality) ----------

describe('s6 Sc8 row 5: near-duplicate denial', () => {
  it('normalisation collapses case, whitespace and trailing punctuation', () => {
    // Asserted on the pure function, not inferred from four end-to-end
    // outcomes: a normaliser is much easier to review than to reverse.
    for (const variant of ['Sure!', 'sure', '  SURE  ', 'Sure.', 'SURE!!!']) {
      expect(normalizeBody(variant), variant).toBe('sure');
    }
    expect(normalizeBody('Sure thing')).toBe('sure thing');
    expect(normalizeBody('on   my\n\tway')).toBe('on my way');
    // Interior punctuation is content, not decoration.
    expect(normalizeBody("I'll be there")).toBe("i'll be there");
    // NFKC, so a full-width compatibility form is the same sentence.
    expect(normalizeBody('Ｓｕｒｅ')).toBe('sure');
    // Nothing but punctuation normalises to nothing, and nothing must never
    // collide with anything: an empty candidate is not a duplicate.
    expect(normalizeBody('...')).toBe('');
  });

  it('a normalised duplicate of something we just sent clamps loop-detected', async () => {
    const a = await armed();
    capsOutOfTheWay(a.h);
    // Only the BODY comparison may clamp here (F-66's discipline, applied to
    // the other half of this scenario).
    streakOutOfTheWay(a.h);

    const sent = await turn(a, 'Sure!');
    await autoSend(a.h, sent.draft.id);
    expect(a.h.store.recentSentBodies(CHAT, 5)).toEqual(['Sure!']);

    for (const collides of ['sure', '  SURE  ', 'Sure.', 'Sure!']) {
      expect(decisionAt(a.h, { candidateBody: collides }), collides).toEqual({
        allow: true,
        mode: 'draft-only',
        clampedBy: 'loop-detected',
      });
    }
    // A different sentence is a different sentence. Exact-after-normalisation,
    // never a similarity threshold (F-62): "Sure thing" shares four fifths of
    // its characters with "Sure!" and is not a repeat of it.
    expect(decisionAt(a.h, { candidateBody: 'Sure thing' })).toEqual({
      allow: true,
      mode: 'auto',
    });
    // And a candidate nobody supplied cannot clamp: at the inbound moment
    // there is no draft body yet, which is why `candidate` is optional.
    expect(decisionAt(a.h)).toEqual({ allow: true, mode: 'auto' });
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
  });

  it('a body we did not send does not collide with one we did', async () => {
    const a = await armed();
    capsOutOfTheWay(a.h);
    streakOutOfTheWay(a.h);
    const sent = await turn(a, 'Sure!');
    await autoSend(a.h, sent.draft.id);
    // The lookback is bodies WE SENT, not messages in the chat: the inbound
    // that triggered all of this is in `inbound_messages` with its own text
    // and is not a candidate for comparison.
    expect(a.h.store.recentSentBodies(CHAT, 5)).toEqual(['Sure!']);
    expect(decisionAt(a.h, { candidateBody: 'tacos tonight?' })).toEqual({
      allow: true,
      mode: 'auto',
    });
    // Nor are bodies we sent in a DIFFERENT chat.
    expect(a.h.store.recentSentBodies(CHAT_B, 5)).toEqual([]);
    expect(
      decisionAt(a.h, {
        chatGuid: CHAT_B,
        handle: HANDLE_B,
        candidateBody: 'Sure!',
      }),
    ).toEqual({ allow: true, mode: 'auto' });
  });
});

// --- RED row 6 -------------------------------------------------------------

describe('s6 Sc8 row 6: the lookback is exactly five', () => {
  it('the fifth-most-recent send collides and the sixth does not', async () => {
    const a = await armed();
    capsOutOfTheWay(a.h);
    streakOutOfTheWay(a.h);
    // The shipped default, asserted rather than set.
    expect(readLoopLimits(a.h.store).duplicateLookback).toBe(5);
    expect(DEFAULT_LOOP_LIMITS).toEqual({
      consecutiveAutoMax: 3,
      duplicateLookback: 5,
    });

    for (let i = 1; i <= 6; i += 1) {
      const t = await turn(a, `body ${String(i)}`);
      await autoSend(a.h, t.draft.id);
    }
    // Newest first, and exactly five of them.
    expect(a.h.store.recentSentBodies(CHAT, 5)).toEqual([
      'body 6',
      'body 5',
      'body 4',
      'body 3',
      'body 2',
    ]);

    // The fifth-most-recent is still inside the window.
    expect(decisionAt(a.h, { candidateBody: 'BODY 2!' })).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });
    // The sixth has fallen out of it. A bounded lookback is a bound: an agent
    // that has said six different things is having a conversation.
    expect(decisionAt(a.h, { candidateBody: 'body 1' })).toEqual({
      allow: true,
      mode: 'auto',
    });

    // The lookback is an operator setting, and raising it is a real raise.
    a.h.store.setSetting(SETTING_LOOP_DUPLICATE_LOOKBACK, '6');
    expect(readLoopLimits(a.h.store).duplicateLookback).toBe(6);
    expect(decisionAt(a.h, { candidateBody: 'body 1' })).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });
  });

  it('zero and negative values can never disable either loop limit', async () => {
    const a = await armed();
    for (const value of ['0', '-5', '-1000000']) {
      a.h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, value);
      a.h.store.setSetting(SETTING_LOOP_DUPLICATE_LOOKBACK, value);
      expect(readLoopLimits(a.h.store), value).toEqual({
        consecutiveAutoMax: 1,
        duplicateLookback: 1,
      });
    }
    // Unparseable falls back to the DEFAULT rather than to the floor, exactly
    // as the caps do: an unreadable setting means nobody set this.
    for (const value of ['', 'off', 'Infinity', 'NaN', '1e3', '7.5', ' 5 ']) {
      a.h.store.setSetting(SETTING_LOOP_CONSECUTIVE_AUTO_MAX, value);
      a.h.store.setSetting(SETTING_LOOP_DUPLICATE_LOOKBACK, value);
      expect(readLoopLimits(a.h.store), value).toEqual(DEFAULT_LOOP_LIMITS);
    }
  });
});

// --- RED row 7 -------------------------------------------------------------

describe('s6 Sc8 row 7: both mechanisms are advisory to autonomy only', () => {
  it('a human may approve the draft a streak clamp produced', async () => {
    const a = await armed();
    await threeAutoTurns(a);
    const fourth = await turn(a, 'reply 4');
    expect(fourth.mode).toBe('draft-only');
    expect(decisionAt(a.h)).toMatchObject({ clampedBy: 'loop-detected' });

    // A loop breaker that vetoes a person is a bug. The clamp withholds
    // AUTONOMY; it does not stand between an operator and their own keyboard.
    const res = await approve(a.h, fourth.draft.id);
    expect(res.statusCode).toBe(200);
    a.h.clockCtl.advance(GRACE_MS);
    await a.h.scheduler.tick();
    expect(a.h.store.getDraft(fourth.draft.id)?.state).toBe('sent');
    expect(a.h.backend.calls().map((c) => c.body)).toContain('reply 4');
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
  });

  it('a human may approve a word-for-word duplicate', async () => {
    const a = await armed();
    capsOutOfTheWay(a.h);
    streakOutOfTheWay(a.h);
    const sent = await turn(a, 'Sure!');
    await autoSend(a.h, sent.draft.id);
    // The machine would be stopped here...
    expect(decisionAt(a.h, { candidateBody: '  SURE  ' })).toMatchObject({
      clampedBy: 'loop-detected',
    });

    // ...and a person is not. Repetition is a human prerogative.
    const again = await turn(a, '  SURE  ');
    const res = await approve(a.h, again.draft.id);
    expect(res.statusCode).toBe(200);
    a.h.clockCtl.advance(GRACE_MS);
    await a.h.scheduler.tick();
    expect(a.h.store.getDraft(again.draft.id)?.state).toBe('sent');
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
  });
});

// --- RED row 8 -------------------------------------------------------------

describe('s6 Sc8 row 8: INV-6, the loop defence that shipped in S2', () => {
  it('isFromMe never matches a rule, so our own sends cannot re-enter', async () => {
    const a = await armed();
    await threeAutoTurns(a);
    const before = requests(a.sock).length;
    const matchedBefore = auditOf(a.h, 'rule.matched').length;

    // The exact text of something we just sent, arriving back through ingest
    // as our own message. This is the shape a real loop takes, and the first
    // line of defence has never been the gate: it is rule eligibility.
    await a.deliver(inbound(a.h.clockCtl.clock.now(), { isFromMe: true }));
    expect(requests(a.sock).length).toBe(before);
    expect(auditOf(a.h, 'rule.matched').length).toBe(matchedBefore);

    // And the same claim at the layer that makes it, where it cannot be an
    // accident of ordering somewhere in the daemon.
    const mine = inbound(T0, { isFromMe: true });
    expect(
      evaluateRules([makeRule()], mine, { hasDraftForMessage: () => false }),
    ).toEqual([]);
    const theirs = { ...mine, isFromMe: false };
    expect(
      evaluateRules([makeRule()], theirs, {
        hasDraftForMessage: () => false,
      }).map((r) => r.id),
    ).toEqual([RULE_ID]);
  });
});

// --- RED row 9 -------------------------------------------------------------

describe('s6 Sc8 row 9: composed — the §1.7 step-7 order, asserted', () => {
  it('one clamp at a time, and the first cause in order is the one recorded', async () => {
    const a = await armed();
    await threeAutoTurns(a);
    // The streak alone, as the baseline every line below is measured against.
    expect(decisionAt(a.h)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });

    // Sc 6 re-asserted, and composed: pacing is saturated three times over by
    // the sends the streak is counting, so BOTH conditions are true of the
    // same message. Rate precedes loop in §1.7, and an operator told
    // "rate-limited" when the real cause was a runaway would be sent to the
    // wrong knob, so the order is the assertion.
    a.h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '1');
    expect(counters(a.h).contactAutoLast2Min).toBeGreaterThanOrEqual(1);
    expect(counters(a.h).consecutiveAutoInChat).toBe(3);
    expect(decisionAt(a.h)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'rate-limited',
    });

    // Sc 7 re-asserted, and composed the same way: circuit precedes loop.
    capsOutOfTheWay(a.h);
    a.h.store.setSetting(SETTING_CIRCUIT_OPENED_AT, a.h.clockCtl.clock.now());
    expect(counters(a.h).circuitOpen).toBe(true);
    expect(decisionAt(a.h)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'circuit-open',
    });

    // And rate precedes circuit, which precedes loop: three true conditions,
    // one recorded cause.
    a.h.store.setSetting(SETTING_CAP_CONTACT_PER_2MIN, '1');
    expect(decisionAt(a.h)).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'rate-limited',
    });

    // The schedule outranks all three (§1.7 step 7, first branch). A rule
    // pointing at a schedule row that is not there is fail-closed by §2.4.2,
    // which is the cheapest way to hold a shut window steady.
    const shut = { ...makeRule(), scheduleId: `${'0'.repeat(24)}S1` };
    expect(decisionAt(a.h, { rule: shut })).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });

    // Nothing in that whole narrative was DENIED. Four causes, four clamps,
    // one `clampedBy` field, and no `gate.denied` row — because a clamp is
    // not a denial, and the send-moment conversion Sc 10 added (F-59) needs
    // an auto approval to act on. None of these drafts ever got one.
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
  });

  it('a duplicate and a streak are still one clamp with one reason', async () => {
    const a = await armed();
    capsOutOfTheWay(a.h);
    // Three identical sends: the streak is at 3 AND the body is a repeat, so
    // both halves of the loop breaker fire on the same message. They share a
    // literal on purpose (§1.7), so there is exactly one thing to record.
    for (let i = 1; i <= 3; i += 1) {
      const t = await turn(a, `same ${String(i)}`);
      await autoSend(a.h, t.draft.id);
    }
    const decision = decisionAt(a.h, { candidateBody: 'SAME 3!' });
    expect(decision).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'loop-detected',
    });
    expect(auditOf(a.h, 'gate.denied')).toEqual([]);
  });
});

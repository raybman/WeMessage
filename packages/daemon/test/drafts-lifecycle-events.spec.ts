/**
 * s8-execution Scenario 3 — the four owed lifecycle frames actually leave.
 *
 * Sc 2 declared `draft.expired`, `draft.superseded`, `draft.redrafted` and
 * `draft.requeued` in `@wemessage/protocol` and wrote the debt down by hand
 * in `UNEMITTED_WS_EVENTS`. This scenario pays it. Every row here exists
 * because a GUI watches the queue instead of polling it, and a queue whose
 * cards can vanish (expiry), be replaced (supersede), be rewritten (redraft)
 * or come back (requeue) with no frame for any of it is a screen that lies
 * between refreshes.
 *
 * Three properties are load-bearing across the whole file.
 *
 * **§1.8, per site, not once.** Each of the four emit sites gets its own row
 * asserting that the audit row was ALREADY DURABLE when the frame went out.
 * The harness records `auditAtBroadcast` — the audit log as it stood at the
 * instant `sink.broadcast` was called — which is the only way a test can tell
 * "appended then broadcast" from "broadcast then appended". The finished log
 * is identical either way; the difference shows up only as a lost record on a
 * crash between the two, and only under load. A single generic row would pass
 * with three of the four sites inverted.
 *
 * **`draft.requeued` is CORE-originated and must not teach core about the
 * wire (INV-1).** `packages/core`'s `dispatchApproved` writes both the
 * `draft.requeued` and the `gate.denied` audit row and returns
 * `{outcome:'requeued', reason}`. It holds no sink and imports no protocol,
 * and that is not negotiable. So the frame is constructed on the DAEMON side,
 * in `scheduler.ts`, from the outcome the core call already returned —
 * exactly the pattern `adapters/feedback.ts`'s `observeDispatch` established
 * for `draft.feedback` and `routes/send.ts` uses inline for `draft.sent` and
 * `draft.failed`. No new channel, and §1.8 holds for free because core has
 * written both rows before it returns.
 *
 * **A clamp is not a deny.** Row 7's `clampedBy` is the same `GateDenyReason`
 * union the audit trail uses (C-6), carried to the live frame and nowhere
 * else: F-108 is explicit that nothing persists it. The gate decision is made
 * in `adapters/dispatch.ts` at the INBOUND moment and the `draft.created`
 * frame is built in `adapters/submit.ts` after an agent round trip, so the
 * reason travels on the in-process issued-request registry — which is
 * live-only by construction and dies with the daemon, which is the property
 * F-108 asks for rather than a compromise with it.
 *
 * Handles are synthetic (`+1555…`); no real content anywhere in this file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import {
  maybeAutoApprove,
  parseChatGuid as coreParseChatGuid,
  SETTING_CAP_GLOBAL_PER_HOUR,
  SETTING_GLOBAL_MODE,
  type AuditEvent,
  type Draft,
  type Message,
  type Rule,
  type Ulid,
} from '@wemessage/core';
import { parseChatGuid as clientParseChatGuid } from '@wemessage/client';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
  boot,
  createDraft,
  get,
  post,
  CHAT,
  HANDLE,
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

// `cleanupAgentHarness` drains the adapter sockets and then calls
// `cleanupHarness`, so one hook covers the rows that never open a socket too.
afterEach(cleanupAgentHarness);

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
/** Comfortably past the route's 240-minute default TTL. */
const PAST_TTL_MS = 241 * 60_000;
/** Comfortably past the 10s default undo/auto grace. */
const PAST_GRACE_MS = 11_000;

const newUlid = monotonicFactory();

interface Frame {
  event: string;
  [k: string]: unknown;
}

interface Recorded {
  frame: Frame;
  auditAtBroadcast: string[];
}

/** Every broadcast of one event name, with the audit log as it then stood. */
function framesOf(h: Harness, event: string): Recorded[] {
  return h.broadcasts
    .map((b) => ({
      frame: b.frame as Frame,
      auditAtBroadcast: b.auditAtBroadcast,
    }))
    .filter((b) => b.frame.event === event);
}

function events(h: Harness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function makeRule(over: Partial<Rule> = {}): Rule {
  return {
    id: RULE_ID,
    name: 'tacos',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: ADAPTER,
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 240,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

let seq = 0;

function inbound(h: Harness, over: Partial<Message> = {}): Message {
  seq += 1;
  const at = h.clockCtl.clock.now();
  return {
    guid: `GUID-SC3-${String(seq)}`,
    sourceRowid: 20_000 + seq,
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
}

/** The Sc 6 inbound pipeline in miniature, wired to the request registry. */
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
    issueRequest: (req) => h.server.agentRequests?.issue(req),
  });
  return async (message: Message): Promise<void> => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

interface Correlation {
  requestId: string;
  chatGuid: string;
  inboundGuid?: string;
}

/**
 * Boot, register + connect an adapter, deliver one matching inbound, and hand
 * back the correlation the gateway issued for it.
 *
 * `prepare` runs after the rule and the contact policy exist but strictly
 * BEFORE the inbound is delivered, which matters more than it looks: the gate
 * decision this scenario is about is taken at the inbound moment, so a row
 * that saturated a cap afterwards would be arranging the world after the
 * decision it wanted to change had already been made.
 */
async function armedAgent(
  prepare: (h: AgentHarness) => Promise<void> | void = () => {},
): Promise<{
  h: AgentHarness;
  sock: FakeAdapterSocket;
  correlation: Correlation;
}> {
  const h = await bootAgent();
  const cred = await addAdapter(h, ADAPTER);
  h.store.insertRule(makeRule());
  h.store.setContactPolicy({
    handle: HANDLE,
    mode: 'draft-only',
    updatedAt: T0,
  });
  await prepare(h);
  const sock = await connectAuthed(h, cred);
  await deliverer(h)(inbound(h));
  await sock.waitFor(1);
  const frame = sock.frames[0] as {
    type: string;
    payload: { correlation: Correlation };
  };
  expect(frame.type).toBe('draft.request');
  return { h, sock, correlation: frame.payload.correlation };
}

// ---------------------------------------------------------------------------
// RED row 1 — the TTL sweep
// ---------------------------------------------------------------------------

describe('s8 Sc3 row 1: the TTL sweep broadcasts draft.expired', () => {
  it('one frame {draftId}, and its audit row was already durable (§1.8)', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'nobody looked');

    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('expired');

    const expired = framesOf(h, 'draft.expired');
    expect(expired).toHaveLength(1);
    // §1.6's shape exactly: no reason, no state, no draft summary. An expiry
    // is the absence of a decision, and the id is the whole of the news.
    expect(expired[0]?.frame).toEqual({
      event: 'draft.expired',
      draftId: draft.id,
    });

    // §1.8 for THIS site. The witness is the audit log as it stood at the
    // instant broadcast was called: the row is in it, so the append ran
    // first. Swapping the two lines leaves the finished log identical and
    // fails only here.
    expect(expired[0]?.auditAtBroadcast).toContain('draft.expired');
  });

  it('a draft approved in time expires nothing and says nothing', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'approved just in time');
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );

    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();

    // The sweep selects `pending` only, so an approved draft is not its
    // business — and a frame here would tell a GUI to grey out a card that
    // has already gone out the door.
    expect(framesOf(h, 'draft.expired')).toEqual([]);
    expect(events(h, 'draft.expired')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED row 2 — redraft
// ---------------------------------------------------------------------------

describe('s8 Sc3 row 2: redraft broadcasts draft.redrafted then draft.created', () => {
  it('both frames in that order, both after BOTH audit rows (§1.8)', async () => {
    const h = await boot();
    const source = await createDraft(h, 'quiet lifecycle');
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();

    const before = h.broadcasts.length;
    const res = await post(h, `/v1/drafts/${source.id}/redraft`);
    expect(res.statusCode).toBe(200);
    const newId = (res.json() as { draft: Draft }).draft.id;

    const after: Recorded[] = h.broadcasts.slice(before).map((b) => ({
      frame: b.frame as Frame,
      auditAtBroadcast: b.auditAtBroadcast,
    }));
    // The order matters to a renderer: told about the replacement first, a
    // GUI can animate one card into the other. Told about the new card
    // first, it draws a duplicate and then removes one of the two at random.
    expect(after.map((b) => b.frame.event)).toEqual([
      'draft.redrafted',
      'draft.created',
    ]);
    // The frame says `newDraftId`; the audit row says `fromDraftId` and
    // `toDraftId`. Sc 2 chose that difference deliberately — a ledger entry
    // has two equal ids and no subject, a frame is addressed at a card on a
    // screen — and this row is where the daemon is held to both spellings.
    expect(after[0]?.frame).toEqual({
      event: 'draft.redrafted',
      draftId: source.id,
      newDraftId: newId,
    });
    expect((after[1]?.frame.draft as { id: string }).id).toBe(newId);

    // §1.8 for THIS site, and for both frames: the redraft's own row AND the
    // new draft's creation row are durable before either frame leaves. The
    // second `draft.created` audit row is the redraft's own.
    for (const b of after) {
      expect(b.auditAtBroadcast).toContain('draft.redrafted');
      expect(
        b.auditAtBroadcast.filter((t) => t === 'draft.created'),
      ).toHaveLength(2);
    }
  });

  it('a refused redraft broadcasts nothing at all', async () => {
    const h = await boot();
    const source = await createDraft(h, 'still pending');
    const before = h.broadcasts.length;

    // REDRAFTABLE is terminal-and-unsent; a pending draft is neither.
    expect((await post(h, `/v1/drafts/${source.id}/redraft`)).statusCode).toBe(
      409,
    );
    expect(h.broadcasts.slice(before)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED row 3 — supersede
// ---------------------------------------------------------------------------

describe('s8 Sc3 row 3: supersede broadcasts draft.superseded', () => {
  it('one frame {draftId, byDraftId} after its row (§1.8)', async () => {
    const { h, sock, correlation } = await armedAgent();
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k1',
      body: 'first try',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const first = h.store.listDrafts()[0] as Draft;

    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k2',
      body: 'better try',
    });
    await waitUntil(
      () => h.store.getDraft(first.id)?.state === 'superseded',
      'superseded',
    );
    await waitUntil(
      () => framesOf(h, 'draft.superseded').length === 1,
      'superseded frame',
    );

    const replacement = h.store.listDrafts()[0] as Draft;
    const superseded = framesOf(h, 'draft.superseded');
    // `byDraftId` on the wire, `supersededBy` in the audit row — the same
    // two-vocabulary split as the redraft above, pinned for the same reason.
    expect(superseded[0]?.frame).toEqual({
      event: 'draft.superseded',
      draftId: first.id,
      byDraftId: replacement.id,
    });
    expect(superseded[0]?.auditAtBroadcast).toContain('draft.superseded');
  });

  it('the retirement is announced BEFORE the replacement is created', async () => {
    const { h, sock, correlation } = await armedAgent();
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k1',
      body: 'first try',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const before = h.broadcasts.length;

    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k2',
      body: 'better try',
    });
    await waitUntil(
      () => framesOf(h, 'draft.superseded').length === 1,
      'superseded frame',
    );

    // Supersede runs BEFORE the insert in `mint` (the new draft's id is the
    // reason the old one is stale), and the frames follow the same order, so
    // a GUI never holds two live cards for one inbound message.
    const seen = h.broadcasts
      .slice(before)
      .map((b) => (b.frame as Frame).event)
      .filter((e) => e === 'draft.superseded' || e === 'draft.created');
    expect(seen).toEqual(['draft.superseded', 'draft.created']);
  });

  it('a supersede REFUSED against an approved draft broadcasts nothing', async () => {
    const { h, sock, correlation } = await armedAgent();
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k1',
      body: 'first try',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const first = h.store.listDrafts()[0] as Draft;
    expect((await post(h, `/v1/drafts/${first.id}/approve`)).statusCode).toBe(
      200,
    );

    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k2',
      body: 'too late',
    });
    await waitUntil(
      () => events(h, 'draft.illegal-transition').length === 1,
      'illegal transition audited',
    );

    // The human already decided. No row, therefore no frame — the frame
    // follows the row and never announces something that did not happen.
    expect(framesOf(h, 'draft.superseded')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED row 4 — requeue (F-72), the core-originated frame
// ---------------------------------------------------------------------------

describe('s8 Sc3 row 4: a hold taken during the grace broadcasts draft.requeued', () => {
  /**
   * The F-72 sequence with the smallest honest setup: an auto-approval taken
   * while all three scopes say auto, then a PAUSE, then the grace elapsing.
   *
   * Pause reuses the `outside-window` literal on purpose (F-68) — it is the
   * same "a human can still send this" clamp a shut schedule produces, and it
   * is the branch `dispatchApproved` requeues on. A two-window schedule would
   * prove the same thing with more fixture; `outside-window.spec.ts` already
   * owns that proof, and this row is about the FRAME.
   */
  const requeued = async (): Promise<{ h: Harness; draft: Draft }> => {
    const h = await boot();
    expect(
      (
        await post(h, '/v1/adapters', {
          id: ADAPTER,
          kind: 'echo',
          displayName: ADAPTER,
        })
      ).statusCode,
    ).toBe(201);
    h.store.insertRule(makeRule({ respondMode: 'auto' }));
    h.store.setContactPolicy({ handle: HANDLE, mode: 'auto', updatedAt: T0 });
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');

    const at = h.clockCtl.clock.now();
    const source = inbound(h);
    h.store.insertInboundMessage(source);
    seq += 1;
    const draft: Draft = {
      id: newUlid(Date.parse(at)),
      inboundGuid: source.guid,
      chatGuid: CHAT,
      ruleId: RULE_ID,
      adapterId: ADAPTER,
      idempotencyKey: `idem-sc3-${String(seq)}`,
      body: 'on my way',
      originalBody: 'on my way',
      state: 'pending',
      stateChangedAt: at,
      expiresAt: new Date(Date.parse(at) + 480 * 60_000).toISOString(),
      createdAt: at,
    };
    h.store.insertDraft(draft);
    expect(
      await maybeAutoApprove(
        {
          store: h.store,
          clock: h.clockCtl.clock,
          sink: h.sink,
          newId: () => newUlid(Date.parse(h.clockCtl.clock.now())) as Ulid,
        },
        draft.id,
      ),
    ).toBe('approved');

    // The operator's hand, through the operator's own route.
    expect(
      (await post(h, '/v1/toggles/pause', { until: '1h' })).statusCode,
    ).toBe(200);

    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    return { h, draft };
  };

  it('one frame {draftId} after the draft.requeued row (§1.8)', async () => {
    const { h, draft } = await requeued();

    expect(events(h, 'draft.requeued')).toHaveLength(1);
    const frames = framesOf(h, 'draft.requeued');
    expect(frames).toHaveLength(1);
    // No reason on the wire: the requeue path writes BOTH a `draft.requeued`
    // and a `gate.denied` row, and the `gate.denied` frame already carries
    // the `GateDenyReason`. Two frames for one cause would be two ways to
    // learn the same thing, and they would drift.
    expect(frames[0]?.frame).toEqual({
      event: 'draft.requeued',
      draftId: draft.id,
    });

    // §1.8 for THIS site — and it is CORE that wrote both rows, which is the
    // point of the whole arrangement: the daemon builds the frame out of the
    // outcome core handed back, by which time core's rows are durable. Core
    // never learns that a wire exists (INV-1) and §1.8 still holds.
    expect(frames[0]?.auditAtBroadcast).toContain('draft.requeued');
    expect(frames[0]?.auditAtBroadcast).toContain('gate.denied');
  });

  it('the draft is pending again with no sendNotBefore, and nothing was sent', async () => {
    const { h, draft } = await requeued();

    const res = await get(h, `/v1/drafts/${draft.id}`);
    expect(res.statusCode).toBe(200);
    const after = (res.json() as { draft: Draft }).draft;
    expect(after.state).toBe('pending');
    // Cleared means OMITTED: a NULL column round-trips as an absent key
    // under exactOptionalPropertyTypes, never as an `undefined` value.
    expect(after.sendNotBefore).toBeUndefined();
    expect('sendNotBefore' in after).toBe(false);
    expect(h.backend.callCount()).toBe(0);
    // A requeue is not a failure, and no frame may say it was.
    expect(framesOf(h, 'draft.failed')).toEqual([]);
    expect(framesOf(h, 'draft.sent')).toEqual([]);
  });

  it('a send that simply succeeds broadcasts no draft.requeued', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'goes out fine');
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(framesOf(h, 'draft.requeued')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED row 7 — clampedBy reaches the live frame (F-64, F-108)
// ---------------------------------------------------------------------------

describe('s8 Sc3 row 7: clampedBy on the draft.created frame', () => {
  function mintedFrame(h: Harness, draftId: string): Frame {
    const match = framesOf(h, 'draft.created').find(
      (b) => (b.frame.draft as { id: string }).id === draftId,
    );
    expect(match, 'no draft.created frame for that draft').toBeDefined();
    return (match as Recorded).frame;
  }

  it("a rate clamp puts clampedBy:'rate-limited' on the frame", async () => {
    const { h, sock, correlation } = await armedAgent(async (harness) => {
      // The global cap's floor is 1 (F-66); there is no value that switches
      // the bound off, so a single approval saturates it. Spent through the
      // product's own approve route rather than by planting a counter,
      // because the whole claim is that a REAL clamp reaches the wire.
      harness.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '1');
      const spender = await createDraft(harness, 'spends the hour');
      expect(
        (await post(harness, `/v1/drafts/${spender.id}/approve`)).statusCode,
      ).toBe(200);
    });

    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k1',
      body: 'on my way',
    });
    await waitUntil(
      () => h.store.listDrafts({ state: 'pending' }).length === 1,
      'agent draft minted',
    );
    const minted = h.store.listDrafts({ state: 'pending' })[0] as Draft;

    const frame = mintedFrame(h, minted.id);
    expect((frame.draft as { clampedBy?: string }).clampedBy).toBe(
      'rate-limited',
    );

    // F-64: the AUDIT row is unchanged. A clamp is not a denial and never
    // was; it is a fact about why this card is waiting on a human, it lives
    // on the live frame, and F-108 says nothing persists it.
    const created = events(h, 'draft.created').find(
      (e) => (e as { draftId?: string }).draftId === minted.id,
    ) as { draft: Record<string, unknown> } | undefined;
    expect(created).toBeDefined();
    expect(
      'clampedBy' in (created as { draft: Record<string, unknown> }).draft,
    ).toBe(false);
    expect(events(h, 'gate.denied')).toEqual([]);
  });

  it('an unclamped decision OMITS the key rather than sending undefined', async () => {
    const { h, sock, correlation } = await armedAgent();
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'k1',
      body: 'on my way',
    });
    await waitUntil(
      () => h.store.listDrafts({ state: 'pending' }).length === 1,
      'agent draft minted',
    );
    const minted = h.store.listDrafts({ state: 'pending' })[0] as Draft;

    const summary = mintedFrame(h, minted.id).draft as Record<string, unknown>;
    // Not `toBeUndefined()` alone: this field travels as JSON, where an
    // explicit `undefined` disappears anyway, so the only assertion that
    // distinguishes "absent" from "present and empty" is the key test.
    expect('clampedBy' in summary).toBe(false);
    expect(summary.clampedBy).toBeUndefined();
  });

  it('a clamp never reaches a HUMAN draft: compose has no gate to clamp', async () => {
    const h = await boot();
    h.store.setSetting(SETTING_CAP_GLOBAL_PER_HOUR, '1');
    const first = await createDraft(h, 'spends the hour');
    expect((await post(h, `/v1/drafts/${first.id}/approve`)).statusCode).toBe(
      200,
    );

    const second = await createDraft(h, 'composed by a person');
    const frame = framesOf(h, 'draft.created').find(
      (b) => (b.frame.draft as { id: string }).id === second.id,
    );
    expect(frame).toBeDefined();
    // F-20: a human's own composition is pinned past the §2.4.3 ladder.
    // There is no autonomy here to withhold, so there is nothing to explain.
    expect(
      'clampedBy' in
        ((frame as Recorded).frame.draft as Record<string, unknown>),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The client's parseChatGuid mirror, pinned to core's (row 8's other half)
// ---------------------------------------------------------------------------

/**
 * `@wemessage/client` depends on `@wemessage/protocol` and `ws`, and nothing
 * else: it is a transport (§2.5), it ships to third parties, and pulling
 * `@wemessage/core` in for one string split would drag the store types, the
 * gate and the dispatcher behind it. So the client owns a small mirror of
 * `parseChatGuid` — and a mirror that is never compared to the original is a
 * copy waiting to drift.
 *
 * This is the only package in the repo that can import both (daemon depends
 * on core and dev-depends on client), which is the whole argument for the row
 * living here rather than in `packages/client/test`.
 *
 * The mirror is a strict NARROWING, not a variation. Where core answers with
 * a known service the two agree field for field; where core would answer
 * `service:'unknown'` — a guid whose prefix is neither iMessage nor SMS — the
 * client refuses instead of handing a caller a shape that means nothing. A
 * GUI that renders `service` as an icon has no icon for 'unknown' and would
 * silently draw the wrong one.
 */
describe('s8 Sc3: the client parseChatGuid mirror agrees with core', () => {
  const SHARED = [
    'iMessage;-;+15550000001',
    'SMS;-;+15550000002',
    'iMessage;+;chat123',
    'SMS;+;chat456',
  ];

  it('field for field, on every guid core recognises', () => {
    for (const guid of SHARED) {
      expect(clientParseChatGuid(guid), guid).toEqual(coreParseChatGuid(guid));
    }
  });

  it('and refuses exactly what core would have called unknown', () => {
    for (const garbage of ['', 'garbage', 'whatsapp;-;+15550000003', ';-;x']) {
      expect(coreParseChatGuid(garbage).service, garbage).toBe('unknown');
      expect(() => clientParseChatGuid(garbage), garbage).toThrow();
    }
  });
});

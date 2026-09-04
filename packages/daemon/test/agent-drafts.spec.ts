/**
 * s5-execution Scenario 7 ★ CHECKPOINT — `draft.submit` becomes a draft.
 *
 * This is the join between the agent era and the S4 product: everything an
 * adapter proposes lands in the SAME pending queue a human composes into,
 * governed by the SAME transition table, sent by the SAME scheduler. Row 1
 * proves that literally — an agent's draft is approved through the unmodified
 * S4 route and verified out through the loopback backend. If that ever needs
 * an agent-specific code path, the design is wrong.
 *
 * The rest of the file is about what an adapter may NOT do:
 *
 *  - It may not draft into a conversation it was never asked about. Every
 *    submit is checked against a correlation THIS gateway issued to THIS
 *    adapter (row 6). A forged or borrowed requestId is a protocol violation,
 *    not a draft.
 *  - It may not overwrite a decision a human already made. Supersede exists
 *    for `pending` drafts only; an `approved` draft is refused and the attempt
 *    is audited (row 3, teeth T7-supersede-approved).
 *  - It may not draft twice by retrying. `(adapterId, idempotencyKey)` is the
 *    closure of F-15, and it holds across a daemon restart because it is a
 *    store read plus a UNIQUE constraint, not process memory (row 2).
 *  - It may not talk past `constraints.maxChars` and expect us to trim. An
 *    over-long body is refused whole; truncating would send words nobody
 *    wrote (row 5).
 *  - It may not leave residue. `draft.delta` is a preview relayed to the
 *    client bus and persisted NOWHERE; a stream that never submits leaves an
 *    empty queue and an empty log (row 7).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Draft, Message, Rule } from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
  auditTypes,
  CHAT,
  HANDLE,
  post,
  get,
  shutdown,
  T0,
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
import {
  EMITTED_WS_EVENTS,
  WS_EVENT_VOCABULARY,
} from './transport-surface.snapshot.js';

afterEach(cleanupAgentHarness);

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
/** F-48: the rule's OWN ttl, deliberately not the route's 240 default. */
const RULE_TTL_MINUTES = 45;
const PAST_GRACE_MS = 11_000;

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
    draftTtlMinutes: RULE_TTL_MINUTES,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function inbound(over: Partial<Message> = {}): Message {
  return {
    guid: 'GUID-INBOUND-1',
    sourceRowid: 41,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    service: 'iMessage',
    kind: 'text',
    text: 'tacos tonight?',
    attachments: [],
    sentAt: T0,
    receivedAt: T0,
    ...over,
  };
}

interface Correlation {
  requestId: string;
  chatGuid: string;
  inboundGuid?: string;
}

/** The Sc 6 pipeline in miniature, wired to the server's request registry. */
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

/** Let every queued socket callback run before asserting a NEGATIVE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(setImmediate);
}

function events(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function broadcasts(h: AgentHarness, event: string): unknown[] {
  return h.broadcasts
    .map((b) => b.frame as { event?: string })
    .filter((f) => f.event === event);
}

/** Boot, register + connect an adapter, match one inbound, hand back its correlation. */
async function armed(): Promise<{
  h: AgentHarness;
  sock: FakeAdapterSocket;
  correlation: Correlation;
  cred: { id: string; token: string };
}> {
  const h = await bootAgent();
  const cred = await addAdapter(h, ADAPTER);
  h.store.insertRule(makeRule());
  // §2.4.3's ladder is consulted for every RULE-borne draft, and an unknown
  // contact denies. That is S4 behaviour this scenario deliberately does not
  // touch: the point of row 1 is that an agent's draft meets the same gate a
  // rule-matched human draft does, so the contact is allowed explicitly
  // rather than the gate being routed around.
  h.store.setContactPolicy({
    handle: HANDLE,
    mode: 'draft-only',
    updatedAt: T0,
  });
  const sock = await connectAuthed(h, cred);
  await deliverer(h)(inbound());
  await sock.waitFor(1);
  const frame = sock.frames[0] as {
    type: string;
    payload: { correlation: Correlation };
  };
  expect(frame.type).toBe('draft.request');
  return { h, sock, correlation: frame.payload.correlation, cred };
}

function submit(
  sock: FakeAdapterSocket,
  payload: Record<string, unknown>,
): void {
  sock.sendFrame('draft.submit', payload);
}

/** Drafts in any state, newest last — the queue filter hides too much here. */
function allDrafts(h: AgentHarness): Draft[] {
  return h.store
    .listDrafts()
    .concat(
      h.store.listDrafts({ state: 'superseded' }),
      h.store.listDrafts({ state: 'approved' }),
      h.store.listDrafts({ state: 'sent' }),
    );
}

describe('s5 Sc7 row 1: draft.submit mints a pending draft the human owns', () => {
  it('mints with the rule TTL, audits, broadcasts, and sends through S4', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, { correlation, idempotencyKey: 'k1', body: 'on my way' });
    await waitUntil(() => h.store.listDrafts().length === 1, 'draft minted');

    const draft = h.store.listDrafts()[0] as Draft;
    expect(draft.state).toBe('pending');
    expect(draft.adapterId).toBe(ADAPTER);
    expect(draft.ruleId).toBe(RULE_ID);
    expect(draft.inboundGuid).toBe('GUID-INBOUND-1');
    expect(draft.chatGuid).toBe(CHAT);
    expect(draft.body).toBe('on my way');
    expect(draft.originalBody).toBe('on my way');
    expect(draft.idempotencyKey).toBe('k1');
    // F-48: the RULE's ttl. 240 here would mean the rule's column is decor.
    expect(Date.parse(draft.expiresAt) - Date.parse(draft.createdAt)).toBe(
      RULE_TTL_MINUTES * 60_000,
    );

    // §1.8: appended, then broadcast.
    expect(events(h, 'draft.created')).toHaveLength(1);
    const bIndex = h.broadcasts.findIndex(
      (b) => (b.frame as { event?: string }).event === 'draft.created',
    );
    expect(bIndex).toBeGreaterThanOrEqual(0);
    expect(h.broadcasts[bIndex]?.auditAtBroadcast).toContain('draft.created');
    expect(h.broadcasts[bIndex]?.frame).toMatchObject({
      event: 'draft.created',
      draft: { id: draft.id, adapterId: ADAPTER, state: 'pending' },
    });

    // The S4 queue is THE queue.
    const listed = get(h, '/v1/drafts');
    expect(((await listed).json() as { drafts: Draft[] }).drafts).toHaveLength(
      1,
    );

    // ...and the unmodified S4 approve/send machinery carries it out.
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(h.backend.calls().map((c) => c.body)).toContain('on my way');
  });
});

describe('s5 Sc7 row 2: dedup on (adapterId, idempotencyKey)', () => {
  it('replaying the identical submit yields one draft and one audit row', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, { correlation, idempotencyKey: 'k1', body: 'on my way' });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const first = h.store.listDrafts()[0] as Draft;

    submit(sock, { correlation, idempotencyKey: 'k1', body: 'on my way' });
    await settle();

    expect(h.store.listDrafts()).toHaveLength(1);
    expect(h.store.listDrafts()[0]?.id).toBe(first.id);
    expect(events(h, 'draft.created')).toHaveLength(1);
    expect(broadcasts(h, 'draft.created')).toHaveLength(1);
  });

  it('holds across a daemon restart (a store read, not process memory)', async () => {
    const { h, sock, correlation, cred } = await armed();
    submit(sock, { correlation, idempotencyKey: 'k1', body: 'on my way' });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const firstId = (h.store.listDrafts()[0] as Draft).id;
    // Drain the socket BEFORE the store goes away: the server-side close
    // handler writes `adapter.disconnected`, and a store closed out from
    // under it is a crash that has nothing to do with what this row proves.
    sock.close();
    await waitUntil(
      () => (h.server.agentTransport?.openSessions() ?? 0) === 0,
      'first session drained',
    );
    await shutdown(h);

    // Same directory, brand-new object graph: every in-memory map that could
    // have remembered the key is gone, including the request registry.
    const h2 = await bootAgent({ dir: h.dir, fixture: h.fixture });
    const sock2 = await connectAuthed(h2, cred);
    // A DIFFERENT inbound message, because F-47 suppresses a re-match while
    // the first one still has a live draft. The key is what is on trial here,
    // not the message.
    await deliverer(h2)(inbound({ guid: 'GUID-INBOUND-2', sourceRowid: 42 }));
    await sock2.waitFor(1);
    const corr2 = (sock2.frames[0] as { payload: { correlation: Correlation } })
      .payload.correlation;
    expect(corr2.requestId).not.toBe(correlation.requestId);

    submit(sock2, { correlation: corr2, idempotencyKey: 'k1', body: 'again' });
    await settle();

    // One row, the original one, and no second creation audited.
    expect(h2.store.listDrafts()).toHaveLength(1);
    expect(h2.store.listDrafts()[0]?.id).toBe(firstId);
    expect(h2.store.listDrafts()[0]?.body).toBe('on my way');
    expect(events(h2, 'draft.created')).toHaveLength(1);
  });
});

describe('s5 Sc7 row 3: supersede is for pending drafts only', () => {
  it('supersedes the live pending draft under the system supersede actor', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, { correlation, idempotencyKey: 'k1', body: 'first try' });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const first = h.store.listDrafts()[0] as Draft;

    submit(sock, { correlation, idempotencyKey: 'k2', body: 'better try' });
    await waitUntil(
      () => h.store.getDraft(first.id)?.state === 'superseded',
      'superseded',
    );

    const fresh = h.store.listDrafts();
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.body).toBe('better try');
    expect(fresh[0]?.state).toBe('pending');
    const sup = events(h, 'draft.superseded')[0] as {
      draftId: string;
      supersededBy?: string;
    };
    expect(sup.draftId).toBe(first.id);
    expect(sup.supersededBy).toBe(fresh[0]?.id);

    // Out of the queue default, present under an explicit state filter:
    // "why did nothing get sent" is only answerable from what did not make it.
    const hidden = await get(h, '/v1/drafts');
    expect(
      (hidden.json() as { drafts: Draft[] }).drafts.map((d) => d.id),
    ).not.toContain(first.id);
    const shown = await get(h, '/v1/drafts?state=superseded');
    expect(
      (shown.json() as { drafts: Draft[] }).drafts.map((d) => d.id),
    ).toContain(first.id);
  });

  it('refuses to supersede an approved draft', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, { correlation, idempotencyKey: 'k1', body: 'first try' });
    await waitUntil(() => h.store.listDrafts().length === 1, 'first draft');
    const first = h.store.listDrafts()[0] as Draft;
    expect((await post(h, `/v1/drafts/${first.id}/approve`)).statusCode).toBe(
      200,
    );

    submit(sock, { correlation, idempotencyKey: 'k2', body: 'too late' });
    await waitUntil(
      () => events(h, 'draft.illegal-transition').length === 1,
      'illegal transition audited',
    );
    await settle();

    // The human already decided. The approved draft is untouched...
    expect(h.store.getDraft(first.id)?.state).toBe('approved');
    expect(events(h, 'draft.superseded')).toHaveLength(0);
    expect(events(h, 'draft.illegal-transition')[0]).toMatchObject({
      draftId: first.id,
      from: 'approved',
      event: 'superseded',
    });
    // ...and the new proposal still becomes a draft the human can review.
    const pending = h.store.listDrafts({ state: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toBe('too late');
  });
});

describe('s5 Sc7 row 4: declined', () => {
  it('mints nothing, audits draft.declined, broadcasts nothing', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, { correlation, idempotencyKey: 'k1', declined: true });
    await waitUntil(
      () => events(h, 'draft.declined').length === 1,
      'declined audited',
    );
    await settle();

    expect(h.store.listDrafts()).toHaveLength(0);
    expect(events(h, 'draft.created')).toHaveLength(0);
    expect(broadcasts(h, 'draft.created')).toHaveLength(0);
    expect(events(h, 'draft.declined')[0]).toMatchObject({
      adapterId: ADAPTER,
      requestId: correlation.requestId,
    });
  });
});

describe('s5 Sc7 row 5: over-limit bodies are refused, never truncated', () => {
  it('refuses a body past constraints.maxChars', async () => {
    const { h, sock, correlation } = await armed();
    const tooLong = 'x'.repeat(2001);
    submit(sock, { correlation, idempotencyKey: 'k1', body: tooLong });
    await waitUntil(
      () => events(h, 'adapter.protocol-violation').length === 1,
      'violation audited',
    );
    await settle();

    expect(h.store.listDrafts()).toHaveLength(0);
    expect(events(h, 'adapter.protocol-violation')[0]).toMatchObject({
      adapterId: ADAPTER,
      reason: 'max-chars',
    });
    // Truncation would have produced a 2000-char draft nobody wrote.
    expect(allDrafts(h)).toHaveLength(0);
  });
});

describe('s5 Sc7 row 6: correlation forgery', () => {
  it('refuses a requestId this gateway never issued', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, {
      correlation: { ...correlation, requestId: 'REQUEST-NEVER-ISSUED' },
      idempotencyKey: 'k1',
      body: 'hello stranger',
    });
    await waitUntil(
      () => events(h, 'adapter.protocol-violation').length === 1,
      'violation audited',
    );
    await settle();
    expect(h.store.listDrafts()).toHaveLength(0);
    expect(events(h, 'adapter.protocol-violation')[0]).toMatchObject({
      adapterId: ADAPTER,
      reason: 'correlation',
    });
  });

  it('refuses a submit whose chatGuid is not the one we asked about', async () => {
    const { h, sock, correlation } = await armed();
    submit(sock, {
      correlation: { ...correlation, chatGuid: 'iMessage;-;+15550000000' },
      idempotencyKey: 'k1',
      body: 'wrong conversation',
    });
    await waitUntil(
      () => events(h, 'adapter.protocol-violation').length === 1,
      'violation audited',
    );
    await settle();
    expect(h.store.listDrafts()).toHaveLength(0);
    expect(events(h, 'adapter.protocol-violation')[0]).toMatchObject({
      reason: 'correlation',
    });
  });
});

describe('s5 Sc7 row 7: deltas relay and persist nothing', () => {
  it('relays three deltas in seq order and stores nothing', async () => {
    const { h, sock, correlation } = await armed();
    for (const [seq, textDelta] of [
      [1, 'on '],
      [2, 'my '],
      [3, 'way'],
    ] as Array<[number, string]>) {
      sock.sendFrame('draft.delta', { correlation, seq, textDelta });
    }
    await waitUntil(
      () => broadcasts(h, 'draft.delta').length === 3,
      'three deltas relayed',
    );

    expect(broadcasts(h, 'draft.delta')).toEqual([
      { event: 'draft.delta', correlation, seq: 1, textDelta: 'on ' },
      { event: 'draft.delta', correlation, seq: 2, textDelta: 'my ' },
      { event: 'draft.delta', correlation, seq: 3, textDelta: 'way' },
    ]);
    expect(h.store.listDrafts()).toEqual([]);
  });

  it('drops a duplicate seq and an out-of-order seq', async () => {
    const { h, sock, correlation } = await armed();
    sock.sendFrame('draft.delta', { correlation, seq: 1, textDelta: 'a' });
    sock.sendFrame('draft.delta', { correlation, seq: 2, textDelta: 'b' });
    await waitUntil(() => broadcasts(h, 'draft.delta').length === 2, 'two');
    sock.sendFrame('draft.delta', { correlation, seq: 2, textDelta: 'dup' });
    sock.sendFrame('draft.delta', { correlation, seq: 1, textDelta: 'old' });
    await settle();

    expect(
      broadcasts(h, 'draft.delta').map(
        (b) => (b as { textDelta: string }).textDelta,
      ),
    ).toEqual(['a', 'b']);
  });

  it('a stream that never submits leaves zero rows and zero audit entries', async () => {
    const { h, sock, correlation } = await armed();
    const before = auditTypes(h.store).length;
    for (let seq = 1; seq <= 3; seq += 1) {
      sock.sendFrame('draft.delta', { correlation, seq, textDelta: 'x' });
    }
    await waitUntil(() => broadcasts(h, 'draft.delta').length === 3, 'relayed');
    await settle();

    expect(h.store.listDrafts()).toEqual([]);
    expect(allDrafts(h)).toEqual([]);
    expect(auditTypes(h.store)).toHaveLength(before);
  });
});

describe('s5 Sc7 row 8: ratchet update #17', () => {
  it('draft.delta is in both WS lists (the slice one protocol addition)', () => {
    expect(WS_EVENT_VOCABULARY).toContain('draft.delta');
    expect(EMITTED_WS_EVENTS).toContain('draft.delta');
  });
});

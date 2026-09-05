/**
 * s5-execution Scenario 8 — `draft.feedback` re-convergence + redraft delivery.
 *
 * An agent that proposes into a void cannot get better. This is the return
 * leg: every terminal thing a human (or the clock, or the send path) does to
 * an agent-originated draft comes back to the adapter that wrote it, as one
 * `draft.feedback` frame carrying the acting `Actor` verbatim.
 *
 * The four properties this file exists to pin:
 *
 *  - **The originator, and nobody else.** Feedback is addressed, not
 *    announced. Two adapters on one machine belong to two operators' agents,
 *    and a fan-out here would hand every agent a transcript of conversations
 *    it was never asked about (row 2 — teeth T8-broadcast-feedback).
 *  - **Best-effort, off the critical path.** A wedged adapter socket must not
 *    be able to hold a human's `reject` hostage. Row 3 wedges the socket for
 *    real (a server-side socket whose `send` throws, and whose buffer never
 *    drains) and asserts the route still answers 200 with a durable audit
 *    row.
 *  - **Dropped, never queued.** An adapter that is not there gets nothing,
 *    and gets nothing retroactively when it comes back (row 4). There is no
 *    outbox, on purpose: replaying yesterday's rejections at reconnect is a
 *    second, worse product, and F-45 already settled this for `draft.request`.
 *  - **Humans are not agents.** A draft composed by a person has
 *    `adapterId:'human'`, the reserved row F-22 keeps permanently
 *    disconnected. It generates no feedback, ever, and not even a
 *    `feedback-dropped` row — there is nobody it was addressed to (row 6).
 *
 * Row 5 finishes S4's F-40: redrafting an agent-originated draft re-asks the
 * agent (a fresh `draft.request`, same `inboundGuid`) while leaving the S4
 * body-copy draft exactly as it was — asserted side by side with the offline
 * case, so "the agent got re-asked" can never quietly become "the S4
 * behaviour changed".
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Draft, Message, Rule } from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
  CHAT,
  HANDLE,
  createDraft,
  post,
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

afterEach(cleanupAgentHarness);

const ADAPTER = 'echo-1';
const RULE_ID = `${'0'.repeat(24)}R1`;
const RULE_TTL_MINUTES = 45;
const PAST_TTL_MS = (RULE_TTL_MINUTES + 1) * 60_000;
const PAST_GRACE_MS = 11_000;
/**
 * Row 3's budget. Generous by two orders of magnitude against a route that
 * does no I/O — the point is to fail loudly if feedback delivery ever moves
 * onto the request path, not to measure fastify.
 */
const HUMAN_PATH_BUDGET_MS = 2_000;

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
    service: 'imessage',
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
  draftId?: string;
}

interface FeedbackFrame {
  type: string;
  payload: {
    correlation: Correlation;
    kind: string;
    actor: unknown;
    reason?: string;
    finalBody?: string;
    error?: { code: string; message: string; at: string };
  };
}

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

function feedbackFrames(sock: FakeAdapterSocket): FeedbackFrame[] {
  return (sock.frames as FeedbackFrame[]).filter(
    (f) => f.type === 'draft.feedback',
  );
}

/** Boot, connect ONE adapter, match an inbound, submit a draft for it. */
async function drafted(body = 'on my way'): Promise<{
  h: AgentHarness;
  sock: FakeAdapterSocket;
  cred: { id: string; token: string };
  draft: Draft;
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
  const sock = await connectAuthed(h, cred);
  await deliverer(h)(inbound());
  await sock.waitFor(1);
  const correlation = (
    sock.frames[0] as { payload: { correlation: Correlation } }
  ).payload.correlation;
  sock.sendFrame('draft.submit', { correlation, idempotencyKey: 'k1', body });
  await waitUntil(() => h.store.listDrafts().length === 1, 'draft minted');
  return {
    h,
    sock,
    cred,
    draft: h.store.listDrafts()[0] as Draft,
    correlation,
  };
}

describe('s5 Sc8 row 1: one feedback frame per terminal outcome', () => {
  it('reject -> draft_rejected with the reason and the human actor', async () => {
    const { h, sock, draft } = await drafted();
    expect(
      (await post(h, `/v1/drafts/${draft.id}/reject`, { reason: 'too casual' }))
        .statusCode,
    ).toBe(200);
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');

    const fb = feedbackFrames(sock)[0] as FeedbackFrame;
    expect(fb.payload.kind).toBe('draft_rejected');
    expect(fb.payload.reason).toBe('too casual');
    expect(fb.payload.actor).toEqual({ kind: 'human', via: 'api' });
    expect(fb.payload.correlation.draftId).toBe(draft.id);
    expect(fb.payload.correlation.chatGuid).toBe(CHAT);
    expect(fb.payload.correlation.inboundGuid).toBe('GUID-INBOUND-1');
  });

  it('TTL sweep -> draft_expired under the system expiry actor', async () => {
    const { h, sock, draft } = await drafted();
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');

    expect(h.store.getDraft(draft.id)?.state).toBe('expired');
    const fb = feedbackFrames(sock)[0] as FeedbackFrame;
    expect(fb.payload.kind).toBe('draft_expired');
    expect(fb.payload.actor).toEqual({ kind: 'system', reason: 'expiry' });
    expect(fb.payload.correlation.draftId).toBe(draft.id);
  });

  it('approve-with-edit -> draft_edited carrying the edited text', async () => {
    const { h, sock, draft } = await drafted();
    expect(
      (
        await post(h, `/v1/drafts/${draft.id}/approve`, {
          editedBody: 'on my way, 10 min',
        })
      ).statusCode,
    ).toBe(200);
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');

    const fb = feedbackFrames(sock)[0] as FeedbackFrame;
    expect(fb.payload.kind).toBe('draft_edited');
    expect(fb.payload.finalBody).toBe('on my way, 10 min');
    expect(fb.payload.actor).toEqual({ kind: 'human', via: 'api' });
  });

  it('verified send -> send_verified carrying what actually went', async () => {
    const { h, sock, draft } = await drafted();
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');

    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    const fb = feedbackFrames(sock)[0] as FeedbackFrame;
    expect(fb.payload.kind).toBe('send_verified');
    expect(fb.payload.finalBody).toBe('on my way');
    expect(fb.payload.actor).toEqual({ kind: 'human', via: 'api' });
    expect(fb.payload.correlation.draftId).toBe(draft.id);
  });

  it('failure -> send_failed carrying the DraftError verbatim', async () => {
    const { h, sock, draft } = await drafted();
    // The backend accepts and writes nothing, so the verify poll runs out:
    // a real 'unverified' DraftError rather than a hand-made one.
    h.backend.sabotageBody('on my way');
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');

    const failed = h.store.getDraft(draft.id);
    expect(failed?.state).toBe('failed');
    const fb = feedbackFrames(sock)[0] as FeedbackFrame;
    expect(fb.payload.kind).toBe('send_failed');
    expect(fb.payload.error).toEqual(failed?.error);
    expect(fb.payload.error?.code).toBe('unverified');
    expect(fb.payload.correlation.draftId).toBe(draft.id);
  });

  it('recall inside the grace window -> draft_recalled', async () => {
    const { h, sock, draft } = await drafted();
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    await waitUntil(() => feedbackFrames(sock).length === 0, 'no edit frame');
    expect((await post(h, `/v1/drafts/${draft.id}/recall`)).statusCode).toBe(
      200,
    );
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');

    const fb = feedbackFrames(sock)[0] as FeedbackFrame;
    expect(fb.payload.kind).toBe('draft_recalled');
    expect(fb.payload.actor).toEqual({ kind: 'human', via: 'api' });
    expect(fb.payload.correlation.draftId).toBe(draft.id);
  });
});

describe('s5 Sc8 row 2: the originating adapter only', () => {
  it('a second connected adapter receives zero frames', async () => {
    const { h, sock, draft } = await drafted();
    const other = await addAdapter(h, 'echo-2');
    const otherSock = await connectAuthed(h, other);

    expect(
      (await post(h, `/v1/drafts/${draft.id}/reject`, { reason: 'no' }))
        .statusCode,
    ).toBe(200);
    await waitUntil(() => feedbackFrames(sock).length === 1, 'feedback');
    await settle();

    // A fan-out here would hand echo-2's operator a transcript of a
    // conversation their agent was never asked about.
    expect(otherSock.frames).toEqual([]);
  });
});

/**
 * A server-side socket that is present, authenticated, and completely
 * useless: its send buffer never drains, and past the wedge point `send`
 * throws the way a destroyed stream does. Exactly the shape that would take
 * a human's reject down with it if feedback were on the critical path.
 */
interface WedgedSocket extends EventEmitter {
  readyState: number;
  buffered: string[];
  wedged: boolean;
  send(raw: string): void;
  close(): void;
  ping?(): void;
}

function wedgedSocket(): WedgedSocket {
  const sock = new EventEmitter() as WedgedSocket;
  sock.readyState = 1;
  sock.buffered = [];
  sock.wedged = false;
  sock.send = (raw: string): void => {
    // Nothing ever drains `buffered`; once wedged, the write fails outright.
    sock.buffered.push(raw);
    if (sock.wedged) throw new Error('EPIPE: this socket is wedged');
  };
  sock.close = (): void => {
    sock.readyState = 3;
    sock.emit('close');
  };
  return sock;
}

describe('s5 Sc8 row 3: the human path is never blocked by an adapter', () => {
  it('reject returns 200 within budget against a wedged adapter socket', async () => {
    const { h, sock, cred, draft } = await drafted();
    // Swap the real socket for the wedged one: same adapter id, same
    // credentials, a socket that cannot be written to.
    sock.close();
    await waitUntil(
      () => (h.server.agentTransport?.openSessions() ?? 0) === 0,
      'real session drained',
    );
    const wedged = wedgedSocket();
    h.server.agentTransport?.accept(wedged);
    wedged.emit(
      'message',
      JSON.stringify({
        v: 1,
        id: `01${'F'.repeat(24)}`,
        type: 'hello',
        ts: h.clockCtl.clock.now(),
        payload: { adapterId: cred.id, token: cred.token, wire: 1 },
      }),
    );
    await waitUntil(
      () => h.server.agentTransport?.isConnected(ADAPTER) === true,
      'wedged socket authenticated',
    );
    wedged.wedged = true;

    const started = Date.now();
    const res = await post(h, `/v1/drafts/${draft.id}/reject`, {
      reason: 'still mine to decide',
    });
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(HUMAN_PATH_BUDGET_MS);
    // Durable, and durable BEFORE anything was attempted on the wire.
    expect(events(h, 'draft.rejected')).toHaveLength(1);
    expect(h.store.getDraft(draft.id)?.state).toBe('rejected');
    // The write was attempted and it failed. Best-effort means the failure
    // is recorded, not propagated.
    await waitUntil(
      () => events(h, 'adapter.feedback-dropped').length === 1,
      'drop audited',
    );
    expect(events(h, 'adapter.feedback-dropped')[0]).toMatchObject({
      adapterId: ADAPTER,
      draftId: draft.id,
      kind: 'draft_rejected',
    });
  });
});

describe('s5 Sc8 row 4: offline adapters are dropped, never queued', () => {
  it('drops the frame with an audit row and delivers nothing on reconnect', async () => {
    const { h, sock, cred, draft } = await drafted();
    sock.close();
    await waitUntil(
      () => (h.server.agentTransport?.openSessions() ?? 0) === 0,
      'session drained',
    );

    expect(
      (await post(h, `/v1/drafts/${draft.id}/reject`, { reason: 'nope' }))
        .statusCode,
    ).toBe(200);
    await waitUntil(
      () => events(h, 'adapter.feedback-dropped').length === 1,
      'drop audited',
    );
    expect(events(h, 'adapter.feedback-dropped')[0]).toMatchObject({
      adapterId: ADAPTER,
      draftId: draft.id,
      kind: 'draft_rejected',
    });

    // Pinned negative: there is no outbox. Coming back gets you the future,
    // never the backlog.
    const again = await connectAuthed(h, cred);
    await settle();
    expect(feedbackFrames(again)).toEqual([]);
  });
});

describe('s5 Sc8 row 5: redraft re-asks the agent (F-40 completes)', () => {
  it('sends a fresh draft.request AND still mints the S4 body copy', async () => {
    const { h, sock, draft } = await drafted();
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    await waitUntil(() => feedbackFrames(sock).length === 1, 'expiry feedback');

    const res = await post(h, `/v1/drafts/${draft.id}/redraft`);
    expect(res.statusCode).toBe(200);
    const copy = (res.json() as { draft: Draft }).draft;

    // S4, unchanged: a new pending draft carrying the original body.
    expect(copy.state).toBe('pending');
    expect(copy.body).toBe('on my way');
    expect(copy.adapterId).toBe(ADAPTER);
    expect(copy.inboundGuid).toBe('GUID-INBOUND-1');

    // S5: and the agent is asked again, for the same inbound message.
    await waitUntil(
      () =>
        (sock.frames as Array<{ type: string }>).filter(
          (f) => f.type === 'draft.request',
        ).length === 2,
      'second draft.request',
    );
    const requests = (
      sock.frames as Array<{
        type: string;
        payload: { correlation: Correlation };
      }>
    ).filter((f) => f.type === 'draft.request');
    const first = requests[0]?.payload.correlation as Correlation;
    const second = requests[1]?.payload.correlation as Correlation;
    expect(second.inboundGuid).toBe(first.inboundGuid);
    expect(second.requestId).not.toBe(first.requestId);
  });

  it('with the adapter offline the S4 behaviour is unchanged (body copy only)', async () => {
    const { h, sock, draft } = await drafted();
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    sock.close();
    await waitUntil(
      () => (h.server.agentTransport?.openSessions() ?? 0) === 0,
      'session drained',
    );
    const framesBefore = sock.frames.length;

    const res = await post(h, `/v1/drafts/${draft.id}/redraft`);
    expect(res.statusCode).toBe(200);
    await settle();

    const copy = (res.json() as { draft: Draft }).draft;
    expect(copy.state).toBe('pending');
    expect(copy.body).toBe('on my way');
    expect(h.store.getDraft(copy.id)?.state).toBe('pending');
    expect(sock.frames).toHaveLength(framesBefore);
    // F-45's posture, reused: dropped and recorded, never parked.
    expect(events(h, 'adapter.unreachable').length).toBeGreaterThanOrEqual(1);
  });
});

describe('s5 Sc8 row 6: human-originated drafts never generate feedback', () => {
  it('rejecting a human draft emits no frame and no drop row', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h, ADAPTER);
    const sock = await connectAuthed(h, cred);
    const draft = await createDraft(h, 'I will write this one myself');

    expect(draft.adapterId).toBe('human');
    expect(
      (
        await post(h, `/v1/drafts/${draft.id}/reject`, {
          reason: 'changed my mind',
        })
      ).statusCode,
    ).toBe(200);
    await waitUntil(
      () => events(h, 'draft.rejected').length === 1,
      'rejection durable',
    );
    await settle();

    expect(sock.frames).toEqual([]);
    // Not even a drop row: there was nobody it was addressed to.
    expect(events(h, 'adapter.feedback-dropped')).toEqual([]);
  });

  it('a human draft that expires and one that sends are equally silent', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h, ADAPTER);
    const sock = await connectAuthed(h, cred);
    h.store.setContactPolicy({
      handle: HANDLE,
      mode: 'draft-only',
      updatedAt: T0,
    });
    const expiring = await createDraft(h, 'this one lapses', {
      ttlMinutes: 1,
    });
    const sending = await createDraft(h, 'this one goes out');

    expect((await post(h, `/v1/drafts/${sending.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(2 * 60_000);
    await h.scheduler.tick();
    await waitUntil(
      () => h.store.getDraft(sending.id)?.state === 'sent',
      'sent',
    );
    expect(h.store.getDraft(expiring.id)?.state).toBe('expired');
    await settle();

    expect(sock.frames).toEqual([]);
    expect(events(h, 'adapter.feedback-dropped')).toEqual([]);
  });
});

/**
 * s5-execution Scenario 13 ★ CHECKPOINT — T-9.4 rows (a) and (c) at the
 * frame level.
 *
 * S4's `gate-adversarial.spec.ts` attacked these two rows at the deepest
 * layer that existed then: a forged `Approval` row handed straight to the
 * dispatcher. That was the honest proof available at S4 and it said so. The
 * wire did not exist yet, so "a hostile agent" could only be simulated by an
 * attacker who already had write access to the approvals table.
 *
 * Now it exists, and the attacker is what the threat model actually describes:
 * a connected adapter with a valid token, putting bytes on a real socket. Two
 * rows, each attacked as an adapter rather than as a database:
 *
 *   (a) auto-send while the kill switch is on. An adapter submits under a
 *       kill; the draft is minted `pending`, because DRAFTING IS NOT SENDING
 *       and burning the queue is not what the switch is for. Approving it is
 *       refused 403 `gate.denied {kill-switch}` (F-34), and a draft that was
 *       already armed and has outlived its grace window dies at the re-gate
 *       under the send mutex instead.
 *
 *   (c) a forged frame claiming operator or approval authority (INV-4). Four
 *       shapes, because "forgery" is not one attack: a `hello` wearing another
 *       adapter's id, a `draft.submit` against a correlation issued to someone
 *       else, a frame typed `draft.approve` — a type that does not exist in
 *       the protocol precisely because approval is never on this socket — and
 *       an `Approval` row minted with an agent actor. Each is refused at a
 *       different layer, and each is audited as itself.
 *
 * The C-6 taxonomy pin is asserted directly and repeatedly: a forbidden or
 * unknown frame audits `adapter.no-send-frame`, NEVER `gate.denied`. Rolling
 * a wire-level refusal into the gate's deny vocabulary would make the gate's
 * counters a mix of "a human's policy said no" and "an agent sent garbage",
 * and those are not the same fact.
 *
 * Standing negatives, asserted over every row at the end of the file: no
 * `Approval` row anywhere in any hostile session has an agent actor; the audit
 * hash chain still verifies; no row carries a taxonomy-violating reason
 * string; and `SendBackend.send` was called ZERO times across the whole file.
 *
 * No GREEN is expected here. Everything these rows attack landed in Sc 5, 7
 * and 9 — this file is the composition-level proof that the pieces hold
 * together under an attacker rather than one at a time under a unit test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { Actor, AuditEvent, Message, Rule, Ulid } from '@wemessage/core';
import { verifyChain } from '@wemessage/core';
import { createInboundDispatch, toGatewayEvent } from '@wemessage/daemon';
import {
  auditEvents,
  CHAT,
  createDraft,
  HANDLE,
  post,
  T0,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAgent,
  connectAuthed,
  waitUntil,
  type AgentHarness,
  type FakeAdapterSocket,
} from './helpers/agent-harness.js';

const ADAPTER = 'echo-1';
const OTHER_ADAPTER = 'echo-2';
const RULE_ID = `${'0'.repeat(24)}R1`;
const PAST_GRACE_MS = 11_000;
const CLOSE_AUTH = 4401;
const ulid = monotonicFactory();

/** The actor a hostile agent would love to be able to mint. INV-4 says no. */
const AGENT_ACTOR: Actor = { kind: 'agent', adapterId: ADAPTER };

afterEach(cleanupAgentHarness);

/* ── ambient sweep ─────────────────────────────────────────────────────── */

interface Snapshot {
  label: string;
  rows: ReturnType<AgentHarness['store']['readAuditRows']>;
  events: AuditEvent[];
  sends: number;
}
const sessions: Snapshot[] = [];

/**
 * Snapshot rather than a live harness: `cleanupAgentHarness` closes each store
 * in afterEach, long before the sweep rows run. A sweep that held a handle
 * would be asserting against a closed database.
 */
function sweep(h: AgentHarness, label: string): void {
  sessions.push({
    label,
    rows: h.store.readAuditRows(0, 5_000),
    events: auditEvents(h.store),
    sends: h.backend.callCount(),
  });
}

function events(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

/** Let every queued socket callback run before asserting a NEGATIVE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(setImmediate);
}

/* ── fixtures ──────────────────────────────────────────────────────────── */

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
    draftTtlMinutes: 45,
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

/** Boot, connect a real adapter, match one inbound, hand back its correlation. */
async function armed(): Promise<{
  h: AgentHarness;
  sock: FakeAdapterSocket;
  correlation: Correlation;
  cred: { id: string; token: string };
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
  const frame = sock.frames[0] as {
    type: string;
    payload: { correlation: Correlation };
  };
  expect(frame.type).toBe('draft.request');
  return { h, sock, correlation: frame.payload.correlation, cred };
}

function denyReasons(h: AgentHarness): string[] {
  return events(h, 'gate.denied').map((e) =>
    'reason' in e ? String(e.reason) : '<none>',
  );
}

/* ── row (a) ───────────────────────────────────────────────────────────── */

describe('s5 Sc13 row (a): a connected adapter cannot auto-send under a kill', () => {
  it('drafts under the kill, is refused 403 at approve, and never sends', async () => {
    const { h, sock, correlation } = await armed();
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);

    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'hostile-1',
      body: 'send this immediately',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'draft minted');

    // Drafting is not sending. The switch stops the send path; it does not
    // burn the queue, and an operator who killed sending at 2am still wants
    // to read what the agents proposed in the morning.
    const draft = h.store.listDrafts()[0];
    expect(draft?.state).toBe('pending');
    expect(draft?.adapterId).toBe(ADAPTER);

    const approve = await post(h, `/v1/drafts/${String(draft?.id)}/approve`);
    expect(approve.statusCode).toBe(403);
    expect(approve.json()).toMatchObject({
      error: 'gate-denied',
      reason: 'kill-switch',
    });
    expect(h.store.getDraft(draft?.id as Ulid)?.state).toBe('pending');
    expect(denyReasons(h)).toContain('kill-switch');

    // And nothing goes out, which is the entire point of the row.
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'a.approve-refused');
  });

  it('an armed draft past its grace window dies at the mutex-held re-gate', async () => {
    const { h, sock, correlation } = await armed();
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'armed-1',
      body: 'already approved when the switch flips',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'draft minted');
    const draftId = h.store.listDrafts()[0]?.id as Ulid;

    expect((await post(h, `/v1/drafts/${draftId}/approve`)).statusCode).toBe(
      200,
    );
    // The window must ELAPSE before the flip: `cancelGraceApproved` would
    // otherwise reject the draft one layer earlier, and that is row (d)'s
    // mechanism, not this one's. To attack the re-gate the draft has to still
    // be 'approved' when the dispatcher re-reads the switch under the mutex.
    h.clockCtl.advance(PAST_GRACE_MS);
    expect(h.store.getDraft(draftId)?.state).toBe('approved');
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);

    await h.scheduler.tick();
    expect(['rejected', 'failed']).toContain(h.store.getDraft(draftId)?.state);
    expect(h.store.getDraft(draftId)?.state).not.toBe('sent');
    expect(denyReasons(h)).toContain('kill-switch');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'a.re-gate');
  });

  it('a fresh submit under the kill still drafts but can never be approved', async () => {
    const { h, sock, correlation } = await armed();
    await post(h, '/v1/toggles/kill-switch', { on: true });
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'hostile-retry',
      body: 'please',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'draft minted');
    const id = h.store.listDrafts()[0]?.id as Ulid;

    // Retried approvals do not wear the switch down.
    for (let i = 0; i < 3; i += 1) {
      const res = await post(h, `/v1/drafts/${id}/approve`);
      expect(res.statusCode).toBe(403);
    }
    expect(h.store.getDraft(id)?.state).toBe('pending');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'a.retry');
  });
});

/* ── row (c) ───────────────────────────────────────────────────────────── */

describe('s5 Sc13 row (c): forged authority on the wire (INV-4)', () => {
  it('a hello wearing another adapter id is closed 4401 and audited auth-failed', async () => {
    const h = await bootAgent();
    const victim = await addAdapter(h, ADAPTER);
    const attacker = await addAdapter(h, OTHER_ADAPTER);

    // The attacker's own, valid token — under the victim's id.
    const sock = await connectAgent(h);
    sock.sendFrame('hello', {
      adapterId: ADAPTER,
      token: attacker.token,
      wire: 1,
    });
    expect(await sock.closeCode).toBe(CLOSE_AUTH);
    expect(events(h, 'adapter.auth-failed')[0]).toMatchObject({
      adapterId: ADAPTER,
      reason: 'bad-token',
    });
    // Health is who is here, not who tried.
    expect(h.store.getAdapter(ADAPTER)?.health).not.toBe('connected');

    // And an id that was never registered at all — 'operator' is the name a
    // forger would reach for, and it is not an adapter.
    const ghost = await connectAgent(h);
    ghost.sendFrame('hello', {
      adapterId: 'operator',
      token: victim.token,
      wire: 1,
    });
    expect(await ghost.closeCode).toBe(CLOSE_AUTH);
    expect(events(h, 'adapter.auth-failed')).toHaveLength(2);
    expect(events(h, 'adapter.auth-failed')[1]).toMatchObject({
      reason: 'unknown-adapter',
    });

    expect(h.store.listDrafts()).toHaveLength(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.forged-hello');
  });

  it("a submit on another adapter's correlation is a protocol violation, not a draft", async () => {
    const { h, correlation } = await armed();
    const attacker = await addAdapter(h, OTHER_ADAPTER);
    const evil = await connectAuthed(h, attacker);

    evil.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'stolen-1',
      body: 'answering a question nobody asked me',
    });
    await waitUntil(
      () => events(h, 'adapter.protocol-violation').length === 1,
      'violation audited',
    );
    await settle();

    expect(events(h, 'adapter.protocol-violation')[0]).toMatchObject({
      adapterId: OTHER_ADAPTER,
      reason: 'correlation',
    });
    expect(h.store.listDrafts()).toHaveLength(0);
    // The correlation registry is keyed on (adapterId, requestId), so this is
    // refused for being someone else's, not for being malformed.
    expect(denyReasons(h)).toHaveLength(0);
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.stolen-correlation');
  });

  it("a frame typed 'draft.approve' audits adapter.no-send-frame and never gate.denied", async () => {
    const { h, sock, correlation } = await armed();

    // `draft.approve` is not in the protocol. That absence is the design:
    // approval is the human's, and there is no frame on this socket that can
    // express it. An adapter that invents one is evidence, not a request.
    sock.sendFrame('draft.approve', {
      draftId: '01DRAFTNEVERMINTED',
      approve: true,
    });
    await waitUntil(
      () => events(h, 'adapter.no-send-frame').length === 1,
      'no-send-frame audited',
    );
    expect(events(h, 'adapter.no-send-frame')[0]).toMatchObject({
      adapterId: ADAPTER,
      frameType: 'draft.approve',
    });

    // Two more shapes of the same claim, including a gateway→agent frame
    // replayed back at us — an adapter asserting it is the gateway.
    sock.sendFrame('send', { chatGuid: CHAT, body: 'straight out the door' });
    sock.sendFrame('draft.feedback', {
      correlation,
      kind: 'send_verified',
      actor: { kind: 'human', via: 'cli' },
    });
    await waitUntil(
      () => events(h, 'adapter.no-send-frame').length === 3,
      'three forbidden frames audited',
    );
    expect(
      events(h, 'adapter.no-send-frame').map((e) =>
        'frameType' in e ? String(e.frameType) : '<none>',
      ),
    ).toEqual(['draft.approve', 'send', 'draft.feedback']);

    // C-6, stated as a negative: none of that is a gate deny.
    expect(denyReasons(h)).toHaveLength(0);

    // The socket stays open. A confused adapter is not a hostile one, and
    // closing would hide the next thing it does — so it must still be able
    // to do its actual job.
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'still-working',
      body: 'on my way',
    });
    await waitUntil(
      () => h.store.listDrafts().length === 1,
      'socket still serves',
    );
    expect(h.store.listDrafts()[0]?.body).toBe('on my way');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.forbidden-frames');
  });

  it('an Approval row minted with an agent actor is refused by the dispatcher', async () => {
    const h = await bootAgent();
    const draft = await createDraft(h, 'agents may draft, never approve');
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );

    // The attacker already has write access to the approvals table — that is
    // the premise, not the vulnerability. INV-4 is the claim that it does not
    // help them.
    const forged = ulid();
    h.store.insertApproval({
      id: forged,
      draftId: draft.id,
      action: 'approve',
      actor: AGENT_ACTOR,
      at: h.clockCtl.clock.now(),
    });
    const before = h.store.getDraft(draft.id)?.state;

    await expect(h.dispatch(draft.id, forged)).rejects.toThrow(/agent actor/);
    expect(h.store.getDraft(draft.id)?.state).toBe(before);
    expect(h.store.getDraft(draft.id)?.state).not.toBe('sent');
    expect(denyReasons(h)).toContain('unapproved');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.agent-approval');
  });

  it('a malformed blob on an authenticated socket never becomes a draft', async () => {
    const { h, sock, correlation } = await armed();
    sock.send('not json at all');
    sock.send('[]');
    sock.send(JSON.stringify({ v: 1, id: 'x', type: 'hello' }));
    await settle();
    expect(h.store.listDrafts()).toHaveLength(0);
    expect(events(h, 'adapter.protocol-violation').length).toBeGreaterThan(0);
    expect(denyReasons(h)).toHaveLength(0);

    // Still alive and still useful.
    sock.sendFrame('draft.submit', {
      correlation,
      idempotencyKey: 'after-garbage',
      body: 'still here',
    });
    await waitUntil(() => h.store.listDrafts().length === 1, 'socket survived');
    expect(h.backend.callCount()).toBe(0);
    sweep(h, 'c.malformed');
  });
});

/* ── standing negatives ────────────────────────────────────────────────── */

describe('s5 Sc13: the standing negatives over every hostile session', () => {
  it('collected a snapshot from every row', () => {
    expect(sessions.length).toBeGreaterThanOrEqual(8);
  });

  it('SendBackend.send was called zero times in every row', () => {
    for (const s of sessions) {
      expect(`${s.label}:${String(s.sends)}`).toBe(`${s.label}:0`);
    }
  });

  it('no approval anywhere in a hostile session was minted by an agent (INV-4)', () => {
    const approvals = sessions.flatMap((s) =>
      s.rows
        .filter((row) => {
          const type = (JSON.parse(row.eventJson) as AuditEvent).type;
          return type === 'draft.approved' || type === 'draft.sent';
        })
        .map((row) => ({
          label: s.label,
          actor: JSON.parse(row.actorJson) as Actor,
        })),
    );
    // Every row of this file forged one; not one of them became an approval
    // the product was willing to act on.
    for (const { label, actor } of approvals) {
      expect(`${label}:${actor.kind}`).not.toContain(':agent');
    }
  });

  it('the audit hash chain still verifies over every hostile session', () => {
    for (const s of sessions) {
      expect(`${s.label}:${String(verifyChain(s.rows).ok)}`).toBe(
        `${s.label}:true`,
      );
    }
  });

  it('no forbidden or unknown frame was ever recorded as a gate deny (C-6)', () => {
    for (const s of sessions) {
      const denies = s.events.filter((e) => e.type === 'gate.denied');
      const reasons = denies.map((e) =>
        'reason' in e ? String(e.reason) : '<none>',
      );
      // The only deny reasons this file can legitimately produce are the two
      // its rows are about. `no-send-frame` is NOT a GateDenyReason and must
      // never appear here — that is the C-6 taxonomy pin, stated as a test.
      for (const reason of reasons) {
        expect(`${s.label}:${reason}`).toMatch(
          /:(kill-switch|unapproved|disconnected|read-only|contact-denied|adapter-disabled)$/,
        );
      }
      expect(reasons).not.toContain('no-send-frame');
      expect(reasons).not.toContain('protocol-violation');
    }
  });

  it('every forbidden frame is attributed to the adapter that sent it', () => {
    const forbidden = sessions.flatMap((s) =>
      s.events.filter((e) => e.type === 'adapter.no-send-frame'),
    );
    expect(forbidden.length).toBeGreaterThanOrEqual(3);
    for (const event of forbidden) {
      expect(event).toMatchObject({ adapterId: ADAPTER });
      expect('frameType' in event && typeof event.frameType === 'string').toBe(
        true,
      );
    }
  });
});

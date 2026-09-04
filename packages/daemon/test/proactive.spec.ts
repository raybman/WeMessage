/**
 * s5-execution Scenario 9 — proactive proposals, always draft-only.
 *
 * Every other agent-originated draft in this slice answers a question the
 * gateway asked. A proactive proposal does not: the agent decided, on its
 * own, that a human should say something to somebody. That is the one place
 * where an adapter chooses the *audience*, so it is the one place the
 * contact ladder has to bind an agent — and until F-50 it did not.
 *
 * The load-bearing rows:
 *
 *  - **Deny-all binds proactive (F-50, teeth T9-proactive-unpoliced).**
 *    `evaluateGate` consulted §2.4.3's ladder only when `ctx.rule !== null`,
 *    and a proactive draft has `ruleId: null` by §3.2 — so an adapter could
 *    propose at an unknown or explicitly denied handle and it would land in
 *    a human's queue. The fix is additive: an `agentOrigin` discriminator on
 *    `GateContext`, consulted alongside `rule`. The proof that it is additive
 *    and not a rewrite is that the human pin (F-20) still holds in the same
 *    process, against the same deny row: `POST /v1/send` still sends.
 *  - **Never auto.** A proactive draft's gate decision is `draft-only` even
 *    under `globalMode:'auto'` and a `contact.mode:'auto'` — the two settings
 *    that make every other draft self-send. And the transition table refuses
 *    a system `auto-respond` approval, so there is no path to `approved` that
 *    does not run through a human. INV-5's sibling, pinned now so S6 inherits
 *    it rather than has to remember it.
 *  - **Reason required.** A proposal with no stated reason is unreviewable:
 *    the human is being asked to send a message to someone who did not write
 *    first, and "why" is the entire content of that decision.
 *
 * Refusals here are audited, never silent, and never partial: no draft row is
 * minted by any refused path, and the queue is asserted empty each time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Draft } from '@wemessage/core';
import {
  applyDraftTransition,
  evaluateGate,
  IllegalDraftActor,
  readGateSettings,
  systemActor,
  SETTING_GLOBAL_MODE,
  SETTING_KILL_SWITCH,
} from '@wemessage/core';
import {
  auditEvents,
  CHAT,
  HANDLE,
  get,
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
const PAST_GRACE_MS = 11_000;

/** Let every queued socket callback run before asserting a NEGATIVE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(setImmediate);
}

function events(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function put(h: AgentHarness, handle: string, mode: string) {
  return h.server.app.inject({
    method: 'PUT',
    url: `/v1/contacts/${encodeURIComponent(handle)}`,
    headers: h.headers,
    payload: { mode },
  });
}

/** A booted server + an authenticated adapter socket, the Sc 9 starting line. */
async function bootWithAdapter(
  opts: { send?: boolean } = {},
): Promise<{ h: AgentHarness; sock: FakeAdapterSocket }> {
  const h = await bootAgent(opts.send === true ? { send: true } : {});
  const cred = await addAdapter(h, ADAPTER);
  const sock = await connectAuthed(h, cred);
  return { h, sock };
}

interface ProposeOver {
  idempotencyKey?: unknown;
  target?: unknown;
  body?: unknown;
  reason?: unknown;
}

function propose(sock: FakeAdapterSocket, over: ProposeOver = {}): void {
  sock.sendFrame('proactive.propose', {
    idempotencyKey: 'prop-1',
    target: { chatGuid: CHAT },
    body: 'their flight lands at 9 — want me to say we are running late?',
    reason: 'flight status changed and the reservation is in 20 minutes',
    ...over,
  });
}

function drafts(h: AgentHarness): Draft[] {
  return h.store.listDrafts({});
}

const COUNTERS = {
  contactAutoLastHour: 0,
  globalAutoLastHour: 0,
  consecutiveAutoInChat: 0,
  circuitOpen: false,
};

describe('s5 Sc 9 — proactive proposals', () => {
  it('row 1: mints a pending draft with no rule, no inbound, and its reason', async () => {
    const { h, sock } = await bootWithAdapter();
    await put(h, HANDLE, 'draft-only');

    propose(sock);
    await waitUntil(() => drafts(h).length === 1, 'proactive draft minted');

    const draft = drafts(h)[0]!;
    expect(draft.ruleId).toBeNull();
    expect(draft.inboundGuid).toBeNull();
    expect(draft.adapterId).toBe(ADAPTER);
    expect(draft.state).toBe('pending');
    expect(draft.proactiveReason).toBe(
      'flight status changed and the reservation is in 20 minutes',
    );
    expect(draft.body).toBe(draft.originalBody);
    expect(draft.createdAt).toBe(T0);

    const created = events(h, 'draft.created');
    expect(created).toHaveLength(1);

    // The queue a human actually reads shows the reason, or the proposal is
    // unreviewable: they cannot tell why a stranger is being written to.
    const queued = (await get(h, '/v1/drafts')).json() as { drafts: Draft[] };
    expect(queued.drafts).toHaveLength(1);
    expect(queued.drafts[0]?.proactiveReason).toBe(draft.proactiveReason);
  });

  it('row 2: a handle target resolves; an unresolvable one is refused', async () => {
    const { h, sock } = await bootWithAdapter();
    await put(h, HANDLE, 'draft-only');

    propose(sock, { target: { handle: HANDLE } });
    await waitUntil(() => drafts(h).length === 1, 'handle target resolved');
    expect(drafts(h)[0]?.chatGuid).toBe(CHAT);

    // No existing conversation => nothing to propose into. An adapter does
    // not get to mint a first contact with a stranger.
    await put(h, '+15550009999', 'draft-only');
    propose(sock, {
      idempotencyKey: 'prop-2',
      target: { handle: '+15550009999' },
    });
    await waitUntil(
      () => events(h, 'adapter.protocol-violation').length === 1,
      'unresolvable target refused',
    );
    await settle();
    expect(drafts(h)).toHaveLength(1);
  });

  it('row 3: a missing or whitespace-only reason is a protocol violation', async () => {
    const { h, sock } = await bootWithAdapter();
    await put(h, HANDLE, 'draft-only');

    // Three shapes of "no reason given", every one of them a violation and
    // none of them a draft. The MISSING key is caught a layer earlier, by the
    // wire guard that reads `FRAME_SPECS['proactive.propose'].required` —
    // `reason` is a required field, so it never reaches the handler. An empty
    // and a whitespace-only reason are well-formed frames that say nothing,
    // which only the handler can know.
    propose(sock, { idempotencyKey: 'p-a', reason: undefined });
    propose(sock, { idempotencyKey: 'p-b', reason: '' });
    propose(sock, { idempotencyKey: 'p-c', reason: '   \n\t ' });
    await waitUntil(
      () => events(h, 'adapter.protocol-violation').length === 3,
      'every reasonless proposal refused',
    );
    await settle();
    expect(drafts(h)).toHaveLength(0);
    expect(
      events(h, 'adapter.protocol-violation').map(
        (e) => (e as { reason?: string }).reason,
      ),
    ).toEqual(['payload', 'reason-required', 'reason-required']);
  });

  it('row 4: dedups on (adapterId, idempotencyKey) exactly as draft.submit', async () => {
    const { h, sock } = await bootWithAdapter();
    await put(h, HANDLE, 'draft-only');

    propose(sock);
    await waitUntil(() => drafts(h).length === 1, 'first proposal');
    propose(sock);
    await settle();

    expect(drafts(h)).toHaveLength(1);
    expect(events(h, 'draft.created')).toHaveLength(1);
  });

  it('row 5: deny-all binds proactive — while the human pin still holds', async () => {
    const { h, sock } = await bootWithAdapter({ send: true });

    // (a) UNKNOWN handle: §1.3.5's deny-all default is what unknown means.
    propose(sock);
    await waitUntil(
      () => events(h, 'gate.denied').length === 1,
      'unknown handle denied',
    );
    await settle();
    expect(drafts(h)).toHaveLength(0);

    // (b) An explicit deny row: same refusal, different provenance.
    await put(h, HANDLE, 'deny');
    propose(sock, { idempotencyKey: 'prop-2' });
    await waitUntil(
      () => events(h, 'gate.denied').length === 2,
      'deny row denied',
    );
    await settle();
    expect(drafts(h)).toHaveLength(0);
    expect(
      events(h, 'gate.denied').map((e) => (e as { reason?: string }).reason),
    ).toEqual(['contact-denied', 'contact-denied']);

    // The agent is TOLD. A refusal it cannot observe is one it will repeat.
    await sock.waitFor(2);
    const feedback = sock.frames.filter(
      (f) => (f as { type?: string }).type === 'draft.feedback',
    );
    expect(feedback).toHaveLength(2);

    // ...and F-20 is untouched in the very same process, against the very
    // same deny row: the ladder is the boundary between hostile inbound and
    // agents, never between the operator and their own Mac.
    const sent = await post(h, '/v1/send', {
      chatGuid: CHAT,
      body: 'my own phone, my own message',
    });
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { outcome: string }).outcome).toBe('sent');
  });

  it('row 6: never auto — draft-only under auto/auto, and no system approval', async () => {
    const { h, sock } = await bootWithAdapter();
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
    await put(h, HANDLE, 'auto');

    // The gate decision itself, at the exact context a proposal presents.
    const decision = evaluateGate({
      now: h.clockCtl.clock.now(),
      settings: readGateSettings(h.store),
      rule: null,
      agentOrigin: true,
      schedule: null,
      contact: h.store.getContactPolicy(HANDLE),
      message: {
        isGroup: false,
        service: 'iMessage',
        handle: HANDLE,
        chatGuid: CHAT,
      },
      counters: COUNTERS,
    });
    expect(decision).toEqual({ allow: true, mode: 'draft-only' });

    // End to end: the two settings that make every other draft self-send
    // leave this one sitting in the queue.
    propose(sock);
    await waitUntil(() => drafts(h).length === 1, 'proactive draft minted');
    const draft = drafts(h)[0]!;
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');

    // And there is no actor but a human that can move it off `pending`.
    expect(() =>
      applyDraftTransition({
        from: 'pending',
        event: 'approve',
        actor: systemActor('auto-respond'),
      }),
    ).toThrow(IllegalDraftActor);
  });

  it('row 7: the kill switch refuses a proposal outright', async () => {
    const { h, sock } = await bootWithAdapter();
    await put(h, HANDLE, 'draft-only');
    h.store.setSetting(SETTING_KILL_SWITCH, '1');

    propose(sock);
    await waitUntil(
      () => events(h, 'gate.denied').length === 1,
      'kill switch denied',
    );
    await settle();
    expect(drafts(h)).toHaveLength(0);
    expect((events(h, 'gate.denied')[0] as { reason?: string }).reason).toBe(
      'kill-switch',
    );
  });
});

/**
 * s6-execution Part 2 Scenario 9 ★ CHECKPOINT — rows 12 and 13: a proactive
 * proposal is still draft-only, now that autonomy exists.
 *
 * s5 Scenario 9 pinned "never auto" at a time when nothing could auto-approve
 * anything. That pin was cheap: the transition table refused a system
 * `auto-respond` actor outright, so "no path to `approved`" was true of every
 * draft in the product, and a proposal was not special. Sc 9 spends that
 * refusal (F-58) on exactly one disjunct, and the moment it does, the s5 row
 * stops proving what it was written to prove.
 *
 * So this suite re-establishes the claim against the widened world, and
 * insists on TWO INDEPENDENT MECHANISMS, asserted separately, because a
 * single mechanism is a single mistake away from an adapter choosing its own
 * audience and having the machine speak to them:
 *
 *  1. **The gate clamps it.** `agentOrigin: true` forces `mode: 'draft-only'`
 *     (F-50) whatever the three scopes say, so the auto path's own
 *     precondition (`mode === 'auto'`) is never met.
 *  2. **The auto path refuses it by shape.** `maybeAutoApprove` withholds any
 *     draft with `ruleId: null`, so even a decision that somehow resolved to
 *     `auto` cannot mint an approval for a proposal. This one holds with the
 *     gate removed from the picture entirely: the rows below drive it against
 *     drafts whose context is otherwise fully auto.
 *
 * Either mechanism alone would make these rows pass. That is the point. Row
 * 12 asserts each one on its own terms rather than only observing that
 * nothing was sent, because "nothing was sent" is exactly what a single
 * silently-broken mechanism also looks like.
 *
 * Row 13 keeps the F-50 deny binding: a proposal at a DENIED contact is
 * refused before a draft row exists, and the refusal is audited. Autonomy
 * did not create a second door into the contact ladder.
 *
 * Handles are synthetic (`+1555…`); no real iMessage content.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { AuditEvent, Draft, Ulid } from '@wemessage/core';
import {
  evaluateGate,
  maybeAutoApprove,
  readGateCounters,
  readGateSettings,
  SETTING_GLOBAL_MODE,
} from '@wemessage/core';
import { auditEvents, CHAT, HANDLE, post } from './helpers/draft-harness.js';
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
/** Comfortably past both the undo grace and F-78's auto grace. */
const PAST_GRACE_MS = 61_000;

const newUlid = monotonicFactory();

/** Let every queued socket callback run before asserting a NEGATIVE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(setImmediate);
}

function events(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

function drafts(h: AgentHarness): Draft[] {
  return h.store.listDrafts();
}

function contact(h: AgentHarness, handle: string, mode: string) {
  return h.server.app.inject({
    method: 'PUT',
    url: `/v1/contacts/${encodeURIComponent(handle)}`,
    headers: h.headers,
    payload: { mode },
  });
}

function propose(sock: FakeAdapterSocket, over: Record<string, unknown> = {}) {
  sock.sendFrame('proactive.propose', {
    idempotencyKey: 'prop-1',
    target: { chatGuid: CHAT },
    body: 'their flight lands at nine, want me to say we are running late?',
    reason: 'flight status changed and the reservation is in twenty minutes',
    ...over,
  });
}

/**
 * A connected adapter and the two settings that make every OTHER draft in
 * this product self-send. Anything that stays pending from here stayed
 * pending on purpose.
 */
async function bootFullyAuto(): Promise<{
  h: AgentHarness;
  sock: FakeAdapterSocket;
}> {
  const h = await bootAgent();
  const cred = await addAdapter(h, ADAPTER);
  const sock = await connectAuthed(h, cred);
  h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
  await contact(h, HANDLE, 'auto');
  return { h, sock };
}

function auto(
  h: AgentHarness,
  draftId: Ulid,
): Promise<'approved' | 'withheld'> {
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

describe('s6 Sc9 row 12: a proactive proposal is never auto-approved', () => {
  it('mechanism 1 — agentOrigin clamps the decision to draft-only (F-50)', async () => {
    const { h } = await bootFullyAuto();
    const base = {
      now: h.clockCtl.clock.now(),
      settings: readGateSettings(h.store),
      rule: null,
      schedule: null,
      contact: h.store.getContactPolicy(HANDLE),
      message: {
        isGroup: false,
        service: 'imessage' as const,
        handle: HANDLE,
        chatGuid: CHAT,
      },
      counters: readGateCounters(h.store, {
        now: h.clockCtl.clock.now(),
        handle: HANDLE,
        chatGuid: CHAT,
      }),
    };
    // Global auto, contact auto, no rule and no clamp of any kind. The ONLY
    // difference between these two calls is who chose the audience.
    expect(evaluateGate(base)).toEqual({ allow: true, mode: 'auto' });
    expect(evaluateGate({ ...base, agentOrigin: true })).toEqual({
      allow: true,
      mode: 'draft-only',
    });
  });

  it('mechanism 2 — the auto path refuses any draft with ruleId null', async () => {
    const { h, sock } = await bootFullyAuto();
    propose(sock);
    await waitUntil(() => drafts(h).length === 1, 'proactive draft minted');
    const draft = drafts(h)[0] as Draft;
    expect(draft.ruleId).toBeNull();
    expect(draft.state).toBe('pending');

    // Called by hand, against a store whose global and contact scopes both
    // say auto: this is the decision with the GATE's clamp deliberately
    // bypassed as a question, and it still says no. `ruleId: null` is a
    // second, independent lock — §1.7 makes it part of the precondition, not
    // a consequence of the mode.
    expect(await auto(h, draft.id)).toBe('withheld');
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(events(h, 'auto.approved')).toEqual([]);
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.store.getDraft(draft.id)?.sendNotBefore).toBeUndefined();
  });

  it('end to end: it survives every tick this suite can throw at it', async () => {
    const { h, sock } = await bootFullyAuto();
    propose(sock);
    await waitUntil(() => drafts(h).length === 1, 'proactive draft minted');
    const draft = drafts(h)[0] as Draft;

    // Whatever the submit path did on its way past, it did not approve this.
    await settle();
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.store.listApprovals(draft.id)).toEqual([]);

    for (let i = 0; i < 5; i += 1) {
      h.clockCtl.advance(PAST_GRACE_MS);
      await h.scheduler.tick();
    }
    // Still pending, still unapproved, still unsent. `sweepExpired` has not
    // reached it either: the TTL is longer than five minutes.
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(h.backend.callCount()).toBe(0);
    expect(events(h, 'auto.approved')).toEqual([]);
    expect(events(h, 'draft.sent')).toEqual([]);
  });

  it('the human path is untouched: a person can still send the proposal', async () => {
    const { h, sock } = await bootFullyAuto();
    propose(sock);
    await waitUntil(() => drafts(h).length === 1, 'proactive draft minted');
    const draft = drafts(h)[0] as Draft;

    // "Never auto" is not "never sent". The whole point of a proposal is
    // that a human reads it and decides, and Sc 9 must not have broken that.
    const res = await post(h, `/v1/drafts/${draft.id}/approve`);
    expect(res.statusCode).toBe(200);
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);
    expect(h.store.listApprovals(draft.id)[0]?.actor).toMatchObject({
      kind: 'human',
    });
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
  });
});

describe('s6 Sc9 row 13: the contact ladder still binds a proposal', () => {
  it('a proposal at a denied contact is refused, audited, and mints nothing', async () => {
    const { h, sock } = await bootFullyAuto();
    await contact(h, HANDLE, 'deny');

    propose(sock);
    await waitUntil(
      () => events(h, 'gate.denied').length === 1,
      'contact-denied',
    );
    await settle();

    expect((events(h, 'gate.denied')[0] as { reason?: string }).reason).toBe(
      'contact-denied',
    );
    // No draft row at all: the refusal is complete, not a draft nobody looks
    // at. Nothing exists for the auto path to be asked about.
    expect(drafts(h)).toHaveLength(0);
    expect(h.backend.callCount()).toBe(0);
    expect(events(h, 'auto.approved')).toEqual([]);
  });

  it('an unknown contact is denied too (the deny-all default still holds)', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h, ADAPTER);
    const sock = await connectAuthed(h, cred);
    h.store.setSetting(SETTING_GLOBAL_MODE, 'auto');
    // No policy row for HANDLE at all.
    expect(h.store.getContactPolicy(HANDLE)).toBeNull();

    propose(sock);
    await waitUntil(
      () => events(h, 'gate.denied').length === 1,
      'contact-denied for an unknown handle',
    );
    await settle();
    expect((events(h, 'gate.denied')[0] as { reason?: string }).reason).toBe(
      'contact-denied',
    );
    expect(drafts(h)).toHaveLength(0);
    expect(h.store.listDrafts()).toHaveLength(0);
  });
});

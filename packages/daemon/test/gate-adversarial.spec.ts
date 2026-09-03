/**
 * s4-execution Scenario 12 — T-9.4 adversarial suite (plan §4.0).
 *
 * The six hostile rows, each attacked at the deepest layer that exists at
 * S4, each asserting the same three things: the send did not happen, the
 * draft never reached 'sent', and exactly the named `gate.denied` reason is
 * on the audit log. Where a row's full surface arrives later (wire frames in
 * S5, schedule windows and rate caps in S6) the row says so rather than
 * pretending the narrower proof is the whole thing.
 *
 * No GREEN is expected here. Every mechanism this suite attacks landed in
 * Scenario 4, 6, 9 or 10; this file is composition-level proof that they
 * hold together under an attacker rather than one at a time under a test.
 * Anything it does force gets fixed in the owning scenario's files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { Actor, GateDenyReason, Ulid } from '@wemessage/core';
import { SETTING_CONNECTION_STATE, verifyChain } from '@wemessage/core';
import {
  auditEvents,
  boot,
  cleanupHarness,
  createDraft,
  post,
  type Harness,
} from './helpers/draft-harness.js';

const PAST_GRACE_MS = 11_000;
const GROUP_CHAT = 'iMessage;+;chat999';
const ulid = monotonicFactory();

/** §1.7's one auto-approval actor. Minted ONLY here, by the attacker. */
const AUTO_ACTOR: Actor = { kind: 'system', reason: 'auto-respond' };
const AGENT_ACTOR: Actor = { kind: 'agent', adapterId: 'test-adapter' };

afterEach(async () => {
  await cleanupHarness();
});

/**
 * Plant an approval row the product would never mint, and hand it straight
 * to the dispatcher. This is the whole point of the suite: every row here
 * assumes the attacker already has write access to the approvals table, and
 * asserts the gate still refuses. A test that could only attack through the
 * routes would be testing the routes, not the invariant.
 */
function forgeApproval(h: Harness, draftId: Ulid, actor: Actor): Ulid {
  const id = ulid();
  h.store.insertApproval({
    id,
    draftId,
    action: 'approve',
    actor,
    at: h.clockCtl.clock.now(),
  });
  return id;
}

function denyReasons(h: Harness): GateDenyReason[] {
  return auditEvents(h.store)
    .filter(
      (e): e is Extract<typeof e, { type: 'gate.denied' }> =>
        e.type === 'gate.denied',
    )
    .map((e) => e.reason);
}

/**
 * Ambient sweep. Each row SNAPSHOTS its audit state before returning; the
 * final two rows assert over every snapshot at once, so a mechanism that
 * "blocks" by corrupting the log cannot pass this file. Snapshots rather
 * than live harnesses because `cleanupHarness` closes each store in
 * afterEach, long before the sweep rows run.
 */
interface Session {
  rows: ReturnType<Harness['store']['readAuditRows']>;
  reasons: GateDenyReason[];
}
const sessions: Session[] = [];
function sweep(h: Harness): void {
  sessions.push({
    rows: h.store.readAuditRows(0, 2000),
    reasons: denyReasons(h),
  });
}

/** Approve for real, then dispatch under a FORGED approval of `actor`. */
async function approveThenForge(
  h: Harness,
  body: string,
  actor: Actor,
  payload: Record<string, unknown> = {},
): Promise<{ draftId: Ulid; forgedId: Ulid }> {
  const draft = await createDraft(h, body, payload);
  expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
    200,
  );
  return { draftId: draft.id, forgedId: forgeApproval(h, draft.id, actor) };
}

describe('s4 Scenario 12: T-9.4 adversarial suite (§4.0)', () => {
  it('(a) an auto-respond approval dispatched while the kill switch is on is denied', async () => {
    const h = await boot();
    const { draftId, forgedId } = await approveThenForge(
      h,
      'auto-send during a kill',
      AUTO_ACTOR,
    );
    // The window must ELAPSE before the flip, or `cancelGraceApproved`
    // rejects the draft and the dispatcher refuses it one layer earlier as
    // "not in state 'approved'". That refusal is real, but it is row (f)'s
    // mechanism, not this row's: to attack the kill switch itself the draft
    // has to still be 'approved' when the dispatcher re-reads the gate.
    h.clockCtl.advance(PAST_GRACE_MS);
    expect(
      (await post(h, '/v1/toggles/kill-switch', { on: true })).statusCode,
    ).toBe(200);
    expect(h.store.getDraft(draftId)?.state).toBe('approved');

    const before = h.backend.callCount();
    await h.dispatch(draftId, forgedId).catch(() => undefined);
    expect(h.store.getDraft(draftId)?.state).not.toBe('sent');
    expect(h.backend.callCount()).toBe(before);
    // Frame-level re-proof (a forged draft.submit on the wire) is S5.
    expect(denyReasons(h)).toContain('kill-switch');
    sweep(h);
  });

  it('(b) approve-moment allow is not send-moment allow: the connection flip denies at dispatch', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'approved while connected');
    expect((await post(h, `/v1/drafts/${draft.id}/approve`)).statusCode).toBe(
      200,
    );
    // The capability the approval was granted under evaporates before the
    // grace window elapses. Nothing re-asks the human; the gate re-read
    // under the send mutex is the only thing standing here.
    h.store.setSetting(SETTING_CONNECTION_STATE, 'read-only');
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();

    const parked = h.store.getDraft(draft.id);
    expect(parked?.state).toBe('failed');
    expect(parked?.error?.message).toContain('read-only');
    expect(h.backend.callCount()).toBe(0);
    expect(denyReasons(h)).toContain('read-only');
    // The literal 'outside-window' schedule form of this attack lands in S6.
    sweep(h);
  });

  it('(c) an approval forged with an agent actor throws and changes nothing (INV-4)', async () => {
    const h = await boot();
    const { draftId, forgedId } = await approveThenForge(
      h,
      'agents may draft, never approve',
      AGENT_ACTOR,
    );
    const stateBefore = h.store.getDraft(draftId)?.state;

    await expect(h.dispatch(draftId, forgedId)).rejects.toThrow(/agent actor/);
    expect(h.store.getDraft(draftId)?.state).toBe(stateBefore);
    expect(h.backend.callCount()).toBe(0);
    expect(denyReasons(h)).toContain('unapproved');
    sweep(h);
  });

  it('(d) flipping the kill switch mid-grace and mid-queue never lets the draft out', async () => {
    const h = await boot();
    const midGrace = await createDraft(h, 'flipped mid-grace');
    await post(h, `/v1/drafts/${midGrace.id}/approve`);
    await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(h.store.getDraft(midGrace.id)?.state).toBe('rejected');

    // Second half: a draft whose window has already elapsed, so the cancel
    // cannot reach it and only the re-gate under the mutex can stop it.
    await post(h, '/v1/toggles/kill-switch', { on: false });
    const midQueue = await createDraft(h, 'flipped mid-queue');
    await post(h, `/v1/drafts/${midQueue.id}/approve`);
    h.clockCtl.advance(PAST_GRACE_MS);
    await post(h, '/v1/toggles/kill-switch', { on: true });
    await h.scheduler.tick();

    // The disjunction is deliberate: which of the two mechanisms catches it
    // depends on a race the test cannot control. Demanding one outcome would
    // eventually be "fixed" by making the product lie.
    expect(['rejected', 'failed']).toContain(
      h.store.getDraft(midQueue.id)?.state,
    );
    expect(h.backend.callCount()).toBe(0);
    const events = auditEvents(h.store).map((e) => e.type);
    expect(
      events.includes('draft.rejected') || events.includes('gate.denied'),
    ).toBe(true);
    sweep(h);
  });

  it('(e) an auto approval on a group chat is denied group-auto-forbidden (INV-5)', async () => {
    const h = await boot();
    const { draftId, forgedId } = await approveThenForge(
      h,
      'auto into a group',
      AUTO_ACTOR,
      { chatGuid: GROUP_CHAT },
    );
    await h.dispatch(draftId, forgedId).catch(() => undefined);

    const parked = h.store.getDraft(draftId);
    expect(parked?.state).not.toBe('sent');
    expect(parked?.error?.message).toContain('group-auto-forbidden');
    expect(h.backend.callCount()).toBe(0);
    expect(denyReasons(h)).toContain('group-auto-forbidden');
    sweep(h);
  });

  it('(f) an approvalId belonging to a different draft is unapproved, not authority', async () => {
    const h = await boot();
    const victim = await createDraft(h, 'the draft that gets sent');
    const other = await createDraft(h, 'the draft that was approved');
    await post(h, `/v1/drafts/${victim.id}/approve`);
    await post(h, `/v1/drafts/${other.id}/approve`);
    const othersApproval = h.store.latestApproveApproval(other.id);
    expect(othersApproval).not.toBeNull();

    await expect(
      h.dispatch(victim.id, othersApproval?.id ?? ''),
    ).rejects.toThrow(/does not authorize/);
    expect(h.store.getDraft(victim.id)?.state).toBe('approved');
    expect(h.backend.callCount()).toBe(0);
    expect(denyReasons(h)).toContain('unapproved');
    // The compile-time half — calling backend.send outside the allowlist —
    // is enforced by test/arch.spec.ts's SendBackend importer baseline.
    sweep(h);
  });

  it('the audit chain still verifies across every hostile session', () => {
    expect(sessions.length).toBeGreaterThanOrEqual(6);
    for (const session of sessions) {
      expect(session.rows.length).toBeGreaterThan(0);
      expect(verifyChain(session.rows)).toMatchObject({ ok: true });
    }
  });

  it('no hostile row produced a reason outside the pinned taxonomy', () => {
    const PINNED: readonly GateDenyReason[] = [
      'kill-switch',
      'disconnected',
      'read-only',
      'contact-denied',
      'group-auto-forbidden',
      'outside-window',
      'rate-limited',
      'circuit-open',
      'loop-detected',
      'unapproved',
      'adapter-disabled',
      'sms-auto-forbidden',
    ];
    const seen = sessions.flatMap((s) => s.reasons);
    expect(seen.length).toBeGreaterThan(0);
    for (const reason of seen) expect(PINNED).toContain(reason);
  });
});

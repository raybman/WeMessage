/**
 * s4-execution Scenario 9: the kill switch, end to end.
 *
 * The invariant the whole suite defends is narrow and absolute: after the
 * flip returns 200, nothing that was waiting goes out. Everything else here
 * is about WHERE each draft is stopped, because there are two mechanisms
 * covering two different moments — `cancelGraceApproved` for drafts still
 * inside their undo window, and the gate re-read under the send mutex for a
 * draft already handed to the dispatcher. Row 5 asserts the disjunction
 * rather than picking one, because a test that demanded a single outcome for
 * a draft racing the flip would be asserting a race it cannot control, and
 * would eventually be "fixed" by making the product lie.
 *
 * Pending drafts deliberately survive the flip. The switch stops sending,
 * it does not burn the queue: an operator who kills sending at 2am still
 * wants to read what the agents proposed in the morning.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SETTING_KILL_SWITCH } from '@wemessage/core';
import {
  auditActors,
  auditTypes,
  boot,
  cleanupHarness,
  createDraft,
  get,
  post,
} from './helpers/draft-harness.js';

const PAST_GRACE_MS = 11_000;

afterEach(async () => {
  await cleanupHarness();
});

describe('s4 Scenario 9: kill switch end-to-end', () => {
  it('the flip sets the setting, bumps the version, and cancels in-grace drafts', async () => {
    const h = await boot();
    const before = h.store.getSettingVersion(SETTING_KILL_SWITCH);
    const a = await createDraft(h, 'in flight a');
    const b = await createDraft(h, 'in flight b');
    await post(h, `/v1/drafts/${a.id}/approve`);
    await post(h, `/v1/drafts/${b.id}/approve`);

    const res = await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { on: boolean; cancelled: string[] };
    expect(body.on).toBe(true);
    expect([...body.cancelled].sort()).toEqual([a.id, b.id].sort());

    expect(h.store.getSetting(SETTING_KILL_SWITCH)).toBe('1');
    expect(h.store.getSettingVersion(SETTING_KILL_SWITCH)).toBeGreaterThan(
      before,
    );
    for (const id of [a.id, b.id]) {
      const draft = h.store.getDraft(id);
      expect(draft?.state).toBe('rejected');
      expect(draft?.error?.code).toBe('gate-denied');
      expect(draft?.sendNotBefore).toBeUndefined();
    }

    // The cancellation is attributed to the switch, not to a human who
    // never touched these particular drafts.
    const actors = auditActors(h.store, 'draft.rejected');
    expect(actors).toHaveLength(2);
    for (const a2 of actors) {
      expect(a2).toMatchObject({ kind: 'system', reason: 'kill-switch' });
    }

    // §1.8: the toggle's own record precedes every cancellation it caused.
    const types = auditTypes(h.store);
    expect(types.indexOf('toggle.changed')).toBeLessThan(
      types.indexOf('draft.rejected'),
    );

    // §1.8 the other way round: the record is durable BEFORE the courtesy
    // goes out. Asserting only on the finished log cannot see this — the log
    // ends up identical whichever order the two happened in. The difference
    // is a client told about a rejection the daemon then forgot.
    const rejectFrames = h.broadcasts.filter(
      (b) => (b.frame as { event?: string }).event === 'draft.rejected',
    );
    expect(rejectFrames).toHaveLength(2);
    for (const [i, frame] of rejectFrames.entries()) {
      expect(
        frame.auditAtBroadcast.filter((t) => t === 'draft.rejected'),
      ).toHaveLength(i + 1);
    }

    // And nothing sends afterwards, which is the entire point.
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(0);
  });

  it('pending drafts survive the flip but can no longer be approved', async () => {
    const h = await boot();
    const pending = await createDraft(h, 'still worth reading');
    await post(h, '/v1/toggles/kill-switch', { on: true });

    expect(h.store.getDraft(pending.id)?.state).toBe('pending');
    const queue = (await get(h, '/v1/drafts')).json() as {
      drafts: Array<{ id: string }>;
    };
    expect(queue.drafts.map((d) => d.id)).toContain(pending.id);

    const res = await post(h, `/v1/drafts/${pending.id}/approve`);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'gate-denied',
      reason: 'kill-switch',
    });
    expect(h.store.getDraft(pending.id)?.state).toBe('pending');
  });

  it('a draft past its grace window is stopped at dispatch, not by the cancel', async () => {
    const h = await boot();
    const first = await createDraft(h, 'goes out first');
    await post(h, `/v1/drafts/${first.id}/approve`);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(first.id)?.state).toBe('sent');

    // The second draft's window has ELAPSED but it has not been dispatched
    // yet, so cancelGraceApproved (strictly-future windows only) cannot
    // touch it. The only thing that can stop it is the gate re-read inside
    // the dispatcher, which is the seam this row exists to prove.
    const second = await createDraft(h, 'must not go out');
    await post(h, `/v1/drafts/${second.id}/approve`);
    h.clockCtl.advance(PAST_GRACE_MS);

    const flip = await post(h, '/v1/toggles/kill-switch', { on: true });
    expect((flip.json() as { cancelled: string[] }).cancelled).toEqual([]);

    const sendsBefore = h.backend.callCount();
    await h.scheduler.tick();
    const parked = h.store.getDraft(second.id);
    expect(parked?.state).toBe('failed');
    expect(parked?.error).toMatchObject({ code: 'gate-denied' });
    expect(parked?.error?.message).toContain('kill-switch');
    expect(h.backend.callCount()).toBe(sendsBefore);
  });

  it('resume re-opens sending without reviving what the switch stopped', async () => {
    const h = await boot();
    const killed = await createDraft(h, 'killed mid-grace');
    await post(h, `/v1/drafts/${killed.id}/approve`);
    await post(h, '/v1/toggles/kill-switch', { on: true });
    expect(h.store.getDraft(killed.id)?.state).toBe('rejected');

    const res = await post(h, '/v1/toggles/kill-switch', { on: false });
    expect(res.statusCode).toBe(200);
    expect(h.store.getSetting(SETTING_KILL_SWITCH)).toBe('0');
    // Resume means "new work may flow", never "replay what I halted": those
    // messages may no longer be true, and the operator killed them on purpose.
    expect(h.store.getDraft(killed.id)?.state).toBe('rejected');

    const fresh = await createDraft(h, 'after the all-clear');
    expect((await post(h, `/v1/drafts/${fresh.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(fresh.id)?.state).toBe('sent');
  });

  it('a draft whose grace elapses exactly at the flip is stopped, either way', async () => {
    const h = await boot();
    const racing = await createDraft(h, 'right on the boundary');
    await post(h, `/v1/drafts/${racing.id}/approve`);
    const deadline = h.store.getDraft(racing.id)?.sendNotBefore;
    expect(deadline).toBeDefined();

    // Clock sits exactly ON the deadline: cancelGraceApproved selects
    // strictly-future windows, so this draft falls between the two
    // mechanisms by construction.
    h.clockCtl.set(String(deadline));
    await post(h, '/v1/toggles/kill-switch', { on: true });
    await h.scheduler.tick();

    const state = h.store.getDraft(racing.id)?.state;
    expect(['rejected', 'failed']).toContain(state);
    // The disjunction is negotiable. This is not.
    expect(h.backend.callCount()).toBe(0);
  });

  it('a malformed toggle body is a 400 and changes nothing', async () => {
    const h = await boot();
    const res = await post(h, '/v1/toggles/kill-switch', { on: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(h.store.getSetting(SETTING_KILL_SWITCH)).toBeNull();
  });
});

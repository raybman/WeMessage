/**
 * s10 Slice 2c: late verification, end to end through the daemon.
 *
 * A send Messages accepted but did not write inside the 10s verify budget
 * parks 'failed' with code 'unverified'. Under load the row lands later.
 * Three places now look before anything is put on the wire again:
 *
 *  1. POST /v1/drafts/:id/retry asks chat.db first. Landed means 409
 *     'already-sent', the draft moves failed -> sent, and the backend is
 *     never called. Checked BEFORE the retry ceiling: a draft that went out
 *     is reported as sent, not as "retry limit reached".
 *  2. The scheduler sweep re-checks recent unverified failures on its own,
 *     throttled to once per 30s and bounded to the last 15 minutes, so the
 *     queue corrects itself without anybody pressing Retry.
 *  3. The dispatcher's ledger guard (core, Slice 2b): a retry approved
 *     BEFORE the row landed still sends nothing if the row is there by the
 *     time grace elapses.
 *
 * Teeth (each verified red, then restored):
 *  TD1. the retry route skips lateVerify -> rows 1-2 send twice.
 *  TD2. the sweep ignores its throttle -> the throttle row goes sent early.
 *  TD3. the sweep's window is unbounded -> the stale row goes sent.
 *  TD4. the dispatcher guard removed -> row 6 calls the backend twice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditActors,
  boot,
  cleanupHarness,
  createDraft,
  post,
  CHAT,
  type Harness,
} from './helpers/draft-harness.js';

const PAST_GRACE_MS = 11_000;
const BODY = 'running ten minutes late';

afterEach(async () => {
  await cleanupHarness();
});

/** Approve, let grace elapse, and fail verification. One backend call. */
async function failUnverified(h: Harness): Promise<string> {
  const draft = await createDraft(h, BODY);
  h.backend.sabotageBody(BODY);
  const approve = await post(h, `/v1/drafts/${draft.id}/approve`);
  expect(approve.statusCode).toBe(200);
  h.clockCtl.advance(PAST_GRACE_MS);
  await h.scheduler.tick();
  const failed = h.store.getDraft(draft.id);
  expect(failed?.state).toBe('failed');
  expect(failed?.error?.code).toBe('unverified');
  expect(h.backend.callCount()).toBe(1);
  return draft.id;
}

/** Messages finally writes the row, after the verify budget ran out. */
function landLate(h: Harness): string {
  h.backend.unsabotageBody(BODY);
  return h.fixture.appendOutbound({
    chatGuid: CHAT,
    text: BODY,
    atIso: h.clockCtl.clock.now(),
  }).guid;
}

function sentFrames(h: Harness, draftId: string) {
  return h.broadcasts.filter(
    (b) =>
      (b.frame as { event?: string; draftId?: string }).event ===
        'draft.sent' && (b.frame as { draftId?: string }).draftId === draftId,
  );
}

describe('s10 Sl2c: the retry route looks before it re-sends', () => {
  it('a late-landed row -> 409 already-sent, draft sent, backend NOT called again', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    const guid = landLate(h);

    const res = await post(h, `/v1/drafts/${id}/retry`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'already-sent',
      from: 'sent',
      sentMessageGuid: guid,
    });
    const after = h.store.getDraft(id);
    expect(after?.state).toBe('sent');
    expect(after?.sentMessageGuid).toBe(guid);
    expect(after?.error).toBeUndefined();

    // Nothing further goes out, now or on a later tick.
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.backend.callCount()).toBe(1);
    expect(h.store.listApprovals(id)).toHaveLength(1);
  });

  it('audits draft.sent as the late-verify system actor, then broadcasts (§1.8)', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    const guid = landLate(h);
    await post(h, `/v1/drafts/${id}/retry`);

    expect(auditActors(h.store, 'draft.sent')).toEqual([
      { kind: 'system', reason: 'late-verify' },
    ]);
    const frames = sentFrames(h, id);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.frame).toEqual({
      event: 'draft.sent',
      draftId: id,
      sentMessageGuid: guid,
    });
    expect(frames[0]?.auditAtBroadcast).toContain('draft.sent');
  });

  it('already-sent wins over the retry ceiling', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    // Burn the ceiling: two more failed retries.
    h.backend.sabotageBody(BODY);
    for (let i = 0; i < 2; i += 1) {
      expect((await post(h, `/v1/drafts/${id}/retry`)).statusCode).toBe(200);
      h.clockCtl.advance(PAST_GRACE_MS);
      await h.scheduler.tick();
    }
    expect(h.store.getDraft(id)?.state).toBe('failed');
    const calls = h.backend.callCount();
    landLate(h);

    const res = await post(h, `/v1/drafts/${id}/retry`);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('already-sent');
    expect(h.backend.callCount()).toBe(calls);
  });

  it('no landed row -> the retry proceeds exactly as before', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    h.backend.unsabotageBody(BODY);

    const res = await post(h, `/v1/drafts/${id}/retry`);
    expect(res.statusCode).toBe(200);
    expect(h.store.getDraft(id)?.state).toBe('approved');
  });
});

describe('s10 Sl2c: the scheduler sweep corrects the queue on its own', () => {
  it('marks a late-landed draft sent without a retry, and broadcasts it', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    const guid = landLate(h);

    h.clockCtl.advance(30_000);
    await h.scheduler.tick();
    expect(h.store.getDraft(id)?.state).toBe('sent');
    expect(h.store.getDraft(id)?.sentMessageGuid).toBe(guid);
    expect(sentFrames(h, id)).toHaveLength(1);
    expect(h.backend.callCount()).toBe(1);
  });

  it('is throttled: a second tick inside 30s does not re-scan', async () => {
    const h = await boot();
    // The tick that failed the draft already ran the sweep (nothing landed).
    const id = await failUnverified(h);
    landLate(h);

    h.clockCtl.advance(5_000);
    await h.scheduler.tick();
    expect(h.store.getDraft(id)?.state).toBe('failed');

    h.clockCtl.advance(30_000);
    await h.scheduler.tick();
    expect(h.store.getDraft(id)?.state).toBe('sent');
  });

  it('is bounded: a failure older than 15 minutes is left for a human', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    h.clockCtl.advance(16 * 60_000);
    landLate(h);

    await h.scheduler.tick();
    expect(h.store.getDraft(id)?.state).toBe('failed');
  });
});

describe('s10 Sl2c: the dispatcher guard, end to end', () => {
  it('a retry approved BEFORE the row landed still sends nothing once it has', async () => {
    const h = await boot();
    const id = await failUnverified(h);
    h.backend.unsabotageBody(BODY);

    // Nothing has landed yet, so the retry is accepted.
    expect((await post(h, `/v1/drafts/${id}/retry`)).statusCode).toBe(200);
    landLate(h);

    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(id)?.state).toBe('sent');
    expect(h.backend.callCount()).toBe(1);
    expect(sentFrames(h, id)).toHaveLength(1);
  });
});

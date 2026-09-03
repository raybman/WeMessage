/**
 * s4-execution Scenario 7 (★ checkpoint): bulk approve, partial failure, retry.
 *
 * The property under test is that a batch is N independent acts reported
 * honestly, NOT one transaction. A bulk approve over five drafts where the
 * third send fails must still deliver the fourth and fifth: aborting on
 * first failure, or rolling the batch back, would turn one stalled message
 * into four unsent ones, silently, at exactly the moment a user is watching
 * a queue drain. That is row 2, and it is the reason `batchReport` reports
 * per-draft current state rather than a batch-level pass/fail.
 *
 * The retry rows cover C-10's other half: a retry gets a FRESH grace window
 * (a reused one is already in the past, so "try again" would mean "send
 * instantly, no undo"), and the ceiling refuses at the route with a 409
 * before the draft is moved, so a user is never shown a retry that looks
 * like it worked until the next tick undoes it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  boot,
  cleanupHarness,
  createDraft,
  get,
  post,
  CHAT,
  type Harness,
} from './helpers/draft-harness.js';

/** Comfortably past the 10s default undo window. */
const PAST_GRACE_MS = 11_000;

afterEach(async () => {
  await cleanupHarness();
});

async function fiveDrafts(h: Harness): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= 5; i += 1) {
    const draft = await createDraft(h, `batch body ${i}`);
    ids.push(draft.id);
  }
  return ids;
}

describe('s4 Scenario 7: bulk approve, partial failure, retry', () => {
  it('bulk approve over the pending queue stamps one batchId on all five', async () => {
    const h = await boot();
    const ids = await fiveDrafts(h);

    const res = await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      filter: { all: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      batchId: string;
      matched: number;
      applied: number;
      appliedIds: string[];
      refused: unknown[];
    };
    expect(body.matched).toBe(5);
    expect(body.applied).toBe(5);
    expect(body.refused).toEqual([]);
    expect([...body.appliedIds].sort()).toEqual([...ids].sort());

    // One batchId spanning five Approval rows, and one grace deadline
    // family: same clock, same setting, so the whole batch shares a fate.
    const deadlines = new Set<string>();
    for (const id of ids) {
      const draft = h.store.getDraft(id);
      expect(draft?.state).toBe('approved');
      expect(draft?.sendNotBefore).toBeDefined();
      deadlines.add(String(draft?.sendNotBefore));
      const approvals = h.store.listApprovals(id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.batchId).toBe(body.batchId);
      expect(approvals[0]?.action).toBe('approve');
    }
    expect(deadlines.size).toBe(1);
  });

  it('a failing send does NOT abort the batch: 4 and 5 still go out', async () => {
    const h = await boot();
    const ids = await fiveDrafts(h);
    // Exactly one draft is doomed. An all-or-nothing sabotage could only
    // prove "everything failed", which is indistinguishable from an abort.
    h.backend.sabotageBody('batch body 3');

    await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      filter: { all: true },
    });
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();

    const states = ids.map((id) => h.store.getDraft(id)?.state);
    expect(states).toEqual(['sent', 'sent', 'failed', 'sent', 'sent']);
  });

  it('GET /v1/batches/:id reports the drafts current truth', async () => {
    const h = await boot();
    await fiveDrafts(h);
    h.backend.sabotageBody('batch body 3');

    const bulk = await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      filter: { all: true },
    });
    const { batchId } = bulk.json() as { batchId: string };
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();

    const res = await get(h, `/v1/batches/${batchId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      batchId,
      sent: 4,
      failed: 1,
      recalled: 0,
      approved: 0,
      sending: 0,
    });
  });

  it('recalling one of a batch during grace shows up in the report', async () => {
    const h = await boot();
    const ids = await fiveDrafts(h);
    const bulk = await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      filter: { all: true },
    });
    const { batchId } = bulk.json() as { batchId: string };

    // Inside the window: the recall is the point of the window.
    const recall = await post(h, `/v1/drafts/${ids[1]}/recall`);
    expect(recall.statusCode).toBe(200);

    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();

    const report = (await get(h, `/v1/batches/${batchId}`)).json();
    expect(report).toMatchObject({ sent: 4, recalled: 1, failed: 0 });
    expect(h.store.getDraft(String(ids[1]))?.state).toBe('recalled');
  });

  it('retry gives a FRESH grace window and a new approve row, then sends', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'retry me');
    h.backend.sabotageBody('retry me');
    await post(h, `/v1/drafts/${draft.id}/approve`);
    const firstDeadline = h.store.getDraft(draft.id)?.sendNotBefore;
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('failed');

    // Un-doom it, then retry: this is the user saying "try again", not
    // "send now", so the window must be re-opened from the current clock.
    h.backend.unsabotageBody('retry me');
    const res = await post(h, `/v1/drafts/${draft.id}/retry`);
    expect(res.statusCode).toBe(200);
    const retried = h.store.getDraft(draft.id);
    expect(retried?.state).toBe('approved');
    expect(retried?.sendNotBefore).toBeDefined();
    expect(Date.parse(String(retried?.sendNotBefore))).toBeGreaterThan(
      Date.parse(String(firstDeadline)),
    );
    const approvals = h.store.listApprovals(draft.id);
    expect(approvals.at(-1)?.action).toBe('approve');
    expect(approvals.filter((a) => a.action === 'approve')).toHaveLength(2);

    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(draft.id)?.state).toBe('sent');
    expect(h.store.sendAttemptCount(draft.id)).toBe(2);
  });

  it('C-10: the third failure is terminal and further retries are 409', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'doomed forever');
    h.backend.sabotageBody('doomed forever');

    await post(h, `/v1/drafts/${draft.id}/approve`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      h.clockCtl.advance(PAST_GRACE_MS);
      await h.scheduler.tick();
      expect(h.store.getDraft(draft.id)?.state).toBe('failed');
      expect(h.store.sendAttemptCount(draft.id)).toBe(attempt);
      if (attempt < 3) {
        expect((await post(h, `/v1/drafts/${draft.id}/retry`)).statusCode).toBe(
          200,
        );
      }
    }

    const res = await post(h, `/v1/drafts/${draft.id}/retry`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'retry-limit', attempts: 3 });
    expect(h.store.getDraft(draft.id)?.state).toBe('failed');
  });

  it('bulk over a mix refuses the un-approvable rows and applies the rest', async () => {
    const h = await boot();
    const sentDraft = await createDraft(h, 'already gone');
    await post(h, `/v1/drafts/${sentDraft.id}/approve`);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(sentDraft.id)?.state).toBe('sent');

    const a = await createDraft(h, 'still pending a');
    const b = await createDraft(h, 'still pending b');

    const res = await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      ids: [sentDraft.id, a.id, b.id, 'no-such-draft'],
    });
    // 200 always: one stale row must not make the endpoint unusable.
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      matched: number;
      applied: number;
      appliedIds: string[];
      refused: Array<{ id: string; error: string }>;
    };
    expect(body.matched).toBe(4);
    expect(body.applied).toBe(2);
    expect([...body.appliedIds].sort()).toEqual([a.id, b.id].sort());
    expect(body.refused).toEqual(
      expect.arrayContaining([
        { id: sentDraft.id, error: 'illegal-transition' },
        { id: 'no-such-draft', error: 'not-found' },
      ]),
    );
    expect(h.store.getDraft(sentDraft.id)?.state).toBe('sent');
  });

  it('filter scopes the batch: planted non-matching drafts are untouched', async () => {
    const h = await boot();
    // POST /v1/drafts is the human compose surface: every draft it makes
    // is adapter 'human' with ruleId null, on the fixture chat. The rule
    // and contact dimensions therefore have to be planted directly, which
    // is also closer to how a rule-generated draft actually arrives.
    const at0 = h.clockCtl.clock.now();
    const plantRule = (id: string): void => {
      h.store.insertRule({
        id,
        name: id,
        enabled: true,
        matcher: { kind: 'keyword', keywords: ['x'], mode: 'any' },
        adapterId: 'human',
        respondMode: 'draft-only',
        scheduleId: null,
        outsideWindow: 'draft-only',
        allowGroupDrafts: false,
        matchAttachmentOnly: false,
        draftTtlMinutes: 240,
        priority: 100,
        createdAt: at0,
        updatedAt: at0,
      });
    };
    // §2.4.3: rule-driven traffic consults the contact ladder, and an
    // UNKNOWN contact denies (§1.3.5 deny-all default). Only human-composed
    // drafts are pinned past it (F-20), so a planted rule-driven draft needs
    // a policy or it is refused before the filter can be judged.
    for (const handle of ['+15551234567', '+15550000001']) {
      h.store.setContactPolicy({ handle, mode: 'auto', updatedAt: at0 });
    }
    plantRule('rule-alpha');
    plantRule('rule-beta');
    const plant = (id: string, ruleId: string | null, chatGuid: string) => {
      const at = h.clockCtl.clock.now();
      h.store.insertDraft({
        id,
        inboundGuid: null,
        chatGuid,
        ruleId,
        adapterId: 'human',
        idempotencyKey: id,
        body: `planted ${id}`,
        originalBody: `planted ${id}`,
        state: 'pending',
        stateChangedAt: at,
        expiresAt: new Date(Date.parse(at) + 3_600_000).toISOString(),
        createdAt: at,
      });
    };
    plant('01AAAAAAAAAAAAAAAAAAAAAAAA', 'rule-alpha', CHAT);
    plant('01BBBBBBBBBBBBBBBBBBBBBBBB', 'rule-beta', CHAT);
    plant('01CCCCCCCCCCCCCCCCCCCCCCCC', null, 'iMessage;-;+15550000001');
    const inRule = { id: '01AAAAAAAAAAAAAAAAAAAAAAAA' };
    const otherRule = { id: '01BBBBBBBBBBBBBBBBBBBBBBBB' };
    const otherContact = { id: '01CCCCCCCCCCCCCCCCCCCCCCCC' };

    const byRule = await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      filter: { rule: 'rule-alpha' },
    });
    expect(byRule.json()).toMatchObject({ matched: 1, applied: 1 });
    expect(h.store.getDraft(inRule.id)?.state).toBe('approved');
    expect(h.store.getDraft(otherRule.id)?.state).toBe('pending');
    expect(h.store.getDraft(otherContact.id)?.state).toBe('pending');

    const byContact = await post(h, '/v1/drafts/bulk', {
      action: 'approve',
      filter: { contact: '+15550000001' },
    });
    expect(byContact.json()).toMatchObject({ matched: 1, applied: 1 });
    expect(h.store.getDraft(otherContact.id)?.state).toBe('approved');
    expect(h.store.getDraft(otherRule.id)?.state).toBe('pending');
  });
});

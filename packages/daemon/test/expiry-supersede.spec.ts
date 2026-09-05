/**
 * s4-execution Scenario 8: expiry visibility, supersede, redraft, and the
 * SMS-retry config field.
 *
 * The through-line is that a draft's END is not its erasure. Expired and
 * superseded drafts leave the working queue but stay readable by explicit
 * state filter, because "why did nothing get sent to this person" is a
 * question you can only answer from the drafts that didn't make it.
 *
 * Redraft (F-40) is a NEW draft, never a resurrection: fresh id, fresh
 * idempotency key, fresh TTL, and it copies `originalBody` rather than
 * `body` so a redraft restores what the agent actually proposed instead of
 * an edit the human already declined to send. The source stays exactly where
 * it was. The `{fromDraftId, toDraftId}` link lives in the audit row and the
 * response, since §2.3's drafts table has no parent column and derived
 * idempotency keys would collide with the UNIQUE dedup agents rely on in S5.
 *
 * Self-ratified flags, as recommended in the slice plan: F-38 (ship the
 * `send.retryAsSms` key only, read by nothing, semantics by S6), F-39 (no WS
 * events for expiry/supersede/redraft in S4; audit rows and queue reads
 * only, preserving the F-3 zero-protocol-additions posture), F-40 (linkage
 * in the audit payload).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SETTING_RETRY_AS_SMS,
  systemActor,
  type AuditEvent,
} from '@wemessage/core';
import {
  auditEvents,
  auditTypes,
  boot,
  cleanupHarness,
  createDraft,
  get,
  post,
  CHAT,
} from './helpers/draft-harness.js';

const REPO_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
);

/** All .ts production files under packages/<pkg>/src (never dist, never test). */
function productionSourceFiles(): string[] {
  const files: string[] = [];
  const packagesDir = join(REPO_ROOT, 'packages');
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const srcDir = join(packagesDir, pkg.name, 'src');
    let entries;
    try {
      entries = readdirSync(srcDir, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files.sort();
}

const PAST_GRACE_MS = 11_000;
/** Comfortably past the 240-minute default TTL. */
const PAST_TTL_MS = 241 * 60_000;

afterEach(async () => {
  await cleanupHarness();
});

describe('s4 Scenario 8: expiry, supersede, redraft, retryAsSms', () => {
  it('an expired draft leaves the queue but stays readable by state filter', async () => {
    const h = await boot();
    const draft = await createDraft(h, 'nobody answered');
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();

    expect(h.store.getDraft(draft.id)?.state).toBe('expired');
    const queue = (await get(h, '/v1/drafts')).json() as {
      drafts: Array<{ id: string }>;
    };
    expect(queue.drafts.map((d) => d.id)).not.toContain(draft.id);

    // History is the whole point: the queue hides it, the filter finds it.
    const history = (await get(h, '/v1/drafts?state=expired')).json() as {
      drafts: Array<{ id: string }>;
    };
    expect(history.drafts.map((d) => d.id)).toContain(draft.id);
  });

  it('supersede parks the old draft under the system actor and leaves the queue', async () => {
    const h = await boot();
    const first = await createDraft(h, 'first take');
    const second = await createDraft(h, 'better take');

    // The production trigger is S5's rule re-fire; here the transition is
    // minted directly, which is exactly the layer S4 owns.
    const at = h.clockCtl.clock.now();
    h.store.applyDraftTransition({
      id: first.id,
      from: 'pending',
      to: 'superseded',
      at,
    });
    h.sink.append(
      {
        type: 'draft.superseded',
        draftId: first.id,
        supersededBy: second.id,
      },
      systemActor('supersede'),
    );

    expect(h.store.getDraft(first.id)?.state).toBe('superseded');
    const queue = (await get(h, '/v1/drafts')).json() as {
      drafts: Array<{ id: string }>;
    };
    expect(queue.drafts.map((d) => d.id)).toEqual([second.id]);

    const row = auditEvents(h.store).find(
      (e) => e.type === 'draft.superseded',
    ) as { supersededBy?: string } | undefined;
    expect(row?.supersededBy).toBe(second.id);
  });

  it('redraft mints a NEW pending draft from originalBody and leaves the source expired', async () => {
    const h = await boot();
    // Straightforward path: a plain draft that timed out.
    const lapsed = await createDraft(h, 'plain proposal');
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(lapsed.id)?.state).toBe('expired');

    const res = await post(h, `/v1/drafts/${lapsed.id}/redraft`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      fromDraftId: string;
      draft: {
        id: string;
        body: string;
        state: string;
        chatGuid: string;
        ruleId: string | null;
        adapterId: string;
        idempotencyKey: string;
        expiresAt: string;
      };
    };
    expect(body.fromDraftId).toBe(lapsed.id);
    expect(body.draft.id).not.toBe(lapsed.id);
    expect(body.draft.state).toBe('pending');
    expect(body.draft.body).toBe(lapsed.originalBody);
    expect(body.draft.chatGuid).toBe(CHAT);
    expect(body.draft.adapterId).toBe(lapsed.adapterId);
    expect(body.draft.ruleId).toBe(lapsed.ruleId);
    expect(body.draft.idempotencyKey).not.toBe(lapsed.idempotencyKey);
    // Fresh TTL measured from now, not the source's long-dead deadline.
    expect(Date.parse(body.draft.expiresAt)).toBeGreaterThan(
      Date.parse(lapsed.expiresAt),
    );
    // The source is history and stays history.
    expect(h.store.getDraft(lapsed.id)?.state).toBe('expired');

    const link = auditEvents(h.store).find(
      (e) => e.type === 'draft.redrafted',
    ) as { fromDraftId?: string; toDraftId?: string } | undefined;
    expect(link).toMatchObject({
      fromDraftId: lapsed.id,
      toDraftId: body.draft.id,
    });
  });

  it('redraft restores originalBody even when the source was edited', async () => {
    const h = await boot();
    const source = await createDraft(h, 'agent original');
    await post(h, `/v1/drafts/${source.id}/approve`, {
      editedBody: 'human edit that never went out',
    });
    await post(h, `/v1/drafts/${source.id}/recall`);
    expect(h.store.getDraft(source.id)?.body).toBe(
      'human edit that never went out',
    );

    const res = await post(h, `/v1/drafts/${source.id}/redraft`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { draft: { body: string } }).draft.body).toBe(
      'agent original',
    );
  });

  it('redraft of a live or already-sent draft is a 409', async () => {
    const h = await boot();
    const pending = await createDraft(h, 'still live');
    const pendingRes = await post(h, `/v1/drafts/${pending.id}/redraft`);
    expect(pendingRes.statusCode).toBe(409);
    expect(pendingRes.json()).toMatchObject({ error: 'illegal-redraft' });

    const sent = await createDraft(h, 'gone already');
    await post(h, `/v1/drafts/${sent.id}/approve`);
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(sent.id)?.state).toBe('sent');
    expect((await post(h, `/v1/drafts/${sent.id}/redraft`)).statusCode).toBe(
      409,
    );
  });

  it('a redrafted draft is an ordinary pending draft: approve, grace, tick, sent', async () => {
    const h = await boot();
    const source = await createDraft(h, 'try again later');
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();

    const redraft = (
      (await post(h, `/v1/drafts/${source.id}/redraft`)).json() as {
        draft: { id: string };
      }
    ).draft;
    expect((await post(h, `/v1/drafts/${redraft.id}/approve`)).statusCode).toBe(
      200,
    );
    h.clockCtl.advance(PAST_GRACE_MS);
    await h.scheduler.tick();
    expect(h.store.getDraft(redraft.id)?.state).toBe('sent');
  });

  it('F-38: send.retryAsSms exists, defaults to absent, and nothing acts on it', async () => {
    const h = await boot();
    expect(SETTING_RETRY_AS_SMS).toBe('send.retryAsSms');
    // Absent, treated as '0'. S4 ships the key, not the behaviour.
    expect(h.store.getSetting(SETTING_RETRY_AS_SMS)).toBeNull();
    h.store.setSetting(SETTING_RETRY_AS_SMS, '1');
    expect(h.store.getSetting(SETTING_RETRY_AS_SMS)).toBe('1');

    // The grep row. A config key that some code path quietly honours while
    // the semantics are still undecided (global vs per-contact, whether SMS
    // send is v1 at all) is worse than no key: it would ship an untested
    // fallback that silently re-sends over a different carrier.
    //
    // s7 Sc4 adds the SECOND file, and the distinction it draws is why this
    // row's title changed from "nothing reads it" to "nothing ACTS on it".
    // `settings/schema.ts` is the closed list behind `/v1/settings`: it
    // reads the key to show the operator its value and writes the key when
    // they change it, and that is the whole of its involvement. No send
    // path, no retry, no carrier decision consults it, which is the property
    // F-38 was protecting. A third file here means somebody gave the key
    // behaviour, and that is a decision this row wants a reviewer to see.
    const readers = productionSourceFiles()
      .filter((abs) => {
        const text = readFileSync(abs, 'utf8');
        return (
          text.includes('retryAsSms') || text.includes('SETTING_RETRY_AS_SMS')
        );
      })
      .map((abs) => relative(REPO_ROOT, abs));
    expect(readers).toEqual([
      'packages/core/src/gate/index.ts',
      'packages/daemon/src/settings/schema.ts',
    ]);
  });

  it('F-39: expiry, supersede and redraft emit audit rows but no WS events', async () => {
    const h = await boot();
    const source = await createDraft(h, 'quiet lifecycle');
    h.clockCtl.advance(PAST_TTL_MS);
    await h.scheduler.tick();
    await post(h, `/v1/drafts/${source.id}/redraft`);

    // The record exists.
    expect(auditTypes(h.store)).toEqual(
      expect.arrayContaining([
        'draft.expired',
        'draft.created',
        'draft.redrafted',
      ]),
    );

    // The courtesy deliberately does not. Protocol carries no such event
    // types, so a broadcast would be an untyped frame no client understands.
    for (const abs of productionSourceFiles()) {
      const text = readFileSync(abs, 'utf8');
      for (const banned of [
        'draft.expired',
        'draft.superseded',
        'draft.redrafted',
      ]) {
        expect(text).not.toContain(`event: '${banned}'`);
      }
    }
    const vocabulary = readFileSync(
      join(REPO_ROOT, 'packages/protocol/src/index.ts'),
      'utf8',
    );
    for (const banned of [
      'draft.expired',
      'draft.superseded',
      'draft.redrafted',
    ]) {
      expect(vocabulary).not.toContain(banned);
    }
  });
});

/** Narrowing helper kept honest against the union rather than `any`. */
export type _AuditEventPinned = AuditEvent;

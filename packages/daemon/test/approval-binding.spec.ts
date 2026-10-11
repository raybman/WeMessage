/**
 * v2 F6d: the content-bound approval. A file draft is sent only when the
 * hash its approval authorised, the hash the draft carries and the hash of
 * the outbox bytes on disk at send time all agree.
 *
 * Every byte is generated here (syntheticPng). The loopback backend counts
 * its calls, which is how "never reaches the backend" is proved rather than
 * assumed. F6d has no file send yet (F6e), so an agreeing file draft fails
 * 'backend-error' with no backend call; what these rows pin is that a
 * disagreeing one fails EARLIER, as a mismatch, before anything else.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { Draft } from '@wemessage/core';
import { syntheticPng } from '@wemessage/fixtures';
import { SETTING_SEND_ATTACHMENTS } from '@wemessage/daemon';
import {
  auditEvents,
  boot,
  cleanupHarness,
  CHAT,
  post,
  T0,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function on(): Promise<Harness> {
  const h = await boot({ outbox: true, send: true });
  h.store.setSetting(SETTING_SEND_ATTACHMENTS, '1');
  return h;
}

async function stage(h: Harness, bytes: Buffer, name = 'grey.png') {
  const r = await h.server.app.inject({
    method: 'POST',
    url: '/v1/attachments/staged',
    headers: {
      ...h.headers,
      'content-type': 'image/png',
      'x-wemessage-name': name,
    },
    payload: bytes,
  });
  expect(r.statusCode).toBe(200);
  return r.json() as { stageId: string };
}

async function sendFile(h: Harness, stageId: string) {
  const r = await post(h, '/v1/send', { chatGuid: CHAT, file: stageId });
  expect(r.statusCode).toBe(200);
  return r.json() as {
    draftId: string;
    outcome: string;
    error?: { code: string; message: string };
  };
}

function approvalsOf(h: Harness, draftId: string): string[] {
  return auditEvents(h.store)
    .filter(
      (e): e is Extract<typeof e, { type: 'draft.approved' }> =>
        e.type === 'draft.approved' && e.draftId === draftId,
    )
    .map((e) => e.approvalId);
}

describe('v2 F6d: approval binds the file by hash', () => {
  it('approveWritesHashInSameTxn', async () => {
    const h = await on();
    const png = syntheticPng(8, 8);
    const { stageId } = await stage(h, png);
    expect(stageId).toBe(sha(png));
    const sent = await sendFile(h, stageId);
    const [approvalId] = approvalsOf(h, sent.draftId);
    expect(approvalId).toBeDefined();
    // The approval row and the hash it authorised are one write.
    expect(h.store.getApproval(approvalId!)?.action).toBe('approve');
    expect(h.store.getApprovalFile(approvalId!)).toBe(sha(png));
    expect(h.store.getDraftFile(sent.draftId)?.sha256).toBe(sha(png));
    // F6d: the file send itself is F6e; an agreeing draft gets that far.
    expect(sent.outcome).toBe('failed');
    expect(sent.error?.code).toBe('backend-error');
    expect(h.backend.callCount()).toBe(0);

    // Atomic: an approval whose hash cannot be written writes neither.
    const draft: Draft = {
      id: ulid(),
      inboundGuid: null,
      chatGuid: CHAT,
      ruleId: null,
      adapterId: 'human',
      idempotencyKey: ulid(),
      body: '',
      originalBody: '',
      state: 'pending',
      stateChangedAt: T0,
      expiresAt: T0,
      createdAt: T0,
    };
    h.store.bindDraftFile(draft, sha(png), T0);
    const second = ulid();
    h.store.insertApproval({
      id: second,
      draftId: draft.id,
      action: 'approve',
      actor: { kind: 'human', via: 'api' },
      at: T0,
    });
    expect(() =>
      h.store.insertApproval({
        id: second,
        draftId: draft.id,
        action: 'approve',
        actor: { kind: 'human', via: 'api' },
        at: T0,
      }),
    ).toThrow();
    expect(h.store.getApprovalFile(second)).toBe(sha(png));
    // A reject authorises nothing.
    const reject = ulid();
    h.store.insertApproval({
      id: reject,
      draftId: draft.id,
      action: 'reject',
      actor: { kind: 'human', via: 'api' },
      at: T0,
    });
    expect(h.store.getApprovalFile(reject)).toBeNull();
  });

  it('swappedOutboxFileFailsMismatchAndNeverCallsBackend', async () => {
    const h = await on();
    const png = syntheticPng(8, 8);
    const { stageId } = await stage(h, png);
    // Same name, other bytes, after staging and before the send.
    const path = join(h.dir, 'outbox', stageId, 'grey.png');
    const swapped = syntheticPng(8, 8, 40);
    expect(sha(swapped)).not.toBe(stageId);
    writeFileSync(path, swapped);

    const sent = await sendFile(h, stageId);
    expect(sent.outcome).toBe('failed');
    expect(sent.error?.code).toBe('attachment-mismatch');
    expect(h.backend.callCount()).toBe(0);
    expect(h.store.getDraft(sent.draftId)?.state).toBe('failed');
    // The refusal burns no send attempt: nothing was attempted.
    expect(h.store.sendAttemptCount(sent.draftId)).toBe(0);
    const failed = auditEvents(h.store).find(
      (e) => e.type === 'draft.failed' && e.draftId === sent.draftId,
    );
    expect(failed).toBeDefined();
    // A deleted file is missing, not mismatched, and also never sent.
    const other = syntheticPng(4, 4);
    const second = await stage(h, other, 'b.png');
    writeFileSync(join(h.dir, 'outbox', second.stageId, 'b.png'), '');
    const gone = await sendFile(h, second.stageId);
    expect(['attachment-mismatch', 'attachment-missing']).toContain(
      gone.error?.code,
    );
    expect(h.backend.callCount()).toBe(0);
  });

  it('a missing outbox file is attachment-missing', async () => {
    const h = await on();
    const png = syntheticPng(5, 5);
    const { stageId } = await stage(h, png);
    const { rmSync } = await import('node:fs');
    rmSync(join(h.dir, 'outbox', stageId), { recursive: true, force: true });
    const sent = await sendFile(h, stageId);
    expect(sent.error?.code).toBe('attachment-missing');
    expect(h.backend.callCount()).toBe(0);
  });

  it('retryRechecksHash', async () => {
    const h = await on();
    const png = syntheticPng(8, 8);
    const { stageId } = await stage(h, png);
    const first = await sendFile(h, stageId);
    // F6d: an agreeing draft fails at the not-yet-wired send.
    expect(first.error?.code).toBe('backend-error');

    // The bytes change between the failure and the retry.
    writeFileSync(
      join(h.dir, 'outbox', stageId, 'grey.png'),
      syntheticPng(8, 8, 200),
    );
    const retry = await post(h, `/v1/drafts/${first.draftId}/retry`);
    expect(retry.statusCode).toBe(200);
    // The retry's approval re-binds the same hash (one write with it).
    const approvals = approvalsOf(h, first.draftId);
    expect(approvals).toHaveLength(2);
    expect(h.store.getApprovalFile(approvals[1]!)).toBe(stageId);

    h.clockCtl.advance(60_000);
    await h.scheduler.tick();
    const failed = auditEvents(h.store).filter(
      (e) => e.type === 'draft.failed' && e.draftId === first.draftId,
    );
    expect(failed).toHaveLength(2);
    expect((failed[1] as { error: { code: string } }).error.code).toBe(
      'attachment-mismatch',
    );
    expect(h.backend.callCount()).toBe(0);
  });

  it('a file draft retry is refused while attachments are off', async () => {
    const h = await on();
    const { stageId } = await stage(h, syntheticPng(3, 3));
    const first = await sendFile(h, stageId);
    h.store.setSetting(SETTING_SEND_ATTACHMENTS, '0');
    const retry = await post(h, `/v1/drafts/${first.draftId}/retry`);
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: 'attachments-unproven' });
  });

  it('fileDraftEditIs409', async () => {
    const h = await on();
    const png = syntheticPng(8, 8);
    const { stageId } = await stage(h, png);
    // A pending file draft (no product path mints one in F6d: POST /v1/send
    // mints approved; this row pins the guard that keeps one honest).
    const draft: Draft = {
      id: ulid(),
      inboundGuid: null,
      chatGuid: CHAT,
      ruleId: null,
      adapterId: 'human',
      idempotencyKey: ulid(),
      body: '',
      originalBody: '',
      state: 'pending',
      stateChangedAt: T0,
      expiresAt: new Date(Date.parse(T0) + 3_600_000).toISOString(),
      createdAt: T0,
    };
    h.store.bindDraftFile(draft, stageId, T0);
    const edited = await post(h, `/v1/drafts/${draft.id}/approve`, {
      editedBody: 'surprise text',
    });
    expect(edited.statusCode).toBe(409);
    expect(edited.json()).toEqual({ error: 'file-draft-not-editable' });
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');
    // Redraft would copy text it does not have: refused the same way.
    const rejected = await post(h, `/v1/drafts/${draft.id}/reject`);
    expect(rejected.statusCode).toBe(200);
    const redraft = await post(h, `/v1/drafts/${draft.id}/redraft`);
    expect(redraft.statusCode).toBe(409);
    expect(redraft.json()).toEqual({ error: 'file-draft-not-editable' });
  });
});

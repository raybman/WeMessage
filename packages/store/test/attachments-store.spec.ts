/**
 * v2 F6d: the store half of staging and the content-bound approval
 * (0004_attachments.sql). Real temp-dir SqliteStore, fake Clock. Hashes are
 * synthetic hex; no file bytes are involved at this layer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, Draft, StagedFile } from '@wemessage/core';
import { humanApiActor } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

const T0 = '2026-09-01T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function clock(): Clock {
  return { now: () => T0, nowMs: () => Date.parse(T0) };
}

function staged(sha256: string, stagedAt = T0): StagedFile {
  return {
    sha256,
    name: 'grey.png',
    mime: 'image/png',
    bytes: 42,
    stagedAt,
    removedAt: null,
  };
}

function draft(id: string, partial: Partial<Draft> = {}): Draft {
  return {
    id,
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15550001111',
    ruleId: null,
    adapterId: 'human',
    idempotencyKey: `idem-${id}`,
    body: '',
    originalBody: '',
    state: 'approved',
    stateChangedAt: T0,
    expiresAt: T0,
    createdAt: T0,
    ...partial,
  };
}

describe('v2 F6d: staged files, draft files, approval files', () => {
  let dir: string;
  let store: SqliteStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wm-f6d-store-'));
    store = openStore({ dir, clock: clock() });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('insertStagedFile is idempotent by hash and a re-stage clears removed', () => {
    expect(store.insertStagedFile(staged(A))).toEqual(staged(A));
    expect(store.sweepStaged(at(DAY), DAY, DAY)).toEqual([A]);
    expect(store.getStagedFile(A)?.removedAt).toBe(at(DAY));
    const again = store.insertStagedFile(staged(A, at(DAY + 1)));
    expect(again.removedAt).toBeNull();
    expect(again.stagedAt).toBe(at(DAY + 1));
    expect(store.getStagedFile(B)).toBeNull();
  });

  it('bindDraftFile writes the draft and its file together, or neither', () => {
    store.insertStagedFile(staged(A));
    store.bindDraftFile(draft('d1'), A, T0);
    expect(store.getDraft('d1')?.state).toBe('approved');
    expect(store.getDraftFile('d1')?.sha256).toBe(A);
    // Unstaged: throws, and no draft is left behind.
    expect(() => store.bindDraftFile(draft('d2'), B, T0)).toThrow(/not staged/);
    expect(store.getDraft('d2')).toBeNull();
    // Swept: the same.
    const C = 'c'.repeat(64);
    store.insertStagedFile(staged(C));
    expect(store.sweepStaged(at(10 * DAY), DAY, DAY)).toEqual([C]);
    expect(() => store.bindDraftFile(draft('d3'), C, T0)).toThrow(/not staged/);
    expect(store.getDraft('d3')).toBeNull();
    // A text draft carries no file.
    store.insertDraft(draft('t1', { body: 'hi', originalBody: 'hi' }));
    expect(store.getDraftFile('t1')).toBeNull();
  });

  it('only an approve of a file draft records a hash', () => {
    store.insertStagedFile(staged(A));
    store.bindDraftFile(draft('d1', { state: 'pending' }), A, T0);
    store.insertDraft(
      draft('t1', { body: 'hi', originalBody: 'hi', state: 'pending' }),
    );
    const actor = humanApiActor();
    store.insertApproval({
      id: 'ap1',
      draftId: 'd1',
      action: 'approve',
      actor,
      at: T0,
    });
    store.insertApproval({
      id: 'ap2',
      draftId: 't1',
      action: 'approve',
      actor,
      at: T0,
    });
    store.insertApproval({
      id: 'rj1',
      draftId: 'd1',
      action: 'reject',
      actor,
      at: T0,
    });
    expect(store.getApprovalFile('ap1')).toBe(A);
    expect(store.getApprovalFile('ap2')).toBeNull();
    expect(store.getApprovalFile('rj1')).toBeNull();
  });

  it('sweepStaged: unbound after the window, bound only after its draft ends', () => {
    store.insertStagedFile(staged(A));
    store.insertStagedFile(staged(B));
    store.bindDraftFile(
      draft('d1', { state: 'pending', expiresAt: at(DAY) }),
      B,
      T0,
    );
    expect(store.sweepStaged(at(DAY - 1), DAY, DAY)).toEqual([]);
    expect(store.sweepStaged(at(DAY), DAY, DAY)).toEqual([A]);
    // B is bound to a live draft: never swept, however old.
    expect(store.sweepStaged(at(30 * DAY), DAY, DAY)).toEqual([]);
    store.applyDraftTransition({
      id: 'd1',
      from: 'pending',
      to: 'rejected',
      at: at(30 * DAY),
    });
    expect(store.sweepStaged(at(31 * DAY - 1), DAY, DAY)).toEqual([]);
    expect(store.sweepStaged(at(31 * DAY), DAY, DAY)).toEqual([B]);
    // Already removed: not reported twice.
    expect(store.sweepStaged(at(40 * DAY), DAY, DAY)).toEqual([]);
  });
});

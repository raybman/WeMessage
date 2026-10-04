/**
 * s10 Slice 2: the store half of late verification.
 *
 *  - `getSendLedger(draftId)`: the first attempt's window. The dispatcher
 *    reads it BEFORE `beginSendAttempt`, because `#bumpLedgerAttempt`
 *    overwrites `started_at` on every retry.
 *  - `applyDraftTransition({..., sentMessageGuid})`: late verification
 *    persists through the same CAS transaction as every other transition,
 *    never through the unguarded `markDraftSent`. Draft guid, cleared error,
 *    and ledger verified_guid/finished_at land together or not at all.
 *  - `listRecentUnverified(since, limit)`: the sweep's bounded read.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, Draft, DraftError } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

const T0 = '2026-10-04T12:00:00.000Z';

function fakeClock(iso = T0): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

function makeDraft(partial: Partial<Draft> & { id: string }): Draft {
  return {
    inboundGuid: null,
    chatGuid: 'any;-;+15557654321',
    ruleId: null,
    adapterId: 'human',
    idempotencyKey: `idem-${partial.id}`,
    body: 'on my way',
    originalBody: 'on my way',
    state: 'approved',
    stateChangedAt: T0,
    expiresAt: '2026-10-04T16:00:00.000Z',
    createdAt: T0,
    ...partial,
  };
}

const unverified = (at: string): DraftError => ({
  code: 'unverified',
  message: 'verify poll timed out',
  at,
});

describe('s10 Sl2: store late-verification surface', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-late-verify-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** approved -> sending (ledger row) -> failed 'unverified'. */
  function failUnverified(id: string, startedAt: string, failedAt: string) {
    store.insertDraft(makeDraft({ id }));
    store.beginSendAttempt(id, 'loopback', startedAt);
    store.markDraftFailed(id, unverified(failedAt), failedAt);
  }

  describe('getSendLedger', () => {
    it('is null for a draft that was never dispatched', () => {
      store.insertDraft(makeDraft({ id: 'D0' }));
      expect(store.getSendLedger('D0')).toBeNull();
      expect(store.getSendLedger('NOPE')).toBeNull();
    });

    it('reports attempt, startedAt and a null verifiedGuid while open', () => {
      store.insertDraft(makeDraft({ id: 'D1' }));
      store.beginSendAttempt('D1', 'loopback', '2026-10-04T12:00:05.000Z');
      expect(store.getSendLedger('D1')).toEqual({
        attempt: 1,
        startedAt: '2026-10-04T12:00:05.000Z',
        verifiedGuid: null,
      });
    });

    it('reports the verified guid once the send is marked sent', () => {
      store.insertDraft(makeDraft({ id: 'D2' }));
      store.beginSendAttempt('D2', 'loopback', '2026-10-04T12:00:05.000Z');
      store.markDraftSent('D2', 'GUID-2', '2026-10-04T12:00:07.000Z');
      expect(store.getSendLedger('D2')?.verifiedGuid).toBe('GUID-2');
    });
  });

  describe('applyDraftTransition with sentMessageGuid', () => {
    it('failed -> sent writes the draft guid, clears the error, and closes the ledger', () => {
      failUnverified(
        'D3',
        '2026-10-04T12:00:05.000Z',
        '2026-10-04T12:00:35.000Z',
      );
      const after = store.applyDraftTransition({
        id: 'D3',
        from: 'failed',
        to: 'sent',
        at: '2026-10-04T12:01:00.000Z',
        sentMessageGuid: 'GUID-3',
      });
      expect(after.state).toBe('sent');
      expect(after.sentMessageGuid).toBe('GUID-3');
      expect(after.error).toBeUndefined();
      expect(after.stateChangedAt).toBe('2026-10-04T12:01:00.000Z');
      expect(store.getSendLedger('D3')).toEqual({
        attempt: 1,
        startedAt: '2026-10-04T12:00:05.000Z',
        verifiedGuid: 'GUID-3',
      });
    });

    it('a lost race (from mismatch) writes nothing, ledger included', () => {
      failUnverified(
        'D4',
        '2026-10-04T12:00:05.000Z',
        '2026-10-04T12:00:35.000Z',
      );
      expect(() =>
        store.applyDraftTransition({
          id: 'D4',
          from: 'approved',
          to: 'sent',
          at: '2026-10-04T12:01:00.000Z',
          sentMessageGuid: 'GUID-4',
        }),
      ).toThrow(/is 'failed'/);
      const d = store.getDraft('D4');
      expect(d?.state).toBe('failed');
      expect(d?.sentMessageGuid).toBeUndefined();
      expect(d?.error?.code).toBe('unverified');
      expect(store.getSendLedger('D4')?.verifiedGuid).toBeNull();
    });

    it('a transition without sentMessageGuid leaves guid, error and ledger alone', () => {
      failUnverified(
        'D5',
        '2026-10-04T12:00:05.000Z',
        '2026-10-04T12:00:35.000Z',
      );
      store.applyDraftTransition({
        id: 'D5',
        from: 'failed',
        to: 'approved',
        at: '2026-10-04T12:01:00.000Z',
      });
      const d = store.getDraft('D5');
      expect(d?.sentMessageGuid).toBeUndefined();
      expect(d?.error?.code).toBe('unverified');
      expect(store.getSendLedger('D5')?.verifiedGuid).toBeNull();
    });
  });

  describe('listRecentUnverified', () => {
    it('returns failed/unverified drafts changed at or after since, oldest first', () => {
      failUnverified(
        'A',
        '2026-10-04T11:40:00.000Z',
        '2026-10-04T11:40:30.000Z',
      );
      failUnverified(
        'B',
        '2026-10-04T11:50:00.000Z',
        '2026-10-04T11:50:30.000Z',
      );
      failUnverified(
        'C',
        '2026-10-04T11:55:00.000Z',
        '2026-10-04T11:55:30.000Z',
      );
      const ids = store
        .listRecentUnverified('2026-10-04T11:45:00.000Z', 20)
        .map((d) => d.id);
      expect(ids).toEqual(['B', 'C']);
    });

    it('excludes other failure codes and non-failed states', () => {
      failUnverified(
        'U',
        '2026-10-04T11:50:00.000Z',
        '2026-10-04T11:50:30.000Z',
      );
      store.insertDraft(makeDraft({ id: 'X' }));
      store.beginSendAttempt('X', 'loopback', '2026-10-04T11:51:00.000Z');
      store.markDraftFailed(
        'X',
        { code: 'backend-error', message: 'osascript 1', at: T0 },
        '2026-10-04T11:51:30.000Z',
      );
      store.insertDraft(
        makeDraft({ id: 'P', state: 'pending', stateChangedAt: T0 }),
      );
      // A draft that late-verified already: sent, error cleared.
      failUnverified(
        'S',
        '2026-10-04T11:52:00.000Z',
        '2026-10-04T11:52:30.000Z',
      );
      store.applyDraftTransition({
        id: 'S',
        from: 'failed',
        to: 'sent',
        at: '2026-10-04T11:53:00.000Z',
        sentMessageGuid: 'GUID-S',
      });
      const ids = store
        .listRecentUnverified('2026-10-04T11:45:00.000Z', 20)
        .map((d) => d.id);
      expect(ids).toEqual(['U']);
    });

    it('honours the limit', () => {
      for (let i = 0; i < 5; i++) {
        failUnverified(
          `L${i}`,
          `2026-10-04T11:5${i}:00.000Z`,
          `2026-10-04T11:5${i}:30.000Z`,
        );
      }
      const ids = store
        .listRecentUnverified('2026-10-04T11:45:00.000Z', 3)
        .map((d) => d.id);
      expect(ids).toEqual(['L0', 'L1', 'L2']);
    });
  });
});

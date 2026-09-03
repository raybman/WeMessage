/**
 * s4-execution.md Part 2 Scenario 3 — Store body extensions.
 * ★ CHECKPOINT `draft-lifecycle.spec.ts` (persistence half; the pure half is
 * packages/core/test/draft-transitions.spec.ts, Scenario 2).
 *
 * §2.3 already has every table and constraint these methods need (drafts'
 * UNIQUE(adapter_id, idempotency_key), contact_policies, settings.version) —
 * no migration, only new SqliteStore methods (§1.5).
 *
 * The load-bearing property here is roadmap risk #1: `applyDraftTransition`
 * re-asserts `from` INSIDE the transaction, so persistence can never drift
 * from core's pure table and two racing transitions cannot both win.
 *
 * Teeth (proven-then-reverted, see commit message): drop the in-transaction
 * from-assertion -> the race test fails; make `listGraceElapsed` ignore the
 * NULL `send_not_before` guard -> the C-2 row fails (a direct-send draft
 * would be double-dispatched by the scheduler).
 *
 * Real temp-dir SqliteStore, fake Clock (§4.0) — same conventions as
 * send-foundations.spec.ts / rules-store.spec.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Approval,
  Clock,
  ContactPolicy,
  Draft,
  DraftError,
} from '@wemessage/core';
import { humanApiActor, systemActor } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

const T0 = '2026-09-01T12:00:00.000Z';

function fakeClock(iso = T0): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

function makeDraft(partial: Partial<Draft> & { id: string }): Draft {
  return {
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15550001111',
    ruleId: null,
    adapterId: 'human',
    idempotencyKey: `idem-${partial.id}`,
    body: 'confirmed for 3pm',
    originalBody: 'confirmed for 3pm',
    state: 'pending',
    stateChangedAt: T0,
    expiresAt: '2026-09-01T16:00:00.000Z',
    createdAt: T0,
    ...partial,
  };
}

function makeApproval(
  partial: Partial<Approval> & { id: string; draftId: string },
): Approval {
  return {
    action: 'approve',
    actor: humanApiActor(),
    at: T0,
    ...partial,
  };
}

const ERR: DraftError = {
  // F-30: dispatch-time gate denial. The GateDenyReason rides in `message`.
  code: 'gate-denied',
  message: 'gate denied: kill-switch',
  at: T0,
};

describe('store draft lifecycle (s4 Scenario 3)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-draft-store-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('applyDraftTransition', () => {
    it('happy path writes state, state_changed_at, and the optional columns', () => {
      store.insertDraft(makeDraft({ id: 'd1' }));
      const out = store.applyDraftTransition({
        id: 'd1',
        from: 'pending',
        to: 'approved',
        at: '2026-09-01T12:05:00.000Z',
        sendNotBefore: '2026-09-01T12:05:10.000Z',
      });
      expect(out.state).toBe('approved');
      expect(out.stateChangedAt).toBe('2026-09-01T12:05:00.000Z');
      expect(out.sendNotBefore).toBe('2026-09-01T12:05:10.000Z');
      expect(store.getDraft('d1')).toEqual(out);
    });

    it('approve-with-edit writes body and leaves originalBody byte-identical', () => {
      store.insertDraft(
        makeDraft({
          id: 'd1',
          body: 'original text',
          originalBody: 'original text',
        }),
      );
      const out = store.applyDraftTransition({
        id: 'd1',
        from: 'pending',
        to: 'approved',
        at: '2026-09-01T12:05:00.000Z',
        body: 'edited text',
      });
      expect(out.body).toBe('edited text');
      expect(out.originalBody).toBe('original text');
    });

    it('sendNotBefore: null CLEARS the column (recall/reject)', () => {
      store.insertDraft(
        makeDraft({
          id: 'd1',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:10.000Z',
        }),
      );
      const out = store.applyDraftTransition({
        id: 'd1',
        from: 'approved',
        to: 'recalled',
        at: '2026-09-01T12:00:05.000Z',
        sendNotBefore: null,
      });
      expect(out.sendNotBefore).toBeUndefined();
    });

    it('omitting sendNotBefore leaves the existing value alone', () => {
      store.insertDraft(
        makeDraft({
          id: 'd1',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:10.000Z',
        }),
      );
      const out = store.applyDraftTransition({
        id: 'd1',
        from: 'approved',
        to: 'sending',
        at: '2026-09-01T12:00:11.000Z',
      });
      expect(out.sendNotBefore).toBe('2026-09-01T12:00:10.000Z');
    });

    it('error is persisted on the failed transition', () => {
      store.insertDraft(makeDraft({ id: 'd1', state: 'sending' }));
      const out = store.applyDraftTransition({
        id: 'd1',
        from: 'sending',
        to: 'failed',
        at: '2026-09-01T12:06:00.000Z',
        error: ERR,
      });
      expect(out.error).toEqual(ERR);
    });

    it('accepts a from-state ARRAY (one method, many callers)', () => {
      store.insertDraft(makeDraft({ id: 'd1', state: 'approved' }));
      const out = store.applyDraftTransition({
        id: 'd1',
        from: ['pending', 'approved'],
        to: 'rejected',
        at: '2026-09-01T12:07:00.000Z',
      });
      expect(out.state).toBe('rejected');
    });

    it('from-state MISMATCH throws with ZERO writes (asserted by re-read)', () => {
      store.insertDraft(makeDraft({ id: 'd1', state: 'sent' }));
      const before = store.getDraft('d1');
      expect(() =>
        store.applyDraftTransition({
          id: 'd1',
          from: 'pending',
          to: 'approved',
          at: '2026-09-01T12:09:00.000Z',
          sendNotBefore: '2026-09-01T12:09:10.000Z',
        }),
      ).toThrow(/is 'sent', expected one of \[pending\]/);
      // The whole point: nothing moved, not even the optional columns.
      expect(store.getDraft('d1')).toEqual(before);
    });

    it('two racing transitions on one draft: the SECOND throws (risk #1 teeth)', () => {
      store.insertDraft(makeDraft({ id: 'd1' }));
      const first = store.applyDraftTransition({
        id: 'd1',
        from: 'pending',
        to: 'approved',
        at: '2026-09-01T12:05:00.000Z',
      });
      expect(first.state).toBe('approved');
      // Same transition replayed — the generalized `beginSendAttempt`
      // posture: the second caller reads the already-written state.
      expect(() =>
        store.applyDraftTransition({
          id: 'd1',
          from: 'pending',
          to: 'approved',
          at: '2026-09-01T12:05:01.000Z',
        }),
      ).toThrow(/is 'approved', expected one of \[pending\]/);
      expect(store.getDraft('d1')?.stateChangedAt).toBe(
        '2026-09-01T12:05:00.000Z',
      );
    });

    it('throws on an unknown draft', () => {
      expect(() =>
        store.applyDraftTransition({
          id: 'nope',
          from: 'pending',
          to: 'approved',
          at: T0,
        }),
      ).toThrow(/no such draft/);
    });
  });

  describe('updateDraftBody', () => {
    it('edits body while pending; original_body is never written', () => {
      store.insertDraft(
        makeDraft({ id: 'd1', body: 'first', originalBody: 'first' }),
      );
      store.updateDraftBody('d1', 'second', '2026-09-01T12:02:00.000Z');
      const d = store.getDraft('d1');
      expect(d?.body).toBe('second');
      expect(d?.originalBody).toBe('first');
      // A second edit still does not touch the evidence column.
      store.updateDraftBody('d1', 'third', '2026-09-01T12:03:00.000Z');
      expect(store.getDraft('d1')?.originalBody).toBe('first');
    });

    it('pending-only: any other state throws with zero writes', () => {
      store.insertDraft(
        makeDraft({ id: 'd1', state: 'approved', body: 'frozen' }),
      );
      const before = store.getDraft('d1');
      expect(() => store.updateDraftBody('d1', 'nope', T0)).toThrow(
        /is 'approved', not 'pending'/,
      );
      expect(store.getDraft('d1')).toEqual(before);
    });
  });

  describe('listDrafts', () => {
    beforeEach(() => {
      store.insertDraft(
        makeDraft({ id: 'p1', state: 'pending', ruleId: null }),
      );
      store.insertDraft(
        makeDraft({
          id: 'a1',
          state: 'approved',
          createdAt: '2026-09-01T12:01:00.000Z',
        }),
      );
      store.insertDraft(
        makeDraft({
          id: 's1',
          state: 'sending',
          createdAt: '2026-09-01T12:02:00.000Z',
        }),
      );
      // Terminal rows: history, never queue.
      for (const [i, st] of (
        [
          'sent',
          'rejected',
          'expired',
          'superseded',
          'recalled',
          'failed',
        ] as const
      ).entries()) {
        store.insertDraft(
          makeDraft({
            id: `t${i}`,
            state: st,
            createdAt: `2026-09-01T12:1${i}:00.000Z`,
          }),
        );
      }
    });

    it('queue default excludes every terminal state', () => {
      const ids = store.listDrafts().map((d) => d.id);
      expect(ids).toEqual(['p1', 'a1', 's1']);
    });

    it('an explicit state filter reads history (overrides the queue default)', () => {
      expect(store.listDrafts({ state: 'expired' }).map((d) => d.id)).toEqual([
        't2',
      ]);
      expect(store.listDrafts({ state: 'sent' }).map((d) => d.id)).toEqual([
        't0',
      ]);
    });

    it('filters by ruleId with planted rows', () => {
      store.insertRule({
        id: 'r1',
        name: 'r1',
        enabled: true,
        matcher: { kind: 'keyword', keywords: ['x'], mode: 'any' },
        adapterId: 'human',
        respondMode: 'draft-only',
        scheduleId: null,
        outsideWindow: 'queue',
        allowGroupDrafts: false,
        matchAttachmentOnly: false,
        draftTtlMinutes: 240,
        priority: 100,
        createdAt: T0,
        updatedAt: T0,
      });
      store.insertDraft(makeDraft({ id: 'ruled', ruleId: 'r1' }));
      expect(store.listDrafts({ ruleId: 'r1' }).map((d) => d.id)).toEqual([
        'ruled',
      ]);
    });

    it('filters by contact (the handle parsed out of chat_guid)', () => {
      store.insertDraft(
        makeDraft({ id: 'other', chatGuid: 'iMessage;-;+15559998888' }),
      );
      expect(
        store.listDrafts({ contact: '+15559998888' }).map((d) => d.id),
      ).toEqual(['other']);
      // The default-fixture handle still resolves to its own rows only.
      expect(
        store.listDrafts({ contact: '+15550001111' }).map((d) => d.id),
      ).toEqual(['p1', 'a1', 's1']);
    });

    it('filters by batchId, joining through approvals', () => {
      store.insertApproval(
        makeApproval({ id: 'ap1', draftId: 'a1', batchId: 'batch-9' }),
      );
      expect(store.listDrafts({ batchId: 'batch-9' }).map((d) => d.id)).toEqual(
        ['a1'],
      );
      expect(store.listDrafts({ batchId: 'batch-absent' })).toEqual([]);
    });
  });

  describe('F-15 closure: cross-restart idempotency dedup', () => {
    it('a second draft with the same (adapter_id, idempotency_key) raises UNIQUE', () => {
      store.insertDraft(makeDraft({ id: 'd1', idempotencyKey: 'same-key' }));
      expect(() =>
        store.insertDraft(makeDraft({ id: 'd2', idempotencyKey: 'same-key' })),
      ).toThrow(/UNIQUE/i);
    });

    it('the same key under a DIFFERENT adapter is a distinct draft', () => {
      store.db
        .prepare(
          "INSERT INTO adapters (id, kind, display_name) VALUES ('sol', 'sol', 'Sol')",
        )
        .run();
      store.insertDraft(makeDraft({ id: 'd1', idempotencyKey: 'k' }));
      store.insertDraft(
        makeDraft({ id: 'd2', idempotencyKey: 'k', adapterId: 'sol' }),
      );
      expect(store.findDraftByIdempotencyKey('human', 'k')?.id).toBe('d1');
      expect(store.findDraftByIdempotencyKey('sol', 'k')?.id).toBe('d2');
    });

    it('findDraftByIdempotencyKey finds the first ACROSS a close/reopen', () => {
      store.insertDraft(makeDraft({ id: 'd1', idempotencyKey: 'restart-key' }));
      store.close();
      // Cross-restart dedup is the constraint plus this read, never memory.
      store = openStore({ dir, clock: fakeClock() });
      expect(store.findDraftByIdempotencyKey('human', 'restart-key')?.id).toBe(
        'd1',
      );
      expect(store.findDraftByIdempotencyKey('human', 'never-used')).toBeNull();
    });
  });

  describe('latestApproveApproval', () => {
    it('returns the most recent approve row, ignoring reject/recall rows', () => {
      store.insertDraft(makeDraft({ id: 'd1' }));
      store.insertApproval(
        makeApproval({
          id: 'ap1',
          draftId: 'd1',
          at: '2026-09-01T12:01:00.000Z',
        }),
      );
      store.insertApproval(
        makeApproval({
          id: 'ap2',
          draftId: 'd1',
          action: 'recall',
          at: '2026-09-01T12:02:00.000Z',
        }),
      );
      store.insertApproval(
        makeApproval({
          id: 'ap3',
          draftId: 'd1',
          at: '2026-09-01T12:03:00.000Z',
        }),
      );
      const got = store.latestApproveApproval('d1');
      expect(got?.id).toBe('ap3');
      expect(got?.action).toBe('approve');
    });

    it('null when the draft has never been approved (INV-2: no synthesis)', () => {
      store.insertDraft(makeDraft({ id: 'd1' }));
      expect(store.latestApproveApproval('d1')).toBeNull();
    });
  });

  describe('listGraceElapsed', () => {
    it('returns elapsed-grace approved drafts, oldest first, with the approvalId', () => {
      store.insertDraft(
        makeDraft({
          id: 'g2',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:20.000Z',
        }),
      );
      store.insertDraft(
        makeDraft({
          id: 'g1',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:10.000Z',
        }),
      );
      store.insertApproval(makeApproval({ id: 'apG1', draftId: 'g1' }));
      store.insertApproval(makeApproval({ id: 'apG2', draftId: 'g2' }));
      expect(store.listGraceElapsed('2026-09-01T12:00:30.000Z')).toEqual([
        { draftId: 'g1', approvalId: 'apG1' },
        { draftId: 'g2', approvalId: 'apG2' },
      ]);
    });

    it('excludes drafts whose grace has NOT elapsed', () => {
      store.insertDraft(
        makeDraft({
          id: 'g1',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:30.000Z',
        }),
      );
      store.insertApproval(makeApproval({ id: 'apG1', draftId: 'g1' }));
      expect(store.listGraceElapsed('2026-09-01T12:00:10.000Z')).toEqual([]);
    });

    it('C-2: a direct-send draft (send_not_before NULL) is STRUCTURALLY excluded', () => {
      // Without the NULL guard the scheduler would pick this up and
      // double-dispatch a send the send path already owns.
      store.insertDraft(makeDraft({ id: 'direct', state: 'approved' }));
      store.insertApproval(makeApproval({ id: 'apD', draftId: 'direct' }));
      expect(store.getDraft('direct')?.sendNotBefore).toBeUndefined();
      expect(store.listGraceElapsed('2099-01-01T00:00:00.000Z')).toEqual([]);
    });

    it('excludes non-approved states even when send_not_before has elapsed', () => {
      store.insertDraft(
        makeDraft({
          id: 'p',
          state: 'pending',
          sendNotBefore: '2026-09-01T12:00:10.000Z',
        }),
      );
      store.insertApproval(makeApproval({ id: 'apP', draftId: 'p' }));
      expect(store.listGraceElapsed('2026-09-01T12:00:30.000Z')).toEqual([]);
    });
  });

  describe('listExpiredPending', () => {
    it('returns pending drafts at/past expiry, oldest first', () => {
      store.insertDraft(
        makeDraft({ id: 'e2', expiresAt: '2026-09-01T13:00:00.000Z' }),
      );
      store.insertDraft(
        makeDraft({ id: 'e1', expiresAt: '2026-09-01T12:30:00.000Z' }),
      );
      store.insertDraft(
        makeDraft({ id: 'fresh', expiresAt: '2026-09-01T20:00:00.000Z' }),
      );
      expect(
        store.listExpiredPending('2026-09-01T14:00:00.000Z').map((d) => d.id),
      ).toEqual(['e1', 'e2']);
    });

    it('ignores non-pending drafts however stale', () => {
      store.insertDraft(
        makeDraft({
          id: 'old',
          state: 'approved',
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      );
      expect(store.listExpiredPending('2026-09-01T14:00:00.000Z')).toEqual([]);
    });
  });

  describe('cancelGraceApproved', () => {
    it('rejects every in-grace approved draft in ONE transaction and returns them', () => {
      store.insertDraft(
        makeDraft({
          id: 'inGrace1',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:30.000Z',
        }),
      );
      store.insertDraft(
        makeDraft({
          id: 'inGrace2',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:40.000Z',
        }),
      );
      const out = store.cancelGraceApproved('2026-09-01T12:00:10.000Z', ERR);
      expect(out.map((d) => d.id)).toEqual(['inGrace1', 'inGrace2']);
      for (const d of out) {
        expect(d.state).toBe('rejected');
        expect(d.error).toEqual(ERR);
        expect(d.sendNotBefore).toBeUndefined();
      }
      expect(store.getDraft('inGrace1')?.state).toBe('rejected');
    });

    it('leaves ALREADY-elapsed grace drafts untouched (the scheduler race to lose)', () => {
      store.insertDraft(
        makeDraft({
          id: 'elapsed',
          state: 'approved',
          sendNotBefore: '2026-09-01T12:00:05.000Z',
        }),
      );
      const out = store.cancelGraceApproved('2026-09-01T12:00:10.000Z', ERR);
      expect(out).toEqual([]);
      expect(store.getDraft('elapsed')?.state).toBe('approved');
    });

    it('leaves direct-send (NULL grace) and non-approved drafts untouched', () => {
      store.insertDraft(makeDraft({ id: 'direct', state: 'approved' }));
      store.insertDraft(makeDraft({ id: 'pending', state: 'pending' }));
      expect(
        store.cancelGraceApproved('2026-09-01T12:00:10.000Z', ERR),
      ).toEqual([]);
      expect(store.getDraft('direct')?.state).toBe('approved');
      expect(store.getDraft('pending')?.state).toBe('pending');
    });
  });

  describe('batchReport', () => {
    it('counts a mixed-state batch by joining approvals(batch_id) -> drafts.state', () => {
      const states = [
        ['b-sent', 'sent'],
        ['b-failed', 'failed'],
        ['b-recalled', 'recalled'],
        ['b-approved', 'approved'],
        ['b-sending', 'sending'],
        ['b-sending2', 'sending'],
        // pending is deliberately NOT in the report shape — it must not leak in.
        ['b-pending', 'pending'],
      ] as const;
      states.forEach(([id, state], i) => {
        store.insertDraft(makeDraft({ id, state }));
        store.insertApproval(
          makeApproval({ id: `ap-${id}`, draftId: id, batchId: 'batch-1' }),
        );
        void i;
      });
      // A draft in a DIFFERENT batch must not be counted.
      store.insertDraft(makeDraft({ id: 'other', state: 'sent' }));
      store.insertApproval(
        makeApproval({ id: 'ap-other', draftId: 'other', batchId: 'batch-2' }),
      );

      expect(store.batchReport('batch-1')).toEqual({
        sent: 1,
        failed: 1,
        recalled: 1,
        approved: 1,
        sending: 2,
      });
    });

    it('an unknown batch reports all zeros', () => {
      expect(store.batchReport('nope')).toEqual({
        sent: 0,
        failed: 0,
        recalled: 0,
        approved: 0,
        sending: 0,
      });
    });
  });

  describe('contact policies (§2.4.3 ladder)', () => {
    const policy = (partial: Partial<ContactPolicy> = {}): ContactPolicy => ({
      handle: '+15550001111',
      mode: 'draft-only',
      updatedAt: T0,
      ...partial,
    });

    it('round-trips through set/get, including the optional displayName', () => {
      store.setContactPolicy(policy({ displayName: 'Alice' }));
      expect(store.getContactPolicy('+15550001111')).toEqual(
        policy({ displayName: 'Alice' }),
      );
    });

    it('omits displayName entirely when unset (no undefined-valued key)', () => {
      store.setContactPolicy(policy());
      const got = store.getContactPolicy('+15550001111');
      expect(got).toEqual(policy());
      expect(got && 'displayName' in got).toBe(false);
    });

    it('setContactPolicy UPSERTS on the normalized handle', () => {
      store.setContactPolicy(policy({ mode: 'deny' }));
      store.setContactPolicy(
        policy({ mode: 'auto', updatedAt: '2026-09-01T13:00:00.000Z' }),
      );
      expect(store.getContactPolicy('+15550001111')?.mode).toBe('auto');
      expect(store.listContactPolicies()).toHaveLength(1);
    });

    it('unknown handle reads null (= deny-all default, never an implicit allow)', () => {
      expect(store.getContactPolicy('+15559999999')).toBeNull();
    });

    it('delete returns to unknown; false when there was nothing to delete', () => {
      store.setContactPolicy(policy());
      expect(store.deleteContactPolicy('+15550001111')).toBe(true);
      expect(store.getContactPolicy('+15550001111')).toBeNull();
      expect(store.deleteContactPolicy('+15550001111')).toBe(false);
    });

    it('list is handle-ordered', () => {
      store.setContactPolicy(policy({ handle: 'zed@example.com' }));
      store.setContactPolicy(policy({ handle: '+15550001111' }));
      store.setContactPolicy(policy({ handle: 'abe@example.com' }));
      expect(store.listContactPolicies().map((p) => p.handle)).toEqual([
        '+15550001111',
        'abe@example.com',
        'zed@example.com',
      ]);
    });
  });

  describe('getSettingVersion (C-7 per-key counter)', () => {
    it('is -1 for a key that has never been set', () => {
      expect(store.getSettingVersion('send.killSwitch')).toBe(-1);
    });

    it('starts at 0 and increases monotonically across setSetting calls', () => {
      store.setSetting('send.killSwitch', '0');
      expect(store.getSettingVersion('send.killSwitch')).toBe(0);
      store.setSetting('send.killSwitch', '1');
      expect(store.getSettingVersion('send.killSwitch')).toBe(1);
      store.setSetting('send.killSwitch', '1');
      expect(store.getSettingVersion('send.killSwitch')).toBe(2);
    });

    it('counters are PER KEY, not global', () => {
      store.setSetting('a', '1');
      store.setSetting('a', '2');
      store.setSetting('b', '1');
      expect(store.getSettingVersion('a')).toBe(1);
      expect(store.getSettingVersion('b')).toBe(0);
    });
  });

  describe('beginSendAttempt retry extension (C-10, ceiling 3)', () => {
    /** failed -> approved, the retry precondition. */
    function reapprove(id: string, at: string): void {
      store.applyDraftTransition({ id, from: 'failed', to: 'approved', at });
    }

    it('increments attempt across retries and throws at the ceiling', () => {
      store.insertDraft(makeDraft({ id: 'd1', state: 'approved' }));

      expect(store.beginSendAttempt('d1', 'applescript', T0)).toEqual({
        attempt: 1,
      });
      store.markDraftFailed('d1', ERR, '2026-09-01T12:01:00.000Z');
      reapprove('d1', '2026-09-01T12:02:00.000Z');

      expect(
        store.beginSendAttempt('d1', 'applescript', '2026-09-01T12:03:00.000Z'),
      ).toEqual({ attempt: 2 });
      store.markDraftFailed('d1', ERR, '2026-09-01T12:04:00.000Z');
      reapprove('d1', '2026-09-01T12:05:00.000Z');

      expect(
        store.beginSendAttempt('d1', 'applescript', '2026-09-01T12:06:00.000Z'),
      ).toEqual({ attempt: 3 });
      store.markDraftFailed('d1', ERR, '2026-09-01T12:07:00.000Z');
      reapprove('d1', '2026-09-01T12:08:00.000Z');

      // 1 first try + 2 retries is the whole allowance.
      expect(() =>
        store.beginSendAttempt('d1', 'applescript', '2026-09-01T12:09:00.000Z'),
      ).toThrow(/retry limit exhausted/);
    });

    it('the S3 state assertion is unchanged: a non-approved draft still throws', () => {
      store.insertDraft(makeDraft({ id: 'd1', state: 'approved' }));
      store.beginSendAttempt('d1', 'applescript', T0);
      // Draft is now 'sending' — the double-begin backstop, still armed.
      expect(() => store.beginSendAttempt('d1', 'applescript', T0)).toThrow(
        /is not approved/,
      );
    });

    it('a retry reopens the ledger row (stale outcome columns cleared)', () => {
      store.insertDraft(makeDraft({ id: 'd1', state: 'approved' }));
      store.beginSendAttempt('d1', 'applescript', T0);
      store.markDraftSent('d1', 'guid-1', '2026-09-01T12:01:00.000Z');
      store.applyDraftTransition({
        id: 'd1',
        from: 'sent',
        to: 'approved',
        at: '2026-09-01T12:02:00.000Z',
      });
      expect(
        store.beginSendAttempt('d1', 'applescript', '2026-09-01T12:03:00.000Z'),
      ).toEqual({ attempt: 2 });
      const ledger = store.db
        .prepare('SELECT * FROM send_ledger WHERE draft_id = ?')
        .get('d1') as {
        attempt: number;
        verified_guid: string | null;
        finished_at: string | null;
      };
      expect(ledger.attempt).toBe(2);
      expect(ledger.verified_guid).toBeNull();
      expect(ledger.finished_at).toBeNull();
    });
  });

  it('systemActor stays usable for the kill-flip caller (import sanity)', () => {
    expect(systemActor('kill-switch')).toEqual({
      kind: 'system',
      reason: 'kill-switch',
    });
  });
});

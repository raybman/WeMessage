/**
 * s3-execution.md Part 2 Scenario 5 — Store foundations: drafts, approvals,
 * ledger, human adapter seed.
 *
 * §2.3 schema is already fully present from S1 (drafts/approvals/
 * send_ledger/adapters) — no migration here, only new SqliteStore methods
 * plus an idempotent boot-time seed of the reserved 'human' adapter row
 * (F-22: humans can hold drafts without relaxing the adapter_id FK).
 *
 * Real temp-dir SqliteStore, fake Clock (§4.0 hand-rolled fakes) — same
 * conventions as rules-store.spec.ts / audit-chain.spec.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Approval,
  AuditEvent,
  Clock,
  Draft,
  DraftError,
} from '@wemessage/core';
import { humanApiActor, systemActor } from '@wemessage/core';
import {
  openStore,
  verifyAuditChain,
  type SqliteStore,
} from '@wemessage/store';

function fakeClock(iso = '2026-09-01T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

/** Full Draft factory — every field explicit so toEqual has teeth. */
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
    stateChangedAt: '2026-09-01T12:00:00.000Z',
    expiresAt: '2026-09-01T16:00:00.000Z',
    createdAt: '2026-09-01T12:00:00.000Z',
    ...partial,
  };
}

/** Insert a draft already in state 'approved' — the precondition beginSendAttempt needs. */
function insertApprovedDraft(
  store: SqliteStore,
  id: string,
  stateChangedAt = '2026-09-01T12:01:00.000Z',
): void {
  store.insertDraft(makeDraft({ id, state: 'approved', stateChangedAt }));
}

describe('store send foundations (s3 Scenario 5)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-send-foundations-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('insertDraft / getDraft', () => {
    it('round-trips a pending draft, adapterId human', () => {
      const draft = makeDraft({ id: 'D1' });
      store.insertDraft(draft);
      expect(store.getDraft('D1')).toEqual(draft);
    });

    it('returns null when absent', () => {
      expect(store.getDraft('nope')).toBeNull();
    });

    it('round-trips optional fields (sendNotBefore, sentMessageGuid, proactiveReason, error) when present', () => {
      const error: DraftError = {
        code: 'unverified',
        message: 'no matching outbound row',
        at: '2026-09-01T12:05:00.000Z',
      };
      const draft = makeDraft({
        id: 'D2',
        adapterId: 'human',
        proactiveReason: 'quiet chat, 3 days',
        sendNotBefore: '2026-09-01T12:00:30.000Z',
        sentMessageGuid: 'MSG-PRIOR',
        error,
      });
      store.insertDraft(draft);
      expect(store.getDraft('D2')).toEqual(draft);
    });
  });

  describe('F-22: reserved human adapter seed', () => {
    it('exists immediately after store open: generic kind, display name, token_hash NULL (fail-closed §2.6)', () => {
      const row = store.db
        .prepare(
          'SELECT kind, display_name, token_hash FROM adapters WHERE id = ?',
        )
        .get('human') as
        | { kind: string; display_name: string; token_hash: string | null }
        | undefined;
      expect(row).toEqual({
        kind: 'generic',
        display_name: 'Human (direct send)',
        token_hash: null,
      });
    });

    it('is idempotent: reopening the same store dir sees exactly one unchanged human row', () => {
      const dir2 = mkdtempSync(join(tmpdir(), 'wemessage-send-foundations-'));
      try {
        const s1 = openStore({ dir: dir2, clock: fakeClock() });
        s1.close();
        const s2 = openStore({ dir: dir2, clock: fakeClock() });
        const rows = s2.db
          .prepare('SELECT token_hash FROM adapters WHERE id = ?')
          .all('human') as { token_hash: string | null }[];
        expect(rows).toEqual([{ token_hash: null }]);
        s2.close();
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    });

    it('a draft referencing the seeded human adapter inserts cleanly (FK satisfied)', () => {
      expect(() =>
        store.insertDraft(makeDraft({ id: 'D3', adapterId: 'human' })),
      ).not.toThrow();
    });

    it('a draft referencing a nonexistent adapter still throws a real FK violation (constraint is alive, not disabled)', () => {
      expect(() =>
        store.insertDraft(makeDraft({ id: 'D4', adapterId: 'ghost' })),
      ).toThrow(/FOREIGN KEY/i);
    });
  });

  describe('insertApproval', () => {
    it('requires an existing draft (FK)', () => {
      const approval: Approval = {
        id: 'A1',
        draftId: 'nonexistent',
        action: 'approve',
        actor: { kind: 'human', via: 'api' },
        at: '2026-09-01T12:05:00.000Z',
      };
      expect(() => store.insertApproval(approval)).toThrow(/FOREIGN KEY/i);
    });

    it('records actor JSON verbatim (F-13-style: stored, not re-derived)', () => {
      store.insertDraft(makeDraft({ id: 'D5' }));
      const approval: Approval = {
        id: 'A2',
        draftId: 'D5',
        action: 'approve',
        actor: { kind: 'human', via: 'cli' },
        at: '2026-09-01T12:05:00.000Z',
      };
      store.insertApproval(approval);
      const row = store.db
        .prepare(
          'SELECT draft_id, action, actor, at FROM approvals WHERE id = ?',
        )
        .get('A2') as {
        draft_id: string;
        action: string;
        actor: string;
        at: string;
      };
      expect(row).toEqual({
        draft_id: 'D5',
        action: 'approve',
        actor: JSON.stringify(approval.actor),
        at: '2026-09-01T12:05:00.000Z',
      });
    });
  });

  describe('getApproval (s3 Scenario 6 body extension, §1.7 step 3a)', () => {
    it('round-trips a full Approval (batchId + editedBody present)', () => {
      store.insertDraft(makeDraft({ id: 'D5a' }));
      const approval: Approval = {
        id: 'A3',
        draftId: 'D5a',
        action: 'approve',
        actor: { kind: 'human', via: 'gui' },
        batchId: 'batch-1',
        editedBody: 'edited text',
        at: '2026-09-01T12:05:00.000Z',
      };
      store.insertApproval(approval);
      expect(store.getApproval('A3')).toEqual(approval);
    });

    it('round-trips a minimal Approval (batchId/editedBody absent)', () => {
      store.insertDraft(makeDraft({ id: 'D5b' }));
      const approval: Approval = {
        id: 'A4',
        draftId: 'D5b',
        action: 'reject',
        actor: { kind: 'system', reason: 'kill-switch' },
        at: '2026-09-01T12:06:00.000Z',
      };
      store.insertApproval(approval);
      expect(store.getApproval('A4')).toEqual(approval);
    });

    it('returns null when absent', () => {
      expect(store.getApproval('nonexistent-id')).toBeNull();
    });
  });

  describe('beginSendAttempt', () => {
    it('approved -> sending: returns {attempt:1}, draft flips state, send_ledger row exists with started_at', () => {
      insertApprovedDraft(store, 'D6');
      const result = store.beginSendAttempt(
        'D6',
        'applescript',
        '2026-09-01T12:02:00.000Z',
      );
      expect(result).toEqual({ attempt: 1 });
      expect(store.getDraft('D6')?.state).toBe('sending');
      const ledger = store.db
        .prepare('SELECT * FROM send_ledger WHERE draft_id = ?')
        .get('D6');
      expect(ledger).toEqual({
        draft_id: 'D6',
        attempt: 1,
        backend: 'applescript',
        started_at: '2026-09-01T12:02:00.000Z',
        verified_guid: null,
        finished_at: null,
      });
    });

    it('a second call on the same (now-sending) draft throws — the persistent double-begin backstop', () => {
      insertApprovedDraft(store, 'D7');
      store.beginSendAttempt('D7', 'applescript', '2026-09-01T12:02:00.000Z');
      expect(() =>
        store.beginSendAttempt('D7', 'applescript', '2026-09-01T12:03:00.000Z'),
      ).toThrow(/not approved/i);
      // No retry path in S3: still exactly attempt 1, ledger untouched by the rejected call.
      const ledger = store.db
        .prepare(
          'SELECT attempt, started_at FROM send_ledger WHERE draft_id = ?',
        )
        .get('D7');
      expect(ledger).toEqual({
        attempt: 1,
        started_at: '2026-09-01T12:02:00.000Z',
      });
    });

    it('a draft that was never approved (still pending) throws the same way', () => {
      store.insertDraft(makeDraft({ id: 'D8', state: 'pending' }));
      expect(() =>
        store.beginSendAttempt('D8', 'applescript', '2026-09-01T12:02:00.000Z'),
      ).toThrow(/not approved/i);
    });
  });

  describe('markDraftSent (extends S1 semantics onto a real ledger row)', () => {
    it('closes the ledger row opened by beginSendAttempt: verified_guid + finished_at set, draft state sent', () => {
      insertApprovedDraft(store, 'D9');
      store.beginSendAttempt('D9', 'applescript', '2026-09-01T12:02:00.000Z');
      store.markDraftSent('D9', 'MSG-GUID-9', '2026-09-01T12:02:05.000Z');

      const draft = store.getDraft('D9');
      expect(draft?.state).toBe('sent');
      expect(draft?.sentMessageGuid).toBe('MSG-GUID-9');

      const ledger = store.db
        .prepare(
          'SELECT verified_guid, finished_at FROM send_ledger WHERE draft_id = ?',
        )
        .get('D9');
      expect(ledger).toEqual({
        verified_guid: 'MSG-GUID-9',
        finished_at: '2026-09-01T12:02:05.000Z',
      });
    });
  });

  describe('markDraftFailed (extends S1 semantics onto a real ledger row)', () => {
    it('closes the ledger row with finished_at only (no verified_guid), sets draft error', () => {
      insertApprovedDraft(store, 'D10');
      store.beginSendAttempt('D10', 'applescript', '2026-09-01T12:02:00.000Z');
      const error: DraftError = {
        code: 'unverified',
        message: 'no matching outbound row',
        at: '2026-09-01T12:02:10.000Z',
      };
      store.markDraftFailed('D10', error, '2026-09-01T12:02:10.000Z');

      const draft = store.getDraft('D10');
      expect(draft?.state).toBe('failed');
      expect(draft?.error).toEqual(error);

      const ledger = store.db
        .prepare(
          'SELECT verified_guid, finished_at FROM send_ledger WHERE draft_id = ?',
        )
        .get('D10');
      expect(ledger).toEqual({
        verified_guid: null,
        finished_at: '2026-09-01T12:02:10.000Z',
      });
    });
  });

  describe('clearAdapterTokens (F-22)', () => {
    it('NULLs token_hash on adapters that have one set, returns the count cleared; human (already NULL) is never counted', () => {
      store.db
        .prepare(
          'INSERT INTO adapters (id, kind, display_name, token_hash) VALUES (?, ?, ?, ?)',
        )
        .run('sol', 'sol', 'Sol', 'hash-1');
      store.db
        .prepare(
          'INSERT INTO adapters (id, kind, display_name, token_hash) VALUES (?, ?, ?, ?)',
        )
        .run('hermes', 'hermes', 'Hermes', 'hash-2');

      expect(store.clearAdapterTokens()).toBe(2);

      const rows = store.db
        .prepare('SELECT id, token_hash FROM adapters ORDER BY id')
        .all();
      expect(rows).toEqual([
        { id: 'hermes', token_hash: null },
        { id: 'human', token_hash: null },
        { id: 'sol', token_hash: null },
      ]);
    });

    it('a second call is a no-op: returns 0, nothing left to clear', () => {
      store.db
        .prepare(
          'INSERT INTO adapters (id, kind, display_name, token_hash) VALUES (?, ?, ?, ?)',
        )
        .run('sol', 'sol', 'Sol', 'hash-1');
      store.clearAdapterTokens();
      expect(store.clearAdapterTokens()).toBe(0);
    });
  });

  describe('new S3 audit variants (draft.created, draft.approved, send.attempted, draft.sent, draft.failed)', () => {
    it('each new variant appends and the hash chain still verifies green', () => {
      const draft = makeDraft({ id: 'D11' });
      const chainedEvents: AuditEvent[] = [
        { type: 'draft.created', draftId: 'D11', draft },
        {
          type: 'draft.approved',
          draftId: 'D11',
          approvalId: 'A11',
          actor: humanApiActor(),
        },
        {
          type: 'send.attempted',
          draftId: 'D11',
          attempt: 1,
          backend: 'applescript',
        },
        { type: 'draft.sent', draftId: 'D11', sentMessageGuid: 'MSG-11' },
      ];
      chainedEvents.forEach((event, i) => {
        store.appendAudit({
          at: `2026-09-01T12:1${i}:00.000Z`,
          eventJson: JSON.stringify(event),
          actorJson: JSON.stringify(humanApiActor()),
        });
      });
      const failedEvent: AuditEvent = {
        type: 'draft.failed',
        draftId: 'D11',
        error: {
          code: 'unverified',
          message: 'no matching outbound row',
          at: '2026-09-01T12:14:00.000Z',
        },
      };
      store.appendAudit({
        at: '2026-09-01T12:14:00.000Z',
        eventJson: JSON.stringify(failedEvent),
        actorJson: JSON.stringify(systemActor('circuit-breaker')),
      });

      const rows = store.listAudit({ limit: 100 });
      expect(
        rows.map((r) => (JSON.parse(r.eventJson) as AuditEvent).type),
      ).toEqual([
        'draft.failed',
        'draft.sent',
        'send.attempted',
        'draft.approved',
        'draft.created',
      ]);
      expect(verifyAuditChain(store)).toEqual({ ok: true, length: 5 });
    });
  });
});

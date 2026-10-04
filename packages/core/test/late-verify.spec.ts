/**
 * s10 Slice 2: `verifyLate`, the after-the-fact half of send verification.
 *
 * A draft parked 'failed' with code 'unverified' was accepted by the send
 * backend but did not show up in chat.db inside the 10s verify budget.
 * Under load Messages writes the row late, so the honest state of such a
 * draft is "unknown", not "failed". verifyLate looks once, from the first
 * attempt's ledger start, and if the row is there it moves the draft
 * failed -> sent through the CAS port with the found guid.
 *
 * It reads; it never sends. The deps type has no SendBackend slot at all,
 * and an arch row pins that the module never imports one.
 *
 * Teeth:
 *  TL1. drop the 'unverified' code check -> the backend-error row sends.
 *  TL2. rethrow on a lost CAS -> the lost-race row throws; swallow every
 *       error -> the broken-write row resolves.
 *  TL3. search from `now` instead of ledger.startedAt -> the sinceIso row fails.
 */
import { describe, expect, it } from 'vitest';
import type {
  AuditEvent,
  ChatDbReader,
  Clock,
  Draft,
  DraftError,
  SendLedgerView,
  Store,
} from '@wemessage/core';
import { verifyLate, type LateVerifyDeps } from '@wemessage/core';

const NOW = '2026-10-04T12:05:00.000Z';
const STARTED = '2026-10-04T12:00:00.000Z';

const clock: Clock = { now: () => NOW, nowMs: () => Date.parse(NOW) };

function failedDraft(error: DraftError, partial: Partial<Draft> = {}): Draft {
  return {
    id: 'D1',
    inboundGuid: null,
    chatGuid: 'any;-;+15551234567',
    ruleId: null,
    adapterId: 'human',
    idempotencyKey: 'idem-D1',
    body: 'on my way',
    originalBody: 'on my way',
    state: 'failed',
    stateChangedAt: '2026-10-04T12:00:12.000Z',
    expiresAt: '2026-10-04T16:00:00.000Z',
    createdAt: STARTED,
    error,
    ...partial,
  };
}

const UNVERIFIED: DraftError = {
  code: 'unverified',
  message: 'send accepted but could not confirm',
  at: '2026-10-04T12:00:12.000Z',
};

interface Rig {
  deps: LateVerifyDeps;
  calls: string[];
  audits: { event: AuditEvent; actor: unknown }[];
  lookups: { chatGuid: string; text: string; sinceIso: string }[];
}

function rig(opts: {
  draft: Draft | null;
  ledger?: SendLedgerView | null;
  resolved?: {
    chatGuid: string;
    service: 'imessage' | 'sms' | 'rcs' | 'unknown';
    isGroup: boolean;
  } | null;
  found?: { guid: string } | null;
  /** 'raced': another writer moved the draft first. 'broken': the write itself failed. */
  casThrows?: 'raced' | 'broken';
}): Rig {
  const calls: string[] = [];
  const audits: Rig['audits'] = [];
  const lookups: Rig['lookups'] = [];
  const ledger =
    opts.ledger === undefined
      ? { attempt: 1, startedAt: STARTED, verifiedGuid: null }
      : opts.ledger;
  let raced = false;
  const store = {
    getDraft: (id: string) => {
      calls.push(`getDraft:${id}`);
      if (raced && opts.draft !== null) {
        return { ...opts.draft, state: 'approved' };
      }
      return opts.draft;
    },
    getSendLedger: (id: string) => {
      calls.push(`getSendLedger:${id}`);
      return ledger;
    },
    applyDraftTransition: (input: {
      id: string;
      from: string;
      to: string;
      at: string;
      sentMessageGuid?: string;
    }) => {
      calls.push(
        `applyDraftTransition:${input.id}:${input.from}->${input.to}:guid=${String(input.sentMessageGuid)}`,
      );
      if (opts.casThrows === 'raced') {
        raced = true;
        throw new Error(`draft ${input.id} is 'approved', not '${input.from}'`);
      }
      if (opts.casThrows === 'broken') throw new Error('SQLITE_BUSY');
      return { ...opts.draft, state: input.to };
    },
    appendAudit: (entry: { eventJson: string; actorJson: string }) => {
      audits.push({
        event: JSON.parse(entry.eventJson) as AuditEvent,
        actor: JSON.parse(entry.actorJson),
      });
      return { seq: audits.length, hash: '0'.repeat(64) };
    },
  } as unknown as Store;
  const reader: Pick<ChatDbReader, 'resolveChat' | 'findOutboundMessage'> = {
    resolveChat: (handle) => {
      calls.push(`resolveChat:${handle}`);
      return Promise.resolve(
        opts.resolved === undefined
          ? {
              chatGuid: 'iMessage;-;+15551234567',
              service: 'imessage',
              isGroup: false,
            }
          : opts.resolved,
      );
    },
    findOutboundMessage: (q) => {
      calls.push('findOutboundMessage');
      lookups.push(q);
      return Promise.resolve(opts.found ?? null);
    },
  };
  return { deps: { store, reader, clock }, calls, audits, lookups };
}

describe('s10 Sl2: verifyLate', () => {
  it('failed/unverified with a landed row -> sent via the CAS port, audited as late-verify', async () => {
    const r = rig({
      draft: failedDraft(UNVERIFIED),
      found: { guid: 'LATE-1' },
    });
    const out = await verifyLate(r.deps, 'D1');
    expect(out).toEqual({ outcome: 'sent', sentMessageGuid: 'LATE-1' });
    expect(r.calls).toContain(
      'applyDraftTransition:D1:failed->sent:guid=LATE-1',
    );
    expect(r.audits).toEqual([
      {
        event: { type: 'draft.sent', draftId: 'D1', sentMessageGuid: 'LATE-1' },
        actor: { kind: 'system', reason: 'late-verify' },
      },
    ]);
  });

  it('searches the RESOLVED chat from the first attempt start, for the exact body', async () => {
    const r = rig({
      draft: failedDraft(UNVERIFIED),
      found: { guid: 'LATE-1' },
    });
    await verifyLate(r.deps, 'D1');
    expect(r.lookups).toEqual([
      {
        chatGuid: 'iMessage;-;+15551234567',
        text: 'on my way',
        sinceIso: STARTED,
      },
    ]);
  });

  it('no landed row -> not-found, nothing written', async () => {
    const r = rig({ draft: failedDraft(UNVERIFIED), found: null });
    expect(await verifyLate(r.deps, 'D1')).toEqual({ outcome: 'not-found' });
    expect(r.calls.some((c) => c.startsWith('applyDraftTransition'))).toBe(
      false,
    );
    expect(r.audits).toEqual([]);
  });

  it('a draft that is not failed -> skipped not-failed, no chat.db read', async () => {
    const r = rig({
      draft: failedDraft(UNVERIFIED, { state: 'approved' }),
      found: { guid: 'X' },
    });
    expect(await verifyLate(r.deps, 'D1')).toEqual({
      outcome: 'skipped',
      reason: 'not-failed',
    });
    expect(r.lookups).toEqual([]);
  });

  it('a missing draft -> skipped not-failed', async () => {
    const r = rig({ draft: null });
    expect(await verifyLate(r.deps, 'D1')).toEqual({
      outcome: 'skipped',
      reason: 'not-failed',
    });
  });

  it('a failure that is not unverified (backend refused) -> skipped, never marked sent', async () => {
    const r = rig({
      draft: failedDraft({
        code: 'backend-error',
        message: 'osascript exit 1',
        at: STARTED,
      }),
      found: { guid: 'COINCIDENCE' },
    });
    expect(await verifyLate(r.deps, 'D1')).toEqual({
      outcome: 'skipped',
      reason: 'not-unverified',
    });
    expect(r.lookups).toEqual([]);
  });

  it('no ledger row -> skipped no-ledger (it was never attempted)', async () => {
    const r = rig({ draft: failedDraft(UNVERIFIED), ledger: null });
    expect(await verifyLate(r.deps, 'D1')).toEqual({
      outcome: 'skipped',
      reason: 'no-ledger',
    });
    expect(r.lookups).toEqual([]);
  });

  it('a group target -> skipped group', async () => {
    const r = rig({
      draft: failedDraft(UNVERIFIED, { chatGuid: 'iMessage;+;chat123' }),
    });
    expect(await verifyLate(r.deps, 'D1')).toEqual({
      outcome: 'skipped',
      reason: 'group',
    });
    expect(r.lookups).toEqual([]);
  });

  it('a handle that resolves to a group or nothing -> skipped group / not-found', async () => {
    const g = rig({
      draft: failedDraft(UNVERIFIED),
      resolved: {
        chatGuid: 'iMessage;+;x',
        service: 'imessage',
        isGroup: true,
      },
    });
    expect(await verifyLate(g.deps, 'D1')).toEqual({
      outcome: 'skipped',
      reason: 'group',
    });
    const n = rig({ draft: failedDraft(UNVERIFIED), resolved: null });
    expect(await verifyLate(n.deps, 'D1')).toEqual({ outcome: 'not-found' });
  });

  it('a lost CAS race (someone retried first) -> not-found, no audit, no throw', async () => {
    const r = rig({
      draft: failedDraft(UNVERIFIED),
      found: { guid: 'LATE-1' },
      casThrows: 'raced',
    });
    expect(await verifyLate(r.deps, 'D1')).toEqual({ outcome: 'not-found' });
    expect(r.audits).toEqual([]);
  });

  it('a write that fails while the draft is still failed is NOT a race -> rethrows', async () => {
    const r = rig({
      draft: failedDraft(UNVERIFIED),
      found: { guid: 'LATE-1' },
      casThrows: 'broken',
    });
    await expect(verifyLate(r.deps, 'D1')).rejects.toThrow('SQLITE_BUSY');
    expect(r.audits).toEqual([]);
  });

  it('the deps type has no backend slot (reads only, by construction)', () => {
    const r = rig({ draft: failedDraft(UNVERIFIED) });
    expect(Object.keys(r.deps).sort()).toEqual(['clock', 'reader', 'store']);
  });
});

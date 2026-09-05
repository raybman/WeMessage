/**
 * s8 Sc5 — the wiring, and the reason an optimistic approve cannot send.
 *
 * `store/index.ts` is the only part of the renderer that talks to the bridge,
 * and it is deliberately thin: subscribe to the two pushes, narrow them, hand
 * them to the reducer, and turn a keystroke into exactly one request. This
 * file is where INV-2 stops being an argument and becomes an observation —
 * the bridge handed to the binding is a `Pick` of five request channels, the
 * fake below records every invocation, and the rows assert both that the
 * send channel was never called AND that it is not reachable from here at
 * all.
 *
 * The compile-time half is the stronger one: `StoreBridge` is a `Pick` over
 * a closed key list, so naming the wizard's send-test channel in this module
 * is a type error rather than a policy violation somebody has to notice.
 *
 * s8 Sc6 widened that list from four keys to six (`rules` and `contacts`,
 * both reads, both already-declared channels) so the cards can render names
 * instead of ids. The widening is deliberate and guarded: `test/arch.spec.ts`
 * asserts the store's `bridge.<member>` set is exactly the six, and asserts
 * separately that no identifier under the store matches /send/i.
 */
import { describe, expect, it } from 'vitest';
import type { DraftPayload } from '@wemessage/client';
import type { StreamFrame } from '../../src/main/event-stream.js';
import {
  bindStore,
  STORE_CHANNELS,
  type StoreBridge,
} from '../../src/renderer/store/index.js';

const AT = '2026-03-02T18:00:00.000Z';

function draft(id: string): DraftPayload {
  return {
    id,
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15550001111',
    ruleId: null,
    adapterId: 'a1',
    idempotencyKey: `k-${id}`,
    body: `body ${id}`,
    originalBody: `body ${id}`,
    state: 'pending',
    stateChangedAt: AT,
    expiresAt: '2026-03-02T19:00:00.000Z',
    createdAt: AT,
  };
}

interface Call {
  readonly channel: string;
  readonly args: readonly unknown[];
}

interface Fake {
  bridge: StoreBridge;
  calls: Call[];
  /** Deliver a push, as the preload would. */
  push(key: 'event' | 'stream', payload: unknown): void;
  /** Answer the next `drafts` call with this list. */
  nextDrafts(list: readonly DraftPayload[]): void;
  /** Answer the next `approve` call with this value, or reject with it. */
  nextApprove(value: unknown, reject?: boolean): void;
  /**
   * Answer the next `reject`/`recall` call with this value, or throw it.
   *
   * One setter for both because the two verbs share `settle` in the wiring;
   * a test that needs them to answer DIFFERENTLY is a test that has found a
   * reason for them not to share, which is worth writing explicitly.
   */
  nextWrite(value: unknown, reject?: boolean): void;
  /**
   * Answer the two catalogue channels with these rows, or make them throw.
   *
   * `unknown` rather than a DTO: these two answers cross the bridge untyped
   * and the store narrows them row by row, so the rows a test hands back
   * have to be able to be malformed. A fake that could only produce valid
   * records could not exercise the narrowing that exists for invalid ones.
   */
  nextCatalogue(next: {
    rules?: unknown;
    contacts?: unknown;
    settings?: unknown;
    rulesThrow?: boolean;
    contactsThrow?: boolean;
    settingsThrow?: boolean;
  }): void;
  /** Answer the next `bulk` call with this value (s8 Sc9). */
  nextBulk(value: unknown, reject?: boolean): void;
  /** Answer every `batch` call with this value (s8 Sc9). */
  nextBatch(value: unknown, reject?: boolean): void;
  listeners(): string[];
}

function fakeBridge(): Fake {
  const calls: Call[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  let drafts: readonly DraftPayload[] = [];
  let approveAnswer: unknown = { draft: draft('d1'), approvalId: 'a1' };
  let approveRejects = false;
  let writeAnswer: unknown = { draft: draft('d1') };
  let writeRejects = false;
  let rules: unknown = [];
  let contacts: unknown = [];
  let settings: unknown = {};
  let rulesThrow = false;
  let contactsThrow = false;
  let settingsThrow = false;
  let bulkAnswer: unknown = {
    batchId: 'B1',
    matched: 0,
    applied: 0,
    appliedIds: [],
    refused: [],
  };
  let bulkRejects = false;
  let batchAnswer: unknown = {
    batchId: 'B1',
    approved: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    recalled: 0,
  };
  let batchRejects = false;
  const record =
    (channel: string, answer: () => unknown) =>
    (...args: readonly unknown[]): Promise<unknown> => {
      calls.push({ channel, args });
      return Promise.resolve(answer());
    };
  return {
    calls,
    listeners: () => [...listeners.keys()].sort(),
    push: (key, payload) => listeners.get(key)?.(payload),
    nextDrafts: (list) => {
      drafts = list;
    },
    nextApprove: (value, reject = false) => {
      approveAnswer = value;
      approveRejects = reject;
    },
    nextWrite: (value, reject = false) => {
      writeAnswer = value;
      writeRejects = reject;
    },
    nextCatalogue: (next) => {
      if (next.rules !== undefined) rules = next.rules;
      if (next.contacts !== undefined) contacts = next.contacts;
      if (next.settings !== undefined) settings = next.settings;
      rulesThrow = next.rulesThrow ?? false;
      contactsThrow = next.contactsThrow ?? false;
      settingsThrow = next.settingsThrow ?? false;
    },
    nextBulk: (value, reject = false) => {
      bulkAnswer = value;
      bulkRejects = reject;
    },
    nextBatch: (value, reject = false) => {
      batchAnswer = value;
      batchRejects = reject;
    },
    bridge: {
      drafts: record('drafts', () => drafts),
      bulk: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'bulk', args });
        return bulkRejects
          ? Promise.reject(new Error(String(bulkAnswer)))
          : Promise.resolve(bulkAnswer);
      },
      batch: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'batch', args });
        return batchRejects
          ? Promise.reject(new Error('batch route is down'))
          : Promise.resolve(batchAnswer);
      },
      retry: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'retry', args });
        return writeRejects
          ? Promise.reject(new Error(String(writeAnswer)))
          : Promise.resolve(writeAnswer);
      },
      settings: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'settings', args });
        return settingsThrow
          ? Promise.reject(new Error('settings route is down'))
          : Promise.resolve(settings);
      },
      approve: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'approve', args });
        return approveRejects
          ? Promise.reject(new Error(String(approveAnswer)))
          : Promise.resolve(approveAnswer);
      },
      reject: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'reject', args });
        return writeRejects
          ? Promise.reject(new Error(String(writeAnswer)))
          : Promise.resolve(writeAnswer);
      },
      recall: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'recall', args });
        return writeRejects
          ? Promise.reject(new Error(String(writeAnswer)))
          : Promise.resolve(writeAnswer);
      },
      rules: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'rules', args });
        return rulesThrow
          ? Promise.reject(new Error('rules route is down'))
          : Promise.resolve(rules);
      },
      contacts: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'contacts', args });
        return contactsThrow
          ? Promise.reject(new Error('contacts route is down'))
          : Promise.resolve(contacts);
      },
      on: (key, listener) => {
        listeners.set(key, listener);
        return () => listeners.delete(key);
      },
    },
  };
}

const snapshotFrame = (
  seq: number,
  ids: readonly string[],
  missed = 0,
): StreamFrame => ({
  kind: 'snapshot',
  seq,
  at: AT,
  missed,
  drafts: ids.map(draft),
});

function connected(fake: Fake): void {
  fake.push('stream', { state: 'connected', armed: null });
}

/* ── the closed channel list ─────────────────────────────────────────── */

describe('s8 Sc5 wiring: the store reaches ten channels and no others', () => {
  it('the allowlist names nothing that could send', () => {
    // s8 Sc6 grew this from three to five: a card that renders a rule NAME
    // and a display NAME needs the two catalogues those names live in. Both
    // additions are reads, and the guarantee this row exists for is
    // unchanged — none of them is the channel that could dispatch.
    //
    // s8 Sc8 grew it to seven, for the two remaining triage verbs. `recall`
    // is worth a second look and passes it: it is the request that STOPS a
    // send, and the daemon refuses it once the grace window has closed.
    //
    // s8 Sc9 grew it to ten, and every one of the three is worth naming:
    //
    //  - `batch` is `GET /v1/batches/:id`, a pure read of the tallies over
    //    one `batchId`. It is what lets one operator act have one answer.
    //  - `settings` is a read too, and it exists because the retry
    //    affordance has to say whether a retry would go out as SMS. A
    //    footnote that GUESSED at that setting would be a footnote about a
    //    fallback the operator cannot see.
    //  - `retry` is the one that is a write, and it is the closest thing in
    //    this list to a send. It passes the same test `recall` did: it is a
    //    request to the DAEMON to put a failed draft back to `approved`
    //    with a fresh grace window, and the send that follows is the
    //    scheduler's, through `dispatchApproved`, exactly as it is for every
    //    other approval. The renderer still cannot dispatch; it can only ask.
    expect([...STORE_CHANNELS]).toEqual([
      'approve',
      'batch',
      'bulk',
      'contacts',
      'drafts',
      'recall',
      'reject',
      'retry',
      'rules',
      'settings',
    ]);
    for (const channel of STORE_CHANNELS)
      expect(/send/i.test(channel)).toBe(false);
  });

  it('binding subscribes to both pushes and calls nothing at all', () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    expect(fake.listeners()).toEqual(['event', 'stream']);
    expect(fake.calls).toEqual([]);
    binding.dispose();
    expect(fake.listeners()).toEqual([]);
  });
});

/* ── pushes reach the reducer ────────────────────────────────────────── */

describe('s8 Sc5 wiring: frames reach the store', () => {
  it('a snapshot frame replaces the map and carries the gap forward', () => {
    const fake = fakeBridge();
    const { store } = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1', 'd2'], 3));
    expect(store.rows().map((r) => r.server.id)).toEqual(['d1', 'd2']);
    expect(store.missed()).toBe(3);
    expect(store.syncedAt()).toBe(AT);
  });

  it('an event frame reaches the reducer', () => {
    const fake = fakeBridge();
    const { store } = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    fake.push('event', {
      kind: 'event',
      seq: 2,
      event: { event: 'draft.expired', draftId: 'd1' },
    } satisfies StreamFrame);
    expect(store.stateOf('d1')).toBe('expired');
  });

  it('a stream push sets the connection state the keymap gates on', () => {
    const fake = fakeBridge();
    const { store } = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    fake.push('stream', { state: 'reconnecting', attempt: 2 });
    expect(store.streamState()).toBe('reconnecting');
    connected(fake);
    expect(store.streamState()).toBe('connected');
  });

  it('a payload that is not a frame is ignored, not rendered', () => {
    const fake = fakeBridge();
    const { store } = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', { kind: 'snapshot', seq: 1, drafts: 'not a list' });
    fake.push('event', null);
    fake.push('event', { kind: 'nonsense' });
    fake.push('stream', { state: 'wat' });
    expect(store.rows()).toEqual([]);
    expect(store.streamState()).toBe('down');
  });
});

/* ── the second gap detector: the IPC sequence itself ────────────────── */

describe('s8 Sc5 wiring: a hole in the frame sequence is a gap', () => {
  it('a skipped seq refetches through the drafts channel', async () => {
    const fake = fakeBridge();
    const { store } = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    fake.nextDrafts([draft('d1'), draft('d7')]);
    // seq 2 never arrived. A renderer that shrugged at this would show a
    // queue that is silently one event out of date for as long as the app
    // stays open — the failure mode this whole scenario exists to prevent.
    fake.push('event', {
      kind: 'event',
      seq: 3,
      event: { event: 'draft.expired', draftId: 'd1' },
    } satisfies StreamFrame);

    expect(store.needsSnapshot()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.calls.map((c) => c.channel)).toEqual(['drafts']);
    expect(store.rows().map((r) => r.server.id)).toEqual(['d1', 'd7']);
    expect(store.needsSnapshot()).toBe(false);
  });

  it('a window that missed the first snapshot asks for the queue itself', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.nextDrafts([draft('d1')]);
    // The frame main pushed while this window was still loading is gone;
    // nobody redelivers an IPC message. The stream state IS replayed, and
    // it is enough: a store with no snapshot knows it has no snapshot.
    connected(fake);
    await binding.settled();
    expect(fake.calls.map((c) => c.channel)).toEqual(['drafts']);
    expect(binding.store.rows().map((r) => r.server.id)).toEqual(['d1']);

    // …and it does not do it again on the next reconnect, because by then
    // it has a queue and the resync in main is the one that closes gaps.
    fake.push('stream', { state: 'reconnecting', attempt: 1 });
    connected(fake);
    await binding.settled();
    expect(fake.calls.map((c) => c.channel)).toEqual(['drafts']);
  });

  it('consecutive frames refetch nothing', () => {
    const fake = fakeBridge();
    bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    fake.push('event', {
      kind: 'event',
      seq: 2,
      event: { event: 'draft.expired', draftId: 'd1' },
    } satisfies StreamFrame);
    expect(fake.calls).toEqual([]);
  });

  it('an unknown draft id refetches exactly once, not once per event', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    fake.nextDrafts([draft('d1')]);
    fake.push('event', {
      kind: 'event',
      seq: 2,
      event: { event: 'draft.expired', draftId: 'ghost' },
    } satisfies StreamFrame);
    fake.push('event', {
      kind: 'event',
      seq: 3,
      event: { event: 'draft.requeued', draftId: 'ghost' },
    } satisfies StreamFrame);
    await binding.settled();
    expect(fake.calls.map((c) => c.channel)).toEqual(['drafts']);
  });
});

/* ── approve: one request, one hypothesis, no send ───────────────────── */

describe('s8 Sc5 wiring: approve', () => {
  it('sets the hypothesis, makes exactly one request, and acks it', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.nextApprove({ draft: draft('d1'), approvalId: 'ap1' });

    const outcome = binding.approve('d1');
    expect(binding.store.stateOf('d1')).toBe('approved');
    await outcome;

    expect(fake.calls).toEqual([{ channel: 'approve', args: ['d1'] }]);
    // The card reads `approved` because a hypothesis says so, then because
    // the daemon's own row says so. Neither is a send: INV-2's only path to
    // the send port is `dispatchApproved` inside the daemon, and the one
    // channel in this app whose name matches /send/i is not in this
    // module's bridge type at all.
    expect(fake.calls.some((c) => /send/i.test(c.channel))).toBe(false);
    expect(binding.store.row('d1')?.pending?.action).toBe('approve');
  });

  it('an offline approve makes no request at all', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    fake.push('stream', { state: 'reconnecting', attempt: 1 });

    await binding.approve('d1');
    expect(fake.calls).toEqual([]);
    expect(binding.store.stateOf('d1')).toBe('pending');
  });

  it('a 409 refusal becomes the conflict chip and the server state', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.nextApprove({
      refused: 'conflict',
      from: 'sending',
      requested: 'approve',
    });

    await binding.approve('d1');
    expect(binding.store.stateOf('d1')).toBe('sending');
    expect(binding.store.chip('d1')).toEqual({
      kind: 'changed-elsewhere',
      state: 'sending',
    });
  });

  it('a 403 refusal rolls back and shows the gate’s own word', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.nextApprove({
      refused: 'denied',
      reason: 'quiet-hours',
      retryAfter: '2026-03-02T18:05:00.000Z',
    });

    await binding.approve('d1');
    expect(binding.store.stateOf('d1')).toBe('pending');
    expect(binding.store.chip('d1')).toEqual({
      kind: 'denied',
      reason: 'quiet-hours',
      retryAfter: '2026-03-02T18:05:00.000Z',
    });
  });

  it('a request that throws rolls the hypothesis back rather than stranding it', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.nextApprove('daemon-unavailable', true);

    await binding.approve('d1');
    expect(binding.store.row('d1')?.pending).toBeUndefined();
    expect(binding.store.stateOf('d1')).toBe('pending');
    expect(binding.store.chip('d1')).toEqual({
      kind: 'error',
      reason: 'daemon-unavailable',
    });
  });
});

/* ── bulk ────────────────────────────────────────────────────────────── */

describe('s8 Sc5 wiring: bulk', () => {
  it('one request for the whole selection, per-id refusals applied', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1', 'd2']));
    connected(fake);

    await binding.bulk(['d1', 'd2'], 'approve');
    // ONE request for N cards, and then exactly one refetch.
    //
    // The refetch is s8 Sc9's addition and it is not bookkeeping. A
    // `BulkResult` is `{batchId, matched, applied, appliedIds, refused}` —
    // counts and ids, no draft payloads — so after a bulk approve the store
    // holds N cards whose hypothesis says `approved` and whose server rows
    // still say `pending`, with no `sendNotBefore` and no `stateChangedAt`
    // for the new state. The undo ring is derived from exactly those two
    // fields, so without this fetch a bulk-approved card would sit there
    // claiming to be approved with no window showing and no way to know how
    // long `Z` had left. One GET for the batch, never one per card.
    expect(fake.calls).toEqual([
      { channel: 'bulk', args: ['approve', { ids: ['d1', 'd2'] }] },
      { channel: 'drafts', args: [] },
    ]);
    expect(fake.calls.some((c) => /send/i.test(c.channel))).toBe(false);
  });

  it('refetches even when the batch was refused outright', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1', 'd2']));
    connected(fake);
    // The refetch a bulk always ends with has to be ANSWERED with the queue
    // the daemon still has. The fake's default is an empty list, and an
    // empty snapshot is a real answer meaning "the queue is empty" — it
    // would drop both cards and, with them, the chips this row is about.
    fake.nextDrafts([draft('d1'), draft('d2')]);
    fake.nextBulk({
      batchId: 'B1',
      matched: 2,
      applied: 0,
      appliedIds: [],
      refused: [
        { id: 'd1', error: 'gate-denied' },
        { id: 'd2', error: 'gate-denied' },
      ],
    });

    await binding.bulk(['d1', 'd2'], 'approve');
    expect(fake.calls.map((c) => c.channel)).toEqual(['bulk', 'drafts']);
    expect(binding.store.chip('d1')).toEqual({
      kind: 'denied',
      reason: 'gate-denied',
    });
  });

  it('a bulk that never reached the daemon marks every started id, and asks again', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1', 'd2']));
    connected(fake);
    fake.nextDrafts([draft('d1'), draft('d2')]);
    fake.nextBulk('the bridge is gone', true);

    await binding.bulk(['d1', 'd2'], 'approve');
    for (const id of ['d1', 'd2']) {
      expect(binding.store.row(id)?.pending).toBeUndefined();
      expect(binding.store.chip(id)).toEqual({
        kind: 'error',
        reason: 'daemon-unavailable',
      });
    }
    // The refetch is in the `finally`, not the happy path: a bulk whose
    // answer was lost is the case where the renderer knows LEAST about what
    // the daemon did, so it is the case that most needs the queue re-read.
    expect(fake.calls.map((c) => c.channel)).toEqual(['bulk', 'drafts']);
  });
});

/* ── the batch report, fetched on terminal frames only (s8 Sc9) ──────── */

describe('s8 Sc9 wiring: one batch GET per terminal event, and no interval', () => {
  /** A bulk over d1/d2 that the daemon accepted whole. */
  async function bulked(fake: Fake): Promise<ReturnType<typeof bindStore>> {
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1', 'd2']));
    connected(fake);
    // The bulk ends with a refetch, and the refetch has to be answered with
    // the two cards that are still there.
    fake.nextDrafts([draft('d1'), draft('d2')]);
    fake.nextBulk({
      batchId: 'B1',
      matched: 2,
      applied: 2,
      appliedIds: ['d1', 'd2'],
      refused: [],
    });
    await binding.bulk(['d1', 'd2'], 'approve');
    await binding.settled();
    fake.calls.length = 0;
    return binding;
  }

  const terminal = (
    seq: number,
    draftId: string,
    kind: 'sent' | 'failed',
  ): StreamFrame =>
    kind === 'sent'
      ? {
          kind: 'event',
          seq,
          event: {
            event: 'draft.sent',
            draftId,
            sentMessageGuid: `guid-${draftId}`,
          },
        }
      : {
          kind: 'event',
          seq,
          event: {
            event: 'draft.failed',
            draftId,
            error: { code: 'unverified', message: 'synthetic', at: AT },
          },
        };

  it('asks once per terminal frame, and for the batch that frame belongs to', async () => {
    const fake = fakeBridge();
    const binding = await bulked(fake);

    fake.push('event', terminal(2, 'd1', 'sent'));
    await binding.settled();
    expect(fake.calls).toEqual([{ channel: 'batch', args: ['B1'] }]);

    fake.nextBatch({
      batchId: 'B1',
      approved: 0,
      sending: 0,
      sent: 1,
      failed: 1,
      recalled: 0,
    });
    fake.push('event', terminal(3, 'd2', 'failed'));
    await binding.settled();
    expect(fake.calls).toEqual([
      { channel: 'batch', args: ['B1'] },
      { channel: 'batch', args: ['B1'] },
    ]);
    expect(binding.store.batch()?.counts).toEqual({
      approved: 0,
      sent: 1,
      failed: 1,
      recalled: 0,
    });
  });

  it('asks for nothing on the frames that are not an ending', async () => {
    const fake = fakeBridge();
    const binding = await bulked(fake);
    // The plan's wording is exact and this row is why: polled ONLY on
    // `draft.failed`/`draft.sent`. Not on an interval — there are no timers
    // in this renderer at all — and not on the frames that merely move a
    // card along, because a batch's tallies cannot have changed until one
    // of its drafts has finished.
    fake.push('event', {
      kind: 'event',
      seq: 2,
      event: {
        event: 'draft.approved',
        draftId: 'd1',
        actor: { kind: 'human', via: 'gui' },
      },
    } satisfies StreamFrame);
    fake.push('event', {
      kind: 'event',
      seq: 3,
      event: { event: 'draft.expired', draftId: 'd2' },
    } satisfies StreamFrame);
    await binding.settled();
    expect(fake.calls).toEqual([]);
  });

  it('asks for nothing when the ending belongs to no batch', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1', 'd2']));
    connected(fake);
    // A single-card approve is not a batch and has no report: `GET
    // /v1/batches/:id` over a card the operator approved with `a` would be
    // a request for a page that does not exist.
    fake.push('event', terminal(2, 'd1', 'sent'));
    await binding.settled();
    expect(fake.calls.filter((c) => c.channel === 'batch')).toEqual([]);
  });

  it('a report that will not load costs the tallies, never the queue', async () => {
    const fake = fakeBridge();
    const binding = await bulked(fake);
    fake.nextBatch(null, true);
    fake.push('event', terminal(2, 'd1', 'sent'));
    await binding.settled();
    expect(binding.store.batch()?.counts).toBeUndefined();
    expect(binding.store.batch()?.batchId).toBe('B1');
    expect(binding.store.rows()).toHaveLength(2);
  });

  it('ignores an answer that is not a report', async () => {
    const fake = fakeBridge();
    const binding = await bulked(fake);
    fake.nextBatch({ batchId: 'B1', sent: 'two', failed: null, approved: 1 });
    fake.push('event', terminal(2, 'd1', 'sent'));
    await binding.settled();
    // Narrowed value by value: the one number survives and the two
    // nonsense fields do not become `NaN` on a card.
    expect(binding.store.batch()?.counts).toEqual({ approved: 1 });
  });
});

/* ── retry, the failed card's only verb (s8 Sc9) ─────────────────────── */

describe('s8 Sc9 wiring: retry is one request and one hypothesis', () => {
  const failedFrame = (seq: number, draftId: string): StreamFrame => ({
    kind: 'event',
    seq,
    event: {
      event: 'draft.failed',
      draftId,
      error: { code: 'unverified', message: 'synthetic', at: AT },
    },
  });

  it('sends exactly one retry for the card, and nothing that could send', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.push('event', failedFrame(2, 'd1'));

    await binding.retry('d1');
    expect(fake.calls).toEqual([{ channel: 'retry', args: ['d1'] }]);
    expect(fake.calls.some((c) => /send/i.test(c.channel))).toBe(false);
    expect(binding.store.stateOf('d1')).toBe('approved');
  });

  it('a card that is not failed never reaches the wire', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    await binding.retry('d1');
    expect(fake.calls).toEqual([]);
  });

  it('a 409 past the retry ceiling settles the card and says so', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.push('event', failedFrame(2, 'd1'));
    // The shape the BRIDGE delivers, not the shape the route sends. The
    // daemon answers 409 `{error:'retry-limit', attempts}`; the client turns
    // that into a `DaemonConflictError` and main's `withRefusals` forwards
    // it as `{refused:'conflict', code}` — with NO `from`, because nobody
    // moved the draft and there is no other state to report. A conflict
    // without a `from` is therefore a refusal by definition, which is the
    // same shape `grace-elapsed` has and gets the same chip.
    fake.nextWrite({ refused: 'conflict', code: 'retry-limit' });

    await binding.retry('d1');
    expect(binding.store.row('d1')?.pending).toBeUndefined();
    expect(binding.store.chip('d1')).toEqual({
      kind: 'refused',
      reason: 'retry-limit',
    });
    expect(binding.store.stateOf('d1')).toBe('failed');
  });
});

/* ── the two name catalogues (s8 Sc6) ────────────────────────────────── */

describe('s8 Sc6 wiring: the catalogue is fetched once, and never on connect', () => {
  it('is not in the connect path, so a reconnect fetches drafts and nothing else', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    connected(fake);
    await binding.settled();
    // The whole point of keeping `loadCatalogue` off the connect path: the
    // channel sequence a reconnect produces stays the one Sc5 pinned. A
    // catalogue fetch wired into `onStream` would appear here and turn "the
    // store fetched the drafts it was owed" into "the store fetched three
    // things, one of which was the drafts".
    expect(fake.calls.map((c) => c.channel)).toEqual(['drafts']);
  });

  it('indexes rules by id and contacts by handle', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.nextCatalogue({
      rules: [{ id: 'r1', name: 'weeknight replies' }],
      contacts: [{ handle: '+15550002222', displayName: 'Second Line' }],
    });

    await binding.loadCatalogue();
    // s8 Sc9 adds a third read to the same one-shot fetch rather than a
    // second entry point. The settings map is catalogue-shaped in every way
    // that matters: read once, small, changed by somebody else's window,
    // and never worth a round trip per card.
    expect(fake.calls.map((c) => c.channel).sort()).toEqual([
      'contacts',
      'rules',
      'settings',
    ]);
    const cat = binding.store.catalogue();
    expect(cat.rules.get('r1')).toBe('weeknight replies');
    expect(cat.contacts.get('+15550002222')).toBe('Second Line');
  });

  it('drops a row it cannot read rather than indexing it under undefined', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.nextCatalogue({
      // In order: no name, no id, an empty name, a non-object, and one good
      // row. A card that found any of the first four would render a blank
      // where a rule name goes, which reads as "no rule" and is a different
      // claim from "a rule whose name did not load".
      rules: [
        { id: 'r1' },
        { name: 'nameless' },
        { id: 'r2', name: '' },
        'not a record',
        { id: 'r3', name: 'the real one' },
      ],
      contacts: 'not even an array',
    });

    await binding.loadCatalogue();
    const cat = binding.store.catalogue();
    expect([...cat.rules.entries()]).toEqual([['r3', 'the real one']]);
    expect(cat.contacts.size).toBe(0);
  });

  it('never rejects: a catalogue that will not load costs names, not the queue', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.nextCatalogue({
      rulesThrow: true,
      contactsThrow: true,
      settingsThrow: true,
    });

    await expect(binding.loadCatalogue()).resolves.toBeUndefined();
    expect(binding.store.catalogue().rules.size).toBe(0);
    // The cards are still there. A name that would not load is a degraded
    // card, never an empty screen.
    expect(binding.store.rows()).toHaveLength(1);
  });
});

/* ── the settings the retry footnote reads (s8 Sc9) ──────────────────── */

describe('s8 Sc9 wiring: settings are read as values, not as a schema', () => {
  it('flattens each entry to its value and keeps only the strings', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    // `SettingsPayload` is `Record<string, {value, default, version, type,
    // readOnly, floor?, ceiling?, use?}>`. The renderer wants the value and
    // has no use for the rest — and, more to the point, an arch row forbids
    // this module from naming any identifier matching /send/i, which the
    // setting the retry footnote is about (`send.retryAsSms`) certainly is.
    // So the narrowing is GENERIC: every entry, its `value`, as a string.
    // The key is a string the store carries and never reads.
    fake.nextCatalogue({
      settings: {
        'send.retryAsSms': { value: false, default: false, type: 'boolean' },
        'send.capGlobalPerHour': { value: 30, default: 30, type: 'number' },
        'not an entry': 5,
        'no value at all': { default: 1 },
      },
    });

    await binding.loadCatalogue();
    const cat = binding.store.catalogue();
    expect(cat.settings.get('send.retryAsSms')).toBe('false');
    expect(cat.settings.get('send.capGlobalPerHour')).toBe('30');
    expect(cat.settings.has('not an entry')).toBe(false);
    expect(cat.settings.has('no value at all')).toBe(false);
  });

  it('a settings route that is down leaves the map empty, not the window', async () => {
    const fake = fakeBridge();
    const binding = bindStore(fake.bridge, { now: () => AT });
    fake.push('event', snapshotFrame(1, ['d1']));
    connected(fake);
    fake.nextCatalogue({ settingsThrow: true });
    await expect(binding.loadCatalogue()).resolves.toBeUndefined();
    expect(binding.store.catalogue().settings.size).toBe(0);
    expect(binding.store.rows()).toHaveLength(1);
  });
});

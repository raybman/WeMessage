/**
 * s8 Sc5 — the wiring, and the reason an optimistic approve cannot send.
 *
 * `store/index.ts` is the only part of the renderer that talks to the bridge,
 * and it is deliberately thin: subscribe to the two pushes, narrow them, hand
 * them to the reducer, and turn a keystroke into exactly one request. This
 * file is where INV-2 stops being an argument and becomes an observation —
 * the bridge handed to the binding is a `Pick` of three channels, the fake
 * below records every invocation, and the rows assert both that the send
 * channel was never called AND that it is not reachable from here at all.
 *
 * The compile-time half is the stronger one: `StoreBridge` is
 * `Pick<WmBridge, 'drafts' | 'approve' | 'bulk' | 'on'>`, so naming the
 * wizard's send-test channel in this module is a type error rather than a
 * policy violation somebody has to notice.
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
  listeners(): string[];
}

function fakeBridge(): Fake {
  const calls: Call[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  let drafts: readonly DraftPayload[] = [];
  let approveAnswer: unknown = { draft: draft('d1'), approvalId: 'a1' };
  let approveRejects = false;
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
    bridge: {
      drafts: record('drafts', () => drafts),
      bulk: record('bulk', () => ({
        batchId: 'B1',
        matched: 0,
        applied: 0,
        appliedIds: [],
        refused: [],
      })),
      approve: (...args: readonly unknown[]): Promise<unknown> => {
        calls.push({ channel: 'approve', args });
        return approveRejects
          ? Promise.reject(new Error(String(approveAnswer)))
          : Promise.resolve(approveAnswer);
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

describe('s8 Sc5 wiring: the store reaches three channels and no others', () => {
  it('the allowlist names nothing that could send', () => {
    expect([...STORE_CHANNELS]).toEqual(['approve', 'bulk', 'drafts']);
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
    expect(fake.calls).toEqual([
      { channel: 'bulk', args: ['approve', { ids: ['d1', 'd2'] }] },
    ]);
    expect(fake.calls.some((c) => /send/i.test(c.channel))).toBe(false);
  });
});

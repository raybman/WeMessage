/**
 * The wiring: the only part of the renderer that talks to the bridge.
 *
 * Deliberately thin, and deliberately narrow. It subscribes to the two
 * pushes, NARROWS them (a renderer that trusts its input shape is one bad
 * push away from a blank window), hands them to the reducer, and turns a
 * keystroke into exactly one request. It holds no policy: the reconnect
 * ladder is main's, the queue's meaning is the reducer's, and the daemon
 * owns everything either of them is about.
 *
 * INV-2's compile-time half lives on the next line but one. `StoreBridge` is
 * a `Pick` of three channels, so the send-test channel is not merely
 * unreachable from this module, it is not in this module's type. Naming it
 * is a type error rather than a convention somebody has to notice in review,
 * and no amount of optimism in the reducer can turn a displayed `approved`
 * into a dispatch: the request this file makes is `approve`, the daemon
 * answers it by recording an `Approval`, and the send happens inside the
 * daemon in `dispatchApproved` or not at all.
 *
 * The SECOND gap detector is here (the first is main's audit count). Frames
 * carry a monotonic sequence number that survives reconnects, so a frame
 * that never arrived — a push dropped on a window that was mid-reload, a
 * renderer that missed a beat — is arithmetic rather than a guess. The
 * recovery is the same as main's: refetch through a real route, never
 * reconstruct.
 */
import type { DraftPayload } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import type { StreamFrame } from '../../main/event-stream.js';
import type { WmBridge } from '../../preload/api.js';
import {
  createOptimisticStore,
  type ConnState,
  type OptimisticStore,
  type QueueAction,
} from './optimistic.js';

/**
 * The three channels the queue may reach, sorted.
 *
 * A list rather than a comment, so `store-wiring.spec.ts` can assert that
 * none of them matches the send pattern and that the set has not grown.
 */
export const STORE_CHANNELS = ['approve', 'bulk', 'drafts'] as const;

/**
 * The bridge, cut down to what the queue needs.
 *
 * `Pick` and not a structural copy: the keys are checked against the real
 * bridge type, so a channel that is renamed in `ipc-channels.ts` breaks this
 * line rather than silently becoming a call to a channel that no longer
 * exists.
 */
export type StoreBridge = Pick<WmBridge, 'approve' | 'bulk' | 'drafts' | 'on'>;

export interface StoreBinding {
  readonly store: OptimisticStore;
  approve(id: string): Promise<void>;
  bulk(ids: readonly string[], action: QueueAction): Promise<void>;
  /** Resolves when every request this binding started has finished. */
  settled(): Promise<void>;
  dispose(): void;
}

export interface BindOptions {
  now(): string;
}

/* ── narrowing ────────────────────────────────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

function asFrame(payload: unknown): StreamFrame | null {
  const p = asRecord(payload);
  if (p === null || typeof p['seq'] !== 'number') return null;
  if (p['kind'] === 'event') {
    const event = asRecord(p['event']);
    if (event === null || typeof event['event'] !== 'string') return null;
    return {
      kind: 'event',
      seq: p['seq'],
      event: event as unknown as GatewayEventPayload,
    };
  }
  if (p['kind'] === 'snapshot') {
    if (typeof p['at'] !== 'string' || typeof p['missed'] !== 'number')
      return null;
    if (!Array.isArray(p['drafts'])) return null;
    return {
      kind: 'snapshot',
      seq: p['seq'],
      at: p['at'],
      missed: p['missed'],
      drafts: p['drafts'] as readonly DraftPayload[],
    };
  }
  return null;
}

function asConnState(payload: unknown): ConnState | null {
  const p = asRecord(payload);
  const state = p?.['state'];
  return state === 'connected' || state === 'reconnecting' || state === 'down'
    ? state
    : null;
}

/** The three answers a draft action can come back with, as DATA. */
interface Refusals {
  conflict?: { from: string };
  denied?: { reason: string; retryAfter?: string };
}

function refusalOf(answer: unknown): Refusals | null {
  const a = asRecord(answer);
  if (a === null) return null;
  if (a['refused'] === 'conflict' && typeof a['from'] === 'string')
    return { conflict: { from: a['from'] } };
  if (a['refused'] === 'denied' && typeof a['reason'] === 'string')
    return {
      denied: {
        reason: a['reason'],
        ...(typeof a['retryAfter'] === 'string'
          ? { retryAfter: a['retryAfter'] }
          : {}),
      },
    };
  return null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : 'daemon-unavailable';
}

/* ── the binding ──────────────────────────────────────────────────────── */

export function bindStore(
  bridge: StoreBridge,
  options: BindOptions,
): StoreBinding {
  // `() => options.now()` and not `options.now`: handing a method to a
  // constructor detaches it from its object, and the store's clock is the
  // one dependency every ordering decision below is made against.
  const store = createOptimisticStore({ now: () => options.now() });
  const inflight = new Set<Promise<unknown>>();
  let lastSeq: number | null = null;
  let refetching = false;

  /**
   * Remember a request until it finishes, so `settled()` can be a real wait
   * rather than a count of microtasks. The tracked copy swallows the
   * rejection — the caller still gets the original promise and still has to
   * handle it — because a bookkeeping handle that rejects is an unhandled
   * rejection nobody asked for.
   */
  function track<T>(work: Promise<T>): Promise<T> {
    const done: Promise<void> = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.add(done);
    void done.then(() => inflight.delete(done));
    return work;
  }

  /**
   * The recovery, and the only thing that clears `needsSnapshot`.
   *
   * One at a time: two unknown ids in the same tick are one hole in one map,
   * and a refetch per event would turn a reconnect burst into a stampede.
   */
  function refetch(): void {
    if (refetching) return;
    refetching = true;
    void track(
      bridge
        .drafts()
        .then((answer) => {
          if (Array.isArray(answer))
            store.snapshot(answer as readonly DraftPayload[], {
              at: options.now(),
              missed: 0,
            });
        })
        .catch(() => {
          // The map stays marked stale, so the next frame or the next
          // reconnect tries again. Silence here is the alternative to a
          // spin, and main's stream is already telling the operator that
          // the daemon is unreachable.
        })
        .finally(() => {
          refetching = false;
        }),
    );
  }

  function onFrame(payload: unknown): void {
    const frame = asFrame(payload);
    if (frame === null) return;
    // Arithmetic, not a guess: sequence numbers survive reconnects, so a
    // hole is a frame that was pushed and never arrived.
    const gap = lastSeq !== null && frame.seq !== lastSeq + 1;
    lastSeq = frame.seq;
    if (frame.kind === 'snapshot')
      store.snapshot(frame.drafts, { at: frame.at, missed: frame.missed });
    else store.event(frame.event);
    if (gap) store.markStale();
    if (store.needsSnapshot()) refetch();
  }

  function onStream(payload: unknown): void {
    const state = asConnState(payload);
    if (state === null) return;
    store.setStream(state);
    // A renderer that has NEVER seen the queue is stale by definition, and
    // the moment there is a connection is the moment it can do something
    // about it. This is not belt-and-braces: main pushes its first snapshot
    // as soon as the socket opens, and a window that was still loading its
    // own JavaScript when that happened would otherwise sit empty until the
    // next reconnect. The stream state is REPLAYED to a window that finishes
    // loading, so this arrives even when everything else was missed.
    if (state === 'connected' && store.syncedAt() === undefined) {
      store.markStale();
      refetch();
    }
  }

  const offEvent = bridge.on('event', onFrame);
  const offStream = bridge.on('stream', onStream);

  return {
    store,

    /**
     * One keystroke, one request.
     *
     * The hypothesis is written BEFORE the await, so the card moves in the
     * same frame as the key that moved it. Everything after the await is
     * server truth replacing a guess: an answer, a refusal, or a failure.
     */
    async approve(id) {
      const started = store.approve(id);
      if (!started.ok) {
        if (started.refused === 'unknown-draft') refetch();
        return;
      }
      try {
        const answer = await track(bridge.approve(id));
        const refusal = refusalOf(answer);
        if (refusal?.conflict !== undefined) {
          store.conflict(id, {
            from: refusal.conflict.from as DraftPayload['state'],
          });
          return;
        }
        if (refusal?.denied !== undefined) {
          store.denied(id, refusal.denied);
          return;
        }
        const draft = asRecord(asRecord(answer)?.['draft']);
        if (draft !== null)
          store.ack(id, { draft: draft as unknown as DraftPayload });
      } catch (error) {
        store.failed(id, { reason: reasonOf(error) });
      }
    },

    /**
     * One request for the whole selection, and per-id outcomes applied
     * exactly as the route reports them. Sc3's bulk is not atomic, so a
     * client that rolled the selection back on a partial refusal would be
     * showing a queue the daemon does not have.
     */
    async bulk(ids, action) {
      const started = store.bulk(ids, action);
      if (!started.ok) return;
      try {
        const result = await track(
          bridge.bulk(action, { ids: [...started.started] }),
        );
        const r = asRecord(result);
        if (r !== null && Array.isArray(r['refused']))
          store.applyBulk(
            r as unknown as Parameters<typeof store.applyBulk>[0],
          );
      } catch {
        for (const id of started.started)
          store.failed(id, { reason: 'daemon-unavailable' });
      }
    },

    async settled(): Promise<void> {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },

    dispose(): void {
      offEvent();
      offStream();
    },
  };
}

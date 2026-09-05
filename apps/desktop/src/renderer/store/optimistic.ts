/**
 * The queue, as the renderer believes it to be.
 *
 * A pure reducer over four inputs: a SNAPSHOT (the daemon's list, which
 * always replaces), an EVENT (the daemon's news), an ACK (the daemon's answer
 * to something we asked for), and a HYPOTHESIS (what the operator just did,
 * before anyone has confirmed it). Everything the queue screen renders is
 * derived here, and nothing here can act.
 *
 * INV-2, structurally. This module imports two type-only modules and nothing
 * else: it has no bridge, no client, no transport, no timer. `approve()`
 * writes a row in a Map and returns; the request is `store/index.ts`'s job
 * and the SEND is the daemon's, reachable only through `dispatchApproved`
 * behind an approval the daemon itself recorded. A card that reads `approved`
 * on this screen is a display fact — the strongest thing it can possibly be
 * from in here, because the only way to make it a dispatch would be to add an
 * import this file would fail its arch row for having.
 *
 * The three-layer read (`stateOf`) is the whole design:
 *
 *     pending.hypothesis   what we just did, unconfirmed
 *     observed.state       what the daemon told us happened
 *     server.state         the row as last fetched
 *
 * `server` is only ever written by a fetch (a snapshot or an ack), never by
 * an event. `draft.approved` carries a `draftId` and an `actor` and no
 * `stateChangedAt`; a store that folded it into the payload would be
 * inventing an instant and then displaying it. So an event moves the row by
 * recording what it OBSERVED, and the payload stays the last thing the
 * daemon actually sent.
 */
import type { BulkResult, DraftPayload, DraftState } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';

/** The three verbs Sc3's bulk route takes, and the three a card offers. */
export type QueueAction = 'approve' | 'recall' | 'reject';

export type ConnState = 'connected' | 'reconnecting' | 'down';

/** What the operator did, and what we expect it to mean. */
export interface Pending {
  readonly action: QueueAction;
  /** When the keystroke happened, which is what a snapshot is compared to. */
  readonly at: string;
  readonly hypothesis: DraftState;
  /** Present when the hypothesis came from a selection, not one card. */
  readonly batchToken?: string;
}

/**
 * Why a card is wearing a badge. Three kinds, one per way a hypothesis can
 * end badly: somebody else moved it, the gate refused it, or the request
 * never landed.
 */
export type Chip =
  | { readonly kind: 'changed-elsewhere'; readonly state: DraftState }
  | {
      readonly kind: 'denied';
      readonly reason: string;
      readonly retryAfter?: string;
    }
  | { readonly kind: 'error'; readonly reason: string };

export interface Row {
  /** The last payload a FETCH produced. Never written by an event. */
  readonly server: DraftPayload;
  /** The last state an EVENT reported, with the instant we heard it. */
  readonly observed?: { readonly state: DraftState; readonly at: string };
  readonly pending?: Pending;
}

export type Refusal = 'offline' | 'unknown-draft' | 'in-flight';

export type Started =
  { readonly ok: true } | { readonly ok: false; readonly refused: Refusal };

export type BulkStarted =
  | {
      readonly ok: true;
      readonly batchToken: string;
      readonly started: readonly string[];
    }
  | { readonly ok: false; readonly refused: Refusal };

export interface OptimisticStore {
  subscribe(listener: () => void): () => void;
  rows(): readonly Row[];
  row(id: string): Row | undefined;
  stateOf(id: string): DraftState | undefined;
  chip(id: string): Chip | undefined;
  streamState(): ConnState;
  /** True when we know our map is stale and a refetch is owed. */
  needsSnapshot(): boolean;
  /** Audit rows written while we were disconnected, per the last resync. */
  missed(): number;
  syncedAt(): string | undefined;

  setStream(state: ConnState): void;
  /**
   * Declare the map stale from outside the reducer.
   *
   * The wiring's own gap detector — a hole in the IPC frame sequence — is
   * arithmetic about frames rather than a fact about drafts, so it cannot be
   * derived in here. It still means exactly what an unknown draft id means,
   * and it is owed exactly the same refetch.
   */
  markStale(): void;
  snapshot(
    drafts: readonly DraftPayload[],
    meta: { at: string; missed: number },
  ): void;
  event(payload: GatewayEventPayload): void;

  approve(id: string): Started;
  bulk(ids: readonly string[], action: QueueAction): BulkStarted;
  ack(id: string, answer: { draft: DraftPayload }): void;
  applyBulk(result: BulkResult): void;
  conflict(id: string, answer: { from: DraftState }): void;
  denied(id: string, answer: { reason: string; retryAfter?: string }): void;
  failed(id: string, answer: { reason: string }): void;
}

export interface OptimisticDeps {
  now(): string;
}

/** What a verb claims about a card while nobody has confirmed it. */
const HYPOTHESIS: Readonly<Record<QueueAction, DraftState>> = {
  approve: 'approved',
  recall: 'recalled',
  reject: 'rejected',
};

export function createOptimisticStore(deps: OptimisticDeps): OptimisticStore {
  let map = new Map<string, Row>();
  let chips = new Map<string, Chip>();
  let stream: ConnState = 'down';
  let stale = false;
  let gap = 0;
  let syncedAt: string | undefined;
  let batches = 0;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const put = (id: string, row: Row): void => {
    map = new Map(map);
    map.set(id, row);
  };

  const drop = (id: string): void => {
    map = new Map(map);
    map.delete(id);
  };

  const setChip = (id: string, chip: Chip): void => {
    chips = new Map(chips);
    chips.set(id, chip);
  };

  const clearChip = (id: string): void => {
    if (!chips.has(id)) return;
    chips = new Map(chips);
    chips.delete(id);
  };

  /**
   * Drop the hypothesis, keeping the key ABSENT rather than undefined.
   *
   * Rebuilt rather than destructured: `exactOptionalPropertyTypes` makes
   * "absent" and "undefined" different types, and a rest-spread that drops
   * one key is a lint error for an unused binding here.
   */
  const settled = (row: Row): Row => ({
    server: row.server,
    ...(row.observed === undefined ? {} : { observed: row.observed }),
  });

  /**
   * Record what an event says happened, and say whether anything changed.
   *
   * Idempotence lives here: the same frame twice is the same state once, so
   * a redelivery after a reconnect cannot double-notify a screen or
   * resurrect a hypothesis the first copy already ended.
   */
  const observe = (id: string, state: DraftState): boolean => {
    const row = map.get(id);
    if (!row) {
      stale = true;
      return true;
    }
    if (row.pending === undefined && row.observed?.state === state)
      return false;
    put(id, {
      ...settled(row),
      observed: { state, at: deps.now() },
    });
    return true;
  };

  const start = (id: string, action: QueueAction, token?: string): Started => {
    if (stream !== 'connected') return { ok: false, refused: 'offline' };
    const row = map.get(id);
    if (!row) {
      stale = true;
      return { ok: false, refused: 'unknown-draft' };
    }
    if (row.pending !== undefined) return { ok: false, refused: 'in-flight' };
    put(id, {
      ...row,
      pending: {
        action,
        at: deps.now(),
        hypothesis: HYPOTHESIS[action],
        ...(token === undefined ? {} : { batchToken: token }),
      },
    });
    clearChip(id);
    return { ok: true };
  };

  /** End a hypothesis and leave the card exactly as the daemon has it. */
  const rollback = (id: string, chip: Chip): void => {
    const row = map.get(id);
    if (!row) return;
    put(id, settled(row));
    setChip(id, chip);
    notify();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rows: () => [...map.values()],
    row: (id) => map.get(id),
    stateOf(id) {
      const row = map.get(id);
      if (!row) return undefined;
      return row.pending?.hypothesis ?? row.observed?.state ?? row.server.state;
    },
    chip: (id) => chips.get(id),
    streamState: () => stream,
    needsSnapshot: () => stale,
    missed: () => gap,
    syncedAt: () => syncedAt,

    markStale() {
      if (stale) return;
      stale = true;
      notify();
    },

    setStream(next) {
      if (stream === next) return;
      stream = next;
      notify();
    },

    /**
     * The snapshot REPLACES. A merge would leave a card on screen that the
     * daemon has already dropped, and a queue that only ever grows is the
     * one bug an operator cannot see: everything present is correct, and
     * what is wrong is invisible.
     *
     * The one thing carried across is a hypothesis NEWER than the refetch,
     * because the answer left the daemon before the keystroke happened and
     * so cannot be describing it. Anything older is superseded: the fetch
     * is the better witness.
     */
    snapshot(drafts, meta) {
      const at = Date.parse(meta.at);
      const next = new Map<string, Row>();
      for (const server of drafts) {
        const previous = map.get(server.id);
        const pending =
          previous?.pending !== undefined &&
          Date.parse(previous.pending.at) > at
            ? previous.pending
            : undefined;
        const observed =
          previous?.observed !== undefined &&
          Date.parse(previous.observed.at) > at
            ? previous.observed
            : undefined;
        next.set(server.id, {
          server,
          ...(observed === undefined ? {} : { observed }),
          ...(pending === undefined ? {} : { pending }),
        });
      }
      map = next;
      // A badge belongs to a card. When the card is gone, so is the badge.
      const kept = new Map<string, Chip>();
      for (const [id, chip] of chips) if (map.has(id)) kept.set(id, chip);
      chips = kept;
      gap = meta.missed;
      syncedAt = meta.at;
      stale = false;
      notify();
    },

    event(payload) {
      switch (payload.event) {
        case 'draft.approved':
        case 'draft.rejected':
        case 'draft.recalled': {
          const state: DraftState =
            payload.event === 'draft.approved'
              ? 'approved'
              : payload.event === 'draft.rejected'
                ? 'rejected'
                : 'recalled';
          if (observe(payload.draftId, state)) notify();
          return;
        }
        case 'draft.sent':
          if (observe(payload.draftId, 'sent')) notify();
          return;
        case 'draft.failed':
          if (observe(payload.draftId, 'failed')) notify();
          return;
        case 'draft.expired':
          if (observe(payload.draftId, 'expired')) notify();
          return;
        case 'draft.requeued':
          if (observe(payload.draftId, 'pending')) notify();
          return;
        case 'draft.superseded':
          // The card is terminal AND a newer draft exists that we have never
          // seen. The first half is a state change; the second is a hole.
          observe(payload.draftId, 'superseded');
          stale = true;
          notify();
          return;
        case 'draft.redrafted':
          // The old card is not in a new state, it is GONE — the queue holds
          // its replacement instead, and we have never seen that one.
          drop(payload.draftId);
          clearChip(payload.draftId);
          stale = true;
          notify();
          return;
        case 'draft.created':
          // The frame carries a `DraftSummary`, which is not a `DraftPayload`:
          // no `stateChangedAt`, no `inboundGuid`, no `idempotencyKey`, no
          // `originalBody`. Inserting one means inventing four fields, so the
          // store asks for the row it can actually have.
          stale = true;
          notify();
          return;
        case 'gate.denied': {
          // A denial is not a state change, so it never makes the map stale.
          // It is a badge, and only for a card we are holding.
          const id = payload.draftId;
          if (id === undefined || !map.has(id)) return;
          setChip(id, { kind: 'denied', reason: payload.reason });
          notify();
          return;
        }
        default:
          // Arrivals, rule matches, previews, toggles, adapter health, the
          // link state and the arming badge. None of them are this queue.
          return;
      }
    },

    approve(id) {
      const outcome = start(id, 'approve');
      // A refusal is not a change. `unknown-draft` is the exception: it
      // learned the map is stale, and the screen has to be told so the
      // wiring can go and fix it.
      if (outcome.ok || outcome.refused === 'unknown-draft') notify();
      return outcome;
    },

    bulk(ids, action) {
      if (stream !== 'connected') return { ok: false, refused: 'offline' };
      batches += 1;
      const token = `b${batches}`;
      const started: string[] = [];
      for (const id of ids) if (start(id, action, token).ok) started.push(id);
      notify();
      return { ok: true, batchToken: token, started };
    },

    /**
     * The HTTP answer. Server truth about the row, and NOT the end of the
     * hypothesis: `approve` returns once the daemon has recorded an
     * approval, which is strictly before the send. The card stays optimistic
     * until the event says otherwise.
     */
    ack(id, answer) {
      const row = map.get(id);
      if (!row) return;
      put(id, { ...row, server: answer.draft });
      notify();
    },

    /**
     * Sc3's bulk is not atomic — one batch, one frame per draft, per-id
     * refusals, no rollback — so this mirrors it exactly. Rolling the whole
     * selection back on a partial refusal would show cards moving that the
     * daemon in fact moved.
     */
    applyBulk(result) {
      for (const { id, error } of result.refused) {
        const row = map.get(id);
        if (!row) continue;
        put(id, settled(row));
        setChip(id, { kind: 'denied', reason: error });
      }
      notify();
    },

    conflict(id, answer) {
      const row = map.get(id);
      if (!row) return;
      put(id, {
        ...settled(row),
        observed: { state: answer.from, at: deps.now() },
      });
      setChip(id, { kind: 'changed-elsewhere', state: answer.from });
      notify();
    },

    denied(id, answer) {
      rollback(id, {
        kind: 'denied',
        reason: answer.reason,
        ...(answer.retryAfter === undefined
          ? {}
          : { retryAfter: answer.retryAfter }),
      });
    },

    failed(id, answer) {
      rollback(id, { kind: 'error', reason: answer.reason });
    },
  };
}

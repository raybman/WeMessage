/**
 * s8 Sc5 — optimistic reconciliation, as a pure reducer.
 *
 * The store is the renderer's model of a queue it does not own. Every row
 * here is one of the four things that can happen to a hypothesis: it is
 * confirmed (the event arrives), it is overtaken (409, somebody else moved
 * the card), it is refused (403, the gate said no), or it is superseded (a
 * snapshot, which REPLACES the map and is the only thing that ever does).
 *
 * INV-2 is structural here rather than tested: this module imports nothing
 * that can perform an action. It has no bridge, no client and no transport —
 * `approve()` records a HYPOTHESIS and returns; the request is the wiring's
 * job (`store/index.ts`, `store-wiring.spec.ts`) and the send is the
 * daemon's, reached only through `dispatchApproved`. A card that reads
 * `approved` on screen is a display fact. It is never a dispatch, and the
 * only way to make it one from here would be to add an import this file
 * would fail its arch row for having.
 */
import { describe, expect, it } from 'vitest';
import type { DraftPayload, DraftState } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  createOptimisticStore,
  type OptimisticStore,
} from '../../src/renderer/store/optimistic.js';

const AT = '2026-03-02T18:00:00.000Z';

function draft(id: string, state: DraftState = 'pending'): DraftPayload {
  return {
    id,
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15550001111',
    ruleId: null,
    adapterId: 'a1',
    idempotencyKey: `k-${id}`,
    body: `body ${id}`,
    originalBody: `body ${id}`,
    state,
    stateChangedAt: AT,
    expiresAt: '2026-03-02T19:00:00.000Z',
    createdAt: AT,
  };
}

/** A store that is connected and holds `ids`, at a controllable clock. */
function seeded(ids: readonly string[] = ['d1', 'd2']): {
  store: OptimisticStore;
  tick(ms: number): void;
  notifications(): number;
} {
  let ms = Date.parse(AT);
  let notifications = 0;
  const store = createOptimisticStore({
    now: () => new Date(ms).toISOString(),
  });
  store.subscribe(() => {
    notifications += 1;
  });
  store.setStream('connected');
  store.snapshot(
    ids.map((id) => draft(id)),
    { at: new Date(ms).toISOString(), missed: 0 },
  );
  return {
    store,
    tick: (delta: number) => {
      ms += delta;
    },
    notifications: () => notifications,
  };
}

const approvedEvent = (draftId: string): GatewayEventPayload => ({
  event: 'draft.approved',
  draftId,
  actor: { kind: 'human', via: 'gui' },
});

/* ── row 1: the happy path, and the view never flickers ──────────────── */

describe('s8 Sc5 optimistic row 1: approve, ack, event', () => {
  it('holds the hypothesis from the keystroke to the event and clears it there', () => {
    const { store, tick } = seeded();
    expect(store.stateOf('d1')).toBe('pending');

    expect(store.approve('d1')).toEqual({ ok: true });
    expect(store.row('d1')?.pending).toEqual({
      action: 'approve',
      at: AT,
      hypothesis: 'approved',
    });
    expect(store.stateOf('d1')).toBe('approved');

    // The HTTP answer is server truth about the row, and it does not end the
    // hypothesis: the card is approved and the SEND has not happened yet.
    tick(10);
    store.ack('d1', { draft: draft('d1', 'approved') });
    expect(store.row('d1')?.pending?.action).toBe('approve');
    expect(store.stateOf('d1')).toBe('approved');

    // The event does end it.
    tick(10);
    store.event(approvedEvent('d1'));
    expect(store.row('d1')?.pending).toBeUndefined();
    expect('pending' in (store.row('d1') as object)).toBe(false);
    expect(store.stateOf('d1')).toBe('approved');
    expect(store.chip('d1')).toBeUndefined();
  });

  it('the event alone is enough: an ack that never arrives changes nothing', () => {
    const { store } = seeded();
    store.approve('d1');
    store.event(approvedEvent('d1'));
    expect(store.stateOf('d1')).toBe('approved');
    expect(store.row('d1')?.pending).toBeUndefined();
  });

  it('OUT OF ORDER: an event that beats its own ack is not undone by it', () => {
    const { store, tick } = seeded();
    store.approve('d1');
    tick(5);
    store.event(approvedEvent('d1'));
    // The response to the request we made, arriving late and describing a row
    // the daemon has since moved on from. A store that trusted it would put
    // the card back into `pending` after the queue had already seen it go.
    tick(5);
    store.ack('d1', { draft: draft('d1', 'pending') });

    expect(store.stateOf('d1')).toBe('approved');
    expect(store.row('d1')?.pending).toBeUndefined();
  });

  it('DOUBLE APPLY: the same event twice is the same state once', () => {
    const { store } = seeded();
    store.approve('d1');
    store.event(approvedEvent('d1'));
    const after = store.row('d1');
    store.event(approvedEvent('d1'));
    expect(store.row('d1')).toEqual(after);
    expect(store.stateOf('d1')).toBe('approved');
    expect(store.rows().length).toBe(2);
  });

  it('DOUBLE APPLY: a second approve while one is in flight is refused, not queued', () => {
    const { store } = seeded();
    expect(store.approve('d1')).toEqual({ ok: true });
    expect(store.approve('d1')).toEqual({ ok: false, refused: 'in-flight' });
    expect(store.row('d1')?.pending?.at).toBe(AT);
  });

  it('server truth is never rewritten by a frame: the payload stays what the daemon last sent', () => {
    const { store } = seeded();
    const before = store.row('d1')?.server;
    store.approve('d1');
    store.event(approvedEvent('d1'));
    // `draft.approved` carries a draftId and an actor. It carries no
    // `stateChangedAt`, so a store that wrote one into `server` would be
    // inventing the instant it displayed.
    expect(store.row('d1')?.server).toEqual(before);
    expect(store.stateOf('d1')).toBe('approved');
  });
});

/* ── row 2: 409, somebody else moved it ──────────────────────────────── */

describe('s8 Sc5 optimistic row 2: conflict', () => {
  it('clears the hypothesis, adopts the server state, and says so', () => {
    const { store } = seeded();
    store.approve('d1');
    store.conflict('d1', { from: 'sending' });

    expect(store.row('d1')?.pending).toBeUndefined();
    expect(store.stateOf('d1')).toBe('sending');
    expect(store.chip('d1')).toEqual({
      kind: 'changed-elsewhere',
      state: 'sending',
    });
    expect(store.rows().length).toBe(2);
  });
});

/* ── row 3: 403, the gate said no ────────────────────────────────────── */

describe('s8 Sc5 optimistic row 3: denied', () => {
  it('rolls the hypothesis back, leaves the row alone, and carries the instant', () => {
    const { store } = seeded();
    const before = store.row('d1');
    store.approve('d1');
    store.denied('d1', {
      reason: 'rate-limited',
      retryAfter: '2026-03-02T18:05:00.000Z',
    });

    expect(store.row('d1')).toEqual(before);
    expect(store.stateOf('d1')).toBe('pending');
    expect(store.chip('d1')).toEqual({
      kind: 'denied',
      reason: 'rate-limited',
      retryAfter: '2026-03-02T18:05:00.000Z',
    });
  });

  it('a deny with no retry instant omits the key rather than carrying undefined', () => {
    const { store } = seeded();
    store.approve('d1');
    store.denied('d1', { reason: 'outside-window' });
    const chip = store.chip('d1');
    expect(chip).toEqual({ kind: 'denied', reason: 'outside-window' });
    expect('retryAfter' in (chip as object)).toBe(false);
  });
});

/* ── row 4: an id we have never heard of ─────────────────────────────── */

describe('s8 Sc5 optimistic row 4: unknown ids', () => {
  it('asks for a snapshot and inserts nothing', () => {
    const { store } = seeded();
    store.event({
      event: 'draft.sent',
      draftId: 'nope',
      sentMessageGuid: 'guid-1',
    });

    expect(store.needsSnapshot()).toBe(true);
    expect(store.row('nope')).toBeUndefined();
    expect(store.rows().map((r) => r.server.id)).toEqual(['d1', 'd2']);
  });

  it('draft.created is an unknown id too: the frame carries a summary, not a row', () => {
    const { store } = seeded();
    store.event({
      event: 'draft.created',
      draft: {
        id: 'd9',
        chatGuid: 'iMessage;-;+15550001111',
        handle: '+15550001111',
        ruleId: null,
        adapterId: 'a1',
        body: 'hello',
        state: 'pending',
        expiresAt: '2026-03-02T19:00:00.000Z',
        createdAt: AT,
      },
    });
    // A `DraftSummary` is not a `DraftPayload`: it has no `stateChangedAt`,
    // no `inboundGuid`, no `idempotencyKey` and no `originalBody`. Inserting
    // one would mean inventing four fields, so the store refetches instead.
    expect(store.needsSnapshot()).toBe(true);
    expect(store.row('d9')).toBeUndefined();
  });

  it('approving an id we do not hold is refused', () => {
    const { store } = seeded();
    expect(store.approve('nope')).toEqual({
      ok: false,
      refused: 'unknown-draft',
    });
    expect(store.needsSnapshot()).toBe(true);
  });
});

/* ── row 5: a snapshot REPLACES ──────────────────────────────────────── */

describe('s8 Sc5 optimistic row 5: snapshot replaces the map', () => {
  it('a draft absent from the snapshot is gone, hypothesis and all', () => {
    const { store, tick } = seeded(['d1', 'd2', 'd3']);
    store.approve('d2');
    expect(store.stateOf('d2')).toBe('approved');

    tick(1000);
    store.snapshot([draft('d1'), draft('d3')], {
      at: '2026-03-02T18:00:01.000Z',
      missed: 4,
    });

    expect(store.rows().map((r) => r.server.id)).toEqual(['d1', 'd3']);
    expect(store.row('d2')).toBeUndefined();
    expect(store.stateOf('d2')).toBeUndefined();
    expect(store.missed()).toBe(4);
    expect(store.syncedAt()).toBe('2026-03-02T18:00:01.000Z');
    expect(store.needsSnapshot()).toBe(false);
  });

  it('a hypothesis older than the snapshot is superseded by it', () => {
    const { store, tick } = seeded();
    store.approve('d1');
    tick(1000);
    store.snapshot([draft('d1'), draft('d2')], {
      at: '2026-03-02T18:00:01.000Z',
      missed: 0,
    });
    expect(store.row('d1')?.pending).toBeUndefined();
    expect(store.stateOf('d1')).toBe('pending');
  });

  it('a hypothesis NEWER than the snapshot survives it', () => {
    const { store, tick } = seeded();
    // The refetch left at 18:00:01. The keystroke happened at 18:00:02, while
    // it was still in flight, so the answer cannot possibly describe it.
    tick(2000);
    store.approve('d1');
    store.snapshot([draft('d1'), draft('d2')], {
      at: '2026-03-02T18:00:01.000Z',
      missed: 0,
    });
    expect(store.row('d1')?.pending?.action).toBe('approve');
    expect(store.stateOf('d1')).toBe('approved');
  });

  it('chips for rows that survived survive; chips for rows that vanished do not', () => {
    const { store } = seeded(['d1', 'd2']);
    store.approve('d1');
    store.denied('d1', { reason: 'outside-window' });
    store.approve('d2');
    store.denied('d2', { reason: 'outside-window' });
    store.snapshot([draft('d1')], { at: AT, missed: 0 });
    expect(store.chip('d1')).toEqual({
      kind: 'denied',
      reason: 'outside-window',
    });
    expect(store.chip('d2')).toBeUndefined();
  });
});

/* ── row 6: offline refuses at the keymap ────────────────────────────── */

describe('s8 Sc5 optimistic row 6: a stream that is not connected', () => {
  it('refuses the approve and mutates nothing', () => {
    const { store, notifications } = seeded();
    const before = store.rows();
    const seen = notifications();
    store.setStream('reconnecting');

    expect(store.approve('d1')).toEqual({ ok: false, refused: 'offline' });
    expect(store.rows()).toEqual(before);
    expect(store.chip('d1')).toBeUndefined();
    // `setStream` is itself a change; the refused approve is not.
    expect(notifications()).toBe(seen + 1);
  });

  it('refuses a bulk the same way, all or nothing', () => {
    const { store } = seeded();
    store.setStream('down');
    expect(store.bulk(['d1', 'd2'], 'approve')).toEqual({
      ok: false,
      refused: 'offline',
    });
    expect(store.row('d1')?.pending).toBeUndefined();
    expect(store.row('d2')?.pending).toBeUndefined();
  });
});

/* ── row 7: bulk ─────────────────────────────────────────────────────── */

describe('s8 Sc5 optimistic row 7: bulk', () => {
  it('one hypothesis per id, all carrying the same batch token', () => {
    const { store } = seeded(['d1', 'd2', 'd3']);
    const started = store.bulk(['d1', 'd2', 'd3'], 'approve');
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');

    const tokens = ['d1', 'd2', 'd3'].map(
      (id) => store.row(id)?.pending?.batchToken,
    );
    expect(tokens).toEqual([
      started.batchToken,
      started.batchToken,
      started.batchToken,
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(store.stateOf('d2')).toBe('approved');
  });

  it('a partial result clears the refused ids one at a time and keeps the rest', () => {
    const { store } = seeded(['d1', 'd2', 'd3']);
    store.bulk(['d1', 'd2', 'd3'], 'approve');
    // Sc3's bulk is NOT atomic: one batchId, one frame per draft, per-id
    // refusals and no rollback. The store has to mirror that exactly, or a
    // partial batch would leave two cards lying in opposite directions.
    store.applyBulk({
      batchId: 'B1',
      matched: 3,
      applied: 2,
      appliedIds: ['d1', 'd3'],
      refused: [{ id: 'd2', error: 'outside-window' }],
    });

    expect(store.row('d1')?.pending?.batchToken).toBeDefined();
    expect(store.row('d3')?.pending?.batchToken).toBeDefined();
    expect(store.row('d2')?.pending).toBeUndefined();
    expect(store.chip('d2')).toEqual({
      kind: 'denied',
      reason: 'outside-window',
    });
    expect(store.stateOf('d1')).toBe('approved');
    expect(store.stateOf('d2')).toBe('pending');

    // …and the applied ones still end at their events, individually.
    store.event(approvedEvent('d1'));
    expect(store.row('d1')?.pending).toBeUndefined();
    expect(store.row('d3')?.pending?.batchToken).toBeDefined();
  });

  it('a bulk over an id we do not hold refuses that id and asks for a snapshot', () => {
    const { store } = seeded(['d1']);
    const started = store.bulk(['d1', 'gone'], 'approve');
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');
    expect(started.started).toEqual(['d1']);
    expect(store.needsSnapshot()).toBe(true);
  });
});

/* ── the four Sc3 lifecycle events ───────────────────────────────────── */

describe('s8 Sc5: the lifecycle events a queue can reach with nobody touching it', () => {
  it('draft.expired moves the card and ends any hypothesis on it', () => {
    const { store } = seeded();
    store.approve('d1');
    store.event({ event: 'draft.expired', draftId: 'd1' });
    expect(store.stateOf('d1')).toBe('expired');
    expect(store.row('d1')?.pending).toBeUndefined();
  });

  it('draft.superseded moves the card and asks about the draft that replaced it', () => {
    const { store } = seeded();
    store.event({
      event: 'draft.superseded',
      draftId: 'd1',
      byDraftId: 'd9',
    });
    expect(store.stateOf('d1')).toBe('superseded');
    expect(store.needsSnapshot()).toBe(true);
    expect(store.row('d9')).toBeUndefined();
  });

  it('draft.redrafted removes the old card rather than leaving a ghost', () => {
    const { store } = seeded();
    store.event({
      event: 'draft.redrafted',
      draftId: 'd1',
      newDraftId: 'd9',
    });
    expect(store.row('d1')).toBeUndefined();
    expect(store.rows().map((r) => r.server.id)).toEqual(['d2']);
    expect(store.needsSnapshot()).toBe(true);
  });

  it('draft.requeued puts the card back in the queue', () => {
    const { store } = seeded();
    store.approve('d1');
    store.event({ event: 'draft.requeued', draftId: 'd1' });
    expect(store.stateOf('d1')).toBe('pending');
    expect(store.row('d1')?.pending).toBeUndefined();
  });

  it('gate.denied about a card we hold becomes that card’s chip', () => {
    const { store } = seeded();
    store.event({
      event: 'gate.denied',
      reason: 'outside-window',
      chatGuid: 'iMessage;-;+15550001111',
      draftId: 'd1',
    });
    expect(store.chip('d1')).toEqual({
      kind: 'denied',
      reason: 'outside-window',
    });
    expect(store.stateOf('d1')).toBe('pending');
  });

  it('an event with nothing to do with drafts changes nothing at all', () => {
    const { store, notifications } = seeded();
    const before = store.rows();
    const seen = notifications();
    store.event({ event: 'connection.state', state: 'fully-connected' });
    store.event({ event: 'message.unsent', guid: 'g1' });
    expect(store.rows()).toEqual(before);
    expect(store.needsSnapshot()).toBe(false);
    expect(notifications()).toBe(seen);
  });
});

/* ── subscribe/notify ────────────────────────────────────────────────── */

describe('s8 Sc5: the store notifies on change and only on change', () => {
  it('one notification per mutation, none for a refusal', () => {
    const { store, notifications } = seeded();
    const seen = notifications();
    store.approve('d1');
    expect(notifications()).toBe(seen + 1);
    store.approve('d1'); // in-flight: refused
    expect(notifications()).toBe(seen + 1);
    store.event(approvedEvent('d1'));
    expect(notifications()).toBe(seen + 2);
    store.event(approvedEvent('d1')); // idempotent: nothing changed
    expect(notifications()).toBe(seen + 2);
  });

  it('unsubscribing stops the notifications', () => {
    const { store } = seeded();
    let count = 0;
    const off = store.subscribe(() => {
      count += 1;
    });
    store.approve('d1');
    off();
    store.event(approvedEvent('d1'));
    expect(count).toBe(1);
  });
});

/* ── the sidecars: facts that ride a frame and are not on the row ─────── */

describe('s8 Sc6: the failure sidecar remembers what the frame said', () => {
  /**
   * Two sidecars now sit beside the row map for the same structural reason
   * and behave differently for a good one.
   *
   * `clampOf` exists because a clamp is on the `draft.created` frame and on
   * NOTHING else (F-108): a refetch is silent about it, so the sidecar is
   * the only copy and a snapshot must not disturb it.
   *
   * `failureOf` exists because a card has to say WHY it failed the instant
   * it turns red, and `draft.failed` is the only thing that knows before the
   * next fetch. But `DraftPayload` HAS an `error` field, so the refetched
   * row is authoritative and `cardOf` prefers it — the sidecar is a stand-in
   * until the record catches up, not a second opinion competing with it.
   *
   * Both are keyed by draft id and pruned by the snapshot, because a map
   * that only ever grew would leak a string per draft for the lifetime of
   * the window.
   */
  /** The wire's own closed set (C-6), read off the frame rather than retyped. */
  type FailureCode = Extract<
    GatewayEventPayload,
    { event: 'draft.failed' }
  >['error']['code'];

  const failedEvent = (
    draftId: string,
    code: FailureCode,
  ): GatewayEventPayload => ({
    event: 'draft.failed',
    draftId,
    error: { code, message: `synthetic ${code}`, at: AT },
  });

  it('records the dispatcher’s code and moves the card in one event', () => {
    const { store, notifications } = seeded();
    const seen = notifications();
    expect(store.failureOf('d1')).toBeUndefined();
    store.event(failedEvent('d1', 'group-send-disabled'));
    expect(store.stateOf('d1')).toBe('failed');
    expect(store.failureOf('d1')).toBe('group-send-disabled');
    expect(notifications()).toBe(seen + 1);
    // The row itself is untouched: an event is not a fetch, and the server
    // layer is the last thing anybody fetched.
    expect(store.row('d1')?.server.error).toBeUndefined();
    expect(store.failureOf('d2')).toBeUndefined();
  });

  it('the same failure twice notifies once', () => {
    const { store, notifications } = seeded();
    store.event(failedEvent('d1', 'backend-error'));
    const seen = notifications();
    store.event(failedEvent('d1', 'backend-error'));
    expect(notifications()).toBe(seen);
    expect(store.failureOf('d1')).toBe('backend-error');
  });

  it('a requeue takes the verdict back, code and all', () => {
    const { store } = seeded();
    store.event(failedEvent('d1', 'no-conversation'));
    store.event({ event: 'draft.requeued', draftId: 'd1' });
    expect(store.stateOf('d1')).toBe('pending');
    // A card back in the queue still wearing the last attempt's error would
    // be reporting a decision that has been withdrawn.
    expect(store.failureOf('d1')).toBeUndefined();
  });

  it('a redraft takes the whole card with it', () => {
    const { store } = seeded();
    store.event(failedEvent('d1', 'backend-error'));
    store.event({ event: 'draft.redrafted', draftId: 'd1', newDraftId: 'd9' });
    expect(store.row('d1')).toBeUndefined();
    expect(store.failureOf('d1')).toBeUndefined();
  });

  it('a snapshot prunes codes for drafts that are gone and keeps the rest', () => {
    const { store } = seeded();
    store.event(failedEvent('d1', 'backend-error'));
    store.event(failedEvent('d2', 'no-conversation'));
    store.snapshot([draft('d2', 'failed')], { at: AT, missed: 0 });
    // d1 left the queue between the frame and the fetch, so its code goes
    // with it; d2 is still here and the frame is still the only place its
    // reason has been seen.
    expect(store.failureOf('d1')).toBeUndefined();
    expect(store.failureOf('d2')).toBe('no-conversation');
  });
});

/* ── s8 Sc7: the local refusal, which is where INV-2 hides ───────────── */

describe('s8 Sc7: a verb the card cannot take never reaches the wire', () => {
  /**
   * The edge-state half of INV-2.
   *
   * Every other refusal in this file is about the LINK or about a request
   * already in flight. This one is about the CARD: a draft that expired
   * under the cursor, a draft somebody else approved from the CLI, a draft
   * the operator is looking at a stale copy of. The daemon would answer all
   * three with a 409, and answering them here instead is not an
   * optimisation — it is the property that makes "no edge-state recovery
   * path becomes a second dispatch" provable by counting requests rather
   * than by reading rollback code.
   *
   * Deliberately NOT the three-layer read. There is no hypothesis to read
   * (the line above this guard proved the row has none), so the comparison
   * is against the same two layers the daemon would compare against.
   */
  const settledStore = (state: DraftState): OptimisticStore => {
    const store = createOptimisticStore({ now: () => AT });
    store.setStream('connected');
    store.snapshot([draft('d1', state)], { at: AT, missed: 0 });
    return store;
  };

  it('refuses approve on every state that is not pending, and chips the truth', () => {
    const states: readonly DraftState[] = [
      'approved',
      'sending',
      'sent',
      'rejected',
      'recalled',
      'expired',
      'superseded',
      'failed',
    ];
    for (const state of states) {
      const store = settledStore(state);
      expect(store.approve('d1'), state).toEqual({
        ok: false,
        refused: 'wrong-state',
      });
      // No hypothesis was written, so nothing on screen moved…
      expect(store.row('d1')?.pending, state).toBeUndefined();
      expect(store.stateOf('d1'), state).toBe(state);
      // …and the keystroke is still accounted for, in the daemon's own word
      // for where the card actually is.
      expect(store.chip('d1'), state).toEqual({ kind: 'error', reason: state });
    }
  });

  it('still allows the one state approve is legal from', () => {
    // The guard has to be narrow as well as present: a refusal that also
    // refused `pending` would pass every row above and break the app.
    const store = settledStore('pending');
    expect(store.approve('d1')).toEqual({ ok: true });
    expect(store.chip('d1')).toBeUndefined();
  });

  it('reads the EVENT layer, not only the last fetch', () => {
    // The realistic shape: the row was fetched while pending, a
    // `draft.expired` frame arrived, and nothing has refetched. An event may
    // not write `server`, so a guard that read `server.state` alone would
    // wave this approve straight through to a 409.
    const store = settledStore('pending');
    store.event({ event: 'draft.expired', draftId: 'd1' });
    expect(store.row('d1')?.server.state).toBe('pending');
    expect(store.approve('d1')).toEqual({ ok: false, refused: 'wrong-state' });
    expect(store.chip('d1')).toEqual({ kind: 'error', reason: 'expired' });
  });

  it('notifies, because a chip nobody paints is a keystroke that vanished', () => {
    let seen = 0;
    const store = settledStore('expired');
    store.subscribe(() => {
      seen += 1;
    });
    store.approve('d1');
    expect(seen).toBe(1);
  });

  it('recall is legal from approved and refused from pending', () => {
    // §1.7's human rows, and the reason the table is per-verb rather than a
    // single `state === 'pending'` test: a shared guard would make the
    // recall key dead on exactly the cards it exists for.
    const settled = settledStore('approved');
    expect(settled.bulk(['d1'], 'recall').ok).toBe(true);

    const fresh = settledStore('pending');
    fresh.bulk(['d1'], 'recall');
    expect(fresh.row('d1')?.pending).toBeUndefined();
    expect(fresh.chip('d1')).toEqual({ kind: 'error', reason: 'pending' });
  });

  it('the link is checked BEFORE the card, so a dropped link never chips', () => {
    // Order matters for what the operator is told. Offline is a fact about
    // the app; wrong-state is a fact about the draft. A disconnected queue
    // that chipped every card the operator pressed `a` on would be blaming
    // the drafts for the socket.
    const store = settledStore('expired');
    store.setStream('reconnecting');
    expect(store.approve('d1')).toEqual({ ok: false, refused: 'offline' });
    expect(store.chip('d1')).toBeUndefined();
  });
});

/* ── s8 Sc9: one operator act, N things in the world ─────────────────── */

/**
 * s8-execution Scenario 9 — bulk, one batch, partial failure.
 *
 * Sc5 proved the store MIRRORS a non-atomic bulk: one hypothesis per id,
 * one shared token, per-id refusals, no rollback. Sc9 needs one thing more,
 * and it is a display fact rather than a state fact: after `⇧A` over three
 * cards the operator performed ONE act, and the screen owes them one place
 * that says how that one act turned out. The daemon has that place — a
 * `batchId` on every Approval row and `GET /v1/batches/:id` over it — so
 * the store's job is to remember which local batch is which daemon batch,
 * and to hold the counts somebody else fetched.
 *
 * Three decisions worth naming:
 *
 *  - **The batch is remembered by TOKEN first and `batchId` second.** The
 *    token is minted here, at the keystroke; the `batchId` is the daemon's
 *    and arrives with the HTTP answer, which is after the first frames can
 *    already have landed. A model that could only name the batch once the
 *    answer came back would drop the very first `draft.sent`.
 *  - **`refused` ids leave the batch.** They produced no Approval row, so
 *    they are not in `GET /v1/batches/:id` either, and a card that is
 *    counted in `3 SELECTED` but can never appear in the report would make
 *    the tallies never add up.
 *  - **The counts are held generically.** `BatchReport` has keys this store
 *    must not name (an arch row bans any `/send/i` identifier under the
 *    store root, and `sending` is one of them). The store keeps whatever
 *    numeric-valued keys it is handed; `derive/batch.ts` knows what they
 *    mean.
 */
describe('s8 Sc9: the batch the operator thinks they performed', () => {
  it('remembers the batch at the keystroke, before any answer comes back', () => {
    const { store } = seeded(['d1', 'd2', 'd3']);
    expect(store.batch()).toBeUndefined();

    const started = store.bulk(['d1', 'd2', 'd3'], 'approve');
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error('unreachable');

    const batch = store.batch();
    expect(batch?.token).toBe(started.batchToken);
    expect(batch?.action).toBe('approve');
    expect(batch?.ids).toEqual(['d1', 'd2', 'd3']);
    // Nobody has answered yet, so the daemon's name for it is not knowable.
    expect(batch?.batchId).toBeNull();
    expect(batch?.counts).toBeUndefined();
    // …and every member can be asked which batch it is in, which is how a
    // frame about one draft finds the batch it should refresh.
    for (const id of ['d1', 'd2', 'd3'])
      expect(store.batchMemberOf(id)).toBe(started.batchToken);
    expect(store.batchMemberOf('d9')).toBeUndefined();
  });

  it('takes the daemon’s name for the batch and drops the ids it refused', () => {
    const { store } = seeded(['d1', 'd2', 'd3']);
    store.bulk(['d1', 'd2', 'd3'], 'approve');
    store.applyBulk({
      batchId: 'B1',
      matched: 3,
      applied: 2,
      appliedIds: ['d1', 'd3'],
      refused: [{ id: 'd2', error: 'gate-denied' }],
    });

    expect(store.batch()?.batchId).toBe('B1');
    expect(store.batch()?.ids).toEqual(['d1', 'd3']);
    expect(store.batch()?.refused).toEqual([
      { id: 'd2', error: 'gate-denied' },
    ]);
    // d2 produced no Approval row, so it is in no report and belongs to no
    // batch: asking it which batch to refresh must answer nothing.
    expect(store.batchMemberOf('d2')).toBeUndefined();
    expect(store.batchMemberOf('d1')).toBeDefined();
  });

  it('holds whatever counts it is handed, for the batch it is holding', () => {
    const { store, notifications } = seeded(['d1', 'd2', 'd3']);
    store.bulk(['d1', 'd2', 'd3'], 'approve');
    store.applyBulk({
      batchId: 'B1',
      matched: 3,
      applied: 3,
      appliedIds: ['d1', 'd2', 'd3'],
      refused: [],
    });

    const seen = notifications();
    store.setBatchCounts('B1', { approved: 0, sent: 2, failed: 1 });
    expect(store.batch()?.counts).toEqual({ approved: 0, sent: 2, failed: 1 });
    expect(notifications()).toBe(seen + 1);

    // A report for a batch this store is not holding is a late answer to a
    // question that has been replaced, and it must not overwrite the one on
    // screen.
    store.setBatchCounts('B0', { approved: 9, sent: 9, failed: 9 });
    expect(store.batch()?.counts).toEqual({ approved: 0, sent: 2, failed: 1 });
  });

  it('replaces the batch on the next one, because there is only one card', () => {
    const { store } = seeded(['d1', 'd2', 'd3']);
    store.bulk(['d1', 'd2'], 'approve');
    store.applyBulk({
      batchId: 'B1',
      matched: 2,
      applied: 2,
      appliedIds: ['d1', 'd2'],
      refused: [],
    });
    const second = store.bulk(['d3'], 'reject');
    expect(second.ok).toBe(true);
    expect(store.batch()?.action).toBe('reject');
    expect(store.batch()?.ids).toEqual(['d3']);
    expect(store.batch()?.batchId).toBeNull();
    // The previous batch's members stop pointing at a batch that is no
    // longer on screen.
    expect(store.batchMemberOf('d1')).toBeUndefined();
  });

  it('records no batch for a bulk that never left the building', () => {
    const { store } = seeded(['d1', 'd2']);
    store.setStream('reconnecting');
    expect(store.bulk(['d1', 'd2'], 'approve')).toEqual({
      ok: false,
      refused: 'offline',
    });
    expect(store.batch()).toBeUndefined();
  });

  it('a snapshot keeps the batch, because the batch is not a row', () => {
    const { store } = seeded(['d1', 'd2']);
    store.bulk(['d1', 'd2'], 'approve');
    store.applyBulk({
      batchId: 'B1',
      matched: 2,
      applied: 2,
      appliedIds: ['d1', 'd2'],
      refused: [],
    });
    // The wiring refetches immediately after a bulk (a `BulkResult` carries
    // no draft payloads, so the rings have no window until it does). If the
    // snapshot cleared the batch, the batch card would be destroyed by the
    // very fetch that makes the cards it summarises tick.
    store.snapshot([draft('d1', 'approved'), draft('d2', 'approved')], {
      at: AT,
      missed: 0,
    });
    expect(store.batch()?.batchId).toBe('B1');
  });
});

/* ── s8 Sc9: what the batch says about the cards it refused ──────────── */

describe('s8 Sc9: a refusal that arrives twice still reads once', () => {
  it('does not overwrite a chip the frame already wrote', () => {
    const { store } = seeded(['d1', 'd2', 'd3']);
    store.bulk(['d1', 'd2', 'd3'], 'approve');

    // The daemon refuses the third approval on the hourly cap. That refusal
    // reaches this renderer TWICE and by two roads: a `gate.denied` frame
    // over the socket carrying the real reason, and the `refused` entry in
    // the HTTP answer carrying the route's generic error name. The frame is
    // the specific one — `rate-limited` tells an operator when to try again,
    // `gate-denied` tells them only that something said no — and the two
    // races, so whichever lands first, the specific one has to survive.
    store.event({
      event: 'gate.denied',
      chatGuid: 'iMessage;-;+15550001111',
      draftId: 'd3',
      reason: 'rate-limited',
    });
    expect(store.chip('d3')).toEqual({
      kind: 'denied',
      reason: 'rate-limited',
    });

    store.applyBulk({
      batchId: 'B1',
      matched: 3,
      applied: 2,
      appliedIds: ['d1', 'd2'],
      refused: [{ id: 'd3', error: 'gate-denied' }],
    });

    expect(store.chip('d3')).toEqual({
      kind: 'denied',
      reason: 'rate-limited',
    });
    // The hypothesis is still cleared: not overwriting the chip is about the
    // WORDS on the card, not about leaving it lying that it was approved.
    expect(store.row('d3')?.pending).toBeUndefined();
    expect(store.stateOf('d3')).toBe('pending');
  });

  it('writes its own chip when nothing got there first', () => {
    const { store } = seeded(['d1', 'd2']);
    store.bulk(['d1', 'd2'], 'approve');
    store.applyBulk({
      batchId: 'B1',
      matched: 2,
      applied: 1,
      appliedIds: ['d1'],
      refused: [{ id: 'd2', error: 'illegal-transition' }],
    });
    expect(store.chip('d2')).toEqual({
      kind: 'denied',
      reason: 'illegal-transition',
    });
  });
});

/* ── s8 Sc9: retry is a verb, and it is not a bulk verb ──────────────── */

describe('s8 Sc9: retry, the one verb a failed card has', () => {
  const failedEvent = (draftId: string): GatewayEventPayload => ({
    event: 'draft.failed',
    draftId,
    error: { code: 'unverified', message: 'synthetic unverified', at: AT },
  });

  it('starts only from failed, and mints the approved hypothesis', () => {
    const { store } = seeded(['d1', 'd2']);
    // A pending card has `a` for approve. Retry is not a second name for it.
    expect(store.retry('d1')).toEqual({ ok: false, refused: 'wrong-state' });

    store.event(failedEvent('d1'));
    expect(store.stateOf('d1')).toBe('failed');
    expect(store.retry('d1')).toEqual({ ok: true });
    // `POST /v1/drafts/:id/retry` puts the draft back to `approved` with a
    // FRESH grace window, so the card goes back to ringing and the
    // hypothesis has to say so.
    expect(store.stateOf('d1')).toBe('approved');
    expect(store.row('d1')?.pending?.action).toBe('retry');
    expect(store.row('d1')?.pending?.hypothesis).toBe('approved');
  });

  it('refuses a second retry while the first is in flight, and refuses offline', () => {
    const { store } = seeded(['d1']);
    store.event(failedEvent('d1'));
    expect(store.retry('d1')).toEqual({ ok: true });
    expect(store.retry('d1')).toEqual({ ok: false, refused: 'in-flight' });

    const other = seeded(['d2']);
    other.store.event(failedEvent('d2'));
    other.store.setStream('reconnecting');
    expect(other.store.retry('d2')).toEqual({ ok: false, refused: 'offline' });
    expect(other.store.retry('gone')).toEqual({
      ok: false,
      refused: 'offline',
    });
  });

  it('cannot be bulked, at the type level', () => {
    const { store } = seeded(['d1']);
    // The route's action enum is `z.enum(['approve','recall','reject'])`.
    // `bulk` takes the NARROWER union so a fourth verb cannot be posted to
    // a route that would 400 on it — and so nobody can retry twelve cards
    // with one keystroke, which is a decision, not an oversight.
    // @ts-expect-error 'retry' is not a BulkAction
    store.bulk(['d1'], 'retry');
  });
});

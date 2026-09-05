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

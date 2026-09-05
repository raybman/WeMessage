/**
 * s8-execution Scenario 6 — the card's view model, without a DOM.
 *
 * `cardOf` is the one place that decides what a card SAYS, and the reason it
 * is a pure function over the store's read model is so that these decisions
 * can be checked here rather than only through an Electron launch. The e2e
 * proves the strings reach the screen; these rows prove the choices behind
 * them, which is the half that a screenshot cannot see.
 *
 * Two of them are about the same rule from opposite sides. A failure code
 * has TWO sources — the `draft.failed` frame and the fetched row's own
 * `error` — and a clamp has exactly ONE (F-108: `clampedBy` rides the live
 * `draft.created` frame and is on no REST record). So the failure prefers
 * the payload and falls back to the sidecar, while the clamp can only ever
 * come from the sidecar; getting either backwards produces a badge that
 * appears or vanishes on a refetch for no reason the operator can see.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { describe, expect, it } from 'vitest';
import type { DraftPayload, DraftState } from '@wemessage/client';
import {
  byAge,
  cardOf,
  type CardContext,
} from '../../src/renderer/derive/queue.js';
import { STATE_GLYPH, STATE_WORD } from '../../src/renderer/derive/state.js';

const AT = '2026-03-02T18:00:00.000Z';
const NOW = '2026-03-02T18:05:00.000Z';

function draft(over: Partial<DraftPayload> = {}): DraftPayload {
  return {
    id: 'd1',
    inboundGuid: null,
    chatGuid: 'iMessage;-;+15550001111',
    ruleId: null,
    adapterId: 'a1',
    idempotencyKey: 'k-d1',
    body: 'on my way',
    originalBody: 'on my way',
    state: 'pending',
    stateChangedAt: AT,
    expiresAt: '2026-03-02T19:00:00.000Z',
    createdAt: AT,
    ...over,
  };
}

/**
 * The empty context: no names, no chip, no clamp, no remembered failure.
 *
 * Written as an explicit `CardContext` rather than a partial so that a field
 * added to the interface fails to compile here — a card gaining a source of
 * truth that no row in this file has an opinion about is exactly the change
 * that should stop and ask.
 */
function context(over: Partial<CardContext> = {}): CardContext {
  return {
    catalogue: { rules: new Map(), contacts: new Map() },
    state: 'pending',
    chip: undefined,
    clampedBy: undefined,
    failedWith: undefined,
    now: NOW,
    ...over,
  };
}

describe('s8 Sc6: a failure code has two sources and the record wins', () => {
  it('the payload’s error is the badge when the row has one', () => {
    const card = cardOf(
      draft({
        state: 'failed',
        error: { code: 'unverified', message: 'no outbound row', at: AT },
      }),
      context({ state: 'failed', failedWith: 'backend-error' }),
    );
    // The fetched row is the daemon's record; the sidecar is our
    // recollection of one frame. Two badges would be two accounts of one
    // event, and the wrong one winning would survive a refetch.
    expect(card.badges).toEqual(['UNVERIFIED']);
  });

  it('the remembered frame is the badge when the row has none', () => {
    const card = cardOf(
      // The realistic case, and the reason the sidecar exists: the card
      // turned `failed` on a frame and nothing has refetched it yet, so the
      // payload in hand is still the pending one that was fetched earlier.
      draft(),
      context({ state: 'failed', failedWith: 'group-send-disabled' }),
    );
    expect(card.badges).toEqual(['GROUP-SEND-DISABLED']);
  });

  it('no source means no badge, not an empty one', () => {
    expect(cardOf(draft(), context()).badges).toEqual([]);
  });
});

describe('s8 Sc6: a clamp is displayed when present and absent when not', () => {
  it('names the gate’s own reason, uppercased', () => {
    const card = cardOf(draft(), context({ clampedBy: 'outside-window' }));
    expect(card.badges).toEqual(['CLAMPED: OUTSIDE-WINDOW']);
  });

  it('is silent when the frame carried none', () => {
    // Silent, and NOT "CLAMPED: NONE". `clampedBy` is optional on the frame
    // under exactOptionalPropertyTypes, so absent is a different fact from
    // any value at all, and a badge that rendered the absence would put a
    // clamp on every unclamped card in the queue.
    const card = cardOf(draft(), context());
    expect(card.badges.some((b) => b.startsWith('CLAMPED'))).toBe(false);
  });

  it('rides the sidecar only — a clamp is never read off the row', () => {
    // A `DraftPayload` has no `clampedBy` field to read (F-108), which is
    // the property this row pins: the model is built from the context, so
    // widening the REST record later cannot silently become the source.
    const card = cardOf(draft(), context({ clampedBy: 'kill-switch' }));
    expect(card.badges).toEqual(['CLAMPED: KILL-SWITCH']);
    expect('clampedBy' in draft()).toBe(false);
  });
});

describe('s8 Sc6: every state carries a glyph AND a word before any colour', () => {
  const STATES: readonly DraftState[] = [
    'pending',
    'approved',
    'sending',
    'sent',
    'rejected',
    'recalled',
    'expired',
    'superseded',
    'failed',
  ];

  it('all nine, from the shared §3.10 table', () => {
    for (const state of STATES) {
      const card = cardOf(draft({ state }), context({ state }));
      expect(card.glyph, state).toBe(STATE_GLYPH[state]);
      expect(card.word, state).toBe(STATE_WORD[state]);
      expect(card.word, state).not.toBe('');
    }
  });

  it('pending and approved differ in SHAPE, not only in tint', () => {
    // The whole of the colour-carries-state rule in one assertion. Sc17
    // re-proves it with axe and a greyscale sweep; this is the row that
    // fails first, in milliseconds, when somebody makes two states share a
    // glyph and distinguishes them with a variable.
    const held = cardOf(draft(), context());
    const decided = cardOf(
      draft({ state: 'approved' }),
      context({ state: 'approved' }),
    );
    expect(held.glyph).not.toBe(decided.glyph);
    expect(held.word).not.toBe(decided.word);
  });

  it('the accessible label is words only, and never a glyph', () => {
    const card = cardOf(draft(), context());
    expect(card.label).toBe('PENDING · +15550001111 · on my way');
    for (const glyph of Object.values(STATE_GLYPH))
      expect(card.label).not.toContain(glyph);
  });
});

describe('s8 Sc6: the queue is a queue', () => {
  it('oldest first, ties broken by id so the list cannot shuffle', () => {
    const older = draft({ id: 'b', createdAt: AT });
    const newer = draft({ id: 'a', createdAt: NOW });
    const twin = draft({ id: 'c', createdAt: AT });
    expect([newer, twin, older].sort(byAge).map((d) => d.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

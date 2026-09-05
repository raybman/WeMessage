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
import { armingGlance } from '../../src/renderer/derive/armingGlance.js';
import {
  byAge,
  BODY_LINES,
  cardOf,
  clampBody,
  HELD_WITHOUT_REASON,
  type CardContext,
  type CardModel,
} from '../../src/renderer/derive/queue.js';
import { STATE_GLYPH, STATE_WORD } from '../../src/renderer/derive/state.js';

/**
 * A card's badges as plain strings.
 *
 * s8 Sc7 turned `badges` from `string[]` into `{text, title?}[]` so that the
 * one badge with a tooltip (`HELD` with no reason) has somewhere to put it.
 * Every row that only cares about the words reads through here, so the rows
 * that DO care about the tooltip are the only ones that mention it.
 */
const texts = (card: CardModel): readonly string[] =>
  card.badges.map((b) => b.text);

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
    // `settings` is s8 Sc9's addition to the catalogue and is read only by
    // the batch card, never by a draft card — so it is empty here on
    // purpose rather than absent, which under exactOptionalPropertyTypes is
    // a different type.
    catalogue: {
      rules: new Map(),
      contacts: new Map(),
      watching: [],
      settings: new Map(),
    },
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
    expect(texts(card)).toEqual(['UNVERIFIED']);
  });

  it('the remembered frame is the badge when the row has none', () => {
    const card = cardOf(
      // The realistic case, and the reason the sidecar exists: the card
      // turned `failed` on a frame and nothing has refetched it yet, so the
      // payload in hand is still the pending one that was fetched earlier.
      draft(),
      context({ state: 'failed', failedWith: 'group-send-disabled' }),
    );
    expect(texts(card)).toEqual(['GROUP-SEND-DISABLED']);
  });

  it('no source means no badge, not an empty one', () => {
    expect(texts(cardOf(draft(), context()))).toEqual([]);
  });
});

describe('s8 Sc6: a clamp is displayed when present and absent when not', () => {
  it('names the gate’s own reason, uppercased', () => {
    const card = cardOf(draft(), context({ clampedBy: 'outside-window' }));
    // `HELD · <REASON>` and not `CLAMPED: …`: F-108's own wording, adopted
    // in Sc7 when the same badge grew a second, reason-less shape.
    expect(texts(card)).toEqual(['HELD · OUTSIDE-WINDOW']);
  });

  it('is silent when the frame carried none', () => {
    // Silent, and NOT "HELD · NONE". `clampedBy` is optional on the frame
    // under exactOptionalPropertyTypes, so absent is a different fact from
    // any value at all, and a badge that rendered the absence would put a
    // clamp on every unclamped card in the queue.
    const card = cardOf(draft(), context());
    expect(texts(card).some((b) => b.startsWith('HELD'))).toBe(false);
  });

  it('rides the sidecar only — a clamp is never read off the row', () => {
    // A `DraftPayload` has no `clampedBy` field to read (F-108), which is
    // the property this row pins: the model is built from the context, so
    // widening the REST record later cannot silently become the source.
    const card = cardOf(draft(), context({ clampedBy: 'kill-switch' }));
    expect(texts(card)).toEqual(['HELD · KILL-SWITCH']);
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

/* ── s8 Sc7: the edge states, decided here and rendered elsewhere ─────── */

describe('s8 Sc7: a held draft whose reason nobody can recover says so', () => {
  it('badges HELD with the tooltip when the draft is proactive and nothing clamped it', () => {
    // The honest reproduction of F-108's gap. A proactive draft is one the
    // daemon decided to write on its own, which is exactly the class that
    // carries a `clampedBy` on its `draft.created` frame — and a window that
    // learned about it by FETCH (opened later, or refetched after a gap) has
    // the `proactiveReason` from the REST record and no clamp at all,
    // because `DraftPayload` has no field to carry one.
    const card = cardOf(
      draft({ proactiveReason: 'noticed an unanswered question' }),
      context(),
    );
    expect(texts(card)).toEqual(['PROACTIVE', 'HELD']);
    expect(card.badges.map((b) => b.title)).toEqual([
      undefined,
      HELD_WITHOUT_REASON,
    ]);
  });

  it('prefers the known reason when the frame carried one', () => {
    // Both facts present: the clamp WINS, because a reason is strictly more
    // than "there is a reason and it is gone". Two badges would be one
    // question asked twice.
    const card = cardOf(
      draft({ proactiveReason: 'noticed an unanswered question' }),
      context({ clampedBy: 'kill-switch' }),
    );
    expect(texts(card)).toEqual(['PROACTIVE', 'HELD · KILL-SWITCH']);
  });

  it('is silent once the draft has left pending', () => {
    // A card that expired is not being held by anything; it is over. The
    // badge would be describing a state the card is no longer in, which is
    // the failure mode the sidecar design exists to avoid.
    const card = cardOf(
      draft({ proactiveReason: 'noticed an unanswered question' }),
      context({ state: 'expired' }),
    );
    // TTL is the expired card's own badge, minted in this same scenario; the
    // claim under test is the ABSENCE of HELD, not the absence of everything.
    expect(texts(card)).toEqual(['PROACTIVE', 'TTL']);
  });

  it('says nothing at all about a draft a human asked for', () => {
    expect(texts(cardOf(draft(), context()))).toEqual([]);
  });
});

describe('s8 Sc7: a long body is clamped by arithmetic, never by a timer', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${String(i)}`).join(
    '\n',
  );

  it('keeps the first six lines and reports the real total', () => {
    const clamped = clampBody(long, false);
    expect(clamped.clamped).toBe(true);
    expect(clamped.lines).toBe(40);
    expect(clamped.text.split('\n')).toHaveLength(BODY_LINES);
    // The TOTAL, not the rendered count. What the affordance offers is the
    // rest of the message, and a card that said "SHOW ALL · 6 LINES" would
    // be describing what is already on screen.
    expect(clamped.text.split('\n')[0]).toBe('line 0');
  });

  it('expands to the whole thing, unchanged', () => {
    const opened = clampBody(long, true);
    expect(opened.clamped).toBe(false);
    expect(opened.text).toBe(long);
    expect(opened.lines).toBe(40);
  });

  it('leaves a short body alone, and does not claim it was clamped', () => {
    const short = 'on my way';
    const out = clampBody(short, false);
    expect(out).toEqual({ text: short, clamped: false, lines: 1 });
  });

  it('does not clamp a body that is exactly at the ceiling', () => {
    // The off-by-one that would put a `SHOW ALL` affordance on a card with
    // nothing more to show.
    const exact = Array.from({ length: BODY_LINES }, () => 'x').join('\n');
    expect(clampBody(exact, false).clamped).toBe(false);
  });
});

describe('s8 Sc7: the empty queue glances at the schedule', () => {
  it('says ARMED when there is no horizon to report', () => {
    expect(armingGlance({ reason: 'armed', until: null })).toBe('ARMED');
  });

  it('says ARMED UNTIL when there is one', () => {
    expect(
      armingGlance({ reason: 'armed', until: '2026-03-02T17:30:00.000Z' }),
    ).toMatch(/^ARMED UNTIL \d{2}:\d{2}$/);
  });

  it('says DISARMED for every other reason, and names none of them', () => {
    // The reason is the STRIP's to render: S6's dormant-deny-literal row
    // pins which production files may spell each of the gate's reasons and
    // this is not one of them. What the empty queue owes the operator is
    // what it COSTS them, which is the same sentence either way.
    const glance = armingGlance({ reason: 'held', until: null });
    expect(glance).toBe('DISARMED · QUEUE-ONLY');
    expect(armingGlance({ reason: 'paused', until: null })).toBe(glance);
  });

  it('treats "the daemon has no store" as disarmed rather than as armed', () => {
    // Erring towards the safer half of a genuine ambiguity: `null` means the
    // daemon could not derive arming at all, and a screen that guessed
    // ARMED would be telling an operator that replies are going out when
    // nothing knows whether they are.
    expect(armingGlance(null)).toBe('DISARMED · QUEUE-ONLY');
  });
});

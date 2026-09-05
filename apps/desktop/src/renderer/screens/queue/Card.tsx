/**
 * One draft, as the operator reads it.
 *
 * The card is the inside of an option, never the option itself: `role`,
 * `aria-selected` and `aria-label` are the listbox's, in the one file allowed
 * to mint them. What is decided here is what a person SEES, in the order
 * they need it — the state first, then who it is for, then the words that
 * would go out under their name.
 *
 * Nothing in here is interactive (INV-2, structurally). There is no approve
 * BUTTON: the approve affordance is a keystroke the screen above interprets,
 * legended on the active card, so an option stays one announceable thing and
 * there is no control that could grow a click handler that skips the
 * approval row. It also keeps `interactiveInOptions` at zero, which is what
 * keeps the whole window at one tab stop.
 *
 * §3.10 — every state is spelled THREE times before hue is involved: a glyph,
 * an uppercase word, and `data-state` on the option. A reader who cannot
 * distinguish the tint from the neutral reads ○ against ●; a screen reader is
 * handed the word; the e2e reads the attribute. Colour is the third carrier
 * and never the only one.
 */
import type { VNode } from 'preact';
import type { CardModel } from '../../derive/queue.js';
import type { Turn } from '../../store/optimistic.js';

export interface CardProps {
  readonly card: CardModel;
  /**
   * The keys that would act on THIS card, or absent when they would not.
   *
   * Rendered on the active card and nowhere else. Twenty legends is twenty
   * copies of the same sentence competing with the twenty bodies the
   * operator is actually reading, and a legend on a card the keys do not
   * act on is worse than no legend at all.
   */
  readonly legend: string | null;
  /** The turns to show inline, empty unless this card is expanded. */
  readonly turns: readonly Turn[];
}

export function Card(props: CardProps): VNode {
  const { card } = props;
  return (
    <div class="card">
      <div class="card-head">
        <span class="card-glyph">{card.glyph}</span>
        <span class="card-word">{card.word}</span>
        <span class="card-who">{card.who}</span>
        <span class="card-rule">{card.rule}</span>
        <span class="card-adapter">{card.adapter}</span>
        {/* The relative label is derived; the instant it was derived FROM
            rides the attribute, so a reader of this DOM can always recover
            the daemon's own record rather than our rounding of it. */}
        <span class="card-time" data-created={card.createdAt}>
          {card.timeLabel}
        </span>
      </div>
      <p class="card-body">{card.body}</p>
      {card.badges.length === 0 ? null : (
        <div class="card-badges">
          {card.badges.map((badge) => (
            <span key={badge} class="card-badge">
              {badge}
            </span>
          ))}
        </div>
      )}
      {/* Absent, not empty. An empty box for a draft with no reason is a box
          that teaches the operator to stop looking at it. */}
      {card.why === null ? null : <p class="card-why">{card.why}</p>}
      {card.hint === null ? null : <p class="card-hint">{card.hint}</p>}
      {props.turns.length === 0 ? null : (
        <div class="card-context">
          {props.turns.map((turn) => (
            <p key={turn.guid} class="turn">
              {turn.text}
            </p>
          ))}
        </div>
      )}
      {props.legend === null ? null : <p class="card-keys">{props.legend}</p>}
    </div>
  );
}

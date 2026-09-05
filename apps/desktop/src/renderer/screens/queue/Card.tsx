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
import { clampBody, type CardModel } from '../../derive/queue.js';
import { UndoRing } from './UndoRing.js';
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
  /**
   * Whether the operator has opened this card.
   *
   * One flag for two things — the inline context turns AND the full body —
   * because they are one question. A card with a second "show more" state
   * would need a second key, and the keymap Sc8's checkpoint runs on is
   * already the tightest thing in the app.
   */
  readonly expanded: boolean;
}

export function Card(props: CardProps): VNode {
  const { card } = props;
  const body = clampBody(card.body, props.expanded);
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
        {/* Only while the daemon says there is a window. The ring is drawn
            from the two instants it supplied, so an optimistic approval has
            none until the answer lands — which is honest: until then this
            window does not know the deadline it would be drawing. */}
        {card.ring === null ? null : <UndoRing ring={card.ring} />}
      </div>
      {/* Clamped by ARITHMETIC, not by a CSS line clamp: a clamp that hid
          lines the DOM still held would make "what does this card show"
          unanswerable from the DOM, which is the only thing the e2e and a
          screen reader both read. */}
      <p class="card-body" data-clamped={body.clamped ? 'yes' : 'no'}>
        {body.text}
      </p>
      {body.clamped ? (
        <p class="card-more">{`SHOW ALL · ${String(body.lines)} LINES · SPACE`}</p>
      ) : null}
      {card.badges.length === 0 ? null : (
        <div class="card-badges">
          {card.badges.map((badge) => (
            <span
              key={badge.text}
              class="card-badge"
              // Conditional, never `title={undefined}`: under
              // exactOptionalPropertyTypes an absent key and an undefined
              // one are different types, and only one of them leaves the
              // attribute off the element.
              {...(badge.title === undefined ? {} : { title: badge.title })}
            >
              {badge.text}
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

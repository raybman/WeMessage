/**
 * One operator act, as a summary of the N things the world did about it.
 *
 * s8 Scenario 9. Bulk is non-atomic all the way down: `POST /v1/drafts/bulk`
 * mints one `batchId`, stamps it on an Approval row per draft, emits one
 * lifecycle frame per draft carrying it, reports per-id `refused` entries,
 * and rolls nothing back. The CARDS render the N faithfully and always
 * have. What no card can say is which of them belonged to the keystroke the
 * operator pressed — and an operator who pressed ⇧A once, then watched two
 * cards go quiet and a third go red, is owed that.
 *
 * Pure, like every other file here: facts in, words out. It cannot fetch,
 * so the tallies are whatever the wiring last read from
 * `GET /v1/batches/:id`, and the honest rendering of "we have not been told
 * yet" is an absent tally rather than a zero.
 *
 * WHY THE NUMBERS GET THEIR NAMES BACK HERE. The store holds the counts as
 * `Record<string, number>`, unnamed. That is not laziness: an arch row
 * rejects any identifier matching /send/i anywhere under the store root —
 * including inside string literals, because the scanner strips comments and
 * keeps strings — and the daemon's report has a `sending` key. So the layer
 * that may not name that field keeps the numbers, and this layer, which is
 * allowed to, decides which of them an operator sees.
 */
import type { DraftState } from '@wemessage/client';
import type { BatchFacts, Catalogue } from '../store/optimistic.js';
import { STATE_GLYPH, STATE_WORD } from './state.js';

/**
 * The setting the retry footnote reads, by its own key.
 *
 * The daemon's spelling, not a friendlier one: an operator who goes looking
 * for this in Settings, in the CLI, or in a support thread finds the same
 * string (C-6).
 */
export const RETRY_AS_SMS = 'send.retryAsSms';

/**
 * The tallies a batch card shows, in the order it shows them.
 *
 * An ALLOWLIST in a fixed order rather than whatever came back, for the same
 * reason the wiring keeps one: a key added to the report upstream must not
 * appear on a card before somebody has decided what it means. The order is
 * the journey a draft takes — still waiting, gone, refused, taken back — so
 * two batches never present their numbers in two different arrangements.
 */
const TALLIED: readonly DraftState[] = [
  'approved',
  'sent',
  'failed',
  'recalled',
];

/**
 * One number, with the glyph and the word its own state already owns.
 *
 * §3.10 again, and the reason there is no `✓` here. The plan asked for a
 * tick on the success count; the glyph set is CLOSED (C-6) and a tick is
 * not in it, so the sent tally wears `●` — the same shape a sent CARD
 * wears — and the failed tally wears `⊘`. The requirement behind the
 * plan's wording is met exactly: the figure is monochrome, it is spelled in
 * a word as well as a shape, and nothing about it is coloured by success.
 */
export interface BatchTally {
  readonly key: string;
  readonly text: string;
}

export interface BatchModel {
  /** The DAEMON's id, or `null` while the answer is still in flight. */
  readonly batchId: string | null;
  readonly action: string;
  /** What the operator did, and to how many cards. */
  readonly headline: string;
  readonly tallies: readonly BatchTally[];
  /**
   * The one sentence this card exists to be able to say.
   *
   * Undo is per CARD. `z` is `POST /v1/drafts/:id/recall` over one draft;
   * there is no route, and no daemon concept, for taking a batch back. A
   * summary of one act that did not say so would invite exactly the wrong
   * expectation at exactly the wrong moment.
   */
  readonly note: string;
  /** What a retry would do, when there is something to retry. */
  readonly footnote: string | null;
}

const countOf = (
  counts: Readonly<Record<string, number>> | undefined,
  key: string,
): number => counts?.[key] ?? 0;

/**
 * Whether a retry would leave over a different network, in words.
 *
 * Read from the daemon's settings rather than assumed. `send.retryAsSms`
 * defaults to false, and a window that hard-coded that would be making a
 * claim on the operator's behalf about which network their words go out
 * over — which is not a detail, and not ours to guess. A value we have not
 * read yet says so; it does not say `OFF`.
 */
function smsFootnote(catalogue: Catalogue): string {
  const value = catalogue.settings.get(RETRY_AS_SMS);
  const word = value === undefined ? 'UNREAD' : value === 'true' ? 'ON' : 'OFF';
  return `SMS RETRY: ${word} (SETTINGS)`;
}

/**
 * The batch, as the operator reads it. `null` when there is no batch to read.
 *
 * ONE batch, because there is one card, because there was one keystroke. A
 * second bulk replaces this rather than stacking beside it: the operator who
 * performed a second act is asking about the second act.
 */
export function batchOf(
  facts: BatchFacts | undefined,
  catalogue: Catalogue,
): BatchModel | null {
  if (facts === undefined) return null;
  const tallies: BatchTally[] = [];
  for (const state of TALLIED) {
    const n = countOf(facts.counts, state);
    if (n > 0)
      tallies.push({
        key: state,
        text: `${STATE_GLYPH[state]} ${String(n)} ${STATE_WORD[state]}`,
      });
  }
  // Refusals are not a draft STATE — the cards they name never moved — so
  // they are counted from the route's own per-id entries rather than from
  // the report, which cannot see them: a refused draft has no Approval row,
  // so it carries no batchId and can never appear in `GET /v1/batches/:id`.
  if (facts.refused.length > 0)
    tallies.push({
      key: 'refused',
      text: `⊘ ${String(facts.refused.length)} REFUSED`,
    });
  const failed = countOf(facts.counts, 'failed');
  return {
    batchId: facts.batchId,
    action: facts.action,
    // The count of what is IN the batch, which is not the count the operator
    // selected: a card the daemon refused produced no Approval row and is in
    // no batch, and a headline that included it would never add up to the
    // tallies underneath it.
    headline: `${facts.action.toUpperCase()} · ${String(facts.ids.length)} IN ONE BATCH`,
    tallies,
    note: 'Z UNDOES ONE CARD, NOT THE BATCH',
    // Only once something has failed. The footnote answers "what would a
    // retry do", and until a card has failed there is nothing to retry and
    // the sentence is a fact about a network nobody asked about.
    footnote: failed > 0 ? smsFootnote(catalogue) : null,
  };
}

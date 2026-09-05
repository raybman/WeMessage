/**
 * The queue's view model: rows in, cards out, nothing in between.
 *
 * A pure function over the store's own read model. It cannot fetch, it
 * cannot act, and it holds no state — which is what makes it the place to
 * put every decision about what a card SAYS, and lets those decisions be
 * unit-tested without a DOM, a bridge or an Electron process.
 *
 * The three-layer read (`pending.hypothesis ?? observed.state ?? server.state`)
 * is the store's; this consumes its answer. TIME is different and is read
 * from `server` alone: lifecycle events carry no state-change instant, so a
 * card that timestamped itself from an event would be putting a fabricated
 * moment on screen next to a real one.
 */
import type { DraftPayload, DraftState } from '@wemessage/client';
import type { Catalogue, Chip } from '../store/optimistic.js';
import { chatParts } from './chat.js';
import { ago } from './format.js';
import { STATE_GLYPH, STATE_WORD } from './state.js';

export interface CardModel {
  readonly draftId: string;
  /** The DOM id, so `aria-activedescendant` and the e2e agree on one string. */
  readonly domId: string;
  readonly chatGuid: string;
  readonly state: DraftState;
  readonly glyph: string;
  readonly word: string;
  readonly who: string;
  readonly rule: string;
  readonly adapter: string;
  readonly timeLabel: string;
  readonly createdAt: string;
  readonly body: string;
  readonly badges: readonly string[];
  /** Why an agent proposed this unprompted, or absent. */
  readonly why: string | null;
  /** A signpost when the app knows nothing about this handle. */
  readonly hint: string | null;
  readonly isGroup: boolean;
  readonly label: string;
}

/** Everything a card needs that is not the draft itself. */
export interface CardContext {
  readonly catalogue: Catalogue;
  readonly state: DraftState;
  readonly chip: Chip | undefined;
  readonly clampedBy: string | undefined;
  /**
   * The failure code, from the live frame, when the fetched row has none.
   *
   * Two sources for one badge because `draft.failed` and `GET /v1/drafts/:id`
   * both know the answer and neither is always available: the frame is what a
   * watching window hears, the payload is what a refetch returns, and a card
   * that read only one of them would go blank in exactly the case the other
   * covers. The PAYLOAD wins when both are present — it is the daemon's
   * record rather than our recollection of one frame.
   */
  readonly failedWith: string | undefined;
  readonly now: string;
}

export const domIdFor = (draftId: string): string => `draft-${draftId}`;

/**
 * The chip, as a badge word.
 *
 * Every one of these is the daemon's own vocabulary uppercased, never a
 * synonym: `changed-elsewhere` carries the state somebody else moved it to,
 * a denial carries the gate's reason, and a failure carries the error we
 * were handed. An operator who searches the CLI's output for the word on
 * this badge finds the same event.
 */
function chipBadge(chip: Chip): string {
  switch (chip.kind) {
    case 'changed-elsewhere':
      return `MOVED ELSEWHERE: ${chip.state.toUpperCase()}`;
    case 'denied':
      return chip.retryAfter === undefined
        ? `DENIED: ${chip.reason.toUpperCase()}`
        : `DENIED: ${chip.reason.toUpperCase()} · RETRY AFTER ${chip.retryAfter}`;
    case 'error':
      return `ERROR: ${chip.reason.toUpperCase()}`;
  }
}

export function cardOf(draft: DraftPayload, context: CardContext): CardModel {
  const parts = chatParts(draft.chatGuid);
  const named = context.catalogue.contacts.get(parts.handle);
  const badges: string[] = [];
  if (draft.proactiveReason !== undefined) badges.push('PROACTIVE');
  if (parts.isGroup) badges.push('GROUP');
  // The clamp comes from the sidecar, never from the payload: `clampedBy`
  // rides the live `draft.created` frame and is not on the REST record, so
  // reading it off `draft` would produce a badge that vanishes on refetch.
  if (context.clampedBy !== undefined)
    badges.push(`CLAMPED: ${context.clampedBy.toUpperCase()}`);
  const failure = draft.error?.code ?? context.failedWith;
  if (failure !== undefined) badges.push(failure.toUpperCase());
  if (context.chip !== undefined) badges.push(chipBadge(context.chip));

  const who = parts.isGroup
    ? // A room has no counterparty to name, so the card names the ROOM. The
      // guid's own tail is what the daemon calls it and what a support
      // thread would quote; inventing "a group chat" would be less.
      (draft.chatGuid.split(';').at(-1) ?? draft.chatGuid)
    : (named ?? parts.handle);

  const ruleName =
    draft.ruleId === null ? null : context.catalogue.rules.get(draft.ruleId);

  return {
    draftId: draft.id,
    domId: domIdFor(draft.id),
    chatGuid: draft.chatGuid,
    state: context.state,
    glyph: STATE_GLYPH[context.state],
    word: STATE_WORD[context.state],
    who,
    // `MANUAL` rather than a blank: a draft with no rule was written by a
    // person, which is a fact about how it got here and not a missing field.
    rule:
      draft.ruleId === null
        ? 'MANUAL'
        : (ruleName?.toUpperCase() ?? 'RULE (UNKNOWN)'),
    adapter: draft.adapterId.toUpperCase(),
    timeLabel: ago(draft.createdAt, context.now),
    createdAt: draft.createdAt,
    body: draft.body,
    badges,
    why: draft.proactiveReason ?? null,
    // Only for a 1:1 with no policy row. A group has no single handle to set
    // a policy for, so the signpost would be pointing at a screen that
    // cannot help.
    hint:
      parts.isGroup || named !== undefined
        ? null
        : 'NO POLICY ROW · ADD ONE IN PEOPLE',
    isGroup: parts.isGroup,
    // Words, not glyphs. This is what a screen reader announces, and `○` is
    // pronounced differently by every voice that pronounces it at all.
    label: `${STATE_WORD[context.state]} · ${who} · ${draft.body}`,
  };
}

/**
 * Oldest first, and the tie broken by id.
 *
 * Oldest first because the queue is a QUEUE: the draft that has been waiting
 * longest is the one closest to expiring, and a newest-first list quietly
 * buries exactly the cards a busy operator most needs to reach. The id is
 * the tie-break because ULIDs are monotonic, so two drafts minted in the
 * same millisecond still have a stable order and the list cannot shuffle
 * under the cursor between paints.
 */
export function byAge(a: DraftPayload, b: DraftPayload): number {
  const at = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return at !== 0 ? at : a.id.localeCompare(b.id);
}

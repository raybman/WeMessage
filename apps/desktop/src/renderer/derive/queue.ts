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

/**
 * One badge, and the explanation a badge sometimes owes.
 *
 * A pair rather than a string because exactly one badge in this app has a
 * fact it cannot fit in its own word: `HELD` with no reason (F-108) is the
 * app saying "this draft was clamped and I cannot know by what", and an
 * operator reading a bare `HELD` deserves to be able to find out why it is
 * bare. `title` is the only carrier available inside an option — a popover
 * would be an interactive descendant, and there are none of those.
 */
export interface CardBadge {
  readonly text: string;
  /** The `title` attribute, present only where the word needs one. */
  readonly title?: string;
}

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
  readonly badges: readonly CardBadge[];
  /** Why an agent proposed this unprompted, or absent. */
  readonly why: string | null;
  /** A signpost when the app knows nothing about this handle. */
  readonly hint: string | null;
  readonly isGroup: boolean;
  readonly label: string;
  /** The undo window, while there is one to draw. */
  readonly ring: CardRing | null;
}

/**
 * A running undo window, in the two forms the screen needs.
 *
 * Milliseconds for the CSS animation (a duration and a negative delay, which
 * is how a ring that started before this paint resumes at the right place
 * with no timer), and whole seconds for the sentence a screen reader is
 * given. Both are computed ONCE, here, so the number in the label and the
 * sweep on the screen cannot disagree.
 */
export interface CardRing {
  readonly totalMs: number;
  readonly elapsedMs: number;
  readonly totalSeconds: number;
  readonly remainingSeconds: number;
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
    // The daemon's own code, uppercased and unrenamed. `GRACE-ELAPSED` is
    // what the route said, what the CLI prints and what a support thread
    // would quote; a friendlier synonym here would strand the operator
    // between two vocabularies for one refusal.
    case 'refused':
      return `REFUSED: ${chip.reason.toUpperCase()}`;
  }
}

/**
 * The undo window, as the two instants the daemon supplied.
 *
 * `stateChangedAt` is when the approval was recorded and `sendNotBefore` is
 * when the grace sweep may dispatch it, so the difference between them IS
 * the window — measured by the clock that will decide, not by the setting
 * that configured it. Reading `send.undoGraceSeconds` instead would draw a
 * ten-second ring over an approval made when the setting was five, and
 * would keep being wrong for every draft approved before the change.
 *
 * `null` for every state but `approved`, and for an approved draft whose
 * `sendNotBefore` we have not been told yet: the optimistic hypothesis has
 * no instants on it, so no ring is drawn until the answer lands. That is
 * the honest reading — a ring is a promise about a deadline, and we do not
 * have the deadline until the daemon gives it to us.
 */
export function ringOf(
  draft: DraftPayload,
  state: DraftState,
  now: string,
): CardRing | null {
  if (state !== 'approved') return null;
  const ends = Date.parse(draft.sendNotBefore ?? '');
  const began = Date.parse(draft.stateChangedAt);
  if (!Number.isFinite(ends) || !Number.isFinite(began)) return null;
  const total = ends - began;
  if (total <= 0) return null;
  const elapsed = Math.max(0, Math.min(total, Date.parse(now) - began));
  return {
    totalMs: total,
    elapsedMs: elapsed,
    totalSeconds: Math.round(total / 1000),
    remainingSeconds: Math.ceil((total - elapsed) / 1000),
  };
}

/**
 * F-108's ratified explanation for a `HELD` badge with no reason on it.
 *
 * Verbatim, because it is a product string rather than a description of
 * one: it tells the operator that the absence is a property of when this
 * window started listening, not a property of their draft.
 */
export const HELD_WITHOUT_REASON =
  'reason known only while the daemon that created this draft is running';

/**
 * Whether a card is held with no reason we could have learned.
 *
 * Proactive AND still pending. `proactiveReason` is the marker for a draft
 * an agent proposed unprompted, and the gate clamps every one of those to
 * draft-only before it becomes a row — so a proactive draft sitting in the
 * queue is by construction a held one. Once it moves out of `pending` the
 * hold is over and the badge would be describing history.
 */
function heldWithoutReason(draft: DraftPayload, state: DraftState): boolean {
  return draft.proactiveReason !== undefined && state === 'pending';
}

/**
 * How many lines of a body a card shows before it asks to be opened.
 *
 * Six, because the queue is a LIST: a forty-line answer rendered in full
 * pushes the next nineteen drafts off the screen, and the operator's job is
 * to see that there are nineteen. Six is enough to judge tone and topic,
 * which is what the collapsed card is for.
 */
export const BODY_LINES = 6;

/** A body, and what was left out of it. */
export interface ClampedBody {
  readonly text: string;
  readonly clamped: boolean;
  readonly lines: number;
}

/**
 * The body a collapsed card shows, and the count the affordance names.
 *
 * Arithmetic over the text rather than a CSS line clamp, for two reasons
 * that both matter here: a CSS clamp hides lines the DOM still contains, so
 * "what does this card show" stops being answerable from the DOM the e2e
 * reads; and the count in `SHOW ALL · 40 LINES` has to be a real number
 * rather than an ellipsis, or the operator cannot tell a body with one
 * hidden line from one with thirty.
 */
export function clampBody(body: string, expanded: boolean): ClampedBody {
  const lines = body.split('\n');
  if (expanded || lines.length <= BODY_LINES)
    return { text: body, clamped: false, lines: lines.length };
  return {
    text: lines.slice(0, BODY_LINES).join('\n'),
    clamped: true,
    lines: lines.length,
  };
}

export function cardOf(draft: DraftPayload, context: CardContext): CardModel {
  const parts = chatParts(draft.chatGuid);
  const named = context.catalogue.contacts.get(parts.handle);
  const badges: CardBadge[] = [];
  if (draft.proactiveReason !== undefined) badges.push({ text: 'PROACTIVE' });
  if (parts.isGroup) badges.push({ text: 'GROUP' });
  // HELD, in the two shapes F-108 ratified and no third one.
  //
  // The clamp comes from the sidecar, never from the payload: `clampedBy`
  // rides the live `draft.created` frame and is not on the REST record, so
  // reading it off `draft` would produce a badge that vanishes on refetch.
  // The reason is the gate's own word uppercased, never a friendlier
  // synonym — the operator will read the same word in the CLI's output and
  // in a support thread, and a second vocabulary here would strand them.
  if (context.clampedBy !== undefined)
    badges.push({ text: `HELD · ${context.clampedBy.toUpperCase()}` });
  else if (heldWithoutReason(draft, context.state))
    // The honest half. A proactive draft that is still pending WAS clamped
    // to draft-only by the gate — that is what proactive-and-pending means —
    // and a window that fetched the row rather than watching it arrive
    // cannot know which dimension did it. So the badge says the fact it has
    // and the title says why it has no more, rather than rendering
    // `HELD · NONE`, which would be a reason.
    badges.push({ text: 'HELD', title: HELD_WITHOUT_REASON });
  // The one terminal state with a KNOB behind it.
  //
  // `EXPIRED` says the draft is over; `TTL` says what ended it, which is the
  // rule's own `draftTtlMinutes` and therefore the one thing on this card
  // the operator can change. It is not a second spelling of the word: the
  // other ways a draft dies (a person rejected it, a newer one replaced it,
  // the dispatcher refused it) each have a different badge or none, and an
  // operator who keeps finding expired cards is being told where to look.
  if (context.state === 'expired') badges.push({ text: 'TTL' });
  const failure = draft.error?.code ?? context.failedWith;
  if (failure !== undefined) badges.push({ text: failure.toUpperCase() });
  if (context.chip !== undefined)
    badges.push({ text: chipBadge(context.chip) });

  const who = parts.isGroup
    ? // A room has no counterparty to name, so the card names the ROOM. The
      // guid's own tail is what the daemon calls it and what a support
      // thread would quote; inventing "a group chat" would be less.
      (draft.chatGuid.split(';').at(-1) ?? draft.chatGuid)
    : (named ?? parts.handle);

  const ruleName =
    draft.ruleId === null ? null : context.catalogue.rules.get(draft.ruleId);

  const ring = ringOf(draft, context.state, context.now);

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
    //
    // The undo clause is APPENDED rather than announced separately, and it
    // is announced once. There is no timer to count down with (and there
    // must not be), so a region that spoke the remaining seconds would
    // either be stuck on the first number it said or would need a tick this
    // app refuses to own. Saying it once, in the option's own label, is
    // what a listbox is for: the operator hears the deadline at the moment
    // the cursor is on the card that has one.
    label:
      ring === null
        ? `${STATE_WORD[context.state]} · ${who} · ${draft.body}`
        : `${STATE_WORD[context.state]} · ${who} · ${draft.body}` +
          ` · UNDO SEND, ${String(ring.remainingSeconds)} SECONDS REMAINING`,
    ring,
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

/**
 * v2 A2: one conversation's words, as pure functions of the pages held.
 *
 * Return on a conversation reads `GET /v1/threads/:guid/messages`, newest
 * page first, and this file turns what came back into what the transcript
 * pane draws: turns grouped under a heading per local calendar day, ours on
 * the right, every placeholder spelled out.
 *
 *  - **Days are relative to the PAGE.** The daemon stamps every page with
 *    `asOf`, and "Today" means the local date that page was read on, exactly
 *    as the list's "Yest" means the day before the list was read. No instant
 *    in this file comes from a clock; each is an argument, so a heading can
 *    never disagree with the list chip about what "now" was.
 *  - **Days are calendar days in a named zone**, projected by the same
 *    `nowInZone` the list and the schedule screen use, so a 23-hour
 *    spring-forward day is one heading and a turn at exactly local midnight
 *    belongs to the day that starts there.
 *  - **Nothing is invented.** A turn the sender unsent says it was unsent,
 *    an attachment-only turn says it is an attachment, and a turn whose
 *    instant does not parse is kept (it is still a message) under the day
 *    before it, or under "Undated" when it is first.
 *  - **The renderer never orders turns.** The daemon pages by
 *    `(date, rowid)` and hands each page oldest first; the only thing this
 *    file does to the order is put older pages before newer ones.
 *
 * English names are spelled out here rather than asked of `Intl`, for the
 * list's reason: the strings are part of the board and of the e2e.
 */
import type { ThreadTurn, Weekday } from '@wemessage/client';
import { localMidnightIso, nowInZone } from './projectWindow.js';

const LONG_DAY: Readonly<Record<Weekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const LONG_MONTH = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MS_PER_DAY = 86_400_000;

/** A local `YYYY-MM-DD` as a whole number of days (see derive/threads.ts). */
function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / MS_PER_DAY);
}

/** `H:MM`, 24-hour, the list's clock. */
function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, '0')}`;
}

/** "September 4", or "September 4, 2025" when it is not `year`. */
function longDate(date: string, year: string): string {
  const [y = '', m = '', d = ''] = date.split('-');
  const month = LONG_MONTH[Number(m) - 1];
  if (month === undefined) return date;
  const day = `${month} ${String(Number(d))}`;
  return y === year ? day : `${day}, ${y}`;
}

/**
 * The heading over one local date, relative to the page's own local date.
 *
 * The same date is "Today", the date before is "Yesterday", two to six back
 * is the weekday, and anything else (older, or AFTER the page, which a
 * sender's fast clock can produce) is the date, with the year only when it
 * is not the page's year.
 */
export function dayHeading(date: string, day: Weekday, ref: string): string {
  const back = dayNumber(ref) - dayNumber(date);
  if (back === 0) return 'Today';
  if (back === 1) return 'Yesterday';
  if (back >= 2 && back <= 6) return LONG_DAY[day];
  return longDate(date, ref.slice(0, 4));
}

/** One turn, every field already a string to draw. */
export interface TurnRow {
  /** The message guid: unique within the transcript, stable across pages. */
  readonly key: string;
  readonly from: 'me' | 'them';
  /** What the bubble says: the text, or the words for what stands in for it. */
  readonly body: string;
  /** Whether `body` is a placeholder rather than the sender's own words. */
  readonly placeholder: boolean;
  /** Who wrote it, in words: "You", the group member, or the conversation. */
  readonly who: string;
  /** Whether `who` is drawn (a group's other members) or only spoken. */
  readonly showWho: boolean;
  /** `H:MM` in the zone, or `''` when the instant does not parse. */
  readonly time: string;
  /** Small print after the body: "Edited", "2 attachments". */
  readonly marks: readonly string[];
}

export interface DayGroup {
  /** The local `YYYY-MM-DD`, or `''` for turns before any readable date. */
  readonly date: string;
  readonly heading: string;
  readonly turns: readonly TurnRow[];
}

function attachmentsWord(n: number): string {
  return n === 1 ? '1 attachment' : `${String(n)} attachments`;
}

function turnRow(
  turn: ThreadTurn,
  time: string,
  title: string,
  isGroup: boolean,
): TurnRow {
  const marks: string[] = [];
  let body: string;
  let placeholder = false;
  if (turn.unsentAt !== undefined) {
    body = 'This message was unsent.';
    placeholder = true;
  } else if (turn.kind === 'audio') {
    body = 'Audio message';
    placeholder = true;
  } else if (turn.kind === 'attachment-only' || turn.text === null) {
    body =
      turn.attachments > 0 ? attachmentsWord(turn.attachments) : 'Attachment';
    placeholder = true;
  } else {
    body = turn.text;
    if (turn.attachments > 0)
      marks.push(`+ ${attachmentsWord(turn.attachments)}`);
  }
  if (turn.editedAt !== undefined && turn.unsentAt === undefined)
    marks.push('Edited');
  const mine = turn.from === 'me';
  const who = mine ? 'You' : (turn.handle ?? title);
  return {
    key: turn.guid,
    from: turn.from,
    body,
    placeholder,
    who,
    showWho: !mine && isGroup,
    time,
    marks,
  };
}

/**
 * Turns, oldest first, grouped under one heading per local date.
 *
 * `asOf` is the instant the NEWEST page held was read at, and `title` and
 * `isGroup` come off the conversation's own row, so a 1:1 turn is spoken as
 * the conversation it belongs to and a group's turns name their sender.
 */
export function dayGroups(
  turns: readonly ThreadTurn[],
  asOf: string,
  zone: string,
  title: string,
  isGroup: boolean,
): DayGroup[] {
  const ref = nowInZone(asOf, zone);
  const groups: { date: string; heading: string; turns: TurnRow[] }[] = [];
  for (const turn of turns) {
    const at = nowInZone(turn.at, zone);
    const time = at === null ? '' : hm(at.minutes);
    const row = turnRow(turn, time, title, isGroup);
    const last = groups[groups.length - 1];
    if (at === null) {
      if (last !== undefined) last.turns.push(row);
      else groups.push({ date: '', heading: 'Undated', turns: [row] });
      continue;
    }
    if (last !== undefined && last.date === at.date) {
      last.turns.push(row);
      continue;
    }
    const heading =
      ref === null
        ? longDate(at.date, '')
        : dayHeading(at.date, at.day, ref.date);
    groups.push({ date: at.date, heading, turns: [row] });
  }
  return groups;
}

/**
 * A fresh head page laid over what is held.
 *
 * The daemon is re-read, never appended to from an event, and the head it
 * answers can relate to what is held in two ways:
 *
 *  - It SHARES a turn with what is held. Everything held stays where it is
 *    (with the head's copy of any turn it re-read, so an edit or an unsend
 *    shows), and the head's turns that are new go after it, in the head's
 *    order.
 *  - It shares NOTHING. More arrived since the last read than one page
 *    holds, so the turns between the held newest and the head's oldest are
 *    in neither. Gluing the two together would draw a transcript with a
 *    silent hole in it; the head replaces what is held instead, and
 *    `continuous` says so, so the caller can drop the older cursor and say
 *    it out loud.
 */
export function mergeHead(
  held: readonly ThreadTurn[],
  head: readonly ThreadTurn[],
): { readonly turns: readonly ThreadTurn[]; readonly continuous: boolean } {
  const fresh = new Map(head.map((turn) => [turn.guid, turn]));
  const overlaps = held.some((turn) => fresh.has(turn.guid));
  if (!overlaps && held.length > 0 && head.length > 0)
    return { turns: head, continuous: false };
  const seen = new Set<string>();
  const out: ThreadTurn[] = [];
  for (const turn of held) {
    seen.add(turn.guid);
    out.push(fresh.get(turn.guid) ?? turn);
  }
  for (const turn of head) if (!seen.has(turn.guid)) out.push(turn);
  return { turns: out, continuous: true };
}

/**
 * `older` before `held`, the first copy of a turn winning.
 *
 * Pages walk back by an opaque `(date, rowid)` cursor and do not overlap,
 * but a page read after a head refresh can re-cover a turn the head already
 * brought in, and a guid drawn twice is a key Preact cannot tell apart.
 */
export function prependOlder(
  held: readonly ThreadTurn[],
  older: readonly ThreadTurn[],
): ThreadTurn[] {
  const seen = new Set(held.map((turn) => turn.guid));
  return [...older.filter((turn) => !seen.has(turn.guid)), ...held];
}

/* ── the date jump ────────────────────────────────────────────────────── */

/** The most digits the jump prompt accepts: `YYYYMMDD`. */
export const JUMP_DIGITS = 8;

/** What the prompt shows for the digits typed so far: `2026-03-1_`. */
export function jumpMask(digits: string): string {
  const padded = digits.padEnd(JUMP_DIGITS, '_').slice(0, JUMP_DIGITS);
  return `${padded.slice(0, 4)}-${padded.slice(4, 6)}-${padded.slice(6, 8)}`;
}

export type JumpTarget =
  | {
      readonly ok: true;
      /** The local date the jump lands on. */
      readonly date: string;
      /** The LAST instant of that local date, as the `until` to send. */
      readonly until: string;
      /** The date in words: "March 14, 2026". */
      readonly spoken: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * The `until` for a typed date: the last millisecond of that local date in
 * `zone`, as a UTC instant the daemon accepts.
 *
 * Measured, not assumed: it is one millisecond before the NEXT local
 * midnight, found by the same fixed point the schedule screen uses, so a
 * 23-hour or 25-hour day ends where it really ends.
 */
export function jumpUntil(digits: string, zone: string): JumpTarget {
  if (!/^\d{8}$/.test(digits))
    return { ok: false, reason: 'Type eight digits, year month day.' };
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  // A date that parses but rolls over (Feb 30 becomes Mar 2) is not the
  // date that was typed.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date)
    return { ok: false, reason: `${jumpMask(digits)} is not a date.` };
  const next = new Date(ms + MS_PER_DAY).toISOString().slice(0, 10);
  const midnight = localMidnightIso(next, zone);
  if (midnight === null)
    return { ok: false, reason: `${jumpMask(digits)} is not a date.` };
  const until = new Date(Date.parse(midnight) - 1).toISOString();
  return { ok: true, date, until, spoken: longDate(date, '') };
}

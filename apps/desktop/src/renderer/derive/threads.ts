/**
 * v2 A1: the conversations list's words, as pure functions of one page.
 *
 * Board 01.B draws every row the same way: a monogram, the channel's mark, a
 * title, a time, and the last line, prefixed "You: " when it was ours. The
 * chip above the list counts the conversations and dates the count. Every
 * string here is computed from what `GET /v1/threads` answered and from
 * nothing else:
 *
 *  - **Times are relative to the LIST.** The daemon stamps each page with
 *    `asOf`, and a row's "Yest" means the calendar day before the day the
 *    list was read. No instant in this file comes from a clock; each is an
 *    argument, under the same ban every derive file lives under, so a row
 *    can never disagree with the chip about what "now" was.
 *  - **Days are calendar days in a named zone**, projected by the same
 *    `nowInZone` the schedule screen uses. "Yest" is the previous local
 *    date, not "24 to 48 hours ago", so a 23-hour spring-forward day is
 *    still exactly one day.
 *  - **The short form is for eyes, the label for ears.** `Yest` and `Fri`
 *    are glyphs to a screen reader. The option's label says "yesterday" and
 *    "Friday", from the same projection, so the two cannot disagree.
 *  - **Nothing is invented.** An instant that does not parse draws no time,
 *    a missing line draws no preview (and no orphaned "You:"), and a channel
 *    this renderer has never heard of is drawn under `?` with its own name.
 *
 * English names are spelled out below rather than asked of `Intl`, because
 * the strings are part of the board and of the e2e, and a host locale must
 * not be able to change them.
 */
import type { ThreadChannel, ThreadSummary, Weekday } from '@wemessage/client';
import { nowInZone } from './projectWindow.js';

/**
 * The channels this renderer draws a mark for. v2 B0 widened the client's
 * `ThreadChannel` to the four the Swift rail names; this renderer still
 * draws iMessage only, and any other channel takes the unknown mark.
 */
type DrawnChannel = Extract<ThreadChannel, 'imessage'>;

/** The mark board 01 draws for each channel the wire can name. */
export const CHANNEL_MARK: Readonly<Record<DrawnChannel, string>> = {
  imessage: 'iM',
};

/** The mark for a channel this renderer has never heard of. */
export const UNKNOWN_MARK = '?';

/** Each channel's name, as the option's label speaks it. */
const CHANNEL_NAME: Readonly<Record<DrawnChannel, string>> = {
  imessage: 'iMessage',
};

const SHORT_DAY: Readonly<Record<Weekday, string>> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

const LONG_DAY: Readonly<Record<Weekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const SHORT_MONTH = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

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

/** `H:MM`, 24-hour, no leading zero on the hour (board 01's "9:41"). */
function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60))}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * A local `YYYY-MM-DD` as a whole number of days. Read as UTC on purpose:
 * the date is already local, so this counts calendar days and never hours.
 */
function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00.000Z`) / MS_PER_DAY);
}

function isKnown(channel: string): channel is DrawnChannel {
  return Object.prototype.hasOwnProperty.call(CHANNEL_MARK, channel);
}

/** The time of day an instant falls at in `zone`, or `''` if unreadable. */
export function clockLabel(iso: string, zone: string): string {
  const at = nowInZone(iso, zone);
  return at === null ? '' : hm(at.minutes);
}

/** A row's time, drawn short and spoken long. */
export interface TimeLabel {
  readonly short: string;
  readonly spoken: string;
}

const BLANK: TimeLabel = { short: '', spoken: '' };

/**
 * When `at` happened, relative to the list's own instant `ref`, in `zone`.
 *
 * The same local date is a time; the date before is `Yest`; two to six
 * dates back is the weekday; anything else (a week or more back, or a date
 * AFTER the list, which a sender's fast clock can produce) is the date, with
 * the year only when it is not the list's year.
 */
export function timeLabel(at: string, ref: string, zone: string): TimeLabel {
  const when = nowInZone(at, zone);
  const now = nowInZone(ref, zone);
  if (when === null || now === null) return BLANK;
  const back = dayNumber(now.date) - dayNumber(when.date);
  if (back === 0) {
    const clock = hm(when.minutes);
    return { short: clock, spoken: clock };
  }
  if (back === 1) return { short: 'Yest', spoken: 'yesterday' };
  if (back >= 2 && back <= 6)
    return { short: SHORT_DAY[when.day], spoken: LONG_DAY[when.day] };
  const [year = '', month = '', day = ''] = when.date.split('-');
  const m = Number(month) - 1;
  const d = String(Number(day));
  const shortMonth = SHORT_MONTH[m];
  const longMonth = LONG_MONTH[m];
  if (shortMonth === undefined || longMonth === undefined) return BLANK;
  if (year === now.date.slice(0, 4))
    return { short: `${shortMonth} ${d}`, spoken: `${longMonth} ${d}` };
  return { short: when.date, spoken: `${longMonth} ${d}, ${year}` };
}

const COUNT = new Intl.NumberFormat('en-US');

/**
 * The chip above the list: what it shows, how many, and as of when. The
 * count is the daemon's `total` and the instant is the page's `asOf`, so
 * the number is dated by the same read that produced it. An instant that
 * will not parse still says the number is dated, as `--:--`.
 */
export function scopeChip(total: number, asOf: string, zone: string): string {
  const noun = total === 1 ? 'conversation' : 'conversations';
  const clock = clockLabel(asOf, zone);
  return `All · ${COUNT.format(total)} ${noun} · as of ${clock === '' ? '--:--' : clock}`;
}

/** The last line, one line tall, prefixed "You: " when it was ours. */
export function previewLine(line: string | null, fromMe: boolean): string {
  if (line === null) return '';
  const flat = line.replace(/\s+/g, ' ').trim();
  if (flat === '') return '';
  return fromMe ? `You: ${flat}` : flat;
}

const WORD_SPLIT = /[\s,]+/u;
/** A letter and whatever marks combine with it ("é" either way it is spelled). */
const INITIAL = /^\p{L}\p{M}*/u;

/**
 * Up to two initials: the first and last words that START with a letter.
 * A title that is only numbers (a phone handle, a list of them) is `#`.
 */
export function monogram(title: string): string {
  const initials: string[] = [];
  for (const word of title.split(WORD_SPLIT)) {
    const initial = INITIAL.exec(word)?.[0];
    if (initial !== undefined) initials.push(initial.toUpperCase());
  }
  const first = initials[0];
  if (first === undefined) return '#';
  const last = initials[initials.length - 1];
  return initials.length === 1 || last === undefined ? first : first + last;
}

/** One option of the list, every field already a string to draw. */
export interface ThreadRow {
  /** The chat guid: stable across pages, unique within the list. */
  readonly key: string;
  readonly title: string;
  readonly mark: string;
  readonly monogram: string;
  readonly time: string;
  readonly preview: string;
  readonly isGroup: boolean;
  /** The whole row in words, for the option's accessible name. */
  readonly label: string;
}

/**
 * One row per conversation, in the order the daemon sent them. The renderer
 * never sorts this list: the daemon ordered it, and a second opinion about
 * which conversation is newest is how two windows come to disagree.
 */
export function threadRows(
  threads: readonly ThreadSummary[],
  asOf: string,
  zone: string,
): ThreadRow[] {
  return threads.map((thread) => {
    const channel: string = thread.channel;
    const known = isKnown(channel);
    const mark = known ? CHANNEL_MARK[channel] : UNKNOWN_MARK;
    const name = known ? CHANNEL_NAME[channel] : channel;
    const time = timeLabel(thread.lastAt, asOf, zone);
    const preview = previewLine(thread.lastLine, thread.lastFromMe);
    const label = [
      thread.title,
      thread.isGroup ? `${name} group` : name,
      time.spoken,
      preview,
    ]
      .filter((part) => part !== '')
      .join(' · ');
    return {
      key: thread.chatGuid,
      title: thread.title,
      mark,
      monogram: monogram(thread.title),
      time: time.short,
      preview,
      isGroup: thread.isGroup,
      label,
    };
  });
}

/**
 * The mounted slice of a held list: at most `size` rows, centred on the
 * cursor and clamped inside the list, so the active option is always in the
 * document and `aria-activedescendant` never names a node that is not.
 */
export function windowAround(
  held: number,
  active: number,
  size: number,
): { readonly start: number; readonly end: number } {
  if (held <= size) return { start: 0, end: held };
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(held - size, active - half));
  return { start, end: start + size };
}

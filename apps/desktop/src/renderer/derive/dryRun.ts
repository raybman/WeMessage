/**
 * The dry run, as the screen shows it: the daemon's verdict, plus WHERE.
 *
 * `GET /v1/rules/:id/dry-run` replays the last N inbound messages against
 * ONE rule and answers `matched` per row. It does not say which span of the
 * text did it, and it cannot: the route returns a preview, not an offset.
 * So the highlight is a client-side MIRROR of the matcher — and a mirror is
 * allowed to be wrong in exactly one direction.
 *
 * **The daemon is the authority on `matched`.** A row it called unmatched is
 * rendered unmatched with nothing marked, even when the mirror thinks it
 * found the keyword. An editor that marked a span the evaluator did not
 * match would be teaching the operator to trust the wrong thing. The mirror
 * only ever subtracts: `hitVisible` is false when the daemon said MATCH and
 * the mirror cannot show where (a `contact` matcher matched the HANDLE, a
 * pattern the local compiler will not take), and the row says so rather than
 * showing a MATCH with nothing lit.
 *
 * **Shadowing is a join, not a field.** `DryRunRow` carries no rule ids and
 * `POST /v1/rules/:id/test` scores one rule, so nothing on the wire can name
 * a rule other than the one asked about. The honest derivation is one replay
 * per higher-priority rule, joined on `guid`, resolved in the evaluator's own
 * order — priority ascending, id ascending, first match wins (§1.7).
 *
 * The folding below mirrors `packages/core/src/rules/matchers.ts`
 * deliberately rather than importing it: the renderer has no dependency on
 * `@wemessage/core` (F-101 keeps Node-only code in main) and acquiring one
 * to highlight text would put the evaluator in the browser bundle.
 */
import type { DryRunRow } from '@wemessage/client';
import type { RuleFormValue } from './ruleForm.js';

/** One run of characters, lit or not. Concatenated, they are the preview. */
export interface PreviewSpan {
  readonly text: string;
  readonly hit: boolean;
}

export interface DryRunViewRow {
  readonly guid: string;
  readonly handle: string;
  readonly matched: boolean;
  readonly preview: readonly PreviewSpan[];
  /** True when the mirror could show WHERE. False is not a contradiction. */
  readonly hitVisible: boolean;
  readonly shadowedBy: string | null;
  readonly wins: boolean;
}

/** One higher-priority rule's own replay of the same window. */
export interface ShadowReplay {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly rows: readonly DryRunRow[];
}

interface Range {
  readonly from: number;
  readonly to: number;
}

/**
 * Lowercase without moving any index.
 *
 * `String.prototype.toLowerCase` is allowed to change length (`'İ'` folds to
 * two code points), and a fold that changes length silently slides every
 * offset after it. Characters that would resize are left alone: the mirror
 * misses a highlight rather than lighting the wrong letters.
 */
function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/** `matchers.ts`'s boundary: `\p{L}\p{N}\p{M}`, not JS `\b` (ASCII-only). */
const WORDLIKE = /[\p{L}\p{N}\p{M}]/u;

function wordLike(ch: string | undefined): boolean {
  return ch !== undefined && WORDLIKE.test(ch);
}

function keywordRanges(text: string, value: RuleFormValue): Range[] {
  const haystack = value.caseSensitive ? text : fold(text);
  const out: Range[] = [];
  for (const keyword of value.keywords) {
    const needle = value.caseSensitive ? keyword : fold(keyword);
    if (needle.length === 0) continue;
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      const to = from + needle.length;
      const before = from === 0 ? undefined : haystack[from - 1];
      const after = haystack[to];
      if (!value.wholeWord || (!wordLike(before) && !wordLike(after)))
        out.push({ from, to });
      from = haystack.indexOf(needle, from + 1);
    }
  }
  return out;
}

function regexRanges(text: string, pattern: string): Range[] {
  let compiled: RegExp;
  try {
    // A FRESH RegExp per call. A shared `/…/g` carries `lastIndex` between
    // rows and silently skips every other one.
    compiled = new RegExp(pattern, 'gu');
  } catch {
    return [];
  }
  const out: Range[] = [];
  for (const match of text.matchAll(compiled)) {
    const from = match.index;
    if (from === undefined || match[0].length === 0) continue;
    out.push({ from, to: from + match[0].length });
  }
  return out;
}

/** Overlapping ranges merged, in order, so no character is emitted twice. */
function merge(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && range.from <= last.to) {
      if (range.to > last.to)
        out[out.length - 1] = { from: last.from, to: range.to };
      continue;
    }
    out.push(range);
  }
  return out;
}

function spansOf(text: string, ranges: readonly Range[]): PreviewSpan[] {
  if (ranges.length === 0)
    return text.length === 0 ? [] : [{ text, hit: false }];
  const out: PreviewSpan[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.from > at)
      out.push({ text: text.slice(at, range.from), hit: false });
    out.push({ text: text.slice(range.from, range.to), hit: true });
    at = range.to;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/**
 * Which rule would have taken each message first.
 *
 * §1.7's order, applied to the replays rather than re-derived: priority
 * ascending, then id ascending as the tiebreak, and the FIRST replay that
 * matched a guid owns it.
 */
export function shadowMap(
  replays: readonly ShadowReplay[],
): ReadonlyMap<string, string> {
  const ordered = [...replays].sort(
    (a, b) =>
      a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out = new Map<string, string>();
  for (const replay of ordered)
    for (const row of replay.rows)
      if (row.matched && !out.has(row.guid))
        out.set(row.guid, replay.name.toUpperCase());
  return out;
}

/** The dry-run rows, with highlights and shadow verdicts attached. */
export function dryRunView(
  rows: readonly DryRunRow[],
  value: RuleFormValue,
  shadows: ReadonlyMap<string, string>,
): readonly DryRunViewRow[] {
  return rows.map((row) => {
    const text = row.textPreview ?? '';
    // Only a row the DAEMON matched is eligible for a highlight, and only
    // the two matcher kinds that match on the body can produce one.
    const ranges =
      !row.matched || value.unsupported !== null
        ? []
        : value.kind === 'keyword'
          ? merge(keywordRanges(text, value))
          : value.kind === 'regex'
            ? merge(regexRanges(text, value.pattern))
            : [];
    const preview = spansOf(text, ranges);
    const shadowedBy = row.matched ? (shadows.get(row.guid) ?? null) : null;
    return {
      guid: row.guid,
      handle: row.handle,
      matched: row.matched,
      preview,
      hitVisible: ranges.length > 0,
      shadowedBy,
      wins: row.matched && shadowedBy === null,
    };
  });
}

/**
 * Whether this matcher could plausibly have taken any of these rows.
 *
 * The screen asks one replay per rule ABOVE the selected one, and a replay
 * is a request. Asking for every higher rule on every dry run would be N
 * round trips to discover that none of them matched anything, so the mirror
 * is used as a FILTER first: a rule that cannot match a single row the
 * daemon already said this rule matched cannot be shadowing any of them.
 *
 * It fails OPEN. A matcher this file cannot mirror — one written by the CLI
 * that the form has no controls for — returns `true` and is replayed, so the
 * optimisation can cost a request but can never hide a shadow.
 */
export function mirrorHits(
  rows: readonly DryRunRow[],
  value: RuleFormValue,
): boolean {
  if (value.unsupported !== null) return true;
  switch (value.kind) {
    case 'keyword':
      return rows.some(
        (row) => keywordRanges(row.textPreview ?? '', value).length > 0,
      );
    case 'regex':
      return rows.some(
        (row) => regexRanges(row.textPreview ?? '', value.pattern).length > 0,
      );
    case 'contact':
      return rows.some((row) => value.handles.includes(row.handle));
    case 'theme':
      // No endpoint in v1, so a stored theme rule matches nothing and
      // shadows nothing. Not a guess: the daemon refuses the matcher.
      return false;
  }
}

/**
 * The audit log, projected for a reader. Pure, and READ-ONLY by shape.
 *
 * §1.8 says "the log is the record, the event is the courtesy". This file is
 * the display half of that sentence, and everything in it is arranged around
 * one constraint: the record was HASHED, so anything this screen shows an
 * auditor has to be traceable back to the exact bytes the chain covered.
 *
 * Four decisions, each of which has a way to be wrong:
 *
 *  - **Verbatim or nothing.** `eventJson` and `actorJson` are carried through
 *    as the stored strings, never re-serialised. `JSON.parse` + `JSON.stringify`
 *    normalises key order, whitespace and unicode escapes, and a drawer titled
 *    "what you see is what was hashed" that showed a normalised string would be
 *    showing something nobody can hash-check. The parse below is used ONLY to
 *    decide what words to put in the table; the raw string always survives.
 *
 *  - **The table summarises by IDENTIFIER.** A `draft.created` row carries a
 *    whole `Draft`, message body included. An audit list is scanned in front of
 *    other people, so {@link IDENTIFIER_KEYS} is a closed, ordered set of
 *    top-level keys and only STRING values are taken from it. `body` is not in
 *    the set and never can be by accident: a nested object is structurally
 *    unreachable. The drawer discloses everything, because that is the thing
 *    the operator explicitly asked for.
 *
 *  - **An unreadable row is a row.** Tamper is the point of this screen. A row
 *    whose event column is `'DOCTORED'`, or is JSON of the wrong shape, still
 *    renders with its seq, its instant and its two hashes, under the honest
 *    word {@link UNREADABLE}. The screen that exists to show you the damage may
 *    not be the screen that breaks when there is some.
 *
 *  - **The deny vocabulary is closed, and UNKNOWN is a member of it.** INV-1
 *    keeps `@wemessage/core` out of the renderer, so {@link DENY_REASONS} is a
 *    deliberate second projection of `GateDenyReason` and an arch row ties the
 *    two lists together. A thirteenth reason from a newer daemon renders its
 *    LITERAL under {@link UNKNOWN_GLYPH} rather than being dropped: an operator
 *    who greps the daemon's source for the word on their screen must find it.
 *    Forward compatibility, never invention.
 *
 * No clock is read here. `nowIso` is an argument, by the same ban Sc11 and
 * Sc12 live under, and an arch row proves it for the whole of `derive/`.
 */
import type { AuditRowPayload } from '@wemessage/client';

/**
 * The twelve `GateDenyReason` members, sorted, as the renderer must spell them.
 *
 * A second projection on purpose (INV-1). The S6 dormant-literal guard names
 * this file as a deliberate home for these strings, and an arch row scrapes the
 * union out of `packages/core/src/domain/types.ts` and asserts set equality, so
 * a thirteenth reason added to the daemon breaks this file rather than silently
 * rendering as unknown forever.
 */
export const DENY_REASONS = [
  'adapter-disabled',
  'circuit-open',
  'contact-denied',
  'disconnected',
  'group-auto-forbidden',
  'kill-switch',
  'loop-detected',
  'outside-window',
  'rate-limited',
  'read-only',
  'sms-auto-forbidden',
  'unapproved',
] as const;

/** A refusal, in §3.10's shape: ⊘ is what the strip already means by refused. */
export const DENY_GLYPH = '⊘';

/**
 * A refusal this build has never heard of.
 *
 * Deliberately NOT one of §3.10's six state glyphs. Those six say what
 * happened; this one says that this build cannot say. Reusing ◌ (absent) would
 * claim the reason was missing when it is present and simply newer.
 */
export const UNKNOWN_GLYPH = '?';

/** There was no value to show, and that is a fact rather than a blank cell. */
export const ABSENT = '—';

/** The stored bytes could not be read as what they claim to be. */
export const UNREADABLE = 'UNREADABLE';

/**
 * The top-level keys the table may name, in the order it prefers them.
 *
 * Closed and ordered so a summary is reproducible, and consulted for STRING
 * values only. Every member is something an operator can look up somewhere
 * else in this product; nothing here is content.
 */
const IDENTIFIER_KEYS = [
  'draftId',
  'approvalId',
  'ruleId',
  'scheduleId',
  'adapterId',
  'handle',
  'guid',
  'key',
  'ruleName',
] as const;

/** The three actor kinds the daemon writes, and the field each one carries. */
const ACTOR_FIELDS: Readonly<Record<string, string>> = {
  human: 'via',
  agent: 'adapterId',
  system: 'reason',
};

/**
 * The chip vocabulary, from the SAME map the rows are projected through.
 *
 * Uppercased once, here, rather than spelled again in the composition root:
 * a fourth actor kind added to `ACTOR_FIELDS` gets a chip for free, and a
 * chip that filtered on a word no row can ever carry cannot be written.
 */
export const ACTORS: readonly string[] = Object.keys(ACTOR_FIELDS).map((kind) =>
  kind.toUpperCase(),
);

/**
 * The two emptinesses, which are statements about two different things.
 *
 * "The daemon returned nothing" is a fact about the LOG under the query the
 * daemon was actually given. "Nothing here matches" is a fact about a
 * narrowing this process did afterwards and can undo. An operator who reads
 * the second and believes the first has been told the log is empty when it
 * is not, which on this screen is the whole failure.
 */
export const LOG_EMPTY = 'THE DAEMON RETURNED NO ROWS FOR THIS QUERY.';
export const FILTER_EMPTY =
  'NO LOADED ROW MATCHES WHAT YOU TYPED HERE. THIS FILTER IS LOCAL: WIDEN IT, OR ASK THE DAEMON FOR A DIFFERENT QUERY.';

export interface AuditDeny {
  /** The daemon's literal, never a paraphrase. */
  readonly reason: string;
  /** The same literal, uppercased: the carrier assistive tech actually gets. */
  readonly word: string;
  readonly glyph: string;
  readonly state: 'KNOWN' | 'UNKNOWN';
}

export interface AuditRowView {
  readonly seq: number;
  /** The stored instant string, whether or not it parsed. */
  readonly at: string;
  /** How long ago, or {@link ABSENT} when `at` could not be read. */
  readonly age: string;
  /** The event's `type`, or {@link UNREADABLE}. */
  readonly kind: string;
  readonly kindKnown: boolean;
  /** One identifier, or {@link ABSENT}. Never message content. */
  readonly summary: string;
  readonly actor: string;
  readonly actorLabel: string;
  readonly deny: AuditDeny | null;
  /** Byte-for-byte what the chain hashed. */
  readonly eventJson: string;
  readonly actorJson: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditRowsInput {
  readonly nowIso: string;
  readonly rows: readonly AuditRowPayload[];
}

/* ── reading the stored bytes ─────────────────────────────────────────── */

/** A JSON object, or `null` for everything else including arrays and scalars. */
function objectOf(json: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return null;
  return parsed as Record<string, unknown>;
}

/**
 * How long ago, in the coarsest honest unit, down to seconds.
 *
 * `derive/format.ts#ago` floors everything under a minute to `JUST NOW`, which
 * is right for a queue card and wrong here: an auditor reading the seconds
 * between an approval and its send is reading the thing this screen is for.
 * A future instant reads `0S AGO` rather than a negative age, for the same
 * reason `ago` clamps: two clocks a second apart is not a story about this row.
 */
function ageOf(at: string, nowIso: string): string {
  const then = Date.parse(at);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return ABSENT;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${String(seconds)}S AGO`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}H AGO`;
  return `${String(Math.floor(hours / 24))}D AGO`;
}

/** The first identifier the event carries, or {@link ABSENT}. */
function summaryOf(event: Record<string, unknown>): string {
  for (const key of IDENTIFIER_KEYS) {
    const value = event[key];
    // STRING only. A nested object is skipped rather than stringified, which
    // is what keeps `draft.body` structurally unreachable from this line.
    if (typeof value === 'string' && value !== '')
      return `${key.toUpperCase()} · ${value}`;
  }
  return ABSENT;
}

function denyOf(event: Record<string, unknown>): AuditDeny | null {
  if (event['type'] !== 'gate.denied') return null;
  const reason = event['reason'];
  if (typeof reason !== 'string' || reason === '') return null;
  const known = (DENY_REASONS as readonly string[]).includes(reason);
  return {
    reason,
    word: reason.toUpperCase(),
    glyph: known ? DENY_GLYPH : UNKNOWN_GLYPH,
    state: known ? 'KNOWN' : 'UNKNOWN',
  };
}

function actorOf(actorJson: string): { actor: string; label: string } {
  const actor = objectOf(actorJson);
  const kind = actor?.['kind'];
  if (typeof kind !== 'string' || !(kind in ACTOR_FIELDS))
    return { actor: UNREADABLE, label: UNREADABLE };
  const field = ACTOR_FIELDS[kind] as string;
  const detail = actor?.[field];
  const second =
    typeof detail === 'string' && detail !== '' ? detail.toUpperCase() : ABSENT;
  const word = kind.toUpperCase();
  return { actor: word, label: `${word} · ${second}` };
}

/* ── the projection ───────────────────────────────────────────────────── */

/** Every stored row, newest first, as words a table can draw. */
export function auditRows(input: AuditRowsInput): AuditRowView[] {
  const views = input.rows.map((stored): AuditRowView => {
    const event = objectOf(stored.eventJson);
    const type = event?.['type'];
    const readable = typeof type === 'string' && type !== '';
    const { actor, label } = actorOf(stored.actorJson);
    return {
      seq: stored.seq,
      at: stored.at,
      age: ageOf(stored.at, input.nowIso),
      kind: readable ? type : UNREADABLE,
      kindKnown: readable,
      summary: readable && event !== null ? summaryOf(event) : ABSENT,
      actor,
      actorLabel: label,
      deny: readable && event !== null ? denyOf(event) : null,
      eventJson: stored.eventJson,
      actorJson: stored.actorJson,
      prevHash: stored.prevHash,
      hash: stored.hash,
    };
  });
  // Newest first, by SEQ rather than by `at`: seq is the chain's own order and
  // the only field a tamper cannot make plausible.
  return views.sort((a, b) => b.seq - a.seq);
}

export interface AuditFilter {
  /** `''` means every actor. */
  readonly actor: string;
  /** `''` means every row. */
  readonly search: string;
}

/**
 * The client-side narrowing, over the words the row already SHOWS.
 *
 * The haystack is `kind`, `summary` and `actorLabel` and nothing else. A search
 * that reached `eventJson` would be a channel through which the table discloses
 * the body it deliberately declined to draw — the operator would type a word
 * and watch rows containing it appear, which is disclosure by inference even
 * before they open one.
 */
export function filterAuditRows(
  rows: readonly AuditRowView[],
  filter: AuditFilter,
): AuditRowView[] {
  const needle = filter.search.trim().toLowerCase();
  return rows.filter((view) => {
    if (filter.actor !== '' && view.actor !== filter.actor) return false;
    if (needle === '') return true;
    const shown =
      `${view.kind} ${view.summary} ${view.actorLabel}`.toLowerCase();
    return shown.includes(needle);
  });
}

/** The event types the LOADED rows contain, sorted. Unreadable rows abstain. */
export function eventTypes(rows: readonly AuditRowView[]): string[] {
  const types = new Set<string>();
  for (const view of rows) if (view.kindKnown) types.add(view.kind);
  return [...types].sort();
}

/** Says out loud that the chips and the box narrow the LOAD, not the log. */
export function scopeLine(loaded: number): string {
  return `CLIENT-SIDE OVER ${String(loaded)} LOADED ROWS`;
}

/** What the drawn window is hiding from the load, or nothing when it hides none. */
export function moreLine(shown: number, loaded: number): string {
  if (shown >= loaded) return '';
  return `SHOWING ${String(shown)} OF ${String(loaded)} LOADED ROWS`;
}

/**
 * The route's ceiling, in words, once the load has hit it.
 *
 * `GET /v1/audit` takes `since`, `event` and `limit`, and NOTHING that bounds a
 * page from above; the store orders by `seq DESC`. So a second page of OLDER
 * rows is not reachable at any limit, and a LOAD MORE that implied otherwise
 * would be telling an auditor they had seen everything when they had not. The
 * honest affordance is to say what the window is and how to move it.
 */
export function ceilingLine(loaded: number, cap: number): string {
  if (loaded < cap) return '';
  return `NEWEST ${String(cap)} ROWS — NARROW BY SINCE OR EVENT TO REACH OLDER ONES`;
}

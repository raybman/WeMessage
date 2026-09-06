/**
 * The house form kit: a saved row, a draft row, and the diff between them.
 *
 * Three more screens reuse this (Sc11 schedules, Sc12 contacts, Sc14
 * settings), so it is deliberately generic and deliberately small. Two
 * decisions are load-bearing and both come from the same place — the daemon
 * is the authority on what is stored, and the form is only ever a claim
 * about a diff:
 *
 *  - **Cleanliness is a VALUE comparison, not an identity one.** A field
 *    holding `['rent']` re-rendered as a fresh array is not an edit. With
 *    reference equality every paint of a list-valued field would mark the
 *    form dirty and every SAVE would rewrite a matcher nobody touched.
 *  - **Key PRESENCE is part of the value** (`exactOptionalPropertyTypes`).
 *    `{a:1}` and `{a:1, b:undefined}` are different rows, because the daemon
 *    stores `caseSensitive` absent and `caseSensitive:false` as different
 *    JSON. So {@link editForm} DELETES a key when it is handed `undefined`
 *    rather than storing the hole, and the comparison below asks about key
 *    sets before it asks about values.
 *
 * `acceptForm` is the third: after a write, the new baseline is the row the
 * DAEMON answered with, never the body that was sent. The daemon applies
 * defaults and normalises; a form that rebaselined onto its own request
 * would say "no unsaved changes" about a row that does not exist.
 */

/** A saved baseline and the draft on top of it. */
export interface Form<T> {
  readonly saved: T;
  readonly draft: T;
}

/** One validator complaint, addressed by the path the daemon named. */
export interface FieldIssue {
  /** A zod path, joined with dots: `matcher.keywords`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Structural equality over JSON-shaped values, key presence included.
 *
 * Not `JSON.stringify` on both sides: that makes `{a:1,b:2}` and `{b:2,a:1}`
 * different, and object key order is not something a form should have an
 * opinion about.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).sort();
  const other = Object.keys(right).sort();
  if (keys.length !== other.length) return false;
  if (!keys.every((k, i) => k === other[i])) return false;
  return keys.every((k) => deepEqual(left[k], right[k]));
}

/** A form over a row that is already stored, with nothing edited. */
export function formOf<T extends object>(base: T): Form<T> {
  return { saved: base, draft: base };
}

/**
 * The keys whose value or presence differs, sorted.
 *
 * The union of both key sets, not the draft's: removing a key is a change
 * and a scan over the draft alone could not see it.
 */
export function changedKeys<T extends object>(form: Form<T>): string[] {
  const saved = form.saved as Record<string, unknown>;
  const draft = form.draft as Record<string, unknown>;
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  const out: string[] = [];
  for (const key of keys) {
    const here = key in draft;
    if (here !== key in saved) out.push(key);
    else if (here && !deepEqual(draft[key], saved[key])) out.push(key);
  }
  return out.sort();
}

export function isDirty<T extends object>(form: Form<T>): boolean {
  return changedKeys(form).length > 0;
}

/** The changed keys, with the draft's values. Keys the draft DROPPED are not
 * expressible in a patch body and are left to the caller. */
export function formPatch<T extends object>(form: Form<T>): Partial<T> {
  const draft = form.draft as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of changedKeys(form)) if (key in draft) out[key] = draft[key];
  return out as Partial<T>;
}

/**
 * One field, replaced — or REMOVED, when the value is `undefined`.
 *
 * The removal case is the whole reason this is a function rather than a
 * spread at the call site: `{...draft, caseSensitive: undefined}` under
 * `exactOptionalPropertyTypes` is a row with the key present and holding a
 * hole, which is a third state the daemon has no column for.
 */
export function editForm<T extends object, K extends keyof T & string>(
  form: Form<T>,
  key: K,
  value: T[K] | undefined,
): Form<T> {
  const draft: Record<string, unknown> = {
    ...(form.draft as Record<string, unknown>),
  };
  if (value === undefined) delete draft[key];
  else draft[key] = value;
  return { saved: form.saved, draft: draft as T };
}

/** Throw the draft away. Asks nothing of anybody: the baseline is local. */
export function revertForm<T extends object>(form: Form<T>): Form<T> {
  return { saved: form.saved, draft: form.saved };
}

/** Rebaseline onto the row the daemon actually stored. */
export function acceptForm<T extends object>(
  _form: Form<T>,
  stored: T,
): Form<T> {
  return { saved: stored, draft: stored };
}

/**
 * The conditional spread, as a function.
 *
 * `{...optional('k', maybe)}` is `{}` when `maybe` is `undefined` and
 * `{k: maybe}` otherwise. Hand-rolled at a dozen call sites this is where
 * a `: undefined` eventually slips in.
 */
export function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  if (value === undefined) return {};
  return { [key]: value } as { [P in K]?: V };
}

/**
 * The daemon's issue list, addressable by field.
 *
 * FIRST WINS. Two complaints about one field is a list no operator can read
 * inside a field label, and the first is the one the validator reached
 * first — which is the one that stopped it.
 */
export function issuesByPath(
  issues: readonly FieldIssue[],
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const issue of issues)
    if (!out.has(issue.path)) out.set(issue.path, issue.message);
  return out;
}

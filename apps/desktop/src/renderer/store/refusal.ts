/**
 * The daemon's refusal, recovered from the exception it arrived as.
 *
 * An `Error` crossing IPC arrives with its message wrapped twice — once by
 * the client (`daemon request failed (HTTP 400): <body>`) and once by
 * Electron (`Error invoking remote method 'wm:…': …`). The BODY survives
 * both wrappings verbatim, so the JSON is cut out between its outermost
 * braces and read as what it is.
 *
 * This file exists because TWO screens now have to do that and only one of
 * them wants zod's prose. The rules editor renders the validator's own
 * `message` strings; `PATCH /v1/settings` has no prose at all — `planPatch`
 * answers with a STRUCTURE (`{error:'below-floor', key, floor}`) and never a
 * sentence. Sharing the cutter and not the reader is the honest split: the
 * bytes-to-object step is identical, and what the object MEANS is not.
 *
 * It reaches no bridge and holds no state, which is why it is not a binding
 * and is not declared in the store partition. It lives under `store/`
 * anyway because what it knows about is the WIRE — how a daemon's 400 looks
 * by the time it has crossed two process boundaries — and that is this
 * directory's subject.
 */
import type { SettingsRefusal } from '@wemessage/client';

/** Whatever the thrown thing had to say, as a string. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

/**
 * The daemon's body, cut back out of a doubly wrapped message.
 *
 * The OUTERMOST braces, deliberately: a refusal carries nested objects
 * (`detail.issues`) and cutting at the first closing brace would truncate
 * the JSON into something that does not parse. Anything that does not parse
 * is `null` rather than a guess — a caller that invented a key from a
 * mangled body would send an operator hunting for a field they never sent.
 */
export function refusalBody(error: unknown): Record<string, unknown> | null {
  const text = errorText(error);
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close <= open) return null;
  try {
    return asRecord(JSON.parse(text.slice(open, close + 1)));
  } catch {
    return null;
  }
}

/**
 * One of the five named settings refusals, or nothing.
 *
 * NOT a widening of whatever the body said: each variant is rebuilt with
 * exactly its own datum, so a body carrying a floor under an `above-ceiling`
 * name cannot reach a screen that would then render the wrong number. The
 * `error` name is checked against the closed five, which is what makes
 * `invalid-settings` — the body-was-not-a-patch answer, which names no key —
 * come back as `null` rather than as a complaint attached to a field.
 */
export function settingsRefusalOf(error: unknown): SettingsRefusal | null {
  const body = refusalBody(error);
  if (body === null) return null;
  const key = body['key'];
  if (typeof key !== 'string') return null;
  const named = body['error'];
  if (named === 'unknown-key') return { error: named, key };
  if (named === 'read-only-key') {
    const use = body['use'];
    return typeof use === 'string' ? { error: named, key, use } : null;
  }
  if (named === 'wrong-type') {
    const expected = body['expected'];
    return expected === 'int' || expected === 'bool'
      ? { error: named, key, expected }
      : null;
  }
  if (named === 'below-floor') {
    const floor = body['floor'];
    return typeof floor === 'number' ? { error: named, key, floor } : null;
  }
  if (named === 'above-ceiling') {
    const ceiling = body['ceiling'];
    return typeof ceiling === 'number' ? { error: named, key, ceiling } : null;
  }
  return null;
}

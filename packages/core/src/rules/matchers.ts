/**
 * Rule matcher evaluation — S2 Scenario 2 (keyword, regex).
 * Plan §1.3.2 matcher semantics; s2-execution §1.7 (binding).
 *
 * Pure functions over the normalized Message's decoded fields (no Clock, no
 * I/O — INV-1). Contact + combinators land in Scenario 3; `theme` is
 * permanently inert in v1 (§1.4.1 #6 — fail closed for the stubbed
 * Classifier seam).
 */
import type { Handle, RuleMatcher } from '../domain/types.js';
import { validateSafeRegex } from './safe-regex.js';

/** The message fields matchers consume (decoded text + normalized handle). */
export interface MatcherInput {
  text: string | null;
  handle: Handle;
}

type KeywordMatcher = Extract<RuleMatcher, { kind: 'keyword' }>;
type RegexMatcher = Extract<RuleMatcher, { kind: 'regex' }>;
type ContactMatcher = Extract<RuleMatcher, { kind: 'contact' }>;

/**
 * §1.7 contact matcher normalization (E.164 or lowercase email, §2.3
 * contact_policies comment): trim; lowercase emails; strip `space ( ) - .`
 * from phone-shaped strings, preserving the leading `+`.
 */
export function normalizeHandle(handle: string): Handle {
  const trimmed = handle.trim();
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const stripped = trimmed.replace(/[\s().-]/g, '');
  if (/^\+?[0-9]+$/.test(stripped)) return stripped;
  return trimmed;
}

/**
 * §1.7 wholeWord boundary: the keyword occurrence must not be adjacent to
 * \p{L}\p{N}\p{M} on either side. JS `\b` is ASCII-only and a spec violation
 * here (café/naïve/CJK rows in the checkpoint matrix pin the difference).
 */
const WORDLIKE = /[\p{L}\p{N}\p{M}]/u;

function isWordLike(ch: string | undefined): boolean {
  return ch !== undefined && WORDLIKE.test(ch);
}

function containsWholeWord(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const before = idx === 0 ? undefined : haystack[idx - 1];
    const after = haystack[idx + needle.length];
    if (!isWordLike(before) && !isWordLike(after)) return true;
    from = idx + 1;
  }
}

function matchKeyword(matcher: KeywordMatcher, text: string | null): boolean {
  if (text === null) return false;
  if (matcher.keywords.length === 0) return false; // defensive; CRUD rejects
  const fold =
    matcher.caseSensitive === true
      ? (s: string): string => s
      : (s: string): string => s.toLowerCase();
  const haystack = fold(text);
  const hit = (keyword: string): boolean => {
    const needle = fold(keyword);
    return matcher.wholeWord === true
      ? containsWholeWord(haystack, needle)
      : haystack.includes(needle);
  };
  return matcher.mode === 'all'
    ? matcher.keywords.every(hit)
    : matcher.keywords.some(hit);
}

function matchRegex(matcher: RegexMatcher, text: string | null): boolean {
  if (text === null) return false;
  // Defense in depth (F-11): CRUD rejects unsafe patterns with 400, and a
  // rejected pattern that still reaches the engine matches nothing
  // (fail closed, §2.4.2 posture).
  if (!validateSafeRegex(matcher.pattern).ok) return false;
  return new RegExp(matcher.pattern, 'u').test(text);
}

function matchContact(matcher: ContactMatcher, handle: Handle): boolean {
  const normalized = normalizeHandle(handle);
  return matcher.handles.some((h) => normalizeHandle(h) === normalized);
}

export function evaluateMatcher(
  matcher: RuleMatcher,
  input: MatcherInput,
): boolean {
  switch (matcher.kind) {
    case 'keyword':
      return matchKeyword(matcher, input.text);
    case 'regex':
      return matchRegex(matcher, input.text);
    case 'theme':
      // Inert forever in v1: never matches (§1.4.1 #6); CRUD additionally
      // rejects theme matchers with 400 theme-unavailable-v1 (Scenario 7).
      return false;
    case 'contact':
      return matchContact(matcher, input.handle);
    case 'all-of':
      // Empty combinator: defensive no-match (§1.7 — CRUD rejects with 400).
      return (
        matcher.matchers.length > 0 &&
        matcher.matchers.every((m) => evaluateMatcher(m, input))
      );
    case 'any-of':
      return matcher.matchers.some((m) => evaluateMatcher(m, input));
  }
}

/**
 * RE2-safe subset validator — F-11 (s2-execution §1.2, Open flags).
 *
 * Plan §1.3.2 wants RE2 semantics ("no backtracking") to keep untrusted-ish
 * patterns from DoSing the daemon, but INV-1 forbids a native dep in core
 * (zero runtime deps) and the seam list is locked (no RegexEngine port).
 * Coordinator-confirmed resolution: a pure-TS validator that rejects
 * backtracking-dangerous constructs, then matching with the built-in RegExp
 * over the validated subset.
 *
 * Rejected constructs (each with a typed reason):
 *  - patterns longer than SAFE_REGEX_MAX_LENGTH (512)     'pattern-too-long'
 *  - patterns RegExp('u') cannot compile                  'invalid-syntax'
 *  - backreferences (\1-\9, \k<name>)                     'backreference'
 *  - lookarounds ((?= (?! (?<= (?<!)                      'lookaround'
 *  - unbounded quantifier over a group whose subtree
 *    already contains an unbounded quantifier
 *    ((a+)+ / ([0-9]*)* / (ab+){2,} shapes)               'nested-quantifier'
 *
 * Pure module: no I/O, no clock, no entropy (INV-1).
 */

export const SAFE_REGEX_MAX_LENGTH = 512;

export type SafeRegexReason =
  | 'pattern-too-long'
  | 'invalid-syntax'
  | 'backreference'
  | 'lookaround'
  | 'nested-quantifier';

export type SafeRegexResult =
  { ok: true } | { ok: false; reason: SafeRegexReason };

const LOOKAROUND_PREFIXES = ['(?=', '(?!', '(?<=', '(?<!'] as const;

interface QuantifierScan {
  present: boolean;
  unbounded: boolean;
  /** index of the first char after the quantifier */
  end: number;
}

/** Parse a quantifier starting at `i` (`+`, `*`, `?`, `{m}`, `{m,n}`, `{m,}`). */
function scanQuantifier(pattern: string, i: number): QuantifierScan {
  const ch = pattern[i];
  if (ch === '+' || ch === '*')
    return { present: true, unbounded: true, end: i + 1 };
  if (ch === '?') return { present: true, unbounded: false, end: i + 1 };
  if (ch === '{') {
    // The pattern already compiled under the 'u' flag, so a literal '{'
    // cannot appear un-escaped: this is a real bounded/unbounded quantifier.
    const close = pattern.indexOf('}', i);
    if (close === -1) return { present: false, unbounded: false, end: i };
    const body = pattern.slice(i + 1, close);
    return { present: true, unbounded: body.endsWith(','), end: close + 1 };
  }
  return { present: false, unbounded: false, end: i };
}

export function validateSafeRegex(pattern: string): SafeRegexResult {
  if (pattern.length > SAFE_REGEX_MAX_LENGTH) {
    return { ok: false, reason: 'pattern-too-long' };
  }
  try {
    // 'u' is also the matching flag (matchers.ts) — validate what will run.
    void new RegExp(pattern, 'u');
  } catch {
    return { ok: false, reason: 'invalid-syntax' };
  }

  // Single escape-aware, class-aware scan. `unbounded` per open group tracks
  // whether the group's subtree contains an unbounded quantifier.
  const groupStack: Array<{ unbounded: boolean }> = [];
  let inClass = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === '\\') {
      const next = pattern[i + 1];
      // Inside a character class, \1 / \k are invalid under 'u' and were
      // already rejected by the compile step — only real backrefs reach here.
      if (!inClass && next !== undefined && next >= '1' && next <= '9') {
        return { ok: false, reason: 'backreference' };
      }
      if (!inClass && next === 'k') {
        return { ok: false, reason: 'backreference' };
      }
      i += 2;
      continue;
    }

    if (inClass) {
      if (ch === ']') inClass = false;
      i += 1;
      continue;
    }

    if (ch === '[') {
      inClass = true;
      i += 1;
      continue;
    }

    if (ch === '(') {
      for (const prefix of LOOKAROUND_PREFIXES) {
        if (pattern.startsWith(prefix, i)) {
          return { ok: false, reason: 'lookaround' };
        }
      }
      groupStack.push({ unbounded: false });
      i += 1;
      continue;
    }

    if (ch === ')') {
      const group = groupStack.pop();
      const quant = scanQuantifier(pattern, i + 1);
      const subtreeUnbounded = group?.unbounded === true;
      if (quant.unbounded && subtreeUnbounded) {
        return { ok: false, reason: 'nested-quantifier' };
      }
      // Propagate to the enclosing group: '((a+)b)*' must still reject.
      const parent = groupStack[groupStack.length - 1];
      if (parent && (subtreeUnbounded || quant.unbounded)) {
        parent.unbounded = true;
      }
      i = quant.present ? quant.end : i + 1;
      continue;
    }

    if (ch === '+' || ch === '*' || ch === '{') {
      const quant = scanQuantifier(pattern, i);
      const parent = groupStack[groupStack.length - 1];
      if (parent && quant.unbounded) parent.unbounded = true;
      i = quant.present ? quant.end : i + 1;
      continue;
    }

    i += 1;
  }

  return { ok: true };
}

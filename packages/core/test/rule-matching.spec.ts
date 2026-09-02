/**
 * S2 NAMED CHECKPOINT — rule-matching.spec.ts (matcher matrix incl. Unicode
 * word bounds). Built up across S2 Scenarios 2-4; this file starts with
 * Scenario 2: keyword + safe-regex matchers (s2-execution Part 2 Scenario 2;
 * plan §1.3.2; §1.7 matcher semantics).
 *
 * F-11 disposition (coordinator-confirmed): pure-TS RE2-safe subset validator
 * + built-in RegExp over the validated subset. No re2 dependency (§1.2 closed
 * list; INV-1 — core has zero runtime deps).
 *
 * Unicode wholeWord contract (§1.7): a keyword occurrence matches only when
 * not adjacent to \p{L}\p{N}\p{M} on either side. JS ASCII `\b` is a spec
 * violation here — several rows below (café/naïve boundary rows) are chosen
 * so an ASCII-\b implementation fails them (the Scenario 2 teeth proof).
 */
import { describe, expect, it } from 'vitest';
import type { Message, RuleMatcher } from '@wemessage/core';
import {
  evaluateMatcher,
  SAFE_REGEX_MAX_LENGTH,
  validateSafeRegex,
} from '@wemessage/core';

function keyword(
  keywords: string[],
  opts: Partial<{
    mode: 'any' | 'all';
    caseSensitive: boolean;
    wholeWord: boolean;
  }> = {},
): RuleMatcher {
  return { kind: 'keyword', keywords, mode: opts.mode ?? 'any', ...opts };
}

function input(text: string | null, handle = '+15550001111') {
  return { text, handle };
}

describe('keyword matcher (§1.3.2, §1.7)', () => {
  it('mode "any": matches when at least one keyword is present', () => {
    const m = keyword(['tacos', 'pizza'], { mode: 'any' });
    expect(evaluateMatcher(m, input('pizza tonight?'))).toBe(true);
    expect(evaluateMatcher(m, input('tacos at noon'))).toBe(true);
    expect(evaluateMatcher(m, input('salad only'))).toBe(false);
  });

  it('mode "all": matches only when every keyword is present', () => {
    const m = keyword(['tacos', 'noon'], { mode: 'all' });
    expect(evaluateMatcher(m, input('tacos at noon'))).toBe(true);
    expect(evaluateMatcher(m, input('tacos tonight'))).toBe(false);
    expect(evaluateMatcher(m, input('see you at noon'))).toBe(false);
  });

  it('is case-insensitive by default (toLowerCase fold)', () => {
    expect(evaluateMatcher(keyword(['TACOS']), input('get tacos'))).toBe(true);
    expect(evaluateMatcher(keyword(['tacos']), input('TACOS!'))).toBe(true);
  });

  it('honors caseSensitive: true', () => {
    const m = keyword(['Tacos'], { caseSensitive: true });
    expect(evaluateMatcher(m, input('Tacos today'))).toBe(true);
    expect(evaluateMatcher(m, input('tacos today'))).toBe(false);
  });

  describe('wholeWord uses Unicode-aware boundaries (§1.7 — ASCII \\b is a spec violation)', () => {
    const whole = (kw: string) => keyword([kw], { wholeWord: true });

    it('matches "café" in "un café noir" (ASCII \\b would fail: é is a non-word char to \\b)', () => {
      expect(evaluateMatcher(whole('café'), input('un café noir'))).toBe(true);
    });

    it('does not match "café" inside "cafés" (adjacent \\p{L})', () => {
      expect(evaluateMatcher(whole('café'), input('cafés'))).toBe(false);
    });

    it('matches "naïve" at string edges and mid-sentence', () => {
      expect(evaluateMatcher(whole('naïve'), input('naïve'))).toBe(true);
      expect(evaluateMatcher(whole('naïve'), input('so naïve'))).toBe(true);
      expect(evaluateMatcher(whole('naïve'), input('a naïve plan'))).toBe(true);
      expect(evaluateMatcher(whole('naïve'), input('naïveté'))).toBe(false);
    });

    it('treats digits as word characters ("call 911" vs "9112")', () => {
      expect(evaluateMatcher(whole('911'), input('call 911'))).toBe(true);
      expect(evaluateMatcher(whole('911'), input('9112'))).toBe(false);
      expect(evaluateMatcher(whole('911'), input('x911'))).toBe(false);
    });

    it('emoji adjacency does not break the boundary (emoji is not \\p{L}\\p{N}\\p{M})', () => {
      expect(evaluateMatcher(whole('tacos'), input('tacos🌮'))).toBe(true);
      expect(evaluateMatcher(whole('tacos'), input('🔥tacos🔥'))).toBe(true);
    });

    it('combining marks (\\p{M}) count as word characters', () => {
      // "cafe" followed by U+0301 combining acute: the mark is adjacent.
      expect(evaluateMatcher(whole('cafe'), input('café'))).toBe(false);
    });

    it('documented CJK consequence: wholeWord "日本" does not match inside "日本語"', () => {
      expect(evaluateMatcher(whole('日本'), input('日本語'))).toBe(false);
      expect(evaluateMatcher(whole('日本'), input('日本 へ行く'))).toBe(true);
    });

    it('composes with the default case-insensitive fold', () => {
      expect(evaluateMatcher(whole('CAFÉ'), input('un café noir'))).toBe(true);
    });
  });

  it('runs on the decoded body of a fixture-shaped Message (decoding proven in S1)', () => {
    // The value is plain here; the attributedBody -> text decode path was
    // proven by the S1 corpus (s2-execution §3.1). Matching consumes the
    // decoded `text` field of the normalized Message.
    const message: Message = {
      guid: 'GL-FIX-KW-001',
      sourceRowid: 42,
      chatGuid: 'iMessage;-;+15550001111',
      handle: '+15550001111',
      isFromMe: false,
      isGroup: false,
      service: 'imessage',
      kind: 'text',
      text: 'GL-FIX-002 emoji 👍🏽🔥',
      attachments: [],
      sentAt: '2026-09-01T00:00:00.000Z',
      receivedAt: '2026-09-01T00:00:01.000Z',
    };
    const m = keyword(['emoji'], { wholeWord: true });
    expect(
      evaluateMatcher(m, { text: message.text, handle: message.handle }),
    ).toBe(true);
  });

  it('never matches when text is null (§1.7)', () => {
    expect(evaluateMatcher(keyword(['tacos']), input(null))).toBe(false);
    expect(
      evaluateMatcher(keyword(['tacos'], { wholeWord: true }), input(null)),
    ).toBe(false);
  });
});

describe('safe-regex validator (F-11: pure-TS RE2-safe subset)', () => {
  it('accepts literals, classes, alternation, bounded quantifiers, anchors', () => {
    for (const pattern of [
      'hello world',
      '[a-z]+[0-9]{1,3}',
      'foo|bar|baz',
      '^order #[0-9]{1,5}$',
      'a{2,4}b?',
      'colou?r',
      '(?<year>[0-9]{4})-[0-9]{2}', // named group is not a lookbehind
      '(?:ab)cd', // non-capturing group without nested unbounded quantifier
    ]) {
      expect(validateSafeRegex(pattern)).toEqual({ ok: true });
    }
  });

  it('rejects backreferences with a typed reason', () => {
    expect(validateSafeRegex('(a)\\1')).toEqual({
      ok: false,
      reason: 'backreference',
    });
    expect(validateSafeRegex('(?<x>a)\\k<x>')).toEqual({
      ok: false,
      reason: 'backreference',
    });
  });

  it('rejects all four lookaround forms with a typed reason', () => {
    for (const pattern of [
      'foo(?=bar)',
      'foo(?!bar)',
      '(?<=foo)bar',
      '(?<!foo)bar',
    ]) {
      expect(validateSafeRegex(pattern)).toEqual({
        ok: false,
        reason: 'lookaround',
      });
    }
  });

  it('rejects nested unbounded quantifiers over groups ((a+)+-shape) with a typed reason', () => {
    for (const pattern of [
      '(a+)+',
      '([0-9]*)*',
      '(ab+){2,}',
      '(?:a+)+',
      '((a+)b)*', // unbounded quantifier over a group whose subtree is unbounded
    ]) {
      expect(validateSafeRegex(pattern)).toEqual({
        ok: false,
        reason: 'nested-quantifier',
      });
    }
  });

  it('does not reject safe quantifier compositions', () => {
    for (const pattern of [
      '(a)+', // no inner quantifier
      '(a+)b+', // sibling quantifiers, not nested
      '(a+){2,4}', // bounded outer over unbounded inner
      '(a{1,3})+', // unbounded outer over bounded inner
    ]) {
      expect(validateSafeRegex(pattern)).toEqual({ ok: true });
    }
  });

  it('rejects patterns longer than the 512-char cap with a typed reason', () => {
    expect(SAFE_REGEX_MAX_LENGTH).toBe(512);
    expect(validateSafeRegex('a'.repeat(512))).toEqual({ ok: true });
    expect(validateSafeRegex('a'.repeat(513))).toEqual({
      ok: false,
      reason: 'pattern-too-long',
    });
  });

  it('rejects syntactically invalid patterns with a typed reason', () => {
    for (const pattern of ['(', 'a{2,1}', '[z-a]']) {
      expect(validateSafeRegex(pattern)).toEqual({
        ok: false,
        reason: 'invalid-syntax',
      });
    }
  });
});

describe('regex matcher (§1.3.2; F-11 defense in depth)', () => {
  const regex = (pattern: string): RuleMatcher => ({ kind: 'regex', pattern });

  it('matches and non-matches with a validated pattern', () => {
    const m = regex('order #[0-9]+');
    expect(evaluateMatcher(m, input('your order #42 shipped'))).toBe(true);
    expect(evaluateMatcher(m, input('no order here'))).toBe(false);
  });

  it('is Unicode-capable over the validated subset', () => {
    expect(evaluateMatcher(regex('café'), input('un café noir'))).toBe(true);
    expect(evaluateMatcher(regex('日本語'), input('日本語です'))).toBe(true);
  });

  it('a pattern that fails validation matches nothing (fail closed, §2.4.2 posture)', () => {
    // Would match 'aaa' if the engine ran it — the validator must gate it out.
    expect(evaluateMatcher(regex('(a+)+'), input('aaa'))).toBe(false);
    expect(evaluateMatcher(regex('foo(?=bar)'), input('foobar'))).toBe(false);
    expect(evaluateMatcher(regex('('), input('anything ( at all'))).toBe(false);
  });

  it('never matches when text is null (§1.7)', () => {
    expect(evaluateMatcher(regex('.*'), input(null))).toBe(false);
  });
});

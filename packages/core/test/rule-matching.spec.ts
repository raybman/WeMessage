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
import type { Message, Rule, RuleMatcher } from '@wemessage/core';
import {
  evaluateMatcher,
  evaluateRules,
  normalizeHandle,
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

/* ------------------------------------------------------------------------ *
 * Scenario 3 — contact matcher, combinators, eligibility & priority
 * (checkpoint part 2 — INV-6 becomes behavior). s2-execution Part 2
 * Scenario 3; §1.7 eligibility table; F-12 (engine returns the full ordered
 * match list; single-winner enforcement is the daemon pipeline's, Scenario 9).
 * ------------------------------------------------------------------------ */

function makeMessage(partial: Partial<Message> = {}): Message {
  return {
    guid: 'GL-FIX-MSG-001',
    sourceRowid: 1,
    chatGuid: 'iMessage;-;+15551234567',
    handle: '+15551234567',
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: 'tacos at noon',
    attachments: [],
    sentAt: '2026-09-01T00:00:00.000Z',
    receivedAt: '2026-09-01T00:00:01.000Z',
    ...partial,
  };
}

function makeRule(partial: Partial<Rule> & Pick<Rule, 'id' | 'matcher'>): Rule {
  return {
    name: 'rule',
    enabled: true,
    adapterId: 'echo',
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 60,
    priority: 100,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...partial,
  };
}

const noDrafts = { hasDraftForMessage: () => false };

describe('normalizeHandle (§1.7 contact matcher; §2.3 contact_policies comment)', () => {
  it('collapses E.164 formatting variants (strip space ( ) - . keep leading +)', () => {
    expect(normalizeHandle('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizeHandle('+15551234567')).toBe('+15551234567');
    expect(normalizeHandle('555.123.4567')).toBe('5551234567');
    expect(normalizeHandle(' +44 20 7946 0958 ')).toBe('+442079460958');
  });

  it('casefolds emails and trims', () => {
    expect(normalizeHandle(' Eric.Test@Example.COM ')).toBe(
      'eric.test@example.com',
    );
  });
});

describe('contact matcher (§1.3.2 — a matcher, not the S4 contact-policy gate)', () => {
  it('matches when formatting variants of the same number collapse equal', () => {
    const m: RuleMatcher = { kind: 'contact', handles: ['+1 (555) 123-4567'] };
    expect(evaluateMatcher(m, input('hi', '+15551234567'))).toBe(true);
    const m2: RuleMatcher = { kind: 'contact', handles: ['+15551234567'] };
    expect(evaluateMatcher(m2, input('hi', '+1 (555) 123-4567'))).toBe(true);
  });

  it('casefolds email handles on both sides', () => {
    const m: RuleMatcher = { kind: 'contact', handles: ['QA@Example.com'] };
    expect(evaluateMatcher(m, input('hi', 'qa@example.com'))).toBe(true);
  });

  it('does not match a non-listed handle', () => {
    const m: RuleMatcher = { kind: 'contact', handles: ['+15551234567'] };
    expect(evaluateMatcher(m, input('hi', '+15559999999'))).toBe(false);
  });

  it('matches independent of text (works with null text)', () => {
    const m: RuleMatcher = { kind: 'contact', handles: ['+15551234567'] };
    expect(evaluateMatcher(m, input(null, '+15551234567'))).toBe(true);
  });
});

describe('all-of / any-of combinators (§1.3.2 recursive composition)', () => {
  const contact = (h: string): RuleMatcher => ({
    kind: 'contact',
    handles: [h],
  });

  it('composes three deep', () => {
    const m: RuleMatcher = {
      kind: 'any-of',
      matchers: [
        contact('+15550000000'), // no
        {
          kind: 'all-of',
          matchers: [
            keyword(['tacos']),
            {
              kind: 'any-of',
              matchers: [contact('+15551234567'), keyword(['nomatch-word'])],
            },
          ],
        },
      ],
    };
    expect(evaluateMatcher(m, input('tacos at noon', '+15551234567'))).toBe(
      true,
    );
    // Break the innermost leg: wrong handle AND missing keyword
    expect(evaluateMatcher(m, input('salad at noon', '+15551234567'))).toBe(
      false,
    );
  });

  it('all-of requires every branch; any-of requires at least one', () => {
    const all: RuleMatcher = {
      kind: 'all-of',
      matchers: [keyword(['tacos']), keyword(['noon'])],
    };
    expect(evaluateMatcher(all, input('tacos at noon'))).toBe(true);
    expect(evaluateMatcher(all, input('tacos tonight'))).toBe(false);
    const any: RuleMatcher = {
      kind: 'any-of',
      matchers: [keyword(['tacos']), keyword(['pizza'])],
    };
    expect(evaluateMatcher(any, input('pizza tonight'))).toBe(true);
    expect(evaluateMatcher(any, input('salad'))).toBe(false);
  });

  it('empty matchers arrays are a defensive no-match (CRUD rejects them with 400)', () => {
    expect(
      evaluateMatcher({ kind: 'all-of', matchers: [] }, input('anything')),
    ).toBe(false);
    expect(
      evaluateMatcher({ kind: 'any-of', matchers: [] }, input('anything')),
    ).toBe(false);
  });
});

describe('theme matcher is inert (§1.4.1 #6 — fail closed for the stubbed Classifier seam)', () => {
  it('never matches, even when the text plainly mentions the theme', () => {
    const m: RuleMatcher = {
      kind: 'theme',
      themes: ['dinner'],
      minConfidence: 0.1,
    };
    expect(evaluateMatcher(m, input('dinner plans for dinner tonight'))).toBe(
      false,
    );
  });

  it('is inert inside combinators too', () => {
    const m: RuleMatcher = {
      kind: 'any-of',
      matchers: [{ kind: 'theme', themes: ['dinner'], minConfidence: 0.1 }],
    };
    expect(evaluateMatcher(m, input('dinner tonight'))).toBe(false);
  });
});

describe('evaluateRules — eligibility (§1.7) & ordering (F-12)', () => {
  const tacoRule = (id: string, partial: Partial<Rule> = {}): Rule =>
    makeRule({ id, matcher: keyword(['tacos']), ...partial });

  it('isFromMe messages never match — INV-6 becomes behavior', () => {
    const rules = [tacoRule('01A')];
    const message = makeMessage({ isFromMe: true });
    expect(evaluateRules(rules, message, noDrafts)).toEqual([]);
    // Control: the identical message with isFromMe false matches.
    expect(
      evaluateRules(rules, makeMessage({ isFromMe: false }), noDrafts),
    ).toHaveLength(1);
  });

  it('tapbacks never match (§1.3.8: a "loved" tapback must not trigger an auto-reply)', () => {
    const message = makeMessage({
      kind: 'tapback',
      text: 'tacos', // even with matching text along for the ride
      tapback: { targetGuid: 'GL-FIX-MSG-000', type: 2000 },
    });
    expect(evaluateRules([tacoRule('01A')], message, noDrafts)).toEqual([]);
  });

  it('unsends never match', () => {
    const message = makeMessage({ kind: 'unsend', text: null });
    expect(
      evaluateRules(
        [
          makeRule({
            id: '01A',
            matcher: { kind: 'contact', handles: ['+15551234567'] },
          }),
        ],
        message,
        noDrafts,
      ),
    ).toEqual([]);
  });

  it('audio/attachment-only messages match only rules with matchAttachmentOnly: true', () => {
    const audio = makeMessage({ kind: 'audio', text: null });
    const attach = makeMessage({ kind: 'attachment-only', text: 'tacos pic' });
    const contactRule = makeRule({
      id: '01A',
      matcher: { kind: 'contact', handles: ['+15551234567'] },
      matchAttachmentOnly: true,
    });
    // Gated off without the flag:
    expect(
      evaluateRules(
        [
          makeRule({
            id: '01B',
            matcher: { kind: 'contact', handles: ['+15551234567'] },
          }),
        ],
        audio,
        noDrafts,
      ),
    ).toEqual([]);
    // With the flag, text-independent matchers reach null-text messages:
    expect(evaluateRules([contactRule], audio, noDrafts)).toHaveLength(1);
    // And text-dependent matchers see the caption (§1.3.8):
    expect(
      evaluateRules(
        [tacoRule('01C', { matchAttachmentOnly: true })],
        attach,
        noDrafts,
      ),
    ).toHaveLength(1);
    // Caption absent -> keyword cannot match even with the flag:
    expect(
      evaluateRules(
        [tacoRule('01D', { matchAttachmentOnly: true })],
        audio,
        noDrafts,
      ),
    ).toEqual([]);
  });

  it('edits are re-matched only when no draft exists yet (§1.3.8; both branches)', () => {
    const edited = makeMessage({
      kind: 'edit',
      text: 'tacos actually',
      editedAt: '2026-09-01T00:05:00.000Z',
    });
    const rules = [tacoRule('01A')];
    expect(
      evaluateRules(rules, edited, { hasDraftForMessage: () => false }),
    ).toHaveLength(1);
    expect(
      evaluateRules(rules, edited, { hasDraftForMessage: () => true }),
    ).toEqual([]);
  });

  it('group messages ARE matched (§1.3.8: ingested, matched, surfaced as events/audit only)', () => {
    const group = makeMessage({
      isGroup: true,
      chatGuid: 'chat123456789',
    });
    expect(evaluateRules([tacoRule('01A')], group, noDrafts)).toHaveLength(1);
  });

  it('disabled rules are skipped entirely (UI §3 S3: dimmed, editable, skipped)', () => {
    const rules = [tacoRule('01A', { enabled: false }), tacoRule('01B')];
    const matched = evaluateRules(rules, makeMessage(), noDrafts);
    expect(matched.map((r) => r.id)).toEqual(['01B']);
  });

  it('returns ALL matches ordered priority ASC, id ASC tiebreak (F-12: winner policy is the pipeline)', () => {
    const rules = [
      tacoRule('01Z', { priority: 20 }),
      tacoRule('01B', { priority: 10 }),
      tacoRule('01A', { priority: 10 }),
      tacoRule('01C', { priority: 5, matcher: keyword(['pizza']) }), // no match
    ];
    const matched = evaluateRules(rules, makeMessage(), noDrafts);
    expect(matched.map((r) => r.id)).toEqual(['01A', '01B', '01Z']);
  });

  it('does not mutate the input rules array', () => {
    const rules = [
      tacoRule('01Z', { priority: 20 }),
      tacoRule('01A', { priority: 10 }),
    ];
    const before = rules.map((r) => r.id);
    void evaluateRules(rules, makeMessage(), noDrafts);
    expect(rules.map((r) => r.id)).toEqual(before);
  });
});

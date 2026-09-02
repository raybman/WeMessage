/**
 * Scenario 10 (part, commit 1 of 2) — pure `dryRun(rule, messages)` helper.
 * s2-execution Part 2 Scenario 10 GREEN: "pure dryRun(rule, messages) helper
 * in core/rules (thin composition over evaluateRules for a single rule)";
 * §1.6 route 7 pins the row shape: { total, matched,
 * rows: [{guid, handle, textPreview, matched}] }.
 *
 * Contract pinned here (the daemon route in commit 2 is a thin adapter):
 *  - verdict fidelity: per-row verdicts equal live-engine verdicts — same
 *    evaluateRules message eligibility (a self-sent or tapback row reports
 *    matched:false for the same reason live matching skips it);
 *  - ONE deliberate divergence: rule-level `enabled` is ignored — a disabled
 *    rule is still dry-runnable (editor affordance; UI §3 S3's dry-run panel
 *    operates on drafts-in-progress). Everything else (matchAttachmentOnly
 *    gating, kind/isFromMe eligibility, matcher semantics) is live-identical;
 *  - textPreview: first 80 chars (DRY_RUN_PREVIEW_CHARS); null-text rows
 *    render matched:false with textPreview:null, no throw;
 *  - pure per INV-1: input order preserved, inputs never mutated, no I/O.
 */
import { describe, expect, it } from 'vitest';
import {
  DRY_RUN_PREVIEW_CHARS,
  dryRun,
  evaluateRules,
  type DryRunRow,
  type Message,
  type Rule,
} from '@wemessage/core';

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

const keywordRule = makeRule({
  id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
  matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
});

/** The eligibility gauntlet: every §1.7 skip reason plus plain hit/miss. */
function gauntlet(): Message[] {
  return [
    makeMessage({ guid: 'g-hit', text: 'tacos at noon?' }),
    makeMessage({ guid: 'g-miss', text: 'salad instead' }),
    makeMessage({ guid: 'g-self', text: 'tacos on me', isFromMe: true }),
    makeMessage({ guid: 'g-tapback', kind: 'tapback', text: 'Loved "tacos"' }),
    makeMessage({ guid: 'g-unsend', kind: 'unsend', text: 'tacos (unsent)' }),
    makeMessage({ guid: 'g-attach', kind: 'attachment-only', text: null }),
  ];
}

describe('dryRun (§1.6 route 7 pure core; S2 Scenario 10)', () => {
  it('replays a single rule with live-engine verdicts and the §1.6 row shape', () => {
    const result = dryRun(keywordRule, gauntlet());
    // Exact toEqual: pins the full row shape {guid, handle, textPreview,
    // matched} (§1.6 route 7) — nothing extra leaks onto the wire shape.
    expect(result.rows).toEqual<DryRunRow[]>([
      {
        guid: 'g-hit',
        handle: '+15551234567',
        textPreview: 'tacos at noon?',
        matched: true,
      },
      {
        guid: 'g-miss',
        handle: '+15551234567',
        textPreview: 'salad instead',
        matched: false,
      },
      {
        guid: 'g-self',
        handle: '+15551234567',
        textPreview: 'tacos on me',
        matched: false, // INV-6: isFromMe is never matched
      },
      {
        guid: 'g-tapback',
        handle: '+15551234567',
        textPreview: 'Loved "tacos"',
        matched: false, // §1.3.8: tapbacks must not trigger
      },
      {
        guid: 'g-unsend',
        handle: '+15551234567',
        textPreview: 'tacos (unsent)',
        matched: false,
      },
      {
        guid: 'g-attach',
        handle: '+15551234567',
        textPreview: null, // null text renders null preview, no throw
        matched: false,
      },
    ]);
    expect(result.total).toBe(6);
    expect(result.matched).toBe(1);
  });

  it('verdicts equal evaluateRules for every row (fidelity contract)', () => {
    const messages = gauntlet();
    const { rows } = dryRun(keywordRule, messages);
    for (const [i, message] of messages.entries()) {
      const live = evaluateRules([keywordRule], message, noDrafts).length > 0;
      expect(rows[i]?.matched, message.guid).toBe(live);
    }
  });

  it('a disabled rule is still dry-runnable (editor affordance, UI §3 S3)', () => {
    const disabled = { ...keywordRule, enabled: false };
    const result = dryRun(disabled, gauntlet());
    // Identical verdicts to the enabled run — only `enabled` is overridden.
    expect(result).toEqual(dryRun(keywordRule, gauntlet()));
    expect(result.matched).toBe(1);
  });

  it('matchAttachmentOnly gating stays live-identical (only `enabled` is overridden)', () => {
    const contactRule = makeRule({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      matcher: { kind: 'contact', handles: ['+15551234567'] },
      enabled: false, // disabled AND attachment-gated: only the former lifts
    });
    const attach = [makeMessage({ guid: 'g-a', kind: 'audio', text: null })];
    expect(dryRun(contactRule, attach).matched).toBe(0);
    expect(
      dryRun({ ...contactRule, matchAttachmentOnly: true }, attach).matched,
    ).toBe(1);
  });

  it('truncates textPreview to 80 chars; short text passes through', () => {
    const long = `tacos ${'x'.repeat(114)}`; // 120 chars, trigger up front
    const { rows } = dryRun(keywordRule, [
      makeMessage({ guid: 'g-long', text: long }),
      makeMessage({ guid: 'g-short', text: 'ok' }),
    ]);
    expect(rows[0]?.matched).toBe(true);
    expect(rows[0]?.textPreview).toBe(long.slice(0, DRY_RUN_PREVIEW_CHARS));
    expect(rows[0]?.textPreview).toHaveLength(80);
    expect(rows[1]?.textPreview).toBe('ok');
  });

  it('preserves input order, never mutates inputs, and handles an empty window', () => {
    const messages = gauntlet().map((m) => Object.freeze(m));
    Object.freeze(messages);
    const rule = Object.freeze({
      ...keywordRule,
      enabled: false,
      matcher: Object.freeze(keywordRule.matcher),
    });
    // Frozen inputs: any mutation (e.g. flipping enabled in place) throws in
    // strict mode — purity per INV-1 is load-bearing, not cosmetic.
    const { rows } = dryRun(rule, messages);
    expect(rows.map((r) => r.guid)).toEqual(messages.map((m) => m.guid));
    expect(rule.enabled).toBe(false);
    expect(dryRun(keywordRule, [])).toEqual({
      total: 0,
      matched: 0,
      rows: [],
    });
  });
});

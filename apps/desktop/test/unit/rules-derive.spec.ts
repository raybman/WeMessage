/**
 * s8-execution Scenario 10 — the rules editor's decisions, without a DOM.
 *
 * The rules screen is a SAFETY surface, not a CRUD form, and almost every
 * safety claim it makes is a pure function of data the daemon already sent.
 * Those functions are tested here so that the e2e can spend its Electron
 * launches proving the strings reach the screen rather than re-deriving
 * arithmetic through a browser.
 *
 * Four of the claims are load-bearing and each has its own block:
 *
 *  - **A rule cannot widen.** §2.4.3's ladder is narrowing-only. The screen
 *    renders the ladder rather than the rule's own `respondMode`, because a
 *    field that says AUTO under a global `draft-only` is a lie about what
 *    the rule will do. `scopeLadder` is that render, and the type it
 *    returns has no way to spell "widened".
 *  - **Nothing drafts by default.** With no `ContactPolicy` row the gate
 *    denies outright (`contact-denied`), so a perfectly valid rule drafts
 *    for nobody. The ladder carries that sentence and the count behind it.
 *  - **Editing a rule approves nothing.** The form kit produces a PATCH
 *    body and nothing else; `rulePatchOf` is a total function into
 *    `Partial<RuleInput>` and there is no field on `RuleInput` that could
 *    approve a draft. The e2e proves the wire agrees.
 *  - **`exactOptionalPropertyTypes` is a form problem.** A keyword matcher
 *    stored WITHOUT `caseSensitive` and one stored with `caseSensitive:
 *    false` behave identically at the matcher and differ as JSON. A form
 *    that normalised the absent key to `false` on load and wrote it back
 *    would report itself dirty for a change the operator did not make, and
 *    would rewrite a matcher on every save. The kit round-trips instead.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { describe, expect, it } from 'vitest';
import type {
  AuditRowPayload,
  DryRunRow,
  RuleMatcher,
  RulePayload,
} from '@wemessage/client';
import {
  acceptForm,
  changedKeys,
  editForm,
  formOf,
  formPatch,
  isDirty,
  issuesByPath,
  optional,
  revertForm,
  type FieldIssue,
} from '../../src/renderer/derive/form.js';
import {
  AUTO_EVERYONE,
  formProblems,
  matcherOf,
  needsTypedConfirm,
  NEW_RULE,
  OUTSIDE_WINDOW_CHOICES,
  regexProblem,
  ruleInputOf,
  rulePatchOf,
  valueOf,
  type RuleFormValue,
} from '../../src/renderer/derive/ruleForm.js';
import { rulesToday } from '../../src/renderer/derive/rulesToday.js';
import { scopeLadder } from '../../src/renderer/derive/scopeLadder.js';
import { dryRunView, shadowMap } from '../../src/renderer/derive/dryRun.js';

const HANDLE = '+15550001111';
const OTHER = '+15550002222';

function rule(over: Partial<RulePayload> = {}): RulePayload {
  return {
    id: '01HQ0000000000000000000R01',
    name: 'rent inquiry',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['rent'], mode: 'any' },
    adapterId: 'agent-one',
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 30,
    priority: 100,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...over,
  };
}

/* ── the house form kit ───────────────────────────────────────────────── */

describe('s8 Sc10: the form kit, which three more screens will reuse', () => {
  interface Simple {
    readonly name: string;
    readonly count: number;
    readonly tags: readonly string[];
  }
  const base: Simple = { name: 'a', count: 1, tags: ['x'] };

  it('a fresh form is clean, and cleanliness is a value comparison not an identity one', () => {
    const f = formOf(base);
    expect(isDirty(f)).toBe(false);
    expect(changedKeys(f)).toEqual([]);
    expect(formPatch(f)).toEqual({});
    // A structurally equal ARRAY is not a change. Reference equality here
    // would make every re-render of a list-valued field dirty.
    const same = editForm(f, 'tags', ['x']);
    expect(isDirty(same)).toBe(false);
    expect(changedKeys(same)).toEqual([]);
  });

  it('an edit is dirty, names only the keys that moved, and reverts exactly', () => {
    const f = editForm(editForm(formOf(base), 'name', 'b'), 'count', 1);
    expect(isDirty(f)).toBe(true);
    // `count` was set to the value it already had: not a change.
    expect(changedKeys(f)).toEqual(['name']);
    expect(formPatch(f)).toEqual({ name: 'b' });
    const back = revertForm(f);
    expect(isDirty(back)).toBe(false);
    expect(back.draft).toEqual(base);
  });

  it('accepting what the daemon stored makes the form clean against the STORED row', () => {
    // The daemon is allowed to disagree with what was sent — it applies
    // defaults, it normalises. `acceptForm` takes the daemon's answer as the
    // new baseline, so a form that showed "no unsaved changes" is telling
    // the truth about the SERVER's row and not about the request.
    const f = editForm(formOf(base), 'count', 9);
    const settled = acceptForm(f, { ...base, count: 7 });
    expect(isDirty(settled)).toBe(false);
    expect(settled.draft.count).toBe(7);
    expect(settled.saved.count).toBe(7);
  });

  it('key PRESENCE is part of the value, which is what makes it an EOPT kit', () => {
    interface Opt {
      readonly a: number;
      readonly b?: number;
    }
    const absent: Opt = { a: 1 };
    const f = formOf(absent);
    expect(isDirty(f)).toBe(false);
    // Adding the key is a change even though nothing "changed value" in the
    // loose sense, and REMOVING it again returns to clean.
    const added = editForm(f, 'b', 2);
    expect(changedKeys(added)).toEqual(['b']);
    const removed = editForm(added, 'b', undefined);
    expect(changedKeys(removed)).toEqual([]);
    expect('b' in removed.draft).toBe(false);
    expect(removed.draft.b).toBeUndefined();
  });

  it('optional() is the conditional spread, as a function, so callers stop hand-rolling it', () => {
    expect({ ...optional('issue', 'too short') }).toEqual({
      issue: 'too short',
    });
    const nothing = { ...optional('issue', undefined) };
    expect(nothing).toEqual({});
    expect('issue' in nothing).toBe(false);
  });

  it('issuesByPath keeps the daemon`s zod paths addressable by field', () => {
    const issues: readonly FieldIssue[] = [
      { path: 'name', message: 'String must contain at least 1 character(s)' },
      { path: 'matcher.keywords', message: 'Array must contain at least 1' },
    ];
    const map = issuesByPath(issues);
    expect(map.get('name')).toContain('at least 1 character');
    expect(map.get('adapterId')).toBeUndefined();
    // First one wins: two issues on one path is a list the operator cannot
    // read inside a field label, and the first is the one zod reached first.
    expect(
      issuesByPath([
        { path: 'name', message: 'first' },
        { path: 'name', message: 'second' },
      ]).get('name'),
    ).toBe('first');
  });
});

/* ── the rule form ────────────────────────────────────────────────────── */

describe('s8 Sc10: RuleInput round-trips through the form without inventing keys', () => {
  it('a new rule defaults to DRAFT-ONLY, no group drafts, TTL 30, no schedule', () => {
    // §2.3's DDL default for draftTtlMinutes is 240 and the wireframe's new
    // rule says 30, so the GUI has to SEND 30 rather than omit the field.
    expect(NEW_RULE.respond).toBe('DRAFT-ONLY');
    expect(NEW_RULE.allowGroupDrafts).toBe(false);
    expect(NEW_RULE.draftTtlMinutes).toBe(30);
    expect(NEW_RULE.scheduleId).toBeNull();
    const input = ruleInputOf({ ...NEW_RULE, name: 'n', adapterId: 'a' });
    expect(input).not.toBeNull();
    expect(input?.draftTtlMinutes).toBe(30);
    expect(input?.respondMode).toBe('draft-only');
    expect(input?.allowGroupDrafts).toBe(false);
    expect(input?.scheduleId).toBeNull();
  });

  it('OFF is enabled:false and not a third respondMode', () => {
    // §2.3 has two respond modes. The wireframe has three choices. OFF is
    // the ENABLED column, and a form that invented `respondMode: 'off'`
    // would 400 on a value the enum does not have.
    const off = ruleInputOf({
      ...NEW_RULE,
      name: 'n',
      adapterId: 'a',
      respond: 'OFF',
    });
    expect(off?.enabled).toBe(false);
    expect(off?.respondMode).toBe('draft-only');
    const auto = ruleInputOf({
      ...NEW_RULE,
      name: 'n',
      adapterId: 'a',
      respond: 'AUTO',
    });
    expect(auto?.enabled).toBe(true);
    expect(auto?.respondMode).toBe('auto');
  });

  it('a keyword matcher with no caseSensitive key round-trips WITHOUT gaining one', () => {
    // The EOPT row. `{kind:'keyword', keywords:['rent'], mode:'any'}` and
    // the same object with `caseSensitive: false` are the same matcher and
    // different JSON. Loading, toggling on, toggling off and saving must
    // leave the stored row alone.
    const stored = rule();
    const loaded = formOf(valueOf(stored));
    expect(loaded.draft.caseSensitive).toBe(false);
    expect(isDirty(loaded)).toBe(false);
    const patch = rulePatchOf(loaded, stored);
    expect(patch).toEqual({});

    const on = editForm(loaded, 'caseSensitive', true);
    expect(isDirty(on)).toBe(true);
    const back = editForm(on, 'caseSensitive', false);
    expect(isDirty(back)).toBe(false);
    expect(rulePatchOf(back, stored)).toEqual({});

    // And when it IS turned on, the key appears; when it is off, it does not.
    const sent = rulePatchOf(on, stored).matcher as RuleMatcher | undefined;
    expect(sent).toBeDefined();
    expect(sent).toEqual({
      kind: 'keyword',
      keywords: ['rent'],
      mode: 'any',
      caseSensitive: true,
    });
    expect('wholeWord' in (sent as object)).toBe(false);
  });

  it('a stored caseSensitive:false is preserved rather than normalised away', () => {
    // The mirror of the row above, and the reason `valueOf` cannot simply
    // drop the key: a rule the CLI wrote with an explicit `false` must not
    // be silently rewritten by a GUI that merely opened it.
    const stored = rule({
      matcher: {
        kind: 'keyword',
        keywords: ['rent'],
        mode: 'any',
        caseSensitive: false,
      },
    });
    const loaded = formOf(valueOf(stored));
    expect(loaded.draft.caseSensitive).toBe(false);
    expect(rulePatchOf(loaded, stored)).toEqual({});
  });

  it('the patch carries only what moved, and a save of nothing is an empty body', () => {
    const stored = rule();
    const f = editForm(formOf(valueOf(stored)), 'name', 'RENT INQUIRY');
    expect(rulePatchOf(f, stored)).toEqual({ name: 'RENT INQUIRY' });
    expect('matcher' in rulePatchOf(f, stored)).toBe(false);
    expect('adapterId' in rulePatchOf(f, stored)).toBe(false);
  });

  it('there is no key on a rule patch that could approve, send or arm anything', () => {
    // INV-2 as a shape claim: the whole editing surface is a rules PATCH,
    // and a rules PATCH cannot name a draft. Nothing here has a `draftId`.
    const stored = rule();
    const every: RuleFormValue = {
      ...valueOf(stored),
      name: 'x',
      respond: 'AUTO',
      kind: 'regex',
      pattern: 'rent',
      allowGroupDrafts: true,
      draftTtlMinutes: 45,
      outsideWindow: 'ignore',
      scheduleId: 'sched-1',
      adapterId: 'agent-two',
    };
    const keys = Object.keys(
      rulePatchOf({ saved: valueOf(stored), draft: every }, stored),
    ).sort();
    expect(keys).toEqual([
      'adapterId',
      'allowGroupDrafts',
      'draftTtlMinutes',
      'matcher',
      'name',
      'outsideWindow',
      'respondMode',
      'scheduleId',
    ]);
    // `draftTtlMinutes` is the one key whose NAME contains "draft"; it is a
    // number of minutes, not an id, and the point stands for every other.
    for (const k of keys) expect(k).not.toMatch(/draftid|approv|send/i);
  });

  it('a theme matcher is not expressible, so the form refuses rather than 400s', () => {
    // Closed delta #8: THEME is offered, disabled, and refuses to arm. There
    // is no theme endpoint in v1 and the daemon answers 400
    // `theme-unavailable-v1`. A GUI that let the operator press SAVE into
    // that is a GUI that teaches its operator to ignore errors.
    const v: RuleFormValue = {
      ...NEW_RULE,
      name: 'n',
      adapterId: 'a',
      kind: 'theme',
    };
    expect(matcherOf(v)).toBeNull();
    expect(ruleInputOf(v)).toBeNull();
    expect(formProblems(v).map((p) => p.path)).toContain('matcher');
  });

  it('SAVE is refused while the matcher is invalid, per field', () => {
    const noName = formProblems({ ...NEW_RULE, name: '  ', adapterId: 'a' });
    expect(noName.map((p) => p.path)).toContain('name');
    const noKeywords = formProblems({
      ...NEW_RULE,
      name: 'n',
      adapterId: 'a',
      keywords: [],
    });
    expect(noKeywords.map((p) => p.path)).toContain('matcher.keywords');
    const noAdapter = formProblems({ ...NEW_RULE, name: 'n', adapterId: '' });
    expect(noAdapter.map((p) => p.path)).toContain('adapterId');
    const ok = formProblems({
      ...NEW_RULE,
      name: 'n',
      adapterId: 'a',
      keywords: ['rent'],
    });
    expect(ok).toEqual([]);
  });

  it('regex validity is the compilation the DAEMON will do, unicode flag and all', () => {
    // `matchRegex` compiles `new RegExp(pattern, 'u')`. Validating without
    // the flag would pass patterns the daemon then refuses — and `(?i)` is
    // the one everybody writes, because the wireframe writes it.
    expect(regexProblem('\\b(rent|lease|deposit)\\b')).toBeNull();
    expect(regexProblem('(rent|lease(')).not.toBeNull();
    expect(regexProblem('(?i)rent')).not.toBeNull();
    // Empty is not an error the compiler raises; it is one the form does.
    expect(regexProblem('')).toBeNull();
    expect(
      formProblems({
        ...NEW_RULE,
        name: 'n',
        adapterId: 'a',
        kind: 'regex',
      }).map((p) => p.path),
    ).toContain('matcher.pattern');
  });

  it('outsideWindow queue is never produced by this form (F-69)', () => {
    const input = ruleInputOf({ ...NEW_RULE, name: 'n', adapterId: 'a' });
    expect(input?.outsideWindow).toBe('draft-only');
    // The offered set is a constant the screen renders from, so the third
    // §1.4.1 mode is absent from the SOURCE and not merely from a branch.
    expect(OUTSIDE_WINDOW_CHOICES).toEqual(['draft-only', 'ignore']);
    expect(OUTSIDE_WINDOW_CHOICES).not.toContain('queue');
  });
});

/* ── the dangerous combo ──────────────────────────────────────────────── */

describe('s8 Sc10: auto in scope is a typed confirm, except where it is narrow', () => {
  it('AUTO with anything but a contact matcher asks; a contact matcher does not', () => {
    expect(AUTO_EVERYONE).toBe('AUTO EVERYONE');
    const auto = {
      ...NEW_RULE,
      name: 'n',
      adapterId: 'a',
      respond: 'AUTO' as const,
    };
    expect(needsTypedConfirm({ ...auto, kind: 'keyword' })).toBe(true);
    expect(needsTypedConfirm({ ...auto, kind: 'regex' })).toBe(true);
    expect(needsTypedConfirm({ ...auto, kind: 'theme' })).toBe(true);
    expect(needsTypedConfirm({ ...auto, kind: 'contact' })).toBe(false);
    // DRAFT-ONLY and OFF never ask, whatever the matcher: neither can
    // auto-reply to anybody.
    for (const respond of ['DRAFT-ONLY', 'OFF'] as const)
      for (const kind of ['keyword', 'regex', 'contact', 'theme'] as const)
        expect(needsTypedConfirm({ ...auto, respond, kind })).toBe(false);
  });
});

/* ── the narrowing-only ladder ────────────────────────────────────────── */

describe('s8 Sc10: the screen renders the ladder, not the rule`s own claim', () => {
  it('a rule set to AUTO under a global draft-only reads DRAFT-ONLY, narrowed by GLOBAL', () => {
    const l = scopeLadder({ global: 'draft-only', rule: 'auto', policies: 3 });
    expect(l.effective).toBe('draft-only');
    expect(l.narrowedBy).toEqual(['GLOBAL']);
    expect(l.rungs.map((r) => r.label)).toEqual(['GLOBAL', 'RULE', 'CONTACT']);
    expect(l.rungs[0]?.value).toBe('DRAFT-ONLY');
    expect(l.rungs[1]?.value).toBe('AUTO');
  });

  it('a rule set to DRAFT-ONLY under a global auto reads DRAFT-ONLY, narrowed by RULE', () => {
    const l = scopeLadder({ global: 'auto', rule: 'draft-only', policies: 3 });
    expect(l.effective).toBe('draft-only');
    expect(l.narrowedBy).toEqual(['RULE']);
  });

  it('AUTO is only ever reached when NOTHING above narrows it', () => {
    const l = scopeLadder({ global: 'auto', rule: 'auto', policies: 3 });
    expect(l.effective).toBe('auto');
    expect(l.narrowedBy).toEqual([]);
    // The exhaustive claim: over every pair, the effective mode is auto in
    // exactly one case. There is no combination in which a rule widens.
    const modes = ['draft-only', 'auto'] as const;
    const autos = modes
      .flatMap((global) =>
        modes.map(
          (r) => scopeLadder({ global, rule: r, policies: 1 }).effective,
        ),
      )
      .filter((m) => m === 'auto');
    expect(autos).toHaveLength(1);
  });

  it('the CONTACT rung is per-handle and always says it can only narrow', () => {
    const l = scopeLadder({ global: 'auto', rule: 'auto', policies: 4 });
    expect(l.rungs[2]?.value).toBe('PER CONTACT');
    expect(l.note).toContain('NARROW');
    expect(l.note).not.toContain('WIDEN');
  });

  it('with no contact policy at all, the screen says the rule drafts for nobody', () => {
    // §2.4.3 step 3: `contact === null` denies outright. This is the fact
    // S7 Sc13 discovered by having four adapters draft nothing.
    const none = scopeLadder({ global: 'auto', rule: 'auto', policies: 0 });
    expect(none.drafts).toBe(false);
    expect(none.deny).toBe(
      'NO CONTACT HAS A POLICY · THIS RULE DRAFTS FOR NOBODY',
    );
    const some = scopeLadder({ global: 'auto', rule: 'auto', policies: 4 });
    expect(some.drafts).toBe(true);
    expect(some.deny).toBe(
      '4 CONTACTS HAVE A POLICY · EVERY OTHER HANDLE IS DENIED',
    );
    expect(
      scopeLadder({ global: 'auto', rule: 'auto', policies: 1 }).deny,
    ).toContain('1 CONTACT HAS A POLICY');
  });
});

/* ── N today ──────────────────────────────────────────────────────────── */

describe('s8 Sc10: N today counts rule.matched since LOCAL midnight', () => {
  const at = (
    y: number,
    m: number,
    d: number,
    h: number,
    min: number,
  ): string => new Date(y, m - 1, d, h, min, 0, 0).toISOString();

  function row(
    seq: number,
    when: string,
    event: Record<string, unknown>,
  ): AuditRowPayload {
    return {
      seq,
      at: when,
      eventJson: JSON.stringify(event),
      actorJson: JSON.stringify({ kind: 'system', reason: 'auto-respond' }),
      prevHash: '',
      hash: '',
    };
  }

  const NOW = at(2026, 3, 2, 14, 30);
  const page: readonly AuditRowPayload[] = [
    // Yesterday at 23:59 LOCAL. Counting from a UTC midnight, or from a
    // rolling 24 hours, includes this row and the number on the list stops
    // meaning "today".
    row(1, at(2026, 3, 1, 23, 59), {
      type: 'rule.matched',
      guid: 'g-0',
      ruleId: 'r-1',
      adapterId: 'agent-one',
      ruleName: 'rent inquiry',
    }),
    row(2, at(2026, 3, 2, 0, 1), {
      type: 'rule.matched',
      guid: 'g-1',
      ruleId: 'r-1',
      adapterId: 'agent-one',
      ruleName: 'rent inquiry',
    }),
    row(3, at(2026, 3, 2, 9, 0), {
      type: 'rule.matched',
      guid: 'g-2',
      ruleId: 'r-1',
      adapterId: 'agent-one',
      ruleName: 'rent inquiry',
    }),
    row(4, at(2026, 3, 2, 9, 5), {
      type: 'rule.matched',
      guid: 'g-3',
      ruleId: 'r-2',
      adapterId: 'agent-one',
      ruleName: 'catch all',
    }),
    // Not a match: a draft the rule produced is a different event, and
    // counting both would double every row on the list.
    row(5, at(2026, 3, 2, 9, 6), {
      type: 'draft.created',
      draftId: 'd-1',
      ruleId: 'r-1',
    }),
  ];

  it('counts per rule, from local midnight, and only rule.matched', () => {
    const today = rulesToday(page, NOW);
    expect(today.get('r-1')).toBe(2);
    expect(today.get('r-2')).toBe(1);
    expect(today.get('r-3')).toBeUndefined();
  });

  it('a rule with no rows today reads 0 today rather than blank', () => {
    const today = rulesToday(page, NOW);
    expect(today.get('r-9') ?? 0).toBe(0);
  });

  it('a malformed audit row is skipped, not thrown on', () => {
    const broken: AuditRowPayload = {
      seq: 9,
      at: NOW,
      eventJson: 'not json',
      actorJson: '{}',
      prevHash: '',
      hash: '',
    };
    expect(rulesToday([...page, broken], NOW).get('r-1')).toBe(2);
  });
});

/* ── the dry run ──────────────────────────────────────────────────────── */

describe('s8 Sc10: the dry run highlights what the daemon would have matched', () => {
  const rows: readonly DryRunRow[] = [
    {
      guid: 'g-1',
      handle: HANDLE,
      textPreview: 'is the rent due friday?',
      matched: true,
    },
    { guid: 'g-2', handle: OTHER, textPreview: 'lunch?', matched: false },
    {
      guid: 'g-3',
      handle: OTHER,
      textPreview: 'RENT cheque posted',
      matched: true,
    },
  ];
  const kw = (over: Partial<RuleFormValue> = {}): RuleFormValue => ({
    ...NEW_RULE,
    name: 'n',
    adapterId: 'a',
    keywords: ['rent'],
    ...over,
  });

  it('marks the keyword span, case-folded exactly as matchers.ts folds it', () => {
    const view = dryRunView(rows, kw(), new Map());
    expect(view[0]?.preview.filter((s) => s.hit).map((s) => s.text)).toEqual([
      'rent',
    ]);
    expect(view[2]?.preview.filter((s) => s.hit).map((s) => s.text)).toEqual([
      'RENT',
    ]);
    // Reassembling the spans is the preview, unchanged. A highlighter that
    // drops or duplicates a character is rewriting the operator's message.
    for (const [i, r] of view.entries())
      expect(r.preview.map((s) => s.text).join('')).toBe(rows[i]?.textPreview);
  });

  it('respects caseSensitive and wholeWord the way the matcher does', () => {
    const cased = dryRunView(rows, kw({ caseSensitive: true }), new Map());
    expect(cased[2]?.preview.some((s) => s.hit)).toBe(false);
    // …and says so, rather than showing a MATCH with nothing marked.
    expect(cased[2]?.hitVisible).toBe(false);
    const whole = dryRunView(
      [
        {
          guid: 'g-4',
          handle: OTHER,
          textPreview: 'rented already',
          matched: false,
        },
      ],
      kw({ wholeWord: true }),
      new Map(),
    );
    expect(whole[0]?.preview.some((s) => s.hit)).toBe(false);
  });

  it('never invents a match the daemon did not report', () => {
    // The daemon is the authority on `matched`. The highlight is a display
    // of WHERE, and a row the daemon called unmatched gets no marks even if
    // the client-side mirror thinks it found one.
    const lying = dryRunView(
      [{ guid: 'g-5', handle: OTHER, textPreview: 'rent', matched: false }],
      kw(),
      new Map(),
    );
    expect(lying[0]?.matched).toBe(false);
    expect(lying[0]?.preview.some((s) => s.hit)).toBe(false);
  });

  it('a regex rule highlights with the same unicode compilation, or not at all', () => {
    const view = dryRunView(
      rows,
      kw({ kind: 'regex', pattern: 'r[ea]nt' }),
      new Map(),
    );
    expect(view[0]?.preview.filter((s) => s.hit).map((s) => s.text)).toEqual([
      'rent',
    ]);
    const broken = dryRunView(
      rows,
      kw({ kind: 'regex', pattern: '(' }),
      new Map(),
    );
    expect(broken[0]?.preview.some((s) => s.hit)).toBe(false);
    expect(broken[0]?.hitVisible).toBe(false);
  });

  it('a contact matcher marks nothing in the body, because it matched the HANDLE', () => {
    const view = dryRunView(
      rows,
      kw({ kind: 'contact', handles: [HANDLE] }),
      new Map(),
    );
    expect(view[0]?.preview.some((s) => s.hit)).toBe(false);
    expect(view[0]?.hitVisible).toBe(false);
  });

  it('shadowing is a join over guid against the higher-priority rules own replay', () => {
    // `DryRunRow` carries no rule ids, and `POST /v1/rules/:id/test` scores
    // ONE rule, so `matchedRuleIds` can never name a rule other than the one
    // asked about. The honest derivation is N replays joined on guid, in the
    // evaluator's own order: priority ascending, id ascending.
    const shadows = shadowMap([
      {
        name: 'urgent',
        priority: 10,
        id: 'r-0',
        rows: [
          { guid: 'g-1', handle: HANDLE, textPreview: '', matched: true },
          { guid: 'g-3', handle: OTHER, textPreview: '', matched: false },
        ],
      },
      {
        name: 'greeting',
        priority: 20,
        id: 'r-x',
        rows: [{ guid: 'g-1', handle: HANDLE, textPreview: '', matched: true }],
      },
    ]);
    // First match wins, top to bottom: the LOWEST priority number shadows.
    expect(shadows.get('g-1')).toBe('URGENT');
    expect(shadows.get('g-3')).toBeUndefined();

    const view = dryRunView(rows, kw(), shadows);
    expect(view[0]?.shadowedBy).toBe('URGENT');
    expect(view[0]?.wins).toBe(false);
    expect(view[2]?.shadowedBy).toBeNull();
    expect(view[2]?.wins).toBe(true);
    // An unmatched row is neither shadowed nor a winner.
    expect(view[1]?.wins).toBe(false);
    expect(view[1]?.shadowedBy).toBeNull();
  });
});

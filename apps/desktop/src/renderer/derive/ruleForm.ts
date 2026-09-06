/**
 * A `Rule` as a form, and a form as a PATCH.
 *
 * The editor's whole write surface is this file: everything the operator can
 * change becomes `Partial<RuleInput>` and nothing else. That is INV-2 as a
 * shape claim — a rules body has no field that could authorise a send, no
 * draft id, and no approval — and it is why the screen can be as interactive
 * as it likes without becoming a second path to the send port.
 *
 * Three decisions worth reading before changing anything here:
 *
 *  - **OFF is the `enabled` column, not a third respond mode.** §2.3 has two
 *    (`draft-only`, `auto`) and the wireframe has three choices. A form that
 *    invented `respondMode: 'off'` would 400 on a value the enum does not
 *    have, so OFF is `enabled: false` with the mode left where it was.
 *  - **A new rule sends its defaults rather than omitting them.** §2.3's DDL
 *    default for `draftTtlMinutes` is 240 and the wireframe's new rule says
 *    30. A create body that omitted the field would store 240 behind a form
 *    that displayed 30.
 *  - **An absent optional key is not `false`.** `{kind:'keyword', …}` and
 *    the same matcher with `caseSensitive: false` behave identically at the
 *    matcher and are different JSON. Loading, toggling on, toggling off and
 *    saving must leave the stored row byte-identical, so {@link rulePatchOf}
 *    compares the derived matcher against the STORED one as well as against
 *    the baseline.
 *
 * THEME is offered and refuses to arm. There is no theme endpoint in v1 and
 * the daemon answers `400 theme-unavailable-v1`; a GUI that let SAVE reach
 * that is a GUI teaching its operator to ignore errors.
 */
import type { RuleInput, RuleMatcher, RulePayload } from '@wemessage/client';
import { deepEqual, optional, type FieldIssue, type Form } from './form.js';

/** The three choices the wireframe offers, which are two columns. */
export type RespondChoice = 'DRAFT-ONLY' | 'AUTO' | 'OFF';

/** The matcher kinds this form can express. Combinators are not among them. */
export type MatcherKind = 'keyword' | 'regex' | 'contact' | 'theme';

/**
 * F-69: `queue` is defined in §1.4.1 #7 and refused by the daemon in v1.
 *
 * A CONSTANT the screen renders from, so the missing third mode is absent
 * from the source rather than from a branch somebody could re-enable.
 */
export const OUTSIDE_WINDOW_CHOICES = ['draft-only', 'ignore'] as const;

export type OutsideWindowChoice = (typeof OUTSIDE_WINDOW_CHOICES)[number];

/** The sentence §1.7 requires typed before a rule may answer for a person. */
export const AUTO_EVERYONE = 'AUTO EVERYONE';

/**
 * Every field of the form, flat.
 *
 * Flat rather than nested-by-matcher-kind because the operator switches
 * kinds and back: a keyword list that vanished when they looked at REGEX and
 * came back empty would be an editor that eats work. Only the fields the
 * ACTIVE kind names reach the wire.
 */
export interface RuleFormValue {
  readonly name: string;
  readonly kind: MatcherKind;
  readonly keywords: readonly string[];
  readonly mode: 'any' | 'all';
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly pattern: string;
  readonly handles: readonly string[];
  readonly adapterId: string;
  readonly respond: RespondChoice;
  readonly scheduleId: string | null;
  readonly outsideWindow: OutsideWindowChoice;
  readonly allowGroupDrafts: boolean;
  readonly draftTtlMinutes: number;
  /**
   * A stored matcher this form cannot express, kept verbatim.
   *
   * `all-of` and `any-of` are real `RuleMatcher` members that the CLI can
   * write and this editor has no controls for. Dropping them on load would
   * mean opening such a rule and pressing SAVE silently replaced its matcher
   * with an empty keyword list. Instead the matcher is held here, the form
   * refuses to derive one, and every OTHER field stays editable.
   */
  readonly unsupported: RuleMatcher | null;
}

/** The wireframe's new rule: the safe one, until somebody says otherwise. */
export const NEW_RULE: RuleFormValue = {
  name: '',
  kind: 'keyword',
  keywords: [],
  mode: 'any',
  caseSensitive: false,
  wholeWord: false,
  pattern: '',
  handles: [],
  adapterId: '',
  respond: 'DRAFT-ONLY',
  scheduleId: null,
  outsideWindow: 'draft-only',
  allowGroupDrafts: false,
  draftTtlMinutes: 30,
  unsupported: null,
};

/**
 * The compilation the DAEMON will do, unicode flag and all.
 *
 * `matchRegex` builds `new RegExp(pattern, 'u')`. Validating without the flag
 * accepts patterns the daemon then refuses — and `(?i)rent` is the one
 * everybody writes, because the wireframe writes it.
 *
 * Returns the compiler's own message, not a paraphrase.
 */
export function regexProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, 'u');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The matcher this form describes, or `null` when it does not describe one. */
export function matcherOf(value: RuleFormValue): RuleMatcher | null {
  if (value.unsupported !== null) return null;
  switch (value.kind) {
    case 'keyword':
      return {
        kind: 'keyword',
        keywords: [...value.keywords],
        mode: value.mode,
        // Omitted rather than `false`: see the header. The daemon's schema
        // has these optional and the absent form is the common one.
        ...optional('caseSensitive', value.caseSensitive ? true : undefined),
        ...optional('wholeWord', value.wholeWord ? true : undefined),
      };
    case 'regex':
      return { kind: 'regex', pattern: value.pattern };
    case 'contact':
      return { kind: 'contact', handles: [...value.handles] };
    case 'theme':
      return null;
  }
}

/** The stored row, as a form value. */
export function valueOf(rule: RulePayload): RuleFormValue {
  const base: RuleFormValue = {
    ...NEW_RULE,
    name: rule.name,
    adapterId: rule.adapterId,
    scheduleId: rule.scheduleId,
    allowGroupDrafts: rule.allowGroupDrafts,
    draftTtlMinutes: rule.draftTtlMinutes,
    respond: !rule.enabled
      ? 'OFF'
      : rule.respondMode === 'auto'
        ? 'AUTO'
        : 'DRAFT-ONLY',
    // `queue` is storable by the CLI on a rule written before F-69's guard.
    // It is not offerable, so it reads as the safe neighbour and a SAVE that
    // touches nothing else leaves it alone (the patch compares to STORED).
    outsideWindow: rule.outsideWindow === 'ignore' ? 'ignore' : 'draft-only',
  };
  const matcher = rule.matcher;
  switch (matcher.kind) {
    case 'keyword':
      return {
        ...base,
        kind: 'keyword',
        keywords: [...matcher.keywords],
        mode: matcher.mode,
        caseSensitive: matcher.caseSensitive === true,
        wholeWord: matcher.wholeWord === true,
      };
    case 'regex':
      return { ...base, kind: 'regex', pattern: matcher.pattern };
    case 'contact':
      return { ...base, kind: 'contact', handles: [...matcher.handles] };
    case 'theme':
      return { ...base, kind: 'theme' };
    default:
      return { ...base, unsupported: matcher };
  }
}

/** Every field a create body carries, derived. `null` when the matcher is not
 * expressible, because a create with no matcher is a 400 waiting to happen. */
export function ruleInputOf(value: RuleFormValue): RuleInput | null {
  const matcher = matcherOf(value);
  if (matcher === null) return null;
  return {
    name: value.name,
    matcher,
    adapterId: value.adapterId,
    // OFF keeps the mode it had; it is the ENABLED column that turns it off.
    respondMode: value.respond === 'AUTO' ? 'auto' : 'draft-only',
    scheduleId: value.scheduleId,
    outsideWindow: value.outsideWindow,
    allowGroupDrafts: value.allowGroupDrafts,
    draftTtlMinutes: value.draftTtlMinutes,
    enabled: value.respond !== 'OFF',
  };
}

/** The same fields, as a bag that can be compared key by key. */
function fieldsOf(value: RuleFormValue): Record<string, unknown> {
  const input = ruleInputOf(value);
  if (input !== null) return { ...input };
  // No matcher: every other field is still editable and still comparable.
  const partial = ruleInputOf({ ...value, unsupported: null, kind: 'regex' });
  const rest = { ...(partial as RuleInput) } as Record<string, unknown>;
  delete rest['matcher'];
  return rest;
}

/** The stored row's own values, in the same shape. */
function storedFieldsOf(rule: RulePayload): Record<string, unknown> {
  return {
    name: rule.name,
    matcher: rule.matcher,
    adapterId: rule.adapterId,
    respondMode: rule.respondMode,
    scheduleId: rule.scheduleId,
    outsideWindow: rule.outsideWindow,
    allowGroupDrafts: rule.allowGroupDrafts,
    draftTtlMinutes: rule.draftTtlMinutes,
    enabled: rule.enabled,
  };
}

/**
 * The PATCH body: what moved, and only what moved.
 *
 * A key is carried when it differs from the BASELINE *and* from the row the
 * daemon has. The second half is the EOPT guarantee: toggling `caseSensitive`
 * on and off again leaves the derived matcher equal to the stored one, so
 * nothing is sent — where a baseline-only comparison would send a matcher
 * that had lost an explicitly-stored `false`.
 */
export function rulePatchOf(
  form: Form<RuleFormValue>,
  stored: RulePayload,
): Partial<RuleInput> {
  const draft = fieldsOf(form.draft);
  const saved = fieldsOf(form.saved);
  const server = storedFieldsOf(stored);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (deepEqual(value, saved[key])) continue;
    if (deepEqual(value, server[key])) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Why SAVE is refused, per field, in the renderer.
 *
 * Deliberately NOT exhaustive: `draftTtlMinutes` has a daemon-side bound and
 * no entry here, so the path from a real zod `issues[].path` to a real field
 * label is exercised by a real 400 rather than by a fixture. Everything this
 * DOES check is something the daemon cannot phrase usefully — an empty
 * keyword list is `invalid-matcher-shape`, which names no field at all.
 */
export function formProblems(value: RuleFormValue): readonly FieldIssue[] {
  const out: FieldIssue[] = [];
  if (value.name.trim().length === 0)
    out.push({ path: 'name', message: 'A NAME IS REQUIRED' });
  if (value.adapterId.length === 0)
    out.push({ path: 'adapterId', message: 'AN AGENT IS REQUIRED' });
  if (value.unsupported !== null)
    out.push({
      path: 'matcher',
      message: 'THIS MATCHER WAS WRITTEN ELSEWHERE AND IS NOT EDITABLE HERE',
    });
  else if (value.kind === 'theme')
    out.push({
      path: 'matcher',
      message: 'THEME MATCHING HAS NO ENDPOINT IN V1',
    });
  else if (value.kind === 'keyword' && value.keywords.length === 0)
    out.push({ path: 'matcher.keywords', message: 'AT LEAST ONE KEYWORD' });
  else if (value.kind === 'contact' && value.handles.length === 0)
    out.push({ path: 'matcher.handles', message: 'AT LEAST ONE HANDLE' });
  else if (value.kind === 'regex') {
    const problem =
      value.pattern.length === 0
        ? 'A PATTERN IS REQUIRED'
        : regexProblem(value.pattern);
    if (problem !== null)
      out.push({ path: 'matcher.pattern', message: problem });
  }
  return out;
}

/**
 * Whether SAVE has to be typed out first (§1.7).
 *
 * AUTO with anything but a contact list is an auto-reply to everybody the
 * matcher reaches, now and for every message that arrives later. A contact
 * matcher is its own scope — the operator enumerated the people — so it is
 * the one combination that does not ask.
 */
export function needsTypedConfirm(value: RuleFormValue): boolean {
  return value.respond === 'AUTO' && value.kind !== 'contact';
}

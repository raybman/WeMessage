/**
 * §2.4.3's three-scope ladder, rendered as what it is: narrowing-only.
 *
 * The rules screen does NOT show `rule.respondMode` as the answer to "what
 * will this rule do". Under a global `draft-only`, a rule whose own column
 * says `auto` will draft, and a field that reads AUTO there is a lie the
 * operator will believe until the first thing they expected to be answered
 * is not. So the screen renders the LADDER — every rung, its own value, and
 * which rung took the decision away.
 *
 * The type has no way to spell "widened". `effective` is computed by taking
 * the narrowest rung, `narrowedBy` names every rung that narrowed, and there
 * is no branch in which a lower rung raises a higher one. That is the §2.4.3
 * invariant expressed as a shape rather than as a comment.
 *
 * The fourth fact is the one S7 Sc13 learned the hard way: with NO
 * `ContactPolicy` row the gate denies outright, so a rule that is valid,
 * enabled, in-window and unclamped still drafts for nobody. The ladder
 * carries that sentence and the count behind it, because "why is nothing
 * happening" is the question this screen exists to answer.
 */
import type { SettingsPayload } from '@wemessage/client';

/** §2.3's two modes. There is no third, and `OFF` is the enabled column. */
export type RespondMode = 'draft-only' | 'auto';

export type RungLabel = 'GLOBAL' | 'RULE' | 'CONTACT';

export interface ScopeRung {
  readonly label: RungLabel;
  /** Uppercase, because it is displayed. `PER CONTACT` on the last rung:
   *  the contact scope has no single value, it has one per handle. */
  readonly value: string;
}

export interface ScopeInput {
  readonly global: RespondMode;
  readonly rule: RespondMode;
  /** How many handles have a `ContactPolicy` row at all. */
  readonly policies: number;
}

export interface ScopeLadder {
  readonly effective: RespondMode;
  /** Every rung strictly narrower than the widest mode, top to bottom. */
  readonly narrowedBy: readonly ('GLOBAL' | 'RULE')[];
  readonly rungs: readonly ScopeRung[];
  readonly note: string;
  /** False when no handle has a policy: §2.4.3 step 3 denies outright. */
  readonly drafts: boolean;
  readonly deny: string;
}

/** The key `POST /v1/toggles/global-mode` owns, read from `GET /v1/settings`.
 *
 * It lives HERE rather than in the store binding on purpose: the binding is
 * under a root whose arch guard bans the substring this key contains, in
 * identifiers and in string literals alike, so that no file next to the
 * approval verbs can name the port. A derive module is not next to them. */
const GLOBAL_MODE_KEY = 'send.globalMode';

/**
 * The shipped global mode, from the settings payload.
 *
 * Falls back to `draft-only`, which is §2.4.3's own default and the safe
 * side: a screen that guessed `auto` while the daemon was in `draft-only`
 * would promise auto-replies that never come.
 */
export function globalModeOf(settings: SettingsPayload): RespondMode {
  const entry = settings[GLOBAL_MODE_KEY];
  return entry !== undefined && entry.value === 'auto' ? 'auto' : 'draft-only';
}

function label(mode: RespondMode): string {
  return mode === 'auto' ? 'AUTO' : 'DRAFT-ONLY';
}

/** The ladder for one rule, as the detail pane renders it. */
export function scopeLadder(input: ScopeInput): ScopeLadder {
  const narrowedBy: ('GLOBAL' | 'RULE')[] = [];
  if (input.global === 'draft-only') narrowedBy.push('GLOBAL');
  if (input.rule === 'draft-only') narrowedBy.push('RULE');
  const effective: RespondMode =
    narrowedBy.length === 0 ? 'auto' : 'draft-only';
  const drafts = input.policies > 0;
  const deny = drafts
    ? `${String(input.policies)} ${
        input.policies === 1 ? 'CONTACT HAS' : 'CONTACTS HAVE'
      } A POLICY · EVERY OTHER HANDLE IS DENIED`
    : 'NO CONTACT HAS A POLICY · THIS RULE DRAFTS FOR NOBODY';
  return {
    effective,
    narrowedBy,
    rungs: [
      { label: 'GLOBAL', value: label(input.global) },
      { label: 'RULE', value: label(input.rule) },
      { label: 'CONTACT', value: 'PER CONTACT' },
    ],
    note: 'EACH RUNG CAN ONLY NARROW THE ONE ABOVE IT',
    drafts,
    deny,
  };
}

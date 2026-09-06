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
import type { ContactMode, SettingsPayload } from '@wemessage/client';

/** §2.3's two modes. There is no third, and `OFF` is the enabled column. */
export type RespondMode = 'draft-only' | 'auto';

export type RungLabel = 'GLOBAL' | 'RULE' | 'CONTACT';

/**
 * The one sentence both ladders end on, and the reason it is a constant.
 *
 * s8 Sc12 renders §2.4.3 a second time, per CONTACT rather than per rule.
 * Two spellings of "narrowing only" is two chances to disagree about the
 * invariant in front of the operator, so the note is minted once here and
 * an arch row pins the ladder to this file. The rules screen and the people
 * screen are the same claim about the same gate, drawn twice.
 */
export const LADDER_NOTE = 'EACH RUNG CAN ONLY NARROW THE ONE ABOVE IT';

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
    note: LADDER_NOTE,
    drafts,
    deny,
  };
}

/* ── the same ladder, one contact at a time (s8 Sc12) ─────────────────── */

/**
 * What the CONTACT rung can be.
 *
 * Four values, not three: `null` is "no `ContactPolicy` row exists", and the
 * whole point of the people screen is that it is not a neutral fourth state.
 * `evaluateGate` reads `ctx.contact === null || ctx.contact.mode === 'deny'`
 * in ONE branch, so absence and DENY reach the same refusal.
 */
export interface ContactScopeInput {
  readonly global: RespondMode;
  readonly contact: ContactMode | null;
}

/** The resolved mode for a handle. `deny` is a fourth outcome, not a mode. */
export type EffectiveMode = ContactMode;

export interface ContactLadder {
  readonly effective: EffectiveMode;
  /** Every rung strictly narrower than AUTO, top to bottom. */
  readonly narrowedBy: readonly RungLabel[];
  readonly rungs: readonly ScopeRung[];
  readonly note: string;
  /** What this resolves to, and who it binds, in one line of prose. */
  readonly sentence: string;
}

/** How much autonomy each value grants. Lower is stricter. */
const RANK: Readonly<Record<EffectiveMode, number>> = {
  deny: 0,
  'draft-only': 1,
  auto: 2,
};

function narrowest(a: EffectiveMode, b: EffectiveMode): EffectiveMode {
  return RANK[a] <= RANK[b] ? a : b;
}

/** The word this screen prints for a stored value. */
function contactLabel(mode: ContactMode | null): string {
  if (mode === null) return 'NO POLICY';
  return mode.toUpperCase();
}

/**
 * §2.4.3, resolved for ONE handle, and provably narrowing-only.
 *
 * There is no branch below in which a lower rung raises a higher one:
 * `narrowest` is the only combinator, `RANK` is total over the three values,
 * and a missing row enters as `deny`. A unit row proves the property
 * exhaustively over every (global, contact) pair rather than trusting the
 * reading — which matters, because "grant AUTO to this person" is exactly
 * what an operator believes the segmented control does.
 *
 * The RULE rung is `PER RULE` rather than a value. A contact policy is not
 * about any one rule, and §1.7 evaluates rules first-match-wins per message,
 * so there is no single number to print there. What the screen CAN say
 * honestly is the direction: whatever rule matches may narrow this further
 * and can never widen it.
 *
 * The sentence carries three facts the ordering alone does not:
 *
 *  - the deny is SCOPED. The gate guards it with `ctx.rule !== null ||
 *    agentOrigin`, and `dispatchApproved` re-gates a human-minted draft with
 *    a null rule and no agent origin — so a person can still approve for a
 *    handle with no row. A screen that said DENIED full stop would be
 *    over-claiming, and an operator who believed it would stop approving.
 *  - a stored DENY and a missing row are the same refusal, WORDED
 *    differently, because the audit trail can answer "did anybody ever
 *    decide about this person" and the screen must not throw that away.
 *  - editing this re-decides NOTHING already in the queue. INV-2: the only
 *    path to the send port is `dispatchApproved` with a validated approval,
 *    and a policy write is not one.
 */
export function contactLadder(input: ContactScopeInput): ContactLadder {
  const stored: EffectiveMode = input.contact ?? 'deny';
  const effective = narrowest(input.global, stored);
  const narrowedBy: RungLabel[] = [];
  if (input.global !== 'auto') narrowedBy.push('GLOBAL');
  if (stored !== 'auto') narrowedBy.push('CONTACT');
  const head =
    input.contact === null
      ? 'NO POLICY ROW · A RULE OR AN AGENT IS DENIED OUTRIGHT · A HUMAN CAN STILL APPROVE A DRAFT FOR THIS HANDLE'
      : input.contact === 'deny'
        ? 'DENY IS STORED · A RULE OR AN AGENT IS DENIED OUTRIGHT · A HUMAN CAN STILL APPROVE A DRAFT FOR THIS HANDLE'
        : effective === 'auto'
          ? 'EVERY RUNG ABOVE SAYS AUTO, SO THIS HANDLE MAY BE ANSWERED WITHOUT A HUMAN'
          : `${contactLabel(input.contact)} IS STORED HERE AND ${
              input.global === 'auto' ? 'CONTACT' : 'GLOBAL'
            } RESOLVES IT TO AT MOST DRAFT-ONLY`;
  return {
    effective,
    narrowedBy,
    rungs: [
      { label: 'GLOBAL', value: label(input.global) },
      { label: 'RULE', value: 'PER RULE' },
      { label: 'CONTACT', value: contactLabel(input.contact) },
    ],
    note: LADDER_NOTE,
    sentence: `${head} · ANY RULE MAY NARROW THIS FURTHER AND NONE MAY WIDEN IT · NOTHING ALREADY IN THE QUEUE IS RE-DECIDED`,
  };
}

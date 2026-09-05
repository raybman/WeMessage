/**
 * s7-execution Scenario 9 — verification tier as a VALUE.
 *
 * F-91 and C-9 require the Luna adapter to say `NOT LIVE-VERIFIED` in its
 * README's first paragraph. A sentence in a README is the correct thing to
 * show a stranger and the wrong thing to rely on: it is one edit away from
 * being false, and nothing anywhere would notice. Prose rots silently, and a
 * rotted honesty claim is worse than none, because by then it has been
 * believed.
 *
 * So the status lives here instead, as a value with three properties:
 *
 *  1. **The tier is a discriminated union, and the honest tier is the cheap
 *     one.** `conformance-only` carries `liveEvidence: null` and a reason.
 *     `live-verified` cannot be constructed at all without naming a spec file
 *     that ran against the real system and the date it ran. There is no
 *     `tier: 'live-verified'` that typechecks on its own.
 *  2. **The README sentence is DERIVED from the value.** `verificationBanner`
 *     renders the paragraph, and a test asserts the README contains that
 *     string byte for byte. Editing the README to claim more, or editing the
 *     value to claim more, both fail the same row. Upgrading the claim
 *     therefore requires the evidence, not the keystrokes.
 *  3. **A live claim is checked against the world.** `liveVerificationOffenders`
 *     rejects a `live-verified` value whose evidence does not exist, is not a
 *     spec the suite runs, or is not tracked by git — evidence a stranger
 *     cannot read is not evidence. It takes an injected probe rather than
 *     touching the filesystem itself, because an adapter that shells out to
 *     `git` at import time is a worse thing than the problem it solves.
 *
 * The shape is deliberately adapter-agnostic. OpenClaw (Sc 10) has the same
 * problem — its plugin API was read from docs only (F-92) — and should be
 * able to declare against this type rather than inventing a second vocabulary
 * for the same admission.
 */

/** What a badge is allowed to mean. Exactly two values, and no default. */
export type VerificationTier = 'live-verified' | 'conformance-only';

interface VerificationBase {
  /** The adapter this is a claim about. */
  readonly adapter: string;
  /** ISO date the claim was last examined by a human. */
  readonly declaredOn: string;
}

/**
 * The expensive tier. Both extra fields are required, so the compiler is the
 * first thing that asks "against what, and when?".
 */
export interface LiveVerified extends VerificationBase {
  readonly tier: 'live-verified';
  /**
   * Package-relative path of the spec that exercised the REAL system. Not a
   * URL, not a description, not a person's word: a file another engineer can
   * open and run.
   */
  readonly liveEvidence: string;
  readonly verifiedOn: string;
}

/** The honest tier when there is nothing to point at. */
export interface ConformanceOnly extends VerificationBase {
  readonly tier: 'conformance-only';
  /** Structurally null: there is no evidence, and no field to hide one in. */
  readonly liveEvidence: null;
  /** Why not, in words that go straight into the README. */
  readonly blockedBy: string;
}

export type AdapterVerification = LiveVerified | ConformanceOnly;

/**
 * The filesystem questions `liveVerificationOffenders` needs answered.
 * Injected so this module stays free of `node:` I/O: the checker is pure, the
 * caller owns the side effects, and the test can ask the same questions about
 * synthetic values without planting files.
 */
export interface EvidenceProbe {
  /** The file's contents, or `null` if this package-relative path is absent. */
  read(rel: string): string | null;
  /** Is it tracked by git — i.e. can a stranger who clones this see it? */
  tracked(rel: string): boolean;
}

/**
 * The literal a live-evidence spec must carry.
 *
 * Nothing static can prove a run against a real system happened; a checker
 * that claimed to would be the same species of lie it exists to prevent. What
 * this buys is narrower and worth having: the claim cannot be made by
 * pointing at the conformance suite, which is the shortcut anyone in a hurry
 * would take, because the conformance suite talks to a mock and does not
 * carry this marker. Adding it is a deliberate, greppable edit to a committed
 * file with a reviewer's name on it, which is the ceiling for this kind of
 * guarantee.
 */
export const LIVE_EVIDENCE_MARKER = '@live' + '-evidence';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Everything wrong with a verification claim, or `[]`.
 *
 * A `conformance-only` claim is nearly free to make: it must name a date and
 * a reason, and that is all, because claiming LESS than you can prove costs
 * a reader nothing. A `live-verified` claim is expensive on purpose. The
 * asymmetry is the mechanism.
 */
export function liveVerificationOffenders(
  v: AdapterVerification,
  probe: EvidenceProbe,
): string[] {
  const out: string[] = [];
  if (!ISO_DATE.test(v.declaredOn))
    out.push(`declaredOn is not an ISO date: ${v.declaredOn}`);

  if (v.tier === 'conformance-only') {
    if (v.blockedBy.trim() === '')
      out.push('conformance-only must say what it is blocked by');
    return out;
  }

  const spec = v.liveEvidence;
  if (!ISO_DATE.test(v.verifiedOn))
    out.push(`verifiedOn is not an ISO date: ${v.verifiedOn}`);
  // Every question is asked, not just the first that fails: a caller fixing a
  // claim should see all of it at once rather than one round-trip at a time.
  if (!/^test\/.+\.spec\.ts$/.test(spec))
    out.push(
      `liveEvidence is not a *.spec.ts the vitest project runs: ${spec}`,
    );
  const body = probe.read(spec);
  if (body === null) out.push(`liveEvidence does not exist: ${spec}`);
  else {
    if (!probe.tracked(spec))
      out.push(`liveEvidence is not tracked by git: ${spec}`);
    if (!body.includes(LIVE_EVIDENCE_MARKER))
      out.push(
        `liveEvidence does not declare ${LIVE_EVIDENCE_MARKER}: ${spec}`,
      );
  }
  return out;
}

/**
 * The README's first paragraph, rendered from the value.
 *
 * Every word a reader sees about this adapter's status is produced here, so
 * "the docs" and "the code" are the same sentence and cannot disagree.
 */
export function verificationBanner(v: AdapterVerification): string {
  if (v.tier === 'conformance-only')
    return (
      `**NOT LIVE-VERIFIED.** The \`${v.adapter}\` adapter passes the WeMessage ` +
      `adapter conformance kit and nothing beyond it: as of ${v.declaredOn} it ` +
      `has never exchanged a byte with the system it is named after, because ` +
      `${v.blockedBy}.`
    );
  return (
    `**LIVE-VERIFIED.** The \`${v.adapter}\` adapter was run against the real ` +
    `system it is named after on ${v.verifiedOn}; the evidence is ` +
    `\`${v.liveEvidence}\`, which is committed and runs in this repo's suite.`
  );
}

/**
 * The shipped claim.
 *
 * `conformance-only`, and it will stay that way until someone points this
 * adapter at an actual Luna. There is no Luna on this machine and none
 * reachable from it; the daemon is loopback-only and Luna runs elsewhere, so
 * even a willing operator would have to build a bridge first (plan §3.6.3).
 * Nothing in S7 pretends otherwise.
 */
export const LUNA_VERIFICATION: AdapterVerification = {
  adapter: 'luna',
  declaredOn: '2026-09-05',
  tier: 'conformance-only',
  liveEvidence: null,
  blockedBy: 'live verification is pending a Luna vanguard install',
};

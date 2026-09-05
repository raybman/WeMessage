/**
 * s7-execution Scenario 11 — the verification tier, applied to a document.
 *
 * Sc 9 built this mechanism for Luna: a claim about how sure we are, held
 * as a VALUE with a checker, rather than as a sentence in a README that
 * ages badly and that nothing enforces. Sc 10 restated it for OpenClaw
 * rather than importing Luna's, because `adapters-thin-clients` forbids an
 * adapter from reaching into a sibling. This is the THIRD statement of the
 * same three properties, and that fact should be uncomfortable, so it is
 * written down here rather than left for a reviewer to notice.
 *
 * WHY IT IS RESTATED AGAIN, AND WHAT SHOULD HAPPEN NEXT.
 *
 * Restated here because the alternative available today is worse. This
 * file lives in `packages/cli/test`, and the two existing copies live in
 * `packages/adapters/{luna,openclaw}/src`. Importing either would be a
 * test in one package depending on the PRODUCTION source of another for a
 * type, which is the coupling `nobody-imports-daemon` and
 * `adapters-thin-clients` were written to prevent in the direction that
 * matters; and the version this file needs is not quite theirs anyway,
 * because the subject is a document read by a model rather than an adapter
 * that speaks a wire.
 *
 * The right home is `@wemessage/adapter-testkit`. Its entire subject is
 * "what did we actually prove about an adapter", `adapters-thin-clients`
 * already lists it among the four things an adapter may import, and F-94
 * puts it in the publish set, so a promotion costs no new rule and no new
 * dependency edge. The recommendation is: promote the type, the
 * `EvidenceProbe`, the offender checker and the banner renderer into the
 * testkit, and reduce all three current copies to re-exports plus their
 * own shipped values.
 *
 * That is NOT done in this scenario, deliberately. It edits the production
 * source of two adapters and moves code that Sc 9 and Sc 10 both proved
 * teeth against, so it would put a refactor of two other slices inside a
 * checkpoint whose subject is skill documents. It is a scenario of its own
 * and it should be one. Until then this file is copy three, and this
 * paragraph is the receipt.
 *
 * ── s7 Sc 12: the recommendation above was taken up, examined, and NOT
 * carried out. This paragraph is the adjudication, written here so the next
 * builder does not re-derive it from scratch.
 *
 * Sc 12 owns the publish set and was therefore the natural home for the
 * promotion, so it was tried. The stop condition Sc 11 anticipated, "it
 * costs a new dependency-cruiser rule", did NOT fire: a value import of
 * `@wemessage/adapter-testkit` planted in `packages/adapters/luna/src/
 * index.ts` cruises clean, because `adapters-thin-clients` already permits
 * that edge. A different and worse problem fired instead.
 *
 *  1. LUNA'S PRODUCTION SOURCE imports `verificationBanner`, not just its
 *     spec. Promoting the renderer therefore makes `ws` and
 *     `node:child_process` reachable at runtime from a shipped Luna
 *     adapter, because the testkit spawns processes and opens sockets for a
 *     living. Today the testkit is a devDependency of luna and openclaw;
 *     the promotion would make the conformance kit a runtime dependency of
 *     two production adapters, to share a discriminated union and one pure
 *     function.
 *  2. THE GUARD THAT WOULD NOT NOTICE. `luna.spec.ts` row 15 asserts that
 *     nothing in that package has ever contacted a Luna, and it does so by
 *     reading the SOURCE TEXT of three files for `node:child_process`,
 *     `fetch(` and a `wss://` host. It would keep passing after the
 *     promotion while its claim quietly became false, since the reach would
 *     arrive through an import rather than a literal. A proven property
 *     that stays green while ceasing to be true is the most expensive kind
 *     of regression, and it is the whole reason this was not done.
 *  3. THE THIRD COPY CANNOT COLLAPSE ANYWAY. This file is about a DOCUMENT:
 *     its subject key is `subject`, not `adapter`, and its banner sentence
 *     differs. The genuinely shared surface is the type plus one pure
 *     function, roughly thirty lines. Two of the three copies could become
 *     re-exports; this one could not.
 *  4. THE GUARD THAT MATTERS IS INDIFFERENT. `test/arch.spec.ts` reads the
 *     BUILT verification values out of each adapter's `dist/index.js` and
 *     cross-checks them against README prose, per adapter. That ledger does
 *     not care how many times the type is spelled; it cares that no shipped
 *     value and no shipped paragraph claims more than was proven. Three
 *     spellings of a type are a tidiness cost. A false negative in row 15
 *     would be a correctness cost.
 *
 * A cheaper mitigation exists and was rejected as scope: a `./verification`
 * subpath export on the testkit, carrying only the type and the pure
 * function, with no transitive reach into `ws` or `node:child_process`.
 * That is a real option for whoever revisits this, and it is the only shape
 * of the promotion that survives point 1. It was not taken here because
 * this scenario is publishing that package for the very first time and
 * adding a second public entry point to a package on the day it becomes
 * public is a decision that deserves its own diff.
 */

/** What a badge is allowed to mean. Exactly two values, and no default. */
export type SkillVerificationTier = 'live-verified' | 'conformance-only';

interface SkillVerificationBase {
  /** The host this is a claim about: the directory under `skills/`. */
  readonly subject: string;
  /** ISO date the claim was last examined by a human. */
  readonly declaredOn: string;
}

/** The expensive tier: something really followed the document. */
export interface SkillLiveVerified extends SkillVerificationBase {
  readonly tier: 'live-verified';
  /** A tracked spec another engineer can open and run. */
  readonly liveEvidence: string;
  readonly verifiedOn: string;
}

/** The honest tier when there is nothing to point at. */
export interface SkillConformanceOnly extends SkillVerificationBase {
  readonly tier: 'conformance-only';
  /** Structurally null: no evidence, and no field to hide one in. */
  readonly liveEvidence: null;
  /** Why not, in words that go straight into the document. */
  readonly blockedBy: string;
}

export type SkillVerification = SkillLiveVerified | SkillConformanceOnly;

/** The filesystem questions the checker needs answered, injected. */
export interface SkillEvidenceProbe {
  read(rel: string): string | null;
  tracked(rel: string): boolean;
}

/**
 * The literal a live-evidence spec must carry. Split across a
 * concatenation so that this file does not read as evidence to a grep.
 */
export const LIVE_EVIDENCE_MARKER = '@live' + '-evidence';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPEC_PATH = /(^|\/)test\/.+\.spec\.ts$/;

/**
 * Everything wrong with a claim, or `[]`. Sc 9's asymmetry, unchanged:
 * claiming less than you can prove is free, claiming more costs a file.
 */
export function skillVerificationOffenders(
  v: SkillVerification,
  probe: SkillEvidenceProbe,
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
  if (!SPEC_PATH.test(spec))
    out.push(`liveEvidence is not a *.spec.ts the suite runs: ${spec}`);
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
 * The paragraph the document opens with, rendered from the value.
 *
 * Same discipline as Sc 9's `verificationBanner`: every word a reader sees
 * about status is produced here, so the document and the code are the same
 * sentence and cannot disagree.
 */
export function skillVerificationBanner(v: SkillVerification): string {
  if (v.tier === 'conformance-only')
    return (
      `**NOT LIVE-VERIFIED.** The policy in this document is enforced by a ` +
      `scripted dry-run, not by a model: as of ${v.declaredOn} no ` +
      `${v.subject} host has been driven through this file end to end, ` +
      `because ${v.blockedBy}.`
    );
  return (
    `**LIVE-VERIFIED.** A real ${v.subject} host was driven through this ` +
    `document on ${v.verifiedOn}; the evidence is \`${v.liveEvidence}\`, ` +
    `which is committed and runs in this repo's suite.`
  );
}

/**
 * The shipped claim for `skills/claude/SKILL.md`.
 *
 * Everything the document says about the CLI is checked against the real
 * CLI, and the policy it declares is obeyed by a scripted agent against a
 * real daemon. What has never happened is a language model reading the
 * file and choosing what to do with it, and no test in a repository can
 * make that happen deterministically. F-93 is explicit that the scripted
 * run is the gate and the human run is a manual step, so the tier is
 * `conformance-only` and this sentence is the reason.
 */
export const CLAUDE_SKILL_VERIFICATION: SkillVerification = {
  subject: 'Claude',
  declaredOn: '2026-09-05',
  tier: 'conformance-only',
  liveEvidence: null,
  blockedBy:
    'a model choosing what to do with a document is not a deterministic ' +
    'thing a test suite can assert, so the gate is a scripted agent that ' +
    'obeys the same three blocks (packages/daemon/test/' +
    'skill-dryrun-live.spec.ts)',
};

/**
 * The shipped claim for `skills/hermes/SKILL.md`.
 *
 * Weaker than Claude's, and for a reason worth naming: Hermes is a sibling
 * agent on the operator's machine, and S7 was never permitted to start it,
 * probe it or modify anything belonging to it. The HTTP adapter was built
 * against a fake in Sc 8 and the plugin against the published wire in
 * Sc 7; neither ever met the real thing, and neither has this document.
 */
export const HERMES_SKILL_VERIFICATION: SkillVerification = {
  subject: 'Hermes',
  declaredOn: '2026-09-05',
  tier: 'conformance-only',
  liveEvidence: null,
  blockedBy:
    'Hermes is a sibling agent this slice was not permitted to start, ' +
    'probe or modify, so every claim here about how a Hermes host uses ' +
    'the CLI is inference from its published surface',
};

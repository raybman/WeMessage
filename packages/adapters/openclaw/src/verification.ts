/**
 * s7-execution Scenario 10 — the honesty, carried as a value.
 *
 * Sc 9 built this mechanism for Luna and said in its own header that OpenClaw
 * "should be able to declare against this type rather than inventing a second
 * vocabulary for the same admission". This file takes it up on that: the
 * shape below is Sc 9's, restated rather than imported.
 *
 * Restated, because an adapter importing another adapter's module would be
 * exactly the coupling `.dependency-cruiser.cjs`'s `adapters-thin-clients`
 * rule exists to forbid — an adapter may reach for `@wemessage/protocol` and
 * `@wemessage/client` and nothing else, least of all a sibling. Promoting the
 * type into the protocol package was the other option and is worse: the
 * protocol is what a stranger implements a wire against, and "how sure are we
 * about this adapter" is not part of a wire. The duplication is thirty lines
 * of type, it is checked by the repo-wide ledger row in `test/arch.spec.ts`
 * that reads every adapter's built `dist/index.js`, and it buys a package
 * boundary that a reviewer can see.
 *
 * The three properties are Sc 9's, and they matter more here than they did
 * there. Luna's admission was "we have never talked to a Luna". OpenClaw's is
 * larger: F-92 records that OpenClaw's plugin API was READ FROM DOCS ONLY,
 * and this scenario never started, probed or modified anything belonging to
 * that sibling agent. So there are two separate claims to keep honest — the
 * tier (what we ran the adapter against) and the ledger (which statements
 * about OpenClaw are facts we can cite and which are guesses we made). The
 * README prints both, derived from here.
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
 * Split across a concatenation so that this file, and every file that
 * mentions the marker in prose, does not itself read as evidence to a grep.
 */
export const LIVE_EVIDENCE_MARKER = '@live' + '-evidence';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Everything wrong with a verification claim, or `[]`.
 *
 * Claiming LESS than you can prove is nearly free; claiming more is
 * expensive on purpose. The asymmetry is the mechanism.
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
 * "the docs" and "the code" are the same sentence and cannot disagree. The
 * wording is byte-for-byte Sc 9's, which is the point: two adapters with the
 * same status say it identically, and a reader who has learned to recognise
 * the sentence does not have to re-read it.
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
 * `conformance-only`, and the reason is a policy rather than a missing
 * install: OpenClaw is a sibling agent on the operator's machine, and this
 * scenario was not permitted to start it, probe it or modify anything
 * belonging to it. Read-only inspection of its documentation for API shape
 * was the entire budget, and the ledger below records what that bought.
 */
export const OPENCLAW_VERIFICATION: AdapterVerification = {
  adapter: 'openclaw',
  declaredOn: '2026-09-05',
  tier: 'conformance-only',
  liveEvidence: null,
  blockedBy:
    'OpenClaw is a sibling agent that this work was not permitted to start, ' +
    'probe or modify, so its plugin API was read from docs only',
};

/* ── the claims ledger ─────────────────────────────────────────────────── */

/**
 * A statement this package makes that a reader could take for a fact, and
 * whether it actually is one.
 *
 * The tier above answers "did you run it?". This answers the question a tier
 * cannot: "which of the things you wrote down did you check?". A shim
 * documented against an API nobody in this repo has called will contain both
 * kinds of sentence, and the failure mode worth spending a type on is a guess
 * that reads like a citation.
 */
export interface VerifiedClaim {
  readonly claim: string;
  readonly basis: 'verified';
  /**
   * A path in THIS repo that a reader can open. Never a URL and never a
   * person's recollection: a claim whose source is off this machine is a
   * claim nobody reviewing this can check.
   */
  readonly source: string;
}

/** A guess. Structurally sourceless, and it says how it gets settled. */
export interface AssumedClaim {
  readonly claim: string;
  readonly basis: 'assumed';
  readonly source: null;
  /** The cheapest thing that would turn this into a fact. */
  readonly settledBy: string;
}

export type OpenClawClaim = VerifiedClaim | AssumedClaim;

/**
 * Where the guesses are republished for a reader of the public docs.
 *
 * Its own heading, with the verified half under a heading of its own just
 * above it, so that "everything below this line is a guess" is true of a
 * whole section rather than of some bullets inside one. A row asserts exactly
 * that: every assumed claim appears after this heading and no verified one
 * does, which a mixed section could not satisfy.
 */
export const OPENCLAW_ASSUMPTION_HEADING = '## What is a guess';

/**
 * Every load-bearing statement, classified.
 *
 * The verified half is verified because a spec in this repo exercises it, not
 * because it sounds right. The assumed half is every sentence that describes
 * OpenClaw itself — because nothing in this tree has ever called OpenClaw,
 * and a shim is a generic NDJSON shim precisely so that being wrong about all
 * of it costs a manifest file rather than a rewrite.
 */
export const OPENCLAW_CLAIMS: readonly OpenClawClaim[] = [
  {
    claim:
      'the NDJSON child protocol this package speaks is defined by this repo, ' +
      'not by OpenClaw',
    basis: 'verified',
    source: 'packages/adapters/openclaw/src/index.ts',
  },
  {
    claim:
      'a child line cannot become a gateway frame the shim did not already ' +
      'have an open request for',
    basis: 'verified',
    source: 'packages/adapters/openclaw/test/shim.spec.ts',
  },
  {
    claim:
      'the gateway credential is never written to the child environment or ' +
      'to its argv',
    basis: 'verified',
    source: 'packages/adapters/openclaw/test/shim.spec.ts',
  },
  {
    claim:
      'the shim passes the same six conformance checks as every other adapter ' +
      'in this repo, driving the committed example child',
    basis: 'verified',
    source: 'packages/adapter-testkit/examples/stdio-child.mjs',
  },
  {
    claim:
      'OpenClaw discovers a plugin from a manifest named `openclaw.plugin.json`',
    basis: 'assumed',
    source: null,
    settledBy:
      'installing one manifest against a real OpenClaw and watching it load',
  },
  {
    claim:
      'that manifest can name an executable which OpenClaw runs as a child process',
    basis: 'assumed',
    source: null,
    settledBy: 'the same one-manifest install',
  },
  {
    claim:
      'OpenClaw talks to such a child over its stdin and stdout rather than a socket',
    basis: 'assumed',
    source: null,
    settledBy:
      'reading which file descriptors the child process is handed while it runs',
  },
  {
    claim: 'nothing in OpenClaw needs to change for it to drive this shim',
    basis: 'assumed',
    source: null,
    settledBy: 'one end-to-end run with an operator present',
  },
];

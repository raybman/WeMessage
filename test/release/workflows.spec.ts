/**
 * s9 Scenario 9: the release workflow becomes real, and its shape is a test.
 *
 * WHAT IS ACTUALLY BEING PROVED HERE. Not "does the release work": that needs
 * a tag push, a macOS runner and about twenty minutes, and it is observable
 * exactly once per release. What is proved here is the SHAPE of the file, and
 * the shape is where release workflows fail. The three failures this guards
 * against have all happened to other projects, publicly:
 *
 *   - A step that references a signing secret WITHOUT a lane guard. On a
 *     fork, or on this repo before anyone buys a certificate, that secret is
 *     the empty string, `base64 -d` writes an empty file, and `security
 *     import` fails. The release stops at the import step and the ad-hoc
 *     artefact that would have been perfectly usable is never built. Row 4
 *     walks every step and refuses this.
 *   - An unpinned `uses:`. `actions/checkout@v4` is a MUTABLE tag. Whoever
 *     controls it controls a job holding `contents: write` on this repo.
 *     Row 8 requires a 40-hex commit SHA with the human-readable version in
 *     a trailing comment, on every third-party action in every workflow.
 *   - A keychain left on the runner, or a `.p12` left in the workspace.
 *     Row 6 requires the import to be undone by a step that runs on failure
 *     as well as on success.
 *
 * THE LANE SPLIT IS THE POINT OF THIS SLICE. This project ships UNSIGNED by
 * choice: it is open source, and requiring a 99 USD Apple membership to build
 * it would put a toll booth in front of a repo whose whole purpose is that
 * people can read it, run it, and change it. So the workflow has two lanes
 * selected by one step, and the ad-hoc lane is the one that is expected to
 * run. The signed lane is written, guarded, and dormant until a credential
 * exists (F-136). Every assertion below treats the ad-hoc lane as the
 * default and the signed lane as the exception, which is the opposite of how
 * these files are usually written and is the reason row 4 exists.
 *
 * WHY `secrets.X != ''` NEVER APPEARS IN A STEP `if:`. GitHub's context
 * availability table does not list `secrets` among the contexts readable
 * from `jobs.<id>.steps[*].if`. A condition written that way is either a
 * syntax error at parse time or, worse, silently falsy, which would disable
 * the very step it was meant to enable. Everything conditional here is
 * routed through the outputs of the one `id: signing` step, which CAN read
 * secrets because it reads them in `run:`, not in `if:`.
 *
 * PLATFORM. Runs everywhere. Nothing here spawns a runner; the file is data.
 * Row 12 shells out to `actionlint` only when it is on PATH, and is skipped
 * and counted otherwise.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const RELEASE = '.github/workflows/release.yml';
const CI_MACOS = '.github/workflows/ci-macos.yml';
const CI_LINUX = '.github/workflows/ci-linux.yml';
const CI_PYTHON = '.github/workflows/ci-python.yml';
const WORKFLOWS = [RELEASE, CI_MACOS, CI_LINUX] as const;

/**
 * Rows 8, 11 and 12 are SWEEPS, and a sweep that skips a file is a sweep with
 * a hole in it. `ci-python.yml` runs third-party actions on every push
 * exactly like the other three, so a mutable tag there is the same
 * supply-chain exposure with the same blast radius. It is deliberately NOT in
 * `WORKFLOWS`: the shape rows ask about a gate job and a release lane and
 * that file has neither, so widening `WORKFLOWS` would have meant loosening
 * those rows to tolerate it.
 */
const SWEPT = [...WORKFLOWS, CI_PYTHON] as const;

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
}

interface Job {
  readonly 'runs-on'?: string;
  readonly needs?: readonly string[] | string;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly name?: string;
  readonly permissions?: unknown;
  readonly jobs?: Readonly<Record<string, Job>>;
}

const load = (rel: string): Workflow => parse(read(rel)) as Workflow;

/**
 * Read the `on:` key without tripping over the oldest trap in this format.
 *
 * Under the YAML 1.1 schema the bare token `on` is a BOOLEAN, so a 1.1
 * parser hands back the key `true` and every `wf.on` lookup in every
 * workflow linter ever written silently returns undefined. The `yaml`
 * package defaults to the 1.2 core schema, where `on` stays a string, but a
 * test that depends on which schema its parser happens to default to is a
 * test that breaks on a minor bump. So both keys are accepted, and the
 * helper throws rather than returning undefined, because "the workflow has
 * no triggers" and "the parser renamed the key" must not look the same.
 */
const triggersOf = (wf: Workflow): unknown => {
  const bag = wf as unknown as Record<string, unknown>;
  const found = bag['on'] ?? bag['true'];
  if (found === undefined)
    throw new Error('workflow has no `on:` key under either spelling');
  return found;
};

const jobsOf = (wf: Workflow): Readonly<Record<string, Job>> => wf.jobs ?? {};

const stepsOf = (wf: Workflow, job: string): readonly Step[] =>
  jobsOf(wf)[job]?.steps ?? [];

/** Every `run:` string in a job, in order. */
const runsOf = (wf: Workflow, job: string): string[] =>
  stepsOf(wf, job)
    .map((s) => s.run)
    .filter((r): r is string => typeof r === 'string');

/**
 * `[a, b, c]` appears inside `haystack` in that relative order, gaps allowed.
 *
 * Deliberately weaker than array equality, and the weakness is the feature:
 * Scenario 11 inserts a second licence step into this job, and a row that
 * pinned the exact sequence would have to be edited by the slice it is
 * supposed to be guarding. What matters is the ORDER (nothing runs before
 * the build, the suite runs after the linters), and the count is pinned
 * separately, so nothing can be inserted without a row noticing.
 */
const isSubsequence = (
  needles: readonly string[],
  hay: readonly string[],
): boolean => {
  let i = 0;
  for (const h of hay) if (i < needles.length && h === needles[i]) i += 1;
  return i === needles.length;
};

/** Everything a step could hide an expression in, as one searchable string. */
const stepText = (s: Step): string => JSON.stringify(s);

const SIGNED_LANE = "steps.signing.outputs.mode == 'release'";
const ADHOC_LANE = "steps.signing.outputs.mode == 'adhoc'";

/** The closed set of secrets this repository's release is allowed to name. */
const ALLOWED_SECRETS = [
  'APPLE_DEVELOPER_ID_P12_BASE64',
  'APPLE_DEVELOPER_ID_P12_PASSWORD',
  'APPLE_TEAM_ID',
  'ASC_ISSUER_ID',
  'ASC_KEY_ID',
  'ASC_KEY_P8_BASE64',
  'GITHUB_TOKEN',
  'TAP_PUSH_TOKEN',
] as const;

const secretsNamedIn = (text: string): string[] =>
  [
    ...new Set([...text.matchAll(/secrets\.(\w+)/g)].map((m) => m[1] ?? '')),
  ].sort();

const hasTool = (tool: string): boolean => {
  try {
    execFileSync('command', ['-v', tool], {
      shell: '/bin/sh',
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

describe('s9 Sc9: the release workflow is real, and its shape is asserted', () => {
  /* ── row 1: the trigger, and the stub is gone ───────────────────────── */

  it('row 1: triggers on a v-tag and on a dispatch that must name one', () => {
    expect(triggersOf(load(RELEASE))).toEqual({
      push: { tags: ['v*'] },
      workflow_dispatch: {
        inputs: { tag: { required: true, type: 'string' } },
      },
    });
    // The S1 stub was a single `echo`. If that string survives, the file was
    // extended rather than replaced and there are two release paths.
    expect(read(RELEASE)).not.toContain('is S9');
    expect(read(RELEASE)).not.toContain('placeholder');
  });

  /* ── row 2: two jobs, one dependency, one permission ────────────────── */

  it('row 2: exactly two jobs, and `contents: write` is the whole grant', () => {
    const wf = load(RELEASE);
    expect(Object.keys(jobsOf(wf)).sort()).toEqual([
      'build-test',
      'pack-macos',
    ]);
    expect(jobsOf(wf)['pack-macos']?.needs).toEqual(['build-test']);
    expect(jobsOf(wf)['pack-macos']?.['runs-on']).toBe('macos-15');
    expect(jobsOf(wf)['build-test']?.['runs-on']).toBe('ubuntu-24.04');
    // Deep equality, not a `toContain`. `id-token: write` is how a workflow
    // grows the ability to mint an OIDC credential against a cloud account,
    // and `packages: write` is how it grows the ability to publish. Neither
    // is needed to attach a DMG to a release, so neither is granted, and a
    // subset check would not have said so.
    expect(wf.permissions).toEqual({ contents: 'write' });
  });

  /* ── row 3: the gate job runs the whole gate, in order ──────────────── */

  it('row 3: build-test runs the five-command gate, suite last', () => {
    const wf = load(RELEASE);
    // Linux has no window server, so the suite runs under `xvfb-run -a`.
    // That is the one legitimate difference between this job and the macOS
    // lane, and it is normalised away here rather than asserted around, so
    // that the rest of the row can talk about commands instead of wrappers.
    const runs = runsOf(wf, 'build-test').map((r) =>
      r.replace('xvfb-run -a pnpm test', 'pnpm test'),
    );
    expect(
      isSubsequence(
        [
          'pnpm install --frozen-lockfile',
          'pnpm build',
          'pnpm lint',
          'pnpm dep:check',
          'pnpm licenses:check',
          'pnpm test',
        ],
        runs,
      ),
    ).toBe(true);
    // The failure this catches: a release job that builds and lints and then
    // ships, with the suite moved to "CI already ran it on the PR". The tag
    // is cut from a commit, not from a pull request, so it is entirely
    // possible for the tagged tree to have never had the suite run on it.
    expect(runs[runs.length - 1]).toBe('pnpm test');
    // And the job is not allowed to grow steps nobody asserted.
    expect(stepsOf(wf, 'build-test')).toHaveLength(11);
  });

  /* ── row 4: every step declares its lane ────────────────────────────── */

  it('row 4: no step touches a signing secret without a lane guard', () => {
    const wf = load(RELEASE);
    const offenders: string[] = [];
    for (const step of stepsOf(wf, 'pack-macos')) {
      const label =
        step.id ?? step.name ?? step.uses ?? step.run ?? '(unnamed)';
      const text = stepText(step);
      // The one step allowed to read a signing secret without a guard is the
      // step that COMPUTES the guard. It reads `APPLE_TEAM_ID` to decide the
      // lane and emits an output; that is the whole mechanism.
      if (step.id === 'signing') continue;
      const touchesSigningSecret = /secrets\.(APPLE|ASC)_/.test(text);
      if (touchesSigningSecret && !(step.if ?? '').includes(SIGNED_LANE))
        offenders.push(
          `${label} references a signing secret without ${SIGNED_LANE}`,
        );
      const producesUnsigned =
        text.includes('UNSIGNED') || text.includes('pack:adhoc');
      if (producesUnsigned && !(step.if ?? '').includes(ADHOC_LANE))
        offenders.push(
          `${label} produces an UNSIGNED artefact without ${ADHOC_LANE}`,
        );
    }
    expect(offenders).toEqual([]);
    // …and the walk is not vacuous: both lanes exist and both were seen.
    const ifs = stepsOf(wf, 'pack-macos').map((s) => s.if ?? '');
    expect(ifs.some((c) => c.includes(SIGNED_LANE))).toBe(true);
    expect(ifs.some((c) => c.includes(ADHOC_LANE))).toBe(true);
  });

  it('row 4b: the lane is decided by one step, and it is an output', () => {
    const wf = load(RELEASE);
    const signing = stepsOf(wf, 'pack-macos').find((s) => s.id === 'signing');
    expect(signing).toBeDefined();
    const body = signing?.run ?? '';
    expect(body).toContain('GITHUB_OUTPUT');
    expect(body).toContain('mode=release');
    expect(body).toContain('mode=adhoc');
    // No `if:` anywhere in the file may read the `secrets` context directly.
    // See the header: that context is not available there, so a condition
    // written that way fails open or fails closed depending on the runner,
    // and either is worse than the explicit output.
    for (const step of stepsOf(wf, 'pack-macos'))
      expect([step.id ?? step.run, /secrets\./.test(step.if ?? '')]).toEqual([
        step.id ?? step.run,
        false,
      ]);
  });

  /* ── row 5: the secret set is closed, and none of it is echoed ──────── */

  it('row 5: names exactly the eight allowed secrets, and leaks none', () => {
    // The PARSED workflow, not the raw file. The header of THIS spec
    // documents the `if: secrets.X != ''` trap by writing the trap out, and a
    // reader sweeping raw text counts that comment's `X` as a ninth secret.
    // Admitting `X` to ALLOWED_SECRETS would have been the wrong repair
    // twice: it widens the closed set this row exists to keep closed, and it
    // would afterwards pass a real secret genuinely named `X`. So the reader
    // narrows instead, to the secrets this workflow REFERENCES rather than
    // the ones its prose mentions.
    const text = JSON.stringify(load(RELEASE));
    expect(secretsNamedIn(text)).toEqual([...ALLOWED_SECRETS]);
    // A secret interpolated into an `echo` is a secret in the log. Actions
    // masks values it was given as secrets, but only exactly: base64 of a
    // secret, or a secret with a newline appended, is not masked.
    for (const run of Object.keys(jobsOf(load(RELEASE))).flatMap((j) =>
      runsOf(load(RELEASE), j),
    ))
      for (const line of run.split('\n'))
        if (/secrets\./.test(line))
          expect([line.trim(), /^\s*echo\b/.test(line)]).toEqual([
            line.trim(),
            false,
          ]);
  });

  it('row 5b: no third-party action is handed a secret except the uploader', () => {
    for (const [job, def] of Object.entries(jobsOf(load(RELEASE))))
      for (const step of def.steps ?? []) {
        if (step.uses === undefined) continue;
        const withText = JSON.stringify(step.with ?? {});
        const named = secretsNamedIn(withText);
        if (named.length === 0) continue;
        // The release uploader legitimately needs a token, and only a token.
        expect([job, step.uses, named]).toEqual([
          job,
          step.uses,
          ['GITHUB_TOKEN'],
        ]);
      }
  });

  /* ── row 6: the keychain is created, scoped, and always destroyed ───── */

  it('row 5c: the CI lanes name no secret at all, in any job', () => {
    /*
     * The release lane is allowed eight secrets and row 5 pins exactly which
     * eight. The CI lanes are allowed NONE, and until this row the only
     * thing that said so was a text sweep in `test/arch.spec.ts`.
     *
     * That gap was measured rather than guessed. The Sc9 teeth mutation
     * TN-secret-in-adhoc-lane put a `CSC_LINK` env pointing at a signing
     * secret into the ad-hoc pack step. The text sweep caught it; this file
     * passed, which is one reader short for the property the whole unsigned
     * lane rests on: it asks the repository for nothing the repository does
     * not have. A lane that carries no credential cannot leak one, and
     * cannot quietly start depending on one that a fork will not have.
     *
     * Read from the PARSED document, so a secret in a `with:` map, a job
     * `env:` or a step `env:` is the same fact as one on a `run:` line.
     */
    for (const rel of [CI_MACOS, CI_LINUX, CI_PYTHON])
      expect(secretsNamedIn(JSON.stringify(load(rel))), rel).toEqual([]);
    // Non-vacuity, against the exact mutation and at the exact depth it
    // used. An empty expectation is only worth having if the reader that
    // produced it can be shown to see the thing it is denying.
    const mutated = JSON.stringify({
      jobs: {
        'pack-adhoc': {
          steps: [
            {
              run: 'pnpm pack:adhoc',
              env: { CSC_LINK: '${{ secrets.APPLE_CERT_P12 }}' },
            },
          ],
        },
      },
    });
    expect(secretsNamedIn(mutated)).toEqual(['APPLE_CERT_P12']);
  });

  it('row 6: the signed lane cleans up its own credentials on every path', () => {
    const wf = load(RELEASE);
    const steps = stepsOf(wf, 'pack-macos');
    const importer = steps.find(
      (s) => (s.id ?? '') === 'import-signing-certificate',
    );
    expect(importer).toBeDefined();
    const body = importer?.run ?? '';
    expect(body).toContain('openssl rand');
    expect(body).toContain('security set-keychain-settings -lut 21600');
    expect(body).toContain('build.keychain-db');
    // Key material is written under RUNNER_TEMP, which the runner wipes, and
    // never under the workspace, which `actions/upload-artifact` can see.
    expect(body).toContain('RUNNER_TEMP');
    expect(importer?.if ?? '').toContain(SIGNED_LANE);

    const cleanup = steps.find(
      (s) => (s.id ?? '') === 'cleanup-signing-credentials',
    );
    expect(cleanup).toBeDefined();
    // `always()` and not `if: success()`, and not omitted. The failure this
    // catches is the interesting one: the release fails DURING notarization,
    // the job ends, and a keychain holding a Developer ID private key stays
    // on a runner that will be recycled to somebody else's job.
    expect(cleanup?.if ?? '').toContain('always()');
    const cleanupBody = cleanup?.run ?? '';
    expect(cleanupBody).toContain('security delete-keychain');
    expect(cleanupBody).toContain('rm -f');
  });

  /* ── row 7: the release itself ──────────────────────────────────────── */

  it('row 7: the release is a draft, prereleased by version not by lane', () => {
    const wf = load(RELEASE);
    const rel = stepsOf(wf, 'pack-macos').find((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release@'),
    );
    expect(rel).toBeDefined();
    const w = (rel?.with ?? {}) as Record<string, unknown>;
    // A draft, because the last human check on a release is a human looking
    // at it. Nothing here publishes on its own.
    expect(w['draft']).toBe(true);
    // Keyed on the TAG, not on `steps.signing.outputs.mode`. The lane version
    // of this assertion was green and wrong: this project ships unsigned by
    // decision, so `mode == 'adhoc'` is a constant true, every release would
    // be flagged a prerelease, and `/releases/latest` excludes prereleases.
    // The README's download link points at `/releases/latest`, so the pair of
    // them guaranteed a dead button. Asserting the tag shape instead means a
    // GA tag produces a GA release on the unsigned lane, which is the whole
    // point of the unsigned lane.
    expect(w['prerelease']).toBe(`\${{ contains(github.ref_name, '-') }}`);
    // Not vacuous in the direction that matters: the expression must actually
    // discriminate, so pin both answers it is required to give.
    const isPre = (tag: string): boolean => tag.includes('-');
    expect(isPre('v1.0.0-rc.1')).toBe(true);
    expect(isPre('v1.0.0')).toBe(false);
    expect(w['body_path']).toBe('dist-pack/RELEASE_NOTES.md');
    const files = String(w['files'] ?? '')
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    expect(files).toEqual([
      'dist-pack/*.dmg',
      'dist-pack/*.zip',
      'dist-pack/SHA256SUMS',
    ]);
    // The checksums file is not decoration. It is the only thing a user of an
    // UNSIGNED build has to check what they downloaded against, because
    // Gatekeeper will tell them nothing.
    expect(read(RELEASE)).toContain('SHA256SUMS');
  });

  /* ── row 8: every third-party action is pinned to a commit ──────────── */

  it('row 8: every `uses:` is a 40-hex SHA with its version in a comment', () => {
    const unpinned: string[] = [];
    for (const rel of SWEPT)
      for (const line of read(rel).split('\n')) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (m === null) continue;
        const [spec, trailer] = [m[1] ?? '', m[2] ?? ''];
        // A local action (`./.github/actions/x`) has no upstream to pin to.
        if (spec.startsWith('./')) continue;
        if (!/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(spec))
          unpinned.push(`${rel}: ${spec} is not pinned to a 40-hex commit SHA`);
        else if (!/#\s*v\d+\.\d+\.\d+/.test(trailer))
          unpinned.push(`${rel}: ${spec} has no readable version comment`);
      }
    // The failure this catches is not hypothetical: `tj-actions/changed-files`
    // was compromised in March 2025 by rewriting its tags, and every workflow
    // that referenced a tag rather than a SHA ran the attacker's code with
    // whatever permissions the job held. This job holds `contents: write`.
    expect(unpinned).toEqual([]);
  });

  /* ── row 9: the macOS CI lane packs the unsigned build ──────────────── */

  it('row 9: ci-macos gains a pack-adhoc job that needs the gate job', () => {
    const wf = load(CI_MACOS);
    const names = Object.keys(jobsOf(wf));
    expect(names).toContain('pack-adhoc');
    // The gate job's name is READ, never assumed: if S8 renamed it, this row
    // must fail loudly rather than quietly asserting against a job that no
    // longer exists.
    const gate = names.find((n) => n !== 'pack-adhoc');
    expect(gate).toBeDefined();
    expect(jobsOf(wf)['pack-adhoc']?.needs).toEqual([gate]);
    expect(jobsOf(wf)['pack-adhoc']?.['runs-on']).toBe('macos-15');
    const runs = runsOf(wf, 'pack-adhoc');
    expect(runs.some((r) => r.includes('pnpm pack:adhoc'))).toBe(true);
    expect(
      runs.some((r) => r.includes('verify-bundle.sh') && r.includes('adhoc')),
    ).toBe(true);
    const upload = stepsOf(wf, 'pack-adhoc').find((s) =>
      (s.uses ?? '').startsWith('actions/upload-artifact@'),
    );
    expect(upload).toBeDefined();
    const w = (upload?.with ?? {}) as Record<string, unknown>;
    expect(String(w['path'] ?? '')).toContain('-UNSIGNED');
    // Seven days, because these are per-push builds and a public repo's
    // artifact storage is finite. The number is asserted so that raising it
    // is a reviewed diff rather than a drift.
    expect(w['retention-days']).toBe(7);
  });

  it('row 9b: the two CI lanes still run the same gate, read from the YAML', () => {
    // A second reader for the claim `test/arch.spec.ts` makes with a text
    // splitter. The splitter had to be narrowed to one job when this slice
    // added a second job to the macOS file, and a narrowing is exactly the
    // moment to prove the claim survives under a different reader.
    const linux = load(CI_LINUX);
    const macos = load(CI_MACOS);
    const linuxGate = Object.keys(jobsOf(linux))[0] ?? '';
    const macosGate =
      Object.keys(jobsOf(macos)).find((n) => n !== 'pack-adhoc') ?? '';
    const norm = (rs: readonly string[]): string[] =>
      rs.map((r) => r.replace('xvfb-run -a pnpm test', 'pnpm test'));
    expect(norm(runsOf(macos, macosGate))).toEqual(
      norm(runsOf(linux, linuxGate)),
    );
    expect(runsOf(macos, macosGate)).toContain('pnpm test');
  });

  /* ── row 10: the tap push is doubly gated and never force-pushed ────── */

  it('row 10: the cask push needs the signed lane AND a tap token', () => {
    const wf = load(RELEASE);
    // Found by what it DOES, not by what it mentions. TWO steps in this job
    // name TAP_PUSH_TOKEN: the `signing` step reads it to decide whether a
    // tap exists at all, and this one spends it. A `.find()` on the token
    // returned the first, which carries no `if:` precisely because it is the
    // step that COMPUTES the lane, so the row asserted against the wrong step
    // and failed for a right-looking wrong reason. Exactly one step may run
    // the cask publisher, and the count is asserted so that a second one
    // cannot be added unguarded beside it.
    const caskSteps = stepsOf(wf, 'pack-macos').filter((s) =>
      (s.run ?? '').includes('release:cask'),
    );
    expect(caskSteps).toHaveLength(1);
    const cask = caskSteps[0];
    // ...and it is still the step holding the token.
    expect(stepText(cask ?? {})).toContain('TAP_PUSH_TOKEN');
    const cond = cask?.if ?? '';
    expect(cond).toContain(SIGNED_LANE);
    expect(cond).toContain('steps.signing.outputs.tap');
    // It opens a pull request. It does not write to the tap's default branch,
    // because a bad sha256 pushed straight to `main` breaks `brew install`
    // for everyone until somebody notices.
    const body = cask?.run ?? '';
    expect(body).toContain('gh pr create');
    expect(body).not.toContain('git push');
    expect(body).not.toContain('--force');
  });

  /* ── row 11: the public sweeps reach the workflow files ─────────────── */

  it('row 11: no phone number, no email address, no hex colour', () => {
    for (const rel of SWEPT) {
      const text = read(rel);
      expect([rel, /\+1\s*\(?\d{3}/.test(text)]).toEqual([rel, false]);
      expect([rel, /[\w.-]+@[\w-]+\.[a-z]{2,}/i.test(text)]).toEqual([
        rel,
        false,
      ]);
      expect([rel, /#[0-9a-fA-F]{6}\b/.test(text)]).toEqual([rel, false]);
    }
  });

  /* ── row 12: actionlint, when the machine has one ───────────────────── */

  const haveActionlint = hasTool('actionlint');

  it.skipIf(!haveActionlint)(
    'row 12: actionlint accepts every workflow',
    () => {
      for (const rel of SWEPT)
        // Throws on non-zero, and the thrown error carries the diagnostics.
        execFileSync('actionlint', [join(repoRoot, rel)], { encoding: 'utf8' });
      expect(haveActionlint).toBe(true);
    },
  );
});

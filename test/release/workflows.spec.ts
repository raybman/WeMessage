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
const CI_SWIFT = '.github/workflows/ci-swift.yml';
const WORKFLOWS = [RELEASE, CI_MACOS, CI_LINUX] as const;

/**
 * Rows 8, 11 and 12 are SWEEPS, and a sweep that skips a file is a sweep with
 * a hole in it. `ci-python.yml` runs third-party actions on every push
 * exactly like the other three, so a mutable tag there is the same
 * supply-chain exposure with the same blast radius. It is deliberately NOT in
 * `WORKFLOWS`: the shape rows ask about a gate job and a release lane and
 * that file has neither, so widening `WORKFLOWS` would have meant loosening
 * those rows to tolerate it. `ci-swift.yml` (v2 S1) joins on the same terms:
 * it checks out the repository with a third-party action on every push.
 */
const SWEPT = [...WORKFLOWS, CI_PYTHON, CI_SWIFT] as const;

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, unknown>>;
  readonly 'timeout-minutes'?: number;
}

interface Job {
  readonly 'runs-on'?: string;
  readonly if?: string;
  readonly 'timeout-minutes'?: number;
  readonly needs?: readonly string[] | string;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly name?: string;
  readonly permissions?: unknown;
  readonly jobs?: Readonly<Record<string, Job>>;
}

const load = (rel: string): Workflow => parse(read(rel)) as Workflow;

/* ── where the pack actually lands ───────────────────────────────────── */

/**
 * The one path in this file that is DERIVED rather than typed, and the
 * reason it had to be.
 *
 * Every `dist-pack/...` in both workflow files was written relative to the
 * repository root, and electron-builder does not write there. It resolves
 * `directories.output` against the PROJECT directory, and `pack.mjs` invokes
 * it as `pnpm --filter @wemessage/desktop exec electron-builder`, which runs
 * in that package's own directory. So the artefacts land in
 * `apps/desktop/dist-pack` and the workflows were all looking one level too
 * high, at a directory that has never existed in this repo.
 *
 * Nothing caught it. `pack-adhoc` in `ci-macos.yml` `needs` the gate job, the
 * gate job has been red, and a needed job that never runs is reported as
 * `skipped` rather than as failed — a green-looking tick attached to a step
 * that would have exited 2 on its first line ("verify-bundle: no such app
 * bundle"). The release workflow has the same fault in nine more places and
 * is triggered by a tag nobody has pushed yet, so its first run would have
 * been the release itself.
 *
 * Hence a derivation and not a constant. Both halves are read:
 *
 *   `apps/desktop/package.json` name === the filter `pack.mjs` passes, which
 *   is what makes `apps/desktop` the project directory rather than a guess;
 *   `apps/desktop/electron-builder.yml` `directories.output`, which is the
 *   only place the leaf name is decided.
 *
 * Change either one and row 9c fails naming the workflow line that drifted,
 * which is the failure this whole comment exists to make impossible to have
 * silently again.
 */
const DESKTOP_DIR = 'apps/desktop';

const packDir = (): string => {
  const pkg = JSON.parse(read(`${DESKTOP_DIR}/package.json`)) as {
    readonly name?: string;
  };
  // The link between the filter in `pack.mjs` and this directory. If the
  // package were renamed, `--filter @wemessage/desktop` would resolve
  // somewhere else (or nowhere) and the whole derivation below would be
  // about the wrong tree.
  expect(pkg.name).toBe('@wemessage/desktop');
  const packer = read('tools/release/bin/pack.mjs');
  for (const token of ['--filter', '@wemessage/desktop', 'electron-builder'])
    expect([token, packer.includes(token)]).toEqual([token, true]);
  const builder = parse(read(`${DESKTOP_DIR}/electron-builder.yml`)) as {
    readonly directories?: { readonly output?: unknown };
  };
  const out = builder.directories?.output;
  expect(typeof out).toBe('string');
  const leaf = String(out);
  // A relative output. An absolute one would not be under the project dir at
  // all and this derivation would be a lie rather than a mistake.
  expect(leaf.startsWith('/')).toBe(false);
  return `${DESKTOP_DIR}/${leaf}`;
};

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

/** v2 S6b: the tap decision, the one decider the Electron job left behind. */
const TAP_LANE = "steps.tap.outputs.tap == 'yes'";

/**
 * v2 S5a: the Swift job's own lane, decided by its own step. `selfsigned`
 * reads the two WEMESSAGE_SIGN_* secrets and is dormant until they exist;
 * `throwaway` mints an identity for the run and names no secret at all.
 */
const SWIFT_JOB = 'pack-swift';
const SWIFT_SIGNED_LANE = "steps.swiftsign.outputs.mode == 'selfsigned'";
const SWIFT_THROWAWAY_LANE = "steps.swiftsign.outputs.mode == 'throwaway'";
const LEAF_EXPR =
  '${{ steps.import-release-signing-identity.outputs.leaf || steps.mint-throwaway-signing-identity.outputs.leaf }}';
const CHECKOUT_REF = '${{ inputs.tag || github.ref }}';
const RELEASE_TAG = '${{ inputs.tag || github.ref_name }}';
const NOT_DRY_RUN = 'inputs.dry_run != true';

const isUploader = (s: Step): boolean =>
  (s.uses ?? '').startsWith('actions/upload-artifact@') ||
  (s.uses ?? '').startsWith('softprops/action-gh-release@');

/**
 * The closed set of secrets this repository's release is allowed to name.
 * v2 S6b took it from ten to four: the Developer ID, notarization and team
 * secrets left with the Electron job.
 */
const ALLOWED_SECRETS = [
  'GITHUB_TOKEN',
  'TAP_PUSH_TOKEN',
  'WEMESSAGE_SIGN_P12',
  'WEMESSAGE_SIGN_P12_PASSWORD',
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
        inputs: {
          tag: { required: true, type: 'string' },
          // v2 S5a: a dispatch can prove the lanes without a release. Off
          // unless asked for, and a tag push has no inputs at all.
          dry_run: { required: false, type: 'boolean', default: false },
        },
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
    // v2 S5a added `pack-swift`; S6b dropped `pack-macos`, the Electron job.
    expect(Object.keys(jobsOf(wf))).toEqual(['build-test', SWIFT_JOB]);
    expect(jobsOf(wf)['build-test']?.['runs-on']).toBe('ubuntu-24.04');
    // The Swift job needs the gate and nothing else, on the one image the
    // Swift package declares (ci-swift.yml runs on the same label).
    expect(jobsOf(wf)[SWIFT_JOB]?.needs).toEqual(['build-test']);
    expect(jobsOf(wf)[SWIFT_JOB]?.['runs-on']).toBe('macos-26');
    expect(jobsOf(wf)[SWIFT_JOB]?.['timeout-minutes']).toBe(40);
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

  // teeth: TN-secret-in-adhoc-lane (row 4), re-pointed in v2 S6b: deleting the lane if from import-release-signing-identity or publish-cask turns this row red.
  it('row 4: no step touches a secret without the guard its decider sets', () => {
    // v2 S6b. Each secret but the job token belongs to exactly one decider,
    // and every other step that names it must carry that decider's output in
    // its `if:`. An unguarded step that reads an empty secret does not fail
    // harmlessly: `base64 --decode` writes a zero-byte file, `security
    // import` exits non-zero, and the job dies before the build it could
    // have shipped.
    const GUARD: Readonly<Record<string, string>> = {
      WEMESSAGE_SIGN_P12: SWIFT_SIGNED_LANE,
      WEMESSAGE_SIGN_P12_PASSWORD: SWIFT_SIGNED_LANE,
      TAP_PUSH_TOKEN: TAP_LANE,
    };
    const DECIDERS = ['swiftsign', 'tap'];
    const wf = load(RELEASE);
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const [job, def] of Object.entries(jobsOf(wf)))
      for (const step of def.steps ?? []) {
        if (DECIDERS.includes(step.id ?? '')) continue;
        const label = `${job}/${step.id ?? step.name ?? step.uses ?? '(unnamed)'}`;
        for (const secret of secretsNamedIn(stepText(step))) {
          const guard = GUARD[secret];
          if (guard === undefined) continue;
          seen.add(guard);
          if (!(step.if ?? '').includes(guard))
            offenders.push(`${label} reads ${secret} without ${guard}`);
        }
      }
    expect(offenders).toEqual([]);
    // ...and the walk is not vacuous: both guards were met on a real step.
    expect([...seen].sort()).toEqual([SWIFT_SIGNED_LANE, TAP_LANE].sort());
  });

  it('row 4b: two deciders, each one step writing an output', () => {
    const wf = load(RELEASE);
    const steps = stepsOf(wf, SWIFT_JOB);
    // `swiftsign` decides the signing lane (rows 13-15 hold its detail);
    // `tap` decides whether a cask pull request can be opened at all.
    const tap = steps.filter((s) => s.id === 'tap');
    expect(tap).toHaveLength(1);
    const body = tap[0]?.run ?? '';
    expect(body).toContain('GITHUB_OUTPUT');
    expect(body).toContain('tap=yes');
    expect(body).toContain('tap=no');
    expect(tap[0]?.if).toBeUndefined();
    expect(secretsNamedIn(stepText(tap[0] ?? {}))).toEqual(['TAP_PUSH_TOKEN']);
    // Both run before anything that reads them.
    const at = (id: string): number => steps.findIndex((s) => s.id === id);
    expect(at('swiftsign')).toBeGreaterThanOrEqual(0);
    expect(at('tap')).toBeGreaterThan(at('swiftsign'));
    const firstReader = steps.findIndex((s) =>
      /steps\.(swiftsign|tap)\.outputs/.test(s.if ?? ''),
    );
    expect(firstReader).toBeGreaterThan(at('tap'));
    // No `if:` anywhere in the file may read the `secrets` context directly:
    // it is not available there, so such a condition fails open or closed
    // depending on the runner, and either is worse than an explicit output.
    for (const [job, def] of Object.entries(jobsOf(wf)))
      for (const step of def.steps ?? [])
        expect([
          job,
          step.id ?? step.run,
          /secrets\./.test(step.if ?? ''),
        ]).toEqual([job, step.id ?? step.run, false]);
    // The Developer ID decider is gone with its job.
    expect(read(RELEASE)).not.toContain('steps.signing.');
  });

  /* ── row 5: the secret set is closed, and none of it is echoed ──────── */

  it('row 5: names exactly the four allowed secrets, and leaks none', () => {
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
     * The release lane is allowed four secrets and row 5 pins exactly which
     * four. The CI lanes are allowed NONE, and until this row the only
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
    for (const rel of [CI_MACOS, CI_LINUX, CI_PYTHON, CI_SWIFT])
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

  it('row 6: the Developer ID lane is gone, and nothing notarizes', () => {
    // v2 S6b. The keychain discipline that lived here (scoped, random
    // password, always deleted) now belongs to the Swift job and rows 20
    // and 22 hold it. What this row holds is the absence: no step imports a
    // Developer ID, notarizes, or packs the Electron app.
    const text = read(RELEASE);
    for (const gone of [
      'pack-macos',
      'release:notarize',
      'notarytool',
      'pack:adhoc',
      'pack:release',
      'build.keychain-db',
      'APPLE_',
      'ASC_',
      'CSC_',
      'apps/desktop/dist-pack',
    ])
      expect([gone, text.includes(gone)]).toEqual([gone, false]);
  });

  /* ── row 7: the release itself ──────────────────────────────────────── */

  it("row 7: the release is a draft, prereleased by version, with this version's notes", () => {
    const wf = load(RELEASE);
    const steps = stepsOf(wf, SWIFT_JOB);
    const rels = steps.filter((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release@'),
    );
    expect(rels).toHaveLength(1);
    const rel = rels[0];
    const w = (rel?.with ?? {}) as Record<string, unknown>;
    // A draft, because the last check on a release is a human looking at it.
    expect(w['draft']).toBe(true);
    // Keyed on the TAG, not on the lane. A lane-keyed prerelease flag was
    // green and wrong once already: it is constant across every build the
    // project cuts, every release becomes a prerelease, and
    // `/releases/latest`, the README's download link, excludes those.
    expect(w['prerelease']).toBe(
      `\${{ contains(inputs.tag || github.ref_name, '-') }}`,
    );
    expect(w['tag_name']).toBe(RELEASE_TAG);
    const isPre = (tag: string): boolean => tag.includes('-');
    expect(isPre('v1.0.0-rc.1')).toBe(true);
    expect(isPre('v1.0.0')).toBe(false);
    // The body is the CHANGELOG section, written by the step before it to
    // the exact path the uploader reads, and it is not a release file.
    const notesPath = 'apps/mac/dist-pack/RELEASE_NOTES.md';
    expect(w['body_path']).toBe(notesPath);
    const notes = steps.filter((s) => (s.run ?? '').includes('release:notes'));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.run).toBe(`pnpm release:notes --out ${notesPath}`);
    // Every mode, so a dry run proves the section exists.
    expect(notes[0]?.if).toBeUndefined();
    expect(steps.indexOf(notes[0] ?? {})).toBeLessThan(
      steps.indexOf(rel ?? {}),
    );
    expect(String(w['files'] ?? '')).not.toContain('RELEASE_NOTES');
    // The checksums file is what a user checks a self-signed download against.
    expect(String(w['files'] ?? '')).toContain('SHA256SUMS');
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

  it('row 9: ci-macos is one node-gate job on macos-26, with no Electron and no pack', () => {
    // v2 S6b. The Electron bundle no longer ships, so `pack-adhoc` is gone,
    // and the shipped app is built and tested by ci-swift. What remains is
    // the Node side of the repo on the macOS release the app targets.
    const wf = load(CI_MACOS);
    expect(Object.keys(jobsOf(wf))).toEqual(['build-and-test']);
    const gate = jobsOf(wf)['build-and-test'];
    expect(gate?.['runs-on']).toBe('macos-26');
    expect(gate?.needs).toBeUndefined();
    const text = read(CI_MACOS);
    for (const gone of [
      'electron',
      'ELECTRON',
      'pack-adhoc',
      'pack:adhoc',
      'UNSIGNED',
      'upload-artifact',
      'dist-pack',
    ])
      expect([gone, text.includes(gone)]).toEqual([gone, false]);
  });

  it('row 9b: the macOS gate is the Linux gate minus Electron, read from the YAML', () => {
    // A second reader for the claim `test/arch.spec.ts` makes with a text
    // splitter. The one Electron run step Linux still needs (until S6c) is
    // dropped, and the suite line is the node projects here.
    const linux = load(CI_LINUX);
    const macos = load(CI_MACOS);
    const linuxGate = Object.keys(jobsOf(linux))[0] ?? '';
    const expected = runsOf(linux, linuxGate)
      .filter((r) => !r.includes('install-electron'))
      .map((r) => r.replace('xvfb-run -a pnpm test', 'pnpm test:node'));
    expect(runsOf(macos, 'build-and-test')).toEqual(expected);
    expect(runsOf(macos, 'build-and-test')).toContain('pnpm test:node');
    expect(runsOf(macos, 'build-and-test')).not.toContain('pnpm test');
  });

  it('row 9c: every workflow reads the pack where electron-builder writes it', () => {
    const dir = packDir();
    // The derivation must actually have moved somewhere. If `directories.output`
    // were ever set to a path that already began with `apps/desktop`, the
    // sweep below would pass by tautology.
    expect(dir).toBe('apps/desktop/dist-pack');
    const leaf = dir.slice(DESKTOP_DIR.length + 1);
    // v2 S5a: the Swift lane packs to its own directory, which pack-swift.mjs
    // decides (its default `--out`); the workflow passes the same path, and
    // `dist-pack-2` beside it for the second pack.
    const swiftDir = 'apps/mac/dist-pack';
    expect(read('tools/release/bin/pack-swift.mjs')).toContain(
      "join(REPO, 'apps', 'mac', 'dist-pack')",
    );
    const prefixes = [dir, swiftDir];

    /*
     * Every line of both workflows, not just `run:` and not just `with:`.
     * The thirteen references this row was written for were spread across
     * six different YAML shapes — a bare `run:`, a heredoc inside one, a
     * multi-line `run:` with a `cd`, `with.path`, `with.body_path` and a
     * block-scalar `with.files` list — and a sweep that understood the
     * schema would have had to know all six. The file is text and the
     * mistake is textual, so it is read as text.
     */
    const offenders: string[] = [];
    let seen = 0;
    for (const rel of SWEPT)
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(new RegExp(`\\S*${leaf}\\S*`, 'g'))) {
            const ref = m[0];
            seen += 1;
            // `apps/desktop/dist-pack…` is right. A bare `dist-pack…`, or one
            // reached through any other prefix, is a path that does not exist
            // on the runner and would fail at the first command to touch it.
            if (!prefixes.some((p) => ref.startsWith(p)))
              offenders.push(`${rel}:${String(i + 1)}: ${ref}`);
          }
        });
    expect(offenders).toEqual([]);
    // Non-vacuity: a sweep over a term that had been renamed would report no
    // offenders because it found nothing at all.
    expect(seen).toBeGreaterThanOrEqual(12);
  });

  /* ── row 10: the cask pull request is triply gated, never a push ───── */

  it('row 10: the cask pull request needs the selfsigned lane, a tap token, and no dry run', () => {
    const wf = load(RELEASE);
    // Found by what it DOES, not by what it mentions: the `tap` decider also
    // names TAP_PUSH_TOKEN, and carries no `if:` because it COMPUTES one.
    // Exactly one step may run the cask publisher, in exactly one job.
    const caskSteps = Object.entries(jobsOf(wf)).flatMap(([job, def]) =>
      (def.steps ?? [])
        .filter((s) => (s.run ?? '').includes('release:cask'))
        .map((s) => [job, s] as const),
    );
    expect(caskSteps.map(([job]) => job)).toEqual([SWIFT_JOB]);
    const cask = caskSteps[0]?.[1];
    expect(stepText(cask ?? {})).toContain('TAP_PUSH_TOKEN');
    const cond = cask?.if ?? '';
    // A cask pointing at a throwaway build would hand Homebrew users an app
    // whose leaf exists nowhere else.
    expect(cond).toContain(SWIFT_SIGNED_LANE);
    expect(cond).toContain(TAP_LANE);
    expect(cond).toContain(NOT_DRY_RUN);
    const body = cask?.run ?? '';
    // The Swift disk image, by the name cask.mjs parses.
    expect(body).toContain('apps/mac/dist-pack/WeMessage-*-arm64.dmg');
    // It opens a pull request. It does not write to the tap's default branch,
    // because a bad sha256 pushed straight to `main` breaks `brew install`
    // for everyone until somebody notices.
    expect(body).toContain('gh pr create');
    expect(body).not.toContain('git push');
    expect(body).not.toContain('--force');
    // After the release step, so a cask never names a file not yet uploaded,
    // and before the cleanup, which stays last.
    const steps = stepsOf(wf, SWIFT_JOB);
    const rel = steps.findIndex((s) =>
      (s.uses ?? '').startsWith('softprops/action-gh-release@'),
    );
    expect(steps.indexOf(cask ?? {})).toBeGreaterThan(rel);
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

  /* ── rows 13-21: the Swift job (v2 S5a) ─────────────────────────────── */

  const swiftSteps = (): readonly Step[] => stepsOf(load(RELEASE), SWIFT_JOB);
  const swiftStep = (id: string): Step => {
    const found = swiftSteps().filter((s) => s.id === id);
    expect([id, found.length]).toEqual([id, 1]);
    return found[0] ?? {};
  };
  const indexOfId = (id: string): number =>
    swiftSteps().findIndex((s) => s.id === id);

  it('row 13: the Swift lane is decided by one step, and it is an output', () => {
    const decider = swiftStep('swiftsign');
    const body = decider.run ?? '';
    expect(body).toContain('GITHUB_OUTPUT');
    expect(body).toContain('mode=selfsigned');
    expect(body).toContain('mode=throwaway');
    // The decider reads the secret in `env:`/`run:`, never in an `if:`, and
    // carries no `if:` of its own: it is the step every guard depends on.
    expect(decider.if).toBeUndefined();
    expect(secretsNamedIn(stepText(decider))).toEqual(['WEMESSAGE_SIGN_P12']);
    for (const step of swiftSteps())
      expect([
        step.id ?? step.uses ?? step.run,
        /secrets\./.test(step.if ?? ''),
      ]).toEqual([step.id ?? step.uses ?? step.run, false]);
    // It runs before anything that depends on it.
    expect(indexOfId('swiftsign')).toBeLessThan(
      indexOfId('import-release-signing-identity'),
    );
    expect(indexOfId('swiftsign')).toBeLessThan(
      indexOfId('mint-throwaway-signing-identity'),
    );
  });

  it('row 14: only the selfsigned importer touches a WEMESSAGE_SIGN secret', () => {
    const offenders: string[] = [];
    for (const step of swiftSteps()) {
      if (step.id === 'swiftsign') continue;
      const named = secretsNamedIn(stepText(step)).filter((n) =>
        n.startsWith('WEMESSAGE_SIGN_'),
      );
      if (named.length === 0) continue;
      if (step.id !== 'import-release-signing-identity')
        offenders.push(
          `${step.id ?? step.uses ?? '?'} names ${named.join(', ')}`,
        );
      if (!(step.if ?? '').includes(SWIFT_SIGNED_LANE))
        offenders.push(
          `${step.id ?? '?'} reads a signing secret without ${SWIFT_SIGNED_LANE}`,
        );
    }
    expect(offenders).toEqual([]);
    const importer = swiftStep('import-release-signing-identity');
    expect(importer.if).toBe(SWIFT_SIGNED_LANE);
    expect(secretsNamedIn(stepText(importer))).toEqual([
      'WEMESSAGE_SIGN_P12',
      'WEMESSAGE_SIGN_P12_PASSWORD',
    ]);
    // ...and no other job may name them.
    for (const job of ['build-test'])
      expect([
        job,
        secretsNamedIn(JSON.stringify(jobsOf(load(RELEASE))[job])).filter((n) =>
          n.startsWith('WEMESSAGE_SIGN_'),
        ),
      ]).toEqual([job, []]);
  });

  // teeth: S5a tooth 3 (a secrets. reference inside the mint step) turns this row red.
  it('row 15: the throwaway path names no secret', () => {
    const mint = swiftStep('mint-throwaway-signing-identity');
    expect(mint.if).toBe(SWIFT_THROWAWAY_LANE);
    // Every step that runs only in the throwaway lane, read as one document:
    // a fork, a pull request and a dry run all take this lane, and none of
    // them has a credential to give it.
    const throwawayOnly = swiftSteps().filter((s) =>
      (s.if ?? '').includes(SWIFT_THROWAWAY_LANE),
    );
    expect(throwawayOnly.length).toBeGreaterThanOrEqual(1);
    for (const step of throwawayOnly)
      expect([step.id, secretsNamedIn(stepText(step))]).toEqual([step.id, []]);
    // Minted for this run: a one-day self-signed leaf with the code-signing
    // usage, in its own keychain under RUNNER_TEMP, trusted so codesign will
    // use it, and its SHA-1 handed on as an output, never typed anywhere.
    const body = mint.run ?? '';
    for (const token of [
      '/usr/bin/openssl req -x509',
      '-days 1',
      'extendedKeyUsage = critical,codeSigning',
      'CN = WeMessage Throwaway',
      '$RUNNER_TEMP/wemessage-sign.keychain-db',
      'security import',
      '-T /usr/bin/codesign',
      'security set-key-partition-list',
      'add-trusted-cert',
      '-fingerprint -sha1',
      "printf 'leaf=%s\\n'",
      'GITHUB_OUTPUT',
    ])
      expect([token, body.includes(token)]).toEqual([token, true]);
    // The private key does not outlive the import.
    expect(body).toContain('rm -f "$RUNNER_TEMP/key.pem"');
    expect(body).toContain('rm -f "$RUNNER_TEMP/identity.p12"');
  });

  it('row 16: both identity steps emit the leaf, and every user reads it the same way', () => {
    for (const id of [
      'import-release-signing-identity',
      'mint-throwaway-signing-identity',
    ]) {
      const body = swiftStep(id).run ?? '';
      expect([id, body.includes("printf 'leaf=%s\\n'")]).toEqual([id, true]);
      expect([id, body.includes('GITHUB_OUTPUT')]).toEqual([id, true]);
      expect([
        id,
        body.includes('security find-identity -v -p codesigning'),
      ]).toEqual([id, true]);
    }
    for (const id of ['pack-swift-twice', 'verify-swift-bundle'])
      expect([id, swiftStep(id).env?.['LEAF']]).toEqual([id, LEAF_EXPR]);
    // The leaf is passed to the packer as the identity, never a name.
    expect(swiftStep('pack-swift-twice').run ?? '').not.toMatch(
      /--identity\s+"?WeMessage/,
    );
  });

  // teeth: S5a tooth 4 (cmp a file with itself) turns this row red.
  it('row 17: two packs, the second with --skip-build, and cmp compares the two', () => {
    const lines = (swiftStep('pack-swift-twice').run ?? '')
      .split('\n')
      .map((l) => l.trim());
    const packs = lines.filter((l) => l.startsWith('pnpm pack:swift '));
    expect(packs).toHaveLength(2);
    const outOf = (l: string): string => /--out (\S+)/.exec(l)?.[1] ?? '';
    const [first, second] = [packs[0] ?? '', packs[1] ?? ''];
    expect(outOf(first)).toBe('apps/mac/dist-pack');
    expect(outOf(second)).toBe('apps/mac/dist-pack-2');
    expect(first).not.toContain('--skip-build');
    expect(second).toContain('--skip-build');
    for (const p of packs) {
      expect(p).toContain('--identity "$LEAF"');
      // The throwaway flag rides on both, so both zips are named so.
      expect(p).toContain('${extra:+"$extra"}');
    }
    expect(lines).toContain(
      'if [ "$MODE" = "throwaway" ]; then extra="--throwaway"; fi',
    );
    const cmps = lines.filter((l) => l.startsWith('cmp '));
    expect(cmps).toHaveLength(1);
    const args = (cmps[0] ?? '').split(/\s+/).slice(1);
    expect(args).toEqual([
      `${outOf(first)}/DESIGNATED_REQUIREMENT.txt`,
      `${outOf(second)}/DESIGNATED_REQUIREMENT.txt`,
    ]);
    // Two DIFFERENT files: a cmp of one file with itself always passes.
    expect(new Set(args).size).toBe(2);
    // The compare runs after both packs.
    expect(lines.indexOf(cmps[0] ?? '')).toBeGreaterThan(lines.indexOf(second));
  });

  it('row 18: verify pins the leaf, after the packs, and touches no trust setting', () => {
    const verify = swiftStep('verify-swift-bundle');
    const body = verify.run ?? '';
    expect(body).toContain(
      'bash tools/swift/verify-bundle.sh --app apps/mac/dist-app/WeMessage.app --expect-leaf "$LEAF"',
    );
    // No trust or certificate change before the verifier: a removal waits
    // on an authorization dialog on a headless runner (row 22).
    for (const banned of [
      'trusted-cert',
      'delete-certificate',
      'trust-settings',
    ])
      expect([banned, body.includes(banned)]).toEqual([banned, false]);
    expect(verify.if).toBeUndefined();
    expect(indexOfId('verify-swift-bundle')).toBeGreaterThan(
      indexOfId('pack-swift-twice'),
    );
    // The RELEASING.md comparison is selfsigned only: a throwaway leaf is
    // never published, so there is nothing to compare it with.
    const compare = swiftStep('compare-leaf-with-releasing');
    expect(compare.if).toBe(SWIFT_SIGNED_LANE);
    expect(compare.run ?? '').toContain('RELEASING.md');
    expect(compare.run ?? '').toContain('certificate leaf');
  });

  it('row 19: a release upload is selfsigned only; a throwaway build uploads its disk image as an artifact and nothing else', () => {
    const uploads = swiftSteps().filter(isUploader);
    // Non-vacuity: all three uploaders are in the job, in this order.
    expect(uploads.map((s) => (s.uses ?? '').split('@')[0])).toEqual([
      'actions/upload-artifact',
      'actions/upload-artifact',
      'softprops/action-gh-release',
    ]);
    // v2 S5b: exactly one throwaway upload, a workflow artifact, never a
    // release, holding the throwaway disk image only.
    const throwaway = uploads.filter((s) => (s.if ?? '').includes('throwaway'));
    expect(throwaway).toHaveLength(1);
    const t = throwaway[0];
    expect(t?.if).toBe(SWIFT_THROWAWAY_LANE);
    expect((t?.uses ?? '').startsWith('actions/upload-artifact@')).toBe(true);
    const tw = (t?.with ?? {}) as Record<string, unknown>;
    expect(String(tw['name'] ?? '')).toMatch(/-throwaway$/);
    expect(tw['path']).toBe('apps/mac/dist-pack/*-throwaway.dmg');
    expect(tw['if-no-files-found']).toBe('error');
    // Every other uploader is selfsigned only.
    for (const step of uploads.filter((s) => s !== t)) {
      const cond = step.if ?? '';
      expect([step.uses, cond.includes(SWIFT_SIGNED_LANE)]).toEqual([
        step.uses,
        true,
      ]);
      expect([step.uses, cond.includes('throwaway')]).toEqual([
        step.uses,
        false,
      ]);
      expect([step.uses, /\|\|/.test(cond)]).toEqual([step.uses, false]);
    }
    // ...and no `run:` uploads behind the uploaders' backs.
    for (const run of runsOf(load(RELEASE), SWIFT_JOB))
      for (const banned of ['gh release', 'gh api', 'curl ', 'upload'])
        expect([banned, run.includes(banned)]).toEqual([banned, false]);
    // The release asset set, and the release is a draft named by the tag.
    const rel = uploads[2];
    const w = (rel?.with ?? {}) as Record<string, unknown>;
    expect(w['draft']).toBe(true);
    expect(w['tag_name']).toBe(RELEASE_TAG);
    expect(rel?.if ?? '').toContain(NOT_DRY_RUN);
    expect(
      String(w['files'] ?? '')
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    ).toEqual([
      'apps/mac/dist-pack/*.zip',
      'apps/mac/dist-pack/*.dmg',
      'apps/mac/dist-pack/SHA256SUMS',
      'apps/mac/dist-pack/DESIGNATED_REQUIREMENT.txt',
    ]);
    // Uploads come after verify and after the image; cleanup is last.
    const firstUpload = swiftSteps().findIndex(isUploader);
    expect(firstUpload).toBeGreaterThan(indexOfId('verify-swift-bundle'));
    expect(firstUpload).toBeGreaterThan(indexOfId('dmg-swift'));
    expect(indexOfId('cleanup-swift-signing-identity')).toBe(
      swiftSteps().length - 1,
    );
  });

  it('row 20: the Swift keychain and key files are removed on every path', () => {
    const cleanup = swiftStep('cleanup-swift-signing-identity');
    expect(cleanup.if).toBe('always()');
    const body = cleanup.run ?? '';
    expect(body).toContain('security delete-keychain');
    expect(body).toContain('$RUNNER_TEMP/wemessage-sign.keychain-db');
    expect(body).toContain('rm -f');
    for (const f of ['identity.p12', 'cert.pem', 'key.pem', 'mint.cnf'])
      expect([f, body.includes(`"$RUNNER_TEMP/${f}"`)]).toEqual([f, true]);
    expect(secretsNamedIn(stepText(cleanup))).toEqual([]);
    // Both identity steps use the keychain cleanup removes, never the login
    // keychain, and never one in the workspace.
    for (const id of [
      'import-release-signing-identity',
      'mint-throwaway-signing-identity',
    ]) {
      const run = swiftStep(id).run ?? '';
      expect([
        id,
        run.includes('kc="$RUNNER_TEMP/wemessage-sign.keychain-db"'),
      ]).toEqual([id, true]);
      expect([id, /delete-keychain|default-keychain/.test(run)]).toEqual([
        id,
        false,
      ]);
    }
  });

  it('row 21: a dispatch builds the tag it names, and a dry run releases nothing', () => {
    const wf = load(RELEASE);
    // Every checkout in every job, so build-test gates the same tree the
    // packers pack.
    const checkouts = Object.entries(jobsOf(wf)).flatMap(([job, def]) =>
      (def.steps ?? [])
        .filter((s) => (s.uses ?? '').startsWith('actions/checkout@'))
        .map((s) => [job, (s.with ?? {})['ref']] as const),
    );
    expect(checkouts).toEqual([
      ['build-test', CHECKOUT_REF],
      [SWIFT_JOB, CHECKOUT_REF],
    ]);
    // The old spelling reads a string where the input is a boolean, and
    // `inputs.tag` is never interpolated into a shell line (it is a string
    // a dispatcher types).
    const text = read(RELEASE);
    expect(text).not.toContain('github.event.inputs');
    for (const [job, def] of Object.entries(jobsOf(wf)))
      for (const step of def.steps ?? [])
        expect([
          job,
          step.id ?? step.name,
          (step.run ?? '').includes('inputs.'),
        ]).toEqual([job, step.id ?? step.name, false]);
    // A dry run: every release-creating or pull-request-opening step
    // anywhere is behind the input.
    for (const [job, def] of Object.entries(jobsOf(wf)))
      for (const step of def.steps ?? [])
        if (
          (step.uses ?? '').startsWith('softprops/action-gh-release@') ||
          (step.run ?? '').includes('gh pr create')
        )
          expect([
            job,
            (def.if ?? '').includes(NOT_DRY_RUN) ||
              (step.if ?? '').includes(NOT_DRY_RUN),
          ]).toEqual([job, true]);
    // Non-vacuity of the expression itself, as GitHub evaluates it: a tag
    // push has no inputs (null), and null != true.
    const notDry = (v: boolean | null): boolean => v !== true;
    expect([notDry(null), notDry(false), notDry(true)]).toEqual([
      true,
      true,
      false,
    ]);
  });

  // Two live dispatches hung on trust removal: 37943894910 to the job
  // limit, then 37950305539, whose step limits kept the log. That log shows
  // verify and cleanup each stuck on `sudo security remove-trusted-cert -d`
  // with no output for their whole limit, while the same verifier had run
  // in seconds inside the pack. Removing a trust setting waits on an
  // authorization dialog even under sudo; adding one through sudo does not.
  // So trust is added in the admin domain through sudo and never removed
  // (the hosted VM is discarded), and the steps after the packs carry their
  // own limits, so any other hang fails fast with its log.
  it('row 22: Swift trust is only added, admin-domain through sudo, and the late steps are time-boxed', () => {
    const changes = swiftSteps().flatMap((s) =>
      (s.run ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /trusted-cert|trust-settings/.test(l))
        .map((l) => [s.id, l] as const),
    );
    // Non-vacuity: both identity steps add trust, and nothing else touches it.
    expect([...new Set(changes.map(([id]) => id))]).toEqual([
      'import-release-signing-identity',
      'mint-throwaway-signing-identity',
    ]);
    for (const [id, line] of changes)
      expect([
        id,
        line.startsWith('sudo security add-trusted-cert -d '),
      ]).toEqual([id, true]);
    // Anywhere in the file, so a step added later cannot bring it back.
    expect(read(RELEASE)).not.toMatch(
      /remove-trusted-cert|trust-settings-(import|export)/,
    );
    for (const id of [
      'verify-swift-bundle',
      'cleanup-swift-signing-identity',
    ]) {
      const limit = swiftStep(id)['timeout-minutes'] ?? 0;
      expect([id, limit > 0 && limit <= 10]).toEqual([id, true]);
    }
  });

  it('row 23: dr-diff runs after the second pack and before upload, selfsigned only', () => {
    const step = swiftStep('dr-diff');
    expect(step.if).toBe(SWIFT_SIGNED_LANE);
    const at = indexOfId('dr-diff');
    expect(at).toBeGreaterThan(indexOfId('pack-swift-twice'));
    // Before EVERY uploader, so an unjustified change publishes nothing.
    const uploaders = swiftSteps()
      .map((s, i) => [s, i] as const)
      .filter(([s]) => isUploader(s))
      .map(([, i]) => i);
    expect(uploaders.length).toBeGreaterThanOrEqual(2);
    for (const i of uploaders) expect([i, at < i]).toEqual([i, true]);
    // The comparison reads this build's requirement and this repo's
    // CHANGELOG, for the tag passed through env (row 21: never `inputs.`
    // in a shell line), and it names no secret but the job token.
    const body = step.run ?? '';
    expect(body).toContain('node tools/release/bin/dr-diff.mjs');
    for (const arg of [
      '--repo "$GITHUB_REPOSITORY"',
      '--tag "$TAG"',
      '--current apps/mac/dist-pack/DESIGNATED_REQUIREMENT.txt',
      '--changelog CHANGELOG.md',
    ])
      expect([arg, body.includes(arg)]).toEqual([arg, true]);
    const env = (step.env ?? {}) as Record<string, unknown>;
    expect(env['TAG']).toBe(RELEASE_TAG);
    expect(secretsNamedIn(stepText(step))).toEqual(['GITHUB_TOKEN']);
    // A failure fails the job: nothing swallows the exit code.
    expect(body).not.toMatch(/\|\|\s*true|continue-on-error/);
    expect(stepText(step)).not.toContain('continue-on-error');
    const limit = step['timeout-minutes'] ?? 0;
    expect(limit > 0 && limit <= 10).toBe(true);
  });

  it('row 24: the disk image is built from the zipped app, signed with the same leaf, in both lanes', () => {
    const step = swiftStep('dmg-swift');
    // Both lanes: a dry run must produce the image too.
    expect(step.if).toBeUndefined();
    expect(indexOfId('dmg-swift')).toBeGreaterThan(
      indexOfId('verify-swift-bundle'),
    );
    const env = (step.env ?? {}) as Record<string, unknown>;
    expect(env['LEAF']).toBe(LEAF_EXPR);
    const body = step.run ?? '';
    for (const token of [
      'set -euo pipefail',
      'ditto -x -k "$zip"',
      'dmg="${zip%.zip}.dmg"',
      'bash tools/swift/dmg.sh --app "$src/WeMessage.app" --out "$dmg" --identity "$LEAF"',
      'shasum -a 256',
      '>> SHA256SUMS',
    ])
      expect([token, body.includes(token)]).toEqual([token, true]);
    expect(secretsNamedIn(stepText(step))).toEqual([]);
    const limit = step['timeout-minutes'] ?? 0;
    expect(limit > 0 && limit <= 10).toBe(true);
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

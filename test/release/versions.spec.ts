/**
 * s9 Scenario 14: CHANGELOG, lockstep versions, cut-tag, v1.0.0-rc.1.
 *
 * Seven rows. Rows 1 through 3 test EXISTING, working machinery
 * (`check-versions.mjs`, `CHANGELOG.md`, `release-notes.mjs`) without
 * rewriting any of it. Row 4 is the new deliverable, `cut-tag.mjs`, whose
 * decision logic and git plumbing live in `tools/release/src/tag.ts`, built
 * to `tools/release/dist/tag.js`. Row 5 is the two-lane GA gate that same
 * file implements. Row 6 documents, honestly, that CLI/daemon `--version`
 * wiring does not exist yet: this row is written and left red on purpose,
 * see its own comment. Row 7 checks the Homebrew cask lock agrees.
 *
 * WHY `cut-tag.mjs` ITSELF NEVER APPEARS TO SPAWN. `test/arch.spec.ts`'s own
 * row 10 partitions the release scripts into a set that must never contain a
 * child-process call in its own source text, and `release:cut-tag` is a
 * permanent member of that set. Every git invocation this scenario makes
 * therefore lives in `tools/release/src/tag.ts` instead, which that row
 * never reads. `tools/release/bin/cask.mjs` established this exact split
 * first; `cut-tag.mjs` follows the same shape for the same reason.
 *
 * WHY EVERY TEMP REPO IS SEEDED FRESH RATHER THAN CLONED FROM THIS ONE.
 * `check-versions.mjs` and `release-notes.mjs` each compute their own repo
 * root from their OWN `import.meta.url`, not from any parameter, so testing
 * them against a synthetic drifted manifest means giving them their own
 * copy to read, at the same relative layout, colocated with copies of
 * `cut-tag.mjs` and the compiled `tag.js`. `seedRepo` below builds exactly
 * that copy, then commits it, so each row starts from a clean tree and
 * mutates only what that row is testing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  APP_VERSION_FILE,
  declaredAppVersion,
  manifestPaths,
  versionDrift,
} from '../../tools/release/bin/check-versions.mjs';
import { sectionFor } from '../../tools/release/bin/release-notes.mjs';
import {
  gaLaneNote,
  planTag,
  type TagInputs,
} from '../../tools/release/src/tag.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const NODE = process.execPath;
const TARGET_VERSION = '1.0.0-rc.1';

const RELEASE_NOTES_BIN = join(REPO, 'tools/release/bin/release-notes.mjs');

/* ── shared temp-repo plumbing, rows 1c, 4 and 5 ─────────────────────── */

const temps: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `wemessage-${prefix}-`));
  temps.push(d);
  return d;
}

interface SeedOptions {
  /** Applied to all 18 manifests, root included. */
  readonly version: string;
  /** Per-relative-path overrides, applied after `version`, before the seed commit. */
  readonly manifestOverrides?: Readonly<Record<string, string>>;
  readonly changelog?: string;
}

/**
 * A self-contained, committed COPY of exactly what `cut-tag.mjs` and its
 * siblings need, at the same relative paths, so their own
 * `import.meta.url`-derived repo roots resolve inside the copy rather than
 * this repo. The copy starts fully committed and clean; a row that wants a
 * dirty or staged-docs case mutates it afterward, deliberately.
 */
function seedRepo(opts: SeedOptions): string {
  const dir = tempDir('versions');
  for (const rel of manifestPaths()) {
    const manifest = JSON.parse(
      readFileSync(join(REPO, rel), 'utf8'),
    ) as Record<string, unknown>;
    manifest['version'] = opts.manifestOverrides?.[rel] ?? opts.version;
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  copyFileSync(
    join(REPO, 'pnpm-workspace.yaml'),
    join(dir, 'pnpm-workspace.yaml'),
  );
  // The nineteenth place the version lives. `versionDrift` reads it, so a copy
  // without it is a copy that fails for a reason the row under test is not
  // about. Rewritten to `opts.version` so the seeded tree is genuinely in
  // lockstep at whatever version the row asked for.
  mkdirSync(join(dir, dirname(APP_VERSION_FILE)), { recursive: true });
  writeFileSync(
    join(dir, APP_VERSION_FILE),
    readFileSync(join(REPO, APP_VERSION_FILE), 'utf8').replace(
      /^export const APP_VERSION = '[^']*';$/m,
      `export const APP_VERSION = '${opts.version}';`,
    ),
  );
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    opts.changelog ?? readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8'),
  );
  mkdirSync(join(dir, 'tools/release/bin'), { recursive: true });
  mkdirSync(join(dir, 'tools/release/dist'), { recursive: true });
  for (const f of ['check-versions.mjs', 'release-notes.mjs', 'cut-tag.mjs']) {
    copyFileSync(
      join(REPO, 'tools/release/bin', f),
      join(dir, 'tools/release/bin', f),
    );
  }
  copyFileSync(
    join(REPO, 'tools/release/dist/tag.js'),
    join(dir, 'tools/release/dist/tag.js'),
  );

  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync(
    'git',
    ['config', 'user.email', 'wemessage-test@example.invalid'],
    {
      cwd: dir,
    },
  );
  execFileSync('git', ['config', 'user.name', 'WeMessage Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
  return dir;
}

function runCutTag(
  dir: string,
  version: string,
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(
    NODE,
    [join(dir, 'tools/release/bin/cut-tag.mjs'), version],
    {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    },
  );
}

/**
 * The message of ONE named tag.
 *
 * The ref pattern is qualified. Unqualified `refs/tags` returns every tag's
 * contents concatenated, so the moment a fixture grows a second tag a
 * `toContain` here starts passing for the wrong reason: it would be finding
 * the phrase in some other tag's message. An unknown name is a refusal
 * rather than an empty string, because a substring assertion against `''`
 * reports "the phrase is missing" when the truth is "the tag is missing",
 * and those want different fixes.
 */
function tagMessage(dir: string, tagName: string): string {
  const contents = execFileSync(
    'git',
    ['for-each-ref', `refs/tags/${tagName}`, '--format=%(contents)'],
    { cwd: dir, encoding: 'utf8' },
  );
  if (contents.trim() === '') {
    throw new Error(`no tag named ${tagName} in ${dir}`);
  }
  return contents;
}

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('s9 Sc14: CHANGELOG, lockstep versions, cut-tag, v1.0.0-rc.1', () => {
  /* ── row 1: eighteen manifests in lockstep, drift named when it happens ── */
  describe('row 1: check-versions.mjs, tested not rewritten', () => {
    it('manifestPaths() finds the root plus all 17 workspace members', () => {
      const paths = manifestPaths();
      expect(paths.length).toBe(18);
      expect(paths).toContain('package.json');
      expect(paths).toContain('tools/release/package.json');
      expect(paths).toContain('packages/core/package.json');
    });

    it('this repository, right now, is in lockstep at the target version', () => {
      // Not a synthetic tree: the real one, as it stands at this commit. The
      // eighteen manifests and the one source constant all agree, which is
      // the whole claim `release:cut-tag` refuses without.
      expect(versionDrift(TARGET_VERSION)).toEqual([]);
      expect(declaredAppVersion()).toBe(TARGET_VERSION);
    });

    it('the source constant is in the check, not merely alongside it', () => {
      // The constant is a nineteenth place the version lives and the only one
      // that is not JSON, so it is the one a bump forgets. Proving the check
      // covers it means proving it FAILS when the constant alone is wrong,
      // which is what a `--expect` the constant cannot satisfy demonstrates:
      // every manifest is at the target, so the only problem left is this one.
      const drifted = versionDrift('9.9.9-not-a-real-version');
      expect(drifted.filter((p) => p.startsWith(APP_VERSION_FILE))).toEqual([
        `${APP_VERSION_FILE} declares APP_VERSION ${TARGET_VERSION}, want 9.9.9-not-a-real-version`,
      ]);
    });

    it('a temp copy with one manifest changed to 1.0.0 is named by path, not just counted', () => {
      const dir = seedRepo({ version: TARGET_VERSION });
      const manifestPath = join(dir, 'packages/core/package.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
      manifest['version'] = '1.0.0';
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = spawnSync(
        NODE,
        [
          join(dir, 'tools/release/bin/check-versions.mjs'),
          '--expect',
          TARGET_VERSION,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/core/package.json is 1.0.0');
    });
  });

  /* ── row 2: CHANGELOG.md, tested not rewritten ───────────────────────── */
  describe('row 2: CHANGELOG.md names every slice it ships', () => {
    // test/release/readme.spec.ts row 6 already covers Unreleased, dated
    // sections and the closed category set; this does not repeat those. It
    // proves the one thing THIS scenario adds: the release candidate names
    // every slice by number, not only the last one.
    it('the 1.0.0-rc.1 section names S1 through S9', () => {
      const changelog = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');
      const body = sectionFor(changelog, TARGET_VERSION);
      expect(body).not.toBeNull();
      for (let n = 1; n <= 9; n += 1) {
        expect(body, `S${n}`).toContain(`S${n},`);
      }
    });
  });

  /* ── row 3: release-notes.mjs, tested not rewritten ──────────────────── */
  describe('row 3: release:notes refuses an unknown version, prints a known one', () => {
    it('--version 9.9.9 exits 1', () => {
      const result = spawnSync(
        NODE,
        [RELEASE_NOTES_BIN, '--version', '9.9.9'],
        {
          cwd: REPO,
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
    });

    it('--version 1.0.0-rc.1 exits 0 and prints the section body', () => {
      const result = spawnSync(
        NODE,
        [RELEASE_NOTES_BIN, '--version', TARGET_VERSION],
        {
          cwd: REPO,
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('S9, ship');
    });
  });

  /* ── row 4: cut-tag.mjs, five refusals, a success, and no push ───────── */
  describe('row 4: cut-tag refuses five ways, then tags, and never pushes', () => {
    const base: TagInputs = {
      version: TARGET_VERSION,
      porcelain: '',
      stagedPaths: [],
      versionProblems: [],
      changelogSection: 'the body',
      tagExists: false,
      env: {},
    };

    it('planTag: dirty tree refuses first', () => {
      const result = planTag({ ...base, porcelain: ' M package.json\n' });
      expect(result).toMatchObject({ ok: false, reason: 'dirty-tree' });
    });

    it('planTag: staged docs/ refuses even with an otherwise-clean tree', () => {
      // Porcelain shows only the staged docs/ path: this is the exact shape
      // TN-tag-with-docs targets. If dirty-tree swallowed this case, the
      // staged-docs reason below would be unreachable.
      const result = planTag({
        ...base,
        porcelain: 'A  docs/plans/slices/s9-execution.md\n',
        stagedPaths: ['docs/plans/slices/s9-execution.md'],
      });
      expect(result).toMatchObject({ ok: false, reason: 'staged-docs' });
    });

    it('planTag: version mismatch refuses, naming the count', () => {
      const result = planTag({
        ...base,
        versionProblems: [
          'packages/core/package.json is 1.0.0, want 1.0.0-rc.1',
        ],
      });
      expect(result).toMatchObject({ ok: false, reason: 'version-mismatch' });
    });

    it('planTag: missing CHANGELOG section refuses', () => {
      const result = planTag({
        ...base,
        version: '9.9.9',
        changelogSection: null,
      });
      expect(result).toMatchObject({ ok: false, reason: 'missing-changelog' });
    });

    it('planTag: an already-existing tag refuses', () => {
      const result = planTag({ ...base, tagExists: true });
      expect(result).toMatchObject({ ok: false, reason: 'tag-exists' });
    });

    it('planTag: every gate passing succeeds, message is the CHANGELOG body', () => {
      const result = planTag(base);
      expect(result).toEqual({
        ok: true,
        tagName: `v${TARGET_VERSION}`,
        message: 'the body',
      });
    });

    /* real git, end to end, against the actual cut-tag.mjs bin */

    it('end to end: dirty tree refuses', () => {
      const dir = seedRepo({ version: TARGET_VERSION });
      writeFileSync(join(dir, 'untracked.txt'), 'dirty');
      const result = runCutTag(dir, TARGET_VERSION);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('dirty tree');
    });

    it("end to end: staged docs/ refuses, this is TN-tag-with-docs's target row", () => {
      const dir = seedRepo({ version: TARGET_VERSION });
      mkdirSync(join(dir, 'docs/plans/slices'), { recursive: true });
      writeFileSync(join(dir, 'docs/plans/slices/s9-execution.md'), '# plan\n');
      execFileSync('git', ['add', '-f', 'docs/plans/slices/s9-execution.md'], {
        cwd: dir,
      });

      const result = runCutTag(dir, TARGET_VERSION);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('docs/ is staged');
      const tags = execFileSync('git', ['tag', '-l'], {
        cwd: dir,
        encoding: 'utf8',
      }).trim();
      expect(tags).toBe('');
    });

    it('end to end: version mismatch refuses, naming the file', () => {
      const dir = seedRepo({
        version: TARGET_VERSION,
        manifestOverrides: { 'packages/core/package.json': '1.0.0' },
      });
      const result = runCutTag(dir, TARGET_VERSION);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('packages/core/package.json is 1.0.0');
    });

    it('end to end: missing CHANGELOG section refuses', () => {
      // Seeded uniformly at 9.9.9, so every manifest already agrees with
      // the version being cut, isolating the changelog gate from the
      // version-mismatch gate that would otherwise fire first.
      const dir = seedRepo({ version: '9.9.9' });
      const result = runCutTag(dir, '9.9.9');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no non-empty section for 9.9.9');
    });

    it('end to end: an already-existing tag refuses', () => {
      const dir = seedRepo({ version: TARGET_VERSION });
      const first = runCutTag(dir, TARGET_VERSION);
      expect(first.status).toBe(0);
      const second = runCutTag(dir, TARGET_VERSION);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('already exists');
    });

    it('end to end: success creates an annotated tag whose message is the CHANGELOG section, and origin receives nothing', () => {
      const dir = seedRepo({ version: TARGET_VERSION });
      const origin = tempDir('origin');
      execFileSync('git', ['init', '-q', '--bare'], { cwd: origin });
      execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });

      const result = runCutTag(dir, TARGET_VERSION);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`v${TARGET_VERSION}`);

      const tagType = execFileSync(
        'git',
        ['cat-file', '-t', `v${TARGET_VERSION}`],
        {
          cwd: dir,
          encoding: 'utf8',
        },
      ).trim();
      expect(tagType).toBe('tag'); // annotated, not lightweight

      expect(tagMessage(dir, `v${TARGET_VERSION}`)).toContain('S1, live tail');

      // Origin receives nothing: cut-tag never names a remote, so the bare
      // "remote" this test adds itself stays entirely untouched.
      const remoteRefs = execFileSync('git', ['for-each-ref'], {
        cwd: origin,
        encoding: 'utf8',
      }).trim();
      expect(remoteRefs).toBe('');
    });
  });

  /* ── row 5: the two-lane GA gate ──────────────────────────────────────── */
  describe('row 5: a bare GA tag needs exactly one of two lanes', () => {
    const VALID_ID = '123e4567-e89b-12d3-a456-426614174000';

    it('prerelease versions are never gated, regardless of env', () => {
      expect(gaLaneNote('1.0.0-rc.1', {})).toEqual({ ok: true, note: null });
      expect(
        gaLaneNote('1.0.0-rc.1', {
          NOTARIZATION_ACCEPTED_ID: VALID_ID,
          UNSIGNED_RELEASE_ACKNOWLEDGED: '1',
        }),
      ).toEqual({ ok: true, note: null });
    });

    it('a valid notarization id alone succeeds, naming the ticket', () => {
      const result = gaLaneNote('1.0.0', {
        NOTARIZATION_ACCEPTED_ID: VALID_ID,
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.note).toContain(VALID_ID);
    });

    it('UNSIGNED_RELEASE_ACKNOWLEDGED=1 alone succeeds, naming Gatekeeper', () => {
      const result = gaLaneNote('1.0.0', {
        UNSIGNED_RELEASE_ACKNOWLEDGED: '1',
      });
      expect(result.ok).toBe(true);
      expect(result.ok && result.note?.toLowerCase()).toContain('gatekeeper');
    });

    it('both set at once is a refusal naming both variables', () => {
      const result = gaLaneNote('1.0.0', {
        NOTARIZATION_ACCEPTED_ID: VALID_ID,
        UNSIGNED_RELEASE_ACKNOWLEDGED: '1',
      });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain(
        'NOTARIZATION_ACCEPTED_ID',
      );
      expect(!result.ok && result.message).toContain(
        'UNSIGNED_RELEASE_ACKNOWLEDGED',
      );
    });

    it('neither set is a refusal naming both options', () => {
      const result = gaLaneNote('1.0.0', {});
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain(
        'NOTARIZATION_ACCEPTED_ID',
      );
      expect(!result.ok && result.message).toContain(
        'UNSIGNED_RELEASE_ACKNOWLEDGED',
      );
    });

    it('a malformed notarization id is refused, not silently accepted', () => {
      const result = gaLaneNote('1.0.0', {
        NOTARIZATION_ACCEPTED_ID: 'not-a-ticket',
      });
      expect(result.ok).toBe(false);
    });

    it('end to end: v1.0.0 succeeds with UNSIGNED_RELEASE_ACKNOWLEDGED=1, and the tag says so', () => {
      const changelog =
        `${readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8')}\n` +
        '## [1.0.0] - 2026-09-09\n\n' +
        'General availability.\n\n' +
        '### Added\n\n' +
        '- GA.\n\n' +
        '[1.0.0]: https://github.com/raybman/WeMessage/releases/tag/v1.0.0\n';
      const dir = seedRepo({ version: '1.0.0', changelog });

      const result = runCutTag(dir, '1.0.0', {
        UNSIGNED_RELEASE_ACKNOWLEDGED: '1',
      });
      expect(result.status).toBe(0);
      expect(tagMessage(dir, 'v1.0.0').toLowerCase()).toContain('gatekeeper');
    });
  });

  /* ── row 6: --version reads the build-time define, never fs ─────────── */
  describe('row 6: CLI and daemon --version', () => {
    // NOT IMPLEMENTED. Confirmed by direct search: packages/cli and
    // packages/daemon both build with plain `tsc -b`, no esbuild `define`
    // step and no bundler at all; commander's `.version(...)` is never
    // called anywhere under packages/cli/src; and no source file under
    // either package contains the string "--version". Wiring an esbuild
    // define step into two packages that have never had a bundler is a
    // build-system change well past "implement cut-tag.mjs", so this row
    // is written honestly and left red rather than skipped or faked. See
    // this scenario's report for the full explanation and what row 7 needs
    // once someone picks this up.
    it('the CLI --version flag reports the lockstep version', () => {
      const result = spawnSync(
        NODE,
        [join(REPO, 'packages/cli/dist/bin.js'), '--version'],
        {
          cwd: REPO,
          encoding: 'utf8',
        },
      );
      expect(result.stdout.trim()).toBe(TARGET_VERSION);
    });
  });

  /* ── row 7: the Homebrew cask lock agrees ────────────────────────────── */
  describe('row 7: homebrew/cask.lock.json.version matches', () => {
    it('cask.lock.json version is 1.0.0-rc.1', () => {
      const lockPath = join(REPO, 'homebrew/cask.lock.json');
      if (!existsSync(lockPath)) {
        throw new Error(
          'homebrew/cask.lock.json does not exist yet. A concurrent scenario ' +
            'owns creating it; this row will pass once that file lands.',
        );
      }
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        version?: string;
      };
      expect(lock.version).toBe(TARGET_VERSION);
    });
  });
});

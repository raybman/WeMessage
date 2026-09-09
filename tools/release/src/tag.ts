/**
 * s9 Sc14: `release:cut-tag`'s decision logic and git plumbing.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `tools/release/bin/cut-tag.mjs`: the
 * same split `tools/release/src/cask.ts`'s own header argues for, for the
 * same two reasons. First, testability: `planTag` below takes plain data in
 * and returns plain data out, so `test/release/versions.spec.ts` can drive
 * every refusal branch in process, no temp git repository required, and
 * reserve the slower real-git rows for the handful of cases that actually
 * need one. Second, `test/arch.spec.ts`'s row 10 (s9 Sc6) partitions the
 * seven release scripts into STUBS and IMPLEMENTED by reading each script's
 * OWN FILE TEXT for a child-process call, and `release:cut-tag` is a member
 * of STUBS there. A STUBS member's text may never match a child-process call
 * site, so every actual git invocation this tool makes has to live
 * somewhere that check does not read; it reads `tools/release/bin/
 * cut-tag.mjs` alone, by the exact path named in the root package.json
 * script string, never this file and never `dist/tag.js`. `cutTag` below,
 * and it alone, is where those calls live. `tools/release/bin/cask.mjs`'s
 * header documents the same fence from the other side, a script that avoids
 * the child process entirely rather than relocating it; git has no
 * pure-Node equivalent, so relocating is this tool's only option.
 *
 * THE TWO-LANE GA GATE. Plan row 5 reads as a single gate: refuse a bare GA
 * tag unless `NOTARIZATION_ACCEPTED_ID` is set. Taken literally that makes
 * `v1.0.0` permanently uncuttable for a project that has already decided,
 * on purpose, to ship unsigned and unnotarized; a guard that blocks the
 * only path anyone actually walks is a guard that gets deleted. `gaLaneNote`
 * below implements two lanes instead: a notarized build records its ticket,
 * an acknowledged-unsigned build records that Gatekeeper will warn, and
 * claiming both at once is refused because a build is one or the other,
 * never both. Neither set is refused too, naming both options. Prerelease
 * tags (any version with a `-` suffix, such as `1.0.0-rc.1`) are not gated
 * by this at all, that is the lane this project ships on. See
 * `test/release/versions.spec.ts` row 5 for the truth table this covers.
 *
 * THE `tools/` FENCE. Nothing here imports a workspace package, not even a
 * type. `node:*` and relative paths are the whole permitted set.
 */
import { execFileSync } from 'node:child_process';

/** A `1.0.0-rc.1`-shaped version carries a prerelease suffix; `1.0.0` does not. */
export function isPrerelease(version: string): boolean {
  return version.includes('-');
}

/** Ticket ids `release:notarize` (s9 Sc9) hands back. */
const NOTARIZATION_ID_RE = /^[0-9a-f-]{36}$/;

export interface TagEnv {
  readonly NOTARIZATION_ACCEPTED_ID?: string;
  readonly UNSIGNED_RELEASE_ACKNOWLEDGED?: string;
}

export type GaLaneResult =
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly message: string };

/**
 * The two-lane GA gate (see this file's header). A prerelease version is
 * always `{ok: true, note: null}`: not gated, nothing to record.
 */
export function gaLaneNote(version: string, env: TagEnv): GaLaneResult {
  if (isPrerelease(version)) return { ok: true, note: null };

  const rawId = env.NOTARIZATION_ACCEPTED_ID;
  const idPresent = typeof rawId === 'string' && rawId.length > 0;
  const idValid =
    idPresent && rawId !== undefined && NOTARIZATION_ID_RE.test(rawId);
  const ackPresent = env.UNSIGNED_RELEASE_ACKNOWLEDGED === '1';

  if (idValid && ackPresent) {
    return {
      ok: false,
      message:
        'refusing: both NOTARIZATION_ACCEPTED_ID and UNSIGNED_RELEASE_ACKNOWLEDGED=1 are ' +
        'set. A build is notarized or it is not; a tag cannot claim both lanes at once.',
    };
  }
  if (idValid && rawId !== undefined) {
    return { ok: true, note: `Notarization accepted: ticket ${rawId}.` };
  }
  if (ackPresent) {
    return {
      ok: true,
      note:
        'This build is NOT signed with an Apple Developer ID and NOT notarized, by ' +
        'project decision. Users installing it will see Gatekeeper warn on first launch.',
    };
  }
  const badIdSuffix = idPresent
    ? ` (NOTARIZATION_ACCEPTED_ID was set but does not match ${NOTARIZATION_ID_RE.source})`
    : '';
  return {
    ok: false,
    message:
      'refusing: a bare GA tag (no prerelease suffix) needs exactly one of ' +
      `NOTARIZATION_ACCEPTED_ID (matching ${NOTARIZATION_ID_RE.source}) or ` +
      `UNSIGNED_RELEASE_ACKNOWLEDGED=1${badIdSuffix}.`,
  };
}

function isDocsPath(path: string): boolean {
  return path === 'docs' || path.startsWith('docs/');
}

/** `docs/` staged paths, the refusal `TN-tag-with-docs` (s9 Sc14 Teeth) removes. */
export function stagedDocsOffenders(
  stagedPaths: readonly string[],
): readonly string[] {
  return stagedPaths.filter(isDocsPath);
}

/**
 * `git status --porcelain` lines with the leading `XY ` status columns
 * stripped, following a `-> ` rename arrow when present. Porcelain v1's
 * format is always exactly two status characters, one space, then the path
 * (or `old -> new` for a rename), so slicing at a fixed offset is safe.
 */
function porcelainPath(line: string): string {
  const raw = line.slice(3);
  const arrow = raw.indexOf(' -> ');
  return arrow === -1 ? raw : raw.slice(arrow + 4);
}

/**
 * `git status --porcelain` lines that are NOT under docs/. `docs/` is
 * gitignored (see .gitignore), so the only way it can appear in porcelain
 * output at all is a force-add; that specific case belongs to the
 * `staged-docs` gate below, with its own, more useful message, not to this
 * catch-all. Excluding it here is what keeps `staged-docs` reachable: an
 * otherwise-clean tree with only `docs/` force-staged must fall through
 * dirty-tree and land on staged-docs instead of being swallowed by it.
 */
function nonDocsPorcelainLines(porcelain: string): readonly string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .filter((line) => !isDocsPath(porcelainPath(line)));
}

export interface TagInputs {
  readonly version: string;
  /** Raw `git status --porcelain` stdout. Non-empty means a dirty tree. */
  readonly porcelain: string;
  /** Raw `git diff --cached --name-only` lines, one path each. */
  readonly stagedPaths: readonly string[];
  /** `versionDrift(version)`'s own problem strings; `[]` means lockstep. */
  readonly versionProblems: readonly string[];
  /** `sectionFor(changelog, version)`'s result; `null` means no section. */
  readonly changelogSection: string | null;
  readonly tagExists: boolean;
  readonly env: TagEnv;
}

export type TagRefusalReason =
  | 'dirty-tree'
  | 'staged-docs'
  | 'version-mismatch'
  | 'missing-changelog'
  | 'tag-exists'
  | 'ga-lane';

export type PlanTagResult =
  | { readonly ok: true; readonly tagName: string; readonly message: string }
  | {
      readonly ok: false;
      readonly reason: TagRefusalReason;
      readonly message: string;
    };

/**
 * The pure decision core: six refusal gates in a fixed order, then the
 * annotated tag's name and message. No git, no filesystem access; every
 * fact it needs arrives already gathered on `inputs`, which is what makes
 * this function callable directly, dozens of times, with synthetic inputs,
 * and is also the function `TN-tag-with-docs` (this file's Teeth) targets:
 * removing the `staged-docs` branch below must still typecheck (the branch
 * is dead code, not a type error, once removed) and must make the row 4
 * staged-docs case wrongly succeed.
 */
export function planTag(inputs: TagInputs): PlanTagResult {
  const dirtyLines = nonDocsPorcelainLines(inputs.porcelain);
  if (dirtyLines.length > 0) {
    return {
      ok: false,
      reason: 'dirty-tree',
      message:
        'refusing: dirty tree. `git status --porcelain` is non-empty; commit or stash ' +
        `before cutting a release tag.\n${dirtyLines.join('\n')}`,
    };
  }

  const docsOffenders = stagedDocsOffenders(inputs.stagedPaths);
  if (docsOffenders.length > 0) {
    return {
      ok: false,
      reason: 'staged-docs',
      message:
        'refusing: docs/ is staged; docs/ is never committed. Unstage: ' +
        docsOffenders.join(', '),
    };
  }

  if (inputs.versionProblems.length > 0) {
    return {
      ok: false,
      reason: 'version-mismatch',
      message:
        `refusing: ${inputs.versionProblems.length} package(s) out of lockstep with ` +
        `${inputs.version}:\n${inputs.versionProblems.map((p) => `  ${p}\n`).join('')}`,
    };
  }

  if (inputs.changelogSection === null) {
    return {
      ok: false,
      reason: 'missing-changelog',
      message: `refusing: CHANGELOG.md has no non-empty section for ${inputs.version}.`,
    };
  }

  if (inputs.tagExists) {
    return {
      ok: false,
      reason: 'tag-exists',
      message: `refusing: tag v${inputs.version} already exists.`,
    };
  }

  const lane = gaLaneNote(inputs.version, inputs.env);
  if (!lane.ok) {
    return { ok: false, reason: 'ga-lane', message: lane.message };
  }

  const message =
    lane.note === null
      ? inputs.changelogSection
      : `${inputs.changelogSection}\n\n${lane.note}`;

  return { ok: true, tagName: `v${inputs.version}`, message };
}

export interface CutTagOptions {
  readonly cwd: string;
  readonly env: TagEnv;
  /** `versionDrift(version)`, gathered by the caller: see `cut-tag.mjs`. */
  readonly versionProblems: readonly string[];
  /** `sectionFor(changelog, version)`, gathered by the caller. */
  readonly changelogSection: string | null;
}

export type CutTagResult = PlanTagResult;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function tagExists(cwd: string, tagName: string): boolean {
  const out = git(cwd, ['tag', '--list', tagName]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .includes(tagName);
}

/**
 * The impure orchestrator `tools/release/bin/cut-tag.mjs` calls through
 * `../dist/tag.js`. Gathers the git facts `planTag` needs, decides, and on
 * success creates the annotated tag. Never pushes: no remote is named
 * anywhere in this function, so there is nothing that could push; the four
 * git invocations it makes are `status`, `diff --cached`, `tag --list` and,
 * only once every gate above has passed, `tag -a`.
 */
export function cutTag(version: string, opts: CutTagOptions): CutTagResult {
  const porcelain = git(opts.cwd, ['status', '--porcelain']);
  const stagedRaw = git(opts.cwd, ['diff', '--cached', '--name-only']);
  const stagedPaths = stagedRaw.split('\n').filter((line) => line.length > 0);
  const tagName = `v${version}`;
  const exists = tagExists(opts.cwd, tagName);

  const plan = planTag({
    version,
    porcelain,
    stagedPaths,
    versionProblems: opts.versionProblems,
    changelogSection: opts.changelogSection,
    tagExists: exists,
    env: opts.env,
  });

  if (!plan.ok) return plan;

  git(opts.cwd, ['tag', '-a', plan.tagName, '-m', plan.message]);
  return plan;
}

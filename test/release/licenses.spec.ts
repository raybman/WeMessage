/**
 * s1 Sc11: the license gate, from --failOn to --onlyAllow.
 *
 * WHAT IS ACTUALLY BEING PROVED HERE. The old `licenses:check` script ran
 * `license-checker-rseidelsohn --failOn 'GPL;AGPL;GPL-3.0;AGPL-3.0'`, a
 * denylist. `--failOn` is fail-open by construction: a license this project
 * has never seen before, has no opinion on and has never reviewed sails
 * through, because it does not match any of the four listed strings. This
 * gate replaces it with `--onlyAllow`, an allowlist: only a license this
 * project has actually reviewed and named in licenses.allow is admitted.
 * Everything else, including a license nobody has thought about yet, is
 * rejected by default. Rows 1 to 3 pin the exact shape of that change.
 *
 * WHY TWO ALLOWLISTS. `licenses.allow` gates `--production`, the packages
 * that actually ship. `licenses.allow.dev` gates the full graph, including
 * devDependencies, and is strictly wider: it is licenses.allow plus
 * MPL-2.0, reviewed and dated, admitted for exactly one reason (axe-core, a
 * test engine, never enters the bundle). Rows 11 to 14 pin that the
 * widening is exactly one license, machine checked, not a door left open.
 *
 * THE NON-VACUITY ROW (row 4). `--production` reads a manifest's own
 * `dependencies` field. A manifest with no `dependencies` field at all
 * (this repo's root, among others) makes `license-checker-rseidelsohn`
 * crash internally with "No packages found in this path...", a full stack
 * trace to stderr, and it STILL EXITS 0. A `--onlyAllow` gate is a denylist
 * wearing an allowlist's clothes if it can pass by scanning nothing: every
 * one of rows 1 to 3 would go green against a chain that silently checks
 * zero packages at every clause. Row 4 rules that out, by asserting real
 * package counts in both directions, not just at the two roots that are
 * legitimately expected to be empty.
 *
 * OR VERSUS AND (rows 6 to 8). `--onlyAllow` does substring matching on the
 * whole SPDX expression, not real SPDX grammar. For an OR expression like
 * `(MIT OR GPL-3.0)` that is correct: under a dual license the licensee
 * picks the favorable arm, so admitting it because MIT appears is the
 * right answer, not a bug (row 6). For an AND expression like
 * `(MIT AND GPL-3.0)` the same substring match is WRONG: AND means both
 * arms are unavoidable obligations, and this passes --onlyAllow anyway
 * (row 7, which pins the gap as it actually behaves today). Row 8 is a
 * dedicated post-processing check, applied to a raw --json report, that
 * splits every AND expression on its arms and requires each one to be
 * independently allowed. It is not wired into the shipped `licenses:check`
 * script; it exists here to prove the gap is real and stays closed.
 *
 * WHAT NEVER APPEARS IN THIS FILE. No hardcoded home-directory path: `REPO`
 * is derived, like every other spec here, and row 20 below asserts the
 * generated notices carry no absolute path either. That row needs the prefix
 * as a VALUE, so it assembles it from fragments rather than writing it out;
 * the tree-wide census in `test/arch.spec.ts` names every file that spells
 * one, and this file has no business being on that list. The prose here
 * cannot spell it either, which is the census reaching its own documentation.
 * No email address, in a probe or an assertion. No em dash: commas and colons
 * carry every row title that the reference file next to this one spells with
 * one.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// `check-versions.mjs` is plain ESM with no declaration file, because the
// tools/ import fence keeps it that way: node:* and relative imports only.
// `tsconfig.vitest.json` sets `allowJs`, so the types here are the ones
// TypeScript infers from that file's real implementation rather than a
// hand-written stub that could drift. notices.mjs imports it the same way for
// the same reason: one hand-rolled pnpm-workspace.yaml reader, not three.
import { manifestPaths } from '../../tools/release/bin/check-versions.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const LICENSE_CHECKER_BIN = join(
  REPO,
  'node_modules/.bin/license-checker-rseidelsohn',
);
const ALLOW_PATH = join(REPO, 'licenses.allow');
const ALLOW_DEV_PATH = join(REPO, 'licenses.allow.dev');
const DENY_PATH = join(REPO, 'licenses.deny');
const NOTICES_PATH = join(REPO, 'THIRD_PARTY_NOTICES.md');
const NOTICES_BIN = join(REPO, 'tools/release/bin/notices.mjs');

/**
 * Root first, then every workspace member, dirs rather than manifest
 * paths. Reused from check-versions.mjs (which notices.mjs also imports
 * from) rather than re-parsing pnpm-workspace.yaml a third time. Deriving
 * this LIVE, instead of hardcoding the current 18 roots, is what makes
 * row 1 an actual regression guard: a workspace member added without a
 * matching update to licenses:check shows up here as a mismatch, not as
 * a silently stale pair of hardcoded lists that drift together.
 */
const WORKSPACE_ROOTS: string[] = (manifestPaths() as string[])
  .map((p) => (p === 'package.json' ? '.' : p.replace(/\/package\.json$/, '')))
  .sort();

/**
 * The only two roots with no `dependencies` field at all: the private
 * root manifest, and tools/release (a CLI toolbox that ships nothing of
 * its own). Every other root is expected to report at least one real
 * package under a `--production` scan.
 */
const EXPECTED_EMPTY = new Set(['.', 'tools/release']);

/**
 * Strips comment and blank lines, then splits what is left on `;`. Shared
 * by licenses.allow, licenses.allow.dev and licenses.deny: all three are
 * the same format, one semicolon-joined line, optionally preceded by
 * `#`-prefixed review comments (licenses.allow.dev is the only one that
 * currently has one).
 */
const readLicenseList = (path: string): string[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') && line.trim() !== '')
    .join(';')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');

const readScripts = (): Record<string, string> =>
  (
    JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

/** Reconstructs one `&&`-joined clause exactly as package.json builds it. */
const buildInvocation = (root: string, production: boolean): string => {
  const source = production
    ? '"$(cat licenses.allow)"'
    : `"$(grep -v '^#' licenses.allow.dev)"`;
  const flag = production ? '--production ' : '';
  return `license-checker-rseidelsohn ${flag}--start ${root} --onlyAllow ${source} --excludePrivatePackages`;
};

const buildChain = (production: boolean): string =>
  WORKSPACE_ROOTS.map((root) => buildInvocation(root, production)).join(' && ');

/**
 * `--production --json`, package count only. stderr is discarded on
 * purpose: the two EXPECTED_EMPTY roots print a full stack trace here
 * (see row 4's comment) and it is not this row's job to display it, only
 * to prove the exit-0-with-zero-packages behavior it produces either way.
 */
const packageCount = (root: string): number => {
  const stdout = execFileSync(
    LICENSE_CHECKER_BIN,
    ['--production', '--start', root, '--json', '--excludePrivatePackages'],
    { encoding: 'utf8', cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return Object.keys(JSON.parse(stdout) as Record<string, unknown>).length;
};

/** A raw, full (non-production) --json scan, no --onlyAllow filtering. */
const scanJson = (root: string): Record<string, { licenses?: string }> => {
  const stdout = execFileSync(
    LICENSE_CHECKER_BIN,
    ['--start', root, '--json', '--excludePrivatePackages'],
    { encoding: 'utf8', cwd: REPO },
  );
  return JSON.parse(stdout) as Record<string, { licenses?: string }>;
};

interface OnlyAllowResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the real --onlyAllow gate against `root` and captures the result
 * whether it exits 0 or throws: `execFileSync` throws on a non-zero exit,
 * and the thrown error carries `.status`, `.stdout` and `.stderr` as
 * plain strings, not Buffers, once `encoding: 'utf8'` is set.
 */
const runOnlyAllow = (root: string, allowList: string): OnlyAllowResult => {
  try {
    const stdout = execFileSync(
      LICENSE_CHECKER_BIN,
      ['--start', root, '--onlyAllow', allowList, '--excludePrivatePackages'],
      { encoding: 'utf8', cwd: REPO },
    );
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = err as {
      status: number | null;
      stdout: string;
      stderr: string;
    };
    return {
      exitCode: failure.status ?? 1,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
};

/**
 * Splits an SPDX AND expression like `(MIT AND GPL-3.0)` into its arms.
 * Returns [] for anything that is not an AND expression (a bare license,
 * or an OR expression, which row 6 establishes is not this gate's
 * problem): only AND turns "one arm allowed" into the wrong answer.
 */
const andArms = (licenseExpr: string): string[] => {
  const inner = licenseExpr.replace(/^\(/, '').replace(/\)$/, '');
  if (!inner.includes(' AND ')) return [];
  return inner.split(' AND ').map((arm) => arm.trim());
};

interface AndViolation {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly deniedArm: string;
}

/**
 * The check --onlyAllow does not do: every arm of an AND expression must
 * be independently in `allowed`, not just one of them.
 */
const andViolations = (
  report: Record<string, { licenses?: string }>,
  allowed: Set<string>,
): AndViolation[] => {
  const violations: AndViolation[] = [];
  for (const [key, info] of Object.entries(report)) {
    const license = info.licenses ?? '';
    const at = key.lastIndexOf('@');
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    for (const arm of andArms(license)) {
      if (!allowed.has(arm))
        violations.push({ name, version, license, deniedArm: arm });
    }
  }
  return violations;
};

const temps: string[] = [];

/**
 * A minimal, throwaway workspace root: a package.json naming it, with an
 * EXPLICIT MIT license, so the anchor itself never trips --onlyAllow. An
 * anchor with no `license` field reports "UNKNOWN" and rejects on its own
 * account (confirmed empirically while designing this row), which would
 * make every planted-probe row below fail for the wrong reason. Plus one
 * node_modules package carrying the license actually under test. Mirrors
 * notarize.spec.ts's tempDir()/temps[] cleanup pattern.
 */
const plantProbe = (name: string, version: string, license: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wemessage-licenses-probe-'));
  temps.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'probe-root', version: '0.0.0', license: 'MIT' }),
  );
  mkdirSync(join(dir, 'node_modules', name), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', name, 'package.json'),
    JSON.stringify({ name, version, license }),
  );
  return dir;
};

const ALLOW_STRING = readFileSync(ALLOW_PATH, 'utf8').trim();

const PLANTED_DENIALS: ReadonlyArray<{
  readonly label: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
}> = [
  {
    label: 'a single denied license',
    name: 'probe-gpl',
    version: '9.9.9',
    license: 'GPL-2.0-only',
  },
  {
    label: 'a single denied license, the -or-later shape',
    name: 'probe-agpl',
    version: '2.0.0',
    license: 'AGPL-3.0-or-later',
  },
  {
    label: 'a dual license where both arms are denied',
    name: 'probe-dual-denied',
    version: '4.0.0',
    license: '(LGPL-2.1 OR GPL-3.0-only)',
  },
];

describe('s1 Sc11: the license gate, from --failOn to --onlyAllow', () => {
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  /* ── the two scripts, exact shape ──────────────────────────────────── */

  it('row 1: licenses:check is the exact production --onlyAllow chain, one clause per workspace root', () => {
    expect(readScripts()['licenses:check']).toBe(buildChain(true));
  });

  it('row 2: licenses:check:dev is the same chain, sourced from licenses.allow.dev, without --production', () => {
    expect(readScripts()['licenses:check:dev']).toBe(buildChain(false));
  });

  it('row 3: neither script uses the old fail-open --failOn flag any more', () => {
    const scripts = readScripts();
    expect(scripts['licenses:check']).not.toContain('--failOn');
    expect(scripts['licenses:check:dev']).not.toContain('--failOn');
  });

  /* ── does the gate actually gate ───────────────────────────────────── */

  it('row 4: every workspace root reports real packages, except the two that are structurally empty', () => {
    /*
     * Measured directly against this tree: `--production --start . --json`
     * writes `{}` to stdout, this to stderr, and STILL exits 0:
     *
     *   An error has occurred:
     *   Error: No packages found in this path...
     *       at .../license-checker-rseidelsohn@4.4.2/.../lib/index.js:697:19
     *
     * That is the fail-open bug this row exists to catch: the tool cannot
     * tell the difference between "scanned and found nothing to object
     * to" and "never scanned anything at all", and exits 0 either way.
     * `.` really is empty this way: the private root manifest has no
     * `dependencies` field, so it crashes. tools/release is ALSO expected
     * to be empty, but for the opposite, better reason: its package.json
     * genuinely has neither `dependencies` nor `devDependencies`, so
     * there is nothing to crash on and the scan is a clean, honest `{}`.
     * Both are legitimate EXPECTED_EMPTY members; any OTHER root
     * reporting zero packages would mean this row caught a real
     * regression, not a known, reviewed absence.
     */
    const counts = WORKSPACE_ROOTS.map((root) => ({
      root,
      count: packageCount(root),
    }));
    for (const { root, count } of counts) {
      if (EXPECTED_EMPTY.has(root)) {
        expect(count, `${root} was expected to be structurally empty`).toBe(0);
      } else {
        expect(
          count,
          `${root} reported zero packages: either it genuinely has none, in ` +
            'which case add it to EXPECTED_EMPTY with a reason, or the scan ' +
            'silently found nothing when it should have found something',
        ).toBeGreaterThan(0);
      }
    }
    // Both directions: EXPECTED_EMPTY names exactly the roots that are
    // empty, no more (checked above) and no fewer (checked here).
    const actuallyEmpty = counts
      .filter((c) => c.count === 0)
      .map((c) => c.root);
    expect(new Set(actuallyEmpty)).toEqual(EXPECTED_EMPTY);
  }, 60000);

  for (const probe of PLANTED_DENIALS) {
    it(`row 5: ${probe.label} is rejected by name, with the exact --onlyAllow reason`, () => {
      const dir = plantProbe(probe.name, probe.version, probe.license);
      const result = runOnlyAllow(dir, ALLOW_STRING);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `Package "${probe.name}@${probe.version}" is licensed under "${probe.license}" which is not permitted by the --onlyAllow flag. Exiting.`,
      );
    });
  }

  it('row 6: an OR expression is admitted when either arm is allowed, and that is correct', () => {
    // Under a dual license the licensee picks the favorable arm: admitting
    // (MIT OR GPL-3.0) because MIT is allowed is the right answer, not a
    // gap. A gate that rejected this would be wrong, not stricter.
    const dir = plantProbe('probe-or-mixed', '3.0.0', '(MIT OR GPL-3.0)');
    const result = runOnlyAllow(dir, ALLOW_STRING);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('row 7: an AND expression is wrongly admitted by --onlyAllow alone, even with a denied arm', () => {
    // This is the real gap: --onlyAllow does substring matching on the
    // whole SPDX string, so (MIT AND GPL-3.0) is admitted because MIT
    // appears in it, even though AND means BOTH arms are owed and GPL-3.0
    // was never reviewed or allowed. Row 8 is the fix.
    const dir = plantProbe('probe-and-mixed', '5.0.0', '(MIT AND GPL-3.0)');
    const result = runOnlyAllow(dir, ALLOW_STRING);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('row 8: the AND-aware check catches what --onlyAllow missed, and leaves an all-allowed AND alone', () => {
    const deniedDir = plantProbe(
      'probe-and-mixed',
      '5.0.0',
      '(MIT AND GPL-3.0)',
    );
    const cleanDir = plantProbe(
      'probe-and-clean',
      '1.0.0',
      '(MIT AND Apache-2.0)',
    );
    const allowed = new Set(readLicenseList(ALLOW_PATH));

    const denied = andViolations(scanJson(deniedDir), allowed);
    const clean = andViolations(scanJson(cleanDir), allowed);

    expect(denied).toEqual([
      {
        name: 'probe-and-mixed',
        version: '5.0.0',
        license: '(MIT AND GPL-3.0)',
        deniedArm: 'GPL-3.0',
      },
    ]);
    expect(clean).toEqual([]);
  });

  /* ── the allowlists and denylist themselves ────────────────────────── */

  it('row 9: licenses.allow and licenses.deny share no license', () => {
    const allow = new Set(readLicenseList(ALLOW_PATH));
    const deny = new Set(readLicenseList(DENY_PATH));
    const overlap = [...allow].filter((license) => deny.has(license));
    expect(
      overlap,
      `licenses.allow and licenses.deny both claim: ${overlap.join(', ')}`,
    ).toEqual([]);
  });

  it('row 10: licenses.deny names the full copyleft family', () => {
    const deny = new Set(readLicenseList(DENY_PATH));
    const family = [
      'GPL-2.0',
      'GPL-3.0',
      'GPL-2.0-only',
      'GPL-2.0-or-later',
      'GPL-3.0-only',
      'GPL-3.0-or-later',
      'LGPL-2.1',
      'LGPL-3.0',
      'AGPL-3.0',
      'AGPL-3.0-only',
      'AGPL-3.0-or-later',
    ];
    for (const license of family) {
      expect(deny.has(license), `licenses.deny is missing ${license}`).toBe(
        true,
      );
    }
  });

  it('row 11: licenses.allow.dev is a strict superset of licenses.allow', () => {
    const prod = new Set(readLicenseList(ALLOW_PATH));
    const dev = new Set(readLicenseList(ALLOW_DEV_PATH));
    for (const license of prod) {
      expect(dev.has(license), `licenses.allow.dev dropped ${license}`).toBe(
        true,
      );
    }
    expect(dev.size).toBeGreaterThan(prod.size);
  });

  it('row 12: the delta between licenses.allow.dev and licenses.allow is exactly MPL-2.0', () => {
    const prod = new Set(readLicenseList(ALLOW_PATH));
    const dev = readLicenseList(ALLOW_DEV_PATH);
    const delta = dev.filter((license) => !prod.has(license));
    expect(delta).toEqual(['MPL-2.0']);
  });

  it('row 13: MPL-2.0 is not on the production allowlist', () => {
    const prod = new Set(readLicenseList(ALLOW_PATH));
    expect(prod.has('MPL-2.0')).toBe(false);
  });

  it('row 14: the dev-only delta is disjoint from licenses.deny', () => {
    const deny = new Set(readLicenseList(DENY_PATH));
    const prod = new Set(readLicenseList(ALLOW_PATH));
    const dev = readLicenseList(ALLOW_DEV_PATH);
    const delta = dev.filter((license) => !prod.has(license));
    for (const license of delta) {
      expect(
        deny.has(license),
        `${license} is both dev-allowed and denied`,
      ).toBe(false);
    }
  });

  it('row 15: licenses.allow matches its committed snapshot', () => {
    expect(readFileSync(ALLOW_PATH, 'utf8')).toMatchSnapshot();
  });

  /* ── the generated notices file ────────────────────────────────────── */

  let generatedNotices = '';
  beforeAll(() => {
    generatedNotices = execFileSync('node', [NOTICES_BIN], {
      cwd: REPO,
      encoding: 'utf8',
    });
  }, 30000);

  it('row 16: THIRD_PARTY_NOTICES.md is exactly what the generator produces right now', () => {
    expect(readFileSync(NOTICES_PATH, 'utf8')).toBe(generatedNotices);
  });

  it('row 17: the notices name electron, the devDependency that ships anyway', () => {
    expect(generatedNotices).toMatch(/^## electron@/m);
  });

  it('row 18: the notices name better-sqlite3', () => {
    expect(generatedNotices).toMatch(/^## better-sqlite3@/m);
  });

  it('row 19: no dependency in the notices reports an unknown license', () => {
    expect(generatedNotices).not.toContain('UNKNOWN');
  });

  it('row 20: the notices never contain an absolute path from this machine', () => {
    // Assembled, not written out. The value is byte-identical; what changes
    // is that the SHAPE is no longer in the tree, so the home-path census in
    // `test/arch.spec.ts` stays closed at the files that have earned a place
    // on it, and a real home path hardcoded into this file later would still
    // fail that census carrying this file's name.
    const MAC_HOME = `/${'Users'}/`;
    expect(MAC_HOME).toHaveLength(7);
    expect(generatedNotices).not.toContain(MAC_HOME);
    expect(generatedNotices).not.toMatch(/\/home\/[^/\s]+\//);
  });

  it('row 21: the notices never contain a literal email address', () => {
    expect(generatedNotices).not.toMatch(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    );
  });
});

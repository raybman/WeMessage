/**
 * Scenario 1 — Architecture invariants hold on the empty scaffold.
 * Named in plan §2.7 (INV-1) and §4.0; spec s1-execution Part 2 Scenario 1.
 *
 * Two halves:
 *  1. The real tree cruises clean under `.dependency-cruiser.cjs` (INV-1 + §3.1
 *     arrows + §3.3 protocol type-only).
 *  2. Proven teeth: a deliberately planted violation (temp file inside
 *     packages/core/src importing the store package) IS reported — the rules
 *     catch bad imports, not merely "nothing bad exists yet".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
// s7 Sc9: the verification ledger reads BUILT modules, so it needs a file URL.
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// s8 Sc1 row 11: "which lint rules apply to this file" is a question only
// ESLint can answer without a second implementation of flat-config
// resolution — and answering it with a glob library would need a dependency
// the plan does not ratify.
import { ESLint } from 'eslint';
import {
  // s8 Sc17 row 8: the slice's closing claim is that a GUI-era slice added
  // no transport, and the ratchet snapshot is where that is already written
  // down. Reading it here rather than restating it is the difference between
  // a meta row and a second list to keep in step.
  EMITTED_WS_EVENTS,
  PORT_IMPORTER_ALLOWLIST,
  // s7 Sc12: a public document may only name a route that exists. The
  // ratchet snapshot is already the arbiter of the route surface, so the
  // documentation sweep asks it rather than growing a second list.
  ROUTE_TABLE,
  UNEMITTED_WS_EVENTS,
  WS_EVENT_VOCABULARY,
} from '../packages/daemon/test/transport-surface.snapshot.js';
import {
  FRAME_SPECS,
  GATEWAY_EVENT_NAMES,
} from '../packages/protocol/src/index.js';
// s7 Sc11: the public-repo predicates now have ONE home, shared with the
// transcript linter. Precedent for a root spec importing a package's test
// helper is the line above, which has done exactly this since s5.
// s7 Sc12 adds `lintTranscript` and `parseSkillBlocks` here rather than a
// fourth copy of the rules: the shipped documents are swept by the same
// implementation that sweeps a live transcript and a committed DRYRUN.md.
import {
  // s8 Sc1 row 6: the ANSI sweep, extracted from `lintTranscript` rather
  // than restated, so the S6 transcripts and the desktop suite share one
  // definition of "coloured output".
  ansiOffenders,
  lintTranscript,
  parseSkillBlocks,
  publicStringOffenders,
} from '../packages/cli/test/helpers/transcript-lint.js';
// s8 Sc1 row 12: the capability scan the transport-surface ratchet runs. The
// arch row plants an offender under `apps/desktop/src` and asserts that THIS
// function sees it, which is the only honest way to claim the ratchet row
// would have failed.
import {
  PRODUCTION_SOURCE_ROOTS,
  portImporters,
  productionSourceFiles,
} from '../packages/daemon/test/helpers/production-sources.js';

const repoRoot = resolve(import.meta.dirname, '..');
const depcruiseBin = join(repoRoot, 'node_modules', '.bin', 'depcruise');

/**
 * Every tracked file the public-repo sweeps are allowed to read, as text.
 *
 * WIDENED BY s7 Sc7. Until this commit the sweep filtered to
 * `/\.(ts|tsx|js|mjs|cjs)$/` plus `.json`, which meant markdown, yaml, html,
 * sql and shell were tracked, published and NEVER SWEPT. That was survivable
 * only for as long as the repo was all TypeScript, and Sc7 ends that: it adds
 * `.py` and `.yaml` under `packages/adapters/hermes/plugin/`, which is
 * exactly the unswept set. Closing the hole is cheaper than remembering that
 * the guard has a blind spot, so the allowlist of extensions is gone: the
 * sweep now reads everything git tracks except the handful of extensions that
 * are not text at all. Every file in the tree passes at the commit that
 * widened it, so nothing was grandfathered in.
 *
 * `test/arch.spec.ts` excludes itself: this file IS the denylist source and
 * has to spell the banned words out in order to grep for them.
 */
function trackedTextFiles(): string[] {
  // s9 Sc 1 row 1: `.svg` is OFF this list. It was put on it in s7 as a "not
  // text" extension, which is wrong twice — an SVG is XML, and the ship era
  // commits more of them than the GUI era did. A repository that bans
  // operator identity in every file except the ones shaped like pictures
  // has a hole exactly the shape of a picture.
  const notText = /\.(bin|blob|db|png|ico|jpg|jpeg|gif|pdf|zip|woff2?)$/;
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.length > 0)
    .filter((f) => !notText.test(f))
    .filter((f) => f !== 'test/arch.spec.ts');
}

/**
 * Every top-level directory git tracks anything in.
 *
 * Added by s7 Sc11 so that the tree-wide sweeps stop keying off hand-written
 * root lists. `skills/` is the cautionary tale: Sc 10 created it and had to
 * REMEMBER to add it to the control-byte sweep's `roots`, and nothing would
 * have failed if it had not. A guard that has to be told about a directory
 * is a guard with a hole the size of the next directory somebody adds, and
 * Sc 1 settled that guards key off structure.
 */
function topLevelTrackedDirs(): string[] {
  const dirs = new Set<string>();
  for (const f of execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).split('\n')) {
    const slash = f.indexOf('/');
    if (slash > 0) dirs.add(f.slice(0, slash));
  }
  return [...dirs].sort();
}

/**
 * Everything in anything git tracks that a PUBLIC repository must not carry.
 *
 * Hoisted to module scope by s7 Sc7 so that the row asserting it is clean
 * (S3 (d)) and the teeth proving it BITES on the file types Sc7 introduces
 * can be the same code. A sweep and its teeth that share no implementation
 * are two guards, and only one of them is the one that runs on CI.
 *
 * WIDENED AND MOVED BY s7 Sc11. The predicates now live in
 * `packages/cli/test/helpers/transcript-lint.ts`, because Sc 11 needs the
 * identical question asked of a live CLI transcript and of every file under
 * `skills/`, and a second copy of "what must a public repo never say" is
 * the copy that goes stale. This function keeps the FILE WALK — which is
 * the half Sc 7's teeth actually exercise — and the offender strings are
 * byte-for-byte what they were, so those teeth did not have to change.
 *
 * Two arms are new: an adapter token (asked of Sc 6's `redactTokens`, not
 * restated) and an absolute home-directory path. Every tracked file passed
 * both at the commit that added them, so neither is grandfathered.
 */
function publicRepoOffenders(): string[] {
  const offenders: string[] = [];
  for (const f of trackedTextFiles()) {
    const content = readFileSync(join(repoRoot, f), 'utf8');
    for (const o of publicStringOffenders(content))
      offenders.push(`${f}: ${o.detail}`);
  }
  return offenders.sort();
}

/**
 * Production files permitted to MINT `reason: 'auto-respond'` — the actor a
 * machine wears when it approves a draft on the operator's behalf.
 *
 * Seeded by s4-execution Scenario 1 guard (c) at ONE path: the `Actor`
 * union's own declaration, because naming a literal in a type is not
 * minting a value.
 *
 * GROWN TO TWO by s6-execution Scenario 1 (C-11, F-74). S6 is the slice
 * that mints it, and the natural move — deleting the guard — would be the
 * wrong one: the guard's value was never that the literal appears nowhere,
 * it is that the literal appears in exactly ONE place, so "where can this
 * system decide to speak on my behalf" has a single-file answer forever.
 * `sending/auto-approve.ts` is that place, and it stays that place.
 *
 * Read by TWO rows, deliberately: S4 (c) ("nothing outside this list mints")
 * and S6 (a) ("this list is exactly these two files, and both exist").
 */
const AUTO_RESPOND_MINT_ALLOWLIST: readonly string[] = [
  'packages/core/src/domain/types.ts',
  'packages/core/src/sending/auto-approve.ts',
];

interface CruiseSummary {
  modules: Array<{ source: string }>;
  summary: {
    error: number;
    violations: Array<{ rule: { name: string }; from: string; to: string }>;
  };
}

/*
 * s9 Sc2, ratified item 1 — the budget for a row that spawns `depcruise`.
 *
 * Measured on this tree at b492282. `packages apps fixtures` is 790 modules;
 * `pnpm dep:check` adds `tools` for 799 modules and 2388 dependencies. (An
 * earlier draft of this comment said 782/791/2344. Those numbers were never
 * on this tree: see the re-measurement below, taken with the same binary and
 * the same config.)
 *
 *   full-tree cruise, `packages apps fixtures`, quiet machine, 5 runs:
 *       1160  1170  1190  1190  1210 ms   (790 modules every run)
 *   the same command on an earlier, busier session, 5 isolated runs:
 *       1367  1369  1376  1394  1422 ms
 *   the same command under ordinary load (load average 18-35), 13 runs:
 *       3107 3268 3413 4112 4222 4226 4434 4584 4753 5183 5336 7021 8905 ms
 *   inside the full suite, worst row observed:
 *       4890 ms  (`reports zero violations on the scaffold`)
 *   cheapest cruise in this file, `packages/sendkit` at 38 modules, 5 runs:
 *        450   450   450   450   450 ms   (629 ms on the busier session)
 *   a genuine no-op, an empty root, 3 runs:
 *        400   400   410 ms   (0 modules)
 *
 * vitest's per-test default is 5000 ms. It sat 110 ms above the worst
 * in-suite measurement and 3905 ms below the worst isolated one, which is
 * why these rows have been green-or-timeout for six slices: nobody chose
 * that number, it is what you get for not choosing.
 *
 * AND THEN THE SAME ROW RAN SOMEWHERE ELSE.
 *
 * Every number above was taken on a developer laptop. The hosted macOS
 * runner is a 3-vCPU virtual machine with a cold filesystem cache, and it
 * runs this cruise while vitest's other forks are competing for those three
 * cores. Six observations of `reports zero violations on the scaffold`,
 * sorted by duration rather than by date, each the row's own reported
 * total:
 *
 *   12301 ms  run 34346002664
 *   15216 ms  run 34356051222
 *   17909 ms  run 34348016549
 *   23186 ms  run 34357757135
 *   24202 ms  run 34319438457
 *   32958 ms  run 34360873292   FAILED: cruise 32779 ms, ceiling 26715 ms
 *
 * The Linux lane is not exempt, only luckier. The same row on
 * `ubuntu-24.04`, three consecutive runs:
 *
 *   17456 ms  run 34357757037
 *   18888 ms  run 34357089607
 *   19947 ms  run 34360873154
 *
 * All three passed, and all three sat within 34% of the old ceiling. The
 * split below is not a macOS patch; it is the CI lane's number.
 *
 * The worst hosted-macOS observation is 3.7x the worst measurement this
 * laptop has ever produced, and the spread across those six is 2.7x on
 * runners of the same type within a day. THE TREE IS NOT THE VARIABLE:
 * `git ls-files packages apps fixtures`, filtered exactly as
 * `minModulesFor` filters, returns 242 non-spec TypeScript files at
 * b492282, at the S8 close a292dc5, and at this commit. Not one file
 * either way. The budget is not being raised because the
 * cruise got more expensive; it is being raised because the measurement it
 * was derived from was taken on the wrong machine.
 *
 * So there are two measurements now, and the ratchet applies to each in its
 * own place. The laptop keeps the tight one, which is where a real cost
 * regression would be caught first and caught hardest; CI gets the one its
 * own hardware justifies. A single global ceiling wide enough for a hosted
 * runner would be 98s, and a 5x regression on this laptop would sail under
 * it in silence. That is the opposite of what this constant is for.
 */

/**
 * The worst cruise ever measured on this tree. Not a budget: a measurement.
 * Raising it means pasting the run that justified it into the block above.
 */
const CRUISE_WORST_MEASURED_MS = 8_905;
/**
 * The worst cruise ever measured on a hosted macOS runner: the cruise inside
 * the row that failed on run 34360873292. Same rule as its sibling above,
 * and the same obligation: raising it means pasting the run that justified
 * it into the block above, with its id.
 */
const CRUISE_WORST_MEASURED_CI_MS = 32_779;
/** The cheapest cruise in this file, `packages/sendkit` at 38 modules. */
const CRUISE_CHEAPEST_MEASURED_MS = 450;
/**
 * The ratified margin, the same one Sc8 used for its checkpoint and Sc15 for
 * its keystroke ratchet: a bound is a MEASUREMENT times three, in whichever
 * direction the bound points. Keeping the factor as a named constant is the
 * point of the exercise: a later slice cannot widen the budget by editing a
 * literal, it has to move the measurement the literal is derived from.
 *
 * Applying 3x to the QUIET floor instead of to the worst case would give
 * 3570 ms, below eleven of the thirteen loaded measurements above — that
 * converts a flake into a certain failure, so the multiplier is applied to
 * the measurement the row actually has to survive.
 */
const CRUISE_RATCHET_FACTOR = 3;
/**
 * A CEILING, not a cost: on this laptop the rows still finish in seconds.
 *
 * `CI` rather than a darwin check or a runner-name sniff, because the
 * property that moves the number is "three shared vCPUs and a cold cache",
 * and that is what every CI provider has in common and what no developer
 * machine here has. GitHub Actions sets `CI=true` on every runner.
 */
const CRUISE_BUDGET_MS =
  (process.env['CI'] === undefined
    ? CRUISE_WORST_MEASURED_MS
    : CRUISE_WORST_MEASURED_CI_MS) * CRUISE_RATCHET_FACTOR;
/*
 * And the other end — with a caveat this file is required to state, because
 * the ratified shape was "assert a lower bound so a run that beats the floor
 * is read as a broken measurement rather than a win", and for THIS tool a
 * time bound cannot carry that weight. A genuine no-op (empty root, zero
 * modules) costs 400 ms of node startup and config load, which is ABOVE any
 * floor that leaves headroom under the 450 ms cheapest real cruise. There is
 * no time threshold that separates "did no work" from "did the cheapest
 * work" here.
 *
 * So this floor is the weak half: it catches a cruise that never spawned at
 * all. The half that actually bites is `minModulesFor` below, which reads
 * the no-op at 0 modules against a floor of 181 and fails it by 181.
 */
const CRUISE_NOOP_FLOOR_MS = Math.floor(
  CRUISE_CHEAPEST_MEASURED_MS / CRUISE_RATCHET_FACTOR,
);

/**
 * Lower bound on the modules a cruise of these roots must visit, derived from
 * the tracked sources under them rather than pinned. 80% because dependency-
 * cruiser also reports node_modules edges (which only ever ADD) while the
 * config may exclude a file or two (which only ever subtract a handful).
 */
function minModulesFor(paths: string[]): number {
  const tracked = execFileSync('git', ['ls-files', '--', ...paths], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .split('\n')
    .filter(
      (f) =>
        /\.tsx?$/.test(f) && !/\.spec\.tsx?$/.test(f) && !/\.d\.ts$/.test(f),
    );
  return Math.max(1, Math.ceil(tracked.length * 0.8));
}

function cruise(paths: string[]): CruiseSummary {
  // --output-type json always exits per violations; capture stdout regardless.
  let stdout: string;
  const startedAt = Date.now();
  try {
    stdout = execFileSync(
      depcruiseBin,
      [
        ...paths,
        '--config',
        '.dependency-cruiser.cjs',
        '--output-type',
        'json',
      ],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    const err = e as { stdout?: string };
    if (!err.stdout) throw e;
    stdout = err.stdout;
  }
  const elapsed = Date.now() - startedAt;
  const result = JSON.parse(stdout) as CruiseSummary;
  // The three ways a cruise can lie about having happened: too fast, too
  // slow, or too small. Every caller inherits all three.
  expect(
    elapsed,
    `cruise of ${paths.join(' ')} returned in ${elapsed}ms; that is faster ` +
      'than reading the tree takes, so it did not read the tree',
  ).toBeGreaterThanOrEqual(CRUISE_NOOP_FLOOR_MS);
  expect(
    elapsed,
    `cruise of ${paths.join(' ')} took ${elapsed}ms, past the measured budget`,
  ).toBeLessThanOrEqual(CRUISE_BUDGET_MS);
  expect(
    result.modules.length,
    `cruise of ${paths.join(' ')} visited ${result.modules.length} modules`,
  ).toBeGreaterThanOrEqual(minModulesFor(paths));
  return result;
}

describe('arch invariants (dependency-cruiser)', () => {
  it(
    'reports zero violations on the scaffold (INV-1 + §3.1 arrows)',
    () => {
      const result = cruise(['packages', 'apps', 'fixtures']);
      expect(result.summary.violations).toEqual([]);
      expect(result.summary.error).toBe(0);
    },
    CRUISE_BUDGET_MS,
  );

  describe('proven teeth', () => {
    const probe = join(repoRoot, 'packages/core/src/__arch_teeth_probe__.ts');

    afterEach(() => {
      rmSync(probe, { force: true });
    });

    it(
      'flags a planted core -> store import (core-no-internal-deps)',
      () => {
        writeFileSync(
          probe,
          // Relative path so resolution cannot silently fail: core has no
          // package.json dep on store (that is the point of INV-1).
          "import '../../store/src/index.js';\nexport {};\n",
        );
        const result = cruise(['packages/core']);
        const names = result.summary.violations.map((v) => v.rule.name);
        expect(names).toContain('core-no-internal-deps');
        expect(result.summary.error).toBeGreaterThan(0);
      },
      CRUISE_BUDGET_MS,
    );

    it(
      'flags a planted core -> node:fs I/O builtin import (core-no-node-io-builtins)',
      () => {
        writeFileSync(probe, "import 'node:fs';\nexport {};\n");
        const result = cruise(['packages/core']);
        const names = result.summary.violations.map((v) => v.rule.name);
        expect(names).toContain('core-no-node-io-builtins');
      },
      CRUISE_BUDGET_MS,
    );
  });

  /**
   * S2 Scenario 1 — arch rules extended (s2-execution §1.2, Part 2 Scenario 1).
   *
   *  (a) the INV-1 rules still pass with the core/rules + core/audit sources
   *      cruised (they are stubs until Scenarios 2-4, but the modules must be
   *      in the cruise so later implementation cannot dodge the rules);
   *  (b) proven teeth for the §1.2 closed dependency list: a planted core
   *      import of `re2` / `ulid` IS reported. Neither resolves from core
   *      (pnpm isolation + core has zero runtime deps), so `core-no-io`
   *      (^node_modules) alone structurally cannot see them — the
   *      `core-no-unresolvable-imports` rule closes that hole;
   *  (c) `node:crypto` from core/audit is NOT reported — pins the §1.2
   *      reading of `core-no-node-io-builtins` (sha256 is pure and
   *      deliberately off the ban list; `randomBytes`-style entropy use is a
   *      review-level catch, per the INV-1 "ulid at the I/O edge" precedent);
   *  (d) append-only audit by construction (§2.3): no tracked non-test file
   *      contains an UPDATE/DELETE against `audit_log` — including
   *      packages/store/src itself. Test dirs are exempt (the Scenario 6
   *      tamper harness lives in packages/store/test by design, s2 §3.2 #4).
   */
  describe('S2 extensions (s2-execution Scenario 1)', () => {
    it(
      'cruises the core rules/audit sources under the INV-1 rules (a)',
      () => {
        const result = cruise(['packages', 'apps', 'fixtures']);
        const sources = result.modules.map((m) => m.source);
        expect(sources).toContain('packages/core/src/rules/index.ts');
        expect(sources).toContain('packages/core/src/audit/index.ts');
        expect(result.summary.violations).toEqual([]);
      },
      CRUISE_BUDGET_MS,
    );

    describe('proven teeth: closed dependency list (b)', () => {
      const probe = join(
        repoRoot,
        'packages/core/src/__arch_s2_teeth_probe__.ts',
      );

      afterEach(() => {
        rmSync(probe, { force: true });
      });

      it(
        'flags a planted core -> re2 import (core-no-unresolvable-imports)',
        () => {
          writeFileSync(probe, "import 're2';\nexport {};\n");
          const result = cruise(['packages/core']);
          const names = result.summary.violations.map((v) => v.rule.name);
          expect(names).toContain('core-no-unresolvable-imports');
          expect(result.summary.error).toBeGreaterThan(0);
        },
        CRUISE_BUDGET_MS,
      );

      it(
        'flags a planted core -> ulid import (core-no-unresolvable-imports)',
        () => {
          writeFileSync(probe, "import 'ulid';\nexport {};\n");
          const result = cruise(['packages/core']);
          const names = result.summary.violations.map((v) => v.rule.name);
          expect(names).toContain('core-no-unresolvable-imports');
          expect(result.summary.error).toBeGreaterThan(0);
        },
        CRUISE_BUDGET_MS,
      );
    });

    describe('node:crypto is legal in core (c)', () => {
      const probe = join(
        repoRoot,
        'packages/core/src/audit/__arch_crypto_probe__.ts',
      );

      afterEach(() => {
        rmSync(probe, { force: true });
      });

      it(
        'does not flag a core/audit -> node:crypto import',
        () => {
          writeFileSync(
            probe,
            "import { createHash } from 'node:crypto';\n" +
              'export const sha256hex = (s: string): string =>\n' +
              "  createHash('sha256').update(s, 'utf8').digest('hex');\n",
          );
          const result = cruise(['packages/core']);
          expect(result.summary.violations).toEqual([]);
          expect(result.summary.error).toBe(0);
        },
        CRUISE_BUDGET_MS,
      );
    });

    it('append-only audit_log by construction: no UPDATE/DELETE anywhere outside test dirs (d)', () => {
      const tracked = execFileSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0)
        // Test dirs only: the Scenario 6 tamper harness (packages/store/test)
        // and this spec are the sole legitimate homes for these strings.
        .filter((f) => !/(^|\/)test\//.test(f))
        // Text-ish sources only; skip binary fixture blobs.
        .filter((f) => !/\.(bin|blob|db|png|ico|svg)$/.test(f));

      const forbidden = /(UPDATE|DELETE\s+FROM)\s+audit_log/i;
      const offenders = tracked.filter((f) =>
        forbidden.test(readFileSync(join(repoRoot, f), 'utf8')),
      );
      expect(offenders).toEqual([]);
    });
  });

  /**
   * S3 Scenario 1 — architecture guards for the send era (s3-execution
   * §1.4 checklist + Part 2 Scenario 1). Structural-only: no production
   * code lands this scenario.
   *
   * (a) `osascript` (the string) is confined to packages/sendkit/src — the
   *     one place S3 is allowed to shell out to Messages.
   * (b) no test/fixture file spawns a REAL osascript or names the LIVE
   *     chat.db path — S3's "no real iMessages in any test, ever" rule
   *     (§ Non-negotiables #2) made structural, not just a review norm.
   * (c) dependency-cruiser re-proof, sendkit-specific: sendkit may import
   *     node:child_process (it needs execFile for osascript); core may not
   *     (core-no-node-io-builtins, already proven for node:fs in the S1
   *     block above — this re-proves it for the exact builtin sendkit uses).
   * (d) public-repo sweep (§ Non-negotiables #3): no brand string, no +1
   *     number outside the +15550/+15551/+15555 fiction blocks the fixture
   *     corpus already uses (test/store/core specs), across every tracked
   *     source/test/fixture file. Kept forever per the spec's own wording.
   *
   * SPEC ADAPTATION: the spec's teeth wording says "plant osascript in
   * packages/daemon/src/doctor.ts" — doctor.ts does not exist until
   * Scenario 7. A scratch probe file under packages/daemon/src/ (same
   * convention as the S1/S2 __arch_*_probe__.ts files above) stands in;
   * the property being proven (a daemon-side production file mentioning
   * osascript is caught) is identical.
   */
  describe('S3 extensions (s3-execution Scenario 1: send-era guards)', () => {
    const skipDirs = new Set([
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
    ]);
    const binaryIsh = /\.(bin|blob|db|png|ico|svg)$/;
    const codeIsh = /\.(ts|tsx|js|mjs|cjs)$/;

    function listFiles(root: string): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (skipDirs.has(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(root);
      return out;
    }

    const relOf = (abs: string): string =>
      abs.slice(repoRoot.length + 1).replace(/\\/g, '/');

    // (a) production source = packages/*/src or apps/*/src, dist excluded.
    function osascriptOutsideSendkit(): string[] {
      const roots = ['packages', 'apps'].map((p) => join(repoRoot, p));
      return roots
        .flatMap((r) => listFiles(r))
        .map(relOf)
        .filter((f) => /^(packages|apps)\/[^/]+\/src\//.test(f))
        .filter((f) => codeIsh.test(f))
        .filter((f) => !f.startsWith('packages/sendkit/src/'))
        .filter((f) =>
          /osascript/.test(readFileSync(join(repoRoot, f), 'utf8')),
        );
    }

    // (b) test/fixture trees: no real osascript spawn, no live chat.db path.
    function realOsascriptOrLiveChatDbOffenders(): string[] {
      const roots = [
        ...listFiles(join(repoRoot, 'packages')),
        ...listFiles(join(repoRoot, 'apps')),
        ...listFiles(join(repoRoot, 'fixtures')),
      ]
        .map(relOf)
        .filter(
          (f) => /(^|\/)(test|fixtures)\//.test(f) || f.startsWith('fixtures/'),
        )
        .filter((f) => codeIsh.test(f) && !binaryIsh.test(f));
      return roots.filter((f) => {
        const content = readFileSync(join(repoRoot, f), 'utf8');
        return (
          /(execFile|spawn)\(\s*['"]osascript/.test(content) ||
          content.includes('Library/Messages/chat.db')
        );
      });
    }

    it('(a) osascript appears in production source only under packages/sendkit/src', () => {
      expect(osascriptOutsideSendkit()).toEqual([]);
    });

    it('(b) no test/fixture file spawns real osascript or names the live chat.db path', () => {
      expect(realOsascriptOrLiveChatDbOffenders()).toEqual([]);
    });

    describe('(c) sendkit may use node builtins; core may not (re-proof, node:child_process)', () => {
      const sendkitProbe = join(
        repoRoot,
        'packages/sendkit/src/__arch_s3_teeth_probe__.ts',
      );
      const coreProbe = join(
        repoRoot,
        'packages/core/src/__arch_s3_teeth_probe__.ts',
      );

      afterEach(() => {
        rmSync(sendkitProbe, { force: true });
        rmSync(coreProbe, { force: true });
      });

      it(
        'sendkit -> node:child_process cruises clean',
        () => {
          writeFileSync(
            sendkitProbe,
            "import 'node:child_process';\nexport {};\n",
          );
          const result = cruise(['packages/sendkit']);
          expect(result.summary.violations).toEqual([]);
          expect(result.summary.error).toBe(0);
        },
        CRUISE_BUDGET_MS,
      );

      it(
        'the identical import from core is flagged (core-no-node-io-builtins)',
        () => {
          writeFileSync(
            coreProbe,
            "import 'node:child_process';\nexport {};\n",
          );
          const result = cruise(['packages/core']);
          const names = result.summary.violations.map((v) => v.rule.name);
          expect(names).toContain('core-no-node-io-builtins');
          expect(result.summary.error).toBeGreaterThan(0);
        },
        CRUISE_BUDGET_MS,
      );
    });

    it('(d) public-repo sweep: no brand strings, no +1 numbers outside the +1555 fiction block', () => {
      expect(publicRepoOffenders()).toEqual([]);
    });

    describe('proven teeth', () => {
      const daemonProbe = join(
        repoRoot,
        'packages/daemon/src/__arch_s3_teeth_probe__.ts',
      );
      const fixtureProbeDir = join(repoRoot, 'fixtures/test/__s3_teeth__');
      const fixtureProbe = join(fixtureProbeDir, 'probe.spec.ts');

      afterEach(() => {
        rmSync(daemonProbe, { force: true });
        rmSync(fixtureProbeDir, { recursive: true, force: true });
      });

      it('planting osascript in a daemon-side production file fails gate (a)', () => {
        writeFileSync(
          daemonProbe,
          "export const cmd = 'osascript -e tell app Messages';\n",
        );
        expect(osascriptOutsideSendkit()).toContain(
          'packages/daemon/src/__arch_s3_teeth_probe__.ts',
        );
      });

      it('planting a live chat.db path in a fixture file fails gate (b)', () => {
        mkdirSync(fixtureProbeDir, { recursive: true });
        writeFileSync(
          fixtureProbe,
          "export const p = '~/Library/Messages/chat.db';\n",
        );
        expect(realOsascriptOrLiveChatDbOffenders()).toContain(
          'fixtures/test/__s3_teeth__/probe.spec.ts',
        );
      });
    });
  });

  /**
   * S4 Scenario 1 — arch guards for the approval era (s4-execution Part 2
   * Scenario 1). Ratchet snapshot: asserts the current baseline holds, no
   * growth yet. Structural-only: no production code lands this scenario.
   *
   * (a) `SendBackend`/`ChatDbReader` are mentioned in production src by
   *     exactly the 13 S3 files plus s5 Scenario 6's `adapters/dispatch.ts`
   *     (F-46, ratchet update #16) — the send/scheduler surface must stay
   *     funneled through `dispatchApproved`; a new caller (e.g. a scheduler
   *     reaching around it straight to `SendBackend`) grows this list and
   *     must be reviewed here, not discovered later.
   * (b) grep gate: no production file computes a `setTimeout` horizon from
   *     `expiresAt`/`sendNotBefore` (the constraint-4 tripwire — S4's grace
   *     scheduler is not built yet; when it is, this test is the reviewer).
   * (c) grep gate: the literal `'auto-respond'` never appears as a minted
   *     actor reason in production src — S4 ships no autonomy. The one
   *     legitimate home for the string is the `Actor` union's own type
   *     declaration (`domain/types.ts`), which is exempted: declaring the
   *     type is not minting a value.
   * (d) public-repo + no-green sweeps: no new tests here, they already exist
   *     ((d) above, and the CLI specs' ANSI-absence checks) — re-pinned by
   *     the full gate run this scenario's commit requires.
   */
  describe('S4 extensions (s4-execution Scenario 1: approval-era guards)', () => {
    const skipDirs = new Set([
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
    ]);
    const codeIsh = /\.(ts|tsx|js|mjs|cjs)$/;

    function listFiles(root: string): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (skipDirs.has(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(root);
      return out;
    }

    const relOf = (abs: string): string =>
      abs.slice(repoRoot.length + 1).replace(/\\/g, '/');

    function productionSrcFiles(): string[] {
      const roots = ['packages', 'apps'].map((p) => join(repoRoot, p));
      return roots
        .flatMap((r) => listFiles(r))
        .map(relOf)
        .filter((f) => /^(packages|apps)\/[^/]+\/src\//.test(f))
        .filter((f) => codeIsh.test(f));
    }

    // (a) importer allowlist: exactly these 15 files mention SendBackend or
    // ChatDbReader in production source — the 13-file S3 baseline (841cd27)
    // plus the two deliberate s5 additions (Scenario 6's F-46 and Scenario
    // 9's F-50) below.
    const SEND_BACKEND_CHAT_DB_READER_BASELINE = [
      'packages/core/src/drafts/recovery.ts',
      'packages/core/src/ports/index.ts',
      'packages/core/src/sending/dispatcher.ts',
      // s5 Scenario 6 (F-46), the ONE deliberate growth of this list in S5:
      // `adapters/dispatch.ts` reads conversation context through
      // `ChatDbReader.readChatTurns`. Reviewed here, in the same commit as
      // the file that joins it, exactly as this guard intends.
      'packages/daemon/src/adapters/dispatch.ts',
      // s5 Scenario 9 (F-50), the second deliberate growth of this list in
      // S5: `adapters/submit.ts` turns a proactive `{handle}` target into a
      // conversation through `ChatDbReader.resolveChat`, availability-only.
      // It holds `Pick<ChatDbReader, 'resolveChat'>` and no SendBackend:
      // nothing in that file can put a message on the wire.
      'packages/daemon/src/adapters/submit.ts',
      'packages/daemon/src/daemon.ts',
      'packages/daemon/src/main.ts',
      'packages/daemon/src/routes/send.ts',
      'packages/daemon/src/server.ts',
      'packages/ingest/src/chatdb/index.ts',
      'packages/ingest/src/index.ts',
      'packages/ingest/src/scan/index.ts',
      'packages/sendkit/src/applescript.ts',
      'packages/sendkit/src/index.ts',
      'packages/sendkit/src/verify.ts',
    ].sort();

    function sendBackendChatDbReaderImporters(): string[] {
      // Substring, not word-boundary: derived types/values like
      // `ChatDbReaderOptions` and `createChatDbReader` count as "mentions"
      // of the surface too (that is how the 13-file S3 baseline was
      // computed) — narrowing to the bare identifiers undercounts it.
      return productionSrcFiles()
        .filter((f) => {
          const content = readFileSync(join(repoRoot, f), 'utf8');
          return (
            content.includes('SendBackend') || content.includes('ChatDbReader')
          );
        })
        .sort();
    }

    /**
     * (b) no production file computes a setTimeout horizon from
     * expiresAt/sendNotBefore. Still a heuristic, not a dataflow check.
     *
     * NARROWED in s4 Scenario 11. The check was "both strings appear anywhere
     * in the same file", which cannot tell a scheduled horizon from a file
     * that happens to do both unrelated things. packages/cli/src/bin.ts now
     * prints `sendNotBefore` as a field label in `drafts show` and, 200 lines
     * away, polls `batchReport` on a FIXED 100ms interval (F-37) — no deadline
     * is derived from anything. Widening the guard's blind spot to keep that
     * file quiet would have been the wrong repair; instead the guard now
     * requires PROXIMITY, because deriving a horizon and passing it to
     * setTimeout is by nature local: you compute the delta and schedule it in
     * the same handful of lines. The (b) teeth probe below plants exactly that
     * shape and still trips it.
     */
    const HORIZON_WINDOW_LINES = 5;
    function computedHorizonSetTimeoutOffenders(): string[] {
      return productionSrcFiles().filter((f) => {
        const lines = readFileSync(join(repoRoot, f), 'utf8').split('\n');
        return lines.some((line, i) => {
          if (!line.includes('setTimeout')) return false;
          const from = Math.max(0, i - HORIZON_WINDOW_LINES);
          const window = lines.slice(from, i + HORIZON_WINDOW_LINES + 1);
          return window.some((w) => /(expiresAt|sendNotBefore)/.test(w));
        });
      });
    }

    // (c) 'auto-respond' as a minted actor reason: everywhere except the
    // files on AUTO_RESPOND_MINT_ALLOWLIST (module scope). That list was the
    // single Actor-union declaration through S5 and grew to two in
    // s6-execution Scenario 1, when `sending/auto-approve.ts` became the one
    // legitimate mint site (C-11, F-74). This row's meaning is unchanged:
    // nothing OUTSIDE the list mints the reason.

    /**
     * NARROWED in s4 Scenario 4. The check was a bare substring match for
     * `'auto-respond'`, which cannot tell MINTING the reason (constructing an
     * auto actor — the thing S4 must not ship) from READING it (comparing
     * against it in order to REFUSE an auto approval, which is the opposite
     * of shipping autonomy, and is exactly what dispatchApproved now does).
     * The guard's own name says "minted", so it now matches the minting
     * syntax: `reason: 'auto-respond'` in an object literal. The (c) teeth
     * probe below mints precisely that shape and still trips it.
     */
    function autoRespondMintedOffenders(): string[] {
      return productionSrcFiles()
        .filter((f) => !AUTO_RESPOND_MINT_ALLOWLIST.includes(f))
        .filter((f) =>
          /reason:\s*'auto-respond'/.test(
            readFileSync(join(repoRoot, f), 'utf8'),
          ),
        );
    }

    it('(a) SendBackend/ChatDbReader importers match the 15-file S3+S5 baseline exactly', () => {
      expect(sendBackendChatDbReaderImporters()).toEqual(
        SEND_BACKEND_CHAT_DB_READER_BASELINE,
      );
    });

    it('(b) no production file derives a setTimeout horizon from expiresAt/sendNotBefore', () => {
      expect(computedHorizonSetTimeoutOffenders()).toEqual([]);
    });

    it("(c) 'auto-respond' is not minted as an actor reason outside its type declaration", () => {
      expect(autoRespondMintedOffenders()).toEqual([]);
    });

    describe('proven teeth', () => {
      const schedulerProbe = join(
        repoRoot,
        'packages/daemon/src/__arch_s4_scheduler_probe__.ts',
      );
      const horizonProbe = join(
        repoRoot,
        'packages/core/src/__arch_s4_horizon_probe__.ts',
      );
      const autoRespondProbe = join(
        repoRoot,
        'packages/core/src/__arch_s4_auto_respond_probe__.ts',
      );

      afterEach(() => {
        rmSync(schedulerProbe, { force: true });
        rmSync(horizonProbe, { force: true });
        rmSync(autoRespondProbe, { force: true });
      });

      it('planting a SendBackend import in a scratch scheduler.ts grows the allowlist (a)', () => {
        writeFileSync(
          schedulerProbe,
          "import type { SendBackend } from '@wemessage/core';\nexport type Probe = SendBackend;\n",
        );
        const found = sendBackendChatDbReaderImporters();
        expect(found).toContain(
          'packages/daemon/src/__arch_s4_scheduler_probe__.ts',
        );
        expect(found).not.toEqual(SEND_BACKEND_CHAT_DB_READER_BASELINE);
      });

      it('planting a setTimeout keyed off expiresAt fails the horizon gate (b)', () => {
        writeFileSync(
          horizonProbe,
          'export function arm(expiresAt: number): void {\n' +
            '  setTimeout(() => {}, expiresAt - Date.now());\n' +
            '}\n',
        );
        expect(computedHorizonSetTimeoutOffenders()).toContain(
          'packages/core/src/__arch_s4_horizon_probe__.ts',
        );
      });

      it("planting a minted 'auto-respond' actor reason fails the autonomy gate (c)", () => {
        writeFileSync(
          autoRespondProbe,
          "export const actor = { kind: 'system', reason: 'auto-respond' } as const;\n",
        );
        expect(autoRespondMintedOffenders()).toContain(
          'packages/core/src/__arch_s4_auto_respond_probe__.ts',
        );
      });
    });
  });

  /**
   * s5-execution Scenario 1 — arch guards for the agent era.
   *
   * The adapter surface is the first place a third party's code reaches our
   * daemon, so the guards go in BEFORE the surface does. Two of the six rows
   * are deliberately narrower here than the slice's final form:
   *
   *  - (a) is source-scan only. The type-level witness (`Extract<AgentToGateway,
   *    {type:'send'}>` is `never`) needs the frame union, which lands in
   *    Scenario 2; putting a compile witness here would mean shipping the
   *    union in a scenario whose GREEN is "configs and a cruiser rule, no
   *    production logic". Scenario 2 owns the type half.
   *  - (e) pins the allowlist. It grew by exactly one file in Scenario 6
   *    (F-46, ratchet update #16 — `packages/daemon/src/adapters/dispatch.ts`),
   *    as a deliberate reviewed diff, and by nothing since.
   */
  describe('S5 extensions (s5-execution Scenario 1: agent-era guards)', () => {
    // Local file-walk helpers. The S3 block has equivalents, but they are
    // scoped to that describe; duplicating six lines beats hoisting shared
    // mutable state across four slices' worth of guards.
    const S5_SKIP = new Set([
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
    ]);
    const codeIsh = /\.(ts|tsx|js|mjs|cjs)$/;
    function listFiles(root: string): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (S5_SKIP.has(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(root);
      return out;
    }
    const relOf = (abs: string): string =>
      abs.slice(repoRoot.length + 1).replace(/\\/g, '/');

    const ADAPTER_PACKAGES = [
      'packages/adapters/echo',
      'packages/adapters/hermes',
      'packages/adapters/luna',
      'packages/adapters/openclaw',
      'packages/adapters/sol',
      'packages/adapter-testkit',
    ];

    // (a) NO SEND FRAME. An adapter proposes; a human approves; the daemon
    // sends. A frame named anything like `send` would be the wire admitting
    // an agent can reach the send path directly, which is INV-2's whole
    // point. The scan looks at exported type/interface NAMES, not prose:
    // `draft.submit`'s doc comment says the word "send" and must stay legal.
    function sendishExportedTypeNames(): string[] {
      const protocolSrc = join(repoRoot, 'packages/protocol/src');
      return listFiles(protocolSrc)
        .filter((f) => codeIsh.test(f))
        .flatMap((f) => {
          const content = readFileSync(f, 'utf8');
          return [...content.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)]
            .map((m) => m[1] ?? '')
            .filter((name) => /send/i.test(name))
            .map((name) => `${relOf(f)}:${name}`);
        });
    }

    // (d) secret hygiene. A real shared secret in a fixture is a secret in
    // the public repo's history, and history is not something we can revoke.
    const SECRET_ASSIGN = /WS_SECRET\s*[=:]\s*['"`]([^'"`]*)['"`]/g;
    const PLACEHOLDER =
      /^(|test|test-secret|placeholder|changeme|<[^>]*>|\$\{[^}]*\})$/i;
    function realSecretAssignments(): string[] {
      const roots = ['packages', 'apps', 'test', 'fixtures'].map((p) =>
        join(repoRoot, p),
      );
      return roots
        .flatMap((r) => listFiles(r))
        .filter((f) => codeIsh.test(f))
        .flatMap((f) => {
          const content = readFileSync(f, 'utf8');
          return [...content.matchAll(SECRET_ASSIGN)]
            .filter((m) => !PLACEHOLDER.test(m[1] ?? ''))
            .map(() => relOf(f));
        });
    }

    it('(a) the protocol exports no send-shaped frame type name', () => {
      expect(sendishExportedTypeNames()).toEqual([]);
    });

    it(
      '(b) adapters are thin clients: protocol + client only',
      () => {
        const result = cruise(['packages', 'apps', 'fixtures']);
        expect(
          result.summary.violations.filter(
            (v) => v.rule.name === 'adapters-thin-clients',
          ),
        ).toEqual([]);
        // The rule must EXIST, not merely find nothing: an absent rule and a
        // satisfied rule look identical in a violations list.
        const config = readFileSync(
          join(repoRoot, '.dependency-cruiser.cjs'),
          'utf8',
        );
        expect(config).toContain("name: 'adapters-thin-clients'");
      },
      CRUISE_BUDGET_MS,
    );

    it(
      '(c) protocol keeps zero runtime deps and type-only core reach',
      () => {
        const result = cruise(['packages', 'apps', 'fixtures']);
        const names = result.summary.violations.map((v) => v.rule.name);
        expect(names).not.toContain('protocol-zero-runtime-deps');
        expect(names).not.toContain('protocol-core-type-only');
      },
      CRUISE_BUDGET_MS,
    );

    it('(d) no real WS_SECRET value is committed anywhere', () => {
      expect(realSecretAssignments()).toEqual([]);
    });

    // (e) the port allowlist pin lives in the S3 block, which already
    // asserts the exact baseline — 14 files since Scenario 6 grew it by
    // `adapters/dispatch.ts` (F-46). Restating it here would be a second copy
    // of the same list to keep in sync; one pin, one edit.

    it('(f) every adapter package and the testkit has a vitest project', () => {
      for (const pkg of ADAPTER_PACKAGES) {
        const config = join(repoRoot, pkg, 'vitest.config.ts');
        expect(
          readFileSync(config, 'utf8'),
          `${pkg}/vitest.config.ts`,
        ).toContain('name:');
      }
    });
  });

  /**
   * s6-execution Scenario 1 — arch guards for the autonomy era.
   *
   * S6 turns on exactly one new capability: a system actor may approve a
   * draft. These guards exist so that capability cannot spread. No
   * production logic lands this scenario; the only non-test file it creates
   * is `packages/core/src/sending/auto-approve.ts` as an `export {}` stub,
   * so row (a)'s allowlist is anchored to a real path (the S5 precedent:
   * adapter vitest configs landed before their bodies).
   *
   * (a) the auto-approve mint site is exactly one file — the deliberate
   *     narrowing of S4 guard (c) (C-11, F-74). The guard is NOT deleted:
   *     its allowlist grows from one path to exactly two and it still trips
   *     on a third. Its value was never "the literal appears nowhere", it is
   *     "the literal appears in ONE place", so that "where can this system
   *     decide to speak on my behalf" has a single-file answer forever.
   * (b) system approvals have exactly one writer: `insertApproval` never
   *     appears within 5 lines of a `kind: 'system'` actor outside
   *     `core/src/sending/auto-approve.ts` (the minter) and
   *     `store/src/store.ts` (the implementation). Proximity, not bare
   *     co-occurrence — the same narrowing S4 (b) already makes, for the
   *     same reason: a file may legitimately mention both, far apart.
   * (c) the port importer allowlist is unchanged at 15 files. S6 declares in
   *     advance that it will not grow: arming decides WHEN a system actor
   *     may approve, never how to reach `SendBackend` without a stored,
   *     validated `Approval`. This row failing at any point in the slice is
   *     a design error, not a ratchet update. It is pinned against the
   *     daemon ratchet's own `PORT_IMPORTER_ALLOWLIST` so the two copies of
   *     that list cannot drift; S4 (a) pins the same live scan against its
   *     own baseline, which makes byte-identity transitive.
   * (d) no horizon is derived from any S6 deadline. S4 guard (b)'s field
   *     list widens from (expiresAt|sendNotBefore) to also cover the four
   *     deadlines this slice introduces — `pauseUntil`, `circuitOpenedAt`,
   *     `armedUntil`, `windowClose` — inside the same 5-line proximity
   *     window. S4 (b) is left exactly as it is: this row is a superset that
   *     becomes the binding one, not an edit to a shipped guard.
   * (e) timezone math is `Intl`-only (F-57). No core file imports a date or
   *     timezone library and core still declares zero dependencies. Belt and
   *     braces over `core-no-unresolvable-imports`, which would catch a
   *     package import but not a vendored copy — testing the whole import
   *     SPECIFIER catches `./vendor/tzdata.js` too.
   * (f) public-repo sweep extended. The S3 (d) brand/phone sweep re-runs
   *     above, in this same file; this row adds the timezone pin — no file
   *     under packages/apps/fixtures/test names an IANA zone outside
   *     {UTC, America/Los_Angeles, Australia/Lord_Howe, Pacific/Chatham,
   *     Asia/Kolkata}. Those five are chosen for DST and half-hour-offset
   *     SHAPE, and pinning the set stops a future fixture from encoding
   *     where somebody lives. Scanned from the filesystem rather than
   *     `git ls-files` so an untracked probe is visible to the teeth.
   * (g) the five dormant deny literals are still dormant. `outside-window`,
   *     `rate-limited`, `circuit-open`, `loop-detected` and
   *     `sms-auto-forbidden` have been in the §3.2 union since S1 and have
   *     never been emitted. The expected sets below are explicit, and each
   *     owning scenario edits its own row in its own commit, so no literal
   *     can start being emitted silently. `audit/events.ts` appears in three
   *     of them because of the C-6 taxonomy pin in its header, which maps
   *     the wireframe's reason names onto exactly these values.
   */
  describe('S6 extensions (s6-execution Scenario 1: autonomy-era guards)', () => {
    // Local file-walk helpers, per the S5 block's precedent: duplicating six
    // lines beats hoisting shared mutable state across five slices of guards.
    const S6_SKIP = new Set([
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
    ]);
    const codeIsh = /\.(ts|tsx|js|mjs|cjs)$/;
    function listFiles(root: string): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (S6_SKIP.has(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(root);
      return out;
    }
    const relOf = (abs: string): string =>
      abs.slice(repoRoot.length + 1).replace(/\\/g, '/');
    const readOf = (rel: string): string =>
      readFileSync(join(repoRoot, rel), 'utf8');

    function productionSrcFiles(): string[] {
      const roots = ['packages', 'apps'].map((p) => join(repoRoot, p));
      return roots
        .flatMap((r) => listFiles(r))
        .map(relOf)
        .filter((f) => /^(packages|apps)\/[^/]+\/src\//.test(f))
        .filter((f) => codeIsh.test(f));
    }

    // (a) the mint site. AUTO_RESPOND_MINT_ALLOWLIST is declared at module
    // scope because the S4 (c) guard reads the same list — one list, one
    // edit, and the growth from one path to two shows up in a single hunk.
    function autoRespondMintOffenders(): string[] {
      return productionSrcFiles()
        .filter((f) => !AUTO_RESPOND_MINT_ALLOWLIST.includes(f))
        .filter((f) => /reason:\s*'auto-respond'/.test(readOf(f)))
        .sort();
    }

    // (b) system-approval writers. `store.ts` is the Store implementation
    // and is exempt as such; every other file that both writes an approval
    // and names a system actor within five lines is minting autonomy.
    const SYSTEM_APPROVAL_WRITERS: readonly string[] = [
      'packages/core/src/sending/auto-approve.ts',
      'packages/store/src/store.ts',
    ];
    const SYSTEM_ACTOR_WINDOW_LINES = 5;
    function systemApprovalWriterOffenders(): string[] {
      return productionSrcFiles()
        .filter((f) => !SYSTEM_APPROVAL_WRITERS.includes(f))
        .filter((f) => {
          const lines = readOf(f).split('\n');
          return lines.some((line, i) => {
            if (!line.includes('insertApproval')) return false;
            const from = Math.max(0, i - SYSTEM_ACTOR_WINDOW_LINES);
            const window = lines.slice(from, i + SYSTEM_ACTOR_WINDOW_LINES + 1);
            return window.some((w) => /kind:\s*'system'/.test(w));
          });
        })
        .sort();
    }

    // (c) same substring scan the S4 (a) baseline uses, re-run here against
    // the daemon ratchet's copy of the list.
    function sendBackendChatDbReaderImporters(): string[] {
      return productionSrcFiles()
        .filter((f) => {
          const content = readOf(f);
          return (
            content.includes('SendBackend') || content.includes('ChatDbReader')
          );
        })
        .sort();
    }

    // (d) S4 (b)'s shape, widened to every deadline S6 persists. All four
    // new names are horizons the slice stores in the DB precisely so that
    // no `setTimeout` ever holds one: a restart must not resurrect a stale
    // pause, circuit or window.
    const S6_HORIZON_FIELDS =
      /(expiresAt|sendNotBefore|pauseUntil|circuitOpenedAt|armedUntil|windowClose)/;
    const S6_HORIZON_WINDOW_LINES = 5;
    function s6ComputedHorizonOffenders(): string[] {
      return productionSrcFiles()
        .filter((f) => {
          const lines = readOf(f).split('\n');
          return lines.some((line, i) => {
            if (!line.includes('setTimeout') && !line.includes('setInterval')) {
              return false;
            }
            const from = Math.max(0, i - S6_HORIZON_WINDOW_LINES);
            const window = lines.slice(from, i + S6_HORIZON_WINDOW_LINES + 1);
            return window.some((w) => S6_HORIZON_FIELDS.test(w));
          });
        })
        .sort();
    }

    // (e) every import specifier, whatever the form: `from 'x'`, bare
    // `import 'x'`, dynamic `import('x')`, `require('x')`. Matching the
    // specifier (not the bare package name) is what makes a vendored copy
    // visible: `./vendor/tzdata.js` names tzdata in the specifier itself.
    const TZ_LIB_RE = /temporal|tzdata|luxon|date-fns|moment|dayjs/i;
    function importSpecifiers(content: string): string[] {
      const re =
        /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
      return [...content.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    }
    function coreTimezoneLibImporters(): string[] {
      return productionSrcFiles()
        .filter((f) => f.startsWith('packages/core/src/'))
        .filter((f) =>
          importSpecifiers(readOf(f)).some((s) => TZ_LIB_RE.test(s)),
        )
        .sort();
    }

    // (f) IANA zone strings. Only a quoted string whose first segment is a
    // real zone region counts, so repo paths and URL fragments cannot false
    // positive. This spec file is exempt: it is the denylist source and has
    // to spell the pinned set (and a probe zone) out to check for them.
    const PINNED_TIMEZONES = new Set([
      'UTC',
      'America/Los_Angeles',
      'Australia/Lord_Howe',
      'Pacific/Chatham',
      'Asia/Kolkata',
    ]);
    const IANA_ZONE_RE =
      /['"`]((?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)['"`]/g;
    function unpinnedTimezoneOffenders(): string[] {
      const roots = ['packages', 'apps', 'fixtures', 'test'].map((p) =>
        join(repoRoot, p),
      );
      return roots
        .flatMap((r) => listFiles(r))
        .map(relOf)
        .filter((f) => codeIsh.test(f) || f.endsWith('.json'))
        .filter((f) => f !== 'test/arch.spec.ts')
        .flatMap((f) =>
          [...readOf(f).matchAll(IANA_ZONE_RE)]
            .map((m) => m[1] ?? '')
            .filter((zone) => !PINNED_TIMEZONES.has(zone))
            .map((zone) => `${f}: ${zone}`),
        )
        .sort();
    }

    // (g) the dormant five, each with the explicit set of production files
    // allowed to name it TODAY. Sc 4/6/7/8/9 each edit their own row here,
    // in their own commit, as the literal starts being emitted. Claimed:
    // 'outside-window' (Sc 4/5), 'rate-limited' (Sc 6), 'circuit-open'
    // (Sc 7), 'loop-detected' (Sc 8), 'sms-auto-forbidden' (Sc 9). None is
    // dormant any longer, and the guard's job changes accordingly: it no
    // longer asks "has anyone started emitting these", it asks "is each one
    // still emitted from exactly the files we reviewed". A sixth reason
    // appearing in a seventh file is still a build failure.
    const DORMANT_DENY_LITERALS: ReadonlyArray<
      readonly [string, readonly string[]]
    > = [
      [
        'outside-window',
        [
          // s8 Scenario 13, and the reason it is a NEW home rather than a
          // deleted literal: the audit screen draws `gate.denied` rows, and
          // a denial an operator cannot read the reason for is a row that
          // tells them a refusal happened and nothing they can act on.
          // `derive/auditRows.ts` re-declares §1.6's twelve because INV-1
          // forbids the renderer a `@wemessage/core` dependency and the
          // client exports `GateDenyReason` as a TYPE with no runtime array
          // behind it — so this is a deliberate second projection, and this
          // scenario adds an arch row tying the twelve back to the union in
          // `packages/core/src/domain/types.ts` so the two cannot drift.
          'apps/desktop/src/renderer/derive/auditRows.ts',
          'packages/client/src/index.ts',
          'packages/core/src/audit/events.ts',
          'packages/core/src/domain/types.ts',
          // s6 Scenario 4, the FIRST deliberate edit to this row and the
          // first time any of the dormant five is emitted: `evaluateGate`
          // clamps a rule whose schedule is shut to 'draft-only' and records
          // the reason in `GateDecision.clampedBy` (F-64). A clamp is not a
          // denial — no `gate.denied` row is written for it — but the
          // LITERAL is now minted in production, which is exactly what this
          // guard exists to make visible. Rows for the other four stay at
          // their S1 shape until Sc 6/7/8/9 claim them one at a time.
          'packages/core/src/gate/index.ts',
          // s6 Scenario 10, the THIRD deliberate edit to this row and the
          // first time the literal is COMPARED rather than recorded: the
          // send-moment re-gate now rebuilds the draft's own context (F-59),
          // so a window that shut during the grace shows up here as
          // `clampedBy`. It is singled out by name because it is the one
          // clamp that does not fail the draft — F-72 returns it to
          // 'pending' — and telling it apart from the clamps that DO fail
          // requires spelling it. The literal still reaches the audit log
          // only through `clampedBy`; nothing new is minted. It sits above
          // the Scenario 5 entry despite arriving after it because the scan
          // returns paths sorted, not in the order the homes were claimed.
          'packages/core/src/sending/dispatcher.ts',
          // s6 Scenario 5, the SECOND deliberate edit: the inbound rule path
          // now consults the gate at the draft moment (F-60), and it must
          // read `clampedBy` to honour `rule.outsideWindow === 'ignore'` —
          // the one clamp the daemon turns into a refusal instead of a
          // narrowed mode. No new deny literal is minted; 'outside-window'
          // simply gains a second, deliberate home.
          'packages/daemon/src/adapters/dispatch.ts',
          // s6 Scenario 11, the FOURTH deliberate edit to this row: the
          // arming derivation names 'outside-window' as an `ArmingReason`,
          // which is a DIFFERENT union that happens to share four of its
          // words with this one. That overlap is the point — an operator
          // reading "outside-window" on their badge and "outside-window" in
          // an audit row is reading about the same shut window — and it is
          // also exactly the kind of coincidence this guard exists to keep
          // visible, because the day the two vocabularies diverge, one of
          // these two files will be wrong and nothing else would notice.
          //
          // Note what does NOT appear: `packages/protocol/src/index.ts`
          // carries the `arming.changed` frame and its reason field, and
          // references the `ArmingReason` TYPE rather than spelling the
          // literals, precisely so the vocabulary has two homes and not
          // three.
          'packages/daemon/src/arming.ts',
        ],
      ],
      [
        'rate-limited',
        [
          // s8 Scenario 13, and the reason it is a NEW home rather than a
          // deleted literal: the audit screen draws `gate.denied` rows, and
          // a denial an operator cannot read the reason for is a row that
          // tells them a refusal happened and nothing they can act on.
          // `derive/auditRows.ts` re-declares §1.6's twelve because INV-1
          // forbids the renderer a `@wemessage/core` dependency and the
          // client exports `GateDenyReason` as a TYPE with no runtime array
          // behind it — so this is a deliberate second projection, and this
          // scenario adds an arch row tying the twelve back to the union in
          // `packages/core/src/domain/types.ts` so the two cannot drift.
          'apps/desktop/src/renderer/derive/auditRows.ts',
          // s8 Scenario 12, the SEVENTH deliberate edit to this guard and the
          // first time any of the five is named OUTSIDE the daemon's own
          // packages: the people screen reports, per row, why a handle set
          // to AUTO is not auto-sending, and it reports it in the DAEMON's
          // word rather than in one of its own. `data-held` in the DOM is
          // the literal, so an operator reading "rate-limited" on a row and
          // "rate-limited" in an audit row is reading about the same clamp.
          //
          // That is the whole argument for the two homes below, and it is
          // the argument this guard exists to force into a reviewed diff:
          // the alternative is a renderer-side display vocabulary that
          // starts out as a faithful copy of §1.7 and drifts the first time
          // a clamp is renamed. INV-1 keeps `@wemessage/core` out of the
          // renderer, so the copy cannot be imported; making it a LITERAL,
          // in exactly two files, is the version of that copy which fails
          // the build when the original moves.
          //
          //  - `autoSendsPerHour.ts` owns `AutoHold` and `heldBy`, which is
          //    where the cap comparison lives.
          //  - `peopleRows.ts` owns `autoCell`, which picks between the
          //    holds in §1.7's own else-if order.
          //
          // Neither MINTS anything: no `gate.denied` row, no `clampedBy`,
          // nothing on the wire. They are read-only echoes of a decision the
          // daemon already made and already logged.
          'apps/desktop/src/renderer/derive/autoSendsPerHour.ts',
          'apps/desktop/src/renderer/derive/peopleRows.ts',
          'packages/client/src/index.ts',
          'packages/core/src/audit/events.ts',
          'packages/core/src/domain/types.ts',
          // s6 Scenario 6, the THIRD deliberate edit to this guard and the
          // second dormant literal to be claimed: `evaluateGate` clamps to
          // 'draft-only' with `clampedBy: 'rate-limited'` when any of the
          // three rolling counters is at its cap (F-66). A clamp, not a
          // denial — the message still gets a draft a human can look at.
          'packages/core/src/gate/index.ts',
          // Same scenario, the other half, and the one place in this product
          // where a rate limit refuses a PERSON: the approve route returns
          // 403 when the global hourly bound is saturated (F-71), because
          // that bound is the daemon's blast radius and a bound with an
          // exception is not a bound. This is a genuine `gate.denied` row
          // with a genuine deny reason, which is why the literal has to be
          // spelled here rather than read out of `clampedBy`.
          'packages/daemon/src/routes/drafts.ts',
        ],
      ],
      [
        'circuit-open',
        [
          // s8 Scenario 13, and the reason it is a NEW home rather than a
          // deleted literal: the audit screen draws `gate.denied` rows, and
          // a denial an operator cannot read the reason for is a row that
          // tells them a refusal happened and nothing they can act on.
          // `derive/auditRows.ts` re-declares §1.6's twelve because INV-1
          // forbids the renderer a `@wemessage/core` dependency and the
          // client exports `GateDenyReason` as a TYPE with no runtime array
          // behind it — so this is a deliberate second projection, and this
          // scenario adds an arch row tying the twelve back to the union in
          // `packages/core/src/domain/types.ts` so the two cannot drift.
          'apps/desktop/src/renderer/derive/auditRows.ts',
          'packages/client/src/index.ts',
          'packages/core/src/domain/types.ts',
          // s6 Scenario 7, the FOURTH deliberate edit to this guard and the
          // third dormant literal to be claimed: `evaluateGate` clamps to
          // 'draft-only' with `clampedBy: 'circuit-open'` when the breaker is
          // open (F-65). A clamp, not a denial — the send-moment refusal is
          // Sc 10's job (F-59).
          'packages/core/src/gate/index.ts',
          // Same scenario, and the one place the breaker actually STOPS
          // something today: an opening breaker cancels the drafts still
          // inside their undo grace, writing a genuine per-draft
          // `gate.denied` row and a `{code:'circuit-open'}` draft error. Both
          // spell the literal, which is why the file has to be named here
          // rather than reading it out of `clampedBy`.
          //
          // s6 Scenario 11, the FIFTH deliberate edit to this row, and the
          // sort order puts it above `circuit.ts` rather than after it: the
          // arming derivation reports 'circuit-open' as an `ArmingReason`
          // when the breaker is the topmost hold. Same overlap, same
          // reasoning, as the 'outside-window' row above — the badge and the
          // audit log say the same word about the same breaker, and this
          // guard is what makes the day they stop agreeing a reviewed diff.
          'packages/daemon/src/arming.ts',
          'packages/daemon/src/circuit.ts',
        ],
      ],
      [
        'loop-detected',
        [
          // s8 Scenario 13, and the reason it is a NEW home rather than a
          // deleted literal: the audit screen draws `gate.denied` rows, and
          // a denial an operator cannot read the reason for is a row that
          // tells them a refusal happened and nothing they can act on.
          // `derive/auditRows.ts` re-declares §1.6's twelve because INV-1
          // forbids the renderer a `@wemessage/core` dependency and the
          // client exports `GateDenyReason` as a TYPE with no runtime array
          // behind it — so this is a deliberate second projection, and this
          // scenario adds an arch row tying the twelve back to the union in
          // `packages/core/src/domain/types.ts` so the two cannot drift.
          'apps/desktop/src/renderer/derive/auditRows.ts',
          'packages/client/src/index.ts',
          'packages/core/src/audit/events.ts',
          'packages/core/src/domain/types.ts',
          // s6 Scenario 8, the FIFTH deliberate edit to this guard and the
          // fourth dormant literal to be claimed: `evaluateGate` clamps to
          // 'draft-only' with `clampedBy: 'loop-detected'` when a chat has
          // run three consecutive machine turns, or when the body about to
          // go out normalises to one of the last five we sent there (F-62).
          // ONE file, and one literal for both mechanisms (C-6) — they are
          // the same fact about the world and an operator can do the same
          // one thing about either. Still a clamp and not a denial; no
          // `gate.denied` row exists for it yet, and the send-moment refusal
          // is Sc 10's (F-59). If a second file ever spells this literal,
          // that is a second place deciding what a loop is, and this guard
          // is how it gets noticed.
          'packages/core/src/gate/index.ts',
        ],
      ],
      [
        'sms-auto-forbidden',
        [
          // s8 Scenario 13, and the reason it is a NEW home rather than a
          // deleted literal: the audit screen draws `gate.denied` rows, and
          // a denial an operator cannot read the reason for is a row that
          // tells them a refusal happened and nothing they can act on.
          // `derive/auditRows.ts` re-declares §1.6's twelve because INV-1
          // forbids the renderer a `@wemessage/core` dependency and the
          // client exports `GateDenyReason` as a TYPE with no runtime array
          // behind it — so this is a deliberate second projection, and this
          // scenario adds an arch row tying the twelve back to the union in
          // `packages/core/src/domain/types.ts` so the two cannot drift.
          'apps/desktop/src/renderer/derive/auditRows.ts',
          // s8 Scenario 12. Same two homes, same argument as the
          // 'rate-limited' row above: `AutoHold` names this literal in a
          // type position and `autoCell` writes it into `data-held` when a
          // handle every rung of which says AUTO is on SMS. It is the LAST
          // branch of §1.7's else-if chain, so it is also the last thing
          // `autoCell` checks, and an e2e row reads the attribute back off
          // the row to prove the two orders agree.
          'apps/desktop/src/renderer/derive/autoSendsPerHour.ts',
          'apps/desktop/src/renderer/derive/peopleRows.ts',
          'packages/client/src/index.ts',
          'packages/core/src/domain/types.ts',
          // s6 Scenario 9, the SIXTH deliberate edit to this guard and the
          // last of the dormant five to be claimed: `evaluateGate` clamps a
          // non-iMessage chat to 'draft-only' with
          // `clampedBy: 'sms-auto-forbidden'` unless the operator has
          // explicitly set `send.allowSmsAuto` (F-74). It sits LAST in the
          // step-7 else-if chain, so a chat that is also out of window, rate
          // limited, breaker-tripped or looping reports the reason it shares
          // with iMessage rather than one that reads as "because it is SMS"
          // — same clamp either way, but the operator is told the thing they
          // can act on. Still a clamp and not a denial; the send-moment
          // refusal that would write `gate.denied` is Sc 10's (F-59).
          //
          // Note this row, alone among the five, has never named
          // `packages/core/src/audit/events.ts`: the other four appear there
          // inside `gate.denied`'s documented reason prose, and this one
          // does not, which is itself a small record of the fact that
          // nothing has ever been DENIED for being SMS.
          'packages/core/src/gate/index.ts',
        ],
      ],
    ];
    function filesNamingLiteral(literal: string): string[] {
      const re = new RegExp(`(['"\`])${literal}\\1`);
      return productionSrcFiles()
        .filter((f) => re.test(readOf(f)))
        .sort();
    }

    it('(a) the auto-approve mint site is exactly one file', () => {
      // Anchored by path: an allowlist entry that does not exist is an
      // allowlist entry nobody can review.
      expect(
        AUTO_RESPOND_MINT_ALLOWLIST.filter(
          (f) => !existsSync(join(repoRoot, f)),
        ),
      ).toEqual([]);
      expect(AUTO_RESPOND_MINT_ALLOWLIST).toHaveLength(2);
      expect(autoRespondMintOffenders()).toEqual([]);
    });

    it('(b) system approvals have exactly one writer', () => {
      expect(systemApprovalWriterOffenders()).toEqual([]);
    });

    it('(c) the port importer allowlist is unchanged at 15 files (INV-2)', () => {
      expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(15);
      expect(sendBackendChatDbReaderImporters()).toEqual([
        ...PORT_IMPORTER_ALLOWLIST,
      ]);
    });

    it('(d) no production file derives a horizon from an S6 deadline', () => {
      expect(s6ComputedHorizonOffenders()).toEqual([]);
    });

    it('(e) core does timezone math with Intl and nothing else', () => {
      expect(coreTimezoneLibImporters()).toEqual([]);
      const pkg = JSON.parse(readOf('packages/core/package.json')) as {
        dependencies?: Record<string, string>;
      };
      expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    });

    it('(f) no file names an IANA timezone outside the pinned five', () => {
      expect(unpinnedTimezoneOffenders()).toEqual([]);
    });

    it('(g) the five dormant gate deny literals are still dormant', () => {
      for (const [literal, homes] of DORMANT_DENY_LITERALS) {
        expect(filesNamingLiteral(literal), literal).toEqual([...homes]);
      }
    });

    describe('proven teeth', () => {
      const mintProbe = join(
        repoRoot,
        'packages/core/src/__arch_s6_mint_probe__.ts',
      );
      const writerProbe = join(
        repoRoot,
        'packages/core/src/__arch_s6_writer_probe__.ts',
      );
      const horizonProbe = join(
        repoRoot,
        'packages/core/src/__arch_s6_horizon_probe__.ts',
      );
      const tzLibProbe = join(
        repoRoot,
        'packages/core/src/__arch_s6_tzlib_probe__.ts',
      );
      const zoneProbeDir = join(repoRoot, 'fixtures/test/__s6_teeth__');
      const zoneProbe = join(zoneProbeDir, 'probe.spec.ts');
      const denyProbe = join(
        repoRoot,
        'packages/core/src/__arch_s6_deny_probe__.ts',
      );

      afterEach(() => {
        rmSync(mintProbe, { force: true });
        rmSync(writerProbe, { force: true });
        rmSync(horizonProbe, { force: true });
        rmSync(tzLibProbe, { force: true });
        rmSync(zoneProbeDir, { recursive: true, force: true });
        rmSync(denyProbe, { force: true });
      });

      it('planting a third mint site trips the allowlist (a)', () => {
        writeFileSync(
          mintProbe,
          "export const actor = { kind: 'system', reason: 'auto-respond' } as const;\n",
        );
        expect(autoRespondMintOffenders()).toContain(
          'packages/core/src/__arch_s6_mint_probe__.ts',
        );
      });

      it('planting a system-actor insertApproval call trips the writer gate (b)', () => {
        writeFileSync(
          writerProbe,
          'export function mint(store: { insertApproval: (a: unknown) => void }): void {\n' +
            '  store.insertApproval({\n' +
            "    actor: { kind: 'system', reason: 'auto-respond' },\n" +
            '  });\n' +
            '}\n',
        );
        expect(systemApprovalWriterOffenders()).toContain(
          'packages/core/src/__arch_s6_writer_probe__.ts',
        );
      });

      it('planting a setTimeout keyed off pauseUntil trips the horizon gate (d)', () => {
        writeFileSync(
          horizonProbe,
          'export function arm(pauseUntil: number): void {\n' +
            '  setTimeout(() => {}, pauseUntil - Date.now());\n' +
            '}\n',
        );
        expect(s6ComputedHorizonOffenders()).toContain(
          'packages/core/src/__arch_s6_horizon_probe__.ts',
        );
      });

      it('planting a vendored tz-data import in core trips the Intl gate (e)', () => {
        writeFileSync(tzLibProbe, "import './vendor/tzdata.js';\nexport {};\n");
        expect(coreTimezoneLibImporters()).toContain(
          'packages/core/src/__arch_s6_tzlib_probe__.ts',
        );
      });

      it('planting an unpinned timezone in a fixture trips the public-repo sweep (f)', () => {
        mkdirSync(zoneProbeDir, { recursive: true });
        // A zone nobody lives in: the probe must prove the sweep bites
        // without itself naming a place a person could be.
        writeFileSync(zoneProbe, "export const tz = 'Antarctica/Troll';\n");
        expect(unpinnedTimezoneOffenders()).toContain(
          'fixtures/test/__s6_teeth__/probe.spec.ts: Antarctica/Troll',
        );
      });

      it('emitting a dormant deny literal from a new file trips the taxonomy pin (g)', () => {
        writeFileSync(
          denyProbe,
          "export const denial = { allow: false, reason: 'rate-limited' };\n",
        );
        expect(filesNamingLiteral('rate-limited')).toContain(
          'packages/core/src/__arch_s6_deny_probe__.ts',
        );
      });
    });
  });

  describe('S7 extensions (s7-execution Scenario 1: ecosystem-era guards)', () => {
    // Same local file-walk shape as the S5 and S6 blocks, for the same
    // reason: six duplicated lines beat shared mutable state threaded
    // through six slices of guards.
    const S7_SKIP = new Set([
      'node_modules',
      'dist',
      '.git',
      'coverage',
      '.turbo',
    ]);
    function s7ListFiles(root: string): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (S7_SKIP.has(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(full);
        }
      };
      walk(root);
      return out;
    }
    const s7Rel = (abs: string): string =>
      abs.slice(repoRoot.length + 1).replace(/\\/g, '/');
    const s7Read = (rel: string): string =>
      readFileSync(join(repoRoot, rel), 'utf8');

    // ---------------------------------------------------------------
    // (a) the typecheck hole. Until S7 only core, protocol and store had a
    // `tsconfig.vitest.json`, so vitest's reassuring "Type Errors: no
    // errors" line was true of three packages and silent about the rest.
    // It hid real errors (F-80) including a missing port method on a test
    // double and fixtures sending a `service` value that is not a member
    // of the `Service` union.
    //
    // The row is keyed off "has a test/ directory" rather than a
    // hand-maintained list of packages: a list is the thing someone
    // forgets to append to on the day they add the first test to a new
    // package, and that day is exactly when the hole reopens.
    // `packages/adapters/{hermes,luna,openclaw}` have no test/ directory
    // at this commit (they are `export {}` stubs), so they are not
    // required to carry the file YET; the S7 scenarios that give them
    // tests are forced to add it by this row, at the moment it matters.
    const TYPECHECK_ROOTS: readonly string[] = [
      'packages',
      'packages/adapters',
      'apps',
    ];
    function packageDirsWithTests(): string[] {
      const out: string[] = [];
      for (const root of TYPECHECK_ROOTS) {
        const abs = join(repoRoot, root);
        if (!existsSync(abs)) continue;
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (S7_SKIP.has(entry.name)) continue;
          const dir = join(abs, entry.name);
          if (!existsSync(join(dir, 'test'))) continue;
          if (!existsSync(join(dir, 'vitest.config.ts'))) continue;
          out.push(s7Rel(dir));
        }
      }
      // `fixtures/` is a workspace package that sits outside packages/ and
      // has its own test/ and vitest.config.ts; enumerated by hand because
      // its parent is the repo root and walking that would enumerate every
      // top-level directory in the tree.
      if (
        existsSync(join(repoRoot, 'fixtures/test')) &&
        existsSync(join(repoRoot, 'fixtures/vitest.config.ts'))
      ) {
        out.push('fixtures');
      }
      return [...new Set(out)].sort();
    }
    function typecheckConfigOffenders(): string[] {
      return packageDirsWithTests()
        .filter((dir) => {
          if (!existsSync(join(repoRoot, dir, 'tsconfig.vitest.json'))) {
            return true;
          }
          const config = s7Read(`${dir}/vitest.config.ts`);
          // Cheap and literal on purpose: the three things that have to be
          // true (typecheck on, enabled, pointed at that file) are three
          // substrings, and a regex over a config file that tried to be
          // clever would be the first thing here to rot.
          return !(
            /typecheck:\s*\{/.test(config) &&
            /enabled:\s*true/.test(config) &&
            /tsconfig:\s*'\.\/tsconfig\.vitest\.json'/.test(config)
          );
        })
        .sort();
    }

    // ---------------------------------------------------------------
    // (b) raw control bytes in tracked source. `dispatch.ts` carried a raw
    // 0x00 between two ids and `send-connect-cli.spec.ts` a raw 0x1B inside
    // an ANSI-detecting regex. Both were sound in INTENT and accidental in
    // ENCODING (F-81). The cost is not runtime — the strings are identical
    // either way — it is that `file(1)` calls such a source file `data`,
    // `grep` without `-a` skips it, and some diff and review tools refuse
    // it outright. A guard over the tree is cheaper than remembering.
    //
    // Tab (0x09), LF (0x0A) and CR (0x0D) are exempt: they are whitespace,
    // not payload. 0x0B and 0x0C (VT, FF) are NOT exempt — nothing in this
    // tree has a reason to spell a vertical tab as a raw byte. Binary
    // fixtures (fixtures/typedstream/*.bin) are out of scope by extension:
    // the row says "text file", and a typedstream blob is not one.
    const TEXT_EXTENSIONS = new Set([
      '.ts',
      '.tsx',
      '.js',
      '.mjs',
      '.cjs',
      '.json',
      '.md',
      '.yml',
      '.yaml',
      '.sql',
      '.py',
      '.sh',
      '.toml',
      '.txt',
      // s8 Sc1: the token sheet is the app's only colour literal file and it
      // is a stylesheet. Adding the extension here rather than leaving it out
      // is the same decision Sc7 made for `.py` and `.yaml`: the sweep should
      // read what the repo actually publishes, not what it published when the
      // list was written.
      '.css',
    ]);
    // Naming control characters is this guard's entire job; the class below
    // IS the denylist, and it is written with escapes precisely so that the
    // file enforcing the rule also obeys it.
    const RAW_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
    function isTextish(rel: string): boolean {
      const dot = rel.lastIndexOf('.');
      return dot === -1 ? false : TEXT_EXTENSIONS.has(rel.slice(dot));
    }
    function rawControlByteOffenders(): string[] {
      // DERIVED SINCE s7 Sc11. This was
      // `['packages', 'skills', 'test', 'fixtures', 'apps']`, a hand-list
      // that was accurate the day it was written and that quietly omitted
      // `.github` and `site`. `skills/` is only in it because Sc 10
      // remembered; the next top-level directory would not be. See
      // `topLevelTrackedDirs`.
      const roots = topLevelTrackedDirs();
      return roots
        .filter((r) => existsSync(join(repoRoot, r)))
        .flatMap((r) => s7ListFiles(join(repoRoot, r)))
        .map(s7Rel)
        .filter(isTextish)
        .flatMap((f) => {
          // latin1 so every byte maps to exactly one code unit: reading a
          // file with a stray 0x00 as utf8 is lossy in the direction that
          // would hide the thing we are looking for.
          const lines = readFileSync(join(repoRoot, f), 'latin1').split('\n');
          return lines
            .map((line, i) =>
              RAW_CONTROL_RE.test(line) ? `${f}:${String(i + 1)}` : null,
            )
            .filter((x): x is string => x !== null);
        })
        .sort();
    }

    // ---------------------------------------------------------------
    // (c) `Service` is `'imessage' | 'sms' | 'rcs' | 'unknown'` — lowercase,
    // four members, closed (packages/core/src/domain/types.ts). chat.db's
    // own `service` COLUMN uses Apple's casing (`iMessage`, `SMS`, `RCS`)
    // and `mapService` in packages/ingest is the ONE seam that folds the
    // second vocabulary into the first. Nine files under packages/ had
    // been writing `service: 'iMessage'` into WIRE payloads since S5 —
    // including the testkit's own request fixture, which is production
    // code a stranger's adapter receives (§0.3 item 2, F-98).
    //
    // Nothing caught it, and it is worth writing down why: `parseFrame`
    // validates the envelope and the TOP-LEVEL payload key set, never
    // nested values, and the mock gateway's `emit(type, payload: unknown)`
    // is untyped BY DESIGN so it can send malformed frames for the
    // negative rows. So the type system was not asked and the wire guards
    // could not answer. Deepening the schemas so the wire itself refuses
    // it is Sc 2's job; making the literal unwritable is this one's.
    //
    // Matched by case-fold rather than by spelling `'iMessage'`: the bug
    // that happened is one of twelve spellings, and a guard that only
    // knows the spelling that happened is a guard that has been beaten
    // once already.
    //
    // F-98: chat GUIDs keep Apple's casing (`iMessage;-;+1555…`) because
    // that is what chat.db stores. This row matches the `service` KEY, not
    // the string, so a GUID is invisible to it — do not "fix" one.
    const SERVICE_MEMBERS = new Set(['imessage', 'sms', 'rcs', 'unknown']);
    const SERVICE_LITERAL_RE = /['"]?\bservice['"]?\s*:\s*(['"])([A-Za-z]+)\1/g;
    // The two ingest specs that feed Apple's RAW column vocabulary to the
    // chat.db fixture builder — which is exactly what `mapService` exists
    // to normalise and what those rows exist to prove. They are allowed to
    // spell Apple's casing because they are the INPUT side of the seam.
    // (fixtures/src/chatdb-builder.ts is the other input site and lives
    // outside this row's `packages/` scope.)
    const APPLE_SERVICE_CASING_ALLOWLIST: readonly string[] = [
      'packages/ingest/test/normalize-edge.spec.ts',
      'packages/ingest/test/resolve-chat.spec.ts',
    ];
    function misCasedServiceOffenders(): string[] {
      return s7ListFiles(join(repoRoot, 'packages'))
        .map(s7Rel)
        .filter((f) => /\.(ts|tsx|js|mjs|cjs|json)$/.test(f))
        .filter((f) => !APPLE_SERVICE_CASING_ALLOWLIST.includes(f))
        .flatMap((f) =>
          [...s7Read(f).matchAll(SERVICE_LITERAL_RE)]
            .map((m) => m[2] ?? '')
            .filter(
              (v) =>
                SERVICE_MEMBERS.has(v.toLowerCase()) && !SERVICE_MEMBERS.has(v),
            )
            .map((v) => `${f}: ${v}`),
        )
        .sort();
    }

    it('(a) every package with tests is typechecked by tsc, not just transpiled', () => {
      // The enumeration itself is asserted: a package that quietly loses
      // its test/ directory must not be able to make this row vacuous.
      expect(packageDirsWithTests()).toEqual([
        // s8 Sc1: `apps/desktop` grows its first test/ directory, and this
        // row is why it grew a tsconfig.vitest.json in the same commit —
        // the fourth time this guard has forced the config into the commit
        // that made it matter. It is also the first non-`packages/` entry
        // the enumeration has ever produced, which is the whole reason
        // TYPECHECK_ROOTS included `apps` before there was anything in it.
        'apps/desktop',
        'fixtures',
        'packages/adapter-testkit',
        'packages/adapters/echo',
        // s7 Sc7: the Hermes package grows its first test/ directory, and
        // this row is why it also grew a tsconfig.vitest.json in the same
        // commit — exactly the moment the hole would otherwise have opened.
        'packages/adapters/hermes',
        // s7 Sc9: and the Luna package grows its first test/ directory,
        // which is the second time this row has forced a tsconfig.vitest.json
        // into the same commit as the tests it typechecks.
        'packages/adapters/luna',
        // s7 Sc10: and the OpenClaw package, the third. The stub had a
        // vitest.config.ts from S5 and nothing to run; the moment it grew a
        // test/ directory this row demanded the tsconfig.vitest.json and the
        // typecheck block in the same commit.
        'packages/adapters/openclaw',
        'packages/adapters/sol',
        'packages/cli',
        'packages/client',
        'packages/core',
        'packages/daemon',
        'packages/ingest',
        'packages/protocol',
        'packages/sendkit',
        'packages/store',
      ]);
      expect(typecheckConfigOffenders()).toEqual([]);

      // The repo-level project is not a package, so the enumeration above
      // structurally cannot see it — and it is the one that carries THIS
      // file. An unchecked enforcer is the single gap the guard could not
      // report on itself, so it is asserted separately.
      expect(existsSync(join(repoRoot, 'tsconfig.vitest.json'))).toBe(true);
      const rootVitest = s7Read('vitest.config.ts');
      expect(rootVitest).toMatch(/typecheck:\s*\{/);
      expect(rootVitest).toMatch(/tsconfig:\s*'\.\/tsconfig\.vitest\.json'/);
    });

    it('(b) no tracked text file carries a raw control byte', () => {
      expect(rawControlByteOffenders()).toEqual([]);
    });

    it('(c) no file under packages/ spells a mis-cased Service member', () => {
      // Anchored by path, per the S6 (a) precedent: an allowlist entry
      // that does not exist is an allowlist entry nobody can review.
      expect(
        APPLE_SERVICE_CASING_ALLOWLIST.filter(
          (f) => !existsSync(join(repoRoot, f)),
        ),
      ).toEqual([]);
      expect(misCasedServiceOffenders()).toEqual([]);
    });

    it('(d) the port importer allowlist is still 15 and still adapter-free (INV-2)', () => {
      // A pin row, not a RED row (S6 (f) precedent). S7 adds an SSE route,
      // a settings route, a spawn transport and four adapter packages, and
      // NONE of them may acquire a reference to `SendBackend` or
      // `ChatDbReader`. S6 (c) pins the count; this pins the SHAPE, so an
      // adapter that reaches for a port fails on a row that says why.
      expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(15);
      const forbiddenPrefixes = [
        'packages/adapters/',
        'packages/adapter-testkit/',
        'packages/daemon/src/routes/events-sse.ts',
        'packages/daemon/src/routes/settings.ts',
      ];
      expect(
        PORT_IMPORTER_ALLOWLIST.filter((f) =>
          forbiddenPrefixes.some((p) => f.startsWith(p)),
        ),
      ).toEqual([]);
    });

    describe('proven teeth', () => {
      const controlProbe = join(
        repoRoot,
        'packages/core/src/__arch_s7_control_probe__.ts',
      );
      const serviceProbe = join(
        repoRoot,
        'packages/core/src/__arch_s7_service_probe__.ts',
      );
      const typecheckProbeDir = join(repoRoot, 'packages/__s7_teeth__');

      afterEach(() => {
        rmSync(controlProbe, { force: true });
        rmSync(serviceProbe, { force: true });
        rmSync(typecheckProbeDir, { recursive: true, force: true });
      });

      it('planting a raw NUL in a source file trips the control-byte sweep (b)', () => {
        // Emitted through String.fromCharCode so this spec file stays free
        // of the byte it bans — the guard has to hold over itself.
        writeFileSync(
          controlProbe,
          `export const sep = 'a${String.fromCharCode(0)}b';\n`,
        );
        expect(rawControlByteOffenders()).toContain(
          'packages/core/src/__arch_s7_control_probe__.ts:1',
        );
      });

      it('planting a raw ESC in a source file trips the control-byte sweep (b)', () => {
        // The second encoding accident this row exists for, and the one
        // that was actually in the tree twice: an ANSI-matching regex
        // typed with a literal escape instead of `\x1b`.
        writeFileSync(
          controlProbe,
          `export const ansi = /${String.fromCharCode(27)}\\[/;\n`,
        );
        expect(rawControlByteOffenders()).toContain(
          'packages/core/src/__arch_s7_control_probe__.ts:1',
        );
      });

      it('planting a mis-cased Service literal trips the taxonomy sweep (c)', () => {
        writeFileSync(
          serviceProbe,
          "export const chat = { service: 'iMessage' };\n",
        );
        expect(misCasedServiceOffenders()).toContain(
          'packages/core/src/__arch_s7_service_probe__.ts: iMessage',
        );
      });

      it('a package that grows a test/ dir without a vitest tsconfig trips (a)', () => {
        // The failure mode the row is really for: not "someone deletes a
        // tsconfig" but "someone adds the first test to a package that
        // never had one", which is how every one of these holes opened.
        mkdirSync(join(typecheckProbeDir, 'test'), { recursive: true });
        writeFileSync(
          join(typecheckProbeDir, 'vitest.config.ts'),
          "export default { test: { name: 'probe' } };\n",
        );
        writeFileSync(
          join(typecheckProbeDir, 'test', 'probe.spec.ts'),
          'export {};\n',
        );
        expect(typecheckConfigOffenders()).toContain('packages/__s7_teeth__');
      });
    });
  });

  /**
   * s7-execution Scenario 7 — the guards a second LANGUAGE needs.
   *
   * Everything above this block is a guard over TypeScript, and every one of
   * them is blind to the files Sc 7 adds. Two holes open the moment a `.py`
   * lands in `packages/`, and both are closed here rather than left for the
   * scenario that trips over them:
   *
   * (e) `pnpm licenses:check` walks `node_modules`. It cannot see a Python
   *     dependency graph, so a `pip install` of something AGPL would be
   *     invisible to the license gate that exists precisely to catch that.
   *     The answer is not a second license tool, it is a dependency list
   *     small enough to read: ONE package, pinned, hashed, BSD-3-Clause
   *     (F-88). This row asserts the list has not grown, in any
   *     `requirements.txt` anywhere in the tree, and that no `.py` file
   *     imports something outside it.
   * (f) the public-repo sweep was extension-scoped and `.py`/`.yaml` were
   *     not in the scope. Widened at its definition (`trackedTextFiles`);
   *     the teeth below prove the widening actually bites on the two
   *     extensions this scenario introduces, rather than merely appearing
   *     in a regex.
   */
  describe('S7 extensions (s7-execution Scenario 7: the second language)', () => {
    /** Every tracked `requirements.txt`, wherever it is. */
    function requirementsFiles(): string[] {
      return trackedTextFiles()
        .filter((f) => /(^|\/)requirements(-[\w.]+)?\.txt$/.test(f))
        .sort();
    }

    /**
     * Every requirement line in the tree, file-qualified. Comments and blanks
     * dropped; nothing else is, because "nothing else" is the assertion.
     */
    function pythonRequirementLines(): string[] {
      return requirementsFiles().flatMap((f) =>
        readFileSync(join(repoRoot, f), 'utf8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'))
          .map((l) => `${f}: ${l.split(/\s+/)[0] ?? ''}`),
      );
    }

    /** Third-party imports in tracked Python, minus the one allowed package. */
    const PY_STDLIB = new Set([
      '__future__',
      'abc',
      'argparse',
      'asyncio',
      'base64',
      'collections',
      'contextlib',
      'dataclasses',
      'datetime',
      'enum',
      'functools',
      'hashlib',
      'inspect',
      'itertools',
      'json',
      'logging',
      'os',
      'pathlib',
      'random',
      're',
      'signal',
      'ssl',
      'sys',
      'time',
      'traceback',
      'types',
      'typing',
      'unittest',
      'urllib',
      'uuid',
    ]);
    /** Modules that ship inside the plugin directory itself. */
    const PY_LOCAL = new Set(['adapter', 'wemessage_wire']);
    /**
     * The one package this repository actually installs. BSD-3-Clause, no
     * dependencies of its own, pinned and hashed in requirements.txt.
     */
    const PY_ALLOWED_THIRD_PARTY = new Set(['websockets']);
    /**
     * Provided by the HOST, never installed by us. `hermes_cli` is Hermes
     * itself: the plugin is loaded into a Hermes process that already has it,
     * this repo never puts it in a requirements file, and every import of it
     * is inside a `try/except ImportError` so the module still loads without
     * it. It is on this list rather than the one above because the license
     * question a requirements file answers does not arise for a symbol we
     * never fetch.
     */
    const PY_HOST_PROVIDED = new Set(['hermes_cli']);

    function pythonImportOffenders(): string[] {
      return trackedTextFiles()
        .filter((f) => f.endsWith('.py'))
        .flatMap((f) => {
          const source = readFileSync(join(repoRoot, f), 'utf8');
          return [
            ...source.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm),
          ]
            .map((m) => (m[1] ?? '').split('.')[0] ?? '')
            .filter(
              (mod) =>
                !PY_STDLIB.has(mod) &&
                !PY_LOCAL.has(mod) &&
                !PY_HOST_PROVIDED.has(mod) &&
                !PY_ALLOWED_THIRD_PARTY.has(mod),
            )
            .map((mod) => `${f}: ${mod}`);
        })
        .sort();
    }

    it('(e) the Python dependency graph is one hashed BSD-3 package, tree-wide', () => {
      // The enumeration first: a requirements.txt that stops being tracked
      // must not be able to make the list below trivially satisfied.
      expect(requirementsFiles()).toEqual([
        'packages/adapters/hermes/plugin/requirements.txt',
      ]);
      // ONE requirement, in the whole repository. This is the entire Python
      // license story: `websockets` is BSD-3-Clause, it is pinned by exact
      // version, its artifacts are pinned by SHA-256, and there is no
      // transitive graph behind it to audit. A second line here is not a
      // style violation, it is a license review, and it fails a row that
      // says so rather than slipping past a checker that cannot see it.
      expect(pythonRequirementLines()).toEqual([
        'packages/adapters/hermes/plugin/requirements.txt: websockets==15.0.1',
      ]);
      // Pinned AND hashed: a version pin still trusts whatever the index
      // serves under that name, and `--require-hashes` in CI is worthless if
      // the file it reads carries no hashes.
      const requirements = readFileSync(
        join(repoRoot, 'packages/adapters/hermes/plugin/requirements.txt'),
        'utf8',
      );
      expect(
        (requirements.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length,
      ).toBeGreaterThan(0);
      // And the code obeys the list. An `import requests` that nobody added
      // to requirements.txt still runs on a developer machine that happens to
      // have it, and still ships a dependency nothing audited.
      expect(pythonImportOffenders()).toEqual([]);
    });

    it('(f) the public-repo sweep reaches the file types this scenario adds', () => {
      // The widening is asserted by ENUMERATION, not by reading the regex:
      // the files exist, they are tracked, and the sweep lists them.
      const swept = new Set(trackedTextFiles());
      const introduced = [
        'packages/adapters/hermes/plugin/adapter.py',
        'packages/adapters/hermes/plugin/wemessage_wire.py',
        'packages/adapters/hermes/plugin/plugin.yaml',
        'packages/adapters/hermes/plugin/requirements.txt',
        'packages/adapters/hermes/plugin/pyproject.toml',
      ];
      expect(introduced.filter((f) => !existsSync(join(repoRoot, f)))).toEqual(
        [],
      );
      expect(introduced.filter((f) => !swept.has(f))).toEqual([]);
      expect(publicRepoOffenders()).toEqual([]);
    });

    describe('proven teeth', () => {
      // `git ls-files` is the enumeration, so a probe has to be in the index
      // to be visible to it. `--intent-to-add` puts the PATH in the index
      // without its content, which is exactly enough, and `git rm --cached`
      // takes it back out. Anything less would prove the offender logic and
      // leave the enumeration — the half that was actually broken —
      // unproven.
      const probes = [
        'packages/adapters/hermes/plugin/__s7c_probe__.py',
        'packages/adapters/hermes/plugin/__s7c_probe__.yaml',
      ];
      const track = (rel: string): void => {
        execFileSync('git', ['add', '--intent-to-add', '--', rel], {
          cwd: repoRoot,
        });
      };
      const untrack = (rel: string): void => {
        try {
          execFileSync(
            'git',
            ['rm', '--cached', '--quiet', '--force', '--', rel],
            {
              cwd: repoRoot,
              stdio: 'ignore',
            },
          );
        } catch {
          // never indexed; the unlink below is the whole cleanup.
        }
      };

      afterEach(() => {
        for (const rel of probes) {
          untrack(rel);
          rmSync(join(repoRoot, rel), { force: true });
        }
      });

      it('a brand string in a .py file trips the public sweep (f)', () => {
        const rel = probes[0] ?? '';
        // Assembled at runtime: this spec is already the one file the sweep
        // skips, but a teeth probe that only works because its enforcer is
        // exempt is not a probe.
        writeFileSync(
          join(repoRoot, rel),
          `BRAND = "flow" + "stay"  # ${'flow'}${'stay'}\n`,
        );
        expect(trackedTextFiles()).not.toContain(rel);
        track(rel);
        expect(trackedTextFiles()).toContain(rel);
        expect(publicRepoOffenders()).toContain(`${rel}: brand string`);
      });

      it('a real +1 number in a .yaml file trips the public sweep (f)', () => {
        const rel = probes[1] ?? '';
        writeFileSync(join(repoRoot, rel), 'handle: "+12065550123"\n');
        track(rel);
        expect(trackedTextFiles()).toContain(rel);
        expect(publicRepoOffenders()).toContain(`${rel}: +12065550123`);
      });

      it('a second Python requirement trips the license guard (e)', () => {
        // The mutation F-88 exists to catch, in the shape it would actually
        // arrive: someone needs one more library, adds one more line, and no
        // license tool in this repo can see it.
        const rel = 'packages/adapters/hermes/plugin/__s7c_probe__.txt';
        const abs = join(repoRoot, rel);
        try {
          writeFileSync(abs, 'somepkg==1.0.0\n');
          execFileSync('git', ['add', '--intent-to-add', '--', rel], {
            cwd: repoRoot,
          });
          expect(requirementsFiles()).not.toContain(rel);
          // The name is what the enumeration keys on, so the probe has to
          // wear the real name to be seen. Renamed in place, then swept.
          const named =
            'packages/adapters/hermes/plugin/nested/requirements.txt';
          mkdirSync(join(repoRoot, 'packages/adapters/hermes/plugin/nested'), {
            recursive: true,
          });
          writeFileSync(join(repoRoot, named), 'somepkg==1.0.0\n');
          execFileSync('git', ['add', '--intent-to-add', '--', named], {
            cwd: repoRoot,
          });
          expect(requirementsFiles()).toContain(named);
          expect(pythonRequirementLines()).toContain(
            `${named}: somepkg==1.0.0`,
          );
        } finally {
          for (const p of [
            rel,
            'packages/adapters/hermes/plugin/nested/requirements.txt',
          ]) {
            try {
              execFileSync(
                'git',
                ['rm', '--cached', '--quiet', '--force', '--', p],
                { cwd: repoRoot, stdio: 'ignore' },
              );
            } catch {
              // not indexed
            }
          }
          rmSync(abs, { force: true });
          rmSync(join(repoRoot, 'packages/adapters/hermes/plugin/nested'), {
            recursive: true,
            force: true,
          });
        }
      });

      it('an unlisted Python import trips the license guard (e)', () => {
        const rel = probes[0] ?? '';
        writeFileSync(join(repoRoot, rel), 'import requests\n');
        track(rel);
        expect(pythonImportOffenders()).toContain(`${rel}: requests`);
      });
    });
  });

  /**
   * s7-execution Scenario 9 — the live-verification ledger (C-9, F-91).
   *
   * S9 ships an adapter for a system nobody here can reach: no Luna source in
   * this tree, no Luna on this machine, nothing on the other end of anything.
   * The adapter passes the conformance kit and that is the entire extent of
   * what is known about it. C-9 says the README must say so in paragraph one.
   *
   * A README sentence is the right thing to SHOW a stranger and the wrong
   * thing to RELY on: it is one edit from being false and nothing would
   * notice. So the status is a VALUE — `LUNA_VERIFICATION` in
   * `packages/adapters/luna/src/verification.ts` — the README paragraph is
   * rendered from it, and the package's own spec pins the two together byte
   * for byte.
   *
   * These rows are the repo-wide half, and they read the BUILT value rather
   * than grepping for a string, because the failure mode is not "Luna's
   * README is wrong" but "some adapter, some day, claims more than it can
   * show". (a) enumerates every adapter README and the tier it declares in
   * prose. (b) enumerates the tiers the shipped code actually declares. (c)
   * is the one that matters: prose and value must agree, per adapter.
   *
   * Nothing in this tree is live-verified. Hermes' two modes were exercised
   * against a scripted child and a loopback fake, Luna against a mock. Real
   * installs are S9+ (§4 backlog). On the day one is verified, these rows are
   * where the stronger claim gets made deliberately, in a diff, instead of
   * quietly in a paragraph nobody re-reads.
   */
  describe('S7 extensions (s7-execution Scenario 9: the verification ledger)', () => {
    const ADAPTER_README = /^packages\/adapters\/[^/]+\/README\.md$/;
    /**
     * Assembled rather than written. This file is read by everyone and swept
     * by nothing, and a bare `live-verified` literal sitting in the enforcer
     * is the first thing a future grep would misread as a claim.
     */
    const LIVE = 'live' + '-verified';
    const ADAPTERS_DIR = join(repoRoot, 'packages/adapters');

    /** Title plus the first two paragraphs: C-9's "first paragraph". */
    function head(rel: string): string {
      return readFileSync(join(repoRoot, rel), 'utf8')
        .split(/\n\s*\n/)
        .slice(0, 3)
        .join('\n\n');
    }

    function adapterReadmes(): string[] {
      return trackedTextFiles()
        .filter((f) => ADAPTER_README.test(f))
        .sort();
    }

    function declaredTier(rel: string): string {
      const first = head(rel);
      // NOT first: `NOT LIVE-VERIFIED` contains `LIVE-VERIFIED`, and reading
      // the weaker claim out of the stronger string is precisely the bug this
      // row would be embarrassed to have.
      if (first.includes('NOT LIVE-VERIFIED')) return 'conformance-only';
      if (/\bLIVE-VERIFIED\b/.test(first)) return LIVE;
      return 'undeclared';
    }

    /** Every adapter package with something built to read. */
    function adapterPackages(): string[] {
      if (!existsSync(ADAPTERS_DIR)) return [];
      return readdirSync(ADAPTERS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => existsSync(join(ADAPTERS_DIR, n, 'dist/index.js')))
        .sort();
    }

    /** The shape a verification value has, as seen from outside its package. */
    function isVerification(
      v: unknown,
    ): v is { adapter: string; tier: string } {
      if (typeof v !== 'object' || v === null) return false;
      const o = v as Record<string, unknown>;
      return typeof o['adapter'] === 'string' && typeof o['tier'] === 'string';
    }

    /**
     * Every verification value an adapter package EXPORTS, read out of the
     * built module.
     *
     * This is the difference between a ledger and a grep. A string search
     * would trip over the type declaration that defines the strong tier, over
     * the spec that tests the checker against synthetic values, and over the
     * README paragraph that explains what would have to change — three places
     * that mention the word and claim nothing. Reading the value asks the
     * only question that matters: what does the shipped code SAY it is?
     */
    async function declaredTiers(): Promise<string[]> {
      const out: string[] = [];
      for (const name of adapterPackages()) {
        const url = pathToFileURL(
          join(ADAPTERS_DIR, name, 'dist/index.js'),
        ).href;
        const mod: Record<string, unknown> = await import(url);
        for (const value of Object.values(mod))
          if (isVerification(value)) out.push(`${name}: ${value.tier}`);
      }
      return out.sort();
    }

    it('(a) every adapter README declares its live-verification tier (C-9)', () => {
      // The enumeration is asserted, not just the predicate: a README that
      // vanishes must not make this row vacuously true, and the next adapter
      // to grow one has to decide what it is claiming in the same commit.
      expect(adapterReadmes().map((f) => `${f}: ${declaredTier(f)}`)).toEqual([
        // s7 Sc12 closes the Sc 9 debt: echo and sol had no README at all,
        // which meant the ledger enumerated three of five adapters and read
        // as complete. Both declare the same tier, for different reasons —
        // echo has no external system to reach and sol has one this tree is
        // forbidden to touch (F-95).
        'packages/adapters/echo/README.md: conformance-only',
        'packages/adapters/hermes/README.md: conformance-only',
        'packages/adapters/luna/README.md: conformance-only',
        // s7 Sc10. The OpenClaw shim's child contract is ours and is fully
        // exercised; what has never happened is a byte exchanged with an
        // OpenClaw. Same tier, same sentence, different reason (F-92).
        'packages/adapters/openclaw/README.md: conformance-only',
        'packages/adapters/sol/README.md: conformance-only',
      ]);
    });

    it('(b) no adapter package ships a value claiming live verification', async () => {
      // The packages scanned are asserted too, for the same reason: an
      // adapter that loses its build is a hole in the ledger, not a pass.
      expect(adapterPackages()).toEqual([
        'echo',
        'hermes',
        'luna',
        'openclaw',
        'sol',
      ]);
      expect(await declaredTiers()).toEqual([
        'luna: conformance-only',
        // s7 Sc10: the shim declares against Sc 9's type rather than
        // inventing a second vocabulary for the same admission, which is
        // exactly what `verification.ts`'s header said it should do.
        'openclaw: conformance-only',
      ]);
    });

    it('(c) prose and value agree, per adapter', async () => {
      const values = new Map(
        (await declaredTiers()).map((row) => {
          const [name = '', tier = ''] = row.split(': ');
          return [name, tier] as const;
        }),
      );
      const drift = adapterReadmes()
        .map((f) => {
          const name = f.split('/')[2] ?? '';
          const value = values.get(name);
          return value === undefined || value === declaredTier(f)
            ? null
            : `${name}: README says ${declaredTier(f)}, code says ${value}`;
        })
        .filter((d): d is string => d !== null);
      // Drift in either direction is the same failure. Editing the README to
      // claim more is caught here; editing the value to claim more is caught
      // here AND in (b) AND in the package's own derived-banner row, which is
      // three rows for one lie and deliberately so.
      expect(drift).toEqual([]);
    });

    describe('proven teeth', () => {
      // The probe brings its own package directory, because an adapter README
      // lives one level below `packages/adapters` and a `dist/index.js` is
      // what the ledger reads. Nothing here touches a real package.
      const probeDir = 'packages/adapters/__s9probe__';
      const probeReadme = `${probeDir}/README.md`;
      const probeDist = `${probeDir}/dist/index.js`;

      afterEach(() => {
        try {
          execFileSync(
            'git',
            ['rm', '--cached', '--quiet', '--force', '--', probeReadme],
            { cwd: repoRoot, stdio: 'ignore' },
          );
        } catch {
          // never indexed; the unlink below is the whole cleanup.
        }
        rmSync(join(repoRoot, probeDir), { recursive: true, force: true });
      });

      it('a README upgraded in prose trips the enumeration (a)', () => {
        // The cheap lie: nobody changes any code, somebody changes a word.
        mkdirSync(join(repoRoot, probeDir), { recursive: true });
        writeFileSync(
          join(repoRoot, probeReadme),
          '# probe\n\n**LIVE-VERIFIED.** against a real one, honest.\n',
        );
        expect(adapterReadmes()).not.toContain(probeReadme);
        execFileSync('git', ['add', '--intent-to-add', '--', probeReadme], {
          cwd: repoRoot,
        });
        expect(adapterReadmes()).toContain(probeReadme);
        expect(declaredTier(probeReadme)).toBe(LIVE);
      });

      it('a value upgraded in code trips the ledger (b)', async () => {
        // The expensive lie, and the one this whole scenario is about: the
        // status is upgraded without any verification behind it. It compiles,
        // it ships, and the README even re-renders itself to match — which is
        // exactly why the ledger reads the VALUE and not the prose.
        mkdirSync(join(repoRoot, probeDir, 'dist'), { recursive: true });
        writeFileSync(
          join(repoRoot, probeDist),
          `export const PROBE_VERIFICATION = { adapter: 'probe', tier: '${LIVE}', ` +
            "liveEvidence: 'test/probe.spec.ts', verifiedOn: '2026-09-05', " +
            "declaredOn: '2026-09-05' };\n",
        );
        expect(adapterPackages()).toContain('__s9probe__');
        expect(await declaredTiers()).toContain(`__s9probe__: ${LIVE}`);
      });
    });
  });

  describe('S7 extensions (s7-execution Scenario 11: skills/ is not a blind spot)', () => {
    // A directory no guard sees is a hole. `skills/` arrived in Sc 10 as a
    // brand-new TOP-LEVEL directory, which is the one shape of change that
    // slips past guards written as root lists: every existing sweep either
    // enumerated `packages apps fixtures` or spelled its roots by hand. Sc 11
    // adds two documents to that directory and a generated transcript, so the
    // question "which guards actually reach it" has to be answered once, out
    // loud, with rows rather than with confidence.
    const tracked = (dir: string): string[] =>
      execFileSync('git', ['ls-files', '--', dir], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0);

    it('(a) the top-level directories are enumerated, so a new one forces a decision', () => {
      // Pinned deliberately. The next top-level directory somebody adds
      // fails this row, and the failure is the prompt to answer the same
      // six questions this scenario had to answer for `skills/`.
      //
      // `tools` arrives in s9 Sc 1 and this row did exactly its job: it was
      // the first thing to fail when the release lane was committed, and
      // the six questions were answered in the S9 block below (`row 7
      // (blind spot)`) before this list was touched. Unlike `skills/`,
      // `tools/` carries COMPILED CODE, so the answers to (c) and (d) come
      // out the other way: it needs a tsconfig, a project reference, a
      // place in the cruise and a cruiser rule of its own, and it has all
      // four.
      //
      // `homebrew` arrives in s9 Sc 10 and the row did its job a second
      // time: it failed the moment the cask was staged, and the six
      // questions are answered in `(a2)` below before this list was
      // touched. `homebrew/` is `skills/`-shaped rather than `tools/`-
      // shaped: it holds a generated Ruby cask, its lock file and a
      // README, so the answers to (c) and (d) are the same NO that
      // `skills/` got, and (a2) asserts the no rather than assuming it.
      expect(topLevelTrackedDirs()).toEqual([
        '.github',
        'apps',
        'fixtures',
        'homebrew',
        'packages',
        'site',
        'skills',
        'test',
        'tools',
      ]);
    });

    it('(a2) homebrew/ answers the six questions skills/ and tools/ did', () => {
      const files = tracked('homebrew');
      // (1) The enumeration, then non-vacuity, then the tree-wide sweep.
      // Named rather than counted: a generated cask that stopped being
      // tracked must not make the rest of this row vacuously true.
      expect(files).toEqual([
        'homebrew/Casks/wemessage.rb',
        'homebrew/README.md',
        'homebrew/cask.lock.json',
      ]);
      const swept = new Set(trackedTextFiles());
      expect(files.filter((f) => !swept.has(f))).toEqual([]);

      // (2) Neither formatter nor linter is configured to skip it. The cask
      // is the file most likely to be waved through on the grounds that
      // nobody formats Ruby, and an ignore entry is the cheapest way to
      // lose a directory.
      const ignored = readFileSync(join(repoRoot, '.prettierignore'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
      expect(ignored.filter((l) => l.startsWith('homebrew'))).toEqual([]);
      const ignores =
        /ignores:\s*\[([^\]]*)\]/.exec(
          readFileSync(join(repoRoot, 'eslint.config.js'), 'utf8'),
        )?.[1] ?? '';
      expect(ignores).not.toContain('homebrew');

      // (3) It carries NO compiled code, which is what makes the missing
      // tsconfig and the missing project reference the right answer rather
      // than an oversight. Asserted, because "there is no TypeScript in
      // there" is exactly the kind of belief that stops being true.
      expect(
        files.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f)),
      ).toEqual([]);

      // (4) The launchd sweep reaches it, and this root is the reason that
      // matters: a Homebrew cask is the one artefact in this repository
      // whose whole job is to describe how to unload a launch agent, so it
      // is the file most able to name a verb that kills one.
      expect(swept.has('homebrew/Casks/wemessage.rb')).toBe(true);

      // (5) Everything in it is generated, and the generator is a tool this
      // repository builds rather than a paste. The cask and its lock file
      // therefore have to agree about the version they describe.
      const cask = readFileSync(
        join(repoRoot, 'homebrew/Casks/wemessage.rb'),
        'utf8',
      );
      const lock = JSON.parse(
        readFileSync(join(repoRoot, 'homebrew/cask.lock.json'), 'utf8'),
      ) as { version?: string };
      expect(typeof lock.version).toBe('string');
      expect(cask).toContain(`version "${lock.version ?? ''}"`);
    });

    it('(b) every tree-wide sweep reaches every file under skills/', () => {
      const files = tracked('skills');
      // The enumeration, not just the predicate: a skill document that stops
      // being tracked must not make this row vacuously true.
      expect(files).toEqual([
        'skills/claude/DRYRUN.md',
        'skills/claude/README.md',
        'skills/claude/SKILL.md',
        'skills/hermes/README.md',
        'skills/hermes/SKILL.md',
        'skills/openclaw/README.md',
        'skills/openclaw/SKILL.md',
      ]);
      const swept = new Set(trackedTextFiles());
      expect(files.filter((f) => !swept.has(f))).toEqual([]);
      // And the control-byte sweep, which since this scenario derives its
      // roots from the same structure rather than from a hand-list.
      expect(topLevelTrackedDirs()).toContain('skills');
      expect(publicRepoOffenders()).toEqual([]);
    });

    it('(c) prettier and eslint are not configured to skip skills/', () => {
      // Read as CONFIGURATION, then proven as BEHAVIOUR in the teeth below.
      // Both halves are needed: an ignore entry is the cheap way to lose a
      // directory, and an empty directory passes any check vacuously.
      const ignored = readFileSync(join(repoRoot, '.prettierignore'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
      expect(ignored.filter((l) => l.startsWith('skills'))).toEqual([]);
      const eslintConfig = readFileSync(
        join(repoRoot, 'eslint.config.js'),
        'utf8',
      );
      const ignores = /ignores:\s*\[([^\]]*)\]/.exec(eslintConfig)?.[1] ?? '';
      expect(ignores).not.toContain('skills');
    });

    it('(d) skills/ carries no compiled code, which is why dep:check and tsc need not reach it', () => {
      // `pnpm dep:check` cruises `packages apps fixtures` and `tsc -b` walks
      // the project references; neither sees `skills/`, and that is CORRECT
      // only for as long as the directory holds nothing but documents. It
      // does: Sc 10's runnable example child lives in
      // `packages/adapter-testkit/examples/`, inside the cruised tree, and
      // was deliberately not put here.
      const code = tracked('skills').filter((f) => !f.endsWith('.md'));
      // The day this fails, `skills/` needs a tsconfig, a project reference
      // and a place in the cruise, and this row is where that is decided.
      expect(code).toEqual([]);
      const cruised = readFileSync(join(repoRoot, 'package.json'), 'utf8');
      expect(cruised).toContain('depcruise packages apps fixtures');
    });

    describe('proven teeth', () => {
      const probeDir = 'skills/__s11probe__';
      const untrack = (rel: string): void => {
        try {
          execFileSync(
            'git',
            ['rm', '--cached', '--quiet', '--force', '--', rel],
            { cwd: repoRoot, stdio: 'ignore' },
          );
        } catch {
          // never indexed; the unlink below is the whole cleanup.
        }
      };
      const probes: string[] = [];
      const plant = (name: string, body: string): string => {
        const rel = `${probeDir}/${name}`;
        mkdirSync(join(repoRoot, probeDir), { recursive: true });
        writeFileSync(join(repoRoot, rel), body);
        probes.push(rel);
        return rel;
      };

      afterEach(() => {
        for (const rel of probes.splice(0)) untrack(rel);
        rmSync(join(repoRoot, probeDir), { recursive: true, force: true });
      });

      it('a brand string in a skills/ document trips the public sweep (b)', () => {
        // Assembled at runtime for the same reason Sc 7's probe is: a probe
        // that only works because its enforcer is exempt is not a probe.
        const rel = plant('probe.md', `# ${'flow'}${'stay'} notes\n`);
        expect(trackedTextFiles()).not.toContain(rel);
        execFileSync('git', ['add', '--intent-to-add', '--', rel], {
          cwd: repoRoot,
        });
        expect(trackedTextFiles()).toContain(rel);
        expect(publicRepoOffenders()).toContain(`${rel}: brand string`);
      });

      it('a legitimate near-miss in the same directory does not trip it (b)', () => {
        // The counterfactual that keeps the row above honest: a skill
        // document is allowed to talk about workflows and handles, so long
        // as the handle is the +1555 fiction and the words are ours.
        const rel = plant(
          'clean.md',
          '# probe\n\nRun `wemessage drafts list --to +15551230000`.\n',
        );
        execFileSync('git', ['add', '--intent-to-add', '--', rel], {
          cwd: repoRoot,
        });
        expect(trackedTextFiles()).toContain(rel);
        expect(publicRepoOffenders()).toEqual([]);
      });

      it('prettier reaches skills/', () => {
        // Formatted wrong on purpose, in a way `prettier --check` reports and
        // a human review of a markdown file plausibly would not.
        plant('unformatted.md', '- a\n    - b\n\n\n\n# heading\n');
        let failed = false;
        try {
          execFileSync(
            join(repoRoot, 'node_modules/.bin/prettier'),
            ['--check', probeDir],
            { cwd: repoRoot, stdio: 'pipe' },
          );
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      });

      it('eslint reaches skills/', () => {
        // The hole that would matter most: a `.ts` file under a directory
        // the linter was never pointed at. `recommended` applies tree-wide;
        // only the TYPE-AWARE block is scoped to package sources, so this
        // needs no tsconfig and would be caught the moment it appeared.
        const rel = plant(
          'probe.ts',
          'export const probe = (x: any): unknown => x;\n',
        );
        // eslint exits 1 when it finds an error, so the report arrives on
        // the thrown error's stdout. Reading only the happy path here would
        // make the row pass on an empty report, which is the bug it exists
        // to catch.
        let out = '';
        try {
          out = execFileSync(
            join(repoRoot, 'node_modules/.bin/eslint'),
            ['--format', 'json', '--no-error-on-unmatched-pattern', rel],
            { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
          );
        } catch (err) {
          out = String((err as { stdout?: string }).stdout ?? '');
        }
        const results = JSON.parse(out) as {
          messages: { ruleId: string | null }[];
        }[];
        const rules = results.flatMap((r) =>
          r.messages.map((m) => m.ruleId ?? ''),
        );
        expect(rules).toContain('@typescript-eslint/no-explicit-any');
      });
    });
  });

  it(
    'does not flag violations planted outside the cruised tree (sandbox sanity)',
    () => {
      // Sanity check that the teeth tests above are attributable to the probe
      // file, not ambient noise: an identical import in a temp dir outside the
      // repo tree is invisible to the cruise.
      const sandbox = mkdtempSync(join(tmpdir(), 'wemessage-arch-'));
      try {
        writeFileSync(
          join(sandbox, 'probe.ts'),
          "import 'node:fs';\nexport {};\n",
        );
        const result = cruise(['packages', 'apps', 'fixtures']);
        expect(result.summary.violations).toEqual([]);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
    CRUISE_BUDGET_MS,
  );
});

/**
 * s7-execution Scenario 12 — the public document set (F-79, F-94, F-95).
 *
 * F-79 is the fact that shapes this whole scenario: `docs/` is wholly
 * gitignored and a `!` negation cannot rescue a subdirectory of an ignored
 * directory, so there is no path by which a file under `docs/` becomes
 * public. Everything a stranger is meant to read therefore lives BESIDE THE
 * CODE — `packages/protocol/PROTOCOL.md`, `packages/adapter-testkit/
 * README.md`, and one README per adapter — and this block is the guard on
 * that set as a set.
 *
 * The rows come in three kinds, and the ordering is deliberate:
 *
 *  1. ENUMERATION. The document set is asserted as a list, not as a
 *     predicate. A README that disappears must fail; a new package's README
 *     that appears un-swept must fail too. Every sweep below runs over the
 *     enumerated set, so growing the set and forgetting to lint it is not a
 *     thing that can happen quietly.
 *  2. CONTENT. Every document goes through Sc 11's linter rather than a
 *     fourth copy of its regexes: `publicStringOffenders` for tokens, brand
 *     strings, real contacts and `/Users/` paths, and `lintTranscript` for
 *     ANSI, colour-carrying-state and unknown frame names. These are public
 *     artifacts of a public repo written from a running system, which is
 *     exactly the shape of file that leaks an operator.
 *  3. TRUTH. A document may only name a route the daemon actually serves.
 *     `ROUTE_TABLE` is the arbiter, so a documented endpoint that was
 *     renamed fails here rather than in a stranger's terminal.
 *
 * WHY `lintSkillDocument` IS NOT USED HERE, since its absence is the kind of
 * thing that reads as an oversight: it flags any backticked `prefix.name`
 * whose prefix is `draft|proactive|event|adapter` and which is not a FRAME.
 * PROTOCOL.md's entire job includes naming the seventeen EVENTS, which are
 * not frames, so that function would report seventeen findings for the
 * document being correct. The equivalent no-drift check for this document
 * lives in `packages/protocol/test/protocol-md.spec.ts` row 3, where it can
 * ask about frames and events together.
 */
describe('s7-execution Scenario 12 — the public document set', () => {
  /** The docs this repo publishes beside its code. `skills/` is Sc 11's. */
  const DOC_RE =
    /^(README\.md|CONTRIBUTING\.md|packages\/.*\/(README|PROTOCOL)\.md)$/;
  const ADAPTER_DOC_RE = /^packages\/adapters\/[^/]+\/README\.md$/;

  function shippedDocs(): string[] {
    return trackedTextFiles()
      .filter((f) => DOC_RE.test(f))
      .sort();
  }
  const read = (rel: string): string =>
    readFileSync(join(repoRoot, rel), 'utf8');

  /* ── row 5 + the enumeration ───────────────────────────────────────── */

  it('the shipped document set is exactly what F-79 says it is', () => {
    expect(shippedDocs()).toEqual([
      'CONTRIBUTING.md',
      'README.md',
      // The quickstart. A stranger's first three commands live here because
      // there is nowhere else public they could live (F-79).
      'packages/adapter-testkit/README.md',
      'packages/adapters/echo/README.md',
      'packages/adapters/hermes/README.md',
      'packages/adapters/luna/README.md',
      'packages/adapters/openclaw/README.md',
      'packages/adapters/sol/README.md',
      'packages/core/README.md',
      // Generated, never hand-written. See protocol-md.spec.ts.
      'packages/protocol/PROTOCOL.md',
      'packages/protocol/README.md',
    ]);
  });

  it('every adapter in the tree has a README (Sc 9 debt, Sc 12 row 5)', () => {
    // Sc 9 flagged echo and sol as missing and deferred them here. The list
    // is derived from the directories, so the next adapter cannot ship
    // without one either.
    const dirs = readdirSync(join(repoRoot, 'packages/adapters'), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual(['echo', 'hermes', 'luna', 'openclaw', 'sol']);
    const withReadme = shippedDocs()
      .filter((f) => ADAPTER_DOC_RE.test(f))
      .map((f) => f.split('/')[2] ?? '');
    expect(withReadme).toEqual(dirs);
  });

  it('the two unreachable adapters say so in paragraph one (C-9)', () => {
    for (const name of ['luna', 'openclaw']) {
      const first = read(`packages/adapters/${name}/README.md`)
        .split(/\n\s*\n/)
        .slice(0, 3)
        .join('\n\n');
      expect(first, `${name} claims too much`).toContain('NOT LIVE-VERIFIED');
    }
  });

  it("sol's README documents the seam drift an author will hit (F-95)", () => {
    // F-95: the Sol agent on this machine speaks a slightly different dialect
    // than the adapter expects, and `~/sol-agent` is not ours to change. An
    // adapter author who hits this deserves to read about it here rather
    // than rediscover it against a live socket.
    const sol = read('packages/adapters/sol/README.md');
    expect(sol).toContain('## Known seam drift');
    const at = sol.indexOf('## Known seam drift');
    const section = sol.slice(at, sol.indexOf('\n## ', at + 1));
    expect(section).toContain('ws-desktop');
    expect(section).toContain('token');
  });

  it('no adapter README names a machine or a home directory', () => {
    // The strictest sweep in the set, because an adapter README is the
    // document most likely to have been written with a terminal open.
    const SYNTHETIC =
      /^(127\.0\.0\.1|localhost|\[::1\]|[a-z0-9-]+\.example\.com)$/;
    const offenders: string[] = [];
    for (const rel of shippedDocs().filter((f) => ADAPTER_DOC_RE.test(f))) {
      const text = read(rel);
      for (const p of text.match(/\/Users\/[^\s`'")]+/g) ?? [])
        offenders.push(`${rel}: ${p}`);
      for (const p of text.match(/(^|[\s`(])~\/[^\s`'")]+/g) ?? [])
        offenders.push(`${rel}: ${p.trim()}`);
      for (const m of text.matchAll(/\b(?:wss?|https?):\/\/([A-Za-z0-9._-]+)/g))
        if (!SYNTHETIC.test(m[1] ?? ''))
          offenders.push(`${rel}: ${m[1] ?? ''}`);
    }
    expect(offenders).toEqual([]);
  });

  /* ── the content sweep ─────────────────────────────────────────────── */

  it('no shipped document leaks a token, a contact, a brand or a path', () => {
    const offenders: string[] = [];
    for (const rel of shippedDocs())
      for (const o of publicStringOffenders(read(rel)))
        offenders.push(`${rel}: ${o.rule} ${o.detail}`);
    expect(offenders).toEqual([]);
  });

  it('no shipped document carries colour, ANSI, or a frame that does not exist', () => {
    // The policy is READ from SKILL.md rather than restated, which is the
    // property Sc 11 built the linter around: a linter holding its own copy
    // of the rules keeps passing after somebody edits the document.
    const policy = parseSkillBlocks(read('skills/claude/SKILL.md'));
    /**
     * The project's own two domains. `wemessage.dev` is the JSON Schema
     * `$id` authority and appears in PROTOCOL.md by requirement; the linter
     * cannot know it is not a person's host, and adding it to the linter's
     * SYNTHETIC_DOMAIN set would weaken the rule for transcripts, where the
     * whole point is that an unfamiliar host is presumed to be somebody's.
     * So the allowance is stated here, narrowly, at the call site.
     */
    const OURS = new Set(['wemessage.dev', 'wemessage.app']);
    /**
     * `github.com`, admitted as THIS repository's address and nothing else.
     *
     * s9 Sc9 made the download link load-bearing rather than decorative: the
     * builds are unsigned, so the README's instruction is "get the DMG from
     * the releases page", and a public README that cannot name its own
     * releases page is not a README. But `github.com` is exactly the host
     * the rule exists for elsewhere. A profile, a gist, another project's
     * issue tracker: each is a person's address, and putting the bare host
     * into `OURS` above would admit all three in every shipped document at
     * once.
     *
     * So the allowance is keyed on the LINE, not on the host. The reference
     * has to be the repository the release artefacts actually come from,
     * and any other GitHub URL anywhere in the document set still fails,
     * still carrying the file and the line that wrote it.
     */
    const OUR_REPO = /https:\/\/github\.com\/raybman\/WeMessage(?![\w.-])/;
    const offenders: string[] = [];
    for (const rel of shippedDocs()) {
      const text = read(rel);
      const lines = text.split('\n');
      for (const f of lintTranscript(text, policy)) {
        if (f.rule === 'non-synthetic-contact' && OURS.has(f.detail)) continue;
        if (
          f.rule === 'non-synthetic-contact' &&
          f.detail === 'github.com' &&
          OUR_REPO.test(lines[f.line - 1] ?? '')
        )
          continue;
        offenders.push(`${rel}:${f.line}: ${f.rule} ${f.detail}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the GitHub allowance is this repository and not the host', () => {
    // Teeth for the exemption above, because an exemption nobody probed is
    // a hole nobody measured. Written against the regex directly: these are
    // the lines a future document is most likely to contain, and only the
    // first of them may pass.
    const OUR_REPO = /https:\/\/github\.com\/raybman\/WeMessage(?![\w.-])/;
    expect(
      OUR_REPO.test(
        '[latest release](https://github.com/raybman/WeMessage/releases/latest).',
      ),
    ).toBe(true);
    for (const line of [
      'file an issue at https://github.com/raybman/WeMessage-tap/issues',
      'thanks to https://github.com/raybman for the review',
      'see https://github.com/someone/WeMessage for the fork',
      'mirrored at https://github.com/raybman/WeMessage.wiki/home',
      'https://gist.github.com/raybman/WeMessage',
    ])
      expect(OUR_REPO.test(line), line).toBe(false);
  });

  it('every route a document names is a route the daemon serves', () => {
    const known = new Set(ROUTE_TABLE);
    /**
     * The first path segment of every route this daemon serves, derived
     * rather than listed. It is the discriminator between "a claim about our
     * surface" and "a claim about somebody else's": the Hermes adapter's
     * README documents `POST /v1/runs` and `GET /v1/runs/{run_id}/events`,
     * which are the UPSTREAM agent API's routes and are correct as written.
     * A row that failed on them would be asserting that no adapter may
     * describe the service it adapts, and the only way back to green would
     * be to delete true documentation.
     *
     * Scoping by noun keeps the teeth where they belong. `runs` is not a
     * noun this gateway has, so those two lines fall out of the grammar; but
     * `drafts`, `send`, `adapters`, `audit` and the rest are, so a document
     * that wrote `POST /v1/drafts/:id/approved`, or invented
     * `POST /v1/send/now`, or went on naming a route a later scenario
     * deleted, still fails here. Drift is drift against OUR table, and it
     * always lands on one of our nouns.
     */
    const ourNouns = new Set(
      ROUTE_TABLE.map((r) => r.split(' ')[1]?.split('/')[2] ?? ''),
    );
    const offenders: string[] = [];
    for (const rel of shippedDocs())
      for (const m of read(rel).matchAll(
        /\b(GET|POST|PATCH|PUT|DELETE) (\/v1\/[A-Za-z0-9/:._-]*[A-Za-z0-9])/g,
      )) {
        const path = m[2] ?? '';
        if (!ourNouns.has(path.split('/')[2] ?? '')) continue;
        const route = `${m[1] ?? ''} ${path}`;
        if (!known.has(route)) offenders.push(`${rel}: ${route}`);
      }
    expect(offenders).toEqual([]);
    // The noun set is derived from a table this suite pins at 67 rows, so it
    // cannot quietly empty out and turn the loop above into a no-op.
    expect(ourNouns.has('drafts') && ourNouns.has('send')).toBe(true);
    expect(ourNouns.has('runs')).toBe(false);
    // Not vacuous: the approve-before-send path is named somewhere public.
    expect(
      shippedDocs().some((f) =>
        read(f).includes('POST /v1/drafts/:id/approve'),
      ),
    ).toBe(true);
  });

  /* ── row 10: the front door ────────────────────────────────────────── */

  describe('row 10: the root README is a front door, not a plan', () => {
    it('no longer advertises a surface that does not exist', () => {
      expect(read('README.md')).not.toContain('Planned surface');
    });

    it('points at the three documents a newcomer needs', () => {
      const readme = read('README.md');
      for (const target of [
        'packages/protocol/PROTOCOL.md',
        'packages/adapter-testkit/README.md',
        'skills/claude/SKILL.md',
      ])
        expect(readme, `README does not link ${target}`).toContain(target);
    });

    it("CONTRIBUTING's out-of-tree adapter section names the kit's bin", () => {
      // Sc 5's refusal prints this exact command; Sc 6 shipped the bin; this
      // scenario publishes the package that makes it resolvable. The three
      // have to agree, and this is the only place a human reads them together.
      const contributing = read('CONTRIBUTING.md');
      expect(contributing).toContain('npx @wemessage/adapter-testkit');
      expect(contributing).toContain('--cmd');
    });
  });
});

/**
 * s8-execution Scenario 1 — arch guards for the GUI era.
 *
 * S8 adds a second process family to a repo that has been one daemon, one
 * CLI and a family of thin adapters for seven slices. An Electron app is the
 * first place in this tree where a renderer, a bundler, a JSX dialect and a
 * design system all arrive at once, and every one of them is a way for the
 * invariants to erode quietly:
 *
 *  - INV-2 lives or dies at the IPC boundary. A renderer that can name a
 *    `wm:send` channel has a path to the send backend that no `Approval` row
 *    gates, so the channel list is CLOSED and its closure is a test.
 *  - The thin-client arrow was written as one rule covering `packages/cli`
 *    and `apps/desktop` together, and the `cli` self-exclusion it needed for
 *    the CLI's own file layout silently licensed `apps/desktop/src` to import
 *    `packages/cli` for six slices. Splitting it is the row that closes a
 *    hole that was always open and never exercised (F-103).
 *  - §3.10 put state in the GLYPH so that colour never carries it. That is a
 *    decision one careless `#34C759` at a time reverses, so the app has one
 *    file that may name a colour and a lint that says so (F-104).
 *
 * Every row below is written BEFORE the thing it guards. That is only worth
 * doing if each one is shown to fire, so each has a planted offender and a
 * legitimate near-miss that must stay silent. Probes are written, cruised or
 * swept, and removed in `afterEach`; where the sweep is over tracked files
 * the probe is `git add --intent-to-add`ed so the enumeration half runs too.
 */
describe('S8 extensions (s8-execution Scenario 1: GUI-era guards)', () => {
  const S8_SKIP = new Set([
    'node_modules',
    'dist',
    '.git',
    'coverage',
    '.turbo',
  ]);
  function s8ListFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (S8_SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(full);
      }
    };
    if (existsSync(root)) walk(root);
    return out.sort();
  }
  const s8Rel = (abs: string): string =>
    abs
      .slice(repoRoot.length + 1)
      .split('\\')
      .join('/');
  const s8Read = (rel: string): string =>
    readFileSync(join(repoRoot, rel), 'utf8');
  /** Every file under `apps/desktop/src`, repo-relative. */
  const desktopSrcFiles = (): string[] =>
    s8ListFiles(join(repoRoot, 'apps/desktop/src')).map(s8Rel);
  /** Every file under `apps/desktop/test`, repo-relative. */
  const desktopTestFiles = (): string[] =>
    s8ListFiles(join(repoRoot, 'apps/desktop/test')).map(s8Rel);

  /**
   * Plant files, remove them, and keep the removal honest.
   *
   * `intentToAdd` exists because half of these sweeps enumerate through
   * `git ls-files`: a probe that git cannot see would exercise the predicate
   * and skip the enumeration, which is precisely the half that rots.
   */
  const planted: string[] = [];
  function plant(rel: string, body: string, intentToAdd = false): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    planted.push(rel);
    if (intentToAdd)
      execFileSync('git', ['add', '--intent-to-add', rel], { cwd: repoRoot });
    return rel;
  }
  afterEach(() => {
    for (const rel of planted.splice(0)) {
      try {
        execFileSync('git', ['rm', '--cached', '--quiet', '--force', rel], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
      } catch {
        // not intent-to-added; nothing to un-stage
      }
      rmSync(join(repoRoot, rel), { force: true });
    }
    for (const dir of ['apps/desktop/src/__s8_probe__'])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  /* ── rows 1, 2, 8: the import graph, proven in one cruise ──────────── */

  /**
   * Six probes, one `depcruise`.
   *
   * Each of these rows wants the same thing — plant an offender, cruise,
   * read the rule name — and the obvious shape is one cruise per row. That
   * shape cost this file five extra subprocess spawns of roughly a second
   * each, which under a full `pnpm test` is enough to push OTHER rows in
   * this file past their timeout. The known "arch.spec dependency-cruiser
   * timeout" flake is exactly this, and adding to it would have been a
   * guard that makes the suite less trustworthy in order to be trustworthy.
   *
   * Planting all six at once is also a STRONGER assertion than six separate
   * runs: the offenders and the near-misses coexist in the same graph, so a
   * rule that only fires when nothing else does, or a near-miss that is
   * silent only because it was cruised alone, is caught here.
   */
  describe('rows 1, 2 and 8: the import graph', () => {
    /** repo-relative path -> file body. Order is irrelevant; names are not. */
    const PROBES: ReadonlyArray<readonly [string, string]> = [
      // row 1 offender: the back door the merged rule left open for six
      // slices. Bare specifier, because that is the sloppiest form and the
      // one a path-only rule would miss.
      [
        'apps/desktop/src/__s8_probe__/back-door.ts',
        "import '@wemessage/cli';\nexport {};\n",
      ],
      // row 1 near-miss: the two packages the app IS allowed to reach.
      [
        'apps/desktop/src/__s8_probe__/allowed.ts',
        [
          "import '@wemessage/client';",
          "import type { GatewayEvent } from '@wemessage/protocol';",
          'export type E = GatewayEvent;',
          '',
        ].join('\n'),
      ],
      // row 2 offender: relative, so resolution cannot silently fail and
      // turn a violation into a shrug (the S1 core->store precedent).
      [
        'apps/desktop/src/__s8_probe__/too-deep.ts',
        "import '../../../../packages/daemon/src/index.js';\nexport {};\n",
      ],
      // row 2 near-miss: the SAME import, one directory over, which is the
      // whole content of the carve-out.
      [
        'apps/desktop/test/__s8_probe__harness.ts',
        "import '../../../packages/daemon/src/index.js';\nexport {};\n",
      ],
      // row 8 offender.
      [
        'packages/client/src/__s8_probe__electron.ts',
        "import { app } from 'electron';\nexport const name = app.getName();\n",
      ],
      // row 8 near-miss: electron is the point of this app, and nowhere else.
      [
        'apps/desktop/src/__s8_probe__/shell.ts',
        "import { app } from 'electron';\nexport const name = (): string => app.getName();\n",
      ],
    ];

    let violations: CruiseSummary['summary']['violations'] = [];
    /** Probes that were genuinely on disk at the moment the cruise ran. */
    let presentAtCruise: string[] = [];
    beforeAll(() => {
      // Written directly rather than through `plant`, because the enclosing
      // `afterEach` tears `plant`'s files down after EVERY test and these
      // six have to survive the whole block. Cleanup is `afterAll`'s.
      for (const [rel, body] of PROBES) {
        const abs = join(repoRoot, rel);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, body);
      }
      presentAtCruise = PROBES.map(([rel]) => rel).filter((rel) =>
        existsSync(join(repoRoot, rel)),
      );
      violations = cruise(['packages', 'apps']).summary.violations;
    }, CRUISE_BUDGET_MS);
    afterAll(() => {
      for (const [rel] of PROBES) rmSync(join(repoRoot, rel), { force: true });
      rmSync(join(repoRoot, 'apps/desktop/src/__s8_probe__'), {
        recursive: true,
        force: true,
      });
    });

    /** Which files a given rule flagged in the one cruise above. */
    const flaggedBy = (rule: string): string[] =>
      violations.filter((v) => v.rule.name === rule).map((v) => v.from);

    it('row 1: the merged rule is gone and both halves exist by name', () => {
      const config = s8Read('.dependency-cruiser.cjs');
      // Rule NAMES are binding (s1-execution §1.6); a rename is a surface
      // change and this is where it is argued.
      expect(config).toContain("name: 'cli-thin-client'");
      expect(config).toContain("name: 'desktop-thin-client'");
      // The merged rule, spelled from fragments so that renaming it back by
      // find-and-replace cannot also rewrite the assertion that forbids it.
      expect(config).not.toContain(`cli-desktop-${'thin'}-clients`);
    });

    it('row 1: the desktop half carries the bare-specifier shape too', () => {
      // pnpm isolation means `apps/desktop` cannot RESOLVE `@wemessage/cli`
      // unless it declares it, so a path-only rule would miss the sloppiest
      // possible reach — an undeclared import that is a violation twice
      // over. `adapters-thin-clients` learned this in S5; the desktop half
      // inherits the two-shape `to` rather than rediscovering it.
      expect(s8Read('.dependency-cruiser.cjs')).toContain(
        "'^@wemessage/(?!client$|protocol$)'",
      );
    });

    it('row 1 PLANTED: a @wemessage/cli import under apps/desktop/src violates', () => {
      expect(
        flaggedBy('desktop-thin-client'),
        `violations seen: ${JSON.stringify(violations)}`,
      ).toContain('apps/desktop/src/__s8_probe__/back-door.ts');
    });

    it('row 1 NEAR-MISS: client and protocol are exactly what the app may reach', () => {
      expect(
        violations.filter(
          (v) => v.from === 'apps/desktop/src/__s8_probe__/allowed.ts',
        ),
      ).toEqual([]);
    });

    it('row 2: the carve-out is on the from side and scoped to test/', () => {
      expect(s8Read('.dependency-cruiser.cjs')).toContain(
        "pathNot: '^apps/desktop/test/'",
      );
    });

    it('row 2 PLANTED: a daemon import under apps/desktop/src still violates', () => {
      expect(flaggedBy('nobody-imports-daemon')).toContain(
        'apps/desktop/src/__s8_probe__/too-deep.ts',
      );
    });

    it('row 2 NEAR-MISS: the same import under apps/desktop/test does not', () => {
      // F-102: the e2e harness boots a REAL daemon in-process, and the house
      // has nowhere else to do that. A narrow, deliberate, test-only
      // exception paired with a positive assertion on src is a stronger
      // arrangement than the rule this replaces, which had no exception and
      // no assertion because nothing had tried.
      expect(flaggedBy('nobody-imports-daemon')).not.toContain(
        'apps/desktop/test/__s8_probe__harness.ts',
      );
    });

    it('row 8 PLANTED: an electron import in packages/client/src violates', () => {
      expect(flaggedBy('no-electron-outside-desktop')).toContain(
        'packages/client/src/__s8_probe__electron.ts',
      );
    });

    it('row 8 NEAR-MISS: the same import inside apps/desktop/src is fine', () => {
      expect(flaggedBy('no-electron-outside-desktop')).not.toContain(
        'apps/desktop/src/__s8_probe__/shell.ts',
      );
    });

    it('the cruise is not vacuous: it saw the probes and it saw the tree', () => {
      // Six probes, three of which must be flagged and three of which must
      // not. Asserting the count keeps "no violations" from being read as
      // "the cruise found nothing to look at".
      expect(violations.length).toBeGreaterThanOrEqual(3);
      expect(presentAtCruise).toEqual(PROBES.map(([rel]) => rel));
    });
  });

  /* ── row 3: the app knows no URL ───────────────────────────────────── */

  describe('row 3: the renderer and main hold no transport of their own', () => {
    /**
     * The app speaks to the daemon through `@wemessage/client` and through
     * nothing else. Every string below is a way to build a second transport
     * by hand, and the first one that appears is the moment the token, the
     * base URL and the retry policy start having two owners.
     */
    const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
      ['fetch(', /\bfetch\(/],
      ['new WebSocket(', /\bnew WebSocket\(/],
      ["from 'ws'", /from ['"]ws['"]/],
      ['http://127.0.0.1', /https?:\/\/127\.0\.0\.1/],
      ['/v1/ literal', /['"`]\/v1\//],
      ['Authorization', /Authorization/],
    ];
    function transportOffenders(): string[] {
      const out: string[] = [];
      for (const rel of desktopSrcFiles()) {
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel)) continue;
        const text = s8Read(rel);
        for (const [label, re] of FORBIDDEN)
          if (re.test(text)) out.push(`${rel}: ${label}`);
      }
      return out.sort();
    }

    it('no file under apps/desktop/src builds its own transport', () => {
      // Non-vacuity first: an empty src/ would make every row here pass.
      expect(desktopSrcFiles().length).toBeGreaterThan(0);
      expect(transportOffenders()).toEqual([]);
    });

    it('PLANTED: a hand-rolled fetch and a hard-coded loopback URL are both caught', () => {
      const rel = plant(
        'apps/desktop/src/__s8_probe__/transport.ts',
        [
          'export async function drafts(token: string): Promise<unknown> {',
          "  const r = await fetch('http://127.0.0.1:8787' + '/v1/drafts', {",
          "    headers: { Authorization: 'Bearer ' + token },",
          '  });',
          '  return r.json();',
          '}',
          '',
        ].join('\n'),
      );
      const offenders = transportOffenders();
      expect(offenders).toContain(`${rel}: fetch(`);
      expect(offenders).toContain(`${rel}: http://127.0.0.1`);
      expect(offenders).toContain(`${rel}: /v1/ literal`);
      expect(offenders).toContain(`${rel}: Authorization`);
    });

    it('LEGITIMATE NEAR-MISS: naming the client and its types is not a transport', () => {
      const rel = plant(
        'apps/desktop/src/__s8_probe__/gateway-ish.ts',
        [
          "import { createClient } from '@wemessage/client';",
          'export const make = (baseUrl: string, token: string) =>',
          '  createClient({ baseUrl, token });',
          '',
        ].join('\n'),
      );
      expect(transportOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
    });
  });

  /* ── row 6: the S6 CLI ANSI precedent, re-run over the desktop suite ── */

  describe('row 6: no desktop spec logs a coloured line', () => {
    function ansiOffendersUnderDesktopTest(): string[] {
      const out: string[] = [];
      for (const rel of desktopTestFiles()) {
        if (/\.(png|ico|jpg|jpeg|gif|webp|pdf|zip)$/.test(rel)) continue;
        for (const f of ansiOffenders(s8Read(rel)))
          out.push(`${rel}:${f.line}: ${f.detail}`);
      }
      return out.sort();
    }

    it('the desktop test tree is ANSI-free', () => {
      // The sweep is `ansiOffenders`, extracted from `lintTranscript` in this
      // scenario. Not a fourth regex that means the same thing: the S6
      // transcripts, the S7 skill documents and this tree are all swept by
      // one implementation, so "coloured output" has one definition.
      expect(desktopTestFiles().length).toBeGreaterThan(0);
      expect(ansiOffendersUnderDesktopTest()).toEqual([]);
    });

    it('PLANTED: a spec that logs an SGR sequence trips it', () => {
      const rel = plant(
        'apps/desktop/test/__s8_probe__ansi.ts',
        // A REAL escape byte, built at runtime. A probe spelling `\\u001b`
        // would be a probe made of the characters backslash-u-zero-zero-one-b,
        // which is exactly the thing the rule permits — and the near-miss
        // below proves that distinction is deliberate rather than lucky.
        `export const banner = '${String.fromCharCode(27)}[32mOK';\n`,
      );
      expect(ansiOffendersUnderDesktopTest().join('\n')).toContain(rel);
    });

    it('LEGITIMATE NEAR-MISS: the glyph vocabulary is not colour', () => {
      // §3.10's whole point: ● ○ ◐ ⊘ ◌ carry state, so a spec that asserts
      // them is asserting the thing that replaced colour, not smuggling it.
      const rel = plant(
        'apps/desktop/test/__s8_probe__glyphs.ts',
        "export const GLYPHS = ['\\u25CF', '\\u25CB', '\\u25D0', '\\u2298', '\\u25CC'];\n",
      );
      expect(
        ansiOffendersUnderDesktopTest().filter((o) => o.startsWith(rel)),
      ).toEqual([]);
    });
  });

  /* ── row 7: there is no send channel ───────────────────────────────── */

  describe('row 7: the IPC surface has no path to send (INV-2 at the GUI boundary)', () => {
    const CHANNELS_FILE = 'apps/desktop/src/main/ipc-channels.ts';
    /** Every `'wm:…'` value the channel table declares. */
    function channelValues(): string[] {
      return [...s8Read(CHANNELS_FILE).matchAll(/'(wm:[^']+)'/g)]
        .map((m) => m[1] as string)
        .sort();
    }

    it('the channel table is closed, non-trivial, and names nothing sendable', () => {
      const values = channelValues();
      // Non-vacuity: a file with two channels in it would pass the /send/i
      // assertion for the wrong reason. The §1.7 table is 40 rows and the
      // floor is set below it so a legitimate edit does not fight the guard,
      // but far above "somebody deleted the constants".
      expect(values.length).toBeGreaterThanOrEqual(30);
      expect(new Set(values).size).toBe(values.length);
      expect(values.filter((v) => /send/i.test(v))).toEqual([
        'wm:wizard.send-test',
      ]);
      // The key, not just the value: `send: 'wm:dispatch'` would pass the
      // line above and be exactly the thing this row exists to stop.
      expect(s8Read(CHANNELS_FILE)).not.toMatch(/^\s*send\s*:/m);
    });

    it('the only route to the send backend stays dispatchApproved, not the GUI', () => {
      // Inherited, not duplicated. s7 Sc13 proved there is exactly ONE
      // `SendBackend.send` call site in the tree and the ratchet's importer
      // allowlist is the standing assertion about who may even NAME the
      // capability. The desktop-specific claim is the narrow one: no file in
      // this app is on that list.
      expect(
        PORT_IMPORTER_ALLOWLIST.filter((f) => f.startsWith('apps/')),
      ).toEqual([]);
      expect(PORT_IMPORTER_ALLOWLIST.length).toBeGreaterThan(0);
    });

    /**
     * Every call of a `.send(` method under `apps/desktop/src`, one entry per
     * occurrence, comments and string bodies stripped.
     *
     * The `webContents` form is main pushing a frame AT the renderer over an
     * enumerated channel; it is the opposite direction and it is already
     * pinned by the channel-list rows above. Everything else is a candidate
     * for the outbound path this row exists to keep at one.
     */
    const sendCallSites = (): string[] =>
      desktopSrcFiles()
        .filter((rel) => /\.(ts|tsx)$/.test(rel))
        .flatMap((rel) =>
          [...codeOf(s8Read(rel)).matchAll(/([A-Za-z_$][\w$]*|\))\.send\(/g)]
            .filter((m) => m[1] !== 'webContents')
            .map(() => rel),
        );

    it('exactly one outbound send call exists in the app, and it is the wizard handler', () => {
      // TIGHTENED AT THE S8 CLOSE. What stood here was the Sc 1 subset
      // assertion, with a comment promising Sc 4 would make it an equality
      // once `gateway.ts` existed. Sc 4 landed and the promise did not, and
      // the sweep found the row was worse than merely loose: it filtered on
      // the literal `client.send(`, while the call the app actually makes is
      // `requireClient().send(`. The receiver is a CALL, not a name, so the
      // regex matched nothing, the subset assertion held over an empty list,
      // and the row could not have failed for any edit to any file. A guard
      // that passes on the empty set is a guard that is not there.
      //
      // The predicate now reads the receiver as either an identifier or a
      // closing paren, which covers `client.send(`, `requireClient().send(`
      // and `getClient().send(` alike, and the enumeration is asserted
      // non-empty before anything is concluded from it.
      const callers = sendCallSites();
      expect(callers.length).toBe(1);
      expect(callers).toEqual(['apps/desktop/src/main/gateway.ts']);
      // …and it is the wizard's handler, not merely the wizard's file. The
      // one occurrence has to sit inside the block registered for
      // `CHANNELS.sendTest`, which is the block that refuses any pair the
      // operator did not arm and clears the pair before the request leaves.
      const code = codeOf(s8Read('apps/desktop/src/main/gateway.ts'));
      const handler = code.slice(code.indexOf('sendTest: async'));
      expect(handler).not.toBe('');
      expect(handler).toContain('.send(');
      expect(handler.slice(0, handler.indexOf('.send('))).toContain(
        'sendTestTarget = null',
      );
    });

    it('PLANTED: a send call outside gateway.ts is caught, in either receiver form', () => {
      // Both forms, because the gap the close found was exactly the gap
      // between them: a probe that only ever writes `client.send(` cannot
      // notice that the production form is spelled the other way.
      const named = plant(
        'apps/desktop/src/__s8_probe__/quick-send.ts',
        [
          'export async function shortcut(client: { send: (a: unknown) => Promise<void> }) {',
          "  await client.send({ to: '+15550000000', body: 'hi' });",
          '}',
          '',
        ].join('\n'),
      );
      const called = plant(
        'apps/desktop/src/__s8_probe__/quick-send-2.ts',
        [
          'declare function grab(): { send: (a: unknown) => Promise<void> };',
          'export async function shortcut() {',
          "  await grab().send({ to: '+15550000001', body: 'hi' });",
          '}',
          '',
        ].join('\n'),
      );
      const callers = sendCallSites();
      expect(callers).toContain(named);
      expect(callers).toContain(called);
      expect(callers.length).toBe(3);
    });
  });

  /* ── row 9: the wireframe set is a closed spec ─────────────────────── */

  describe('row 9: the screen registry is closed (F-113)', () => {
    const ROUTER = 'apps/desktop/src/renderer/router.ts';
    function constArray(name: string): string[] {
      const m = new RegExp(
        `export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`,
        'm',
      ).exec(s8Read(ROUTER));
      if (m === null) return [];
      return [...(m[1] as string).matchAll(/'([^']+)'/g)].map(
        (x) => x[1] as string,
      );
    }

    it('SCREENS is §1.7; WIZARD_STEPS is §1.7 plus the s9 Sc7 amendment', () => {
      /*
       * Both arrays are closed, and the row's job is to make growing either
       * one a reviewed diff rather than a quiet one. It did that job: s9 Sc7
       * added a sixth wizard step and this was the row that said so, before
       * the step reached a snapshot.
       *
       * The step is authorised, and by a document rather than by whoever
       * wrote it: `docs/plans/slices/s9-execution.md`, Scenario 7 row 5,
       * "the new step 'Keep it running' (after the permission probes,
       * before the send test)". Position is part of the claim, so the
       * equality below places it where the plan places it, between the last
       * permission probe and the send test, rather than merely containing
       * it. A step appended to the end would still fail here.
       *
       * SCREENS is untouched, and deliberately: the wizard is a modal flow
       * with its own registry, not a sidebar destination, so a wizard step
       * is never also a screen. That is why this row reads both arrays.
       */
      expect(constArray('SCREENS')).toEqual([
        'queue',
        'rules',
        'schedule',
        'people',
        'audit',
        'settings',
      ]);
      expect(constArray('WIZARD_STEPS')).toEqual([
        'welcome',
        'full-disk',
        'automation',
        'optional',
        'keep-running',
        'send-test',
      ]);
    });

    it('the screens/ directory set is exactly the registry plus wizard', () => {
      // Scope explosion in a GUI slice is not a risk to be monitored, it is
      // a rule to be mechanised. A seventeenth screen fails here, and the
      // failure is the prompt to argue it into the plan first.
      const dir = join(repoRoot, 'apps/desktop/src/renderer/screens');
      const dirs = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      expect(dirs).toEqual([
        'audit',
        'people',
        'queue',
        'rules',
        'schedule',
        'settings',
        'wizard',
      ]);
      // And every screen in the registry has a directory: the two lists are
      // pinned to each other, not merely each pinned to a literal.
      for (const screen of constArray('SCREENS'))
        expect(dirs, `${screen} has no screens/ directory`).toContain(screen);
    });

    it('PLANTED: an eighth screen directory fails the row', () => {
      mkdirSync(join(repoRoot, 'apps/desktop/src/renderer/screens/insights'), {
        recursive: true,
      });
      plant(
        'apps/desktop/src/renderer/screens/insights/index.tsx',
        'export default function InsightsScreen(): null {\n  return null;\n}\n',
      );
      const dirs = readdirSync(
        join(repoRoot, 'apps/desktop/src/renderer/screens'),
        { withFileTypes: true },
      )
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      expect(dirs).toContain('insights');
      rmSync(join(repoRoot, 'apps/desktop/src/renderer/screens/insights'), {
        recursive: true,
        force: true,
      });
    });
  });

  /* ── row 10: the dependency list is closed ─────────────────────────── */

  describe('row 10: the §1.2 dependency list, pinned so an addition is a diff', () => {
    interface DesktopPkg {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
    const pkg = (): DesktopPkg =>
      JSON.parse(s8Read('apps/desktop/package.json')) as DesktopPkg;

    it('dependencies and devDependencies are exactly §1.2', () => {
      // `preact` is a dependency and not a devDependency on purpose: it ships
      // inside the renderer bundle. Everything else is build- or test-time.
      //
      // s8 Sc4 added the two workspace links. They are not a widening of the
      // §1.2 list, they are the list becoming TRUE: `desktop-thin-client`
      // has said since Sc 1 that this app may reach `@wemessage/client` and
      // `@wemessage/protocol` and nothing else, and pnpm does not hoist, so
      // an undeclared dependency is one that does not resolve. The row that
      // matters is the cruiser rule; this one keeps the manifest honest
      // about what the rule permits.
      expect(Object.keys(pkg().dependencies ?? {}).sort()).toEqual([
        '@wemessage/client',
        '@wemessage/protocol',
        'preact',
      ]);
      //
      // s9 Sc 1 row 9 GROWS this list by exactly four build-time packages
      // (`@electron/fuses`, `electron-builder`, `esbuild`, `gifenc`) and
      // states that growth as its own equality. This row is updated in
      // place rather than weakened to a subset: two independent exact
      // equalities over the same manifest is the strong shape — a
      // thirteenth devDependency has to be written down in two files
      // before it is legal, and a drift between the two lists fails
      // loudly here rather than being absorbed by a `toContain`.
      expect(Object.keys(pkg().devDependencies ?? {}).sort()).toEqual([
        '@electron/fuses',
        '@preact/preset-vite',
        '@types/pngjs',
        'axe-core',
        'electron',
        'electron-builder',
        'esbuild',
        'gifenc',
        'pixelmatch',
        'playwright-core',
        'pngjs',
        'vite',
      ]);
      // Workspace protocol, not a version range: a semver range here would
      // silently resolve to a published copy the day one exists.
      const deps = pkg().dependencies ?? {};
      expect(deps['@wemessage/client']).toBe('workspace:*');
      expect(deps['@wemessage/protocol']).toBe('workspace:*');
    });

    it('the list is not decorative: every entry is actually installed', () => {
      // The failure this catches is a package.json that names a dependency
      // the lockfile does not carry — a list that reads correctly and buys
      // nothing. Enumeration asserted, then each member checked.
      //
      // Eleven at s8, fifteen from s9 Sc 1 row 9: three dependencies plus
      // twelve devDependencies. The count is restated rather than derived
      // from the lists above so that a member deleted from BOTH equalities
      // in the same careless edit still fails something.
      const p = pkg();
      const names = [
        ...Object.keys(p.dependencies ?? {}),
        ...Object.keys(p.devDependencies ?? {}),
      ];
      expect(names.length).toBe(15);
      expect(
        names.filter(
          (n) =>
            !existsSync(
              join(repoRoot, 'apps/desktop/node_modules', n, 'package.json'),
            ),
        ),
      ).toEqual([]);
    });

    it('electron is in pnpm.onlyBuiltDependencies, or its binary never downloads', () => {
      // pnpm 10 blocks postinstall scripts by default; electron's postinstall
      // IS the binary download, so without this line the app has no shell and
      // the e2e harness has nothing to launch (F-99).
      const root = JSON.parse(s8Read('package.json')) as {
        pnpm?: { onlyBuiltDependencies?: string[] };
      };
      expect(root.pnpm?.onlyBuiltDependencies ?? []).toContain('electron');
    });

    it('licenses:check walks the desktop subtree, not only the root', () => {
      // s7 Sc12 found that pnpm's lack of hoisting means license-checker sees
      // only what is reachable from the --start root it is given. A new
      // publish-graph root therefore needs its own pass, or seven new
      // packages are licence-checked by nobody.
      const scripts = (
        JSON.parse(s8Read('package.json')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      expect(scripts['licenses:check']).toContain('--start apps/desktop');
    });
  });

  /* ── row 11: lint reaches the new code ─────────────────────────────── */

  describe('row 11: eslint type-aware coverage reaches apps/desktop TSX', () => {
    /**
     * A rule's numeric severity in a resolved flat config.
     *
     * ESLint normalises `'off' | 'warn' | 'error'` to `0 | 1 | 2` when it
     * calculates a config, so comparing against the STRING the config file
     * spells passes vacuously — `undefined !== 'off'` is true for a rule
     * that is not configured at all, which is exactly the near-miss this row
     * needs to distinguish from a rule that is deliberately disabled.
     */
    function severityOf(
      config: { rules?: Record<string, unknown> },
      rule: string,
    ): number | undefined {
      const entry = config.rules?.[rule];
      if (entry === undefined) return undefined;
      const value = Array.isArray(entry) ? entry[0] : entry;
      if (typeof value === 'number') return value;
      return { off: 0, warn: 1, error: 2 }[String(value)];
    }

    it('a .tsx under apps/desktop/src gets the type-aware rules', async () => {
      // Asked of ESLint itself rather than of a glob library: the question is
      // "what config applies to this file", and ESLint is the only thing that
      // can answer it without a second implementation of flat-config
      // resolution (and without a new dependency the plan did not ratify).
      const rel = plant(
        'apps/desktop/src/__s8_probe__/Screen.tsx',
        'export default function Probe(): null {\n  return null;\n}\n',
      );
      const eslint = new ESLint({ cwd: repoRoot });
      expect(await eslint.isPathIgnored(rel)).toBe(false);
      const config = await eslint.calculateConfigForFile(rel);
      const rules = config.rules ?? {};
      // These three are type-aware and cannot run without a project service,
      // so their presence proves the parser is configured, not merely that
      // some block matched.
      expect(rules['@typescript-eslint/no-floating-promises']).toBeDefined();
      expect(rules['@typescript-eslint/consistent-type-imports']).toBeDefined();
      expect(rules['@typescript-eslint/no-explicit-any']).toBeDefined();
    });

    it('the desktop keeps its no-restricted-imports override', async () => {
      // `electron` is banned by that rule everywhere else in the tree. The
      // app is the one place it is the point, and dependency-cruiser's
      // no-electron-outside-desktop is what fences it (row 8), so the eslint
      // override is not a hole — it is the same boundary drawn once.
      const rel = plant(
        'apps/desktop/src/__s8_probe__/Main.tsx',
        "import { app } from 'electron';\nexport const n = (): string => app.getName();\n",
      );
      const config = await new ESLint({ cwd: repoRoot }).calculateConfigForFile(
        rel,
      );
      expect(severityOf(config, 'no-restricted-imports')).toBe(0);
    });

    it('LEGITIMATE NEAR-MISS: a package .ts is unaffected by the widening', async () => {
      const config = await new ESLint({ cwd: repoRoot }).calculateConfigForFile(
        'packages/core/src/index.ts',
      );
      expect(
        config.rules?.['@typescript-eslint/no-floating-promises'],
      ).toBeDefined();
      expect(severityOf(config, 'no-restricted-imports')).toBe(2);
    });
  });

  /* ── row 12: the capability scan reaches the app ───────────────────── */

  describe('row 12: the port-importer ratchet scans apps/*/src', () => {
    it('apps is one of the production-source roots', () => {
      expect([...PRODUCTION_SOURCE_ROOTS]).toContain('apps');
      expect([...PRODUCTION_SOURCE_ROOTS]).toContain('packages');
    });

    it('the scan actually reaches desktop files', () => {
      const scanned = productionSourceFiles().map(s8Rel);
      expect(scanned).toContain('apps/desktop/src/index.ts');
    });

    it('PLANTED: naming SendBackend under apps/desktop/src breaks the allowlist row', () => {
      const rel = plant(
        'apps/desktop/src/__s8_probe__/capability.ts',
        [
          "import type { SendBackend } from '@wemessage/core';",
          'export type Backend = SendBackend;',
          '',
        ].join('\n'),
      );
      // Run the RATCHET's own predicate, not a copy of it: the claim is that
      // the ratchet row would fail, and only the ratchet's function can make
      // that claim true.
      const importers = portImporters();
      expect(importers).toContain(rel);
      expect(importers).not.toEqual([...PORT_IMPORTER_ALLOWLIST]);
    });

    it('LEGITIMATE NEAR-MISS: a desktop file naming the client is not a capability', () => {
      const rel = plant(
        'apps/desktop/src/__s8_probe__/no-capability.ts',
        [
          "import type { GatewayClient } from '@wemessage/client';",
          'export type C = GatewayClient;',
          '',
        ].join('\n'),
      );
      expect(portImporters()).not.toContain(rel);
      expect(portImporters()).toEqual([...PORT_IMPORTER_ALLOWLIST]);
    });
  });

  /* ── row 13: the public sweep, plus the raster enumeration ─────────── */

  describe('row 13: the repo is still publishable, and ships no raster', () => {
    const tracked = (pattern: string): string[] =>
      execFileSync('git', ['ls-files', '--', pattern], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0)
        .sort();
    /**
     * The one raster this repo tracks, and the reason it is allowed to.
     *
     * Empty from Sc 17 through the whole of S8, and the reason for that is
     * unchanged and restated below: NO golden PNG has been committed and
     * none will be. What changed at s9 Sc 6 is that the app acquired a
     * PACKAGING INPUT. `electron-builder` hands `dmg-background.png` to
     * Finder to composite behind the drag-to-Applications arrow, and the
     * DMG format takes a raster or it takes nothing — there is no vector
     * path to argue for.
     *
     * So the admission is bounded by LOCATION as well as by name, in the
     * row below. Anything under `apps/desktop/build/` is a build input:
     * reproducible from `site/logo/mark.svg` by
     * `apps/desktop/scripts/render-brand-assets.sh`, and decoded and swept
     * pixel by pixel by `apps/desktop/test/tokens.spec.ts` row 3b rather
     * than merely named. A PNG anywhere else is a screenshot, and still
     * fails on sight.
     *
     * `icon.icns` is NOT here because this row reads `*.png` only. The
     * all-extensions equality is tokens.spec.ts row 3a, which is the
     * stronger of the two and says so.
     *
     * THE SC 17 REASONING, retained because it is what keeps this list from
     * growing a third member:
     *
     * Sc 1 wrote this list expecting Sc 17 to commit two reduced-transparency
     * reference PNGs and then tighten the subset below into an equality. Sc 17
     * committed none, for three reasons that all point the same way. A golden
     * PNG of a real window is a machine-dependent artefact — this window is
     * translucent over a macOS material, and what sits behind it is not in the
     * page. It is also a SNAPSHOT, and the mutation discipline says a teeth
     * mutation must fail a structural row rather than a picture, so a golden
     * would be an instrument the slice is not allowed to lean on. And a repo
     * that bans rasters cannot make an exception for its own test data
     * without the ban meaning "except where we found it inconvenient".
     *
     * What replaced it is stronger and needs nothing committed: the window's
     * ALPHA CENSUS. `#app` covers the viewport and paints `--layer-1`, so the
     * thinnest pixel in a capture is predictable from the token sheet — 184
     * for 0.72, 199 for 0.78, 255 for the reduced branch — and `a11y.spec.ts`
     * asserts the equality rather than a ratio against a picture of last week.
     */
    const BUILD_INPUT_PNGS: readonly string[] = [
      'apps/desktop/build/dmg-background.png',
    ];

    it('no brand string, no operator handle, no absolute home path', () => {
      expect(publicRepoOffenders()).toEqual([]);
    });

    it('the repo tracks no raster but the DMG background', () => {
      // Equality from Sc 17. s9 Sc 6 moved the list from empty to one, and
      // moving it is a two-file diff: this row and tokens.spec.ts row 3a.
      expect(tracked('*.png')).toEqual([...BUILD_INPUT_PNGS]);
      // Bounded by LOCATION, not only by name. Without this a golden could
      // join the list by being appended to it, which is the exact move the
      // paragraph above spends twenty lines refusing.
      expect(
        BUILD_INPUT_PNGS.filter((p) => !p.startsWith('apps/desktop/build/')),
      ).toEqual([]);
    });

    it('PLANTED: a screenshot committed anywhere else fails the row', () => {
      // `--intent-to-add` so the ENUMERATION half runs: a probe git cannot
      // see would exercise the filter and skip the `git ls-files` call that
      // is the actual mechanism.
      const rel = plant(
        'apps/desktop/assets/__s8_probe__shot.png',
        'not really a png\n',
        true,
      );
      const pngs = tracked('*.png');
      expect(pngs).toContain(rel);
      expect(pngs.filter((p) => !BUILD_INPUT_PNGS.includes(p))).toEqual([rel]);
    });

    it('LEGITIMATE NEAR-MISS: a monochrome template SVG is not a raster', () => {
      // Sc 16's tray glyphs are SVG precisely so macOS can tint them; the
      // rule is about rasters, and an SVG the system recolours is the
      // opposite of a baked-in colour.
      const rel = plant(
        'apps/desktop/assets/__s8_probe__trayTemplate.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n',
        true,
      );
      expect(tracked('*.png')).not.toContain(rel);
      expect(
        tracked('*.png').filter((p) => !BUILD_INPUT_PNGS.includes(p)),
      ).toEqual([]);
    });
  });

  /* ── row 14: readiness, not sleeping ───────────────────────────────── */

  describe('row 14: the desktop suite waits on state, never on the clock', () => {
    const SLEEPS: ReadonlyArray<readonly [string, RegExp]> = [
      ['setTimeout(', /\bsetTimeout\(/],
      ['waitForTimeout(', /\bwaitForTimeout\(/],
    ];
    function sleepOffenders(): string[] {
      const out: string[] = [];
      for (const rel of desktopTestFiles()) {
        if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel)) continue;
        const text = s8Read(rel);
        for (const [label, re] of SLEEPS)
          if (re.test(text)) out.push(`${rel}: ${label}`);
      }
      return out.sort();
    }

    it('nothing under apps/desktop/test sleeps', () => {
      expect(desktopTestFiles().length).toBeGreaterThan(0);
      expect(sleepOffenders()).toEqual([]);
    });

    it('PLANTED: a timed wait is caught', () => {
      const rel = plant(
        'apps/desktop/test/__s8_probe__sleep.ts',
        'export const settle = () =>\n  new Promise((r) => setTimeout(r, 250));\n',
      );
      expect(sleepOffenders()).toContain(`${rel}: setTimeout(`);
    });

    it('LEGITIMATE NEAR-MISS: waiting on the readiness attribute is the sanctioned wait', () => {
      const rel = plant(
        'apps/desktop/test/__s8_probe__ready.ts',
        [
          'export const ready = (page: { waitForSelector: (s: string) => Promise<void> }) =>',
          '  page.waitForSelector(\'html[data-conn="connected"]\');',
          '',
        ].join('\n'),
      );
      expect(sleepOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
    });
  });

  /* ── row 15: a11y findings are not suppressed ──────────────────────── */

  describe('row 15: axe is not allowed to be told to look away', () => {
    const SUPPRESSIONS: ReadonlyArray<readonly [string, RegExp]> = [
      ['disableRules', /disableRules/],
      ['.exclude(', /\.exclude\(/],
    ];
    function suppressionOffenders(): string[] {
      const out: string[] = [];
      for (const rel of desktopTestFiles()) {
        if (!/\.(ts|tsx|js|mjs|cjs|json)$/.test(rel)) continue;
        const text = s8Read(rel);
        for (const [label, re] of SUPPRESSIONS)
          if (re.test(text)) out.push(`${rel}: ${label}`);
      }
      return out.sort();
    }

    interface Suppression {
      rule?: string;
      reason?: string;
    }
    /** The allowlist's own schema, applied to whatever the file holds. */
    function allowlistOffenders(entries: readonly Suppression[]): string[] {
      return entries
        .filter((e) => (e.reason ?? '').length < 40)
        .map((e) => `${e.rule ?? '<unnamed>'}: reason too short`);
    }

    it('no desktop spec disables an axe rule or excludes a subtree', () => {
      expect(suppressionOffenders()).toEqual([]);
    });

    it('the allowlist parses, is an array, and every entry carries a real reason', () => {
      const entries = JSON.parse(
        s8Read('apps/desktop/test/a11y-allowlist.json'),
      ) as Suppression[];
      expect(Array.isArray(entries)).toBe(true);
      expect(allowlistOffenders(entries)).toEqual([]);
      // Empty at Sc 1, so the loop above is vacuous — and a vacuous
      // validator is the exact failure mode this scenario keeps naming. The
      // predicate is therefore exercised directly on a synthetic entry.
      expect(
        allowlistOffenders([{ rule: 'color-contrast', reason: 'later' }]),
      ).toEqual(['color-contrast: reason too short']);
      expect(
        allowlistOffenders([
          {
            rule: 'color-contrast',
            reason:
              'forty characters is roughly one sentence of actual justification',
          },
        ]),
      ).toEqual([]);
    });

    it('PLANTED: a spec that narrows axe is caught', () => {
      const rel = plant(
        'apps/desktop/test/__s8_probe__axe.ts',
        [
          'export const run = (axe: { disableRules: (r: string[]) => void }) =>',
          "  axe.disableRules(['color-contrast']);",
          '',
        ].join('\n'),
      );
      expect(suppressionOffenders()).toContain(`${rel}: disableRules`);
    });

    it('LEGITIMATE NEAR-MISS: scoping axe to the app root is not a suppression', () => {
      const rel = plant(
        'apps/desktop/test/__s8_probe__axe-include.ts',
        "export const SCOPE = { include: [['#app']] };\n",
      );
      expect(suppressionOffenders().filter((o) => o.startsWith(rel))).toEqual(
        [],
      );
    });
  });
});

/**
 * s8 Sc 4 — the shell's static guards.
 *
 * Three of Sc 4's claims cannot be made from inside a running app, so they
 * are made here:
 *
 *  - **The harness runs in CI.** A harness that only runs on laptops is not
 *    a harness. Electron needs a display, so the Linux job has to provide
 *    one, and the binary download has to be cached or every run pays for it.
 *  - **The token has a LOCALITY, like colour does.** `tokens.css` is the one
 *    file that may name a colour; `main/auth.ts` is the one file that may
 *    name the credential. The renderer and the preload — the two things that
 *    live in, or hand things to, a Chromium process — may not mention it at
 *    all, so "can the renderer reach the token" is a question answerable by
 *    reading two directories and finding nothing.
 *  - **The window is constructed once, from one frozen options object.** The
 *    e2e reads those options back through the test-state mirror, and that
 *    reading is only worth anything if there is exactly one construction
 *    site and it is handed exactly that object.
 */
describe('S8 extensions (s8-execution Scenario 4: the Electron shell)', () => {
  const read = (rel: string): string =>
    readFileSync(join(repoRoot, rel), 'utf8');
  const listFiles = (rel: string): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else
          out.push(
            full
              .slice(repoRoot.length + 1)
              .split('\\')
              .join('/'),
          );
      }
    };
    if (existsSync(join(repoRoot, rel))) walk(join(repoRoot, rel));
    return out.sort();
  };

  /* ── row 8: the harness runs on Linux, in CI, with a cached binary ── */

  describe('row 8: ci-linux runs the desktop lane under a display', () => {
    interface Step {
      readonly run: string | null;
      readonly uses: string | null;
      readonly body: string;
    }
    /**
     * A step reader, not a YAML parser.
     *
     * The repo has no YAML dependency and this scenario does not ratify one
     * (`js-yaml` exists in the store as somebody else's transitive, which is
     * not the same as being installed). The file being read is one this repo
     * writes and this row pins the shape of, so a reader for THAT shape is
     * honest where a general parser would be a new dependency.
     */
    const steps = (text: string): Step[] =>
      text
        .split(/\n {6}- /)
        .slice(1)
        .map((body) => ({
          run: /(?:^|\n)\s*run: (.*)/.exec(body)?.[1]?.trim() ?? null,
          uses: /(?:^|\n)\s*uses: (.*)/.exec(body)?.[1]?.trim() ?? null,
          body,
        }));

    const WORKFLOW = '.github/workflows/ci-linux.yml';

    it('the reader sees a real job, not an empty file', () => {
      const parsed = steps(read(WORKFLOW));
      expect(parsed.length).toBeGreaterThanOrEqual(6);
      expect(parsed.filter((s) => s.uses !== null).length).toBeGreaterThan(0);
      expect(
        parsed.map((s) => s.run).filter((r) => r === 'pnpm build'),
      ).toEqual(['pnpm build']);
    });

    it('the one step that runs the suite runs it under xvfb', () => {
      // `xvfb-run -a` and not a bare `pnpm test`: on Linux the Electron
      // window has nowhere to open without a display, so the desktop project
      // would fail — or worse, be quietly excluded, which is the failure Sc
      // 17's meta rows exist to catch.
      const testSteps = steps(read(WORKFLOW)).filter(
        (s) => s.run !== null && / pnpm test\b|^pnpm test\b/.test(s.run),
      );
      expect(testSteps.length).toBe(1);
      expect(testSteps[0]?.run).toBe('xvfb-run -a pnpm test');
    });

    it('the electron download is cached, keyed on the pinned version', () => {
      const text = read(WORKFLOW);
      const cacheSteps = steps(text).filter((s) =>
        (s.uses ?? '').startsWith('actions/cache@'),
      );
      expect(cacheSteps.length).toBe(1);
      const electron = (
        JSON.parse(read('apps/desktop/package.json')) as {
          devDependencies: Record<string, string>;
        }
      ).devDependencies['electron'];
      expect(electron).toMatch(/^\d+\.\d+\.\d+$/);
      expect(cacheSteps[0]?.body).toContain(String(electron));
      // The cache is worthless unless the download lands where it is cached.
      expect(text).toContain('ELECTRON_CACHE');
      expect(cacheSteps[0]?.body).toContain('.cache/electron');
    });
  });

  /* ── the token has a locality ──────────────────────────────────────── */

  describe('the credential is named in main and nowhere else', () => {
    /** Everything that lives in, or is loaded into, the Chromium process. */
    const RENDERER_SIDE = [
      'apps/desktop/src/renderer',
      'apps/desktop/src/preload',
    ];
    /**
     * What a credential looks like, rather than the WORD "token".
     *
     * The distinction is deliberate and was found the hard way: the wizard's
     * card has to say "token rejected" in prose, and the renderer imports a
     * file called `tokens.css`. Banning the word would have banned the copy
     * and the design system along with the credential. These five are the
     * ways a renderer could actually COME TO HOLD one — the env var, the
     * reader, the header, the file it lives in, and its own prefix.
     */
    const CREDENTIAL: ReadonlyArray<readonly [string, RegExp]> = [
      ['WEMESSAGE_TOKEN', /WEMESSAGE_TOKEN/],
      ['readTokenFile', /readTokenFile/],
      ['Bearer', /Bearer/],
      ['daemon.token', /daemon\.token/],
      ['token prefix', new RegExp(`wm${'_'}`)],
    ];
    function credentialOffenders(): string[] {
      const out: string[] = [];
      for (const root of RENDERER_SIDE)
        for (const rel of listFiles(root)) {
          if (!/\.(ts|tsx|js|mjs|cjs|html)$/.test(rel)) continue;
          const text = read(rel);
          for (const [label, re] of CREDENTIAL)
            if (re.test(text)) out.push(`${rel}: ${label}`);
        }
      return out.sort();
    }

    it('no renderer or preload file mentions the credential', () => {
      // Non-vacuity: both trees exist and carry files.
      for (const root of RENDERER_SIDE)
        expect(listFiles(root).length, root).toBeGreaterThan(0);
      expect(credentialOffenders()).toEqual([]);
    });

    it('PLANTED: a preload that reads the token file is caught', () => {
      const rel = 'apps/desktop/src/preload/__s8_probe__token.ts';
      const abs = join(repoRoot, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(
        abs,
        'export const carry = (t: string): string => `Bearer ${t}`;\n',
      );
      try {
        const offenders = credentialOffenders();
        expect(offenders).toContain(`${rel}: Bearer`);
      } finally {
        rmSync(abs, { force: true });
      }
    });

    it('main is where it lives, and it is one file', () => {
      const owners = listFiles('apps/desktop/src/main')
        .filter((rel) => /\.ts$/.test(rel))
        .filter((rel) => /readTokenFile|WEMESSAGE_TOKEN/.test(read(rel)));
      expect(owners).toEqual(['apps/desktop/src/main/auth.ts']);
    });
  });

  /* ── one window, one frozen options object ─────────────────────────── */

  describe('the BrowserWindow is constructed once, from a frozen constant', () => {
    const WINDOW = 'apps/desktop/src/main/window.ts';

    it('there is exactly one construction site and it passes WINDOW_OPTIONS', () => {
      const text = read(WINDOW);
      expect([...text.matchAll(/new BrowserWindow\(/g)].length).toBe(1);
      expect(text).toContain('new BrowserWindow(WINDOW_OPTIONS)');
      expect(text).toMatch(/Object\.freeze\(/);
      // Every construction site in the whole app, not just this file: a
      // second window built somewhere else would be a second set of
      // webPreferences that no e2e row reads.
      const everywhere = listFiles('apps/desktop/src')
        .filter((rel) => /\.(ts|tsx)$/.test(rel))
        .filter((rel) => /new BrowserWindow\(/.test(read(rel)));
      expect(everywhere).toEqual([WINDOW]);
    });

    it('the hardening flags are written down, and the e2e reads them back', () => {
      // Belt: the source says it. Braces: `shell.e2e.spec.ts` asks the
      // running Chromium what it actually received. Neither alone is enough
      // — a source scan cannot see a flag Electron ignored, and a runtime
      // read cannot fail a file that never shipped.
      const text = read(WINDOW);
      for (const flag of [
        'contextIsolation: true',
        'nodeIntegration: false',
        'sandbox: true',
        'webSecurity: true',
      ])
        expect(text).toContain(flag);
      expect(text).toContain('setWindowOpenHandler');
      expect(text).toContain('will-navigate');
    });
  });
});

/**
 * s8 Sc 5 — the event-stream store's static guards.
 *
 * Three of Scenario 5's claims are about things that are true of the tree
 * rather than of a run, and a running test cannot make them:
 *
 *  - **The reconnect ladder owns no clock.** Every wait in the policy goes
 *    through an injected `delay`, which is why the backoff table can be
 *    asserted exactly rather than approximately. The plan asked for this as
 *    "an arch grep row local to the spec", which is not possible: row 14
 *    bans the literal `setTimeout(` everywhere under `apps/desktop/test`,
 *    so a spec that greps for it fails row 14 the moment it is written.
 *    The row therefore lives here, and it is repo-wide rather than
 *    file-local: the desktop app has exactly ONE timer, at the composition
 *    root that injects it.
 *  - **The queue's reach is three channels wide, and none of them sends.**
 *    INV-2's compile-time half is a `Pick`, which a future edit could widen
 *    in one character. This row reads the store's code — with comments
 *    stripped, because the store's own prose explains the ban and a naive
 *    grep would convict the file for documenting itself — and enumerates
 *    every bridge member it touches.
 *  - **`/v1/events` closes exactly one way.** `verdictFor` claims totality:
 *    on this route a close is a filter refusal and nothing else, so every
 *    other failure is transient and retryable. That claim is about the
 *    DAEMON's route, so it is asserted against the daemon's source. The
 *    other three close codes belong to the adapter transport, which the
 *    desktop never opens.
 */
/**
 * The S8 desktop guards' shared file walker and comment stripper.
 *
 * Hoisted here in s8 Sc6 because Scenario 6's view-layer rows judge the same
 * trees the Scenario 5 rows do, and a second copy of a comment scanner is a
 * second thing that can drift out of agreement with the first.
 */
const ARCH_SKIP = new Set([
  'node_modules',
  'dist',
  // s9 Sc5. `dist-bundle` is the daemon bundle the desktop app now emits, and
  // it is build output in exactly the sense `dist` is: gitignored, rebuilt from
  // source, and full of code this repository did not write. Leaving it in the
  // walk did not make the sweeps stronger, it made them read esbuild's output:
  // the bundled `daemon/main.mjs` inlines the launchd runner, so row 5 convicted
  // a build artifact of spawning a child process. A row that a `pnpm build`
  // can flip is not a guard. The row below pins this set against .gitignore so
  // the entry cannot quietly become a place to hide a real file.
  'dist-bundle',
  // s9 Sc6. The pack's outputs, same argument. `dist-pack` holds a COPIED
  // ELECTRON: ~14 Mach-O binaries and a few thousand files of Chromium's
  // resources, none of it written here and all of it visible to a sweep that
  // walks the filesystem. `dist-pack-next` is the staging name the release
  // lane uses so a failed pack cannot leave a half-built app where the
  // previous good one was.
  'dist-pack',
  'dist-pack-next',
  '.git',
  'coverage',
  '.turbo',
]);
const archRead = (rel: string): string =>
  readFileSync(join(repoRoot, rel), 'utf8');
/** Every code file under a repo-relative root, repo-relative and sorted. */
function archFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ARCH_SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name))
        out.push(
          full
            .slice(repoRoot.length + 1)
            .split('\\')
            .join('/'),
        );
    }
  };
  const abs = join(repoRoot, root);
  if (existsSync(abs)) walk(abs);
  return out.sort();
}

/**
 * Comments out, code in.
 *
 * Every row below is about what the code DOES, and all three of these
 * files explain in prose exactly what they refuse to do. A text grep
 * would therefore convict the most careful file in the tree, which is the
 * self-trip this scenario was warned about. A scanner rather than a
 * regex, because "strip comments" and "do not strip a comment marker
 * inside a string" is not a thing a regex does.
 */
function codeOf(text: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tick' = 'code';
  while (i < text.length) {
    const ch = text[i] ?? '';
    const two = text.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (two === '/*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") mode = 'sq';
      else if (ch === '"') mode = 'dq';
      else if (ch === '`') mode = 'tick';
      out += ch;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (two === '*/') mode = 'code';
      i += two === '*/' ? 2 : 1;
      continue;
    }
    if (ch === '\\') {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === 'sq' && ch === "'") ||
      (mode === 'dq' && ch === '"') ||
      (mode === 'tick' && ch === '`')
    )
      mode = 'code';
    out += ch;
    i += 1;
  }
  return out;
}

describe('S8 extensions (s8-execution Scenario 5: the event-stream store)', () => {
  const sc5Planted: string[] = [];
  function sc5Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc5Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc5Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/__s8_sc5_probe__',
      'apps/desktop/src/renderer/store/__s8_sc5_probe__',
      'test/__s8_sc5_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  it('the comment stripper keeps strings and drops prose', () => {
    // The stripper is the load-bearing part of two rows below, so it is
    // tested directly rather than inferred from their greens.
    expect(codeOf('const a = 1; // setTimeout(x)\n').trim()).toBe(
      'const a = 1;',
    );
    expect(codeOf('/* setTimeout( */ const b = 2;').trim()).toBe(
      'const b = 2;',
    );
    expect(codeOf("const c = '// not a comment';").trim()).toBe(
      "const c = '// not a comment';",
    );
  });

  /* ── the reconnect ladder owns no clock ────────────────────────────── */

  describe('the desktop app has exactly one timer, and it is injected', () => {
    /**
     * The composition root, and the only file allowed to name a real timer.
     *
     * `gateway.ts` is where main assembles the stream out of a transport, a
     * clock and an RNG; the `delay` it passes in is the one place a promise
     * is allowed to know how long a millisecond is. Every other file takes
     * the wait as a parameter, which is why `event-stream.spec.ts` can
     * assert the ladder is 500/1000/2000/4000/8000 with ±20% jitter and
     * finish in no time at all.
     */
    const TIMER_SITE = 'apps/desktop/src/main/gateway.ts';
    const TIMERS = /\b(setTimeout|setInterval)\(/g;

    function timerOffenders(rels: readonly string[]): string[] {
      const out: string[] = [];
      for (const rel of rels) {
        for (const m of codeOf(archRead(rel)).matchAll(TIMERS))
          out.push(`${rel}: ${m[1] ?? ''}(`);
      }
      return [...new Set(out)].sort();
    }

    it('no file under apps/desktop/src schedules its own wait, except the composition root', () => {
      const files = archFiles('apps/desktop/src');
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain('apps/desktop/src/main/event-stream.ts');
      expect(timerOffenders(files.filter((f) => f !== TIMER_SITE))).toEqual([]);
    });

    it('the composition root injects a delay, and the policy consumes it', () => {
      // Non-vacuity: the ban means something only because a real timer
      // exists somewhere, and it is here, wired into the stream as data.
      expect(timerOffenders([TIMER_SITE])).toEqual([
        `${TIMER_SITE}: setTimeout(`,
      ]);
      const policy = codeOf(archRead('apps/desktop/src/main/event-stream.ts'));
      expect(policy).toContain('deps.delay(');
      expect(policy).toContain('deps.random()');
    });

    it('PLANTED: a backoff that schedules itself is caught', () => {
      const rel = sc5Plant(
        'apps/desktop/src/__s8_sc5_probe__/backoff.ts',
        [
          'export const wait = (ms: number): Promise<void> =>',
          '  new Promise<void>((resolve) => {',
          '    setTimeout(resolve, ms);',
          '  });',
          '',
        ].join('\n'),
      );
      expect(timerOffenders(archFiles('apps/desktop/src'))).toContain(
        `${rel}: setTimeout(`,
      );
    });

    it('LEGITIMATE NEAR-MISS: awaiting an injected delay, and saying so, is not a timer', () => {
      const rel = sc5Plant(
        'apps/desktop/src/__s8_sc5_probe__/injected.ts',
        [
          '/** Waits through the injected clock, never through setTimeout(). */',
          'export const wait = (deps: { delay(ms: number): Promise<void> }) =>',
          '  deps.delay(500); // not setTimeout(resolve, 500)',
          '',
        ].join('\n'),
      );
      expect(
        timerOffenders(archFiles('apps/desktop/src')).filter((o) =>
          o.startsWith(rel),
        ),
      ).toEqual([]);
    });
  });

  /* ── the queue's reach is three channels, and none of them sends ───── */

  describe('the optimistic store cannot reach a send (INV-2 in the renderer)', () => {
    const STORE_ROOT = 'apps/desktop/src/renderer/store';
    const WIRING = `${STORE_ROOT}/index.ts`;
    /**
     * The bridge members the queue is allowed to touch, sorted.
     *
     * s8 Sc6 widened this from four to six, deliberately and in one diff:
     * a card that renders a rule NAME and a display NAME needs the two
     * catalogues those names live in, and `rules`/`contacts` were already
     * declared request channels, so nothing new was opened at the IPC
     * boundary to get them. Both additions are READS.
     *
     * s8 Sc8 widens it again, to eight, for `reject` and `recall` — the two
     * writes a keyboard triage needs and the ONLY two it needs. Both were
     * already channels in the registry; no IPC surface was opened for the
     * keymap. `recall` in particular is the opposite of a send: it is the
     * request that stops one. The guarantee this row exists for is unchanged
     * and is asserted separately below: no identifier under the store may
     * match /send/i, so the store still cannot reach the one channel that
     * could dispatch.
     *
     * s8 Sc9 widens it to eleven, again in one diff, for the batch card and
     * the one verb a failed card has:
     *
     *  - `batch` — `GET /v1/batches/:id`, a read of the tallies over one
     *    `batchId`. It is what lets ONE operator act have one answer when
     *    the daemon performed N separate ones.
     *  - `settings` — a read, and the reason it is here rather than
     *    hard-coded: the retry footnote states whether a retry would fall
     *    back to SMS, and a GUI that assumed that would be making a claim
     *    about a different network on the operator's behalf.
     *  - `retry` — the only write, and the closest thing on this list to a
     *    send. It passes the same test `recall` did. It asks the DAEMON to
     *    move a failed draft back to `approved` with a fresh grace window;
     *    the dispatch that eventually follows is the scheduler's, through
     *    `dispatchApproved`, with an Approval row, exactly as for any other
     *    approval. The renderer still cannot send. It can only ask.
     */
    const ALLOWED = [
      'approve',
      'batch',
      'bulk',
      'contacts',
      'drafts',
      'on',
      'recall',
      'reject',
      'retry',
      'rules',
      'settings',
    ];

    /** Every `bridge.<member>` the store's CODE names, sorted and unique. */
    function bridgeReach(rels: readonly string[]): string[] {
      const out: string[] = [];
      for (const rel of rels)
        for (const m of codeOf(archRead(rel)).matchAll(
          /\bbridge\s*\.\s*([A-Za-z_$][\w$]*)/g,
        ))
          out.push(m[1] ?? '');
      return [...new Set(out)].sort();
    }

    /** Anything send-shaped the store's CODE names, as `file: token`. */
    function sendOffenders(rels: readonly string[]): string[] {
      const out: string[] = [];
      for (const rel of rels)
        for (const m of codeOf(archRead(rel)).matchAll(/[A-Za-z_$][\w$]*/g))
          if (/send/i.test(m[0])) out.push(`${rel}: ${m[0]}`);
      return [...new Set(out)].sort();
    }

    it('the store reaches exactly ten request channels and one subscription', () => {
      const files = archFiles(STORE_ROOT);
      expect(files).toContain(WIRING);
      // s8 Sc10 scoped this ONE equality from the whole root to the queue's
      // own binding file. The root grew a second binding (the rules editor
      // reads nine catalogues and writes one), and a union over two files
      // cannot say which file reached which channel — so Sc10 replaced the
      // union with a PARTITION that asserts totality, per-file reach and
      // per-file `Pick` together. That row is strictly stronger than this
      // one was; this row keeps the queue's own list honest, and the ban
      // below still runs over every file under the root.
      expect(bridgeReach([WIRING])).toEqual(ALLOWED);
      // The runtime list and the type-level `Pick` are the same names, so
      // widening one without the other is a diff somebody has to write on
      // purpose.
      const declared = /STORE_CHANNELS = \[([^\]]*)\]/.exec(archRead(WIRING));
      expect(declared).not.toBeNull();
      expect(
        [...(declared?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
      ).toEqual([
        'approve',
        'batch',
        'bulk',
        'contacts',
        'drafts',
        'recall',
        'reject',
        'retry',
        'rules',
        'settings',
      ]);
      // Written across lines in the source, so the type is matched by its
      // members rather than by one spelling of the union's whitespace.
      const pick = /Pick<\s*WmBridge,([\s\S]*?)>/.exec(archRead(WIRING));
      expect(pick).not.toBeNull();
      expect(
        [...(pick?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      ).toEqual(ALLOWED);
    });

    it('exactly one file in the store names a send, and it is the wizard’s', () => {
      // Non-vacuous twice over: there IS a send-capable channel on the
      // bridge, and the store's prose talks about it constantly. The ban is
      // on the code.
      expect(archRead('apps/desktop/src/main/ipc-channels.ts')).toContain(
        "sendTest: 'wm:wizard.send-test'",
      );
      expect(/send/i.test(archRead(WIRING))).toBe(true);
      //
      // s8 Sc15, deliberate amendment. This was `toEqual([])` from Sc5 to
      // Sc14, and it was the right row for a tree where nothing sent. The
      // wizard's step 5 sends, through `POST /v1/send` — which mints a real
      // Draft, a real Approval and dispatches through the one call site —
      // so an emptiness here would now have to be bought by routing the
      // send somewhere the store cannot see, which is worse.
      //
      // The replacement is an EQUALITY, not an allowlist: exactly one file,
      // exactly one identifier. A second sender, or a second send-shaped
      // name in the same file, fails. `isEnding` — Sc9's self-trip, which
      // lowercases to contain "sending" — would still fail here, and it was
      // renamed rather than exempted for exactly that reason.
      expect(sendOffenders(archFiles(STORE_ROOT))).toEqual([
        `${STORE_ROOT}/wizard.ts: sendTest`,
      ]);
    });

    it('PLANTED: a store file that reaches for the send-test channel is caught', () => {
      const rel = sc5Plant(
        `${STORE_ROOT}/__s8_sc5_probe__/wire.ts`,
        [
          'export const go = (bridge: { sendTest: () => Promise<unknown> }) =>',
          '  bridge.sendTest();',
          '',
        ].join('\n'),
      );
      const files = archFiles(STORE_ROOT);
      expect(bridgeReach(files)).toContain('sendTest');
      expect(sendOffenders(files)).toContain(`${rel}: sendTest`);
    });

    it('LEGITIMATE NEAR-MISS: a comment about the send ban, over an approve, is clean', () => {
      const rel = sc5Plant(
        `${STORE_ROOT}/__s8_sc5_probe__/documented.ts`,
        [
          '/**',
          ' * An optimistic approve is a display fact. The daemon decides',
          ' * whether anything is sent; sendTest is not reachable from here.',
          ' */',
          'export const go = (bridge: { approve: (id: string) => Promise<unknown> }) =>',
          "  bridge.approve('draft-1'); // never a send",
          '',
        ].join('\n'),
      );
      const files = archFiles(STORE_ROOT);
      expect(sendOffenders(files).filter((o) => o.startsWith(rel))).toEqual([]);
      expect(bridgeReach([WIRING])).toEqual(ALLOWED);
    });
  });

  /* ── /v1/events closes exactly one way ─────────────────────────────── */

  describe('the events route has one close code, which is what makes verdictFor total', () => {
    const SERVER = 'packages/daemon/src/server.ts';
    const POLICY = 'apps/desktop/src/main/event-stream.ts';
    /** The one file allowed to name the other three close codes. */
    const TRANSPORT = 'packages/daemon/src/adapters/transport.ts';

    /**
     * The close codes named inside the `/v1/events` handler.
     *
     * A slice, not a parse: from the route registration to the line that
     * closes it, which in this file is the first `});` at handler indent.
     */
    function closeCodesInEventsRoute(text: string): string[] {
      const body = codeOf(text);
      const start = body.indexOf("app.get('/v1/events',");
      if (start < 0) return ['<route not found>'];
      const end = body.indexOf('\n  });', start);
      const slice = body.slice(start, end < 0 ? body.length : end);
      return [
        ...new Set(
          [...slice.matchAll(/CLOSE_CODES\.([A-Za-z_$][\w$]*)/g)].map(
            (m) => m[1] ?? '',
          ),
        ),
      ].sort();
    }

    it('the websocket route refuses with the protocol code and nothing else', () => {
      expect(closeCodesInEventsRoute(archRead(SERVER))).toEqual(['protocol']);
    });

    it('the other three close codes belong to the adapter transport the desktop never opens', () => {
      const offenders = [...archFiles('packages'), ...archFiles('apps')]
        .filter((f) => /^(packages|apps)\/[^/]+\/src\//.test(f))
        .filter((f) => f !== TRANSPORT)
        .filter((f) => f !== 'packages/protocol/src/index.ts')
        .filter((f) =>
          /CLOSE_CODES\.(auth|timeout|version)\b/.test(codeOf(archRead(f))),
        );
      expect(offenders).toEqual([]);
      // Non-vacuity: the transport really does send all three.
      const transport = codeOf(archRead(TRANSPORT));
      for (const name of ['auth', 'timeout', 'version'])
        expect(transport).toContain(`CLOSE_CODES.${name}.code`);
    });

    it('the desktop maps that one close, plus the upgrade refusal, and retries everything else', () => {
      // `verdictFor` is total by construction — two terminal branches and a
      // retry — and the two branches are exactly the two refusals this
      // route can produce: 401 at the upgrade, 4400 after it.
      const policy = codeOf(archRead(POLICY));
      expect(policy).toContain('DaemonAuthError');
      expect(policy).toContain('DaemonEventFilterError');
      expect(policy).toContain("reason: 'token-rejected'");
      expect(policy).toContain("reason: 'stream-refused'");
      expect(policy).toContain('return { retry: true }');
    });

    it('PLANTED: a second close code on the events route is caught', () => {
      const rel = sc5Plant(
        'test/__s8_sc5_probe__/events-route.ts',
        [
          'declare const app: {',
          '  get(p: string, o: object, h: (s: Sock, r: object) => void): void;',
          '};',
          'declare const CLOSE_CODES: Record<string, { code: number }>;',
          'interface Sock {',
          '  close(code: number): void;',
          '}',
          "app.get('/v1/events', { websocket: true }, (socket) => {",
          '  socket.close(CLOSE_CODES.auth.code);',
          '  socket.close(CLOSE_CODES.protocol.code);',
          '});',
          '',
        ].join('\n'),
      );
      expect(closeCodesInEventsRoute(archRead(rel))).toEqual([
        'auth',
        'protocol',
      ]);
    });

    it('LEGITIMATE NEAR-MISS: two refusal paths with the same code are still one code', () => {
      const rel = sc5Plant(
        'test/__s8_sc5_probe__/two-refusals.ts',
        [
          'declare const app: {',
          '  get(p: string, o: object, h: (s: Sock, r: object) => void): void;',
          '};',
          'declare const CLOSE_CODES: Record<string, { code: number }>;',
          'declare const bad: boolean;',
          'interface Sock {',
          '  close(code: number): void;',
          '}',
          "app.get('/v1/events', { websocket: true }, (socket) => {",
          '  // A rotated token is refused at the upgrade, never here, so',
          '  // CLOSE_CODES.auth.code is not this handler to send.',
          '  if (bad) socket.close(CLOSE_CODES.protocol.code);',
          '  else socket.close(CLOSE_CODES.protocol.code);',
          '});',
          '',
        ].join('\n'),
      );
      expect(closeCodesInEventsRoute(archRead(rel))).toEqual(['protocol']);
    });
  });
});

describe('S8 extensions (s8-execution Scenario 6: the queue’s structure)', () => {
  const sc6Planted: string[] = [];
  function sc6Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc6Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc6Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/components/__s8_sc6_probe__',
      'apps/desktop/src/renderer/screens/__s8_sc6_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  /* ── the view layer reads the store, and only the store ────────────── */

  describe('nothing that renders can reach the bridge', () => {
    /**
     * The view tree: everything that paints, plus the two pure layers the
     * queue derives from.
     *
     * Sc5 made `renderer/store/index.ts` the one module that touches
     * `window.wm`, and typed its input as four bridge keys so that
     * `sendTest` is not in scope. That guarantee is only worth having if the
     * things ON TOP of the store cannot route around it — a card that read
     * the bridge directly would be holding the full `WmBridge`, send channel
     * and all, and would be doing it in the layer with the most files and
     * the least review.
     *
     * So the ban is structural rather than a promise: under these roots
     * there is no `window.wm` and no `bridge.<member>` at all. Data arrives
     * as props, and actions leave as callbacks the composition root wires to
     * the binding.
     */
    const VIEW_ROOTS = [
      'apps/desktop/src/renderer/components',
      'apps/desktop/src/renderer/screens',
      'apps/desktop/src/renderer/keys',
      'apps/desktop/src/renderer/derive',
    ];
    /** The composition root, and the only renderer file allowed the bridge. */
    const ROOTS = [
      'apps/desktop/src/renderer/main.tsx',
      'apps/desktop/src/renderer/store/index.ts',
    ];
    const REACHES: ReadonlyArray<readonly [string, RegExp]> = [
      ['window.wm', /\bwindow\s*\.\s*wm\b/g],
      ['bridge.', /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/g],
    ];

    function reachOffenders(rels: readonly string[]): string[] {
      const out: string[] = [];
      for (const rel of rels) {
        const body = codeOf(archRead(rel));
        for (const [label, re] of REACHES)
          if (re.test(body)) out.push(`${rel}: ${label}`);
      }
      return [...new Set(out)].sort();
    }

    it('the view tree names neither the bridge nor the global it hangs on', () => {
      const files = VIEW_ROOTS.flatMap((root) => archFiles(root));
      expect(files.length).toBeGreaterThan(0);
      expect(reachOffenders(files)).toEqual([]);
    });

    it('the composition root and the store still do, which is what makes the ban mean something', () => {
      // Non-vacuity: the reach EXISTS in this app, in exactly two files,
      // and both are outside the view tree.
      expect(reachOffenders(ROOTS)).toEqual([
        'apps/desktop/src/renderer/main.tsx: window.wm',
        'apps/desktop/src/renderer/store/index.ts: bridge.',
      ]);
      for (const root of ROOTS)
        expect(VIEW_ROOTS.some((v) => root.startsWith(`${v}/`))).toBe(false);
    });

    it('PLANTED: a card that fetches its own drafts is caught', () => {
      const rel = sc6Plant(
        'apps/desktop/src/renderer/components/__s8_sc6_probe__/Eager.tsx',
        [
          'export async function refresh(): Promise<unknown> {',
          '  return window.wm.drafts();',
          '}',
          '',
        ].join('\n'),
      );
      expect(reachOffenders(archFiles(VIEW_ROOTS[0] ?? ''))).toContain(
        `${rel}: window.wm`,
      );
    });

    it('LEGITIMATE NEAR-MISS: a component that explains the ban, and takes props, is clean', () => {
      const rel = sc6Plant(
        'apps/desktop/src/renderer/screens/__s8_sc6_probe__/Card.tsx',
        [
          '/**',
          ' * Reads from the store, never from window.wm: a card holding the',
          ' * bridge would hold every channel on it, including bridge.sendTest.',
          ' */',
          'export function Card(props: { body: string }): string {',
          '  return props.body; // no bridge.anything here',
          '}',
          '',
        ].join('\n'),
      );
      expect(
        reachOffenders(archFiles(VIEW_ROOTS[1] ?? '')).filter((o) =>
          o.startsWith(rel),
        ),
      ).toEqual([]);
    });
  });

  /* ── the demo flag is read once, where policy lives ────────────────── */

  describe('WEMESSAGE_DEMO is read in exactly one file', () => {
    /**
     * `policy.ts` already owns every other environment-derived constant in
     * main, and the demo flag belongs with them for one reason: the badge is
     * a HONESTY affordance. A screenshot of seeded data that does not say so
     * is the failure mode, and a flag read in three places is a flag that
     * will eventually be read as `!== undefined` in one of them and as
     * `=== '1'` in the others.
     */
    const SITE = 'apps/desktop/src/main/policy.ts';
    const FLAG = /WEMESSAGE_DEMO/;

    function readers(): string[] {
      return [...archFiles('apps'), ...archFiles('packages')]
        .filter((f) => /^(apps|packages)\/[^/]+\/src\//.test(f))
        .filter((f) => FLAG.test(codeOf(archRead(f))));
    }

    it('exactly one source file names the flag, and it is the policy module', () => {
      expect(readers()).toEqual([SITE]);
    });

    it('PLANTED: a second reader is caught', () => {
      const rel = sc6Plant(
        'apps/desktop/src/renderer/components/__s8_sc6_probe__/Demo.tsx',
        [
          'export const demo = (env: Record<string, string | undefined>) =>',
          "  env['WEMESSAGE_DEMO'] !== undefined;",
          '',
        ].join('\n'),
      );
      expect(readers()).toContain(rel);
    });
  });

  /* ── one listbox, minted in one place ──────────────────────────────── */

  describe('the queue is one listbox, and its options come from one file', () => {
    const LISTBOX = 'apps/desktop/src/renderer/components/Listbox.tsx';

    function roleSites(role: string): string[] {
      const out: string[] = [];
      for (const rel of archFiles('apps/desktop/src/renderer'))
        if (codeOf(archRead(rel)).includes(`role="${role}"`)) out.push(rel);
      return out.sort();
    }

    it('the listbox role and the option role are declared in the same single file', () => {
      // The e2e asserts one `role="listbox"` in the rendered document. This
      // asserts it in the SOURCE, which is the difference between "no screen
      // we happened to open had two" and "there is one place that can mint
      // one". Sc9's `BatchCard` and Sc7's empty states both render inside
      // this listbox rather than beside it, and this row is what tells the
      // author of either that a second one is a decision, not a detail.
      expect(roleSites('listbox')).toEqual([LISTBOX]);
      expect(roleSites('option')).toEqual([LISTBOX]);
    });

    it('the listbox declares the whole activedescendant contract in one place', () => {
      const body = codeOf(archRead(LISTBOX));
      // Roving focus, not roving tabindex: one tab stop on the container,
      // and the active option named by id. A virtualized list cannot use
      // roving tabindex, because the focused node is unmounted the moment it
      // scrolls out of the window.
      expect(body).toContain('aria-activedescendant');
      expect(body).toContain('aria-multiselectable');
      expect(body).toContain('aria-selected');
      expect(body).toContain('tabIndex={0}');
      expect(body).not.toContain('tabIndex={-1}');
    });
  });
});

describe('S8 extensions (s8-execution Scenario 7: the queue’s edge states)', () => {
  const sc7Planted: string[] = [];
  function sc7Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc7Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc7Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    rmSync(
      join(
        repoRoot,
        'apps/desktop/src/renderer/screens/queue/__s8_sc7_probe__',
      ),
      { recursive: true, force: true },
    );
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const QUEUE = 'apps/desktop/src/renderer/screens/queue';

  /** Every renderer file, as comment-free code keyed by path. */
  function rendererCode(): ReadonlyArray<readonly [string, string]> {
    return archFiles(RENDERER).map(
      (rel) => [rel, codeOf(archRead(rel))] as const,
    );
  }

  /* ── INV-2: recovery paths do not multiply the send ────────────────── */

  describe('the edge states added no second way to approve', () => {
    /**
     * The row this whole scenario exists to make cheap.
     *
     * S7 Sc13 proved there is exactly one call site of the send port in the
     * daemon. This is the same claim one layer out, where the edge states
     * live: a disconnected overlay with a working RETRY, a stale banner with
     * a REFRESH AND APPROVE, an expiry handler that re-approves the
     * replacement — every one of those is a plausible, well-meant feature
     * and every one of them is a second dispatch wearing a recovery's
     * clothes. There is one `bridge.approve(` in the renderer, and a search
     * for it is how a reviewer finds every path that can reach the daemon's
     * approval row at all.
     */
    const SITE = 'apps/desktop/src/renderer/store/index.ts';
    // Two spellings of one pattern, on purpose. A `/g` regex carries
    // `lastIndex` across `.test()` calls, so the one that walks every file
    // is deliberately NOT global and the one that counts is used only with
    // `.match()`, which resets.
    const CALL = /\bbridge\s*\.\s*approve\s*\(/;
    const CALLS = /\bbridge\s*\.\s*approve\s*\(/g;

    function approveSites(): string[] {
      return rendererCode()
        .filter(([, body]) => CALL.test(body))
        .map(([rel]) => rel);
    }

    it('exactly one file in the renderer calls the approve channel', () => {
      expect(approveSites()).toEqual([SITE]);
    });

    it('and it calls it exactly once', () => {
      // One FILE is not one call. A wiring module that approved from both a
      // keystroke path and a "retry the ones that failed" path would satisfy
      // the row above and would be the bug.
      expect(codeOf(archRead(SITE)).match(CALLS)).toHaveLength(1);
    });

    it('exactly one place mints a hypothesis, and it is the guarded one', () => {
      // The TABLE READ, not the field name: `Pending.hypothesis` is declared
      // once as a type and written once as a value, and only the second is
      // the thing worth pinning. `start()` is where the link check, the
      // in-flight check and Sc7's wrong-state check all live, so a second
      // writer would be a card that moves on screen without passing any of
      // them — which is precisely how an operator ends up looking at an
      // `approved` card that nothing ever asked the daemon about.
      const MINT = /\bhypothesis\s*:\s*HYPOTHESIS\[/;
      const MINTS = /\bhypothesis\s*:\s*HYPOTHESIS\[/g;
      const sites = rendererCode().filter(([, body]) => MINT.test(body));
      expect(sites.map(([rel]) => rel)).toEqual([
        'apps/desktop/src/renderer/store/optimistic.ts',
      ]);
      expect((sites[0]?.[1] ?? '').match(MINTS)).toHaveLength(1);
    });

    it('PLANTED: an overlay that retries the approve itself is caught', () => {
      const rel = sc7Plant(
        `${QUEUE}/__s8_sc7_probe__/Retry.tsx`,
        [
          'declare const bridge: { approve(id: string): Promise<unknown> };',
          '// The well-meant version: the link came back, so push the ones',
          '// the operator already pressed. It is a second dispatch.',
          'export async function retryAll(ids: string[]): Promise<void> {',
          '  for (const id of ids) await bridge.approve(id);',
          '}',
          '',
        ].join('\n'),
      );
      expect(approveSites()).toContain(rel);
    });

    it('LEGITIMATE NEAR-MISS: a screen that only names the refusal is clean', () => {
      const rel = sc7Plant(
        `${QUEUE}/__s8_sc7_probe__/Refused.tsx`,
        [
          '// Says that approve is refused while disconnected. Saying it is',
          '// not doing it: no bridge, no channel, one string.',
          'export function refusal(): string {',
          "  return 'APPROVE IS REFUSED WHILE DISCONNECTED';",
          '}',
          '',
        ].join('\n'),
      );
      expect(approveSites()).not.toContain(rel);
    });
  });

  /* ── one tab stop, structurally ────────────────────────────────────── */

  describe('nothing in the queue screen is clickable', () => {
    /**
     * The plan drew two buttons on the disconnected overlay, and the reason
     * they are static text instead is not taste.
     *
     * The window has exactly ONE tabbable node — the listbox container,
     * which holds focus for the whole `aria-activedescendant` contract. Sc8's
     * checkpoint triages twenty drafts on the keyboard alone, and a control
     * that appears only in a transient state is the worst possible place for
     * a stray tab stop: it passes every test that does not happen to be run
     * while the link is down, and then it eats a `Tab` in front of an
     * operator working at speed.
     *
     * So the ban is on the SUBTREE rather than on the overlay. The listbox
     * itself lives under `components/` and is not swept here, which is what
     * keeps the one legitimate tab stop legitimate.
     */
    const INTERACTIVE: ReadonlyArray<readonly [string, RegExp]> = [
      ['<button', /<button\b/],
      ['<a href', /<a\s[^>]*\bhref\b/],
      ['<input', /<input\b/],
      ['onClick', /\bonClick\s*=/],
      ['tabIndex', /\btabIndex\s*=/],
    ];

    function clickables(): string[] {
      const out: string[] = [];
      for (const rel of archFiles(QUEUE)) {
        const body = codeOf(archRead(rel));
        for (const [label, re] of INTERACTIVE)
          if (re.test(body)) out.push(`${rel}: ${label}`);
      }
      return out.sort();
    }

    it('the whole queue subtree mints no control and no tab stop', () => {
      expect(archFiles(QUEUE).length).toBeGreaterThan(0);
      expect(clickables()).toEqual([]);
    });

    it('the listbox, which is outside it, does declare the one tab stop', () => {
      // Non-vacuity from the other side: the pattern exists in this app,
      // once, in the file whose whole job is to own it.
      expect(
        codeOf(archRead('apps/desktop/src/renderer/components/Listbox.tsx')),
      ).toContain('tabIndex={0}');
    });

    it('PLANTED: the RETRY NOW button the plan asked for is caught', () => {
      const rel = sc7Plant(
        `${QUEUE}/__s8_sc7_probe__/RetryButton.tsx`,
        [
          'export function RetryNow(props: { go: () => void }): unknown {',
          '  return <button onClick={props.go}>RETRY NOW</button>;',
          '}',
          '',
        ].join('\n'),
      );
      expect(clickables()).toContain(`${rel}: <button`);
      expect(clickables()).toContain(`${rel}: onClick`);
    });

    it('LEGITIMATE NEAR-MISS: the same affordance as text, naming its key, is clean', () => {
      const rel = sc7Plant(
        `${QUEUE}/__s8_sc7_probe__/RetryText.tsx`,
        [
          'export function RetryNow(): unknown {',
          '  return <span class="queue-overlay-action">RETRY NOW</span>;',
          '}',
          '',
        ].join('\n'),
      );
      expect(clickables().filter((o) => o.startsWith(rel))).toEqual([]);
    });
  });

  /* ── one live region, however many things go wrong at once ─────────── */

  describe('the queue has exactly one live region', () => {
    /**
     * Sc7 adds three surfaces that all want to announce themselves: the
     * empty state, the stale banner and the disconnected overlay. Each of
     * them is a reasonable candidate for `role="status"`, and a screen with
     * four polite live regions announces a dropped link four times over a
     * card the operator is having read to them — which is how a blind
     * operator loses the queue, not a cosmetic problem.
     *
     * `alert` is banned outright rather than counted. An assertive region
     * interrupts, and nothing on this screen is worth interrupting a
     * sentence the operator is in the middle of.
     */
    function regionSites(role: string): string[] {
      return rendererCode()
        .filter(([, body]) => body.includes(`role="${role}"`))
        .map(([rel]) => rel);
    }

    it('one polite region, in the screen that owns the queue', () => {
      expect(regionSites('status')).toEqual([`${QUEUE}/index.tsx`]);
    });

    it('and no assertive one anywhere', () => {
      expect(regionSites('alert')).toEqual([]);
      expect(regionSites('alertdialog')).toEqual([]);
    });

    it('PLANTED: an overlay that announces itself as well is caught', () => {
      const rel = sc7Plant(
        `${QUEUE}/__s8_sc7_probe__/Loud.tsx`,
        [
          'export function Loud(props: { text: string }): unknown {',
          '  return <p role="status">{props.text}</p>;',
          '}',
          '',
        ].join('\n'),
      );
      expect(regionSites('status')).toContain(rel);
    });

    it('PLANTED: and an assertive one is caught even though it is the only one', () => {
      const rel = sc7Plant(
        `${QUEUE}/__s8_sc7_probe__/Urgent.tsx`,
        [
          'export function Urgent(props: { text: string }): unknown {',
          '  return <p role="alert">{props.text}</p>;',
          '}',
          '',
        ].join('\n'),
      );
      expect(regionSites('alert')).toEqual([rel]);
    });
  });
});

describe('S8 extensions (s8-execution Scenario 8: keyboard triage)', () => {
  const sc8Planted: string[] = [];
  function sc8Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc8Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc8Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/queue/__s8_sc8_probe__',
      'apps/desktop/src/renderer/store/__s8_sc8_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const EDITOR = `${RENDERER}/components/Editor.tsx`;
  const RING = `${RENDERER}/screens/queue/UndoRing.tsx`;
  const WIRING = `${RENDERER}/store/index.ts`;

  /**
   * Row 1 — the editable control has exactly one home.
   *
   * The same shape as Sc6's rule for `role="listbox"`, and for the same
   * reason. Sc7 pinned the document to ONE tab stop, on the listbox, and a
   * textarea is a second one: every place that can mint one is a place that
   * can leave the operator's focus somewhere the keymap does not reach. One
   * file means the mount, the focus and the hand-back are one decision.
   *
   * `codeOf` and not the raw text, because half this codebase's comments are
   * about the control this row is restricting and a guard that its own
   * documentation trips is a guard somebody deletes.
   */
  function editorSites(): string[] {
    return archFiles(RENDERER).filter((rel) =>
      /<textarea\b/.test(codeOf(archRead(rel))),
    );
  }

  describe('row 1: one editable control, in one file', () => {
    it('mints a textarea in exactly one place, and it is the editor', () => {
      expect(editorSites()).toEqual([EDITOR]);
      // Non-vacuous: the file really does contain one, so this row is
      // asserting a location rather than an absence.
      expect(codeOf(archRead(EDITOR))).toContain('<textarea');
    });

    it('PLANTED: a card that grows its own textarea is caught', () => {
      const rel = sc8Plant(
        `${RENDERER}/screens/queue/__s8_sc8_probe__/Inline.tsx`,
        [
          'export function Inline(props: { body: string }): unknown {',
          '  return <textarea value={props.body} />;',
          '}',
          '',
        ].join('\n'),
      );
      expect(editorSites()).toContain(rel);
    });

    it('LEGITIMATE NEAR-MISS: prose about the control, over a card, is clean', () => {
      const rel = sc8Plant(
        `${RENDERER}/screens/queue/__s8_sc8_probe__/Documented.tsx`,
        [
          '/**',
          ' * Editing happens elsewhere. A <textarea> inside an option would',
          ' * give the listbox a second focus owner, so this renders text.',
          ' */',
          'export function Documented(props: { body: string }): unknown {',
          '  return <p class="card-body">{props.body}</p>; // not a <textarea>',
          '}',
          '',
        ].join('\n'),
      );
      expect(editorSites()).not.toContain(rel);
      expect(editorSites()).toEqual([EDITOR]);
    });
  });

  /**
   * Row 2 — one call site per write verb, still.
   *
   * Sc7 pinned `bridge.approve(`. Scenario 8 adds two more verbs that move a
   * draft, and the reason the first one was pinned applies to all three: a
   * second call site is a second place a retry, a double-press or an
   * "optimistic" shortcut can turn one keystroke into two writes. The
   * checkpoint counts approvals at the wire; this counts them in the source.
   */
  describe('row 2: every write verb has exactly one call site', () => {
    for (const verb of ['approve', 'reject', 'recall'] as const) {
      const one = new RegExp(`\\bbridge\\s*\\.\\s*${verb}\\s*\\(`);
      const all = new RegExp(`\\bbridge\\s*\\.\\s*${verb}\\s*\\(`, 'g');
      it(`calls bridge.${verb} from one file, once`, () => {
        const callers = archFiles(RENDERER).filter((rel) =>
          one.test(codeOf(archRead(rel))),
        );
        expect(callers).toEqual([WIRING]);
        expect(codeOf(archRead(WIRING)).match(all)).toHaveLength(1);
      });
    }

    it('PLANTED: a second caller anywhere in the renderer is caught', () => {
      const rel = sc8Plant(
        `${RENDERER}/screens/queue/__s8_sc8_probe__/Shortcut.tsx`,
        [
          'export const go = (bridge: { reject: (id: string) => unknown }) =>',
          "  bridge.reject('draft-1');",
          '',
        ].join('\n'),
      );
      const callers = archFiles(RENDERER).filter((f) =>
        /\bbridge\s*\.\s*reject\s*\(/.test(codeOf(archRead(f))),
      );
      expect(callers).toContain(rel);
      expect(callers).not.toEqual([WIRING]);
    });
  });

  /**
   * Row 3 — the ring is drawn from the daemon's instants, not the setting.
   *
   * §1.7's rule, made mechanical. `send.undoGraceSeconds` is what the daemon
   * used to COMPUTE `sendNotBefore`; it is not what the operator is looking
   * at. A ring drawn from the setting would keep sweeping for ten seconds
   * after an operator changed the setting to five, and would be wrong about
   * every approval made before the change. The two instants the daemon
   * supplied are the only honest source, and they arrive on the draft.
   *
   * The no-timer rows elsewhere already ban the interval §1.7 assumed; this
   * says what replaced it, so that the replacement cannot quietly become a
   * poll on the next hand that reads the plan instead of the code.
   */
  describe('row 3: the undo ring has no clock of its own', () => {
    /** Where the two instants become a duration. */
    const DERIVE = `${RENDERER}/derive/queue.ts`;

    it('derives its total from the two instants and animates in CSS', () => {
      // The derivation names both instants and does the arithmetic once.
      const derived = codeOf(archRead(DERIVE));
      expect(derived).toContain('sendNotBefore');
      expect(derived).toContain('stateChangedAt');
      // The component only spends what it was handed, as CSS: an
      // `animation-duration` and the negative `animation-delay` that makes a
      // ring which started before this paint resume where it really is.
      const body = codeOf(archRead(RING));
      expect(body).toContain('animationDuration');
      expect(body).toContain('animationDelay');
      // The setting's NAME may appear in the prose above the code — it is
      // the thing the comments are warning about — but in renderer CODE it
      // has exactly one home, and that home is not a ring.
      //
      // s8 Scenario 14 is the first legitimate namer and the reason this
      // row grew teeth instead of an exemption. A settings screen whose job
      // is to EDIT the eleven writable keys must spell all eleven, and
      // `send.undoGraceSeconds` is one of them; INV-1 keeps the renderer off
      // `@wemessage/core`, so `derive/settingsFields.ts` re-declares the
      // daemon's closed list the way `derive/auditRows.ts` re-declares
      // §1.6's twelve. Listing a key as editable is the opposite of the harm
      // this row exists to prevent: the harm is a ring whose sweep is
      // computed from a NUMBER rather than from the two instants the daemon
      // supplied, and it would show up as this file naming an instant or an
      // animation, or as the ring's derivation reaching for this file. So
      // the row now says all four of those things out loud, and a second
      // namer anywhere in the renderer is still a build failure.
      const SETTING_HOMES = [`${RENDERER}/derive/settingsFields.ts`];
      const namers = archFiles(RENDERER)
        .filter((f) => codeOf(archRead(f)).includes('undoGraceSeconds'))
        .sort();
      expect(namers).toEqual(SETTING_HOMES);
      // Non-vacuity, and the SHAPE of the exemption: it is a settings key,
      // spelled with the namespace the daemon's schema uses.
      const home = codeOf(archRead(SETTING_HOMES[0] ?? ''));
      expect(home).toContain("'send.undoGraceSeconds'");
      // And it is only that. Neither instant, neither animation handle.
      for (const banned of [
        'sendNotBefore',
        'stateChangedAt',
        'animationDuration',
        'animationDelay',
      ])
        expect([banned, home.includes(banned)]).toEqual([banned, false]);
      // The ring's own derivation cannot reach the projection either.
      expect(derived).not.toContain('settingsFields');
    });

    it('PLANTED: a second renderer namer of the setting is caught', () => {
      const rel = sc8Plant(
        `${RENDERER}/derive/__s8_sc8_probe__/ring.ts`,
        [
          'export const total = (s: { undoGraceSeconds: number }): number =>',
          '  s.undoGraceSeconds * 1000;',
          '',
        ].join('\n'),
      );
      const namers = archFiles(RENDERER)
        .filter((f) => codeOf(archRead(f)).includes('undoGraceSeconds'))
        .sort();
      expect(namers).toContain(rel);
      expect(namers).not.toEqual([`${RENDERER}/derive/settingsFields.ts`]);
    });

    it('NEAR-MISS: the settings projection itself is not an offender', () => {
      // The legitimate home, read the way the ban reads it, carries the key
      // and nothing that could draw a ring — so the row above is an
      // enumeration and not a blanket amnesty.
      const home = codeOf(archRead(`${RENDERER}/derive/settingsFields.ts`));
      expect(home).toContain('undoGraceSeconds');
      expect(/animation|sendNotBefore|stateChangedAt/.test(home)).toBe(false);
    });
  });
});

describe('S8 extensions (s8-execution Scenario 9: bulk, and one batch)', () => {
  const sc9Planted: string[] = [];
  function sc9Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc9Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc9Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/queue/__s8_sc9_probe__',
      'apps/desktop/src/renderer/store/__s8_sc9_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc9_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const WIRING = `${RENDERER}/store/index.ts`;

  /**
   * Row 1 — the three channels Sc9 opened get the same treatment as the
   * three Sc7 and Sc8 opened before them.
   *
   * Bulk is where "one keystroke, one request" is most tempting to break,
   * in both directions. A second `bridge.bulk(` call site is how `⇧A` ends
   * up posting twice under a double press; a second `bridge.retry(` is how
   * a failed card acquires a second, unguarded way to be re-sent; and a
   * second `bridge.batch(` is how a report fetch escapes the one place that
   * knows a batch is being held and becomes the poll this scenario's plan
   * explicitly forbids.
   */
  describe('row 1: the batch verbs have exactly one call site each', () => {
    for (const verb of ['bulk', 'batch', 'retry'] as const) {
      const one = new RegExp(`\\bbridge\\s*\\.\\s*${verb}\\s*\\(`);
      const all = new RegExp(`\\bbridge\\s*\\.\\s*${verb}\\s*\\(`, 'g');
      it(`calls bridge.${verb} from one file, once`, () => {
        const callers = archFiles(RENDERER).filter((rel) =>
          one.test(codeOf(archRead(rel))),
        );
        expect(callers).toEqual([WIRING]);
        expect(codeOf(archRead(WIRING)).match(all)).toHaveLength(1);
      });
    }

    it('PLANTED: a screen that fetches its own batch report is caught', () => {
      const rel = sc9Plant(
        `${RENDERER}/screens/queue/__s8_sc9_probe__/Tally.tsx`,
        [
          'export const refresh = (bridge: { batch: (id: string) => unknown }) =>',
          "  bridge.batch('01J000000000000000000000');",
          '',
        ].join('\n'),
      );
      const callers = archFiles(RENDERER).filter((f) =>
        /\bbridge\s*\.\s*batch\s*\(/.test(codeOf(archRead(f))),
      );
      expect(callers).toContain(rel);
      expect(callers).not.toEqual([WIRING]);
    });

    it('LEGITIMATE NEAR-MISS: a component that RENDERS the report is clean', () => {
      const rel = sc9Plant(
        `${RENDERER}/screens/queue/__s8_sc9_probe__/Summary.tsx`,
        [
          '/**',
          ' * The tallies arrive as props. Nothing here calls bridge.batch(',
          ' * — the wiring fetches on a terminal frame and hands the counts',
          ' * down, which is why there is no poll on this screen.',
          ' */',
          'export function Summary(props: { sent: number }): unknown {',
          '  return <p class="batch-tally">{props.sent}</p>;',
          '}',
          '',
        ].join('\n'),
      );
      const callers = archFiles(RENDERER).filter((f) =>
        /\bbridge\s*\.\s*batch\s*\(/.test(codeOf(archRead(f))),
      );
      expect(callers).not.toContain(rel);
      expect(callers).toEqual([WIRING]);
    });
  });

  /**
   * Row 2 — the batchId on screen is the daemon's, because the renderer
   * cannot mint one.
   *
   * The whole wire proof of Scenario 9 rests on one identity: the id the
   * operator can see on the batch card is the id stamped on the Approval
   * rows. A renderer that minted its own — a ULID, a UUID, a counter it
   * called a batch id — could show a perfectly consistent summary of a
   * batch the daemon never recorded, and every e2e assertion about
   * `GET /v1/batches/:id` would still pass while proving nothing.
   *
   * The store's LOCAL batch token is deliberately not an id and is
   * deliberately not id-shaped: it is `b1`, `b2`, minted by incrementing an
   * integer, and it never leaves the renderer. This row bans the two
   * standard ways to mint a real one.
   */
  describe('row 2: no renderer file mints an identifier', () => {
    const MINTS = /\b(ulid|randomUUID|nanoid|uuidv4)\s*\(/g;

    function minters(): string[] {
      const out: string[] = [];
      for (const rel of archFiles(RENDERER))
        for (const m of codeOf(archRead(rel)).matchAll(MINTS))
          out.push(`${rel}: ${m[1] ?? ''}(`);
      return [...new Set(out)].sort();
    }

    it('mints nothing, anywhere under the renderer', () => {
      expect(archFiles(RENDERER).length).toBeGreaterThan(0);
      expect(minters()).toEqual([]);
      // Non-vacuous: the daemon really does mint the batchId, with `ulid()`,
      // in the bulk route. The ban is on the renderer, not on the concept.
      expect(
        codeOf(archRead('packages/daemon/src/routes/drafts.ts')),
      ).toContain('const batchId = ulid();');
    });

    it('PLANTED: a store that mints its own batch id is caught', () => {
      const rel = sc9Plant(
        `${RENDERER}/store/__s8_sc9_probe__/mint.ts`,
        [
          'declare const ulid: () => string;',
          'export const batchId = (): string => ulid();',
          '',
        ].join('\n'),
      );
      expect(minters()).toContain(`${rel}: ulid(`);
    });

    it('LEGITIMATE NEAR-MISS: a local counter, and prose about ulid, is clean', () => {
      const rel = sc9Plant(
        `${RENDERER}/store/__s8_sc9_probe__/token.ts`,
        [
          '/**',
          ' * A LOCAL token, not an id. The daemon mints the batchId with',
          ' * ulid() and it arrives with the answer; this only has to tell',
          ' * one in-flight batch from the next.',
          ' */',
          'let batches = 0;',
          'export const nextToken = (): string => {',
          '  batches += 1;',
          '  return `b${String(batches)}`;',
          '};',
          '',
        ].join('\n'),
      );
      expect(minters().filter((o) => o.startsWith(rel))).toEqual([]);
    });
  });

  /**
   * Row 3 — the batch card is a summary, not a control.
   *
   * Sc7 banned every clickable shape under `screens/queue`, and its planted
   * offender is literally the RETRY NOW button this slice's plan asked for.
   * Scenario 9 is the scenario that would have added it, so the ban is
   * re-asserted here against the file that now exists, together with the
   * thing that replaced the button: a key, legended on the card.
   */
  describe('row 3: the batch card carries no control', () => {
    const CARD = `${RENDERER}/screens/queue/BatchCard.tsx`;
    const CLICKABLE = /<button\b|<a\s[^>]*href|<input\b|onClick=|tabIndex=/;

    it('renders the summary with nothing an operator could click', () => {
      const body = codeOf(archRead(CARD));
      expect(body.length).toBeGreaterThan(0);
      expect(CLICKABLE.test(body)).toBe(false);
      // …and it is really a summary: it names the id it was given and the
      // tally class the e2e reads.
      expect(body).toContain('batch-tally');
    });

    it('PLANTED: the retry button the plan asked for is caught', () => {
      const rel = sc9Plant(
        `${RENDERER}/screens/queue/__s8_sc9_probe__/Retry.tsx`,
        [
          'export function Retry(props: { onRetry: () => void }): unknown {',
          '  return <button onClick={props.onRetry}>Retry</button>;',
          '}',
          '',
        ].join('\n'),
      );
      expect(CLICKABLE.test(codeOf(archRead(rel)))).toBe(true);
    });

    it('LEGITIMATE NEAR-MISS: the same affordance as a legended key is clean', () => {
      const rel = sc9Plant(
        `${RENDERER}/screens/queue/__s8_sc9_probe__/RetryKey.tsx`,
        [
          '/**',
          ' * The retry affordance. Not a <button onClick=...>: this screen',
          ' * has one tab stop and the keymap owns every verb, so a failed',
          ' * card legends A as retry and the listbox handles the stroke.',
          ' */',
          'export function RetryKey(): unknown {',
          '  return <span class="card-keys">A retry</span>;',
          '}',
          '',
        ].join('\n'),
      );
      expect(CLICKABLE.test(codeOf(archRead(rel)))).toBe(false);
    });
  });
});

describe('S8 extensions (s8-execution Scenario 10: the rules editor)', () => {
  const sc10Planted: string[] = [];
  function sc10Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc10Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc10Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/store/__s8_sc10_probe__',
      'apps/desktop/src/renderer/screens/rules/__s8_sc10_probe__',
      'apps/desktop/src/renderer/screens/queue/__s8_sc10_probe__',
      'apps/desktop/src/renderer/components/__s8_sc10_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc10_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const STORE_ROOT = `${RENDERER}/store`;
  const RULES = `${RENDERER}/screens/rules`;
  const QUEUE = `${RENDERER}/screens/queue`;

  /** Every `bridge.<member>` one file's CODE names, sorted and unique. */
  function reachOf(rel: string): string[] {
    const out: string[] = [];
    for (const m of codeOf(archRead(rel)).matchAll(
      /\bbridge\s*\.\s*([A-Za-z_$][\w$]*)/g,
    ))
      out.push(m[1] ?? '');
    return [...new Set(out)].sort();
  }

  /** The files under `store/` whose CODE reaches the bridge at all. */
  function bindingFiles(): string[] {
    return archFiles(STORE_ROOT)
      .filter((rel) => reachOf(rel).length > 0)
      .sort();
  }

  /** The single-quoted members of `Pick<WmBridge, …>` in one file, sorted. */
  function pickOf(rel: string): string[] {
    const m = /Pick<\s*WmBridge,([\s\S]*?)>/.exec(archRead(rel));
    if (m === null) return [];
    return [...(m[1] as string).matchAll(/'([^']+)'/g)]
      .map((x) => x[1] as string)
      .sort();
  }

  /** The single-quoted members of a named `const X = [ … ]`, in order. */
  function constArrayOf(rel: string, name: string): string[] {
    const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(archRead(rel));
    if (m === null) return [];
    return [...(m[1] as string).matchAll(/'([^']+)'/g)].map(
      (x) => x[1] as string,
    );
  }

  /* ── row 1: the store's reach is a PARTITION ────────────────────────── */

  /**
   * Sc5 asserted a FLAT list: the union of every `bridge.<member>` named
   * anywhere under `store/` had to equal one array. That was exact while the
   * store was one file, and it stops being exact the moment there are two —
   * a union cannot say which file reached which channel, so a queue binding
   * that quietly acquired `ruleWrite` would still satisfy it.
   *
   * The rules editor needs a second binding (it reads nine catalogues and
   * writes one), so the row is replaced by a PARTITION, which is strictly
   * stronger in three ways and weaker in none:
   *
   *  - every file under `store/` that reaches the bridge AT ALL must be a
   *    declared partition member. A third binding file is a failure until
   *    somebody writes it down, which is the diff this row exists to force.
   *  - each file's reach must equal ITS OWN list, so the queue binding and
   *    the rules binding cannot borrow each other's channels.
   *  - each file's type-level `Pick` must equal the same list, so widening
   *    the runtime and the type apart is still impossible.
   *
   * Sc5's `/send/i` ban is unchanged and still runs over the whole root:
   * neither binding may name a send, and adding a binding cannot dilute it.
   * Sc5's own row now scopes its equality to `index.ts`, which is the one
   * line of that block this scenario touched.
   *
   * Sc11 (schedules), Sc12 (contacts and policies) and Sc14 (settings) each
   * extend this by one entry and one line. That is the intended shape of
   * the diff: a new screen's reach is declared here or the screen does not
   * typecheck past this row.
   */
  interface Binding {
    /** The runtime array the binding invokes through. */
    readonly constant: string;
    /** Its members, plus `'on'` when the binding subscribes. */
    readonly members: readonly string[];
  }
  const BINDINGS: Readonly<Record<string, Binding>> = {
    [`${STORE_ROOT}/index.ts`]: {
      constant: 'STORE_CHANNELS',
      members: [
        'approve',
        'batch',
        'bulk',
        'contacts',
        'drafts',
        'on',
        'recall',
        'reject',
        'retry',
        'rules',
        'settings',
      ],
    },
    [`${STORE_ROOT}/rules.ts`]: {
      constant: 'RULES_CHANNELS',
      // Nine reads and one write, and the write is `ruleWrite`. Deliberately
      // absent: `on` (the editor is request/response — it refetches rather
      // than reconciling a stream, so it cannot render a stale rule as a
      // live one), and `ruleDelete` (the wireframe has no delete affordance
      // and a rule that is drafting for somebody is not a row to remove
      // behind a keystroke; OFF is the reversible answer).
      members: [
        'adapters',
        'audit',
        'contacts',
        'drafts',
        'ruleDryRun',
        'ruleTest',
        'ruleWrite',
        'rules',
        'schedules',
        'settings',
      ],
    },
    [`${STORE_ROOT}/schedule.ts`]: {
      constant: 'SCHEDULE_CHANNELS',
      // Sc11, and the third entry this row was written to demand. Three
      // reads and two writes. `rules` is here because a schedule is only
      // ever ABOUT rules — the footnote counts what each rule does outside
      // the window (F-69) and the 409 that refuses a delete names how many
      // rules still point at it — and `scheduleDelete` is here, unlike the
      // rules editor's `ruleDelete`, because the DAEMON refuses a delete
      // that would strand a rule. An affordance the server already guards
      // is an affordance the GUI may offer; one it does not, is not.
      //
      // No `on`, for the same reason the rules binding declares none: an
      // editor that rendered a schedule from a stream would eventually
      // render a row somebody else was halfway through changing.
      members: ['rules', 'scheduleDelete', 'scheduleWrite', 'schedules'],
    },
    [`${STORE_ROOT}/people.ts`]: {
      constant: 'PEOPLE_CHANNELS',
      // Sc12, and the fourth entry. Four reads and one write.
      //
      // `audit` is here because the AUTO-SENDS column does not exist in any
      // catalogue: `auto.approved` carries no handle, so the count per
      // person only exists as a JOIN of that event against `draft.created`'s
      // draft snapshot, and both live in the audit log. `settings` is here
      // because the GLOBAL rung of §2.4.3's ladder is `send.globalMode`, and
      // a screen that assumed the shipped default would tell an operator
      // their AUTO took when the daemon had already narrowed it.
      //
      // Deliberately absent: `rules`, because the RULE rung of this screen's
      // ladder is `PER RULE` — a contact row is not about any one rule, and
      // fetching every rule to render a constant string would be nine
      // catalogues for a word. And `contactDelete`, which is a real channel
      // the CLI uses: DENY is the reversible answer, and deleting the row
      // does not mean "no policy", it means the strictest policy there is.
      // A destructive gesture that is indistinguishable from the strict one
      // is a gesture with no reason to exist.
      members: ['audit', 'contactSet', 'contacts', 'drafts', 'settings'],
    },
    [`${STORE_ROOT}/audit.ts`]: {
      constant: 'AUDIT_CHANNELS',
      // Sc13, and the fifth entry. Two reads and one write, and the write
      // does not leave this machine.
      //
      // This is the first binding whose whole reason for existing is that
      // it reads. The audit log is append-only as an API property — the
      // Store exposes no update or delete path for `audit_log` and the
      // daemon registers no mutating route for it (see this scenario's
      // route rows) — so a screen over it that could write would be a
      // screen whose capability exceeded the thing it is looking at.
      //
      // `auditVerify` is separate from `audit` because it is a full chain
      // walk on every call and never cached (§2.3): it is an ACT the
      // operator performs, not a field of the list, and giving it its own
      // channel is what lets a row assert it was asked for exactly once.
      //
      // `exportReport` is the odd one. It reaches no daemon at all: main
      // opens a save dialog, writes the JSON and hands back the BASENAME,
      // so no absolute home path ever crosses the bridge into a document.
      // It is still declared a WRITE below, because it is the only channel
      // in this GUI that writes bytes outside this process, and a second
      // owner for that is a second place a report can be written from.
      //
      // Deliberately absent: `on`. A log that redrew itself under the
      // operator would move the row they were reading, and `verify` would
      // become a claim about a chain that has since grown. The screen says
      // what it loaded and when, and reloads when asked.
      members: ['audit', 'auditVerify', 'exportReport'],
    },
    [`${STORE_ROOT}/settings.ts`]: {
      constant: 'SETTINGS_CHANNELS',
      // Sc14, and the sixth entry. Four reads, six writes and one channel
      // that reaches nothing — more writes than the other five bindings put
      // together, because this is the screen where every control that
      // changes the daemon's posture lives and putting them anywhere else
      // would be putting them in two places.
      //
      // `doctor` is here for the Permissions pane, which is the ONLY
      // consumer of that channel outside the wizard: a report the screen
      // re-runs on request rather than polls (Sc15 owns the polling, and
      // owns it only while its own step is on screen).
      //
      // `drafts` is a shared READ — the rules editor and the people grid
      // already have it — and it is here for the danger zone's confirm,
      // which states how many drafts are in flight before an operator
      // agrees to stop the watcher. A count in a destructive confirm that
      // was not fetched at the moment of asking is a count that lies.
      //
      // `adapterRotate` is a write in the strongest sense in this app: it
      // destroys a credential. Its plaintext answer never reaches this
      // process — main copies it to the clipboard and returns a receipt —
      // so this binding may ASK for a rotation and can never hold one.
      //
      // `openSystemSettings` is the eleventh, and it is not a write: it
      // reaches no daemon, changes no state and can refuse nothing. It is
      // here because macOS TCC is not grantable through any API — that is
      // the OS's design, not an omission — so a Permissions card that
      // claimed a GRANT button would be lying about what a click does. The
      // most a card may offer is to open the pane the operator has to act
      // in, by NAME, against main's allowlist.
      //
      // Deliberately absent: `on`. A settings form that redrew itself from
      // a stream would discard a half-typed field the moment somebody
      // else's event arrived. The kill switch's own state does not come
      // through this binding either: it rides the stream push that main
      // already sends, so the control moves when the daemon says so rather
      // than when the click returns.
      members: [
        'adapterRotate',
        'adapters',
        'connect',
        'disconnect',
        'doctor',
        'drafts',
        'globalMode',
        'killSwitch',
        'openSystemSettings',
        'settings',
        'settingsWrite',
      ],
    },
    [`${STORE_ROOT}/wizard.ts`]: {
      constant: 'WIZARD_CHANNELS',
      // Sc15, and the seventh entry. One read, one opener and two writes,
      // and it is the smallest binding in the app on purpose: onboarding is
      // the moment the operator trusts the product least, so every channel
      // it can reach is a thing it could be blamed for.
      //
      // `doctor` is a SHARED read — Sc14's Permissions pane has it too — and
      // it is the whole verification story here. `runDoctor` probes,
      // derives, PERSISTS the connection state the gate later reads, and
      // broadcasts only on change; so asking it is not a display act, it is
      // the same act the daemon performs at boot. That is what lets the last
      // step quote the daemon rather than count its own steps.
      //
      // `connect` is deliberately absent, and Sc14 called this shot: "a
      // reconnect belongs on the wizard" was listed there as the second
      // plausible home that does not get one. It would also be a lie in the
      // one place it seems most needed — after the danger zone's disconnect
      // the bearer this process holds has been rotated, so a RECONNECT
      // button on the welcome step would be a control that cannot work,
      // rendered at the exact moment the operator is deciding whether to
      // believe the product.
      //
      // `wizardArm` and `sendTest` are the two writes, and they are one
      // gesture split in half: main mints a four-hex code and remembers the
      // handle, then refuses any send whose recipient or body is not that
      // pair. The renderer therefore cannot choose what gets said, which is
      // the only version of a "send yourself a test" that does not amount
      // to a general-purpose send with a filter on it.
      //
      // Deliberately absent: `on`. The wizard's link state arrives as a
      // prop from `main.tsx`'s single stream subscription; a second
      // subscriber would be a second opinion about whether the daemon is
      // there, and the whole screen is about there being one.
      members: ['doctor', 'openSystemSettings', 'sendTest', 'wizardArm'],
    },
  };

  it('every file under store/ that reaches the bridge is a declared binding', () => {
    expect(bindingFiles()).toEqual(Object.keys(BINDINGS).sort());
  });

  it('each binding reaches exactly its own declared channels, at both levels', () => {
    for (const [rel, binding] of Object.entries(BINDINGS)) {
      const members = [...binding.members].sort();
      expect(reachOf(rel), `${rel} reach`).toEqual(members);
      expect(pickOf(rel), `${rel} Pick<WmBridge>`).toEqual(members);
      // The runtime list is the request channels only: `on` is a
      // subscription and is not invoked.
      expect(
        [...constArrayOf(rel, binding.constant)].sort(),
        `${rel} ${binding.constant}`,
      ).toEqual(members.filter((m) => m !== 'on'));
    }
  });

  it('no two bindings overlap on any WRITE channel', () => {
    // Reads may be shared — both screens name a rule — but two files that
    // can both mutate the same resource is two places for one keystroke to
    // become two requests. Sc7, Sc8 and Sc9 each pinned their write to one
    // call site; this is the same claim stated over the partition.
    const WRITES = [
      'approve',
      'bulk',
      'recall',
      'reject',
      'retry',
      'ruleWrite',
      // Sc11's two. A schedule is the only resource in this GUI a screen may
      // DELETE, and it is deliberately owned by the binding that also owns
      // the patch: two files that could both remove a schedule is two places
      // for one keystroke to become two requests, and the second one 404s.
      'scheduleDelete',
      'scheduleWrite',
      // Sc12's one. There is no bulk route for contacts, so a bulk gesture
      // on that screen is N of these — which is exactly why it may only
      // have one owner, and why the typed confirm names the request count.
      'contactSet',
      // Sc13's one, and the only member of this list that reaches no
      // daemon. `exportReport` writes a file to a path the operator chose,
      // which is the one thing this GUI does that leaves the process
      // without going through the wire — so the wire rows cannot see it and
      // this partition is the only thing that can say who may do it.
      'exportReport',
      // Sc14's six, and the reason this list is the right place for them.
      // Every one of these changes what the daemon will DO with the next
      // message, and five of the six have a second plausible home: a kill
      // switch belongs on a toolbar, a global mode belongs beside the rule
      // that it narrows, a reconnect belongs on the wizard. One owner each
      // is what makes "the switch flipped once" a checkable claim.
      'adapterRotate',
      'connect',
      'disconnect',
      'globalMode',
      'killSwitch',
      'settingsWrite',
      // Sc15's two, and they are halves of one another. `wizardArm` is what
      // makes `sendTest` narrow: main mints the body and holds the handle,
      // so a second owner of EITHER would be a way to send something the
      // operator did not see. One owner each is the whole guard.
      'sendTest',
      'wizardArm',
    ];
    for (const write of WRITES) {
      const owners = Object.entries(BINDINGS)
        .filter(([, b]) => b.members.includes(write))
        .map(([rel]) => rel);
      expect(owners, `${write} has one owner`).toHaveLength(1);
    }
  });

  it('every declared member is a real channel, and none of them is a push', () => {
    const registry = archRead('apps/desktop/src/main/ipc-channels.ts');
    const pushes = [
      ...(/PUSH_KEYS = \[([^\]]*)\]/.exec(registry)?.[1] ?? '').matchAll(
        /'([^']+)'/g,
      ),
    ].map((m) => m[1]);
    for (const binding of Object.values(BINDINGS))
      for (const member of binding.members) {
        if (member === 'on') continue;
        expect(registry, `${member} is a channel`).toMatch(
          new RegExp(`^\\s*${member}:`, 'm'),
        );
        expect(pushes, `${member} is not a push channel`).not.toContain(member);
      }
  });

  it('PLANTED: a third file under store/ that reaches the bridge is caught', () => {
    const rel = sc10Plant(
      `${STORE_ROOT}/__s8_sc10_probe__/schedules.ts`,
      [
        'export const go = (bridge: { schedules: () => Promise<unknown> }) =>',
        '  bridge.schedules();',
        '',
      ].join('\n'),
    );
    expect(bindingFiles()).toContain(rel);
    expect(bindingFiles()).not.toEqual(Object.keys(BINDINGS).sort());
  });

  it('LEGITIMATE NEAR-MISS: a store file that only DISCUSSES the bridge is not a binding', () => {
    const rel = sc10Plant(
      `${STORE_ROOT}/__s8_sc10_probe__/pure.ts`,
      [
        '/**',
        ' * A pure reducer. It takes rows the binding already fetched over',
        ' * bridge.rules and bridge.drafts, and reaches nothing itself.',
        ' */',
        'export const rows = (all: readonly string[]): number => all.length;',
        '',
      ].join('\n'),
    );
    expect(reachOf(rel)).toEqual([]);
    expect(bindingFiles()).toEqual(Object.keys(BINDINGS).sort());
  });

  /* ── row 2: one call site for the editor's one write ────────────────── */

  /**
   * The same treatment Sc7, Sc8 and Sc9 gave the channels they opened. A
   * second `bridge.ruleWrite(` is how a drag-reorder and a form save both
   * fire for one gesture, and how a typed confirm gets bypassed by a second
   * path that never learned to ask.
   *
   * `ruleDelete` is asserted ABSENT from the renderer entirely. It is a real
   * channel with a real handler — the CLI uses it — and this GUI does not
   * offer it, so the absence is a decision rather than an omission.
   */
  it('ruleWrite has exactly one call site, and ruleDelete has none', () => {
    const callers = (needle: string): string[] =>
      archFiles(RENDERER).filter((rel) =>
        codeOf(archRead(rel)).includes(needle),
      );
    expect(callers('bridge.ruleWrite(')).toEqual([`${STORE_ROOT}/rules.ts`]);
    const once = codeOf(archRead(`${STORE_ROOT}/rules.ts`)).split(
      'bridge.ruleWrite(',
    );
    expect(once).toHaveLength(2);
    expect(callers('bridge.ruleDelete(')).toEqual([]);
    // Non-vacuous: the channel exists and is spelled here.
    expect(archRead('apps/desktop/src/main/ipc-channels.ts')).toContain(
      "ruleDelete: 'wm:rule.delete'",
    );
  });

  /* ── row 3: controls live where the guard permits them ──────────────── */

  /**
   * Sc7 banned `<button`, `<a href`, `<input`, `onClick=` and `tabIndex=`
   * under `screens/queue`, with a planted button as its offender. That ban
   * is SCOPED to the queue and always was: the queue has one tab stop
   * because it is a virtualised listbox driven entirely by a keymap, and a
   * control inside a virtualised option is a focus holder that unmounts.
   *
   * A rules editor cannot be built that way. It takes a NAME, a regex, a
   * list of keywords and a typed confirmation string, and §1.7 requires
   * "only a click or ⌘↩ on the confirm button with the exact text" — a
   * button and a text field, in the specification. So the editor gets real
   * controls and this row states exactly where the line is:
   *
   *  - `screens/rules` MAY mint `<input` and `<button`. Asserted to be
   *    NON-EMPTY so the permission is not theoretical.
   *  - `screens/queue` still may not. Re-asserted here rather than trusted,
   *    because the interesting failure is a control migrating INTO the
   *    queue on the argument that the app now has some.
   *  - `<a href` is banned across the whole renderer. There is no browser
   *    here and no document to link to; a link is how a renderer navigates
   *    away from the app it is.
   *  - `<textarea` stays out of the editor. Sc8 pinned it to
   *    `components/Editor.tsx` app-wide; a multi-line regex field is the
   *    obvious way to break that and it is not needed.
   *  - the typed confirm's `role="dialog"` lives in ONE component. `alert`
   *    and `alertdialog` remain banned renderer-wide (Sc7), and `role=
   *    "status"` remains the queue's.
   */
  const INTERACTIVE: readonly (readonly [string, RegExp])[] = [
    ['<button', /<button\b/],
    ['<a href', /<a\s[^>]*\bhref\b/],
    ['<input', /<input\b/],
    ['onClick', /\bonClick\s*=/],
    ['tabIndex', /\btabIndex\s*=/],
  ];

  function controlsIn(root: string): string[] {
    const out: string[] = [];
    for (const rel of archFiles(root)) {
      const code = codeOf(archRead(rel));
      for (const [name, re] of INTERACTIVE)
        if (re.test(code)) out.push(`${rel}: ${name}`);
    }
    return out.sort();
  }

  it('the rules editor has real controls and the queue still has none', () => {
    const rules = controlsIn(RULES);
    expect(rules.some((c) => c.endsWith(': <input'))).toBe(true);
    expect(rules.some((c) => c.endsWith(': <button'))).toBe(true);
    // …and none of them is a link or a hand-rolled tab stop.
    expect(rules.filter((c) => c.endsWith(': <a href'))).toEqual([]);
    expect(rules.filter((c) => c.endsWith(': tabIndex'))).toEqual([]);
    expect(controlsIn(QUEUE)).toEqual([]);
  });

  it('no file in the renderer contains an anchor with an href', () => {
    const anchors = (): string[] =>
      archFiles(RENDERER).filter((rel) =>
        /<a\s[^>]*\bhref\b/.test(codeOf(archRead(rel))),
      );
    expect(anchors()).toEqual([]);
    // Non-vacuous over an EMPTY result: the same scan, over a planted link
    // of the kind the schedule field is most likely to grow ("edit in S4
    // →"), finds it. That affordance is a keystroke here, not a link.
    const rel = sc10Plant(
      `${RULES}/__s8_sc10_probe__/Link.tsx`,
      [
        'export function ScheduleLink(): unknown {',
        '  return <a href="#schedule">EDIT IN SCHEDULES</a>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(anchors()).toEqual([rel]);
  });

  it('the rules editor uses no textarea, which stays the editor component`s', () => {
    const sites = archFiles(RENDERER).filter((rel) =>
      /<textarea\b/.test(codeOf(archRead(rel))),
    );
    expect(sites).toEqual([`${RENDERER}/components/Editor.tsx`]);
  });

  it('role="dialog" lives in exactly one component, and alert roles stay banned', () => {
    const withRole = (role: string): string[] =>
      archFiles(RENDERER).filter((rel) =>
        codeOf(archRead(rel)).includes(`role="${role}"`),
      );
    expect(withRole('dialog')).toEqual([
      `${RENDERER}/components/TypedConfirm.tsx`,
    ]);
    expect(withRole('alert')).toEqual([]);
    expect(withRole('alertdialog')).toEqual([]);
    expect(withRole('status')).toEqual([`${QUEUE}/index.tsx`]);
  });

  it('PLANTED: a button smuggled into the queue is caught', () => {
    const rel = sc10Plant(
      `${QUEUE}/__s8_sc10_probe__/Save.tsx`,
      [
        'export function Save(props: { onSave: () => void }): unknown {',
        '  return <button onClick={props.onSave}>SAVE</button>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(QUEUE)).toEqual([`${rel}: <button`, `${rel}: onClick`]);
  });

  it('LEGITIMATE NEAR-MISS: the same button in the rules editor is allowed', () => {
    const rel = sc10Plant(
      `${RULES}/__s8_sc10_probe__/Save.tsx`,
      [
        'export function Save(props: { onSave: () => void }): unknown {',
        '  return <button onClick={props.onSave}>SAVE</button>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(RULES)).toContain(`${rel}: <button`);
    expect(controlsIn(QUEUE)).toEqual([]);
  });

  /* ── row 4: a form is the classic way to acquire a timer ────────────── */

  /**
   * Sc5 pinned every `setTimeout`/`setInterval` under `apps/desktop/src` to
   * the reconnect backoff in `main/gateway.ts`. A form with debounced
   * validation is the standard way to break that, and it is not needed:
   * pattern compilation is microseconds, so validity is computed on every
   * keystroke, and the SERVER-side confirmation (`POST /v1/rules/:id/test`)
   * fires on `blur` — an event the operator generates, not a delay the app
   * invents.
   *
   * The timer ban alone would not catch the intent, because the usual
   * helper is written once and imported. So the names are banned too, in
   * code (comments like this one are stripped before the scan).
   */
  const DELAY_HELPERS = /\b(debounce|throttle|requestIdleCallback)\b/i;

  it('the desktop app schedules nothing and imports no delay helper', () => {
    const offenders = archFiles('apps/desktop/src')
      .filter((rel) => DELAY_HELPERS.test(codeOf(archRead(rel))))
      .sort();
    expect(offenders).toEqual([]);
    // Non-vacuous: the ONE timer in the app is still exactly where Sc5 left
    // it, so this row is scanning a tree that really could hold another.
    const timers = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(timers).toEqual(['apps/desktop/src/main/gateway.ts']);
  });

  it('PLANTED: a debounced validator is caught', () => {
    const rel = sc10Plant(
      `${RULES}/__s8_sc10_probe__/validate.ts`,
      [
        'export function debounce(fn: () => void, ms: number): () => void {',
        '  let t: ReturnType<typeof setTimeout> | null = null;',
        '  return () => {',
        '    if (t !== null) clearTimeout(t);',
        '    t = setTimeout(fn, ms);',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    const code = codeOf(archRead(rel));
    expect(DELAY_HELPERS.test(code)).toBe(true);
    expect(/\b(setTimeout|setInterval)\(/.test(code)).toBe(true);
  });

  it('LEGITIMATE NEAR-MISS: validating on every keystroke, and confirming on blur, is clean', () => {
    const rel = sc10Plant(
      `${RULES}/__s8_sc10_probe__/live.ts`,
      [
        '/**',
        ' * No debounce and no throttle: compiling a pattern costs less than',
        ' * the keystroke that triggered it, and the daemon is asked on blur.',
        ' */',
        'export function problem(pattern: string): string | null {',
        '  try {',
        "    new RegExp(pattern, 'u');",
        '    return null;',
        '  } catch (error) {',
        '    return error instanceof Error ? error.message : String(error);',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const code = codeOf(archRead(rel));
    expect(DELAY_HELPERS.test(code)).toBe(false);
    expect(/\b(setTimeout|setInterval)\(/.test(code)).toBe(false);
  });

  /* ── row 5: the editor cannot approve, and the screen cannot fetch ──── */

  /**
   * INV-2, stated where this scenario could break it. Two halves:
   *
   *  - the rules BINDING may not name an approval or a draft id. Its whole
   *    write surface is `PUT`-shaped over a rule, and a rule has no field
   *    that could authorise a send. The partition row above already pins
   *    which channels it reaches; this pins the vocabulary, which is what a
   *    reviewer actually scans for.
   *  - the rules SCREEN may not reach the bridge at all. Sc6's view-tree row
   *    already says this for `screens/`; it is re-asserted here over
   *    `screens/rules` specifically, because that row's non-vacuity list is
   *    pinned to two roots and a reader of THIS scenario should not have to
   *    go and check that the new directory was in scope.
   */
  it('the rules binding names no approval, and the rules screen names no bridge', () => {
    const binding = codeOf(archRead(`${STORE_ROOT}/rules.ts`));
    for (const m of binding.matchAll(/[A-Za-z_$][\w$]*/g))
      expect(m[0], `${m[0]} in the rules binding`).not.toMatch(
        /^(approve|approval|draftId|dispatch)$/i,
      );
    for (const rel of archFiles(RULES)) {
      const code = codeOf(archRead(rel));
      expect(/\bwindow\s*\.\s*wm\b/.test(code), `${rel} names window.wm`).toBe(
        false,
      );
      expect(
        /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/.test(code),
        `${rel} names a bridge member`,
      ).toBe(false);
    }
  });

  /* ── row 6: every screen is reachable, by exactly one mechanism ─────── */

  /**
   * Sc17 runs axe over every `SCREENS` entry, which is impossible while the
   * shell hard-codes one. The editor is the first screen that has to be
   * REACHED, so navigation lands here.
   *
   * It is a keymap, not a sidebar, and that is forced rather than chosen:
   * Sc6 asserts the whole window has exactly ONE tab stop while the queue is
   * up, and a persistent clickable nav rail is six more. §1.7 sanctions it
   * from the other side — "no key is bound while data-conn !== 'connected'
   * except navigation" names navigation as a key.
   *
   * `verbOf` returns null for any stroke carrying meta, ctrl or alt, so a
   * ⌘-digit cannot collide with a queue verb, today or later.
   */
  const SCREEN_KEYS = `${RENDERER}/keys/screens.ts`;

  it('the screen keymap names every screen in the registry, and nothing else', () => {
    const registry = [
      ...(
        /export const SCREENS\s*=\s*\[([^\]]*)\]/.exec(
          archRead(`${RENDERER}/router.ts`),
        )?.[1] ?? ''
      ).matchAll(/'([^']+)'/g),
    ].map((m) => m[1] as string);
    expect(registry).toHaveLength(6);
    const code = codeOf(archRead(SCREEN_KEYS));
    for (const screen of registry)
      expect(code, `${screen} is reachable`).toContain(`'${screen}'`);
  });

  it('exactly one file in the app adds a window-level key listener', () => {
    const sites = archFiles('apps/desktop/src')
      .filter((rel) => /addEventListener\s*\(/.test(codeOf(archRead(rel))))
      .sort();
    expect(sites).toEqual([`${RENDERER}/main.tsx`]);
    // And it is a KEY listener, at the composition root, not a click
    // delegate standing in for the controls the queue may not have.
    const code = codeOf(archRead(`${RENDERER}/main.tsx`));
    expect(code).toContain("addEventListener('keydown'");
    expect(/addEventListener\(\s*'click'/.test(code)).toBe(false);
  });

  it('PLANTED: a second window-level listener is caught', () => {
    const rel = sc10Plant(
      `${RULES}/__s8_sc10_probe__/nav.ts`,
      [
        'export function wire(): void {',
        "  window.addEventListener('keydown', () => undefined);",
        '}',
        '',
      ].join('\n'),
    );
    const sites = archFiles('apps/desktop/src').filter((r) =>
      /addEventListener\s*\(/.test(codeOf(archRead(r))),
    );
    expect(sites).toContain(rel);
  });

  it('LEGITIMATE NEAR-MISS: a pure stroke-to-screen function is clean', () => {
    const rel = sc10Plant(
      `${RENDERER}/derive/__s8_sc10_probe__/nav.ts`,
      [
        '/**',
        ' * Pure. The composition root owns the one addEventListener call and',
        ' * hands strokes here; this decides, it does not subscribe.',
        ' */',
        'export const screenFor = (key: string): string | null =>',
        "  key === '2' ? 'rules' : null;",
        '',
      ].join('\n'),
    );
    const sites = archFiles('apps/desktop/src').filter((r) =>
      /addEventListener\s*\(/.test(codeOf(archRead(r))),
    );
    expect(sites).not.toContain(rel);
  });
});

describe('S8 extensions (s8-execution Scenario 11: the schedule editor)', () => {
  const sc11Planted: string[] = [];
  function sc11Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc11Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc11Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/schedule/__s8_sc11_probe__',
      'apps/desktop/src/renderer/screens/queue/__s8_sc11_probe__',
      'apps/desktop/src/renderer/screens/rules/__s8_sc11_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc11_probe__',
      'apps/desktop/src/renderer/store/__s8_sc11_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const STORE_ROOT = `${RENDERER}/store`;
  const SCHEDULE = `${RENDERER}/screens/schedule`;
  const QUEUE = `${RENDERER}/screens/queue`;
  const RULES = `${RENDERER}/screens/rules`;

  /* ── row 1: the renderer may not decide arming, only draw it ────────── */

  /**
   * The load-bearing claim of this whole scenario, and the one the
   * dependency graph is already enforcing for free.
   *
   * `packages/core` owns the window math (F-57): `isArmed`, `projectToZone`,
   * `windowCloseAfter`, `nextWindowOpen`. The daemon calls them. The
   * renderer CANNOT, because `apps/desktop/package.json` does not depend on
   * `@wemessage/core` — and that is the reason `derive/projectWindow.ts`
   * exists as a second, DISPLAY-ONLY projection rather than an import.
   *
   * Two implementations of "what time is it there" is normally a smell, and
   * here it is the design: one of them decides whether a message goes out
   * and the other decides where a rectangle is drawn, and the second one
   * being wrong must never be able to change the first. This row states
   * that the wall between them is structural, so that a later scenario
   * cannot dissolve it by adding one line to a manifest.
   *
   * Non-vacuous from both ends: core really does export the verb, and the
   * renderer really does have a projection of its own.
   */
  it('the renderer cannot reach the daemon`s window math', () => {
    const manifest = JSON.parse(
      archRead('apps/desktop/package.json'),
    ) as Record<string, Record<string, string>>;
    const declared = [
      ...Object.keys(manifest['dependencies'] ?? {}),
      ...Object.keys(manifest['devDependencies'] ?? {}),
    ];
    expect(declared).not.toContain('@wemessage/core');
    const importers = archFiles('apps/desktop/src')
      .filter((rel) => /['"]@wemessage\/core['"]/.test(codeOf(archRead(rel))))
      .sort();
    expect(importers).toEqual([]);
    // …and the thing it cannot reach is real, and is the decider.
    const core = archRead('packages/core/src/schedule/index.ts');
    expect(core).toContain('export function isArmed');
    expect(core).toContain('export function projectToZone');
    // …and the renderer's own projection exists and is display-only, which
    // is asserted as the absence of the verb that would make it authority.
    const mine = codeOf(archRead(`${RENDERER}/derive/projectWindow.ts`));
    expect(mine).not.toMatch(/\bisArmed\b/);
  });

  /* ── row 2: no screen reads a clock ──────────────────────────────────── */

  /**
   * A schedule editor wants a live NOW marker, and the two ways to build one
   * are a timer (banned since Sc5) and a clock read inside the component
   * that draws it. The second is the subtler mistake: it is not a timer, so
   * no existing row catches it, and it makes the marker's instant a
   * property of WHEN PREACT HAPPENED TO RENDER rather than a value the
   * composition root chose and can be handed a different one of.
   *
   * So: the clock belongs to `main.tsx`, exactly as `midnightIso()` already
   * does, and every screen is a pure function of the instant it was given.
   * That is also what makes the e2e able to say the marker follows the
   * OPERATOR's clock and not the daemon's — two clocks are only
   * distinguishable if the screen is handed one rather than reading one.
   */
  const CLOCK_READ = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/;

  it('no file under screens/ reads a clock', () => {
    const offenders = archFiles(`${RENDERER}/screens`)
      .filter((rel) => CLOCK_READ.test(codeOf(archRead(rel))))
      .sort();
    expect(offenders).toEqual([]);
    // Non-vacuous: the composition root really does read one, so this scan
    // is looking at a tree where the pattern occurs.
    expect(CLOCK_READ.test(codeOf(archRead(`${RENDERER}/main.tsx`)))).toBe(
      true,
    );
  });

  it('PLANTED: a NOW marker that reads the clock where it draws is caught', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/Now.tsx`,
      [
        'export function NowLine(): unknown {',
        '  const at = new Date().toISOString();',
        '  return <div class="now" data-now={at} />;',
        '}',
        '',
      ].join('\n'),
    );
    const offenders = archFiles(`${RENDERER}/screens`).filter((r) =>
      CLOCK_READ.test(codeOf(archRead(r))),
    );
    expect(offenders).toEqual([rel]);
  });

  it('LEGITIMATE NEAR-MISS: a marker handed its instant is clean', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/Given.tsx`,
      [
        '/**',
        ' * The instant arrives as a prop. The composition root owns the one',
        ' * clock read in this app, and a screen that read its own would be a',
        ' * screen no test could stand still.',
        ' */',
        'export function NowLine(props: { nowIso: string }): unknown {',
        '  return <div class="now" data-now={props.nowIso} />;',
        '}',
        '',
      ].join('\n'),
    );
    expect(CLOCK_READ.test(codeOf(archRead(rel)))).toBe(false);
  });

  /* ── row 3: controls, per screen, still ──────────────────────────────── */

  /**
   * Sc7 banned controls under `screens/queue`; Sc10 permitted them under
   * `screens/rules` and re-asserted the queue's ban in the same row. This is
   * the third root, and it is a SEPARATE row on purpose.
   *
   * The separation is the point the user of this guard should read first:
   * `screens/schedule` being allowed a button cannot widen `screens/queue`,
   * because the queue's emptiness is asserted here by its own expression
   * over its own root. One `expect` per claim; no union that could be
   * satisfied by the wrong half.
   *
   * The schedule editor earns its controls the same way the rules editor
   * did. It has a ZONE to choose out of several hundred, a SAVE, a DELETE
   * and a typed confirmation, and §1.7 spells the last of those as "a click
   * or ⌘↩ on the confirm button". A 7x24 grid of drag targets is not the
   * argument — a drag needs no tab stop and mints no control — the zone
   * select and the two verbs are.
   *
   * The queue's one-tab-stop claim (Sc6) is what Sc8's twenty-drafts-under-
   * a-minute checkpoint rests on, and it is a claim about the QUEUE. It has
   * never been a claim about the app, which is why navigation is a ⌘-digit
   * keymap rather than the nav rail that would have put six tab stops in
   * front of every screen including that one.
   */
  const INTERACTIVE: readonly (readonly [string, RegExp])[] = [
    ['<button', /<button\b/],
    ['<a href', /<a\s[^>]*\bhref\b/],
    ['<input', /<input\b/],
    ['<select', /<select\b/],
    ['onClick', /\bonClick\s*=/],
    ['tabIndex', /\btabIndex\s*=/],
  ];

  function controlsIn(root: string): string[] {
    const out: string[] = [];
    for (const rel of archFiles(root)) {
      const code = codeOf(archRead(rel));
      for (const [name, re] of INTERACTIVE)
        if (re.test(code)) out.push(`${rel}: ${name}`);
    }
    return out.sort();
  }

  it('the schedule editor has real controls; the queue still has none', () => {
    const schedule = controlsIn(SCHEDULE);
    expect(schedule.some((c) => c.endsWith(': <button'))).toBe(true);
    expect(schedule.some((c) => c.endsWith(': <select'))).toBe(true);
    expect(schedule.filter((c) => c.endsWith(': <a href'))).toEqual([]);
    expect(schedule.filter((c) => c.endsWith(': tabIndex'))).toEqual([]);
    // Its own expression, over its own root. Widening the line above cannot
    // reach this one.
    expect(controlsIn(QUEUE)).toEqual([]);
    // And the rules editor is untouched by any of it.
    expect(controlsIn(RULES).some((c) => c.endsWith(': <button'))).toBe(true);
  });

  it('PLANTED: a zone select smuggled into the queue is caught', () => {
    const rel = sc11Plant(
      `${QUEUE}/__s8_sc11_probe__/Zone.tsx`,
      [
        'export function Zone(props: { zones: readonly string[] }): unknown {',
        '  return (',
        '    <select>',
        '      {props.zones.map((z) => (',
        '        <option value={z}>{z}</option>',
        '      ))}',
        '    </select>',
        '  );',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(QUEUE)).toEqual([`${rel}: <select`]);
  });

  it('LEGITIMATE NEAR-MISS: the same select in the schedule editor is allowed', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/Zone.tsx`,
      [
        'export function Zone(props: { zones: readonly string[] }): unknown {',
        '  return (',
        '    <select>',
        '      {props.zones.map((z) => (',
        '        <option value={z}>{z}</option>',
        '      ))}',
        '    </select>',
        '  );',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(SCHEDULE)).toContain(`${rel}: <select`);
    expect(controlsIn(QUEUE)).toEqual([]);
  });

  /* ── row 4: the locality rows, with a third screen in scope ─────────── */

  /**
   * Sc8 pinned the multi-line text field to one component, Sc10 pinned the
   * modal role to one component and the list roles have belonged to
   * `components/Listbox.tsx` since Sc6. A grid editor is a plausible way to
   * break all three at once — a notes field on a window, a "delete this
   * schedule?" panel with its own role, a hand-rolled list of windows — so
   * they are re-asserted here with the new directory in the tree rather
   * than left to a row whose non-vacuity list predates it.
   *
   * Re-spelling a banned literal in a second file is the failure; reusing
   * the component that owns it is the fix.
   */
  it('the owned markup still lives in exactly one file each', () => {
    const withCode = (re: RegExp): string[] =>
      archFiles(RENDERER)
        .filter((rel) => re.test(codeOf(archRead(rel))))
        .sort();
    expect(withCode(/<textarea\b/)).toEqual([
      `${RENDERER}/components/Editor.tsx`,
    ]);
    expect(withCode(/role="dialog"/)).toEqual([
      `${RENDERER}/components/TypedConfirm.tsx`,
    ]);
    expect(withCode(/role="listbox"/)).toEqual([
      `${RENDERER}/components/Listbox.tsx`,
    ]);
    expect(withCode(/role="option"/)).toEqual([
      `${RENDERER}/components/Listbox.tsx`,
    ]);
    expect(withCode(/<a\s[^>]*\bhref\b/)).toEqual([]);
  });

  it('PLANTED: a second modal role in the schedule editor is caught', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/Confirm.tsx`,
      [
        'export function Ask(): unknown {',
        '  return <div role="dialog">DELETE THIS SCHEDULE?</div>;',
        '}',
        '',
      ].join('\n'),
    );
    const sites = archFiles(RENDERER).filter((r) =>
      /role="dialog"/.test(codeOf(archRead(r))),
    );
    expect(sites).toContain(rel);
  });

  it('LEGITIMATE NEAR-MISS: reusing the confirm component spells nothing', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/Reuse.tsx`,
      [
        '/**',
        ' * The typed confirmation is a component, not a shape to re-draw.',
        ' * Its ARIA contract has one home and this file is not it.',
        ' */',
        "import { TypedConfirm } from '../../../components/TypedConfirm.js';",
        'export const Ask = TypedConfirm;',
        '',
      ].join('\n'),
    );
    expect(/role="dialog"/.test(codeOf(archRead(rel)))).toBe(false);
  });

  /* ── row 5: no zone literal in the renderer ─────────────────────────── */

  /**
   * The zone menu is `Intl.supportedValuesOf('timeZone')`, evaluated in the
   * renderer at paint time. That is not a convenience: a hand-written list
   * is a tz database with no maintainer, and this repo is PUBLIC, so row (f)
   * of the S6 guard above already pins every IANA literal in the tree to
   * five zones chosen for DST SHAPES rather than for anybody's location.
   *
   * Shipping a menu of four hundred zone names as source would either break
   * that row or force it open. Asking the runtime keeps the tree at zero
   * zone literals and keeps the menu correct on every future ICU.
   */
  const IANA_LITERAL =
    /['"`](?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z0-9_+-]+['"`]/;

  it('the renderer names no IANA zone, and asks the runtime instead', () => {
    const offenders = archFiles('apps/desktop/src')
      .filter((rel) => IANA_LITERAL.test(codeOf(archRead(rel))))
      .sort();
    expect(offenders).toEqual([]);
    const askers = archFiles(RENDERER)
      .filter((rel) =>
        /supportedValuesOf\s*\(\s*'timeZone'\s*\)/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(askers).toEqual([`${RENDERER}/screens/schedule/TzSelector.tsx`]);
  });

  it('PLANTED: a hand-written zone list in the renderer is caught', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/zones.ts`,
      ["export const ZONES = ['Europe/Lisbon', 'Indian/Mahe'];", ''].join('\n'),
    );
    const offenders = archFiles('apps/desktop/src').filter((r) =>
      IANA_LITERAL.test(codeOf(archRead(r))),
    );
    expect(offenders).toEqual([rel]);
  });

  /* ── row 6: INV-2, at the third screen ──────────────────────────────── */

  /**
   * A schedule is the most tempting place in this GUI to acquire a send
   * path, because "the window is open now" reads like an instruction. It is
   * not: opening a window changes what AUTONOMY may do next, and it says
   * nothing at all about work a human has already been asked to decide.
   *
   * Two halves, exactly as Sc10 stated them for the rules editor. The
   * binding may not name the approval vocabulary, and the screen may not
   * reach the bridge at all.
   */
  it('the schedule binding names no approval, and the screen names no bridge', () => {
    const binding = codeOf(archRead(`${STORE_ROOT}/schedule.ts`));
    for (const m of binding.matchAll(/[A-Za-z_$][\w$]*/g))
      expect(m[0], `${m[0]} in the schedule binding`).not.toMatch(
        /^(approve|approval|draftId|dispatch)$/i,
      );
    for (const rel of archFiles(SCHEDULE)) {
      const code = codeOf(archRead(rel));
      expect(/\bwindow\s*\.\s*wm\b/.test(code), `${rel} names window.wm`).toBe(
        false,
      );
      expect(
        /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/.test(code),
        `${rel} names a bridge member`,
      ).toBe(false);
    }
  });

  it('scheduleWrite and scheduleDelete have exactly one call site each', () => {
    const callers = (needle: string): string[] =>
      archFiles(RENDERER).filter((rel) =>
        codeOf(archRead(rel)).includes(needle),
      );
    for (const needle of ['bridge.scheduleWrite(', 'bridge.scheduleDelete(']) {
      expect(callers(needle), needle).toEqual([`${STORE_ROOT}/schedule.ts`]);
      expect(
        codeOf(archRead(`${STORE_ROOT}/schedule.ts`)).split(needle),
        needle,
      ).toHaveLength(2);
    }
  });

  /* ── row 7: the app still schedules nothing ─────────────────────────── */

  /**
   * Re-asserted with the marker in the tree. The NOW line is the single most
   * likely thing in this application to acquire a timer, and it did not: it
   * is painted from an instant the composition root read, labelled with the
   * instant it was read at, and moved by an operator keystroke. F-117 in the
   * small — nothing is armed for a deadline, so nothing can fire late,
   * early, or after the window closed.
   */
  it('the desktop app still schedules nothing, marker included', () => {
    const timers = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(timers).toEqual(['apps/desktop/src/main/gateway.ts']);
    const delayed = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(debounce|throttle|requestIdleCallback|requestAnimationFrame)\b/i.test(
          codeOf(archRead(rel)),
        ),
      )
      .sort();
    expect(delayed).toEqual([]);
  });

  it('PLANTED: a ticking NOW marker is caught', () => {
    const rel = sc11Plant(
      `${SCHEDULE}/__s8_sc11_probe__/tick.ts`,
      [
        'export function tick(paint: () => void): void {',
        '  setInterval(paint, 60_000);',
        '}',
        '',
      ].join('\n'),
    );
    const timers = archFiles('apps/desktop/src').filter((r) =>
      /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(r))),
    );
    expect(timers).toContain(rel);
  });
});

describe('S8 extensions (s8-execution Scenario 12: contacts and policies)', () => {
  const sc12Planted: string[] = [];
  function sc12Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc12Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc12Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/people/__s8_sc12_probe__',
      'apps/desktop/src/renderer/screens/queue/__s8_sc12_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc12_probe__',
      'apps/desktop/src/renderer/store/__s8_sc12_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const STORE_ROOT = `${RENDERER}/store`;
  const PEOPLE = `${RENDERER}/screens/people`;
  const QUEUE = `${RENDERER}/screens/queue`;
  const RULES = `${RENDERER}/screens/rules`;
  const GATE = 'packages/core/src/gate/index.ts';

  /** The single-quoted members of a named `const X = [ … ]`, in order. */
  function literalsOf(rel: string, name: string): string[] {
    const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(archRead(rel));
    if (m === null) return [];
    return [...(m[1] as string).matchAll(/'([^']+)'/g)].map(
      (x) => x[1] as string,
    );
  }

  /* ── row 1: absence is deny, and the screen may not soften it ───────── */

  /**
   * The load-bearing claim of the whole scenario, stated as a tie between
   * two packages that cannot import each other.
   *
   * §2.4.3 step 3 lives in `evaluateGate`: with no `ContactPolicy` row the
   * gate returns `contact-denied`. So a contacts grid whose policy column is
   * blank for a handle with no row is not "showing no policy" — it is
   * drawing the strictest state this product has as the absence of a state,
   * and an operator who reads it that way will wait forever for a reply the
   * daemon already refused.
   *
   * The renderer cannot import the gate (INV-1: `apps/desktop` has no
   * `@wemessage/core` dependency), so the sentence it prints is a COPY of a
   * behaviour it cannot see. That is exactly the kind of copy that rots. So
   * this row reads both ends and pins them together:
   *
   *  - the gate still denies when `ctx.contact === null`, and
   *  - the guard on that branch is still `ctx.rule !== null || agentOrigin`,
   *    which is what makes the screen's HUMAN carve-out true rather than
   *    generous, and
   *  - the screen's sentence for the absence is non-empty and says DENIED.
   *
   * If a later slice makes the default permissive, this row fails and the
   * sentence gets rewritten, rather than quietly becoming a lie.
   */
  it('the gate still denies an unknown contact, and the screen says so in words', () => {
    const gate = codeOf(archRead(GATE));
    expect(gate).toContain('function evaluateGate');
    // The guard, and the branch under it. Written as one match so a
    // reordering that moved the deny out from under the guard fails here.
    expect(gate).toMatch(
      /if \(ctx\.rule !== null \|\| agentOrigin\) \{\s*if \(ctx\.contact === null \|\| ctx\.contact\.mode === 'deny'\) \{\s*return \{ allow: false, reason: 'contact-denied' \};/,
    );
    // …and narrowing, never raising, on the line after it.
    expect(gate).toContain('mode = narrower(mode, ctx.contact.mode);');

    const derive = archRead(`${RENDERER}/derive/peopleRows.ts`);
    const sentence = /UNKNOWN_MODE_SENTENCE\s*=\s*'([^']*)'/.exec(derive)?.[1];
    expect(sentence).toBeDefined();
    expect(sentence).not.toBe('');
    expect(sentence).toMatch(/DENIED/);
  });

  /* ── row 2: the footer is the gate's chain, read from the gate ──────── */

  /**
   * The precedence footer is the one piece of prose on this screen that
   * claims to describe an ORDER, and the plan's version of it
   * (`KILL > DENY > window > rate cap > rule mode`) is wrong twice: the mode
   * ladder resolves BEFORE the clamp chain, and the chain has five distinct
   * clamps rather than two.
   *
   * A footer written by hand is a comment with a stylesheet. So the clamp
   * half of it is tied to the `clampedBy` assignments in `evaluateGate`,
   * in source order, deduped — `outside-window` is assigned twice, by the
   * pause and by the shut window, and an operator reading a list does not
   * need to be told the same word twice.
   *
   * The tie is by first word rather than by a mapping table, because a
   * mapping table in this file would be a third place for the order to
   * disagree with itself.
   */
  it('the clamp footer is the gate`s else-if chain, in the gate`s order', () => {
    const assigned: string[] = [];
    for (const m of codeOf(archRead(GATE)).matchAll(/clampedBy = '([a-z-]+)'/g))
      if (!assigned.includes(m[1] as string)) assigned.push(m[1] as string);
    expect(assigned).toEqual([
      'outside-window',
      'rate-limited',
      'circuit-open',
      'loop-detected',
      'sms-auto-forbidden',
    ]);
    const footer = literalsOf(
      `${RENDERER}/derive/peopleRows.ts`,
      'CLAMP_ORDER',
    );
    expect(footer).toHaveLength(assigned.length);
    for (const [i, word] of footer.entries())
      expect(
        (assigned[i] as string).toUpperCase(),
        `${word} is clamp ${String(i)}`,
      ).toContain(word.split(' ')[0] as string);
    // …and the denies are a SEPARATE list, because they bind different
    // people: `if (!gate.allow) return gateDeny(...)` runs before
    // `if (isAutoApproval)`, so a deny stops everybody and a clamp stops
    // only the machine. One flat list would erase that.
    expect(
      literalsOf(`${RENDERER}/derive/peopleRows.ts`, 'DENY_ORDER'),
    ).toEqual(['KILL', 'LINK', 'CONTACT DENY']);
  });

  /* ── row 3: controls, per screen, still ─────────────────────────────── */

  /**
   * Sc7 banned controls under `screens/queue`; Sc10 permitted them under
   * `screens/rules`; Sc11 permitted them under `screens/schedule`. This is
   * the fourth root and, as in Sc11, it is a SEPARATE row over its own
   * expressions: `screens/people` being allowed a button cannot widen
   * `screens/queue`, because the queue's emptiness is asserted here by its
   * own expression over its own root.
   *
   * The people screen earns them. It has a search field, a per-row
   * segmented control of three modes, a selection toggle, a bulk mode
   * select and a typed confirmation, and §1.7 spells the last as "a click
   * or ⌘↩ on the confirm button". What it may NOT have is a link or a
   * hand-rolled tab stop: `<a href` is banned renderer-wide and `tabIndex`
   * is how a grid grows the focus holders the queue proved it cannot keep.
   */
  const INTERACTIVE: readonly (readonly [string, RegExp])[] = [
    ['<button', /<button\b/],
    ['<a href', /<a\s[^>]*\bhref\b/],
    ['<input', /<input\b/],
    ['<select', /<select\b/],
    ['onClick', /\bonClick\s*=/],
    ['tabIndex', /\btabIndex\s*=/],
  ];

  function controlsIn(root: string): string[] {
    const out: string[] = [];
    for (const rel of archFiles(root)) {
      const code = codeOf(archRead(rel));
      for (const [name, re] of INTERACTIVE)
        if (re.test(code)) out.push(`${rel}: ${name}`);
    }
    return out.sort();
  }

  it('the people screen has real controls; the queue still has none', () => {
    const people = controlsIn(PEOPLE);
    expect(people.some((c) => c.endsWith(': <button'))).toBe(true);
    expect(people.some((c) => c.endsWith(': <input'))).toBe(true);
    expect(people.some((c) => c.endsWith(': <select'))).toBe(true);
    expect(people.filter((c) => c.endsWith(': <a href'))).toEqual([]);
    expect(people.filter((c) => c.endsWith(': tabIndex'))).toEqual([]);
    // Its own expression, over its own root.
    expect(controlsIn(QUEUE)).toEqual([]);
    // And the editors before it are untouched by any of it.
    expect(controlsIn(RULES).some((c) => c.endsWith(': <button'))).toBe(true);
  });

  it('PLANTED: a segmented control smuggled into the queue is caught', () => {
    const rel = sc12Plant(
      `${QUEUE}/__s8_sc12_probe__/Mode.tsx`,
      [
        'export function Mode(props: { set: (m: string) => void }): unknown {',
        '  return <button onClick={() => props.set("auto")}>AUTO</button>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(QUEUE)).toEqual([`${rel}: <button`, `${rel}: onClick`]);
  });

  it('LEGITIMATE NEAR-MISS: the same control in the people screen is allowed', () => {
    const rel = sc12Plant(
      `${PEOPLE}/__s8_sc12_probe__/Mode.tsx`,
      [
        'export function Mode(props: { set: (m: string) => void }): unknown {',
        '  return <button onClick={() => props.set("auto")}>AUTO</button>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(PEOPLE)).toContain(`${rel}: <button`);
    expect(controlsIn(QUEUE)).toEqual([]);
  });

  /* ── row 4: the locality rows, with a grid in the tree ──────────────── */

  /**
   * Sc8 pinned the multi-line text field, Sc10 the modal role, Sc6 the list
   * roles, and Sc11 re-asserted all four with a third screen in scope. A
   * grid is a plausible way to break every one of them at once — a notes
   * field on a contact, a "set 40 contacts to AUTO?" panel with its own
   * role, a hand-rolled listbox of modes — so they are re-asserted here.
   *
   * The GRID roles are new, and they are pinned the same way on the way in
   * rather than after somebody re-spells them: `role="grid"`, `"row"`,
   * `"columnheader"` and `"gridcell"` are one component's ARIA contract, and
   * a second file that spells `role="row"` is a second file that has to be
   * kept consistent with the first about rowcount, selection and order.
   */
  it('the owned markup still lives in exactly one file each', () => {
    const withCode = (re: RegExp): string[] =>
      archFiles(RENDERER)
        .filter((rel) => re.test(codeOf(archRead(rel))))
        .sort();
    expect(withCode(/<textarea\b/)).toEqual([
      `${RENDERER}/components/Editor.tsx`,
    ]);
    expect(withCode(/role="dialog"/)).toEqual([
      `${RENDERER}/components/TypedConfirm.tsx`,
    ]);
    expect(withCode(/role="listbox"/)).toEqual([
      `${RENDERER}/components/Listbox.tsx`,
    ]);
    expect(withCode(/role="option"/)).toEqual([
      `${RENDERER}/components/Listbox.tsx`,
    ]);
    expect(withCode(/<a\s[^>]*\bhref\b/)).toEqual([]);
    for (const role of ['grid', 'row', 'columnheader', 'gridcell'])
      expect(withCode(new RegExp(`role="${role}"`)), role).toEqual([
        `${PEOPLE}/Grid.tsx`,
      ]);
  });

  it('PLANTED: a second file spelling the grid`s row role is caught', () => {
    const rel = sc12Plant(
      `${PEOPLE}/__s8_sc12_probe__/Row.tsx`,
      [
        'export function Row(props: { handle: string }): unknown {',
        '  return <div role="row">{props.handle}</div>;',
        '}',
        '',
      ].join('\n'),
    );
    const sites = archFiles(RENDERER).filter((r) =>
      /role="row"/.test(codeOf(archRead(r))),
    );
    expect(sites).toContain(rel);
  });

  it('LEGITIMATE NEAR-MISS: reusing the confirm component spells nothing', () => {
    const rel = sc12Plant(
      `${PEOPLE}/__s8_sc12_probe__/Reuse.tsx`,
      [
        '/**',
        ' * The typed confirmation is a component, not a shape to re-draw.',
        ' * Its ARIA contract has one home and this file is not it.',
        ' */',
        "import { TypedConfirm } from '../../../components/TypedConfirm.js';",
        'export const Ask = TypedConfirm;',
        '',
      ].join('\n'),
    );
    expect(/role="dialog"/.test(codeOf(archRead(rel)))).toBe(false);
  });

  /* ── row 5: no screen reads a clock, and this one counts an hour ────── */

  /**
   * Sc11's ban, re-asserted where it is most tempting to break. The
   * AUTO-SENDS column is a count over a window ending NOW, and the obvious
   * way to write it is `Date.now()` inside the cell that draws it — which
   * would make the number a property of when Preact happened to render, and
   * would make the e2e's rate-cap row untestable without racing a real
   * clock (C-11).
   *
   * The instant is read once, in `main.tsx`, and handed down. `derive/` is
   * pure and takes the instant as an argument.
   */
  const CLOCK_READ = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/;

  it('no file under screens/ or derive/ reads a clock', () => {
    for (const root of [`${RENDERER}/screens`, `${RENDERER}/derive`]) {
      const offenders = archFiles(root)
        .filter((rel) => CLOCK_READ.test(codeOf(archRead(rel))))
        .sort();
      expect(offenders, root).toEqual([]);
    }
    // Non-vacuous: the composition root really does read one.
    expect(CLOCK_READ.test(codeOf(archRead(`${RENDERER}/main.tsx`)))).toBe(
      true,
    );
  });

  it('PLANTED: an hour window that reads the clock where it counts is caught', () => {
    const rel = sc12Plant(
      `${RENDERER}/derive/__s8_sc12_probe__/hour.ts`,
      [
        'export function recent(at: readonly string[]): number {',
        '  const cut = Date.now() - 3_600_000;',
        '  return at.filter((iso) => Date.parse(iso) >= cut).length;',
        '}',
        '',
      ].join('\n'),
    );
    const offenders = archFiles(`${RENDERER}/derive`).filter((r) =>
      CLOCK_READ.test(codeOf(archRead(r))),
    );
    expect(offenders).toEqual([rel]);
  });

  it('LEGITIMATE NEAR-MISS: the same window handed its instant is clean', () => {
    const rel = sc12Plant(
      `${RENDERER}/derive/__s8_sc12_probe__/given.ts`,
      [
        '/**',
        ' * The instant arrives as an argument. `Date.parse` reads a string',
        ' * somebody else stamped; it asks nothing of the machine.',
        ' */',
        'export function recent(at: readonly string[], nowIso: string): number {',
        '  const cut = Date.parse(nowIso) - 3_600_000;',
        '  return at.filter((iso) => Date.parse(iso) >= cut).length;',
        '}',
        '',
      ].join('\n'),
    );
    expect(CLOCK_READ.test(codeOf(archRead(rel)))).toBe(false);
  });

  /* ── row 6: INV-2, at the fourth screen ─────────────────────────────── */

  /**
   * A contact policy is the most tempting place in this GUI to acquire a
   * send path, because "this person is set to AUTO" reads like an
   * instruction about the queue. It is not: a policy governs what AUTONOMY
   * may do NEXT, and says nothing at all about work a human has already
   * been asked to decide. Loosening it must not dispatch or auto-approve a
   * draft that already exists.
   *
   * Two halves, as Sc10 and Sc11 stated them. The binding may not name the
   * approval vocabulary, and the screen may not reach the bridge at all.
   */
  it('the people binding names no approval, and the screen names no bridge', () => {
    const binding = codeOf(archRead(`${STORE_ROOT}/people.ts`));
    for (const m of binding.matchAll(/[A-Za-z_$][\w$]*/g))
      expect(m[0], `${m[0]} in the people binding`).not.toMatch(
        /^(approve|approval|draftId|dispatch)$/i,
      );
    for (const rel of archFiles(PEOPLE)) {
      const code = codeOf(archRead(rel));
      expect(/\bwindow\s*\.\s*wm\b/.test(code), `${rel} names window.wm`).toBe(
        false,
      );
      expect(
        /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/.test(code),
        `${rel} names a bridge member`,
      ).toBe(false);
    }
  });

  it('contactSet has exactly one call site, and contactDelete has none', () => {
    const callers = (needle: string): string[] =>
      archFiles(RENDERER).filter((rel) =>
        codeOf(archRead(rel)).includes(needle),
      );
    expect(callers('bridge.contactSet(')).toEqual([`${STORE_ROOT}/people.ts`]);
    // One site, once. A bulk gesture is N calls THROUGH this site, which is
    // what lets the typed confirm count the requests it is about to make.
    expect(
      codeOf(archRead(`${STORE_ROOT}/people.ts`)).split('bridge.contactSet('),
    ).toHaveLength(2);
    expect(callers('bridge.contactDelete(')).toEqual([]);
    // Non-vacuous: the channel exists and is spelled in the registry.
    expect(archRead('apps/desktop/src/main/ipc-channels.ts')).toContain(
      "contactDelete: 'wm:contact.delete'",
    );
  });

  /* ── row 7: the app still schedules nothing ─────────────────────────── */

  it('the desktop app still schedules nothing, two thousand rows included', () => {
    const timers = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(timers).toEqual(['apps/desktop/src/main/gateway.ts']);
    const delayed = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(debounce|throttle|requestIdleCallback|requestAnimationFrame)\b/i.test(
          codeOf(archRead(rel)),
        ),
      )
      .sort();
    expect(delayed).toEqual([]);
  });

  it('PLANTED: a debounced contact search is caught', () => {
    const rel = sc12Plant(
      `${PEOPLE}/__s8_sc12_probe__/search.ts`,
      [
        'export function debounce(fn: () => void, ms: number): () => void {',
        '  let t: ReturnType<typeof setTimeout> | null = null;',
        '  return () => {',
        '    if (t !== null) clearTimeout(t);',
        '    t = setTimeout(fn, ms);',
        '  };',
        '}',
        '',
      ].join('\n'),
    );
    const code = codeOf(archRead(rel));
    expect(/\b(debounce|throttle)\b/i.test(code)).toBe(true);
    expect(/\b(setTimeout|setInterval)\(/.test(code)).toBe(true);
  });
});

describe('S8 extensions (s8-execution Scenario 13: the audit screen)', () => {
  const sc13Planted: string[] = [];
  function sc13Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc13Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc13Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/audit/__s8_sc13_probe__',
      'apps/desktop/src/renderer/screens/queue/__s8_sc13_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc13_probe__',
      'apps/desktop/src/renderer/store/__s8_sc13_probe__',
      'packages/daemon/src/routes/__s8_sc13_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const STORE_ROOT = `${RENDERER}/store`;
  const AUDIT = `${RENDERER}/screens/audit`;
  const QUEUE = `${RENDERER}/screens/queue`;
  const PEOPLE = `${RENDERER}/screens/people`;
  const ROUTES = 'packages/daemon/src/routes';
  const AUDIT_ROUTE = `${ROUTES}/audit.ts`;
  const DENY_UNION = 'packages/core/src/domain/types.ts';

  /** Every `app.<verb>('<path>'` a route file registers, in source order. */
  function registrationsIn(rel: string): string[] {
    const out: string[] = [];
    for (const m of codeOf(archRead(rel)).matchAll(
      /\bapp\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*'([^']+)'/g,
    ))
      out.push(`${(m[1] as string).toUpperCase()} ${m[2] as string}`);
    return out;
  }

  /* ── row 1: the log is append-only, and there is no route that isn't ── */

  /**
   * The strongest thing this scenario can assert, and it is an ABSENCE.
   *
   * `packages/core/src/ports/index.ts` states it as an API property rather
   * than a convention: "The Store exposes NO update/delete path for
   * audit_log." The daemon agrees by having nothing to expose — two reads,
   * and the auto-HEAD twins fastify derives from them. This row pins the
   * absence at both levels, so a later scenario that wants a `DELETE
   * /v1/audit` (or a "clear history" affordance behind one) has to delete
   * this row and say why in the same diff.
   *
   * It is a ban-style row and therefore vacuously satisfiable by a tree in
   * which nobody ever writes a route at all, which is why the second half
   * asserts the scanner FINDS mutating verbs elsewhere, and why the planted
   * offender below is a real registration in a real route directory.
   */
  it('the audit surface is exactly two reads, and no route mutates the log', () => {
    expect(registrationsIn(AUDIT_ROUTE)).toEqual([
      'GET /v1/audit',
      'GET /v1/audit/verify',
    ]);
    // …and the transport surface agrees, HEAD twins included.
    expect(ROUTE_TABLE.filter((r) => r.includes('/v1/audit'))).toEqual([
      'GET /v1/audit',
      'GET /v1/audit/verify',
      'HEAD /v1/audit',
      'HEAD /v1/audit/verify',
    ]);
    // Nothing anywhere in the route directory mutates a path naming audit.
    const mutating = archFiles(ROUTES).flatMap((rel) =>
      registrationsIn(rel)
        .filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r))
        .map((r) => `${rel}: ${r}`),
    );
    expect(mutating.filter((r) => /\/v1\/audit/.test(r))).toEqual([]);
    // Non-vacuous: the scanner really does see mutating registrations.
    expect(mutating.length).toBeGreaterThan(10);
  });

  it('PLANTED: a route that deletes audit rows is caught', () => {
    const rel = sc13Plant(
      `${ROUTES}/__s8_sc13_probe__/purge.ts`,
      [
        "import type { FastifyInstance } from 'fastify';",
        'export function registerPurge(app: FastifyInstance): void {',
        "  app.delete('/v1/audit', () => ({ purged: true }));",
        '}',
        '',
      ].join('\n'),
    );
    const mutating = archFiles(ROUTES).flatMap((r) =>
      registrationsIn(r).map((x) => `${r}: ${x}`),
    );
    expect(mutating).toContain(`${rel}: DELETE /v1/audit`);
  });

  it('LEGITIMATE NEAR-MISS: a second READ over the log is not a mutation', () => {
    const rel = sc13Plant(
      `${ROUTES}/__s8_sc13_probe__/tail.ts`,
      [
        '/**',
        ' * A reader may be added freely. What may not be added is a verb.',
        ' */',
        "import type { FastifyInstance } from 'fastify';",
        'export function registerTail(app: FastifyInstance): void {',
        "  app.get('/v1/audit/tail', () => []);",
        '}',
        '',
      ].join('\n'),
    );
    const mine = registrationsIn(rel);
    expect(mine).toEqual(['GET /v1/audit/tail']);
    expect(mine.filter((r) => /^(POST|PUT|PATCH|DELETE) /.test(r))).toEqual([]);
  });

  /* ── row 2: the list query has no upper bound, and the copy knows it ── */

  /**
   * The plan says `LOAD MORE` "fetches with `since` set from the oldest
   * loaded `at`". It cannot. `since` is `sinceAt` in
   * `packages/store/src/store.ts`, which is an INCLUSIVE LOWER bound
   * (`at >= ?`) under `ORDER BY seq DESC LIMIT ?`, and the route exposes no
   * upper bound at all — no `until`, no `before`, no `beforeSeq`, and not
   * even the `sinceSeq` the store itself supports. Re-fetching with the
   * oldest loaded instant returns the SAME page.
   *
   * So the screen escalates the LIMIT to the route's cap and then says, in
   * words, that it is at the newest thousand and that narrowing is how you
   * reach the rest. That copy is only honest while this is true, which is
   * why the query schema is pinned here rather than left to be discovered
   * by an operator who thought they had seen everything.
   */
  it('the audit list query is exactly since, event and limit', () => {
    const m = /listQuery = z\.strictObject\(\{([\s\S]*?)\}\)/.exec(
      archRead(AUDIT_ROUTE),
    );
    expect(m).not.toBeNull();
    const keys = [
      ...(m?.[1] ?? '').matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm),
    ].map((x) => x[1] as string);
    expect(keys).toEqual(['since', 'event', 'limit']);
    // `strictObject`, so an unknown param is a 400 rather than a silent
    // no-op: the screen cannot ask for a window the daemon will ignore.
    expect(archRead(AUDIT_ROUTE)).toContain('z.strictObject');
    // And the cap the ceiling copy names is the one the route enforces.
    expect(archRead(AUDIT_ROUTE)).toMatch(/\.max\(1000\)/);
  });

  /* ── row 3: the renderer's twelve are core's twelve ─────────────────── */

  /**
   * INV-1 forbids the renderer a `@wemessage/core` dependency, and
   * `@wemessage/client` exports `GateDenyReason` as a TYPE with no runtime
   * array behind it. A screen that draws `gate.denied` rows therefore has
   * to re-declare the taxonomy, which makes it a second projection of C-6's
   * closed union — the exact situation C-6 exists to keep honest.
   *
   * The tie is made here, by scraping both. A thirteenth reason added to
   * core and not to the renderer fails this row, rather than reaching an
   * operator as a word with no glyph.
   */
  it('the audit derivation names exactly the twelve gate deny reasons', () => {
    const union = /GateDenyReason\s*=([\s\S]*?);/.exec(archRead(DENY_UNION));
    expect(union).not.toBeNull();
    const core = [...(union?.[1] ?? '').matchAll(/'([^']+)'/g)]
      .map((m) => m[1] as string)
      .sort();
    expect(core).toHaveLength(12);
    const screen = [
      ...(/DENY_REASONS[^=]*=\s*\[([\s\S]*?)\]/.exec(
        archRead(`${RENDERER}/derive/auditRows.ts`),
      )?.[1] ?? ''),
    ]
      .join('')
      .match(/'([^']+)'/g);
    expect(screen).not.toBeNull();
    expect((screen ?? []).map((q) => q.slice(1, -1)).sort()).toEqual(core);
  });

  /* ── row 4: no adapter token can reach this process's windows ───────── */

  /**
   * Adapter tokens are `wm_` plus 64 hex, scrypt-hashed at rest, minted
   * once and never re-displayed. No audit event carries one — the
   * `adapter.*` events carry an id, a kind and a reason — so this row is
   * GREEN today, and that is exactly why it is worth writing: it is cheap
   * now and it is the difference between a leak and a failing test on the
   * day somebody adds a token field to an audit payload "for debugging".
   *
   * Scoped to the whole desktop app rather than to the audit screen. The
   * screen is where a token would be SEEN, but main is where one would be
   * carried, and a bridge that never holds one cannot hand one over.
   *
   * Over `codeOf`, deliberately: a comment explaining the ban (there is one
   * in the audit binding) must not be an offender, and the recurring
   * self-trip in this suite is a guard tripping over its own prose.
   */
  const TOKEN_PREFIX = /wm_/;

  it('no file in the desktop app names an adapter token prefix', () => {
    const offenders = archFiles('apps/desktop/src')
      .filter((rel) => TOKEN_PREFIX.test(codeOf(archRead(rel))))
      .sort();
    expect(offenders).toEqual([]);
    // Non-vacuous: the prefix is real, and the minting site spells it.
    expect(
      TOKEN_PREFIX.test(
        codeOf(archRead('packages/adapter-testkit/src/spawn.ts')),
      ),
    ).toBe(true);
  });

  it('PLANTED: a drawer that renders a token field is caught', () => {
    const rel = sc13Plant(
      `${AUDIT}/__s8_sc13_probe__/Token.tsx`,
      [
        'export function Token(props: { row: { token?: string } }): unknown {',
        "  return <code>{props.row.token ?? 'wm_'}</code>;",
        '}',
        '',
      ].join('\n'),
    );
    expect(TOKEN_PREFIX.test(codeOf(archRead(rel)))).toBe(true);
  });

  it('LEGITIMATE NEAR-MISS: naming the adapter itself is not naming its token', () => {
    const rel = sc13Plant(
      `${AUDIT}/__s8_sc13_probe__/Adapter.tsx`,
      [
        '/**',
        ' * An adapter IDENTITY is on every audit row and belongs on screen.',
        ' * Its credential is not on any audit row and never will be.',
        ' */',
        'export function Adapter(props: { adapterId: string }): unknown {',
        '  return <span>{props.adapterId}</span>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(TOKEN_PREFIX.test(codeOf(archRead(rel)))).toBe(false);
  });

  /* ── row 5: a reader has no destructive verb, anywhere in its copy ──── */

  /**
   * The UI half of row 1. A route that does not exist cannot be called, but
   * a screen can still IMPLY that it could — a greyed "CLEAR HISTORY", a
   * per-row bin glyph, a "REMOVE" in a menu — and an operator who believes
   * the log can be edited is an operator who does not trust it as evidence
   * and does not expect anybody else to either. The append-only property is
   * worth nothing that is not visible.
   *
   * The screen's copy is uppercase by convention (§1.7), so the ban is over
   * uppercase words: the words a control would be LABELLED with. `EXPORT`
   * is not among them — writing a copy out is not a mutation of the log —
   * and neither is `VERIFY`.
   */
  const DESTRUCTIVE = /\b(DELETE|REMOVE|CLEAR|ERASE|PURGE|WIPE|DISCARD)\b/;

  it('the audit screen offers no destructive verb', () => {
    const offenders = archFiles(AUDIT)
      .filter((rel) => DESTRUCTIVE.test(codeOf(archRead(rel))))
      .sort();
    expect(offenders).toEqual([]);
    // Non-vacuous: the scanner does find these words where they belong.
    expect(
      archFiles(RENDERER).some((rel) =>
        DESTRUCTIVE.test(codeOf(archRead(rel))),
      ),
    ).toBe(true);
  });

  it('PLANTED: a CLEAR HISTORY button on the audit screen is caught', () => {
    const rel = sc13Plant(
      `${AUDIT}/__s8_sc13_probe__/Clear.tsx`,
      [
        'export function Clear(props: { go: () => void }): unknown {',
        '  return <button onClick={props.go}>CLEAR HISTORY</button>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(DESTRUCTIVE.test(codeOf(archRead(rel)))).toBe(true);
  });

  /* ── row 6: controls, per screen, for the fifth root ────────────────── */

  const INTERACTIVE: readonly (readonly [string, RegExp])[] = [
    ['<button', /<button\b/],
    ['<a href', /<a\s[^>]*\bhref\b/],
    ['<input', /<input\b/],
    ['<select', /<select\b/],
    ['onClick', /\bonClick\s*=/],
    ['tabIndex', /\btabIndex\s*=/],
  ];

  function controlsIn(root: string): string[] {
    const out: string[] = [];
    for (const rel of archFiles(root)) {
      const code = codeOf(archRead(rel));
      for (const [name, re] of INTERACTIVE)
        if (re.test(code)) out.push(`${rel}: ${name}`);
    }
    return out.sort();
  }

  /**
   * Sc11 and Sc12 each kept this as SEPARATE expressions over SEPARATE
   * roots in one row, so that widening one line structurally cannot reach
   * the queue line. Fifth root, same shape.
   *
   * The audit screen earns controls: an event-type select, a free-text
   * box, a since box, actor chips, VERIFY CHAIN, EXPORT REPORT, a per-row
   * opener and a drawer close. What it may not have is `<a href` (banned
   * renderer-wide) or `tabIndex` — a table with five hundred rows is the
   * most tempting place in the app to hand-roll a roving tab stop, and the
   * row opener being a real `<button>` is what makes that unnecessary.
   */
  it('the audit screen has real controls; the queue still has none', () => {
    const audit = controlsIn(AUDIT);
    expect(audit.some((c) => c.endsWith(': <button'))).toBe(true);
    expect(audit.some((c) => c.endsWith(': <input'))).toBe(true);
    expect(audit.some((c) => c.endsWith(': <select'))).toBe(true);
    expect(audit.filter((c) => c.endsWith(': <a href'))).toEqual([]);
    expect(audit.filter((c) => c.endsWith(': tabIndex'))).toEqual([]);
    // Its own expression, over its own root.
    expect(controlsIn(QUEUE)).toEqual([]);
    // And the screen before it is untouched by any of it.
    expect(controlsIn(PEOPLE).some((c) => c.endsWith(': <button'))).toBe(true);
  });

  it('PLANTED: a row opener smuggled into the queue is caught', () => {
    const rel = sc13Plant(
      `${QUEUE}/__s8_sc13_probe__/Open.tsx`,
      [
        'export function Open(props: { seq: number }): unknown {',
        '  return <button onClick={() => props.seq}>OPEN</button>;',
        '}',
        '',
      ].join('\n'),
    );
    expect(controlsIn(QUEUE)).toEqual([`${rel}: <button`, `${rel}: onClick`]);
  });

  /* ── row 7: locality, with a table and a drawer in the tree ─────────── */

  /**
   * Both of this screen's two biggest surfaces are shaped exactly like
   * something another file already owns, which is why they are re-asserted
   * on the way in:
   *
   *  - the JSON drawer is NOT a dialog. `role="dialog"` has one home, and
   *    a pane over an append-only log has no business being modal: the
   *    table behind it stays readable and the keymap stays live.
   *  - the row table is NOT a grid. `role="grid"` and its three companions
   *    are `people/Grid.tsx`'s ARIA contract, and a second file spelling
   *    `role="row"` is a second file that has to be kept consistent about
   *    rowcount, selection and order. A native `<table>` spells no role at
   *    all, which is the point.
   */
  it('the owned markup still lives in exactly one file each', () => {
    const withCode = (re: RegExp): string[] =>
      archFiles(RENDERER)
        .filter((rel) => re.test(codeOf(archRead(rel))))
        .sort();
    expect(withCode(/<textarea\b/)).toEqual([
      `${RENDERER}/components/Editor.tsx`,
    ]);
    expect(withCode(/role="dialog"/)).toEqual([
      `${RENDERER}/components/TypedConfirm.tsx`,
    ]);
    expect(withCode(/role="listbox"/)).toEqual([
      `${RENDERER}/components/Listbox.tsx`,
    ]);
    expect(withCode(/role="option"/)).toEqual([
      `${RENDERER}/components/Listbox.tsx`,
    ]);
    expect(withCode(/<a\s[^>]*\bhref\b/)).toEqual([]);
    for (const role of ['grid', 'row', 'columnheader', 'gridcell'])
      expect(withCode(new RegExp(`role="${role}"`)), role).toEqual([
        `${PEOPLE}/Grid.tsx`,
      ]);
  });

  it('PLANTED: an audit drawer that claims the modal role is caught', () => {
    const rel = sc13Plant(
      `${AUDIT}/__s8_sc13_probe__/Modal.tsx`,
      [
        'export function Modal(props: { json: string }): unknown {',
        '  return <div role="dialog"><pre>{props.json}</pre></div>;',
        '}',
        '',
      ].join('\n'),
    );
    const sites = archFiles(RENDERER).filter((r) =>
      /role="dialog"/.test(codeOf(archRead(r))),
    );
    expect(sites).toContain(rel);
  });

  /* ── row 8: the screen that draws ages still reads no clock ─────────── */

  /**
   * Sc11's ban at its hardest test. Every row on this screen carries an
   * age, and the obvious way to write "2S AGO" is `Date.now()` in the cell
   * — which would make the column a property of when Preact happened to
   * render, and would make a five-thousand-row fixture's ages race a real
   * clock (C-11).
   *
   * The instant is read once in `main.tsx`, handed down as a prop,
   * published as `data-now-iso`, and moves only when the operator asks.
   */
  const CLOCK_READ = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/;

  it('no file under screens/ or derive/ reads a clock, ages included', () => {
    for (const root of [`${RENDERER}/screens`, `${RENDERER}/derive`]) {
      const offenders = archFiles(root)
        .filter((rel) => CLOCK_READ.test(codeOf(archRead(rel))))
        .sort();
      expect(offenders, root).toEqual([]);
    }
    expect(CLOCK_READ.test(codeOf(archRead(`${RENDERER}/main.tsx`)))).toBe(
      true,
    );
    // The screen publishes the instant it used, so an age on screen can be
    // checked against the moment it was computed from.
    expect(codeOf(archRead(`${RENDERER}/main.tsx`))).toContain('data-now-iso');
  });

  it('PLANTED: an age computed at draw time is caught', () => {
    const rel = sc13Plant(
      `${RENDERER}/derive/__s8_sc13_probe__/age.ts`,
      [
        'export function age(at: string): number {',
        '  return Date.now() - Date.parse(at);',
        '}',
        '',
      ].join('\n'),
    );
    const offenders = archFiles(`${RENDERER}/derive`).filter((r) =>
      CLOCK_READ.test(codeOf(archRead(r))),
    );
    expect(offenders).toEqual([rel]);
  });

  /* ── row 9: INV-2, at the fifth screen and the first read-only one ──── */

  /**
   * The audit screen is the first surface in this GUI with no write to the
   * daemon at all, which makes the INV-2 claim both easier to state and
   * easier to break by accident: a screen that lists `auto.approved` rows
   * is a screen whose source is full of the word "approve".
   *
   * Sc12's shape, not a blanket ban. The binding may not name the approval
   * VOCABULARY as identifiers, and the screen may not reach the bridge at
   * all — but the screen is free to name an approval as a string in a read
   * URL, because that is what reading approvals looks like. The e2e states
   * the other half at the wire: every request naming an approval is a GET.
   */
  it('the audit binding names no approval, and the screen names no bridge', () => {
    const binding = codeOf(archRead(`${STORE_ROOT}/audit.ts`));
    for (const m of binding.matchAll(/[A-Za-z_$][\w$]*/g))
      expect(m[0], `${m[0]} in the audit binding`).not.toMatch(
        /^(approve|approval|draftId|dispatch)$/i,
      );
    for (const rel of archFiles(AUDIT)) {
      const code = codeOf(archRead(rel));
      expect(/\bwindow\s*\.\s*wm\b/.test(code), `${rel} names window.wm`).toBe(
        false,
      );
      expect(
        /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/.test(code),
        `${rel} names a bridge member`,
      ).toBe(false);
    }
  });

  /**
   * SELF-TRIP, recorded rather than papered over. This row was first
   * written to claim that all three audit channels have one call site, and
   * it was FACTUALLY WRONG about the product: `bridge.audit(` already has
   * three callers, because the rules editor reads the log for its LAST
   * MATCHED column and the people grid reads it for AUTO-SENDS PER HOUR.
   *
   * That is correct and the partition row above says so in as many words:
   * READS may be shared, WRITES may not. So the row is strengthened rather
   * than loosened — the shared read is enumerated exactly, which catches a
   * fourth reader as surely as the original claim would have, and the two
   * channels that are genuinely single-owner are asserted separately AND
   * counted, because a `verify` that fired twice would walk the chain twice
   * and the second answer would be about a longer log.
   */
  it('the shared read is enumerated; verify and export have one caller each', () => {
    const callers = (needle: string): string[] =>
      archFiles(RENDERER)
        .filter((rel) => codeOf(archRead(rel)).includes(needle))
        .sort();
    expect(callers('bridge.audit(')).toEqual([
      `${STORE_ROOT}/audit.ts`,
      `${STORE_ROOT}/people.ts`,
      `${STORE_ROOT}/rules.ts`,
    ]);
    for (const channel of ['auditVerify', 'exportReport'])
      expect(callers(`bridge.${channel}(`), channel).toEqual([
        `${STORE_ROOT}/audit.ts`,
      ]);
    for (const channel of ['auditVerify', 'exportReport'])
      expect(
        codeOf(archRead(`${STORE_ROOT}/audit.ts`)).split(`bridge.${channel}(`),
        channel,
      ).toHaveLength(2);
  });

  /* ── row 10: the keymap still holds, and prettier still leaves it ──── */

  /**
   * Sc10's trap, re-checked because it costs one row. `prettier --write`
   * once unquoted the screen names in a record literal, which silently
   * broke the arch row that proves every `SCREENS` member is reachable.
   * The pair form survived that; this asserts it is still the pair form,
   * and that this scenario's screen really is the one ⌘5 opens.
   */
  it('every screen is reachable by a quoted pair, audit on Digit5', () => {
    const keys = archRead(`${RENDERER}/keys/screens.ts`);
    const screens = [
      ...(/SCREENS\s*=\s*\[([^\]]*)\]/.exec(
        archRead(`${RENDERER}/router.ts`),
      )?.[1] ?? ''),
    ]
      .join('')
      .match(/'([^']+)'/g);
    expect(screens).not.toBeNull();
    for (const quoted of screens ?? []) expect(keys).toContain(quoted);
    expect(keys).toContain("['audit', 'Digit5']");
    // The load-time collision check is still there: two screens on one
    // stroke would otherwise make the second silently unreachable.
    expect(keys).toContain('two screens claim one navigation stroke');
  });

  /* ── row 11: the app still schedules nothing ───────────────────────── */

  it('the desktop app still schedules nothing, five thousand rows included', () => {
    const timers = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(timers).toEqual(['apps/desktop/src/main/gateway.ts']);
    const delayed = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(debounce|throttle|requestIdleCallback|requestAnimationFrame)\b/i.test(
          codeOf(archRead(rel)),
        ),
      )
      .sort();
    expect(delayed).toEqual([]);
  });

  it('PLANTED: a virtualiser that windows on a frame callback is caught', () => {
    const rel = sc13Plant(
      `${AUDIT}/__s8_sc13_probe__/Window.ts`,
      [
        'export function onScroll(fn: () => void): void {',
        '  requestAnimationFrame(fn);',
        '}',
        '',
      ].join('\n'),
    );
    const code = codeOf(archRead(rel));
    expect(/\brequestAnimationFrame\b/.test(code)).toBe(true);
  });

  it('LEGITIMATE NEAR-MISS: windowing by slice schedules nothing', () => {
    const rel = sc13Plant(
      `${AUDIT}/__s8_sc13_probe__/Slice.ts`,
      [
        '/**',
        ' * The drawn window is a slice of a sorted array. It is recomputed',
        ' * when the filters change and at no other time, so there is nothing',
        ' * to schedule and nothing to cancel.',
        ' */',
        'export function drawn<T>(rows: readonly T[], page: number): readonly T[] {',
        '  return rows.slice(0, page);',
        '}',
        '',
      ].join('\n'),
    );
    const code = codeOf(archRead(rel));
    expect(/\b(setTimeout|setInterval)\(/.test(code)).toBe(false);
    expect(
      /\b(debounce|throttle|requestIdleCallback|requestAnimationFrame)\b/i.test(
        code,
      ),
    ).toBe(false);
  });
});

describe('S8 extensions (s8-execution Scenario 14: settings, the kill switch and the danger zone)', () => {
  const sc14Planted: string[] = [];
  function sc14Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc14Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc14Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/settings/__s8_sc14_probe__',
      'apps/desktop/src/renderer/screens/queue/__s8_sc14_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc14_probe__',
      'apps/desktop/src/renderer/store/__s8_sc14_probe__',
      'apps/desktop/src/preload/__s8_sc14_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const STORE_ROOT = `${RENDERER}/store`;
  const SETTINGS = `${RENDERER}/screens/settings`;
  const QUEUE = `${RENDERER}/screens/queue`;
  const AUDIT = `${RENDERER}/screens/audit`;
  const PEOPLE = `${RENDERER}/screens/people`;
  const SCHEMA = 'packages/daemon/src/settings/schema.ts';
  const GATE = 'packages/core/src/gate/index.ts';
  const TOGGLES = 'packages/daemon/src/routes/toggles.ts';

  /**
   * Every `export const SETTING_… = '…'` in core, as a map from the
   * identifier to the string it stands for.
   *
   * The schema names its keys by CONSTANT, never by literal (that is the
   * whole point of the constants), so a row that scraped `schema.ts` for
   * quoted strings would find the five refusal names and none of the keys.
   * `\s*` spans newlines on purpose: prettier has already wrapped one of
   * these declarations onto a second line, and a line-anchored scan would
   * have silently lost `send.circuitFailureWindowMin`.
   */
  function settingConstants(): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const rel of archFiles('packages/core/src'))
      for (const m of archRead(rel).matchAll(
        /export const (SETTING_[A-Z0-9_]+)\s*=\s*'([^']+)'/g,
      ))
        out.set(m[1] as string, m[2] as string);
    return out;
  }

  /** The schema's entries, in source order: `[literal key, readOnly]`. */
  function schemaEntries(): Array<readonly [string, boolean]> {
    const consts = settingConstants();
    const text = codeOf(archRead(SCHEMA));
    const specs = /const SPECS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
    expect(specs, 'the SPECS array is still an array literal').not.toBeNull();
    const out: Array<readonly [string, boolean]> = [];
    for (const block of (specs?.[1] ?? '').split(/\n  \{/)) {
      const key = /\bkey:\s*(SETTING_[A-Z0-9_]+)/.exec(block);
      if (key === null) continue;
      const literal = consts.get(key[1] as string);
      expect(literal, `${key[1] as string} resolves to a literal`).toBeTypeOf(
        'string',
      );
      out.push([literal as string, /\breadOnly:\s*true/.test(block)]);
    }
    return out;
  }

  /** The single-quoted members of a named `const X = [ … ] as const`. */
  function quotedArray(rel: string, name: string): string[] {
    const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(archRead(rel));
    if (m === null) return [];
    return [...(m[1] as string).matchAll(/'([^']+)'/g)].map(
      (x) => x[1] as string,
    );
  }

  /* ── row 1: the screen's key list IS the daemon's, at both ends ────── */

  /**
   * The settings screen is the first surface in this GUI that has to be
   * TOTAL over a list somebody else owns. Every other screen renders rows
   * the daemon happens to have; this one renders a fixed form, and a form
   * that is missing a key is a knob an operator cannot reach while the
   * daemon goes on enforcing it.
   *
   * INV-1 is why this is a row and not an import: the renderer has no
   * `@wemessage/core` dependency and cannot reach `packages/daemon` at all,
   * so `derive/settingsFields.ts` re-declares the list — the same deliberate
   * second projection as `derive/auditRows.ts`'s twelve deny reasons (Sc13
   * row 3), and tied back the same way, so the two cannot drift.
   *
   * The plan's §1.1 list is STALE and this row is what proves it: it names
   * `send.circuitTripThreshold`, `send.circuitOpen` and `arming.globalMode`,
   * none of which exist, and claims five writable and five read-only against
   * a tree that has eleven and four.
   */
  it('the renderer re-declares the daemon settings list exactly', () => {
    const entries = schemaEntries();
    const writable = entries
      .filter(([, ro]) => !ro)
      .map(([k]) => k)
      .sort();
    const readOnly = entries
      .filter(([, ro]) => ro)
      .map(([k]) => k)
      .sort();
    // Non-vacuous, and the count the plan is wrong about.
    expect(entries).toHaveLength(15);
    expect(writable).toHaveLength(11);
    expect(readOnly).toHaveLength(4);
    const FIELDS = `${RENDERER}/derive/settingsFields.ts`;
    expect([...quotedArray(FIELDS, 'WRITABLE_KEYS')].sort()).toEqual(writable);
    expect([...quotedArray(FIELDS, 'READ_ONLY_KEYS')].sort()).toEqual(readOnly);
  });

  /**
   * The four read-only keys each name the ROUTE that owns them, and a
   * settings screen that offered to PATCH one would be offering a write the
   * daemon refuses in fourth place (`unknown-key` → `read-only-key` → …).
   *
   * `arming.pauseUntil` is the one worth naming out loud: a "pause until"
   * field is the most natural thing in the world to put on a settings form,
   * and it is exactly the key whose refusal points somewhere else. Both the
   * verb and the path are checked against the route file AND the ratcheted
   * transport surface, because the plan has been wrong about its own routes,
   * verbs and status codes in four consecutive scenarios.
   */
  it('every read-only key points at a route that really exists', () => {
    const consts = settingConstants();
    const text = codeOf(archRead(SCHEMA));
    const uses = new Map<string, string>();
    for (const block of text.split(/\n  \{/)) {
      const key = /\bkey:\s*(SETTING_[A-Z0-9_]+)/.exec(block);
      const use = /\buse:\s*'([^']+)'/.exec(block);
      if (key === null || use === null) continue;
      uses.set(consts.get(key[1] as string) ?? '', use[1] as string);
    }
    expect([...uses.keys()].sort()).toEqual([
      'arming.pauseUntil',
      'send.circuitOpenedAt',
      'send.globalMode',
      'send.killSwitch',
    ]);
    expect(uses.get('arming.pauseUntil')).toBe('POST /v1/toggles/pause');
    const toggles = codeOf(archRead(TOGGLES));
    for (const use of uses.values()) {
      // The `use` string may carry an example body after the path.
      const [verb, path] = use.split(' ') as [string, string];
      expect(ROUTE_TABLE, use).toContain(`${verb} ${path}`);
      expect(toggles, use).toMatch(
        new RegExp(`app\\s*\\.\\s*${verb.toLowerCase()}\\s*\\(\\s*'${path}'`),
      );
    }
  });

  /* ── row 2: the write channels the screen may and may not reach ────── */

  /**
   * The partition row above (Sc10) says the settings binding declares its
   * own reach. This says what that reach may NOT contain, by name, over the
   * whole renderer — which is the half a `Pick` cannot state.
   *
   * `pause` and `resume` are the load-bearing absences. `arming.pauseUntil`
   * is read-only precisely because `POST /v1/toggles/pause` does more than
   * move a string (it re-sweeps the arming posture), and a settings screen
   * that acquired either channel would be a second owner of the hold with no
   * horizon of its own to publish. `adapterUpdate` and `contactDelete` are
   * real channels this GUI has decided not to offer.
   *
   * s8 Sc15, deliberate amendment: `sendTest` was in the absent list below
   * because nothing called it. The wizard now does, through its own binding
   * and through one call site, so the claim is STRENGTHENED rather than
   * loosened — an exact owner instead of an emptiness that would have gone
   * on being true if the settings screen had grown a send.
   */
  it('the settings screen writes through five channels and no others', () => {
    const callers = (needle: string): string[] =>
      archFiles(RENDERER)
        .filter((rel) => codeOf(archRead(rel)).includes(needle))
        .sort();
    for (const channel of [
      'adapterRotate',
      'connect',
      'disconnect',
      'globalMode',
      'killSwitch',
      'settingsWrite',
    ]) {
      expect(callers(`bridge.${channel}(`), channel).toEqual([
        `${STORE_ROOT}/settings.ts`,
      ]);
      expect(
        codeOf(archRead(`${STORE_ROOT}/settings.ts`)).split(
          `bridge.${channel}(`,
        ),
        channel,
      ).toHaveLength(2);
    }
    for (const absent of [
      'pause',
      'resume',
      'adapterUpdate',
      'contactDelete',
      'ruleDelete',
    ])
      expect(callers(`bridge.${absent}(`), absent).toEqual([]);
    // s8 Sc15: one owner, and it is not this screen.
    expect(callers('bridge.sendTest(')).toEqual([`${STORE_ROOT}/wizard.ts`]);
  });

  /* ── row 3: a minted adapter token cannot reach a Chromium process ─── */

  /**
   * Sc4 banned five credential SHAPES from the renderer and the preload and
   * Sc13 proved no `wm_` prefix reaches the desktop app at all. Neither of
   * them could say anything about the channel that MINTS one, because
   * nothing called it yet. This scenario calls it, so the claim has to
   * become structural.
   *
   * The decision, argued rather than assumed: **the plaintext token never
   * crosses the bridge.** `main` calls `rotateAdapterToken`, writes the
   * secret to the system clipboard from the process that already holds the
   * daemon's bearer, and answers the renderer with a RECEIPT — the adapter
   * row, the environment variable the operator must set, and the command to
   * run WITHOUT the credential in it. The sandboxed renderer is the least
   * trusted process in this app and the clipboard is where the operator
   * needs the value anyway, so handing it through a Chromium process buys
   * nothing and costs the DOM, two web storages, the performance timeline
   * and every string-valued window property as places it could persist.
   *
   * `connectCmd` is refused outright and does not reach the screen in any
   * form. The daemon builds it as `--token <plaintext>` — argv, which is
   * world-readable through `ps` — and `packages/adapter-testkit/src/spawn.ts`
   * documents the opposite convention for the same credential ("the token
   * travels by environment, never by argv"). The CLI already elides it
   * before printing. A GUI that offered a COPY button for that string would
   * be teaching the operator the unsafe carriage, so the receipt names the
   * variable instead.
   */
  const MINTING = /\bconnectCmd\b|\brotateAdapterToken\b/;

  /**
   * SELF-TRIP, recorded rather than papered over. This row was first written
   * with `clipboard` in the MINTING alternation, and it was factually wrong
   * about the product: `main.tsx` already writes to `navigator.clipboard`,
   * because Sc13's audit drawer copies a row's stored JSON. That is a
   * legitimate copy of bytes that are on screen already and has nothing to
   * do with a credential.
   *
   * Strengthened rather than loosened, because the property that actually
   * matters is not "who says the word clipboard" but "can one process both
   * WRITE a clipboard and HOLD a token". So the row splits: the minting
   * vocabulary is banned from the renderer entirely, and the renderer's
   * clipboard writers are ENUMERATED — one file, the audit copy — so the
   * settings screen structurally cannot acquire one. A sixth screen that
   * gained a copy affordance would fail here and have to say why.
   */
  it('token material is named in main only, and in exactly one file', () => {
    const named = archFiles('apps/desktop/src')
      .filter((rel) => MINTING.test(codeOf(archRead(rel))))
      .sort();
    expect(named).toEqual(['apps/desktop/src/main/gateway.ts']);
    // Non-vacuous: both names are real, and the CLI spells them where it
    // renders the one block in this product that shows a plaintext token.
    expect(MINTING.test(codeOf(archRead('packages/cli/src/adapters.ts')))).toBe(
      true,
    );
    // The renderer's clipboard writers, enumerated. `main/gateway.ts` is the
    // only file that may hold Electron's own `clipboard`, and it is the only
    // file that ever holds a minted token — so the two capabilities meet in
    // the process that already has the daemon's bearer, and nowhere else.
    const rendererCopies = archFiles(RENDERER)
      .filter((rel) =>
        /\bnavigator\s*\.\s*clipboard\b/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(rendererCopies).toEqual([`${RENDERER}/main.tsx`]);
    const mainCopies = archFiles('apps/desktop/src/main')
      .filter((rel) => /\bclipboard\b/.test(codeOf(archRead(rel))))
      .sort();
    expect(mainCopies).toEqual(['apps/desktop/src/main/gateway.ts']);
  });

  it('PLANTED: a settings pane that copies to the clipboard itself is caught', () => {
    const rel = sc14Plant(
      `${SETTINGS}/__s8_sc14_probe__/Copy.tsx`,
      [
        'export function Copy(props: { text: string }): unknown {',
        '  return (',
        '    <button onClick={() => navigator.clipboard.writeText(props.text)}>',
        '      COPY',
        '    </button>',
        '  );',
        '}',
        '',
      ].join('\n'),
    );
    const rendererCopies = archFiles(RENDERER).filter((r) =>
      /\bnavigator\s*\.\s*clipboard\b/.test(codeOf(archRead(r))),
    );
    expect(rendererCopies).toContain(rel);
  });

  it('PLANTED: a settings pane that renders the connect command is caught', () => {
    const rel = sc14Plant(
      `${SETTINGS}/__s8_sc14_probe__/Cmd.tsx`,
      [
        'export function Cmd(props: { connectCmd: string }): unknown {',
        '  return <code>{props.connectCmd}</code>;',
        '}',
        '',
      ].join('\n'),
    );
    const named = archFiles('apps/desktop/src').filter((r) =>
      MINTING.test(codeOf(archRead(r))),
    );
    expect(named).toContain(rel);
  });

  it('LEGITIMATE NEAR-MISS: rendering hasToken is not holding a token', () => {
    const rel = sc14Plant(
      `${SETTINGS}/__s8_sc14_probe__/Token.tsx`,
      [
        '/**',
        ' * Whether the daemon holds a hash for this adapter. A boolean is the',
        ' * whole read surface: there is no route that returns stored token',
        ' * material, only one that replaces it.',
        ' */',
        'export function Cell(props: { hasToken: boolean }): unknown {',
        "  return <span>{props.hasToken ? 'SET' : 'NONE'}</span>;",
        '}',
        '',
      ].join('\n'),
    );
    expect(MINTING.test(codeOf(archRead(rel)))).toBe(false);
  });

  /* ── row 4: the danger zone cannot brick the daemon, or the log ────── */

  /**
   * `POST /v1/disconnect` takes `{purge?: boolean}`, and `purge` deletes the
   * whole config directory — the database with the audit log in it — after
   * which `server.ts` latches and answers 503 to everything for the rest of
   * the process's life. There is no in-app route back from that: the window
   * would be looking at a daemon that cannot answer, forever.
   *
   * That is a CONTRADICTION with this scenario's brief rather than a feature
   * to build. Sc13 pinned that no audit-mutating route exists, at the source
   * and at the transport surface; purge is not an audit-mutating route (it
   * removes the file the log lives in, which is a different act), so that
   * pin still holds — but a GUI button that reaches it would destroy the
   * evidence this product's whole design is arranged around, from a screen
   * whose own confirm could not tell the operator how to undo it.
   *
   * So the GUI never offers purge, this row says so structurally, and the
   * confirm's copy says so in words. `DISCONNECT` with no body is the act
   * the danger zone offers: it stops the watcher, revokes every adapter
   * token, rotates the daemon's own, and leaves the config directory alone.
   */
  it('no settings file offers a purge, and the route it would call is real', () => {
    const offenders = archFiles(SETTINGS)
      .filter((rel) => /\bpurge\b/i.test(codeOf(archRead(rel))))
      .sort();
    expect(offenders).toEqual([]);
    // Non-vacuous twice: the word is real in the daemon, and the two routes
    // the danger zone DOES reach are on the ratcheted surface.
    expect(
      /\bpurge\b/i.test(
        codeOf(archRead('packages/daemon/src/routes/connection.ts')),
      ),
    ).toBe(true);
    expect(ROUTE_TABLE).toContain('POST /v1/disconnect');
    expect(ROUTE_TABLE).toContain('POST /v1/connect');
  });

  it('PLANTED: a PURGE EVERYTHING button in the danger zone is caught', () => {
    const rel = sc14Plant(
      `${SETTINGS}/__s8_sc14_probe__/Purge.tsx`,
      [
        'export function Purge(props: { go: () => void }): unknown {',
        '  return <button onClick={props.go}>PURGE EVERYTHING</button>;',
        '}',
        '',
      ].join('\n'),
    );
    const offenders = archFiles(SETTINGS).filter((r) =>
      /\bpurge\b/i.test(codeOf(archRead(r))),
    );
    expect(offenders).toEqual([rel]);
  });

  /* ── row 5: the kill switch is a DENY and the source still says so ─── */

  /**
   * The distinction this scenario exists to keep visible: a DENY binds
   * everyone including the operator, a CLAMP binds only autonomy. The kill
   * switch is the first deny in `evaluateGate` — before the mode narrowing
   * and before the whole else-if clamp chain — so it refuses a HUMAN
   * approval, not merely an automatic one.
   *
   * Asserted as an ORDER in the gate's source, because that is what makes it
   * true: a kill-switch check moved below the clamp chain would still deny
   * something, and would deny only the traffic that was already going to be
   * narrowed. `clampedBy` is the marker the clamp branches carry (Sc3), so
   * the first mention of the switch preceding the first mention of that
   * marker is the claim, stated where it can break.
   */
  it('the kill switch is evaluated before anything that clamps', () => {
    const gate = codeOf(archRead(GATE));
    const deny = gate.indexOf("'kill-switch'");
    const clamp = gate.indexOf('clampedBy');
    expect(deny).toBeGreaterThan(-1);
    expect(clamp).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(clamp);
  });

  /* ── row 6: controls, per screen, for the sixth root ───────────────── */

  const INTERACTIVE: readonly (readonly [string, RegExp])[] = [
    ['<button', /<button\b/],
    ['<a href', /<a\s[^>]*\bhref\b/],
    ['<input', /<input\b/],
    ['<select', /<select\b/],
    ['onClick', /\bonClick\s*=/],
    ['tabIndex', /\btabIndex\s*=/],
  ];

  function controlsIn(root: string): string[] {
    const out: string[] = [];
    for (const rel of archFiles(root)) {
      const code = codeOf(archRead(rel));
      for (const [name, re] of INTERACTIVE)
        if (re.test(code)) out.push(`${rel}: ${name}`);
    }
    return out.sort();
  }

  /**
   * Sixth root, same shape Sc11, Sc12 and Sc13 each kept: separate
   * expressions over separate roots in ONE row, so widening the settings
   * line structurally cannot reach the queue line.
   *
   * This screen has more controls than any other in the app and is still
   * not allowed `<a href` — `x-apple.systempreferences:` is opened by MAIN
   * from a closed allowlist keyed by a NAME (`main/policy.ts`), and an
   * anchor whose href the renderer chose would be `shell.openExternal` with
   * the guard removed.
   */
  it('the settings screen has real controls; the queue still has none', () => {
    const settings = controlsIn(SETTINGS);
    expect(settings.some((c) => c.endsWith(': <button'))).toBe(true);
    expect(settings.some((c) => c.endsWith(': <input'))).toBe(true);
    expect(settings.filter((c) => c.endsWith(': <a href'))).toEqual([]);
    expect(settings.filter((c) => c.endsWith(': tabIndex'))).toEqual([]);
    expect(controlsIn(QUEUE)).toEqual([]);
    expect(controlsIn(AUDIT).some((c) => c.endsWith(': <button'))).toBe(true);
  });

  /* ── row 7: locality, with confirms and a reveal in the tree ───────── */

  /**
   * A settings screen with two typed confirmations and a credential reveal
   * wants a dialog per surface. It gets none: `TypedConfirm.tsx` still owns
   * `role="dialog"` for the whole renderer, and the rotate reveal is an
   * inline disclosure panel rather than a modal — Sc13's non-modal drawer
   * precedent, for the same reason. A second modal is a second focus trap
   * and a second Escape handler, and this screen already has the one that
   * cancels a disconnect.
   */
  it('the owned markup still lives in exactly one file each', () => {
    const withCode = (re: RegExp): string[] =>
      archFiles(RENDERER)
        .filter((rel) => re.test(codeOf(archRead(rel))))
        .sort();
    expect(withCode(/<textarea\b/)).toEqual([
      `${RENDERER}/components/Editor.tsx`,
    ]);
    expect(withCode(/role="dialog"/)).toEqual([
      `${RENDERER}/components/TypedConfirm.tsx`,
    ]);
    expect(withCode(/<a\s[^>]*\bhref\b/)).toEqual([]);
    for (const role of ['grid', 'row', 'columnheader', 'gridcell'])
      expect(withCode(new RegExp(`role="${role}"`)), role).toEqual([
        `${PEOPLE}/Grid.tsx`,
      ]);
  });

  /* ── row 8: a horizon on screen, and still no clock and no timer ───── */

  /**
   * "PAUSED UNTIL 14:30" is the most timer-shaped string in the product,
   * and a countdown beside it would be the app's second `setInterval`. Sc11
   * refused a live clock outright and argued it on the record; this screen
   * keeps that refusal with the horizon actually on screen. The instant is
   * read once in `main.tsx` and handed down, the horizon is formatted from
   * the daemon's own `until`, and it moves when the operator asks and at no
   * other time.
   */
  const CLOCK_READ = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/;

  it('no file under screens/ or derive/ reads a clock, horizons included', () => {
    for (const root of [`${RENDERER}/screens`, `${RENDERER}/derive`]) {
      const offenders = archFiles(root)
        .filter((rel) => CLOCK_READ.test(codeOf(archRead(rel))))
        .sort();
      expect(offenders, root).toEqual([]);
    }
  });

  it('the desktop app still schedules nothing, a pause horizon included', () => {
    const timers = archFiles('apps/desktop/src')
      .filter((rel) =>
        /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(rel))),
      )
      .sort();
    expect(timers).toEqual(['apps/desktop/src/main/gateway.ts']);
  });

  it('PLANTED: a paused-until countdown is caught', () => {
    const rel = sc14Plant(
      `${SETTINGS}/__s8_sc14_probe__/Countdown.ts`,
      [
        'export function tick(fn: () => void): void {',
        '  setInterval(fn, 1000);',
        '}',
        '',
      ].join('\n'),
    );
    const timers = archFiles('apps/desktop/src').filter((r) =>
      /\b(setTimeout|setInterval)\(/.test(codeOf(archRead(r))),
    );
    expect(timers).toContain(rel);
  });

  /* ── row 9: INV-2 at the sixth screen, and the loudest one ─────────── */

  /**
   * Every other screen's INV-2 row is about a surface that could plausibly
   * approve something. This one is about a surface that changes the RULES
   * approval is judged by — the caps, the breaker, the global mode, the
   * switch itself — and the failure mode is not "the screen approved a
   * draft" but "turning the switch off replayed what it had halted".
   *
   * The daemon says it does not, in as many words (`routes/toggles.ts`:
   * resume means new work may flow again, not replay whatever was just
   * halted), and the e2e proves it at the wire. Here: the binding may not
   * name the approval vocabulary as identifiers, and no file under the
   * screen may reach the bridge at all.
   */
  it('the settings binding names no approval, and the screen names no bridge', () => {
    const binding = codeOf(archRead(`${STORE_ROOT}/settings.ts`));
    for (const m of binding.matchAll(/[A-Za-z_$][\w$]*/g))
      expect(m[0], `${m[0]} in the settings binding`).not.toMatch(
        /^(approve|approval|draftId|dispatch)$/i,
      );
    for (const rel of archFiles(SETTINGS)) {
      const code = codeOf(archRead(rel));
      expect(/\bwindow\s*\.\s*wm\b/.test(code), `${rel} names window.wm`).toBe(
        false,
      );
      expect(
        /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/.test(code),
        `${rel} names a bridge member`,
      ).toBe(false);
    }
  });

  /* ── row 10: the sixth screen is finally reachable ─────────────────── */

  it('every screen is reachable by a quoted pair, settings on Digit6', () => {
    const keys = archRead(`${RENDERER}/keys/screens.ts`);
    const screens = [
      ...(/SCREENS\s*=\s*\[([^\]]*)\]/.exec(
        archRead(`${RENDERER}/router.ts`),
      )?.[1] ?? ''),
    ]
      .join('')
      .match(/'([^']+)'/g);
    expect(screens).not.toBeNull();
    for (const quoted of screens ?? []) expect(keys).toContain(quoted);
    expect(keys).toContain("['settings', 'Digit6']");
    expect(keys).toContain('two screens claim one navigation stroke');
    // Every screen now has a surface: the inert branch is gone.
    const main = codeOf(archRead(`${RENDERER}/main.tsx`));
    const mounted = /MOUNTED[^=]*=\s*new Set<Screen>\(\[([^\]]*)\]/.exec(main);
    expect(mounted).not.toBeNull();
    expect(
      [...(mounted?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    ).toEqual((screens ?? []).map((q) => q.slice(1, -1)).sort());
  });
});

describe('S8 extensions (s8-execution Scenario 15: the onboarding wizard and every exit state)', () => {
  const sc15Planted: string[] = [];
  function sc15Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc15Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc15Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    for (const dir of [
      'apps/desktop/src/renderer/screens/wizard/__s8_sc15_probe__',
      'apps/desktop/src/renderer/screens/queue/__s8_sc15_probe__',
      'apps/desktop/src/renderer/derive/__s8_sc15_probe__',
      'apps/desktop/src/renderer/store/__s8_sc15_probe__',
    ])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });

  const RENDERER = 'apps/desktop/src/renderer';
  const STORE_ROOT = `${RENDERER}/store`;
  const WIZARD = `${RENDERER}/screens/wizard`;
  const QUEUE = `${RENDERER}/screens/queue`;
  const EXITS = `${RENDERER}/derive/wizardExits.ts`;
  const POLICY = 'apps/desktop/src/main/policy.ts';
  const GATEWAY = 'apps/desktop/src/main/gateway.ts';
  const CHANNELS = 'apps/desktop/src/main/ipc-channels.ts';
  const CLIENT = 'packages/client/src/index.ts';
  const CORE_TYPES = 'packages/core/src/domain/types.ts';
  const DAEMON_DOCTOR = 'packages/daemon/src/doctor.ts';
  const SEND_ROUTE = 'packages/daemon/src/routes/send.ts';

  /** Every quoted string inside the first `[ … ]` after `name`. */
  function quotedArray(text: string, name: string): string[] {
    const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    if (m === null) return [];
    return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
  }

  /** Every quoted string in the union that `export type <name> =` opens. */
  function unionMembers(text: string, name: string): string[] {
    const m = new RegExp(`export type ${name}\\s*=([\\s\\S]*?);`).exec(text);
    if (m === null) return [];
    return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
  }

  /** The quoted keys of the `WIZARD_EXIT_SPEC` object literal. */
  function exitKeys(): string[] {
    const m = /WIZARD_EXIT_SPEC[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
      archRead(EXITS),
    );
    return [...(m?.[1] ?? '').matchAll(/'((?:link|daemon):[^']*)'\s*:/g)]
      .map((x) => x[1] as string)
      .sort();
  }

  const callers = (needle: string): string[] =>
    archFiles(RENDERER)
      .filter((rel) => codeOf(archRead(rel)).includes(needle))
      .sort();

  /* ── row 1: the exit vocabulary is two other people's unions ───────── */

  /**
   * The one claim this scenario is built to support is that the wizard
   * cannot render a reassuring screen for a state nobody enumerated. That
   * is only true if the enumeration is not the wizard's own.
   *
   * `WizardExit` is `link:${DownReason} | daemon:${ConnectionState}`, so
   * `Readonly<Record<WizardExit, ExitSpec>>` rejects a missing key AND (by
   * TypeScript's excess-property check on an object literal) an extra one.
   * The compiler is the real guard; this row is its runtime shadow, and it
   * exists because the compiler cannot tell you that the union you are
   * total over is the union the DAEMON actually ships.
   *
   * So the cross-check runs the whole way down: the desktop's link reasons,
   * the client's `ConnectionState`, core's `ConnectionState`, and the
   * daemon's own runtime narrowing in `doctor.ts` — four spellings that
   * INV-1 keeps deliberately separate — all have to agree before the eight
   * exits are allowed to be these eight.
   */
  it('the eight exits are exactly the link reasons crossed with the daemon’s states', () => {
    const reasons = quotedArray(archRead(POLICY), 'DOWN_REASONS');
    expect(reasons).toEqual([
      'no-token',
      'token-rejected',
      'unreachable',
      'stream-refused',
    ]);
    // The S8 plan names a reason called `auth`. There is no such thing.
    expect(reasons).not.toContain('auth');

    const fromClient = unionMembers(archRead(CLIENT), 'ConnectionState');
    const fromCore = unionMembers(archRead(CORE_TYPES), 'ConnectionState');
    expect(fromClient).toEqual(fromCore);
    expect([...fromClient].sort()).toEqual([
      'disconnected',
      'fully-connected',
      'read-only',
      'unsupported',
    ]);
    // `connected` is the word the plan uses. The daemon has never said it.
    expect(fromClient).not.toContain('connected');

    // And the daemon narrows the wire to exactly those four.
    //
    // Anchored on the DEFINITION, not on the name. The first mention of
    // `isConnectionState` in this file is a CALL, twenty lines above the
    // function, and a non-greedy sweep from there to the next `}` captures
    // the caller's block — which of course spells none of the four states.
    // A row that read a body the guard does not live in would have gone
    // green the day somebody deleted a member from it.
    const narrowing = codeOf(archRead(DAEMON_DOCTOR));
    const guard = /function isConnectionState\([\s\S]*?\n\}/.exec(narrowing);
    expect(guard).not.toBeNull();
    // Non-vacuity: the captured body is the four-way `||`, not a stub.
    expect(guard?.[0]).toContain('value is ConnectionState');
    for (const state of fromCore)
      expect(guard?.[0], `doctor narrows ${state}`).toContain(`'${state}'`);
    // And nothing else: a fifth `'…'` in that body would be a state the
    // daemon accepts off the wire that the exit vocabulary has no row for.
    expect((guard?.[0].match(/'[a-z-]+'/g) ?? []).sort()).toEqual(
      [...fromCore].map((s) => `'${s}'`).sort(),
    );

    expect(exitKeys()).toEqual(
      [
        ...reasons.map((r) => `link:${r}`),
        ...fromClient.map((s) => `daemon:${s}`),
      ].sort(),
    );
  });

  /* ── row 2: the wizard spells no exit of its own ───────────────────── */

  /**
   * A totality that only holds in one file is a totality one `if` away from
   * a hole. The screens read `WIZARD_EXITS` / `exitFor` / `exitView` and
   * never a literal, so a step that wanted to special-case an exit would
   * have to say so where the compiler is watching.
   *
   * `codeOf` strips comments, which is the point: the derive module's prose
   * names these strings constantly, and prose is not a second vocabulary.
   */
  it('only the derive module spells an exit literal', () => {
    const owners = archFiles(RENDERER).filter((rel) =>
      /'(?:link|daemon):[^']*'/.test(codeOf(archRead(rel))),
    );
    expect(owners).toEqual([EXITS]);
    // Non-vacuous: there really are literals in there to find.
    expect(exitKeys()).toHaveLength(8);
  });

  it('PLANTED: a wizard step that special-cases one exit is caught', () => {
    const rel = sc15Plant(
      `${WIZARD}/__s8_sc15_probe__/Special.tsx`,
      [
        'export const friendly = (exit: string): boolean =>',
        "  exit === 'link:unreachable';",
        '',
      ].join('\n'),
    );
    const owners = archFiles(RENDERER).filter((r) =>
      /'(?:link|daemon):[^']*'/.test(codeOf(archRead(r))),
    );
    expect(owners).toContain(rel);
  });

  it('LEGITIMATE NEAR-MISS: a comment naming an exit, over derived code, is clean', () => {
    const rel = sc15Plant(
      `${WIZARD}/__s8_sc15_probe__/Documented.tsx`,
      [
        '/**',
        " * Renders whatever `exitView` hands back. 'link:unreachable' and",
        " * 'daemon:read-only' look different only in the datum, never here.",
        ' */',
        'export const word = (view: { word: string }): string => view.word;',
        '',
      ].join('\n'),
    );
    expect(/'(?:link|daemon):[^']*'/.test(codeOf(archRead(rel)))).toBe(false);
    const owners = archFiles(RENDERER).filter((r) =>
      /'(?:link|daemon):[^']*'/.test(codeOf(archRead(r))),
    );
    expect(owners).toEqual([EXITS]);
  });

  /* ── row 3: readiness is the daemon's word, not the step counter ───── */

  /**
   * The failure this slice keeps catching, in its final and worst form: a
   * last screen that says READY because the operator got to it. Five steps
   * completed is a fact about the operator, not about the product.
   *
   * `ready` is a field of `ExitSpec`, exactly one exit carries it, and that
   * exit is minted only from a `DoctorReportPayload` the daemon returned.
   * So the sentence "you are ready" is structurally a quotation of the
   * daemon's `state`, and the row below forbids the wizard from computing
   * it any other way: nothing under `screens/wizard` may reach the step
   * list to decide it.
   */
  it('exactly one exit is ready, and the finish screen asks no one else', () => {
    const src = archRead(EXITS);
    const readies = [...src.matchAll(/ready:\s*true/g)];
    expect(readies).toHaveLength(1);
    const spec = /WIZARD_EXIT_SPEC[\s\S]*?\n\};/.exec(src)?.[0] ?? '';
    const readyBlock = /'daemon:fully-connected'\s*:\s*\{[\s\S]*?\}/.exec(spec);
    expect(readyBlock?.[0]).toContain('ready: true');

    // `readyToFinish` is the only readiness verb, and it reads the spec.
    const fn = /export function readyToFinish[\s\S]*?\n\}/.exec(src);
    expect(fn).not.toBeNull();
    expect(fn?.[0]).toContain('WIZARD_EXIT_SPEC');
    expect(fn?.[0]).not.toMatch(/WIZARD_STEPS|stepIndex|length/);

    // Every file that renders the readiness datum derives it from there.
    for (const rel of archFiles(WIZARD)) {
      const code = codeOf(archRead(rel));
      if (!code.includes('data-ready')) continue;
      expect(code, `${rel} renders data-ready`).toContain('readyToFinish');
    }
    expect(callers('readyToFinish(').length).toBeGreaterThan(0);
  });

  /* ── row 4: onboarding's send is THE send, or it is nothing ────────── */

  /**
   * INV-2 in the scenario most likely to break it. "Send yourself a test
   * message" is a proposal for a second send path unless it is the first
   * one, and the tree already decides which: the desktop's `sendTest` IPC
   * handler calls `client.send`, which POSTs `/v1/send`, which mints a
   * `Draft`, mints an `Approval` through `humanApiActor()`, appends both
   * audit rows and only then calls `dispatchApproved` — the one function
   * that owns the one `SendBackend.send` call site in the repo.
   *
   * So the answer is ROUTED, not refused, and this row states the chain
   * link by link. The GUI side is pinned too: one call site, in the
   * wizard's own binding, and no screen may reach the bridge at all.
   */
  it('the wizard’s send-test is the daemon’s approve-then-dispatch path', () => {
    // One caller in the renderer, and it is the wizard's binding.
    expect(callers('bridge.sendTest(')).toEqual([`${STORE_ROOT}/wizard.ts`]);
    expect(
      codeOf(archRead(`${STORE_ROOT}/wizard.ts`)).split('bridge.sendTest('),
    ).toHaveLength(2);
    // No screen, wizard included, reaches the bridge itself.
    for (const rel of archFiles(WIZARD)) {
      const code = codeOf(archRead(rel));
      expect(/\bwindow\s*\.\s*wm\b/.test(code), `${rel} names window.wm`).toBe(
        false,
      );
      expect(
        /\bbridge\s*\.\s*[A-Za-z_$][\w$]*/.test(code),
        `${rel} names a bridge member`,
      ).toBe(false);
    }

    // Main's handler reaches the client and nothing else.
    const handler = /sendTest:\s*async[\s\S]*?\n {4}\},/.exec(
      codeOf(archRead(GATEWAY)),
    );
    expect(handler).not.toBeNull();
    expect(handler?.[0]).toContain('.send(');
    expect(handler?.[0]).not.toMatch(/dispatch|SendBackend|approve/i);

    // The client's `send` is one POST, to the one route.
    //
    // Anchored on the member's own indentation and closed on its RESULT
    // type, because it is a one-expression arrow and not a block: there is
    // no `\n  },` to close on, and the shape this row first assumed matched
    // nothing at all. A `null` match is not a failure by itself — it made
    // `.toContain` throw on `undefined`, which is the only reason it was
    // caught — so the match is asserted before it is read.
    const client = codeOf(archRead(CLIENT));
    const send = /\n {4}send: \(input\)[\s\S]*?as Promise<SendResult>,/.exec(
      client,
    );
    expect(send).not.toBeNull();
    expect(send?.[0]).toContain("'/v1/send'");
    expect(send?.[0]).toContain('post(');
    // And that member is the only place in the client that names the route,
    // so there is no second spelling of it for a caller to reach.
    expect(client.match(/'\/v1\/send'/g) ?? []).toHaveLength(1);

    // And that route is the sanctioned path, in full.
    const route = codeOf(archRead(SEND_ROUTE));
    for (const needle of [
      'humanApiActor',
      'dispatchApproved',
      "type: 'draft.created'",
      "type: 'draft.approved'",
    ])
      expect(route, `send route names ${needle}`).toContain(needle);
    // Log before broadcast, both times (§1.8).
    const appends = [...route.matchAll(/\bappend\b|\bbroadcast\b/g)].map(
      (m) => m[0],
    );
    expect(appends.slice(0, 4)).toEqual([
      'append',
      'broadcast',
      'append',
      'broadcast',
    ]);
  });

  /* ── row 5: main chooses the body, so the renderer cannot ──────────── */

  /**
   * The IPC guard is only worth writing if it constrains something the
   * renderer could otherwise choose. A handler that refuses a bad `to` and
   * accepts any `body` is a general-purpose send with a recipient filter.
   *
   * So main mints the code, keeps it, and compares both fields; the arm
   * channel is one-shot; and the arm channel is NOT named for a send —
   * `wizardArm`, not `armSend` — because Sc1's `/send/i` sweep over the
   * store is an equality and an allowlisted second name would dissolve it.
   */
  it('the send-test handler pins both the recipient and the body', () => {
    const gw = codeOf(archRead(GATEWAY));
    const handler = /sendTest:\s*async[\s\S]*?\n {4}\},/.exec(gw)?.[0] ?? '';
    expect(handler).toContain('wizard-only');
    // Both fields, and the code comes from main's own state.
    expect(handler).toMatch(/\bto\s*!==\s*sendTest/);
    expect(handler).toMatch(/\bbody\s*!==\s*sendTest/);
    // One-shot: the armed pair is cleared as the send goes out.
    expect(handler).toMatch(/sendTestTarget\s*=\s*null/);

    // Arming is an IPC request, not a method on the interface: the dead
    // `armSendTest` export Sc4 left behind is gone.
    expect(gw).not.toContain('armSendTest');
    expect(archRead(CHANNELS)).toContain("wizardArm: 'wm:wizard.arm'");
    // ...and it is not spelled with a send in it.
    expect(/send/i.test('wizardArm')).toBe(false);

    // The four-hex code is minted in main, from main's randomness.
    const arm = /wizardArm:\s*async[\s\S]*?\n {4}\},/.exec(gw)?.[0] ?? '';
    expect(arm).not.toBe('');
    expect(arm).toMatch(/randomBytes|randomUUID|getRandomValues/);
  });

  /* ── row 6: no timer, no listener, no clock ────────────────────────── */

  /**
   * A wizard wants three timers before breakfast: a spinner, a re-probe
   * poll and a backoff. It gets none.
   *
   * The app owns exactly one `setTimeout`, in `main/gateway.ts`, and
   * exactly one `addEventListener`, in `main.tsx`, and it listens for
   * `keydown`. That forecloses the poll (no timer) AND the obvious dodge
   * (a `focus` or `visibilitychange` listener that re-probes when the
   * operator comes back from System Settings). What is left is a gesture:
   * the operator grants in the pane the card opened, returns, and presses
   * RE-CHECK. The "checking" state is the promise being in flight, which
   * needs no clock at all.
   */
  it('the wizard mints no timer, no listener and reads no clock', () => {
    const roots = [...archFiles(WIZARD), `${STORE_ROOT}/wizard.ts`, EXITS];
    for (const rel of roots) {
      const code = codeOf(archRead(rel));
      for (const banned of [
        'setTimeout(',
        'setInterval(',
        'requestAnimationFrame(',
        'requestIdleCallback(',
      ])
        expect(code.includes(banned), `${rel} names ${banned}`).toBe(false);
      expect(
        /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(/.test(code),
        `${rel} reads the clock`,
      ).toBe(false);
      expect(/addEventListener\s*\(/.test(code), `${rel} adds a listener`).toBe(
        false,
      );
    }
    // Still exactly one timer and one listener, app-wide.
    const timers = archFiles('apps/desktop/src').filter((rel) =>
      /\bset(?:Timeout|Interval)\s*\(/.test(codeOf(archRead(rel))),
    );
    expect(timers).toEqual([GATEWAY]);
    const listeners = archFiles(RENDERER).filter((rel) =>
      /addEventListener\s*\(/.test(codeOf(archRead(rel))),
    );
    expect(listeners).toEqual([`${RENDERER}/main.tsx`]);
    // Non-vacuous: the in-flight state exists and is a datum.
    expect(
      archFiles(WIZARD).some((rel) => archRead(rel).includes('data-probing')),
    ).toBe(true);
  });

  /* ── row 7: the wizard is not a dialog and is not a screen ─────────── */

  /**
   * A wizard is the most dialog-shaped thing in the app, and it is not one.
   * It replaces the surface exactly as `#daemon-not-found` already did, so
   * `role="dialog"` stays in `components/TypedConfirm.tsx` — one focus trap
   * and one Escape handler in the whole renderer.
   *
   * It is not in the ⌘-digit table either, and cannot be: `SCREENS`,
   * `MOUNTED` and the keymap are total over `Screen` in both directions,
   * and a seventh entry would put the wizard in the sidebar, give it a
   * stroke that must not collide, and add a second tab stop to the surface
   * whose one-tab-stop claim Sc8's checkpoint rests on. It is reached by
   * the link going down, or by a button on the Permissions pane, and it is
   * left by finishing or skipping — a mode, not a destination.
   */
  it('the wizard owns no dialog, claims no stroke and is no screen', () => {
    const withCode = (re: RegExp): string[] =>
      archFiles(RENDERER)
        .filter((rel) => re.test(codeOf(archRead(rel))))
        .sort();
    expect(withCode(/role="dialog"/)).toEqual([
      `${RENDERER}/components/TypedConfirm.tsx`,
    ]);
    expect(withCode(/role="alertdialog"/)).toEqual([]);
    expect(withCode(/<textarea\b/)).toEqual([
      `${RENDERER}/components/Editor.tsx`,
    ]);
    expect(withCode(/<a\s[^>]*\bhref\b/)).toEqual([]);

    const router = archRead(`${RENDERER}/router.ts`);
    const screens = quotedArray(router, 'SCREENS');
    const steps = quotedArray(router, 'WIZARD_STEPS');
    expect(screens).not.toContain('wizard');
    for (const step of steps) expect(screens, step).not.toContain(step);
    const keys = archRead(`${RENDERER}/keys/screens.ts`);
    expect(keys).not.toContain('wizard');
    for (const step of steps) expect(keys, step).not.toContain(`'${step}'`);
    const mounted = /MOUNTED[^=]*=\s*new Set<Screen>\(\[([^\]]*)\]/.exec(
      codeOf(archRead(`${RENDERER}/main.tsx`)),
    );
    expect(
      [...(mounted?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
    ).toEqual([...screens].sort());
  });

  /* ── row 8: controls in the wizard, still none in the queue ────────── */

  it('the wizard has real controls; the queue still has none', () => {
    const controls = (root: string): string[] => {
      const out: string[] = [];
      for (const rel of archFiles(root)) {
        const code = codeOf(archRead(rel));
        for (const [name, re] of [
          ['<button', /<button\b/],
          ['<a href', /<a\s[^>]*\bhref\b/],
          ['<input', /<input\b/],
          ['tabIndex', /\btabIndex\s*=/],
        ] as const)
          if (re.test(code)) out.push(`${rel}: ${name}`);
      }
      return out.sort();
    };
    const wiz = controls(WIZARD);
    expect(wiz.some((c) => c.endsWith(': <button'))).toBe(true);
    expect(wiz.some((c) => c.endsWith(': <input'))).toBe(true);
    expect(wiz.filter((c) => c.endsWith(': <a href'))).toEqual([]);
    expect(wiz.filter((c) => c.endsWith(': tabIndex'))).toEqual([]);
    expect(controls(QUEUE)).toEqual([]);
  });

  /* ── row 9: it opens a pane by name, and navigates nowhere ─────────── */

  /**
   * macOS TCC is not grantable through any API. The wizard's remedy is
   * therefore instructions plus an offer to open the pane, and the offer
   * goes through main's closed allowlist keyed by a NAME — never a URL,
   * never a navigation, never `shell` from the renderer.
   *
   * The pane names the wizard can ask for are `CARD_PANE`'s values, which
   * is Sc14's map, which is the vocabulary this scenario was told not to
   * mint a second copy of.
   */
  it('the only escape hatch is a pane name main already allows', () => {
    const panes = Object.keys(
      Object.fromEntries(
        [
          ...(
            /SYSTEM_SETTINGS_PANES[^=]*=\s*\{([\s\S]*?)\n\}/.exec(
              archRead(POLICY),
            )?.[1] ?? ''
          ).matchAll(/^\s*([A-Za-z]+)\s*:/gm),
        ].map((m) => [m[1] as string, true]),
      ),
    ).sort();
    expect(panes).toEqual([
      'accessibility',
      'automation',
      'fullDisk',
      'notifications',
    ]);
    const cardPane = archRead(`${RENDERER}/derive/permissionCards.ts`);
    const offered = [
      ...(
        /CARD_PANE[^=]*=\s*\{([\s\S]*?)\n\}/.exec(cardPane)?.[1] ?? ''
      ).matchAll(/:\s*'([^']+)'/g),
    ].map((m) => m[1] as string);
    expect(offered.length).toBeGreaterThan(0);
    for (const p of offered) expect(panes, p).toContain(p);

    for (const rel of [...archFiles(WIZARD), `${STORE_ROOT}/wizard.ts`]) {
      const code = codeOf(archRead(rel));
      for (const banned of [
        'x-apple.systempreferences',
        'shell.',
        'window.open',
        'location.href',
        'http://',
        'https://',
      ])
        expect(code.includes(banned), `${rel} names ${banned}`).toBe(false);
    }
  });

  /* ── row 10: nothing about the wizard survives the wizard ──────────── */

  /**
   * Abandonment is an exit state. Quitting halfway and reopening must not
   * resume into a step whose premise has since changed — the operator may
   * have granted the permission, or revoked it, or moved the daemon.
   *
   * The decision is RESTART, and it is enforced by having nowhere to
   * resume from: the wizard's step lives in renderer memory, the binding
   * declares no persistence channel, and no file in the flow reaches
   * `localStorage`, `sessionStorage`, `indexedDB` or `settingsWrite`. A
   * wizard that wrote its progress into the daemon's settings table would
   * be a wizard that changed the product's behaviour by being opened.
   */
  it('the wizard persists nothing, anywhere', () => {
    for (const rel of [
      ...archFiles(WIZARD),
      `${STORE_ROOT}/wizard.ts`,
      EXITS,
    ]) {
      const code = codeOf(archRead(rel));
      for (const banned of [
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'settingsWrite',
        'writeFileSync',
        'app.getPath',
      ])
        expect(code.includes(banned), `${rel} names ${banned}`).toBe(false);
    }
    // Non-vacuous: the channel it is forbidden to reach is a real one that
    // another binding really does own.
    expect(archRead(CHANNELS)).toContain("settingsWrite: '");
    expect(
      codeOf(archRead(`${STORE_ROOT}/settings.ts`)).includes(
        'bridge.settingsWrite(',
      ),
    ).toBe(true);
  });

  /* ── row 11: the flow is total over the steps, in the type ─────────── */

  /**
   * The same shape Sc14 used for the settings list: a compile-time total
   * `Readonly<Record<K, …>>` over a union somebody else owns, so a sixth
   * `WizardStep` is a type error rather than a step that renders blank.
   */
  it('every step has a title and a check list, by type', () => {
    const src = archRead(EXITS);
    const steps = quotedArray(
      archRead(`${RENDERER}/router.ts`),
      'WIZARD_STEPS',
    );
    // Non-vacuity for the loop below, not a second opinion about the
    // contents: the authoritative list lives in S8 Sc1 row 9, which pins
    // every member and its position. What this needs is proof that the
    // reader found an array at all, because an empty `steps` would make
    // every `expect` in the loop pass without covering anything. Six since
    // s9 Sc7 added `keep-running`.
    expect(steps).toHaveLength(6);
    for (const record of ['STEP_TITLE', 'STEP_CHECKS']) {
      expect(src, record).toMatch(
        new RegExp(`${record}\\s*:\\s*Readonly<\\s*Record<\\s*WizardStep`),
      );
      const block =
        new RegExp(`${record}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(
          src,
        )?.[1] ?? '';
      // Key POSITION, not merely presence, and quoted-or-not. `prettier`
      // runs `quoteProps: "as-needed"` and strips the quotes from
      // `welcome` while leaving them on `full-disk`, so a row that demanded
      // the quoted spelling would be a row about the formatter. Anchoring
      // to the colon is the stronger claim anyway: the step has to be a
      // KEY of the record, not a word somewhere in a value.
      for (const step of steps)
        expect(block, `${record} covers ${step}`).toMatch(
          new RegExp(`(?:^|[\\s{,])'?${step}'?\\s*:`),
        );
    }
    expect(src).toMatch(
      /WIZARD_EXIT_SPEC\s*:\s*Readonly<\s*Record<\s*WizardExit/,
    );
    // The runtime list is derived, never written down twice.
    expect(src).toMatch(
      /WIZARD_EXITS[^=]*=\s*Object\.keys\(\s*WIZARD_EXIT_SPEC/,
    );
  });

  /* ── row 12: the public-repo sweep, over the new surface ───────────── */

  /**
   * A wizard is example paths and example handles from top to bottom, and
   * this repo is public. The global sweep already runs; this row states it
   * as a Sc15 claim over exactly the files this scenario adds, plus the
   * `/Users/` census, which S6 left at three and s9 Sc6 takes to four.
   */
  it('nothing the wizard shows an operator identifies one', () => {
    expect(publicRepoOffenders()).toEqual([]);
    const mine = [
      ...archFiles(WIZARD),
      `${STORE_ROOT}/wizard.ts`,
      EXITS,
      'apps/desktop/test/e2e/onboarding.e2e.spec.ts',
      'apps/desktop/test/unit/wizard-exits.spec.ts',
    ];
    for (const rel of mine) {
      const raw = archRead(rel);
      expect(raw.includes('/Users/'), `${rel} names a home path`).toBe(false);
      for (const phone of raw.match(/\+1\d{10}/g) ?? [])
        expect(phone.startsWith('+1555'), `${rel}: ${phone}`).toBe(true);
      for (const host of raw.match(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])
        expect(host.endsWith('example.com'), `${rel}: ${host}`).toBe(true);
    }
    // NAMING the homes beats counting them: a new one fails on the list and
    // says which file it was, where an integer would only say the number
    // moved.
    //
    // Three of the four are here, because `trackedTextFiles()` deliberately
    // excludes `test/arch.spec.ts` — the guard file is a home too, and it
    // has to be able to spell the shape it hunts for. Asserting a COUNT over
    // a list that structurally cannot contain that one was this scenario's
    // own row being wrong rather than the tree.
    const homes = trackedTextFiles().filter((rel) =>
      readFileSync(join(repoRoot, rel), 'utf8').includes('/Users/'),
    );
    expect(homes.sort()).toEqual([
      'apps/desktop/scripts/verify-bundle.sh',
      'packages/adapter-testkit/test/pack.spec.ts',
      'packages/cli/test/skill-dryrun.spec.ts',
    ]);
    // s9 Sc6 admits the FOURTH home, and admitting one by NAME ALONE would
    // be exactly the widening this census exists to prevent. So the entry
    // arrives with a condition attached. The bundle verifier hunts absolute
    // paths inside a shipped Mach-O, which means it has to be able to spell
    // one, and every `/Users/` in it must therefore sit inside a grep
    // pattern. An edit that later hard-codes a real home on a line of its
    // own still fails, and fails carrying the line that did it.
    for (const line of readFileSync(
      join(repoRoot, 'apps/desktop/scripts/verify-bundle.sh'),
      'utf8',
    ).split('\n'))
      if (line.includes('/Users/'))
        expect(line, 'verify-bundle.sh names a home outside a grep').toContain(
          'grep',
        );
    expect(readFileSync(join(repoRoot, 'test/arch.spec.ts'), 'utf8')).toContain(
      '/Users/',
    );
  });
});

describe('S8 extensions (s8-execution Scenario 16: the tray, PAUSE, deep links and the global shortcut)', () => {
  const sc16Planted: string[] = [];
  function sc16Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc16Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc16Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
    rmSync(join(repoRoot, 'apps/desktop/src/main/__s8_sc16_probe__'), {
      recursive: true,
      force: true,
    });
  });

  const MAIN = 'apps/desktop/src/main';
  const RENDERER16 = 'apps/desktop/src/renderer';
  const DESKTOP_SRC = 'apps/desktop/src';
  const DEEP_LINK = `${MAIN}/deep-link.ts`;
  const TRAY_MODEL = `${MAIN}/tray-model.ts`;
  const TRAY = `${MAIN}/tray.ts`;
  const GLYPHS = `${MAIN}/tray-glyphs.ts`;
  const SHORTCUT = `${MAIN}/shortcut.ts`;
  const INDEX16 = `${MAIN}/index.ts`;
  const ROUTER16 = `${RENDERER16}/router.ts`;
  const KILL_PANE = `${RENDERER16}/screens/settings/Kill.tsx`;
  const TOGGLES = 'packages/daemon/src/routes/toggles.ts';
  const GATE = 'packages/core/src/gate/index.ts';

  /** Every quoted string inside the first `[ … ]` after `name`. */
  const sc16Array = (text: string, name: string): string[] => {
    const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    if (m === null) return [];
    return [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
  };

  /** Files under a root whose CODE (comments stripped) contains `needle`. */
  const namers = (root: string, needle: string): string[] =>
    archFiles(root)
      .filter((rel) => codeOf(archRead(rel)).includes(needle))
      .sort();

  /* ── row 1: the host allowlist IS the router's screen set ──────────── */

  /**
   * A deep link's host is the one field an attacker fully controls, so the
   * set it is matched against has to be a closed list expressed as DATA and
   * it has to be the same list the app can actually navigate to.
   *
   * Two projections, deliberately. Main does not import the renderer (row 4)
   * — a main-process security decision that could be widened by editing a
   * renderer file is not a security decision — so `DEEP_LINK_HOSTS` is its
   * own array and this row is what keeps the two honest. The model is
   * Sc15's, whose union is cross-checked against four independently-spelled
   * upstream sources rather than trusted because it compiles.
   */
  it('the deep-link hosts are the router’s screens, spelled twice on purpose', () => {
    const hosts = sc16Array(archRead(DEEP_LINK), 'DEEP_LINK_HOSTS');
    const screens = sc16Array(archRead(ROUTER16), 'SCREENS');
    expect(screens.length).toBe(6);
    expect([...hosts].sort()).toEqual([...screens].sort());
    // `wizard` is a MODE, not a destination (Sc15), so no URL may name it.
    expect(hosts).not.toContain('wizard');
  });

  it('matches the host against the list and never against a literal', () => {
    // A chain of `if (host === 'queue')` is the shape that grows a seventh
    // branch nobody reviews. Each screen name appears exactly once in this
    // file, inside the array, and the match is a membership test.
    const code = codeOf(archRead(DEEP_LINK));
    for (const screen of sc16Array(archRead(ROUTER16), 'SCREENS')) {
      const hits = [...code.matchAll(new RegExp(`'${screen}'`, 'g'))].length;
      expect([screen, hits]).toEqual([screen, 1]);
    }
    expect(code).toMatch(/DEEP_LINK_HOSTS[\s\S]{0,120}includes\(/);
  });

  it('registers the protocol under the scheme the parser enforces', () => {
    const scheme = /DEEP_LINK_SCHEME\s*=\s*'([^']+)'/.exec(archRead(DEEP_LINK));
    expect(scheme?.[1]).toBe('wemessage');
    const boot = codeOf(archRead(INDEX16));
    expect(boot).toContain('setAsDefaultProtocolClient(DEEP_LINK_SCHEME)');
    // Not a second spelling of the word on the OS side of the handshake.
    expect(boot).not.toContain("setAsDefaultProtocolClient('");
  });

  /* ── row 2: the parser is pure, and provably ───────────────────────── */

  /**
   * The whole security argument for `parseDeepLink` is that it is a total
   * function from a string to a value. That argument dies the moment the
   * module can reach anything: a parser that can `fetch` is a parser that
   * can be talked into fetching.
   */
  it('the parser imports nothing that can act', () => {
    const FORBIDDEN = [
      "from 'electron'",
      '@wemessage/client',
      'fetch(',
      'ipcMain',
      'ipcRenderer',
      'child_process',
      'node:fs',
    ];
    const code = codeOf(archRead(DEEP_LINK));
    for (const needle of FORBIDDEN) expect(code).not.toContain(needle);
    // Non-vacuity: the file exists and is the parser.
    expect(code).toContain('export function parseDeepLink');
    expect(code).toContain('export function deepLinkFromArgv');
  });

  it('catches the planted parser that reaches for the network', () => {
    const rel = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/hungry.ts',
      'export const probe = async (id: string) => fetch(`/v1/drafts/${id}`);\n',
    );
    expect(codeOf(archRead(rel))).toContain('fetch(');
    // And the legitimate near-miss: a module that merely NAMES the word in
    // a string it will never call is not an offender.
    const ok = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/polite.ts',
      "export const NOTE = 'this module does not prefetch anything';\n",
    );
    expect(codeOf(archRead(ok))).not.toContain('fetch(');
  });

  /* ── row 3: a deep link may navigate and select, and may not act ───── */

  /**
   * The strongest statement available: the handler's code names the two
   * things it is allowed to do and nothing that could do a third.
   *
   * The ban list is the union of every verb this app has. `CHANNELS.pause`
   * and `CHANNELS.kill` are on it too — the tray is allowed to reach those,
   * a URL is not, and the two live in different files precisely so this row
   * can say which.
   */
  it('the deep-link path names no verb at all', () => {
    const FORBIDDEN = [
      'approve',
      'reject',
      'recall',
      'retry',
      'bulk',
      'dispatch',
      'SendBackend',
      'killSwitch',
      'CHANNELS.pause',
      'CHANNELS.resume',
      'CHANNELS.kill',
      'setSetting',
      'createAdapter',
      'disconnect',
    ];
    const code = codeOf(archRead(DEEP_LINK));
    for (const needle of FORBIDDEN)
      expect([needle, code.includes(needle)]).toEqual([needle, false]);
  });

  it('routes both delivery doors through one validated call', () => {
    // `open-url` (which can fire before `app.whenReady`) and the argv of a
    // `second-instance` are the same untrusted input arriving by different
    // doors. Two call sites would be two grammars eventually.
    const boot = codeOf(archRead(INDEX16));
    expect(boot).toContain("app.on('open-url'");
    expect(boot).toContain("app.on('second-instance'");
    expect(boot).toContain('deepLinkFromArgv(');
    const handlers = [...boot.matchAll(/handleDeepLink\(/g)].length;
    // Two callers and one definition.
    expect(handlers).toBeGreaterThanOrEqual(3);
    expect(namers(DESKTOP_SRC, 'parseDeepLink(').sort()).toEqual([
      DEEP_LINK,
      INDEX16,
    ]);
  });

  /* ── row 4: main does not import the renderer ──────────────────────── */

  it('no main-process file imports a renderer module', () => {
    const offenders = archFiles(MAIN).filter((rel) =>
      /from\s+'[^']*renderer\//.test(codeOf(archRead(rel))),
    );
    expect(offenders).toEqual([]);
  });

  it('catches the planted main file that reaches into the renderer', () => {
    const rel = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/borrowed.ts',
      "import { SCREENS } from '../../renderer/router.js';\nexport const s = SCREENS;\n",
    );
    expect(
      archFiles(MAIN).filter((f) =>
        /from\s+'[^']*renderer\//.test(codeOf(archRead(f))),
      ),
    ).toEqual([rel]);
    // Near-miss: a file whose PROSE mentions the renderer is not an import.
    const ok = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/prose.ts',
      '// the renderer/ tree owns this word and this file does not import it\nexport const x = 1;\n',
    );
    expect(
      archFiles(MAIN).filter((f) =>
        /from\s+'[^']*renderer\//.test(codeOf(archRead(f))),
      ),
    ).not.toContain(ok);
  });

  /* ── row 5: a tray does not tick ───────────────────────────────────── */

  /**
   * The hardest constraint in this scenario. A tray that says "PAUSED UNTIL
   * 14:30" is one small step from a tray that counts down, and a countdown
   * is a timer, and this app has exactly one timer (the reconnect backoff in
   * `gateway.ts`). So the tray is rebuilt by EVENTS — `push()` for the
   * posture, a `draft.*` frame for the queue — and the horizon it renders is
   * a wall-clock instant that stays true until the daemon corrects it with
   * `arming.changed`.
   */
  it('no tray or shortcut module owns a clock', () => {
    const TICKS = /\b(setTimeout|setInterval|requestAnimationFrame)\(/;
    for (const rel of [TRAY, TRAY_MODEL, GLYPHS, SHORTCUT, DEEP_LINK]) {
      expect([rel, TICKS.test(codeOf(archRead(rel)))]).toEqual([rel, false]);
    }
    // And the one timer in the app is still where Sc5 left it.
    expect(namers(DESKTOP_SRC, 'setTimeout(')).toEqual([`${MAIN}/gateway.ts`]);
  });

  it('catches the planted countdown', () => {
    const rel = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/counting.ts',
      'export const start = (f: () => void) => setInterval(f, 1000);\n',
    );
    expect(/\b(setTimeout|setInterval)\(/.test(codeOf(archRead(rel)))).toBe(
      true,
    );
    // Near-miss: naming the horizon is not polling it.
    const ok = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/horizon.ts',
      'export const untilLabel = (iso: string) => `PAUSED UNTIL ${iso.slice(11, 16)}`;\n',
    );
    expect(/\b(setTimeout|setInterval)\(/.test(codeOf(archRead(ok)))).toBe(
      false,
    );
  });

  /* ── row 6: the two public strings have one writer each ────────────── */

  /**
   * `setTitle` puts a string on the operator's menu bar, where anyone in the
   * room can read it and (on macOS) accessibility tooling can scrape it. One
   * writer, whose argument is a function that is total over `number` and
   * returns one of eleven strings, is the difference between a rule and a
   * habit.
   */
  it('the tray title and tooltip are each written in exactly one place', () => {
    expect(namers(DESKTOP_SRC, '.setTitle(')).toEqual([TRAY]);
    expect(namers(DESKTOP_SRC, '.setToolTip(')).toEqual([TRAY]);
    const code = codeOf(archRead(TRAY));
    expect(code).toMatch(/\.setTitle\(\s*trayBadge\(/);
    expect(code).toMatch(/\.setToolTip\(\s*trayTooltip\(/);
    // Neither string can be built from a draft, because neither computing
    // function can SEE one. `badgeFor` takes a number and a boolean; the
    // tooltip is built from the posture and the count and nothing else.
    const model = codeOf(archRead(TRAY_MODEL));
    expect(model).toMatch(
      /function badgeFor\(\s*count: number,\s*connected: boolean,?\s*\)/,
    );
    const body = /function trayTooltip\([\s\S]*?\n\}/.exec(model)?.[0] ?? '';
    expect(body).not.toBe('');
    for (const needle of ['preview', 'oldest', 'draftId', 'body', 'handle'])
      expect([needle, body.includes(needle)]).toEqual([needle, false]);
  });

  it('the title and tooltip are computed, never interpolated', () => {
    // A template literal at either call site is how a body ends up on a
    // menu bar. The two computing functions live in the pure model, where
    // the unit rows sweep them against a distinctive synthetic body.
    const code = codeOf(archRead(TRAY));
    expect(code).not.toMatch(/setTitle\(`/);
    expect(code).not.toMatch(/setToolTip\(`/);
    const model = codeOf(archRead(TRAY_MODEL));
    expect(model).toContain('export function trayBadge');
    expect(model).toContain('export function trayTooltip');
    expect(model).toContain('export function badgeFor');
  });

  /* ── row 7: nothing in the tray can approve ────────────────────────── */

  it('no tray module names an approving verb', () => {
    const FORBIDDEN = [
      'approveDraft',
      'bulkDrafts',
      'rejectDraft',
      'recallDraft',
      'retryDraft',
      'dispatchApproved',
      'SendBackend',
      'CHANNELS.approve',
      'CHANNELS.bulk',
      "'/approve'",
    ];
    for (const rel of [TRAY, TRAY_MODEL, GLYPHS]) {
      const code = codeOf(archRead(rel));
      for (const needle of FORBIDDEN)
        expect([rel, needle, code.includes(needle)]).toEqual([
          rel,
          needle,
          false,
        ]);
    }
    // Non-vacuity, as a closed SET rather than as two substrings.
    //
    // The first version of this clause asserted the tray's code contained
    // `CHANNELS.pause` and `CHANNELS.kill`, and both halves were wrong.
    // `CHANNELS` maps a request KEY to a `wm:` string for the preload
    // bridge; the tray lives in MAIN, on the far side of that bridge, and
    // reaches the daemon by naming the KEY and calling the handler. There is
    // no `CHANNELS.kill` at all — the key is `killSwitch` — so that half was
    // passing only because `'CHANNELS.killSwitch'` contains it as a
    // substring, which is the shape of assertion that convicts nothing.
    //
    // So: scrape every key the registry declares, keep the ones the tray
    // actually invokes, and assert the whole set. An equality bans
    // `approve`, `bulk` and every other key by construction rather than by
    // somebody remembering to add it to a list.
    const tray = codeOf(archRead(TRAY));
    const keys = [
      ...codeOf(archRead(`${MAIN}/ipc-channels.ts`)).matchAll(
        /^\s+(\w+): '(?:wm:)/gm,
      ),
    ].map((m) => m[1] as string);
    expect(keys).toContain('approve');
    expect(keys.length).toBeGreaterThan(20);
    const reached = keys.filter((key) => tray.includes(`invoke('${key}'`));
    expect([...new Set(reached)].sort()).toEqual([
      'drafts',
      'killSwitch',
      'pause',
      'resume',
    ]);
  });

  it('catches the planted Approve submenu item', () => {
    const rel = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/eager.ts',
      "import { CHANNELS } from '../ipc-channels.js';\nexport const item = { label: 'APPROVE', channel: CHANNELS.approve };\n",
    );
    expect(codeOf(archRead(rel))).toContain('CHANNELS.approve');
    // Near-miss: the WORD in a refusal string is not the channel.
    const ok = sc16Plant(
      'apps/desktop/src/main/__s8_sc16_probe__/refusal.ts',
      "export const NOTE = 'no approvals are offered from this menu';\n",
    );
    expect(codeOf(archRead(ok))).not.toContain('CHANNELS.approve');
  });

  /* ── row 8: the glyphs are procedural, because they have to be ─────── */

  /**
   * §1.7 asks for template SVGs under `apps/desktop/assets/tray/`. That
   * cannot exist: `nativeImage` on this Electron decodes PNG and JPEG and
   * has no SVG path at all, and Sc1 row 4 bans every raster under
   * `apps/desktop/src` and `apps/desktop/assets` with an allowlist that is
   * deliberately EMPTY. So the five glyphs are drawn into a BGRA buffer in
   * a pure module, which is the better answer anyway: "monochrome" becomes
   * a fact about bytes rather than a fact about a text sweep.
   */
  it('draws its icons rather than loading them', () => {
    expect(namers(DESKTOP_SRC, 'createFromBitmap(')).toEqual([TRAY]);
    expect(namers(DESKTOP_SRC, 'createFromPath(')).toEqual([]);
    expect(namers(DESKTOP_SRC, 'createFromDataURL(')).toEqual([]);
    expect(codeOf(archRead(GLYPHS))).not.toContain("from 'electron'");
    // Every posture has a bitmap, and the names are the plan's.
    const model = codeOf(archRead(TRAY_MODEL));
    for (const name of [
      'armedTemplate',
      'draftOnlyTemplate',
      'sendingTemplate',
      'killedTemplate',
      'disconnectedTemplate',
    ])
      expect(model).toContain(name);
  });

  /* ── row 9: the shortcut is registered once and its answer is read ─── */

  it('registers one accelerator, once, and does not swallow the answer', () => {
    expect(namers(DESKTOP_SRC, 'globalShortcut.register(')).toEqual([SHORTCUT]);
    const code = codeOf(archRead(SHORTCUT));
    // The return value is BOUND, and this is the STRONGER spelling of that.
    // The first draft of this row demanded a `const` initialiser and was
    // wrong: the call belongs inside a `try`, because some platforms THROW
    // for an accelerator they cannot parse and a throw during boot would
    // take the whole app down over a convenience — so the binding is an
    // assignment to a `let` declared above it. Relaxing the row to "contains
    // the word" would have let the discarded form back in, so instead it now
    // pins BOTH facts the original was reaching for: there is exactly one
    // call site, and its value is assigned rather than dropped.
    const calls = [...code.matchAll(/(.{2})globalShortcut\.register\(/g)].map(
      (m) => m[1] as string,
    );
    expect(calls).toEqual(['= ']);
    // And the throw is handled rather than left to kill the process.
    expect(code).toMatch(/try\s*\{[\s\S]{0,200}globalShortcut\.register\(/);
    expect(code).toMatch(/\}\s*catch\s*\{/);
    expect(code).toContain('isRegistered(');
    // One accelerator, named in the model and used here.
    expect(codeOf(archRead(TRAY_MODEL))).toContain(
      "TRAY_ACCELERATOR = 'CommandOrControl+Shift+K'",
    );
    expect(code).toContain('TRAY_ACCELERATOR');
  });

  it('the chord summons and cannot act', () => {
    // The organising principle of this scenario, made structural: a
    // system-wide keystroke carries no context, so it may show, hide or
    // focus the window and it may not decide anything. If it toggled, then
    // half the time the chord meant to STOP the world would RELEASE the
    // deny — and the operator pressing it cannot see which case they are in.
    const code = codeOf(archRead(SHORTCUT));
    for (const needle of [
      'CHANNELS.kill',
      'CHANNELS.pause',
      'CHANNELS.resume',
      'CHANNELS.approve',
      'setKillSwitch',
      'killSwitch',
    ])
      expect([needle, code.includes(needle)]).toEqual([needle, false]);
    // What it does instead.
    expect(code).toContain('showMainWindow');
  });

  it('says the failure out loud, in three agreeing spellings', () => {
    const model = archRead(TRAY_MODEL);
    const states = sc16Array(model, 'SHORTCUT_STATES');
    expect([...states].sort()).toEqual(['declined', 'registered', 'taken']);
    // `Readonly<Record<ShortcutState, string>>` is the compile-time half;
    // this is the runtime shadow, and it is what catches a copy table that
    // was widened with `as` somewhere.
    const spec = /SHORTCUT_LINE[^=]*=\s*\{([\s\S]*?)\n\};/.exec(model);
    const keys = [...(spec?.[1] ?? '').matchAll(/(\w[\w-]*)\s*:/g)].map(
      (m) => m[1] as string,
    );
    expect([...keys].sort()).toEqual([...states].sort());
    // And the window says it too, on the pane the chord summons.
    expect(codeOf(archRead(KILL_PANE))).toContain('kill-shortcut');
  });

  /* ── row 10: PAUSE is a clamp, and the menu is not allowed to lie ──── */

  /**
   * The organising distinction of this slice: DENIES bind everyone
   * including the operator; CLAMPS bind only autonomy. `evaluateGate`
   * answers the kill switch with `allow: false` and answers a pause with
   * `allow: true, mode: 'draft-only', clampedBy: 'outside-window'` — so a
   * paused daemon still sends what a human approves and a killed one
   * refuses the human too.
   *
   * That is why the tray may set AND release a pause, and may only ARM the
   * kill switch: a control that can only be set from a menu is a trap, and
   * a control that binds the operator is not released from a surface that
   * can be mis-clicked while nobody is looking at the screen.
   */
  it('takes the daemon’s own three pause tokens, not an instant it computed', () => {
    const route = archRead(TOGGLES);
    // The route's own vocabulary, read from the route.
    for (const token of ['1h', 'until-tomorrow', 'rest-of-window'])
      expect(route).toContain(`'${token}'`);
    const model = codeOf(archRead(TRAY_MODEL));
    for (const token of ['1h', 'until-tomorrow', 'rest-of-window'])
      expect([token, model.includes(`'${token}'`)]).toEqual([token, true]);
    // The plan says the third item passes `armed.until`. It does not: the
    // daemon resolves `rest-of-window` through `armedWindowClose` and
    // answers 409 `not-armed` when no SCHEDULE window is open, which is a
    // different fact from `armed.until === null`.
    expect(route).toContain('armedWindowClose');
    expect(model).not.toMatch(/until:\s*armed\.until/);
  });

  it('pause is a clamp in the gate, and the menu says the word', () => {
    // Read from the gate, so the menu's copy cannot drift from the truth.
    const gate = archRead(GATE);
    expect(gate).toMatch(/pausedAt\([\s\S]{0,200}clampedBy = 'outside-window'/);
    const model = archRead(TRAY_MODEL);
    expect(model).toContain('CLAMP');
    expect(model).toContain('NOT A DENY');
    // The half that gets people: resume does not replay.
    expect(model).toContain('RELEASES NOTHING');
  });

  it('the kill switch is armed from the tray and released only in the window', () => {
    const tray = codeOf(archRead(TRAY));
    const model = codeOf(archRead(TRAY_MODEL));
    // The command has no argument, so there is no spelling of it that turns
    // the switch OFF. That is a type-level fact; this is its shadow.
    expect(model).toMatch(/kind:\s*'kill'/);
    expect(model).not.toMatch(/kind:\s*'unkill'/);
    expect(model).not.toMatch(/kind:\s*'kill';\s*readonly\s+on:/);
    // Pinned to the ARGUMENT, not to a substring within eighty characters.
    // The earlier spelling would have been satisfied by `CHANNELS.killSwitch`
    // appearing anywhere near the word `true`, including in an unrelated
    // line; this says exactly what is passed, and the negative says there is
    // no call that passes anything else.
    expect(tray).toMatch(/invoke\('killSwitch', \[true\]\)/);
    expect(tray).not.toMatch(/invoke\('killSwitch', \[(?!true\])/);
  });

  /* ── row 11: the window is no longer the app ───────────────────────── */

  it('closing the last window does not quit, and QUIT is a menu item', () => {
    const boot = codeOf(archRead(INDEX16));
    // Sc4 quit on `window-all-closed` because the window WAS the app. A
    // tray that dies with the window is a tray that is never there when it
    // is wanted, so the handler goes and the operator gets an explicit way
    // out instead of an implicit one.
    expect(boot).not.toMatch(/window-all-closed[\s\S]{0,120}app\.quit\(\)/);
    expect(codeOf(archRead(TRAY_MODEL))).toMatch(/kind:\s*'quit'/);
    // Exactly one window constructor, still (Sc4).
    expect(namers(DESKTOP_SRC, 'new BrowserWindow(')).toEqual([
      `${MAIN}/window.ts`,
    ]);
  });

  it('there is one way to show the window and everything uses it', () => {
    // The tray's OPEN, the shortcut's summon and a deep link all have to
    // re-create a window that may not exist. Three spellings of "make a
    // window" is three places for Sc4's frozen `WINDOW_OPTIONS` to be
    // bypassed.
    expect(namers(DESKTOP_SRC, 'createWindow(').sort()).toEqual([
      INDEX16,
      `${MAIN}/window.ts`,
    ]);
    const boot = codeOf(archRead(INDEX16));
    expect(boot).toContain('function showMainWindow');
    for (const rel of [TRAY, SHORTCUT])
      expect([rel, codeOf(archRead(rel)).includes('createWindow(')]).toEqual([
        rel,
        false,
      ]);
  });

  /* ── row 12: the public repo is still public-safe ──────────────────── */

  it('nothing the tray puts on screen identifies an operator', () => {
    expect(publicRepoOffenders()).toEqual([]);
    // Sc15's row 12 owns the `/Users/` census and gets it right (the guard
    // file is excluded from `trackedTextFiles()`, so "three" cannot be
    // asserted over that list — asserting it there was Sc15's own row being
    // wrong rather than the tree). This row does not re-count. It sweeps
    // exactly the files Sc16 adds, which is the part that could regress.
    const mine = [
      DEEP_LINK,
      TRAY_MODEL,
      TRAY,
      GLYPHS,
      SHORTCUT,
      'apps/desktop/test/unit/deep-link.spec.ts',
      'apps/desktop/test/unit/tray-model.spec.ts',
      'apps/desktop/test/e2e/tray.e2e.spec.ts',
    ];
    for (const rel of mine) {
      const raw = archRead(rel);
      expect(raw.includes('/Users/'), `${rel} names a home path`).toBe(false);
      for (const phone of raw.match(/\+1\d{10}/g) ?? [])
        expect(phone.startsWith('+1555'), `${rel}: ${phone}`).toBe(true);
      for (const host of raw.match(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])
        expect(host.endsWith('example.com'), `${rel}: ${host}`).toBe(true);
    }
    // And the census itself is re-asserted here by NAME, so a carrier
    // introduced by any later scenario fails HERE with a filename rather
    // than three scenarios later with an integer.
    const homes = trackedTextFiles().filter((rel) =>
      readFileSync(join(repoRoot, rel), 'utf8').includes('/Users/'),
    );
    expect(homes.sort()).toEqual([
      'apps/desktop/scripts/verify-bundle.sh',
      'packages/adapter-testkit/test/pack.spec.ts',
      'packages/cli/test/skill-dryrun.spec.ts',
    ]);
    // s9 Sc6 admits the FOURTH home, and admitting one by NAME ALONE would
    // be exactly the widening this census exists to prevent. So the entry
    // arrives with a condition attached. The bundle verifier hunts absolute
    // paths inside a shipped Mach-O, which means it has to be able to spell
    // one, and every `/Users/` in it must therefore sit inside a grep
    // pattern. An edit that later hard-codes a real home on a line of its
    // own still fails, and fails carrying the line that did it.
    for (const line of readFileSync(
      join(repoRoot, 'apps/desktop/scripts/verify-bundle.sh'),
      'utf8',
    ).split('\n'))
      if (line.includes('/Users/'))
        expect(line, 'verify-bundle.sh names a home outside a grep').toContain(
          'grep',
        );
  });
});

describe('S8 extensions (s8-execution Scenario 17: the checkpoint, and the slice’s own closing rows)', () => {
  const sc17Planted: string[] = [];
  function sc17Plant(rel: string, body: string): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    sc17Planted.push(rel);
    return rel;
  }
  afterEach(() => {
    for (const rel of sc17Planted.splice(0))
      rmSync(join(repoRoot, rel), { force: true });
  });

  const LINUX = '.github/workflows/ci-linux.yml';
  const MACOS = '.github/workflows/ci-macos.yml';
  const TOKENS = 'apps/desktop/src/renderer/theme/tokens.css';
  const APP_CSS = 'apps/desktop/src/renderer/app.css';

  /* ── row 7: the macOS lane is a lane, not a green tick ─────────────── */

  /**
   * A step reader for a file shape this repo writes, same as row 8's.
   *
   * Kept local rather than shared because the two rows ask different
   * questions of it and row 8's copy is scoped inside its own describe; a
   * lifted helper would be a refactor of a passing guard in a scenario whose
   * job is to close the slice, and this scenario has already been warned
   * about editing existing guards to fit new work.
   */
  /**
   * The `jobs:` block alone, and then the body of ONE named job inside it.
   *
   * s9 Sc9 narrowed the readers below. Until this slice each CI file held
   * exactly one job, so "the steps in the file" and "the steps in the gate
   * job" were the same list and a reader could take the whole file. Then the
   * macOS file gained a `pack-adhoc` job and the two stopped being the same
   * list. The narrowing runs in the strict direction: the rows below would
   * previously have been satisfied by steps belonging to ANY job, so a lane
   * could have moved `pnpm test` out of its gate job into a second job that
   * never runs on a pull request, and nothing here would have noticed.
   *
   * The slice starts at `jobs:` on purpose, and that is not defensiveness.
   * `on:` holds `push:` and `pull_request:` at the same two-space indent a
   * job name uses, so a reader scanning the whole file hands back the trigger
   * block for a job called `push`.
   */
  const sc17Jobs = (text: string): string => {
    const at = /^jobs:$/m.exec(text);
    if (at === null) throw new Error('this workflow has no `jobs:` block');
    return text.slice(at.index + at[0].length);
  };

  const sc17Job = (text: string, job: string): string => {
    const body = sc17Jobs(text);
    const start = new RegExp(`^  ${job}:$`, 'm').exec(body);
    if (start === null) throw new Error(`no job \`${job}\` in this workflow`);
    const after = body.slice(start.index + start[0].length);
    const next = /^  [\w-]+:$/m.exec(after);
    return next === null ? after : after.slice(0, next.index);
  };

  /** The gate job. Both lanes spell it the same way, and a row asserts that. */
  const GATE_JOB = 'build-and-test';

  const sc17Steps = (text: string): string[] =>
    text
      .split(/\n {6}- /)
      .slice(1)
      .map((body) => body.split('\n      #')[0] ?? body)
      .map((body) =>
        body
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'))
          .join(' | '),
      );

  it('the macOS lane runs the same gate as Linux, step for step', () => {
    // The failure this catches is the one a "macOS smoke job" always drifts
    // into: a lane that installs, builds, and then runs a subset — or worse,
    // a lane that runs `pnpm test` with a filter, which is how the desktop
    // project gets quietly excluded from the platform it actually ships on.
    // The lanes are therefore compared as SEQUENCES rather than by spot
    // checks, with the one legitimate difference normalised away: Linux has
    // no window server and needs `xvfb-run -a`, macOS has one and must not
    // use it. Any other difference is a difference.
    const linux = sc17Steps(sc17Job(archRead(LINUX), GATE_JOB)).map((s) =>
      s.replace('run: xvfb-run -a pnpm test', 'run: pnpm test'),
    );
    const macos = sc17Steps(sc17Job(archRead(MACOS), GATE_JOB));
    expect(linux.length).toBeGreaterThanOrEqual(9);
    expect(macos).toEqual(linux);
    // …and the reader is not vacuous: it found the step that matters.
    expect(macos).toContain('run: pnpm test');
    expect(macos).toContain('run: pnpm build');
  });

  it('the macOS lane holds exactly the gate job and the pack job', () => {
    // The readers above name their job, so they can no longer notice a job
    // that was ADDED. This row is what replaces that: the job list is closed,
    // and growing it is a reviewed diff rather than a silent one.
    const jobsIn = (text: string): string[] =>
      [...sc17Jobs(text).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] ?? '');
    expect(jobsIn(archRead(MACOS))).toEqual([GATE_JOB, 'pack-adhoc']);
    // Linux has one job and spells its name the same way, which is the whole
    // reason the step-for-step comparison above means anything.
    expect(jobsIn(archRead(LINUX))).toEqual([GATE_JOB]);
  });

  it('runs on a real macOS runner, and Linux still runs on Linux', () => {
    expect(archRead(MACOS)).toContain('runs-on: macos-15');
    expect(archRead(MACOS)).not.toContain('runs-on: ubuntu');
    expect(archRead(LINUX)).toContain('runs-on: ubuntu-latest');
    // A workflow that only ever runs when somebody presses a button is a
    // workflow that is green because nobody ran it. This one is on push.
    expect(archRead(MACOS)).not.toContain('workflow_dispatch');
    expect(archRead(MACOS)).toContain('pull_request');
  });

  it('neither signs nor notarizes, and asks for no secret', () => {
    // There is no Apple Developer ID and no notarization credential for this
    // project, and the repo is public. A step that pretended to sign would
    // either need a secret this repo must not carry, or would be a tick
    // attached to nothing — and the second is worse, because it reads as
    // "signing is covered". s9 Sc9 added a `pack-adhoc` job to this file
    // and that does not weaken this row: packing is not signing, the job
    // carries no secret, and the sweep below reads the WHOLE file, so a
    // signing step added to EITHER job still fails here.
    const text = archRead(MACOS);
    for (const forbidden of [
      'secrets.',
      'codesign',
      'notarytool',
      'xcrun',
      'APPLE_ID',
      'CSC_LINK',
      'p12',
      'keychain',
    ])
      expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);
    // The comment header has to SAY so, because the next person to read this
    // file will otherwise add signing to it and wonder why it was missing.
    expect(text).toContain('notarize');
  });

  it('PLANTED: a macOS lane that skips the suite is caught', () => {
    const rel = sc17Plant(
      '.github/workflows/__s8_sc17_probe__.yml',
      archRead(MACOS).replace('      - run: pnpm test\n', ''),
    );
    const linux = sc17Steps(sc17Job(archRead(LINUX), GATE_JOB)).map((s) =>
      s.replace('run: xvfb-run -a pnpm test', 'run: pnpm test'),
    );
    expect(sc17Steps(sc17Job(archRead(rel), GATE_JOB))).not.toEqual(linux);
  });

  it('LEGITIMATE NEAR-MISS: the same lane with a reworded comment is not a drift', () => {
    // Comments are not steps. A row that compared raw text would fail on a
    // typo fix, and a row that fails on a typo fix gets deleted.
    const rel = sc17Plant(
      '.github/workflows/__s8_sc17_probe__.yml',
      archRead(MACOS).replace(
        '# No xvfb: macOS runners have a window server',
        '# macOS runners have a window server, so no xvfb',
      ),
    );
    expect(sc17Steps(sc17Job(archRead(rel), GATE_JOB))).toEqual(
      sc17Steps(sc17Job(archRead(MACOS), GATE_JOB)),
    );
  });

  /* ── row 8 (meta): the GUI-era slice added no transport ────────────── */

  it('the wire vocabulary is one vocabulary, spelled three times', () => {
    // Three lists, three files, three authors' worth of opportunity to drift:
    // the protocol's own union, the ratchet's snapshot of what the vocabulary
    // is, and the ratchet's snapshot of what the daemon actually emits. S8
    // put a GUI in front of all of it and must not have moved any of them.
    expect([...WS_EVENT_VOCABULARY].sort()).toEqual(
      [...GATEWAY_EVENT_NAMES].sort(),
    );
    expect([...EMITTED_WS_EVENTS].sort()).toEqual(
      [...GATEWAY_EVENT_NAMES].sort(),
    );
    // The list of events nobody emits is the interesting one: a name that
    // exists in the vocabulary and comes out of nothing is a name a client
    // can wait for forever.
    expect([...UNEMITTED_WS_EVENTS]).toEqual([]);
    expect(GATEWAY_EVENT_NAMES.length).toBe(21);
  });

  it('the route table, the frame table and the port allowlist are S7’s', () => {
    // Numbers, because these are the slice's closing counts and a count is
    // the one thing a relationship cannot express: "no new route" has no
    // second source to compare against inside this repo. Each is also
    // checked for the shape of drift a count alone would miss.
    expect(ROUTE_TABLE.length).toBe(67);
    expect(new Set(ROUTE_TABLE).size).toBe(ROUTE_TABLE.length);
    expect(ROUTE_TABLE.filter((r) => !/^[A-Z]+ \//.test(r))).toEqual([]);

    expect(Object.keys(FRAME_SPECS).length).toBe(9);
    // INV-2 at the wire: there is no frame that sends. Every path to a send
    // goes through an approval the daemon validated, and a frame type would
    // be a way around that which no amount of GUI review would catch.
    expect(Object.keys(FRAME_SPECS)).not.toContain('send');

    expect(PORT_IMPORTER_ALLOWLIST.length).toBe(15);
    expect(new Set(PORT_IMPORTER_ALLOWLIST).size).toBe(
      PORT_IMPORTER_ALLOWLIST.length,
    );
    // The GUI is not on it, and that is the whole of INV-2 in one line.
    expect(
      PORT_IMPORTER_ALLOWLIST.filter((f) => f.startsWith('apps/desktop')),
    ).toEqual([]);
  });

  it('nothing under src spells a send frame into existence', () => {
    const offenders: string[] = [];
    for (const root of ['packages', 'apps'])
      for (const rel of archFiles(root)) {
        if (!/\/src\//.test(rel)) continue;
        if (codeOf(archRead(rel)).includes("type: 'send'")) offenders.push(rel);
      }
    expect(offenders).toEqual([]);
  });

  it('apps/desktop/src imports five packages and the node builtins', () => {
    // An inventory, which is stronger than the cruiser rule it doubles: the
    // rule says "this may not reach core", the inventory says "this reaches
    // exactly these", so a new dependency is a diff here even when it is one
    // the cruiser has no opinion about.
    const specifiers = new Set<string>();
    for (const rel of archFiles('apps/desktop/src'))
      for (const m of codeOf(archRead(rel)).matchAll(/from '([^']+)'/g)) {
        const spec = m[1] ?? '';
        if (!spec.startsWith('.')) specifiers.add(spec);
      }
    expect([...specifiers].sort()).toEqual([
      '@wemessage/client',
      '@wemessage/protocol',
      'electron',
      'node:crypto',
      'node:fs',
      'node:os',
      'node:path',
      'node:url',
      'preact',
    ]);
    // `preact/hooks` and `preact/jsx-runtime` are reached through the vite
    // alias rather than by specifier, so their absence here is not a hole;
    // what would be a hole is a bare specifier nobody declared, and the
    // manifest row above pins the declared set to the same three names.
  });

  /* ── the token sheet's one filter list goes in a filter property ───── */

  it('--backdrop is only ever assigned to backdrop-filter', () => {
    // `--backdrop` holds `blur(30px) saturate(180%)`. Assign it to
    // `backdrop-filter` and the panel blurs; assign it to `background` and
    // the declaration is invalid at computed-value time, unsets in silence,
    // and the element paints NOTHING. No error, no warning, and nothing for
    // a contrast reader or a screenshot to find missing, because the pixels
    // that should have been there never existed. `.confirm-scrim` shipped
    // exactly that from Sc 10 until this scenario measured it.
    //
    // The runtime half lives in `a11y.spec.ts`, which substitutes every
    // `var()` in the CSSOM and asks `CSS.supports`. This half is the source
    // statement, so the answer is a diff rather than a test run.
    const uses: string[] = [];
    for (const rel of [TOKENS, APP_CSS])
      for (const m of archRead(rel).matchAll(
        /^\s*([a-z-]+)\s*:\s*[^;]*var\(--backdrop\)/gm,
      ))
        uses.push(`${rel}: ${m[1] ?? ''}`);
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((u) => !u.endsWith(': backdrop-filter'))).toEqual([]);
  });

  /* ── row 9 (meta, PUBLIC): the checkpoint added nothing identifying ── */

  it('nothing this scenario adds identifies an operator or a machine', () => {
    expect(publicRepoOffenders()).toEqual([]);
    const mine = [
      'apps/desktop/test/e2e/a11y.spec.ts',
      'apps/desktop/test/e2e/a11y.ts',
      'apps/desktop/test/e2e/axe.ts',
      'apps/desktop/test/e2e/no-green-runtime.ts',
      MACOS,
    ];
    for (const rel of mine) {
      const raw = archRead(rel);
      expect(raw.includes('/Users/'), `${rel} names a home path`).toBe(false);
      for (const phone of raw.match(/\+1\d{10}/g) ?? [])
        expect(phone.startsWith('+1555'), `${rel}: ${phone}`).toBe(true);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════ */
/* s9 Sc1 — the ship-era guards (s9-execution Scenario 1).                   */
/* ════════════════════════════════════════════════════════════════════════ */

/**
 * S9 turns this repository into something a stranger downloads and a machine
 * signs. Both of those change what the guards have to be about.
 *
 * Until now every sweep in this file has been about the SOURCE: what imports
 * what, what mints what, what colour the app paints. The ship era adds two
 * new failure modes that no source rule can see. The first is that the
 * artefacts an operator actually meets — a landing page, a README, a cask, a
 * DMG background — are outside every root the guards walk, so the product can
 * say one thing and the page in front of the download button can say the
 * opposite. The second is that the release machinery is the first code in
 * this tree with the ability to stop a service on the machine it runs on,
 * and the operator's own machine runs services that are not ours.
 *
 * So the rows below extend three existing sweeps outward (public strings to
 * every tracked text file including SVG, plus an operator-identity arm; the
 * no-green sweep to every ship surface; the raster ban to an enumerated,
 * DECODED allowlist) and add one that is new: no tracked file anywhere near
 * the product may name a process-killing launchd verb, and the one file that
 * is allowed to spawn `launchctl` may only ever hand it a label this project
 * owns.
 *
 * Divergences from the plan text are argued at each row. The tree wins.
 */
describe('S9 extensions (s9-execution Scenario 1: the ship era)', () => {
  const s9Read = (rel: string): string => archRead(rel);

  /** Plant, index, and un-index — the s7 Sc7 shape, scoped to this block. */
  const s9Planted: string[] = [];
  function s9Plant(rel: string, body: string, intentToAdd = false): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    s9Planted.push(rel);
    if (intentToAdd)
      execFileSync('git', ['add', '--intent-to-add', '--', rel], {
        cwd: repoRoot,
      });
    return rel;
  }
  /** Remove the directory shells the plants created. Named so a row can prove it. */
  function s9RemovePlantedDirs(): void {
    for (const dir of [
      'apps/desktop/scripts',
      'packages/daemon/src/__s9__',
      'packages/daemon/test/__s9__',
    ]) {
      const abs = join(repoRoot, dir);
      // Empty-only, deliberately. The per-file loop in `afterEach` has already
      // removed everything this block planted, so anything still standing here
      // belongs to somebody else and a recursive force-remove would eat it.
      if (existsSync(abs) && readdirSync(abs).length === 0)
        rmSync(abs, { recursive: true });
    }
  }

  afterEach(() => {
    for (const rel of s9Planted.splice(0)) {
      try {
        execFileSync(
          'git',
          ['rm', '--cached', '--quiet', '--force', '--', rel],
          { cwd: repoRoot, stdio: 'ignore' },
        );
      } catch {
        // never indexed; the unlink is the whole cleanup
      }
      rmSync(join(repoRoot, rel), { force: true });
    }
    s9RemovePlantedDirs();
  });

  /**
   * s9 D5: `apps/desktop/scripts` is a REAL, shipped path — Sc 5's
   * `bundle-daemon.mjs` lives there — unlike its two `__s9__` siblings, which
   * are namespaced precisely so they can never collide with source. This row
   * is the guard that the cleanup above removes the empty shells a plant
   * created and stops there. Without it, the sweep deletes a tracked file out
   * of the working tree on every row in this block, and the failure looks like
   * the file was never written.
   *
   * Sc 5 amended the row, and the amendment is the whole reason it existed.
   * When it was written, `apps/desktop/scripts` was still empty, so it could
   * carry both halves of the claim at once: a keeper survives, and the empty
   * shell is then removed. Sc 5 put a permanent file in that directory, which
   * makes the second half FALSE of it forever — the shell is never empty
   * again. So the halves split. Survival is now asserted against the shipped
   * file by name, which is strictly stronger than a synthetic keeper because
   * it is the file the cleanup would actually have destroyed. Removal moves to
   * `packages/daemon/src/__s9__`, a namespaced path that can never become a
   * real one, so the row cannot be invalidated a second time the same way.
   */
  it('cleanup removes the planted directory shells, but never a real file', () => {
    const scripts = join(repoRoot, 'apps/desktop/scripts');
    const shipped = join(scripts, 'bundle-daemon.mjs');
    const keeper = join(scripts, '__s9_keeper__.mjs');

    // The half that matters: the bundler Sc 5 shipped is sitting in one of the
    // three directories this helper sweeps, and it has to still be there after.
    expect(existsSync(shipped), 'Sc 5 ships apps/desktop/scripts').toBe(true);
    mkdirSync(scripts, { recursive: true });
    writeFileSync(keeper, 'export const shipped = true;\n');
    try {
      s9RemovePlantedDirs();
      expect(
        existsSync(keeper),
        'a non-empty apps/desktop/scripts must survive cleanup',
      ).toBe(true);
    } finally {
      rmSync(keeper, { force: true });
    }
    s9RemovePlantedDirs();
    expect(existsSync(shipped), 'the shipped bundler survives cleanup').toBe(
      true,
    );

    // The other half, on a path that is namespaced out of collision range.
    const shell = join(repoRoot, 'packages/daemon/src/__s9__');
    mkdirSync(shell, { recursive: true });
    s9RemovePlantedDirs();
    expect(existsSync(shell), 'the empty shell is still removed').toBe(false);
  });

  /**
   * s9 Sc5: the file walker's skip set, pinned.
   *
   * `archFiles` walks the filesystem rather than the index, deliberately: the
   * planted probes above are never committed, and a `git ls-files` walk would
   * be blind to every one of them. The price is that build output is visible,
   * and Sc 5 collected it — `dist-bundle/daemon/main.mjs` is esbuild's inlined
   * copy of the daemon, launchd runner and all, and row 5 duly convicted it of
   * spawning a child process. A guard a `pnpm build` can flip is not a guard.
   *
   * The fix is an entry in ARCH_SKIP, and an entry in a skip set is a hole
   * unless something outside the set decides what may go in it. So: every name
   * is either dot-prefixed tooling metadata, which cannot hold a module the
   * product imports, or a directory git itself refuses to track. Neither limb
   * admits `src`, `test`, `scripts` or any other place source actually lives.
   */
  it('the walker skips only tooling metadata and gitignored build output', () => {
    const ignored = (name: string): boolean => {
      try {
        execFileSync(
          'git',
          ['check-ignore', '-q', '--', `apps/desktop/${name}/`],
          {
            cwd: repoRoot,
            stdio: 'ignore',
          },
        );
        return true;
      } catch {
        return false;
      }
    };
    const admissible = (name: string): boolean =>
      name.startsWith('.') || ignored(name);

    expect([...ARCH_SKIP].sort()).toEqual([
      '.git',
      '.turbo',
      'coverage',
      'dist',
      'dist-bundle',
      'dist-pack',
      'dist-pack-next',
      'node_modules',
    ]);
    for (const name of ARCH_SKIP) expect(admissible(name), name).toBe(true);

    // Non-vacuity, both limbs. `src` is neither dot-prefixed nor ignored, and
    // it is the exact name a future edit would reach for to make a stubborn
    // row go quiet.
    for (const name of ['src', 'test', 'scripts', 'packages'])
      expect(admissible(name), name).toBe(false);
    expect(ignored('dist-bundle')).toBe(true);
  });

  /* ── row 1: the public sweep reads more of the tree, and more shapes ── */

  /**
   * The plan says the extension filter "becomes"
   * `/\.(ts|tsx|js|mjs|cjs|json|md|html|css|rb|plist|yml|yaml|sh)$/`.
   *
   * That is stale, and adopting it would be a REGRESSION. s7 Sc7 already
   * replaced the allowlist the plan is describing with a DENYLIST — every
   * tracked file except a handful of binary extensions — which is strictly
   * wider than the fifteen extensions above and does not have to be edited
   * when somebody commits a `.toml` or a `.txt`. The plan was written
   * against the s6-era filter. So the two plants it prescribes tell us
   * something different from what it expected: the `+1` number in a `.md`
   * ALREADY fails, and it fails at HEAD, because `.md` is not in the
   * denylist.
   *
   * Two things are genuinely missing, and both of them are what this row is.
   *
   * `.svg` is IN the denylist. It was put there in s7 as a "not text"
   * extension, which is wrong twice: an SVG is XML, and the ship era commits
   * more of them (the site mark, the tray glyphs) than the GUI era did. A
   * repository that bans operator identity in every file except the ones
   * shaped like pictures has a hole exactly the shape of a picture.
   *
   * And there is no identity arm at all. `publicStringOffenders` refuses
   * brands, real `+1` numbers, adapter tokens, bearer tokens and absolute
   * home paths — every one of which is a string a MACHINE would leave
   * behind. None of them is the operator's name. The plan's own probe (an
   * `eric@` local-part) cannot fail today for that reason.
   */
  describe('row 1: every tracked text file, and one more thing to look for', () => {
    it('SVG is swept: it is XML, and the ship era commits more of it', () => {
      const svgs = execFileSync('git', ['ls-files', '--', '*.svg'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0)
        .sort();
      // Non-vacuity first: a subset row over an empty set is a row that
      // passes because it read nothing.
      expect(svgs.length).toBeGreaterThan(0);
      const swept = new Set(trackedTextFiles());
      expect(svgs.filter((f) => !swept.has(f))).toEqual([]);
      expect(publicRepoOffenders()).toEqual([]);
    });

    it('PLANTED: an operator handle in an .svg trips the public sweep', () => {
      // Assembled at runtime. This file is the one the sweep skips, and a
      // probe that only works because its enforcer is exempt is not a probe
      // — but it is also a PUBLIC repository, and the point of the arm
      // being added is that the operator's handle never appears in it.
      const handle = `wind${'seeker'}`;
      const rel = s9Plant(
        'apps/desktop/assets/__s9_probe__.svg',
        `<svg xmlns="http://www.w3.org/2000/svg"><title>${handle}</title></svg>\n`,
        true,
      );
      expect(trackedTextFiles()).toContain(rel);
      expect(publicRepoOffenders()).toContain(`${rel}: operator identity`);
    });

    it('PLANTED: an operator local-part in a .yml under .github trips it', () => {
      const local = `${'eri'}c@`;
      const rel = s9Plant(
        '.github/__s9_probe__.yml',
        `on: push\njobs:\n  x:\n    env:\n      NOTIFY: "${local}example.com"\n`,
        true,
      );
      expect(publicRepoOffenders()).toContain(`${rel}: operator identity`);
    });

    it('NEAR-MISS: the fixture mailboxes the tree already carries are fine', () => {
      // `Eric.Test@Example.COM` and `eric.test@example.com` are real tracked
      // fixture data — case-folding evidence for the store's contact
      // matching. An identity arm that convicted them would be an arm
      // somebody had to add an exemption for, and a guard a legitimate
      // caller must be exempted from is the wrong guard. The arm therefore
      // asks for the handle followed IMMEDIATELY by `@` or `+`, which is
      // what an actual mailbox looks like and what a first-name-shaped
      // fixture never is.
      const near = [
        `${'Eri'}c.Test@Example.COM`,
        `${'eri'}c.test@example.com`,
        'a generic mailbox',
        `${'eri'}csson`,
      ];
      for (const text of near)
        expect(
          publicStringOffenders(text).map((o) => o.detail),
          text,
        ).not.toContain('operator identity');
      // and the arm is not asleep:
      expect(
        publicStringOffenders(`${'eri'}c@example.com`).map((o) => o.detail),
      ).toContain('operator identity');
    });
  });

  /* ── row 4: the launchd verbs, banned across the whole product ─────── */

  /**
   * F-120's mechanical half, and the most important row in the scenario.
   *
   * The operator's machine runs launchd agents that are not ours. Sc 3 gives
   * this project the ability to spawn `launchctl`, and from that commit
   * onward every one of the verbs below is one typo away from stopping
   * somebody else's daemon. The rule is therefore not "be careful with
   * launchctl", it is that these ten strings do not appear in the product at
   * all — not in code, not in a comment, not in a workflow, not in a fixture.
   * A verb nobody has written down is a verb nobody can run by accident.
   *
   * `kickstart` and `pkill` and `killall` are the process killers.
   * `launchctl load`/`unload`/`remove`/`kill` are the deprecated,
   * whole-domain spellings whose modern replacements (`bootstrap`,
   * `bootout`, `enable`, `disable`) are scoped to a target and are what the
   * runner uses. `sol-agent` and `com.user.` are the operator's own labels,
   * named because they are the specific services on the specific machine
   * this code is written on, and `/Library/LaunchDaemons` is root's domain,
   * which this project never enters.
   *
   * THE SELF-REFERENCE. A guard that greps for ten strings has to spell all
   * ten, so its own source is the one file that must be exempt. That is not
   * a hole invented here: `trackedTextFiles()` has excluded
   * `test/arch.spec.ts` since s7 Sc7 for exactly this reason, and the
   * settled resolution — used for the `/Users/` sweep in s8 — is that the
   * exemption is proved to be a set of size one and the exempt file's own
   * hits are ENUMERATED rather than counted. Both legs are below.
   */
  // teeth: TN-sol-agent-by-cast (row 6): a foreign label cast past the brand was refused as LaunchdInvocationRefused rather than LaunchdLabelRefused, failing row 6 of packages/daemon/test/launchctl.spec.ts and its sibling. Reverted.
  // Recorded in this file because row 4 below bans that tooth's own name in every tracked file under the product roots, and this file is the single exemption.
  describe('row 4: no tracked file names a launchd verb that kills', () => {
    const LAUNCHD_BANNED: readonly string[] = [
      'kickstart',
      'pkill',
      'killall',
      'launchctl kill',
      'launchctl remove',
      'launchctl unload',
      'launchctl load',
      'sol-agent',
      'com.user.',
      '/Library/LaunchDaemons',
    ];
    const LAUNCHD_ROOTS: readonly string[] = [
      'packages/',
      'apps/',
      'tools/',
      'fixtures/',
      'test/',
      '.github/',
      'homebrew/',
    ];
    const sweptForLaunchd = (): string[] =>
      trackedTextFiles().filter((f) =>
        LAUNCHD_ROOTS.some((r) => f.startsWith(r)),
      );
    function launchdOffenders(): string[] {
      const out: string[] = [];
      for (const f of sweptForLaunchd()) {
        const lines = readFileSync(join(repoRoot, f), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i += 1)
          for (const verb of LAUNCHD_BANNED)
            if ((lines[i] ?? '').includes(verb))
              out.push(`${f}:${String(i + 1)}: ${verb}`);
      }
      return out.sort();
    }

    it('the ban list is the plan\u2019s ten, in the plan\u2019s order', () => {
      // Pinned against a SECOND, fragment-assembled spelling so that the
      // cheapest way to make a failing file pass — deleting the verb from
      // the list — is itself a failing diff. Assembled rather than copied
      // because a find-and-replace that reworded the guard would otherwise
      // reword the assertion that forbids rewording the guard.
      expect([...LAUNCHD_BANNED]).toEqual([
        `kick${'start'}`,
        `p${'kill'}`,
        `kill${'all'}`,
        `launchctl ${'kill'}`,
        `launchctl ${'remove'}`,
        `launchctl ${'unload'}`,
        `launchctl ${'load'}`,
        `sol${'-agent'}`,
        `com.${'user.'}`,
        `/Library/${'LaunchDaemons'}`,
      ]);
    });

    /**
     * The one place in the tree that is allowed to say `sol` + `-agent`, and
     * a SELF-TRIP paid in full rather than papered over.
     *
     * This row was written expecting an empty tree and got five hits. Three
     * were in `packages/daemon/test/launchctl.spec.ts` — this scenario's own
     * new file, whose header quoted the literals it was explaining — and
     * those were not exempted. That file was rewritten to describe them, the
     * same resolution `packages/cli/test/helpers/transcript-lint.ts` took
     * for the operator-identity arm an hour earlier. A guard's documentation
     * is inside the guard's scan, and the fix is to stop quoting, never to
     * stop scanning.
     *
     * The other two are real and pre-date the ban by three slices. s5 Sc 12
     * shipped `@wemessage/adapter-sol`, a bridge to the operator's own agent,
     * and its whole documented promise is that not one line of that agent's
     * repository changes. A package that exists to talk to a thing has to be
     * able to name the thing. Deleting the ban would give up the row; adding
     * `packages/adapters/sol/` to `LAUNCHD_ROOTS`' complement would blind the
     * sweep to an entire package. So the carriers are ENUMERATED, and each
     * one is constrained twice over:
     *
     *  - it may spell exactly ONE of the ten (`sol` + `-agent`, the agent's
     *    name), never `com.` + `user.`, never a killing verb, never the
     *    system daemons directory; and
     *  - every hit must be inside a COMMENT. `codeOf` strips comments and
     *    keeps string literals, so a hit that survives `codeOf` is a hit in
     *    a value — an argument, a label, a path — and that is exactly the
     *    shape the ban exists to prevent. The adapter may TALK about the
     *    operator's agent. It may not ADDRESS it.
     *
     * Both legs are asserted non-vacuously: the carrier list is proved
     * non-empty and proved to be exactly what the sweep finds, so a third
     * carrier appearing anywhere is a failing diff rather than a silent
     * addition.
     */
    const LAUNCHD_CARRIERS: ReadonlyArray<
      readonly [string, readonly string[]]
    > = [
      ['packages/adapters/sol/src/index.ts', [`sol${'-agent'}`]],
      [
        'packages/adapters/sol/test/sol-adapter.contract.spec.ts',
        [`sol${'-agent'}`],
      ],
    ];

    it('no tracked file under the product roots names one, except two', () => {
      const carriers = LAUNCHD_CARRIERS.map(([f]) => f);
      expect(
        launchdOffenders().filter(
          (o) => !carriers.some((c) => o.startsWith(`${c}:`)),
        ),
      ).toEqual([]);
    });

    it('the two carriers are enumerated, and each is doubly constrained', () => {
      // Non-vacuity: the exemption is a list of files that really do carry a
      // hit, not a list somebody could pad.
      expect(LAUNCHD_CARRIERS.length).toBeGreaterThan(0);
      const hit = new Map<string, Set<string>>();
      for (const o of launchdOffenders()) {
        const file = o.slice(0, o.indexOf(':'));
        const verb = o.slice(o.lastIndexOf(': ') + 2);
        let set = hit.get(file);
        if (set === undefined) {
          set = new Set<string>();
          hit.set(file, set);
        }
        set.add(verb);
      }
      // Equality, not containment: exactly these files, exactly these verbs.
      expect([...hit.keys()].sort()).toEqual(
        LAUNCHD_CARRIERS.map(([f]) => f).sort(),
      );
      for (const [file, permitted] of LAUNCHD_CARRIERS) {
        expect([...(hit.get(file) ?? [])].sort(), file).toEqual(
          [...permitted].sort(),
        );
        // …and every hit is in a comment. `codeOf` keeps string literals,
        // so surviving it means the literal is in a VALUE.
        const code = codeOf(readFileSync(join(repoRoot, file), 'utf8'));
        for (const verb of permitted)
          expect(code.includes(verb), file).toBe(false);
      }
    });

    it('the sweep is not vacuous: every root that exists contributed', () => {
      const swept = sweptForLaunchd();
      expect(swept.length).toBeGreaterThan(300);
      // Which roots actually have tracked files is a fact about the tree,
      // and pinning it is what stops this row from silently becoming a
      // sweep of two directories.
      //
      // SELF-TRIP, AND IT FIRED. This list was authored WITHOUT `test/` and
      // WITHOUT `homebrew/`. `test/` could not contribute, because its only
      // tracked file was `test/arch.spec.ts` and `trackedTextFiles()` drops
      // that one file by name; `homebrew/` did not exist yet. Both roots
      // were nevertheless put into `LAUNCHD_ROOTS` on purpose, so that the
      // day a real file landed under either one it would be swept from its
      // FIRST commit rather than from the commit somebody remembered.
      //
      // Sc8 landed `test/release/notarize.spec.ts` and Sc10 landed the cask,
      // so that day arrived twice, and both times this row is what said so.
      // The old singleton assertion recorded the empty state and is replaced
      // below by the fact that outlives it: the exemption is still exactly
      // one file, and every other tracked spec under `test/` really is
      // inside the sweep rather than merely adjacent to it.
      const contributing = LAUNCHD_ROOTS.filter((r) =>
        swept.some((f) => f.startsWith(r)),
      );
      expect(contributing).toEqual([
        'packages/',
        'apps/',
        'tools/',
        'fixtures/',
        'test/',
        '.github/',
        'homebrew/',
      ]);
      const trackedUnderTest = execFileSync(
        'git',
        ['ls-files', '--', 'test/'],
        { cwd: repoRoot, encoding: 'utf8' },
      )
        .split('\n')
        .filter((f) => f.length > 0);
      // More than one, or the clause below is asserting nothing.
      expect(trackedUnderTest.length).toBeGreaterThan(1);
      // Restricted to `.ts` so that the sweep's binary-extension policy
      // cannot quietly move a file out of this comparison. A second name
      // added to `trackedTextFiles()`' exclusion list shows up right here,
      // carrying its own path.
      expect(
        trackedUnderTest.filter((f) => f.endsWith('.ts') && !swept.includes(f)),
      ).toEqual(['test/arch.spec.ts']);
    });

    it('PLANTED: a .sh under apps/desktop/scripts naming the verb fails', () => {
      const rel = s9Plant(
        'apps/desktop/scripts/__s9_probe__.sh',
        `#!/bin/sh\nlaunchctl kick${'start'} gui/501/sh.wemessage.gateway\n`,
        true,
      );
      expect(sweptForLaunchd()).toContain(rel);
      expect(launchdOffenders()).toContain(`${rel}:2: kickstart`);
    });

    it('PLANTED: a comment, not code, is enough to fail it', () => {
      // The sweep reads BYTES, deliberately. `codeOf` exists two hundred
      // lines up and is the right tool for "what does this file do"; it is
      // the wrong tool here, because the danger is a maintainer reading a
      // comment that suggests the verb, then typing it.
      const rel = s9Plant(
        'apps/desktop/scripts/__s9_probe__note.ts',
        `// a note that mentions p${'kill'} in passing\nexport const x = 1;\n`,
        true,
      );
      expect(launchdOffenders()).toContain(`${rel}:1: pkill`);
    });

    it('NEAR-MISS: the verbs the product actually uses do not trip it', () => {
      // `bootout`, `bootstrap`, `enable`, `disable` and a label in this
      // project's own reverse-DNS namespace are the entire vocabulary the
      // runner needs, and none of them is on the list. A ban that also
      // caught the legitimate replacement would be a ban somebody widened.
      const rel = s9Plant(
        'apps/desktop/scripts/__s9_probe__ok.sh',
        [
          '#!/bin/sh',
          'launchctl bootout gui/501/sh.wemessage.gateway || true',
          'launchctl bootstrap gui/501 "$PLIST"',
          'launchctl enable gui/501/sh.wemessage.gateway',
          'launchctl print gui/501/sh.wemessage.gateway',
          '',
        ].join('\n'),
        true,
      );
      expect(sweptForLaunchd()).toContain(rel);
      expect(launchdOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
    });

    it('the arch spec is the sweep\u2019s ONLY exemption', () => {
      const notText = /\.(bin|blob|db|png|ico|jpg|jpeg|gif|pdf|zip|woff2?)$/;
      const all = execFileSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0)
        .filter((f) => !notText.test(f));
      const swept = new Set(trackedTextFiles());
      expect(all.filter((f) => !swept.has(f))).toEqual(['test/arch.spec.ts']);
    });

    it('and the exempt file\u2019s own hits are enumerated, not counted', () => {
      // An exact expected LIST, not a count: a count goes green the moment
      // somebody deletes a verb from the guard and adds a use of it
      // somewhere else in this file, which is the one edit the exemption
      // makes possible. The read is "every banned literal is spelled here,
      // and nothing else in the tree spells any of them".
      const self = readFileSync(join(repoRoot, 'test/arch.spec.ts'), 'utf8');
      expect(LAUNCHD_BANNED.filter((v) => self.includes(v))).toEqual([
        ...LAUNCHD_BANNED,
      ]);
    });
  });

  /* ── row 5: exactly one file may spawn launchctl ───────────────────── */

  /**
   * The plan says to grep for `'launchctl'` string literals across the `src`
   * trees and assert the runner is the only hit. Kept as written, with one
   * sharpening: the grep runs over `codeOf`, not raw bytes.
   *
   * That is the opposite of the choice row 4 makes one row up, and the two
   * are not in tension. Row 4 is about a word a maintainer might COPY, so it
   * reads comments. This row is about what a module DOES, so it reads code —
   * and a prose sweep here would convict the most careful file in the tree,
   * which is the self-trip s8 Sc 14 was warned about and hit.
   */
  describe('row 5: one runner, and it is the only thing that names the tool', () => {
    const RUNNER = 'packages/daemon/src/launchd/launchctl.ts';
    /**
     * The production modules allowed to compose the runner with a real spawn:
     * the PROGRAM ROOTS, DERIVED rather than listed.
     *
     * WHY THIS STOPPED BEING ONE HARDCODED PATH IN S9 Sc 4. Until Sc4 the
     * only program that needed to reach launchd was `wemessaged`, so this
     * was the string `packages/daemon/src/bin.ts` and the row was an
     * equality against it. Sc4 gives the DAEMON a reason to run one op --
     * `bootout` of its own label, when the operator disconnects -- and the
     * daemon is a different program with a different root.
     *
     * Appending a second string would have been the allowlist-widening this
     * file exists to refuse: the next program would append a third, and a
     * list that grows whenever a caller appears has stopped asserting
     * anything. So the row now asks a QUESTION instead of holding a list --
     * "is this file something the operating system actually executes?" --
     * and both answers come from artifacts outside this test:
     *
     *   1. `packages/daemon/package.json#bin`, which is what `pnpm` puts on
     *      PATH. Rename or drop `wemessaged` and this set changes with it.
     *   2. `DEV_DAEMON_MAIN_SUFFIX` in `packages/daemon/src/launchd/plist.ts`,
     *      which is the script the generated LaunchAgent plist executes.
     *      That constant is not decoration: `plist.ts` validates real
     *      `ProgramArguments` against it, so a daemon entrypoint that moved
     *      would break installation long before it reached this row.
     *
     * A file that is neither on PATH nor named by a plist is not a program
     * root, and importing the runner from it is still exactly as forbidden
     * as it was before this scenario.
     */
    const PROGRAM_ROOTS: string[] = (() => {
      const distToSrc = (dist: string): string =>
        `packages/daemon/src/${basename(dist).replace(/\.js$/, '.ts')}`;

      const pkg = JSON.parse(
        readFileSync(
          join(repoRoot, 'packages', 'daemon', 'package.json'),
          'utf8',
        ),
      ) as { bin?: Record<string, string> };
      const binTargets = Object.values(pkg.bin ?? {});

      const plistSrc = s9Read('packages/daemon/src/launchd/plist.ts');
      const suffix = /DEV_DAEMON_MAIN_SUFFIX = '([^']+)'/.exec(plistSrc);
      // No `expect` in here on purpose: this runs at COLLECTION time, where
      // a failed assertion is a file-level crash with no row name on it.
      // The non-vacuity checks are a row of their own, one down.
      if (suffix === null)
        throw new Error('DEV_DAEMON_MAIN_SUFFIX not found in plist.ts');

      return [...binTargets.map(distToSrc), distToSrc(suffix[1] ?? '')].sort();
    })();
    /**
     * The two test-side files permitted to name the tool: the lane every
     * future launchd spec goes through, and the runner's own spec.
     */
    const TEST_NAMERS = [
      'packages/daemon/test/helpers/launchd-lane.ts',
      'packages/daemon/test/launchctl.spec.ts',
    ];
    /** The lane: the one test-side file allowed to hold a spawn. */
    const LANE = 'packages/daemon/test/helpers/launchd-lane.ts';
    /** The one test-side file allowed to write the binary's name out. */
    const SPELLER = 'packages/daemon/test/launchctl.spec.ts';

    /**
     * Code with MODULE SPECIFIERS blanked.
     *
     * s9 Sc3 sharpened this, and the reason is worth stating because it is
     * the shape of a guard going wrong rather than a guard being wrong.
     *
     * `codeOf` keeps string literals, so `import … from './launchctl.js'`
     * counted as "naming the tool". That was harmless while nothing imported
     * the runner and became unsatisfiable the moment something had to: the
     * installer, the CLI and the entrypoint could not do their jobs without
     * failing this row. The available fixes were to exempt the legitimate
     * callers — a guard a legitimate caller must be exempted from is the
     * wrong guard — or to say what the row always meant. It means the
     * BINARY, not a filename. So specifiers come out, and a separate leg
     * pins who is allowed to import the runner, which the old row said
     * nothing about at all. Net: strictly stronger than what it replaced.
     */
    function withoutSpecifiers(code: string): string {
      return code
        .replace(/(\bfrom\s*)(['"])(?:[^'"\\]|\\.)*\2/g, '$1$2$2')
        .replace(/(\bimport\s*\(\s*)(['"])(?:[^'"\\]|\\.)*\2/g, '$1$2$2')
        .replace(/(\brequire\s*\(\s*)(['"])(?:[^'"\\]|\\.)*\2/g, '$1$2$2');
    }

    /** Every module specifier a file uses, as written. */
    function specifiersOf(code: string): string[] {
      const out: string[] = [];
      for (const re of [
        /\bfrom\s*(['"])((?:[^'"\\]|\\.)*)\1/g,
        /\bimport\s*\(\s*(['"])((?:[^'"\\]|\\.)*)\1/g,
        /\brequire\s*\(\s*(['"])((?:[^'"\\]|\\.)*)\1/g,
      ])
        for (const m of code.matchAll(re))
          if (m[2] !== undefined) out.push(m[2]);
      return out;
    }

    const TOOL = ['launch', 'ctl'].join('');

    /**
     * Two readings of "names the tool", because they are two different facts.
     *
     *  - `spelled`: the BINARY appears outside a module specifier. This is
     *    the file that could hand a string to `execFile`.
     *  - `mentions`: the identifier appears anywhere in code, specifiers
     *    included — so importing the runner counts.
     *
     * Production is pinned on `spelled` (plus a separate importer leg);
     * the test tree is pinned on BOTH, and `mentions` is the stricter of
     * the two there because it is the reading under which importing the
     * runner from a spec is already a hit.
     */
    function namers(inSrc: boolean, reading: 'spelled' | 'mentions'): string[] {
      const out: string[] = [];
      for (const root of ['packages', 'apps', 'tools'])
        for (const f of archFiles(root)) {
          if (f.includes('/src/') !== inSrc) continue;
          const code = codeOf(s9Read(f));
          const hay = reading === 'spelled' ? withoutSpecifiers(code) : code;
          if (hay.includes(TOOL)) out.push(f);
        }
      return [...new Set(out)].sort();
    }

    /** Files whose module specifiers point AT the runner module. */
    function runnerImporters(inSrc: boolean): string[] {
      const out: string[] = [];
      for (const root of ['packages', 'apps', 'tools'])
        for (const f of archFiles(root)) {
          if (f.includes('/src/') !== inSrc) continue;
          if (specifiersOf(codeOf(s9Read(f))).some((sp) => sp.includes(TOOL)))
            out.push(f);
        }
      return [...new Set(out)].sort();
    }

    /**
     * Files that WRITE the tool's name into another program's file instead of
     * handing it to a process.
     *
     * s9 Sc10 added the Homebrew cask renderer, and that renderer has to emit
     * an `uninstall launchctl:` stanza. It is the key Homebrew's own DSL uses
     * to unload a launch agent during `brew uninstall`, and a cask without it
     * leaves the agent running after the app it belonged to is gone. So the
     * word genuinely has to appear in what that module writes.
     *
     * It is admitted by CONDITION, not by name. Being on this list grants
     * nothing on its own: `rendererFaults` re-derives the facts that make the
     * admission safe, and a renderer that stops satisfying them fails the row
     * below carrying its own path. Those facts are that it still names the
     * tool at all, that it imports nothing and therefore has no spawner in
     * scope, that no spawn API appears in it, and that every occurrence of
     * the word is the cask stanza rather than an argv. Row 5 goes on saying
     * exactly what it always said, which is that one module can put this
     * binary on a command line.
     */
    const RENDERERS: readonly string[] = ['tools/release/src/cask.ts'];

    /** The emitted Homebrew key: the only occurrence a renderer may hold. */
    const CASK_STANZA = /^\s*uninstall launchctl: "/;

    /** Empty when `rel` may be admitted, otherwise every reason it may not. */
    function rendererFaults(rel: string): string[] {
      const code = codeOf(s9Read(rel));
      const faults: string[] = [];
      // A stale exemption is worse than no exemption: it reads as a granted
      // permission and grants a file that no longer needs it.
      if (!withoutSpecifiers(code).includes(TOOL))
        faults.push(`${rel}: no longer names the tool, so this entry is stale`);
      // Imports nothing. This is the load-bearing one. A module with no
      // module specifiers has no way to reach a child process, so it cannot
      // run the string it is writing however the string is shaped.
      for (const sp of specifiersOf(code)) faults.push(`${rel}: imports ${sp}`);
      // Belt and braces, for the day someone adds a global that does not
      // need an import to spawn.
      for (const api of ['child_process', 'execFile', 'execSync', 'spawn'])
        if (code.includes(api)) faults.push(`${rel}: holds ${api}`);
      // And the word appears only where the cask needs it. An `export const
      // CMD = 'launchctl bootout …'` handed to a caller would fail here even
      // though the renderer itself still runs nothing.
      for (const [i, line] of code.split('\n').entries())
        if (line.includes(TOOL) && !CASK_STANZA.test(line))
          faults.push(`${rel}:${i + 1}: names it outside the stanza`);
      return faults;
    }

    /** Production spellers, renderers removed. The row's real subject. */
    const spellers = (): string[] =>
      namers(true, 'spelled').filter((f) => !RENDERERS.includes(f));

    it('the renderers are admitted by a property, not by their names', () => {
      // Non-vacuity: an empty list would make the loop assert nothing while
      // the filter above went on exempting nothing, and both would be green.
      expect(RENDERERS.length).toBeGreaterThan(0);
      for (const rel of RENDERERS) {
        expect(existsSync(join(repoRoot, rel)), rel).toBe(true);
        expect(rendererFaults(rel), rel).toEqual([]);
        // Each entry is carrying weight: it really is a speller, so deleting
        // it from the list breaks the row above rather than doing nothing.
        expect(namers(true, 'spelled')).toContain(rel);
      }
    });

    it('PLANTED: a renderer that could actually run it is not admitted', () => {
      const rel = s9Plant(
        'packages/daemon/src/__s9__/renderer.ts',
        [
          "import { execFile } from 'node:child_process';",
          'export const stanza = (): string =>',
          '  `  uninstall launchctl: "sh.wemessage.gateway",`;',
          'export const go = (): void => {',
          "  execFile('launchctl', ['print', 'gui/501']);",
          '};',
          '',
        ].join('\n'),
      );
      // It emits the same stanza the real renderer does, so the shape alone
      // is not what earns the exemption. Three separate arms refuse it, and
      // each one names the file that broke it.
      const faults = rendererFaults(rel);
      expect(faults.some((f) => f.includes('imports'))).toBe(true);
      expect(faults.some((f) => f.includes('holds'))).toBe(true);
      expect(faults.some((f) => f.includes('outside the stanza'))).toBe(true);
      // And putting it on the list by name would not have saved it either:
      // the admission row above is what would fail next.
      expect(spellers()).toEqual([RUNNER, rel].sort());
    });

    it('exactly one production module names the tool', () => {
      expect(spellers()).toEqual([RUNNER]);
    });

    it('the derived program-root set is neither empty nor a wildcard', () => {
      /*
       * A derived list has a failure mode a hardcoded one does not: if the
       * derivation silently yields nothing, the equality below becomes
       * "nobody imports the runner", which PASSES while asserting nothing.
       * So the derivation is pinned from the other side too.
       */
      expect(PROGRAM_ROOTS.length).toBeGreaterThan(0);
      // Every derived entry is a real file, not a path that stopped existing.
      for (const root of PROGRAM_ROOTS)
        expect(existsSync(join(repoRoot, root))).toBe(true);
      // And it is a SET of program roots, not "every file under src".
      expect(PROGRAM_ROOTS.length).toBeLessThan(
        archFiles('packages').filter((f) => f.includes('/src/')).length,
      );
    });

    it('only PROGRAM ROOTS import that runner', () => {
      // The leg the old row did not have. "One file names the binary" says
      // nothing about who can REACH it; this says the composition happens
      // only in files the operating system actually executes, which is the
      // fact that makes the injected-spawn design hold rather than merely
      // be the current shape.
      //
      // Still an EQUALITY, and that is what keeps it a guard after S9 Sc4
      // widened the set from one file to two: a third importer fails this
      // row unless it also became something launchd or PATH runs.
      expect(runnerImporters(true)).toEqual(PROGRAM_ROOTS);
    });

    it('PLANTED: a second spawner anywhere under src is a second hit', () => {
      const rel = s9Plant(
        'packages/daemon/src/__s9__/second.ts',
        [
          "import { execFile } from 'node:child_process';",
          'export const go = (): void => {',
          "  execFile('launchctl', ['print', 'gui/501']);",
          '};',
          '',
        ].join('\n'),
      );
      expect(spellers()).toEqual([RUNNER, rel].sort());
    });

    it('PLANTED: a second production importer of the runner is a second hit', () => {
      const rel = s9Plant(
        'packages/daemon/src/__s9__/importer.ts',
        [
          "import { runLaunchctl } from '../launchd/launchctl.js';",
          'export const go = runLaunchctl;',
          '',
        ].join('\n'),
      );
      expect(runnerImporters(true)).toEqual([...PROGRAM_ROOTS, rel].sort());
      // …and it is NOT a speller, which is the whole point of blanking
      // specifiers: importing the runner and spawning the binary are
      // different facts and get different rows.
      expect(spellers()).toEqual([RUNNER]);
    });

    it('NEAR-MISS: a module that only TALKS about it is not a spawner', () => {
      s9Plant(
        'packages/daemon/src/__s9__/prose.ts',
        [
          '/**',
          ' * The supervisor never shells out to launchctl; it asks the runner.',
          ' */',
          "export const NOTE = 'see the launchd runner';",
          '',
        ].join('\n'),
      );
      expect(spellers()).toEqual([RUNNER]);
      expect(runnerImporters(true)).toEqual(PROGRAM_ROOTS);
    });

    /* ── the second leg (s9 Sc3): the TEST tree, which row 5 never read ── */

    describe('row 5, second leg: the test tree has exactly one lane', () => {
      /*
       * Everything above sweeps paths containing `/src/`, which meant the
       * test tree — the half of the repository that is about to start
       * running a real service manager against a machine that supervises the
       * operator's own agents — was unguarded. Stage 2 of this scenario makes
       * that gap load-bearing, so it closes here, before the spawner is
       * wired to anything.
       */
      it('exactly two test-side files mention the tool, and they are the lane', () => {
        expect(namers(false, 'mentions')).toEqual([...TEST_NAMERS].sort());
      });

      it('and the lane itself never SPELLS the binary', () => {
        // Stronger than the equality above, and the reason the helper is
        // safe to hand to Stage 2: it reaches launchd only through the
        // runner's exported `SERVICE_MANAGER` brand, so there is no string
        // in it that could be handed to a child process by mistake. The
        // runner's own spec spells it because asserting on the argv is its
        // whole job.
        expect(namers(false, 'spelled')).toEqual([SPELLER]);
      });

      it('and only the lane may reach a child process', () => {
        // The helper is the seam: it is the one test-side file allowed to
        // hold a spawn. A spec that grew its own `execFile` would satisfy
        // the equality above and fail here.
        const others = namers(false, 'mentions').filter((f) => f !== LANE);
        expect(others.length).toBeGreaterThan(0); // non-vacuity
        for (const f of others)
          expect(
            specifiersOf(codeOf(s9Read(f))).filter((sp) =>
              sp.includes('child_process'),
            ),
            f,
          ).toEqual([]);
      });

      it('the pinned files exist and really do mention it', () => {
        // Non-vacuity for the equality itself: a pinned list of paths that
        // no longer existed would make the sweep empty and the row would be
        // asserting that two missing files equal two missing files.
        for (const f of TEST_NAMERS) {
          expect(existsSync(join(repoRoot, f)), f).toBe(true);
          expect(codeOf(s9Read(f)).includes(TOOL), f).toBe(true);
        }
      });

      it('PLANTED: a third test file naming the tool is a third hit', () => {
        const rel = s9Plant(
          'packages/daemon/test/__s9__/rogue.spec.ts',
          [
            "import { execFile } from 'node:child_process';",
            'export const go = (): void => {',
            "  execFile('launchctl', ['bootout', 'gui/501/whatever']);",
            '};',
            '',
          ].join('\n'),
        );
        expect(namers(false, 'mentions')).toEqual([...TEST_NAMERS, rel].sort());
        expect(namers(false, 'spelled')).toEqual([SPELLER, rel].sort());
      });

      it('PLANTED: a spec that imports the runner directly is a hit too', () => {
        // The case the `spelled` reading alone would miss: no binary name
        // anywhere, just a spec helping itself to the runner instead of
        // going through the lane.
        const rel = s9Plant(
          'packages/daemon/test/__s9__/direct.spec.ts',
          [
            "import { runLaunchctl } from '../../src/launchd/launchctl.js';",
            'export const go = runLaunchctl;',
            '',
          ].join('\n'),
        );
        expect(namers(false, 'mentions')).toEqual([...TEST_NAMERS, rel].sort());
        expect(namers(false, 'spelled')).toEqual([SPELLER]);
      });

      it('NEAR-MISS: a test that goes through the lane, and one that only talks, are fine', () => {
        s9Plant(
          'packages/daemon/test/__s9__/polite.spec.ts',
          [
            '// Everything here goes through the lane; nothing shells out to',
            '// launchctl and nothing imports the runner.',
            "import { sweepOwnDir } from '../helpers/launchd-lane.js';",
            'export const sweep = sweepOwnDir;',
            '',
          ].join('\n'),
        );
        expect(namers(false, 'mentions')).toEqual([...TEST_NAMERS].sort());
        expect(namers(false, 'spelled')).toEqual([SPELLER]);
      });
    });
  });

  /* ── row 7 + row 8: the tools workspace, and the arrows that hold ──── */

  describe('rows 7 and 8: tools/ is wired in, and the old arrows still bite', () => {
    const PROBES: ReadonlyArray<readonly [string, string]> = [
      [
        'tools/release/src/__s9_probe__reach.ts',
        [
          "import { auditChainHead } from '@wemessage/core';",
          'export const x = auditChainHead;',
          '',
        ].join('\n'),
      ],
      [
        'tools/release/src/__s9_probe__ok.ts',
        [
          "import { readFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'export const read = (d: string, f: string): string =>',
          "  readFileSync(join(d, f), 'utf8');",
          '',
        ].join('\n'),
      ],
      [
        'apps/desktop/src/__s9_probe__daemon.ts',
        [
          "import { createDaemon } from '@wemessage/daemon';",
          'export const d = createDaemon;',
          '',
        ].join('\n'),
      ],
    ];
    let violations: CruiseSummary['summary']['violations'] = [];
    let cruisedSources: string[] = [];

    beforeAll(() => {
      for (const [rel, body] of PROBES) {
        const abs = join(repoRoot, rel);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, body);
      }
      const result = cruise(['packages', 'apps', 'tools']);
      violations = result.summary.violations;
      cruisedSources = result.modules.map((m) => m.source);
    }, CRUISE_BUDGET_MS);
    afterAll(() => {
      for (const [rel] of PROBES) rmSync(join(repoRoot, rel), { force: true });
    });
    const flaggedBy = (rule: string): string[] =>
      violations.filter((v) => v.rule.name === rule).map((v) => v.from);

    it('row 7: pnpm, tsc and depcruise all know tools/ exists', () => {
      expect(s9Read('pnpm-workspace.yaml')).toMatch(/^\s+-\s+'tools\/\*'$/m);
      const refs = (
        JSON.parse(s9Read('tsconfig.json')) as {
          references: Array<{ path: string }>;
        }
      ).references.map((r) => r.path);
      expect(refs).toContain('tools/release');
      const pkg = JSON.parse(s9Read('package.json')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts['dep:check']).toContain('tools');
    });

    it('row 7: the rule exists by name', () => {
      // Rule names are binding (s1-execution §1.6).
      expect(s9Read('.dependency-cruiser.cjs')).toContain(
        "name: 'tools-import-runtime-nothing'",
      );
    });

    /**
     * s7 Sc 11 (a) pins the top-level directory list precisely so that a new
     * one cannot arrive without somebody answering its six questions out
     * loud. `tools/` is the first new one since `skills/`, and this row is
     * the answer. The list in (a) was extended only after these passed.
     *
     * Where `skills/` answered "no compiled code, so `tsc` and `dep:check`
     * correctly do not reach it", `tools/` answers the opposite on every
     * one of those, which is why row 7 is a wiring row rather than a note.
     */
    it('row 7 (blind spot): tools/ answers the six questions skills/ had to', () => {
      const trackedTools = execFileSync('git', ['ls-files', '--', 'tools/'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0);
      // (1) Non-vacuity, then the public sweep reaches every one of them.
      expect(trackedTools.length).toBeGreaterThan(0);
      const swept = new Set(trackedTextFiles());
      expect(trackedTools.filter((f) => !swept.has(f))).toEqual([]);

      // (2) Neither formatter nor linter is configured to skip it. An
      // ignore entry is the cheapest way to lose a directory.
      const ignored = readFileSync(join(repoRoot, '.prettierignore'), 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
      expect(ignored.filter((l) => l.startsWith('tools'))).toEqual([]);
      const ignores =
        /ignores:\s*\[([^\]]*)\]/.exec(
          readFileSync(join(repoRoot, 'eslint.config.js'), 'utf8'),
        )?.[1] ?? '';
      expect(ignores).not.toContain('tools');

      // (3) It DOES carry compiled code — the opposite of `skills/` — so
      // the answer to "does tsc need to reach it" is yes, and the project
      // reference asserted above is what makes that true.
      expect(
        trackedTools.filter((f) => f.endsWith('.ts')).length,
      ).toBeGreaterThan(0);

      // (4) The launchd sweep reaches it. This is the root that matters
      // most for row 4: the release lane is the first code in this tree
      // with a reason to write a launchd verb down.
      expect(swept.has('tools/release/src/index.ts')).toBe(true);
    });

    it('row 7 PLANTED: a release tool reaching a workspace package violates', () => {
      expect(
        flaggedBy('tools-import-runtime-nothing'),
        `violations seen: ${JSON.stringify(violations)}`,
      ).toContain('tools/release/src/__s9_probe__reach.ts');
    });

    it('row 7 NEAR-MISS: node builtins and relative paths are the point', () => {
      // The rule's whole reason for existing is that a broken daemon build
      // must not be able to block a cask render — so the tools may read the
      // filesystem, parse YAML, and import each other, and nothing else.
      expect(
        violations.filter(
          (v) => v.from === 'tools/release/src/__s9_probe__ok.ts',
        ),
      ).toEqual([]);
    });

    it('row 8: the thin-client rule texts are byte-identical to s8', () => {
      const config = s9Read('.dependency-cruiser.cjs');
      expect(config).toContain("name: 'cli-thin-client'");
      expect(config).toContain("name: 'desktop-thin-client'");
      expect(config).toContain("'^@wemessage/(?!client$|protocol$)'");
      expect(config).toContain("pathNot: '^apps/desktop/test/'");
      expect(config).not.toContain(`cli-desktop-${'thin'}-clients`);
    });

    it('row 8 PLANTED: the supervisor must spawn the daemon, not import it', () => {
      // Sc 7's supervisor is the reason this is re-proved here rather than
      // taken on trust from s8: the scenario that adds a supervisor is the
      // scenario most tempted to reach for the daemon's factory directly.
      expect(flaggedBy('nobody-imports-daemon')).toContain(
        'apps/desktop/src/__s9_probe__daemon.ts',
      );
    });

    it('the cruise is not vacuous: it saw all three probes and the tree', () => {
      expect(
        PROBES.map(([rel]) => rel).filter(
          (rel) => !cruisedSources.includes(rel),
        ),
      ).toEqual([]);
      expect(cruisedSources.length).toBeGreaterThan(200);
    });
  });

  /* ── row 9: the desktop dependency list, extended for packaging ────── */

  describe('row 9: the §1.2 list grows by exactly the ship-era four', () => {
    interface DesktopPkg {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
    const pkg = (): DesktopPkg =>
      JSON.parse(s9Read('apps/desktop/package.json')) as DesktopPkg;
    const SHIP_DEV_ADDITIONS: readonly string[] = [
      '@electron/fuses',
      'electron-builder',
      'esbuild',
      'gifenc',
    ];

    it('devDependencies are the s8 eight plus the ship-era four', () => {
      expect(Object.keys(pkg().devDependencies ?? {}).sort()).toEqual(
        [
          '@preact/preset-vite',
          '@types/pngjs',
          'axe-core',
          'electron',
          'pixelmatch',
          'playwright-core',
          'pngjs',
          'vite',
          ...SHIP_DEV_ADDITIONS,
        ].sort(),
      );
    });

    it('dependencies did NOT grow: the renderer ships what it shipped', () => {
      // The four additions are all build-time. A packaging scenario that
      // quietly put something in `dependencies` would put it in the
      // renderer bundle, and INV-1's desktop half is that the renderer's
      // import inventory is closed.
      expect(Object.keys(pkg().dependencies ?? {}).sort()).toEqual([
        '@wemessage/client',
        '@wemessage/protocol',
        'preact',
      ]);
    });

    it('the list is not decorative: every entry is actually installed', () => {
      const p = pkg();
      const names = [
        ...Object.keys(p.dependencies ?? {}),
        ...Object.keys(p.devDependencies ?? {}),
      ];
      expect(names.length).toBe(15);
      expect(
        names.filter(
          (n) =>
            !existsSync(
              join(repoRoot, 'apps/desktop/node_modules', n, 'package.json'),
            ),
        ),
      ).toEqual([]);
    });
  });

  /* ── row 10: the release scripts are declared and land somewhere ───── */

  /**
   * s9 Sc14 rebuilt this row, because the shape it had drifted twice in one
   * slice and both drifts were silent.
   *
   * Sc1 wrote it when all of them were stubs and asserted one thing: the body
   * contains `process.exit(2)`. Sc6 implemented `pack.mjs`, which kept
   * `process.exit(2)` for its refusal path, so the row went on passing while
   * claiming `pack:adhoc` does nothing. Sc6 patched that with a second bucket
   * split on "reaches a child process". Then Sc11 implemented `cask.mjs` and
   * Sc14 implemented `check-versions.mjs`, `release-notes.mjs` and
   * `cut-tag.mjs`, and NONE of those four spawn anything, so all four sat in
   * STUBS making the same false claim the split was added to prevent.
   *
   * The lesson is that "does it spawn" is a fact about a script's plumbing,
   * not about whether it is finished, and the row kept guessing the second
   * from the first. So the buckets no longer guess. A stub now has to SAY it
   * is a stub, in its own text, in the words its own refusal message uses,
   * and every other lane has to prove it is real in the way that lane can:
   * by driving a build, by delegating to a compiled and separately tested
   * module, or by being run right here and watched.
   *
   * The direction matters. Every arm below is a narrowing: the stub arm gained
   * a self-declaration requirement it did not have, and the implemented arms
   * gained proofs where they previously had none. Nothing was admitted by
   * being named.
   */
  describe('row 10: eight release scripts, each resolving to a real file', () => {
    const RELEASE_SCRIPTS: readonly string[] = [
      'release:notarize',
      'release:cask',
      'release:check-versions',
      'release:notes',
      'release:cut-tag',
      'pack:adhoc',
      'pack:release',
      'smoke:automated',
    ];
    const scripts = (): Record<string, string> =>
      (
        JSON.parse(s9Read('package.json')) as {
          scripts: Record<string, string>;
        }
      ).scripts;

    /** The `tools/...` path a script's command line names. */
    const pathOf = (name: string): string =>
      /(tools\/[^\s]+\.(?:mjs|js|ts|sh))/.exec(scripts()[name] ?? '')?.[1] ??
      '';
    const bodyOf = (name: string): string => s9Read(pathOf(name));

    /** The sentence a stub in this tree writes about itself. */
    const STUB_SELF_DECLARATION = 'not implemented yet (';
    const SPAWN_SHAPE =
      /\b(spawnSync|execFileSync|execSync|spawn|execFile)\s*\(/;

    /** Announces itself as unfinished, and does nothing else. */
    const STUBS: readonly string[] = ['release:notarize', 'smoke:automated'];

    /** Drives a real build through a child process. */
    const DRIVES_A_BUILD: readonly string[] = ['pack:adhoc', 'pack:release'];

    /**
     * Thin bins over a compiled module in `tools/release/src`. Running these
     * for real writes files or creates git tags, so the proof they are not
     * hollow is that they delegate to a module that has its own spec.
     */
    const DELEGATES_TO_SRC: readonly string[] = [
      'release:cask',
      'release:cut-tag',
    ];

    /**
     * Pure readers. Nothing to mock and nothing to clean up, so these are not
     * argued about, they are executed: once on input they must reject and once
     * on this tree as it stands.
     */
    const RUNS_IN_PROCESS: readonly string[] = [
      'release:check-versions',
      'release:notes',
    ];

    const BUCKETS: readonly (readonly string[])[] = [
      STUBS,
      DRIVES_A_BUILD,
      DELEGATES_TO_SRC,
      RUNS_IN_PROCESS,
    ];

    it('all eight are declared', () => {
      const have = scripts();
      expect(RELEASE_SCRIPTS.filter((s) => !(s in have))).toEqual([]);
    });

    it('the root declares no ninth release script this row does not know about', () => {
      // The other direction, and the one the old row was missing: a script
      // added to `package.json` and never added here would have been covered
      // by nothing at all. `release:notes` arrived exactly that way.
      const declared = Object.keys(scripts()).filter((n) =>
        /^(?:release|pack|smoke):/.test(n),
      );
      expect(declared.sort()).toEqual([...RELEASE_SCRIPTS].sort());
    });

    it('every one of them points at a file that exists', () => {
      // A script naming a path that is not there is a script that fails at
      // 3am with `MODULE_NOT_FOUND` instead of at review time.
      const have = scripts();
      const missing: string[] = [];
      for (const name of RELEASE_SCRIPTS) {
        const cmd = have[name] ?? '';
        const path = pathOf(name);
        if (path.length === 0) missing.push(`${name}: no file in ${cmd}`);
        else if (!existsSync(join(repoRoot, path)))
          missing.push(`${name}: ${path} does not exist`);
      }
      expect(missing).toEqual([]);
    });

    it('the four buckets partition the eight, with nothing in two or in none', () => {
      expect(BUCKETS.flat().sort()).toEqual([...RELEASE_SCRIPTS].sort());
      // Pairwise, so a failure names the two buckets that overlap instead of
      // printing two eight-element arrays side by side.
      for (const [i, a] of BUCKETS.entries())
        for (const b of BUCKETS.slice(i + 1))
          expect(a.filter((n) => b.includes(n))).toEqual([]);
    });

    it('the stubs say they are stubs, and refuse loudly rather than no-op', () => {
      // Exit 2, not 0. A release script that is a no-op is the single most
      // dangerous shape in this list: `pnpm release:notarize && ship` would
      // ship an unnotarised app and report success.
      for (const name of STUBS) {
        const body = bodyOf(name);
        expect(body, `${name} does not declare itself unfinished`).toContain(
          STUB_SELF_DECLARATION,
        );
        expect(body, name).toContain('process.exit(2)');
        expect(
          SPAWN_SHAPE.test(body),
          `${name} spawns, so it is no longer a stub`,
        ).toBe(false);
        expect(
          body.includes('../dist/'),
          `${name} imports compiled work, so it is no longer a stub`,
        ).toBe(false);
      }
    });

    it('no implemented lane still describes itself as unfinished', () => {
      // The drift that got past this row twice, stated directly. A lane that
      // has been built and whose header still says "not implemented yet" is
      // either a lie in the tree or a lane that was never finished, and both
      // are worth a red test.
      for (const name of RELEASE_SCRIPTS.filter((n) => !STUBS.includes(n)))
        expect(bodyOf(name), `${name} still calls itself a stub`).not.toContain(
          STUB_SELF_DECLARATION,
        );
    });

    it('the build drivers actually drive a build, and still refuse loudly', () => {
      for (const name of DRIVES_A_BUILD) {
        const body = bodyOf(name);
        // The refusal path does not go away when the happy path arrives: a
        // release lane with no certificate has to fail, not degrade.
        expect(body, name).toContain('process.exit(2)');
        expect(
          /\b(spawnSync|execFileSync)\s*\(/.test(body),
          `${name} must drive a real build`,
        ).toBe(true);
      }
    });

    it('the delegating bins really delegate, to a module that exists in src', () => {
      for (const name of DELEGATES_TO_SRC) {
        const body = bodyOf(name);
        const imported = [
          ...body.matchAll(/from '\.\.\/dist\/([\w.-]+)\.js'/g),
        ].map((m) => m[1] ?? '');
        expect(
          imported.length,
          `${name} imports nothing from ../dist`,
        ).toBeGreaterThan(0);
        for (const mod of imported)
          expect(
            existsSync(join(repoRoot, `tools/release/src/${mod}.ts`)),
            `${name} imports ../dist/${mod}.js with no tools/release/src/${mod}.ts behind it`,
          ).toBe(true);
        // A bin that delegates has no business spawning as well: the child
        // process, if there is one, belongs in the module that is tested.
        expect(
          SPAWN_SHAPE.test(body),
          `${name} both delegates and spawns; pick one`,
        ).toBe(false);
        expect(body, `${name} has no refusal path`).toContain('process.exit(');
      }
    });

    it('the in-process lanes refuse bad input and pass this tree, for real', () => {
      for (const name of RUNS_IN_PROCESS) {
        const script = join(repoRoot, pathOf(name));

        // Arm one: it refuses. A version string nothing in the tree is at, so
        // both lanes must fail: no manifest matches it and the CHANGELOG has
        // no section for it.
        const refused = spawnSync(
          process.execPath,
          [
            script,
            '--version',
            'no-such-version',
            '--expect',
            'no-such-version',
          ],
          { encoding: 'utf8' },
        );
        expect(
          refused.status,
          `${name} accepted a version nothing in this tree is at`,
        ).not.toBe(0);
        expect(
          refused.stderr.trim().length,
          `${name} failed silently`,
        ).toBeGreaterThan(0);

        // Arm two: it is not merely an always-failer, which is all arm one on
        // its own would have proved. With no arguments each lane falls back to
        // the root's OWN version, so a green here is a real claim about this
        // tree: every manifest agrees on a version, and the CHANGELOG has a
        // non-empty section for it. No version literal appears in this file,
        // which is why the row survives the next bump.
        const accepted = spawnSync(process.execPath, [script], {
          encoding: 'utf8',
        });
        expect(
          accepted.status,
          `${name} rejects this very tree: ${accepted.stderr.trim()}`,
        ).toBe(0);
      }
    });
  });

  /* ── row 11: no secret shapes, and the digests that ARE here ───────── */

  /**
   * Three of the plan's four regexes are kept exactly. The fourth is wrong
   * and the third needed a boundary.
   *
   * "a 40-hex `sha256`" is not a thing: sha256 is 64 hex, and 40 hex is
   * sha1. The tree contains ZERO 40-hex runs, so the row as written passes
   * against every possible tree and guards nothing. What the tree does
   * contain is 64-hex, in exactly three files, all of them legitimate: pip's
   * `--hash=sha256:` pins, and two audit-chain specs that assert a known
   * digest. A ban with three exemptions is the wrong guard, so the shape is
   * inverted — the row ENUMERATES which files may carry a digest and asserts
   * the set is exactly those three. A fourth carrier is then a diff somebody
   * has to argue, which is what the plan wanted and could not get from a ban.
   *
   * `/[0-9A-Z]{10}\b.*issuer/i` needed the `i` split off the key-id class
   * and a `(?![a-z])` after `issuer`. As written it matches
   * `deps.issueRequest` — `issueR` is `issuer` case-insensitively — and the
   * daemon has six of those. It survives at HEAD only because none of them
   * happens to have ten alphanumerics in front of it on the same line, which
   * is a guard held up by luck.
   */
  describe('row 11: nothing shaped like a signing credential', () => {
    const SECRET_SHAPES: ReadonlyArray<{
      readonly name: string;
      readonly re: RegExp;
    }> = [
      { name: 'PEM block', re: /-----BEGIN / },
      {
        name: 'App Store Connect key file',
        re: new RegExp(`Auth${'Key'}_[A-Z0-9]{10}\\.p8`),
      },
      {
        name: 'key id beside an issuer',
        re: /\b[0-9A-Z]{10}\b.*\b[Ii]ssuer(?![a-z])/,
      },
    ];
    const DIGEST_CARRIERS: readonly string[] = [
      'packages/adapters/hermes/plugin/requirements.txt',
      'packages/core/test/audit-chain-core.spec.ts',
      'packages/store/test/audit-chain.spec.ts',
    ];
    const HEX64 = /\b[0-9a-f]{64}\b/;

    function secretOffenders(): string[] {
      const out: string[] = [];
      for (const f of trackedTextFiles()) {
        const text = readFileSync(join(repoRoot, f), 'utf8');
        for (const shape of SECRET_SHAPES)
          if (shape.re.test(text)) out.push(`${f}: ${shape.name}`);
      }
      return out.sort();
    }

    it('no tracked file carries a signing-credential shape', () => {
      expect(secretOffenders()).toEqual([]);
    });

    it('PLANTED: a .p8 key, a PEM block and an issuer line all fail', () => {
      const probes: ReadonlyArray<readonly [string, string, string]> = [
        [
          'tools/release/__s9_probe__key.txt',
          `Auth${'Key'}_ABC1234567.p8\n`,
          'App Store Connect key file',
        ],
        [
          'tools/release/__s9_probe__pem.txt',
          `-----${'BEGIN'} PRIVATE KEY-----\n`,
          'PEM block',
        ],
        [
          'tools/release/__s9_probe__asc.txt',
          'KEY_ID=ABCD123456 issuer_id=00000000-0000-0000-0000-000000000000\n',
          'key id beside an issuer',
        ],
      ];
      for (const [rel, body, name] of probes) {
        s9Plant(rel, body, true);
        expect(secretOffenders(), rel).toContain(`${rel}: ${name}`);
      }
    });

    it('NEAR-MISS: `deps.issueRequest` is not a signing credential', () => {
      // The exact false positive the plan's regex has, written out so the
      // fix cannot be reverted by somebody restoring the plan's text.
      const rel = s9Plant(
        'tools/release/__s9_probe__near.ts',
        [
          'const somethingLong = { issueRequest: (r: string): string => r };',
          'export const go = somethingLong.issueRequest;',
          '',
        ].join('\n'),
        true,
      );
      expect(secretOffenders().filter((o) => o.startsWith(rel))).toEqual([]);
      // and the sweep DID read it, so the emptiness is a verdict:
      expect(trackedTextFiles()).toContain(rel);
    });

    /**
     * s9 admits a second KIND of 64-hex run rather than a longer list of
     * names: the all-zero placeholder, and only that.
     *
     * Two files earned the shape in this era and neither carries a value.
     * The notary-log fixture has to look like real `notarytool log` output
     * and that output has a `sha256` field; the rendered Homebrew cask has
     * to have a `sha256` field before a release exists to fill it in. Adding
     * those two names to the list above would have been the widening this
     * row exists to prevent, and worse, it would then have licensed a REAL
     * digest pasted into either of them forever. Naming the VALUE does not:
     * one non-zero run in the same file moves that file straight back onto
     * the strict side, carrying the name that did it.
     */
    const NULL_DIGEST = '0'.repeat(64);

    /** True when every 64-hex run in `text` is that placeholder. */
    const onlyNullDigests = (text: string): boolean =>
      [...text.matchAll(/\b[0-9a-f]{64}\b/g)].every(
        (m) => m[0] === NULL_DIGEST,
      );

    it('a 64-hex digest lives in exactly three files, all of them earned', () => {
      const carriers = trackedTextFiles()
        .filter((f) => HEX64.test(readFileSync(join(repoRoot, f), 'utf8')))
        .sort();
      const placeholders = carriers.filter((f) =>
        onlyNullDigests(readFileSync(join(repoRoot, f), 'utf8')),
      );
      expect(carriers.filter((f) => !placeholders.includes(f))).toEqual(
        [...DIGEST_CARRIERS].sort(),
      );
      // Non-vacuity: the placeholder arm is an ARM, not a hole. It accepted
      // at least one file, and it is proved to reject a real digest and to
      // reject a file that holds one real digest beside the placeholder.
      expect(placeholders.length).toBeGreaterThan(0);
      expect(onlyNullDigests(`  sha256 "${NULL_DIGEST}"`)).toBe(true);
      expect(onlyNullDigests(`  sha256 "${'a'.repeat(64)}"`)).toBe(false);
      expect(onlyNullDigests(`"${NULL_DIGEST}" and "${'b'.repeat(64)}"`)).toBe(
        false,
      );
    });

    /**
     * SELF-TRIP, recorded rather than quietly fixed.
     *
     * This row was written as "the tree contains no 40-hex run at all", and
     * that was TRUE when it was written and FALSE by the time row 3 landed
     * four hours later. Row 3's decoders are proved against real PNG and GIF
     * bytes pasted as hex, and `prettier` wraps those literals at eighty
     * columns — which, for a quoted hex string indented four levels, is a
     * chunk of exactly forty characters. The row convicted its own slice's
     * fixtures, and it convicted them for a formatting reason.
     *
     * The two cheap ways out are both wrong. Re-wrapping the fixture into
     * 38-character chunks makes the guard pass by editing the thing it is
     * pointed at, which is the definition of dodging a ban. Deleting the row
     * gives up a real question — a signing digest pasted into the tree is
     * exactly the kind of thing a ship slice leaks.
     *
     * So the row is STRENGTHENED into the shape the 64-hex arm above already
     * uses, plus one property the 64-hex arm cannot state: a permitted
     * 40-hex run must be a SLICE of a longer raster byte blob that this
     * project decodes, never a standalone value. A pasted sha1 digest is a
     * standalone value and still fails, in the one file that is allowed to
     * contain forty hex characters at all.
     */
    const HEX40_CARRIERS: readonly string[] = [
      'apps/desktop/test/tokens.spec.ts',
    ];

    /**
     * SELF-TRIP, THE SECOND, and the same repair as the first.
     *
     * s9 Sc9 pins every third-party action to a commit SHA, because a
     * mutable tag is how `tj-actions/changed-files` shipped an attacker's
     * code into every workflow that referenced it in March 2025, and the
     * release job here holds `contents: write`. A commit SHA is forty hex
     * characters. So the security control this slice adds and the ban this
     * row enforces are the same forty characters, and one of them had to
     * give.
     *
     * Neither does. The workflow files are admitted by CONDITION: a 40-hex
     * run inside one of them must be the commit half of a pinned `uses:`, on
     * a line that also carries the human-readable version it was resolved
     * from. `test/release/workflows.spec.ts` row 8 requires that shape from
     * the other direction, so the claim is made twice by two readers. A
     * checksum line, an Apple key id or a digest pasted into a workflow
     * still fails here, and still fails carrying the line that did it.
     */
    const isWorkflowFile = (rel: string): boolean =>
      rel.startsWith('.github/workflows/') &&
      (rel.endsWith('.yml') || rel.endsWith('.yaml'));

    /** Not `/g`: `.test` on a global regex advances `lastIndex`. */
    const HEX40_PINNED =
      /^\s*(?:-\s*)?uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s*#\s*v\d+\.\d+\.\d+\s*$/;
    /** `Buffer.from('..' + '..', 'hex')` — the chunks, re-joined. */
    function hexBlobs(text: string): string[] {
      const out: string[] = [];
      for (const m of text.matchAll(
        /Buffer\.from\(\s*((?:'[0-9a-f]*'\s*\+?\s*)+),\s*'hex'/g,
      ))
        out.push(
          [...(m[1] ?? '').matchAll(/'([0-9a-f]*)'/g)]
            .map((q) => q[1] ?? '')
            .join(''),
        );
      return out;
    }
    /** PNG, GIF87a/89a, ICNS — the three the decoders read. */
    const RASTER_MAGIC = [
      '89504e47',
      '474946383961',
      '474946383761',
      '69636e73',
    ];

    it('a 40-hex run appears only as a slice of a decodable raster', () => {
      // NOT a `/g` regex reused across the filter: `RegExp.test` on a global
      // regex advances `lastIndex` and would skip every other file.
      const carriers = trackedTextFiles()
        .filter((f) =>
          /\b[0-9a-f]{40}\b/.test(readFileSync(join(repoRoot, f), 'utf8')),
        )
        .sort();
      expect(carriers.filter((f) => !isWorkflowFile(f))).toEqual(
        [...HEX40_CARRIERS].sort(),
      );
      // The workflow arm, line by line, so a failure names the offender.
      const loose: string[] = [];
      for (const rel of carriers.filter(isWorkflowFile))
        for (const [n, line] of readFileSync(join(repoRoot, rel), 'utf8')
          .split('\n')
          .entries())
          if (/\b[0-9a-f]{40}\b/.test(line) && !HEX40_PINNED.test(line))
            loose.push(`${rel}:${n + 1}: ${line.trim()}`);
      expect(loose).toEqual([]);
      // Non-vacuity again: there ARE pinned workflows, so that arm ran.
      expect(carriers.filter(isWorkflowFile).length).toBeGreaterThan(0);
      // Non-vacuity: the carrier really does hold runs, and they really are
      // inside blobs this project can decode.
      for (const rel of HEX40_CARRIERS) {
        const text = readFileSync(join(repoRoot, rel), 'utf8');
        const runs = [...text.matchAll(/\b[0-9a-f]{40}\b/g)].map((m) => m[0]);
        expect(runs.length, rel).toBeGreaterThan(0);
        const blobs = hexBlobs(text);
        expect(blobs.length, rel).toBeGreaterThan(0);
        // Every blob is a raster, and every blob is LONGER than a digest —
        // so no blob is a digest wearing a `Buffer.from` costume.
        for (const blob of blobs) {
          expect(
            RASTER_MAGIC.some((magic) => blob.startsWith(magic)),
            `${rel}: blob starts ${blob.slice(0, 16)}`,
          ).toBe(true);
          expect(blob.length, `${rel}: blob length`).toBeGreaterThan(40);
        }
        // …and every 40-run in the file is a slice of one of them.
        for (const run of runs)
          expect(
            blobs.some((b) => b.includes(run)),
            `${rel}: ${run.slice(0, 12)}… is not inside a raster blob`,
          ).toBe(true);
      }
    });

    it('PLANTED: a bare sha1-shaped digest is an offender even in the carrier', () => {
      // The property the enumeration buys: being on the carrier list is not
      // a licence to hold a digest, because the list admits SLICES OF A
      // BLOB and a digest is not one.
      const digest = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      const blobs = hexBlobs(
        `const X = Buffer.from('89504e470d0a1a0a' + '0000000d49484452', 'hex');`,
      );
      expect(blobs).toEqual(['89504e470d0a1a0a0000000d49484452']);
      expect(blobs.some((b) => b.includes(digest))).toBe(false);
      // …and a file that is not on the carrier list fails on sight.
      const rel = s9Plant(
        'tools/release/__s9_probe__sums.txt',
        `${digest}  WeMessage.dmg\n`,
        true,
      );
      expect(
        trackedTextFiles()
          .filter((f) =>
            /\b[0-9a-f]{40}\b/.test(readFileSync(join(repoRoot, f), 'utf8')),
          )
          .filter((f) => !HEX40_CARRIERS.includes(f) && !isWorkflowFile(f)),
      ).toEqual([rel]);
    });

    it('PLANTED: the workflow arm admits a PIN and nothing else', () => {
      // The condition is the entire reason `.github/workflows` may hold
      // forty hex characters, so it is proved directly rather than trusted.
      const sha = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      expect(
        HEX40_PINNED.test(`      - uses: actions/checkout@${sha} # v4.4.0`),
      ).toBe(true);
      // No version comment: pinned, but unreviewable at a glance.
      expect(HEX40_PINNED.test(`      - uses: actions/checkout@${sha}`)).toBe(
        false,
      );
      // A tag name is not a version.
      expect(
        HEX40_PINNED.test(`      - uses: actions/checkout@${sha} # main`),
      ).toBe(false);
      // And the two shapes this ban is actually about.
      expect(HEX40_PINNED.test(`      # ${sha}  WeMessage.dmg`)).toBe(false);
      expect(HEX40_PINNED.test(`          key: ${sha}`)).toBe(false);
    });
  });

  /* ── row 12: the transport surface did not move ────────────────────── */

  /**
   * The plan says the last-update comment is `#23`. It is `#24`, minted in
   * s8 Sc 3 when the four `draft.*` lifecycle emit sites were wired and
   * `UNEMITTED_WS_EVENTS` was forced back to `[]`. The plan was written
   * before Sc 3 landed. `#25` has never existed and this scenario must not
   * mint one: S9 ships the product, it does not extend the wire.
   */
  describe('row 12: the ratchet reads #24, and S9 does not bump it', () => {
    const RATCHET = 'packages/daemon/test/transport-surface.snapshot.ts';
    /** Every deliberate-update number, in either spelling the file uses. */
    function deliberateUpdates(text: string): number[] {
      const out: number[] = [];
      for (const m of text.matchAll(
        /(?:#(\d+)\s+deliberate|deliberate\s+update\s+#(\d+))/gi,
      ))
        out.push(Number(m[1] ?? m[2]));
      return [...new Set(out)].sort((a, b) => a - b);
    }

    it('the S8-close counts are unchanged', () => {
      expect(ROUTE_TABLE.length).toBe(67);
      expect(WS_EVENT_VOCABULARY.length).toBe(21);
      expect(GATEWAY_EVENT_NAMES.length).toBe(21);
      expect(EMITTED_WS_EVENTS.length).toBe(21);
      expect(UNEMITTED_WS_EVENTS).toEqual([]);
      expect(PORT_IMPORTER_ALLOWLIST.length).toBe(15);
      // `Object.keys`, not `.length`: `FRAME_SPECS` is a KEY TABLE, not an
      // array, and `.length` on it is `undefined` — an assertion that would
      // have failed for a reason that has nothing to do with the wire.
      expect(Object.keys(FRAME_SPECS).length).toBe(9);
    });

    it('the highest deliberate update is #24 and #25 was never minted', () => {
      const seen = deliberateUpdates(s9Read(RATCHET));
      expect(Math.max(...seen)).toBe(24);
      expect(seen).not.toContain(25);
    });

    it('the extractor is not vacuous: it finds numbers, and it finds #25', () => {
      // A regex that matched nothing would make both assertions above pass
      // for the wrong reason — the "filter predicate that matches nothing"
      // shape. Proved against the real file and against a synthetic bump.
      const seen = deliberateUpdates(s9Read(RATCHET));
      expect(seen.length).toBeGreaterThan(5);
      expect(seen).toContain(23);
      expect(
        deliberateUpdates('// #25 deliberate (s9 Scenario 1): a new route.'),
      ).toEqual([25]);
      expect(
        deliberateUpdates(' * Deliberate update #25, s9 Scenario 1.'),
      ).toEqual([25]);
    });
  });

  /* ── row 13: docs/ is never staged ─────────────────────────────────── */

  it('row 13: git tracks nothing under docs/', () => {
    // S8 gate 14, promoted from a close-of-slice check to a row so that it
    // runs on every `pnpm test` rather than once a slice. `docs/` is the
    // planning tree: it names the operator, the machine, and every decision
    // that has not been made yet, and this repository is public.
    const tracked = execFileSync('git', ['ls-files', '--', 'docs/'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.length > 0);
    expect(tracked).toEqual([]);
    /*
     * Non-vacuity: the tree KNOWS about `docs/`, so an empty result above is
     * a fact about the INDEX rather than about a directory that happens not
     * to exist.
     *
     * This used to be `existsSync(join(repoRoot, 'docs'))`, and that probe
     * was false on every fresh clone for exactly the reason this row exists:
     * `docs/` is ignored, so it is never cloned. The row therefore passed on
     * the machine that has the directory and failed on every CI runner, which
     * is the worst possible arrangement -- a guard that is red where nobody
     * can act on it and green where the mistake would be made.
     *
     * `git check-ignore -q` exits 0 iff a rule would ignore the path. That is
     * the same fact the old probe was reaching for, and it holds in a
     * checkout that never had the directory at all.
     */
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', 'docs/anything'], {
        cwd: repoRoot,
        stdio: 'ignore',
      }),
    ).not.toThrow();
    /*
     * ANCHORED, and the anchor is the assertion. What stood here was
     * `/^docs\/$/m`, matching the unanchored pattern this file shipped with,
     * and an unanchored `docs/` matches a directory of that name at ANY
     * depth. It silently swallowed `site/docs/`, the five published install
     * and permissions and launchd and uninstall and security pages, which
     * were therefore untrackable: `git add` refused them, CI never saw them,
     * and the site shipped with five dead links. The leading slash scopes
     * the rule to the ROOT planning tree, which is the only tree this row
     * has ever been about.
     */
    expect(s9Read('.gitignore')).toMatch(/^\/docs\/$/m);
    /*
     * The other direction, which nothing asserted before and which is the
     * half that actually regressed. A published page under `site/docs/`
     * must NOT be ignored. `check-ignore -q` exits 1 when no rule matches,
     * so this is the mirror of the non-vacuity probe above rather than a
     * restatement of it.
     */
    expect(() =>
      execFileSync('git', ['check-ignore', '-q', 'site/docs/anything'], {
        cwd: repoRoot,
        stdio: 'ignore',
      }),
    ).toThrow();
  });

  /* ── row 14: the app never starts a process ────────────────────────── */

  it('row 14: nothing under apps/desktop/src can spawn a process', () => {
    /*
     * THIS ROW EXISTS BECAUSE A TOOTH COULD NOT BE RUN, AND THAT IS THE
     * INTERESTING PART.
     *
     * Gate 9's `TN-spawn-anyway` says: in the desktop app's daemon
     * supervisor, on `installed && !running`, spawn the daemon "to be safe",
     * and watch Sc7 row 4 go red when the app's spawn and launchd's respawn
     * race and the loser reports `already running (pid N)`.
     *
     * The mutation could not be applied. There is no `daemon-supervisor.ts`,
     * there is no `daemon.app.log`, and nothing under `apps/desktop/src`
     * imports a process primitive at all. Sc7 was implemented along a seam
     * that made an app-side supervisor unnecessary, so the tooth was aimed
     * at a module the slice never wrote.
     *
     * The honest reading of that is NOT "the tooth passes". It is that the
     * invariant the tooth was protecting, launchd owns the daemon's
     * lifetime and the app never races it, held by accident rather than by
     * construction. Nothing stopped a future contributor from adding that
     * spawn; the race would simply have come back, and the row aimed at it
     * had never existed.
     *
     * So the tooth is discharged by building the guard it implies. The app
     * may ASK for a service operation over the local API, which is what the
     * wizard's install and restart buttons already do. It may not start a
     * process itself.
     */
    const desktopSrc = archFiles('apps').filter((f) =>
      f.startsWith('apps/desktop/src/'),
    );

    // Non-vacuity: an empty scan would make the assertion below trivially
    // true, and this row's whole value is that the set it scans is real.
    expect(desktopSrc.length).toBeGreaterThan(10);

    // teeth: TN-spawn-anyway (row 14): the tooth's own target does not exist,
    // so it was re-aimed at the invariant the target would have broken.
    // Importing spawn from node:child_process into main/gateway.ts listed
    // that file here, against an expected empty set. Reverted.
    const spawners = desktopSrc.filter((f) =>
      /\bfrom\s+['"](?:node:)?child_process['"]/.test(codeOf(s9Read(f))),
    );
    expect(spawners).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* s9 Sc2 — the two forward items the S8 close deferred to this slice.       */
/*                                                                           */
/* Neither is about the daemon lock. Both are about guards that have been    */
/* quietly not-guarding: a licence gate that scans three of eighteen roots,  */
/* and a dependency-cruise whose budget is vitest's default rather than a    */
/* measurement. Sc2 owns them because Sc10 is the scenario that makes the    */
/* first one bite.                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The globs under the `packages:` key of `pnpm-workspace.yaml`, in file
 * order. Sectioned rather than line-swept: pnpm 10 manifests carry other
 * list-valued keys (`onlyBuiltDependencies:`, `catalog:`) and a sweep would
 * read their entries as workspace globs.
 */
function workspaceGlobs(): string[] {
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*['"]?([^'"#\s]+)['"]?\s*(?:#.*)?$/.exec(line);
    if (m?.[1] !== undefined) globs.push(m[1]);
  }
  return globs;
}

/**
 * The only two glob shapes the derivation below understands: a literal
 * directory, or one level of `*` at the end. Everything pnpm also accepts —
 * `**`, a `!` exclusion, a brace set, a `*` in the middle — would be read as
 * a literal directory that does not exist and dropped in silence, and a
 * dropped glob is a member the licence gate never learns about. So the shape
 * is asserted rather than assumed, and an unhandled shape fails loudly.
 */
const SUPPORTED_WORKSPACE_GLOB =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*(?:\/\*)?$/;

/** Every workspace member directory, derived from `pnpm-workspace.yaml`. */
function workspacePackageDirs(): string[] {
  const globs = workspaceGlobs();
  for (const glob of globs) {
    if (!SUPPORTED_WORKSPACE_GLOB.test(glob))
      throw new Error(
        `pnpm-workspace.yaml declares '${glob}', a glob shape this ` +
          'derivation cannot expand. Teach workspacePackageDirs() the shape ' +
          'rather than letting its members skip the licence gate.',
      );
  }
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith('/*')) {
      const base = glob.slice(0, -2);
      const baseAbs = join(repoRoot, base);
      if (!existsSync(baseAbs)) continue;
      for (const entry of readdirSync(baseAbs)) {
        const rel = `${base}/${entry}`;
        if (existsSync(join(repoRoot, rel, 'package.json'))) dirs.push(rel);
      }
    } else if (existsSync(join(repoRoot, glob, 'package.json'))) {
      dirs.push(glob);
    }
  }
  return dirs.sort();
}

describe('S9 extensions (s9-execution Scenario 2: the two deferred guards)', () => {
  /* ── ratified item 2: the licence gate reaches every root ──────────────── */

  describe('licenses:check scans a root set derived from the workspace', () => {
    /**
     * `license-checker-rseidelsohn` resolves from ONE `--start` root and pnpm
     * does not hoist, so the set of licences it sees is exactly the set
     * declared by the manifests reachable from that root. Three `--start`
     * roots therefore checked three manifests' worth of dependencies and
     * called it a repository-wide GPL gate.
     *
     * Two existing rows already assert single roots by name
     * (`packages/adapter-testkit/test/pack.spec.ts` derives them from the
     * PUBLISH set; `row 10` above names `apps/desktop`). Both are true and
     * both are narrower than the tree: the publish set does not contain
     * `packages/daemon`, which is where `fastify`, `zod` and `better-sqlite3`
     * are declared, and it does not contain `tools/release`, which Sc1 gave
     * permission to import `yaml` and Sc10 will.
     *
     * This row derives the required set from `pnpm-workspace.yaml` instead,
     * so a nineteenth member added by a later scenario fails HERE rather
     * than silently inheriting an unchecked licence.
     */
    const licensesScript = (): string =>
      String(
        (
          JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>;
          }
        ).scripts?.['licenses:check'] ?? '',
      );

    it('every workspace glob is a shape the derivation can expand', () => {
      /*
       * The derivation above is the only thing standing between a new
       * workspace member and an unscanned licence. It handles a literal
       * directory and a single trailing `*`. pnpm accepts more than that,
       * and the shapes it also accepts are exactly the ones that would be
       * dropped without a word: `packages/**` resolves to no directory named
       * `**`, so it contributes nothing and every member under it becomes
       * invisible to the row below.
       */
      const globs = workspaceGlobs();
      // Non-vacuity: the sectioned read really found the packages list.
      expect(globs.length).toBeGreaterThanOrEqual(4);
      expect(globs).toContain('packages/*');
      expect(globs).toContain('fixtures');
      for (const glob of globs) expect(glob).toMatch(SUPPORTED_WORKSPACE_GLOB);
      // Both branches of the derivation are exercised by the real file, so
      // neither is dead code that could rot unnoticed.
      expect(globs.some((g) => g.endsWith('/*'))).toBe(true);
      expect(globs.some((g) => !g.endsWith('/*'))).toBe(true);
      // And the guard is real: the shapes pnpm allows and this cannot expand
      // are rejected, not quietly dropped.
      for (const bad of [
        'packages/**',
        '!packages/legacy',
        'packages/{core,cli}',
        'packages/*/src',
        'apps/*-web',
      ])
        expect(SUPPORTED_WORKSPACE_GLOB.test(bad)).toBe(false);
    });

    it('the derived root set is the workspace root plus every member', () => {
      const members = workspacePackageDirs();
      // Non-vacuity: an empty derivation would make every assertion below
      // pass without scanning anything.
      expect(members.length).toBeGreaterThan(10);
      expect(members).toContain('tools/release');
      expect(members).toContain('packages/daemon');
      expect(members).toContain('apps/desktop');
      // Every derived directory really is a package on disk.
      for (const dir of members)
        expect(existsSync(join(repoRoot, dir, 'package.json'))).toBe(true);
    });

    it('the script starts at every derived root and at the repo root', () => {
      const script = licensesScript();
      expect(script).not.toBe('');
      const starts = [...script.matchAll(/--start\s+(\S+)/g)].map((m) => m[1]);
      const expected = ['.', ...workspacePackageDirs()];
      expect(expected.length).toBeGreaterThan(10);
      expect([...starts].sort()).toEqual([...expected].sort());
    });

    it('every pass is the same allowlist gate, not a denylist', () => {
      /*
       * s1 Sc11 replaced `--failOn 'GPL;AGPL;…'` with `--onlyAllow`, and the
       * swap is the substance of this row rather than a rename of it.
       * `--failOn` is a denylist: it catches the copyleft families somebody
       * thought to name and waves through every licence nobody did, which
       * includes every licence that did not exist when the list was written.
       * `--onlyAllow` inverts the default, so an unrecognised licence is a
       * failure rather than a pass.
       *
       * What the row has always been about survives unchanged: a root added
       * without the clause would be a pass that scans and then approves
       * whatever it finds. It now also pins `--production`, because a pass
       * that dropped it would gate the wrong dependency set, and
       * `--excludePrivatePackages`, because a pass that dropped that would
       * trip over this repo's own unpublished members and get "fixed" by
       * widening the allowlist to admit them.
       */
      const script = licensesScript();
      const passes = script
        .split('&&')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(passes.length).toBe(workspacePackageDirs().length + 1);
      for (const pass of passes) {
        expect(pass).toMatch(/^license-checker-rseidelsohn\b/);
        expect(pass).toContain('--production ');
        expect(pass).toContain('--onlyAllow "$(cat licenses.allow)"');
        expect(pass).toContain('--excludePrivatePackages');
        // Gone from EVERY pass, not merely absent from the ones a reader
        // happened to scroll past.
        expect(pass).not.toContain('--failOn');
      }
    });
  });

  /* ── ratified item 1: the dependency-cruise budget is measured ─────────── */

  describe('the dependency-cruise budget is derived from a measurement', () => {
    /**
     * These rows spawn `depcruise` as a child process. vitest's per-test
     * default is 5000 ms and nobody ever chose it; the cruise grew from 776
     * to 791 modules over six slices and the rows became green-or-timeout
     * depending on what else the machine was doing. The fix is not a bigger
     * magic number, it is a budget with a recorded derivation, a lower bound
     * so that a suspiciously fast cruise is read as a broken measurement
     * rather than a win, and an enumeration so no cruising row escapes it.
     *
     * The enumeration is the part that has to be derived: a hand-kept list of
     * "rows that cruise" is a list that goes stale the first time somebody
     * adds a row. This row reads THIS file and asks which `it`/`beforeAll`
     * blocks contain a `cruise(` call, then asserts each of them carries the
     * budget as its explicit timeout.
     */
    const ownSource = (): string[] =>
      readFileSync(join(repoRoot, 'test', 'arch.spec.ts'), 'utf8').split('\n');

    /**
     * The same lines with comments and string/template literals blanked out,
     * line count preserved so every index below still names the real line.
     *
     * Written after a self-trip: the first draft scanned raw text, so a row
     * whose NAME or whose comment mentioned `cruise([...])` was counted as a
     * row that spawns depcruise. Worse, a mention on the `it(` line itself
     * was attributed to the block ABOVE it, because an opener is not less
     * than itself. A prose mention is a legitimate near-miss and flagging it
     * would be a guard a legitimate caller has to be exempted from, which is
     * the wrong guard. This is a precision fix, not a relaxation: a real
     * `cruise(` call is never inside a comment or a string, so nothing that
     * used to be caught escapes — the row below asserts the count is
     * unchanged.
     */
    const codeOnly = (lines: string[]): string[] => {
      const out: string[] = [];
      let inBlockComment = false;
      for (const line of lines) {
        let kept = '';
        let quote: string | null = null;
        for (let i = 0; i < line.length; i += 1) {
          const c = line[i] ?? '';
          const next = line[i + 1] ?? '';
          if (inBlockComment) {
            if (c === '*' && next === '/') {
              inBlockComment = false;
              i += 1;
            }
            continue;
          }
          if (quote !== null) {
            if (c === '\\') i += 1;
            else if (c === quote) quote = null;
            continue;
          }
          if (c === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
          }
          if (c === '/' && next === '/') break;
          if (c === "'" || c === '"' || c === '`') {
            quote = c;
            continue;
          }
          kept += c;
        }
        out.push(kept);
      }
      return out;
    };

    /** Line indexes (0-based) of every `it(`/`beforeAll(` opener. */
    const openerLines = (lines: string[]): number[] => {
      const out: number[] = [];
      lines.forEach((line, i) => {
        if (/^\s*(it|it\.\w+|beforeAll)\(/.test(line)) out.push(i);
      });
      return out;
    };

    /**
     * The opener a given line belongs to: the nearest one at or above it.
     * `<=`, not `<`, so a one-line `beforeAll(() => cruise([...]))` belongs
     * to itself rather than to whatever block happens to precede it.
     */
    const ownerOf = (openers: number[], line: number): number => {
      let owner = -1;
      for (const o of openers) if (o <= line) owner = o;
      return owner;
    };

    it('derives both bounds from a measurement times the ratified factor', () => {
      const src = readFileSync(join(repoRoot, 'test', 'arch.spec.ts'), 'utf8');
      /*
       * The point of this row is that neither bound is a literal. A later
       * slice that wants a bigger budget has to move the MEASUREMENT, which
       * means pasting the run that justified it into the comment block. A
       * bare `const CRUISE_BUDGET_MS = 60_000;` fails here.
       *
       * There are TWO worst-case measurements now, one per machine class,
       * because the laptop number was blown by a 3-vCPU hosted runner and a
       * single ceiling wide enough for the runner would hide a 5x regression
       * here. The shape below pins the selector as well as the arithmetic:
       * both measurement names, the factor, and exactly one environment
       * read. A third branch, or a second `process.env` in this expression,
       * fails.
       */
      expect(src).toMatch(
        /const CRUISE_BUDGET_MS =\s*\n?\s*\(process\.env\['CI'\] === undefined\s*\n?\s*\? CRUISE_WORST_MEASURED_MS\s*\n?\s*: CRUISE_WORST_MEASURED_CI_MS\) \* CRUISE_RATCHET_FACTOR;/,
      );
      expect(src).toMatch(
        /const CRUISE_NOOP_FLOOR_MS = Math\.floor\(\s*\n?\s*CRUISE_CHEAPEST_MEASURED_MS \/ CRUISE_RATCHET_FACTOR,?\s*\n?\s*\);/,
      );
      // The three measurements are literals, because measurements are.
      expect(src).toMatch(/const CRUISE_WORST_MEASURED_MS = [\d_]+;/);
      expect(src).toMatch(/const CRUISE_WORST_MEASURED_CI_MS = [\d_]+;/);
      expect(src).toMatch(/const CRUISE_CHEAPEST_MEASURED_MS = [\d_]+;/);
      // The factor is the ratified one and is not a free parameter.
      expect(CRUISE_RATCHET_FACTOR).toBe(3);
      /*
       * Both branches, evaluated here rather than only the one this process
       * happens to be in. Asserting only the live branch would mean the CI
       * arithmetic is checked on CI and the laptop arithmetic on a laptop,
       * and neither run would ever see the other half.
       */
      expect(CRUISE_BUDGET_MS).toBe(
        (process.env['CI'] === undefined
          ? CRUISE_WORST_MEASURED_MS
          : CRUISE_WORST_MEASURED_CI_MS) * CRUISE_RATCHET_FACTOR,
      );
      expect([
        CRUISE_WORST_MEASURED_MS * CRUISE_RATCHET_FACTOR,
        CRUISE_WORST_MEASURED_CI_MS * CRUISE_RATCHET_FACTOR,
      ]).toContain(CRUISE_BUDGET_MS);
      /*
       * A hosted runner is slower than this laptop, never faster. If that
       * inverts, the CI number was not measured on a runner and the split
       * has stopped meaning what its comment says it means.
       */
      expect(CRUISE_WORST_MEASURED_CI_MS).toBeGreaterThan(
        CRUISE_WORST_MEASURED_MS,
      );
      /*
       * THE RATCHET, and the row that makes the rest non-vacuous: the CI
       * measurement's own digits must appear in this file's prose on a line
       * that also names the run they came from. Bumping the constant to
       * survive a red build, without pasting the run that justified it, is
       * the exact move this fails.
       */
      const ciDigits = String(CRUISE_WORST_MEASURED_CI_MS);
      const justified = src
        .split('\n')
        .filter((line) => line.trimStart().startsWith('*'))
        .filter((line) => line.includes(ciDigits))
        .filter((line) => /\brun \d{8,}/.test(line));
      expect(
        justified.length,
        `no comment line pastes a run id beside ${ciDigits}`,
      ).toBeGreaterThanOrEqual(1);
      expect(CRUISE_NOOP_FLOOR_MS).toBe(
        Math.floor(CRUISE_CHEAPEST_MEASURED_MS / CRUISE_RATCHET_FACTOR),
      );
      expect(CRUISE_NOOP_FLOOR_MS).toBeGreaterThan(0);
      expect(CRUISE_BUDGET_MS).toBeGreaterThan(CRUISE_NOOP_FLOOR_MS);
      // The default this replaces. A budget at or below it would leave the
      // rows exactly where six slices of flake found them.
      expect(CRUISE_BUDGET_MS).toBeGreaterThan(5000);
      // The floor leaves headroom under the cheapest cruise ever measured,
      // so a slow machine cannot trip it.
      expect(CRUISE_NOOP_FLOOR_MS).toBeLessThan(CRUISE_CHEAPEST_MEASURED_MS);
      // The derivations are in the file, in prose, next to the numbers.
      expect(src).toMatch(/quiet machine/i);
      expect(src).toMatch(/a genuine no-op/i);
    });

    it('the module-count bound is the no-op detector, and it is not vacuous', () => {
      /*
       * Stated in the comment above and asserted here, because it is the
       * claim the whole budget block rests on: the TIME floor cannot tell a
       * no-op from work (a zero-module cruise costs 400 ms of startup, only
       * 50 ms under the cheapest real cruise), so the bound that catches a
       * cruise which silently read nothing is the module count.
       */
      const floor = minModulesFor(['packages', 'apps', 'fixtures']);
      // Non-vacuous: the derivation finds real sources, not an empty list.
      expect(floor).toBeGreaterThan(100);
      // A no-op returns zero modules, and zero is nowhere near the floor.
      expect(0).toBeLessThan(floor);
      // And it is derived, not pinned: it moves with the tracked tree.
      expect(minModulesFor(['packages/sendkit'])).toBeLessThan(floor);
      expect(minModulesFor(['packages/sendkit'])).toBeGreaterThan(0);
      // The measured no-op cost sits ABOVE the time floor, which is exactly
      // why the time floor cannot be the detector.
      expect(CRUISE_NOOP_FLOOR_MS).toBeLessThan(400);
    });

    it('every block that cruises carries the budget as its timeout', () => {
      const lines = ownSource();
      const code = codeOnly(lines);
      const openers = openerLines(lines);
      expect(openers.length).toBeGreaterThan(100);

      const cruising = new Set<number>();
      code.forEach((line, i) => {
        // The call sites, not the declaration, not a method of the same name,
        // and not this file's prose about them.
        if (!/(?:^|[^.\w])cruise\(\[/.test(line)) return;
        const owner = ownerOf(openers, i);
        expect(
          owner,
          `cruise() at line ${i + 1} is outside any block`,
        ).toBeGreaterThanOrEqual(0);
        cruising.add(owner);
      });

      /*
       * Two shapes, because Prettier renders the SAME argument two ways
       * depending on whether the call fits a line: `}, CRUISE_BUDGET_MS);`
       * when it does, and `CRUISE_BUDGET_MS,` on a line of its own between
       * `},` and `);` when it does not. This row is about the argument being
       * passed, not about how the formatter chose to lay it out, so it reads
       * both. Neither shape can match anything else in this file: the only
       * other mentions of the constant are its declaration, a comparison
       * inside `cruise()`, and the source-literal assertions above, and none
       * of those is a bare trailing argument.
       */
      const TIMEOUT_ARG =
        /^\s*(?:\},\s*CRUISE_BUDGET_MS\);|CRUISE_BUDGET_MS,)\s*$/;
      const budgeted = new Set<number>();
      code.forEach((line, i) => {
        if (!TIMEOUT_ARG.test(line)) return;
        budgeted.add(ownerOf(openers, i));
      });

      // Non-vacuity: this file really does cruise, in more than one block.
      expect(cruising.size).toBeGreaterThanOrEqual(8);
      /*
       * And the blanking did not blank away a call site. Every `cruise([`
       * that survives comment/string removal is a real call, and the count
       * of real calls is asserted against the raw count minus the mentions,
       * so a future prose mention cannot quietly reduce the enumeration.
       */
      const rawHits = lines.filter((l) =>
        /(?:^|[^.\w])cruise\(\[/.test(l),
      ).length;
      const codeHits = code.filter((l) =>
        /(?:^|[^.\w])cruise\(\[/.test(l),
      ).length;
      expect(codeHits).toBeGreaterThanOrEqual(14);
      expect(rawHits).toBeGreaterThanOrEqual(codeHits);
      const missing = [...cruising]
        .filter((o) => !budgeted.has(o))
        .map((o) => `${o + 1}: ${lines[o]?.trim() ?? ''}`);
      expect(
        missing,
        'these blocks spawn depcruise on vitest’s default timeout',
      ).toEqual([]);
      // And nothing carries the budget without earning it: a stray timeout
      // on a cheap row is a 30-second hang waiting to be misdiagnosed.
      const unearned = [...budgeted]
        .filter((o) => !cruising.has(o))
        .map((o) => `${o + 1}: ${lines[o]?.trim() ?? ''}`);
      expect(unearned).toEqual([]);
    });
  });
});

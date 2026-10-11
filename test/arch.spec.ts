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
  lintTranscript,
  parseSkillBlocks,
  publicStringOffenders,
} from '../packages/cli/test/helpers/transcript-lint.js';
// The capability scan the transport-surface ratchet runs. The v2 S6c
// tombstone plants an offender under `apps/` and asserts that THIS function
// sees it, which is the only honest way to claim the ratchet row would have
// failed.
import {
  PRODUCTION_SOURCE_ROOTS,
  portImporters,
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
 * The extensions the raw-control-byte sweep (s7 Sc1 (b)) reads as text.
 *
 * Moved to module scope by v2 S1, unchanged, so that the Swift tree's rows
 * ('v2 S1: the Swift tree') can assert membership against the SAME set the
 * sweep uses rather than a copy that could drift from it.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
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
  // v2 S1: apps/mac is Swift source in a public repository, so the sweeps
  // read it for the same reason they read `.py` and `.css`.
  '.swift',
]);

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
    const content = publicSweepText(f, readFileSync(join(repoRoot, f), 'utf8'));
    for (const o of publicStringOffenders(content))
      offenders.push(`${f}: ${o.detail}`);
  }
  return offenders.sort();
}

/** The all-zero adapter token the S0 contract recorder mints in place of a real one. */
const NULL_ADAPTER_TOKEN = `wm_${'0'.repeat(64)}`;

/**
 * What the public sweep reads of one tracked file. v2 S0, advisor item 5:
 * the contract recorder rewrites every minted adapter token to the NULL
 * token, so a client fixture keeps the shape it must parse and authenticates
 * nothing. That one string is exempt in that one directory. The linter is
 * not touched: the same string is still an offender in a transcript (it is
 * skill-dryrun's own tooth), and any other hex after `wm_` under
 * fixtures/contract still convicts.
 */
function publicSweepText(file: string, raw: string): string {
  return file.startsWith('fixtures/contract/')
    ? raw.split(NULL_ADAPTER_TOKEN).join('')
    : raw;
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
      // s10 Slice 2, a deliberate growth: `sending/late-verify.ts` asks
      // chat.db whether a draft parked 'unverified' landed late. It holds
      // `Pick<ChatDbReader, 'resolveChat' | 'findOutboundMessage'>` and no
      // send backend at all; the row below pins that it never gains one.
      'packages/core/src/sending/late-verify.ts',
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

    it('(a) SendBackend/ChatDbReader importers match the S3+S5+s10 baseline exactly', () => {
      expect(sendBackendChatDbReaderImporters()).toEqual(
        SEND_BACKEND_CHAT_DB_READER_BASELINE,
      );
    });

    it('s10 Sl2: late-verify.ts reads chat.db but never names SendBackend', () => {
      // verifyLate runs from the retry route and a scheduler sweep, two
      // callers that are NOT dispatchApproved. Its whole safety argument is
      // that it can only ever mark a draft sent, never put one on the wire.
      const src = readFileSync(
        join(repoRoot, 'packages/core/src/sending/late-verify.ts'),
        'utf8',
      );
      expect(src).toContain('findOutboundMessage');
      expect(src).not.toMatch(/SendBackend|\bbackend\b|\.send\(/);
    });

    /**
     * s10 Slice 4: approval binds content. What a person approved is what
     * goes out. The body changes in exactly one place, the approve
     * transition (`editedBody` inside `applyDraftTransition`); agents
     * supersede, they never edit. `Store.updateDraftBody` (pending-only) is
     * declared on the port and implemented by the store, and nothing in
     * production calls it. A caller appearing anywhere else is a new path
     * that could change a body after a human looked at it, and must arrive
     * as a reviewed diff to this list.
     */
    const UPDATE_DRAFT_BODY_FILES = [
      'packages/core/src/ports/index.ts',
      'packages/store/src/store.ts',
    ];
    function updateDraftBodyFiles(): string[] {
      return productionSrcFiles()
        .filter((f) =>
          readFileSync(join(repoRoot, f), 'utf8').includes('updateDraftBody'),
        )
        .sort();
    }

    it('s10 Sl4: updateDraftBody has no production caller beyond its port and impl', () => {
      expect(updateDraftBodyFiles()).toEqual(UPDATE_DRAFT_BODY_FILES);
    });

    it('s10 Sl4: the one send call puts draft.body on the wire, nothing else', () => {
      const src = readFileSync(
        join(repoRoot, 'packages/core/src/sending/dispatcher.ts'),
        'utf8',
      );
      const calls = src.match(/backend\.send\(\{[^}]*\}\)/g) ?? [];
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatch(/\bbody:\s*draft\.body\s*,?\s*\}/);
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

      const bodyEditProbe = join(
        repoRoot,
        'packages/daemon/src/__arch_s10_body_edit_probe__.ts',
      );

      afterEach(() => {
        rmSync(schedulerProbe, { force: true });
        rmSync(horizonProbe, { force: true });
        rmSync(autoRespondProbe, { force: true });
        rmSync(bodyEditProbe, { force: true });
      });

      it('planting an updateDraftBody caller in daemon/src fails the approval-content row (s10 Sl4)', () => {
        writeFileSync(
          bodyEditProbe,
          "import type { Store } from '@wemessage/core';\n" +
            'export function rewrite(store: Store, id: string): void {\n' +
            "  store.updateDraftBody(id, 'changed after approval', '2026-10-04T00:00:00.000Z');\n" +
            '}\n',
        );
        const found = updateDraftBodyFiles();
        expect(found).toContain(
          'packages/daemon/src/__arch_s10_body_edit_probe__.ts',
        );
        expect(found).not.toEqual(UPDATE_DRAFT_BODY_FILES);
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
    //
    // v2 S6c removed the three desktop renderer homes s8 Scenarios 12 and 13
    // added (`auditRows.ts`, `autoSendsPerHour.ts`, `peopleRows.ts`): the
    // app they lived in was deleted, and a home for a file that does not
    // exist is a row that can no longer fail.
    const DORMANT_DENY_LITERALS: ReadonlyArray<
      readonly [string, readonly string[]]
    > = [
      [
        'outside-window',
        [
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

    it('(c) the port importer allowlist is pinned at 16 files (INV-2)', () => {
      // 16 since s10 Slice 2 (#25, late-verify.ts).
      expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(16);
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
    //
    // TEXT_EXTENSIONS itself lives at module scope (next to
    // trackedTextFiles) since v2 S1, so the Swift tree's rows can ask the
    // same set this sweep reads instead of keeping a second copy of it.
    //
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
      // v2 F5: the by-handle route spec builds an SMS-only 1:1 through the
      // same fixture builder, so it too spells Apple's raw column casing on
      // the input side and asserts the normalised 'sms' on the wire.
      'packages/daemon/test/thread-by-handle-routes.spec.ts',
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
        // v2 S6c: `apps/desktop` was the only `apps/` entry this ever
        // produced, and it left with the Electron app. TYPECHECK_ROOTS keeps
        // `apps` for the same reason it held it before there was anything in
        // it: the next TypeScript app there is the one this row must see.
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
      // 16 since s10 Slice 2 (#25, late-verify.ts).
      expect(PORT_IMPORTER_ALLOWLIST).toHaveLength(16);
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
  /**
   * The docs this repo publishes beside its code. `skills/` is Sc 11's.
   *
   * RELEASING.md joined this set when it was written, rather than sitting
   * beside it as an unchecked file. It is a public document, so the rows
   * below are exactly the rows it needs: the leak sweep is the reason a
   * release procedure full of local commands does not carry somebody's home
   * directory into a public repository, and the route row is the reason the
   * endpoint it tells a releaser to poll has to be one the daemon serves.
   */
  const DOC_RE =
    /^(README\.md|CONTRIBUTING\.md|RELEASING\.md|packages\/.*\/(README|PROTOCOL)\.md)$/;
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
      // The unsigned lane's procedure, and the checklist the manual leg of
      // the release smoke is copied from.
      'RELEASING.md',
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
    // The noun set is derived from a table this suite pins at 69 rows, so it
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
  // v2 S6a. The plain-Node flavour of the same bundle, which pack-swift step 3
  // now writes to `apps/mac/dist-bundle-node`. Same argument, and the row 5
  // conviction is the same one: after a local `pack:swift`, its inlined
  // `daemon/main.mjs` reached `node:child_process` and failed the gate.
  'dist-bundle-node',
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

/* ════════════════════════════════════════════════════════════════════════ */
/* v2 S6c: the Electron app is gone, and what outlived it.                   */
/* ════════════════════════════════════════════════════════════════════════ */

describe('v2 S6c: the desktop app is deleted, not dormant', () => {
  /**
   * v2 S6c deleted `apps/desktop`, the Electron app the Swift app replaced,
   * and with it about seven thousand lines of this file: the S8 GUI-era
   * guards and the v2 A1/A2 renderer rows, every one of which read a file
   * under that tree. A guard on a deleted file is not a weaker guard, it is
   * a crash, so they went with it rather than being skipped.
   *
   * What stays is in three groups. The S8 rows that were never about the
   * GUI (the macOS lane, the wire vocabulary, the route table) are the
   * Scenario 17 block below, edited in place. The two S8 Scenario 1 rows
   * whose PREDICATE outlived the app are re-planted here on a probe instead
   * of on the app. And this describe adds the tombstone: the app is absent,
   * and nothing in a manifest can quietly bring its toolchain back.
   */
  const s6cPlanted: string[] = [];
  function s6cPlant(rel: string, body: string, intentToAdd = false): string {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
    s6cPlanted.push(rel);
    if (intentToAdd)
      execFileSync('git', ['add', '--intent-to-add', rel], { cwd: repoRoot });
    return rel;
  }
  afterEach(() => {
    for (const rel of s6cPlanted.splice(0)) {
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
    for (const dir of ['apps/__s6c_probe__'])
      rmSync(join(repoRoot, dir), { recursive: true, force: true });
  });
  const lsFiles = (...pattern: string[]): string[] =>
    execFileSync('git', ['ls-files', '--', ...pattern], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.length > 0)
      .sort();

  /* ── the tombstone ─────────────────────────────────────────────────── */

  it('apps/desktop is absent on disk and in the index', () => {
    expect(lsFiles('apps/desktop')).toEqual([]);
    expect(existsSync(join(repoRoot, 'apps/desktop'))).toBe(false);
  });

  /**
   * The Electron toolchain, by package name. A manifest that names any of
   * these is the desktop app coming back through a side door, and the
   * Swift app has no use for any of them.
   */
  const ELECTRON_TOOLCHAIN =
    /^(electron|electron-builder|vite|@vitejs\/.+|@electron\/.+)$/;
  function toolchainDeps(): string[] {
    const out: string[] = [];
    for (const rel of lsFiles('package.json', '*/package.json')) {
      const pkg = JSON.parse(archRead(rel)) as Record<string, unknown>;
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ])
        for (const name of Object.keys(
          (pkg[field] ?? {}) as Record<string, string>,
        ))
          if (ELECTRON_TOOLCHAIN.test(name))
            out.push(`${rel}: ${field}.${name}`);
    }
    return out.sort();
  }

  it('no tracked manifest depends on the Electron toolchain', () => {
    expect(
      lsFiles('package.json', '*/package.json').length,
    ).toBeGreaterThanOrEqual(17);
    expect(toolchainDeps()).toEqual([]);
    const root = JSON.parse(archRead('package.json')) as {
      pnpm?: { onlyBuiltDependencies?: string[] };
    };
    expect(
      (root.pnpm?.onlyBuiltDependencies ?? []).filter((n) =>
        ELECTRON_TOOLCHAIN.test(n),
      ),
    ).toEqual([]);
  });

  it('the predicate is not vacuous: it names a planted electron devDependency', () => {
    expect(ELECTRON_TOOLCHAIN.test('electron')).toBe(true);
    expect(ELECTRON_TOOLCHAIN.test('@electron/notarize')).toBe(true);
    expect(ELECTRON_TOOLCHAIN.test('@vitejs/plugin-react')).toBe(true);
    // LEGITIMATE NEAR-MISS: a name that merely contains the word.
    expect(ELECTRON_TOOLCHAIN.test('electron-to-chromium')).toBe(false);
    expect(ELECTRON_TOOLCHAIN.test('vitest')).toBe(false);
  });

  /* ── the word itself: an exact allowlist ────────────────────────────── */

  /**
   * Every tracked file that still names Electron, each with the reason it
   * may. EXACT, both ways: a file that starts naming it fails (the prose of
   * a deleted app creeping back in), and a file listed here that stops
   * naming it fails too, so the list can only shrink by an edit that says
   * so. S6d shrank it by seven: the doctor's runtime union, its client and
   * Swift mirrors, the fixture file and the bundle plist variable went.
   *
   * "electronic" is not a mention: the Apache LICENSE files say "any form
   * of electronic ... communication", and a guard that convicts a licence
   * text gets an exemption bolted on until it guards nothing.
   */
  const ELECTRON_WORD = /electron(?!ic)/i;
  const ELECTRON_WORD_ALLOWLIST: Readonly<Record<string, string>> = {
    // history: what shipped before, by name
    'CHANGELOG.md': 'history',
    // the guards that refuse the word have to spell it
    'test/arch.spec.ts': 'this tombstone',
    'test/release/workflows.spec.ts': 'guard: ci-macos names no electron',
    'test/release/s9-e2e.spec.ts': 'guard: ci-macos names no electron',
    'packages/daemon/test/helpers/contract-recorder.ts':
      'guard: refuses to record under process.versions.electron',
    'packages/daemon/test/launchd-lifecycle.spec.ts':
      'guard: the dev vector carries no ELECTRON_RUN_AS_NODE',
    // the host scrubs the variable and still reads an old plist's vector
    'apps/mac/Sources/WeMessageDaemonHost/HostArguments.swift':
      'migration: the legacy bundle argv a pre-Swift plist passes',
    'apps/mac/Sources/WeMessageDaemonHost/HostEnvironment.swift':
      'guard: ELECTRON_RUN_AS_NODE is scrubbed from the child env',
    'apps/mac/Tests/WeMessageDaemonHostTests/DaemonHostTests.swift':
      'migration + scrub rows',
    'apps/mac/Tests/WeMessageDaemonHostTests/HostArgumentsTests.swift':
      'migration rows',
    'apps/mac/Tests/WeMessageDaemonHostTests/HostEnvironmentTests.swift':
      'scrub rows',
    'packages/daemon/src/launchd/paths.ts':
      'migration: the bundle pair an installed pre-Swift app resolves to',
    'packages/daemon/test/launchd-paths.spec.ts': 'migration rows',
    // S5e: the human smoke upgrades a Mac that still has the v1 app
    'RELEASING.md': 'migration: the smoke step that upgrades over a v1 install',
    'test/release/releasing-s5e.spec.ts': 'migration rows: the upgrade note',
    // S6d's own guards: what the runtime union and the plist variable left
    'packages/daemon/test/doctor.spec.ts':
      'guard: doctor copy never names it; a stray versions key changes nothing',
    'packages/daemon/test/launchd-plist.spec.ts':
      'guard: no shape sets ELECTRON_RUN_AS_NODE',
  };
  function electronWordFiles(): string[] {
    // The file NAME counts as a mention too: a tracked `electron.json`
    // names the app as plainly as a sentence does.
    const out = new Set<string>(lsFiles().filter((f) => ELECTRON_WORD.test(f)));
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        ['grep', '-l', '-I', '-i', '-P', 'electron(?!ic)'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch (err) {
      // exit 1 is "no match", anything else is a real failure
      if ((err as { status?: number }).status !== 1) throw err;
    }
    for (const f of hits.split('\n')) if (f.length > 0) out.add(f);
    return [...out].sort();
  }

  it('the word electron appears only in the files allowed to name it', () => {
    expect(electronWordFiles()).toEqual(
      Object.keys(ELECTRON_WORD_ALLOWLIST).sort(),
    );
  });

  it('the word predicate is not vacuous, and spares a licence', () => {
    expect(ELECTRON_WORD.test('the Electron app')).toBe(true);
    expect(ELECTRON_WORD.test('ELECTRON_RUN_AS_NODE')).toBe(true);
    expect(ELECTRON_WORD.test('electron.json')).toBe(true);
    // LEGITIMATE NEAR-MISS: the Apache licence text.
    expect(ELECTRON_WORD.test('any form of electronic communication')).toBe(
      false,
    );
    // The allowlist is not a wildcard: README is the first surface a user
    // reads, and it is not on it.
    expect(Object.keys(ELECTRON_WORD_ALLOWLIST)).not.toContain('README.md');
  });

  /* ── v2 S6d: the runtime union and the plist variable ─────────────── */

  it('v2 S6d: ELECTRON_RUN_AS_NODE is absent from every package source', () => {
    // Tests may name it to assert its absence; no shipped source may set,
    // read or declare it. `packages/*/src` is what the daemon bundle and
    // the client are built from.
    const offenders = lsFiles().filter(
      (f) =>
        /^packages\/[^/]+(?:\/[^/]+)?\/src\//.test(f) &&
        readFileSync(join(repoRoot, f), 'utf8').includes(
          'ELECTRON_RUN_AS_NODE',
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('v2 S6d: fixtures/doctor-runtime holds the node variant and nothing else', () => {
    expect(
      lsFiles()
        .filter((f) => f.startsWith('fixtures/doctor-runtime/'))
        .sort(),
    ).toEqual(['fixtures/doctor-runtime/node.json']);
  });

  /* ── S8 Sc1 row 12, re-planted: the capability scan reaches apps/ ──── */

  it('apps is still one of the production-source roots', () => {
    // The desktop app was the only TypeScript under `apps/`. The root stays
    // anyway: the next TypeScript app is exactly the thing this scan exists
    // to catch, and a root dropped because it is empty today is a hole on
    // the day it is not.
    expect([...PRODUCTION_SOURCE_ROOTS]).toContain('apps');
    expect([...PRODUCTION_SOURCE_ROOTS]).toContain('packages');
  });

  it('PLANTED: naming SendBackend under apps/*/src breaks the allowlist row', () => {
    const rel = s6cPlant(
      'apps/__s6c_probe__/src/capability.ts',
      [
        "import type { SendBackend } from '@wemessage/core';",
        'export type Backend = SendBackend;',
        '',
      ].join('\n'),
    );
    // The RATCHET's own predicate, not a copy of it.
    const importers = portImporters();
    expect(importers).toContain(rel);
    expect(importers).not.toEqual([...PORT_IMPORTER_ALLOWLIST]);
  });

  it('LEGITIMATE NEAR-MISS: an app file naming the client is not a capability', () => {
    const rel = s6cPlant(
      'apps/__s6c_probe__/src/no-capability.ts',
      [
        "import type { GatewayClient } from '@wemessage/client';",
        'export type C = GatewayClient;',
        '',
      ].join('\n'),
    );
    expect(portImporters()).not.toContain(rel);
    expect(portImporters()).toEqual([...PORT_IMPORTER_ALLOWLIST]);
  });

  /* ── S8 Sc1 row 13, re-planted: publishable, and no PNG ────────────── */

  it('no brand string, no operator handle, no absolute home path', () => {
    expect(publicRepoOffenders()).toEqual([]);
  });

  it('the repo tracks no PNG at all', () => {
    // The one PNG S8 and s9 admitted was the DMG background, a packaging
    // input of the Electron build, and it left with that build. The list is
    // empty again, as it was through Sc 17: no golden screenshot has ever
    // been committed and none will be. Every OTHER raster is an allowlist
    // entry in `test/release/helpers/no-green-static.ts`, decoded and swept
    // pixel by pixel by `test/release/no-green.spec.ts`.
    expect(lsFiles('*.png')).toEqual([]);
  });

  it('PLANTED: a screenshot committed anywhere fails the row', () => {
    // `--intent-to-add` so the ENUMERATION half runs, not only the filter.
    const rel = s6cPlant(
      'apps/__s6c_probe__/shot.png',
      'not really a png\n',
      true,
    );
    expect(lsFiles('*.png')).toEqual([rel]);
  });

  it('LEGITIMATE NEAR-MISS: an SVG is not a raster', () => {
    const rel = s6cPlant(
      'apps/__s6c_probe__/glyph.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n',
      true,
    );
    expect(lsFiles('*.png')).not.toContain(rel);
    expect(lsFiles('*.png')).toEqual([]);
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

  /**
   * v2 S6c. The Linux gate as the macOS lane must run it, which is now the
   * Linux gate itself: the Electron provisioning steps and the xvfb wrapper
   * left with the desktop app, so there is nothing left to normalise away.
   */
  const linuxAsMacos = (text: string): string[] =>
    sc17Steps(sc17Job(text, GATE_JOB));

  it('the macOS lane runs the Linux gate, step for step', () => {
    // The failure this catches is the one a "macOS smoke job" always drifts
    // into: a lane that installs, builds, and then runs a subset. The lanes
    // are compared as SEQUENCES rather than by spot checks. Since v2 S6c
    // there is no legitimate difference left between the two step lists,
    // so any difference is a difference.
    const linux = linuxAsMacos(archRead(LINUX));
    const macos = sc17Steps(sc17Job(archRead(MACOS), GATE_JOB));
    expect(linux.length).toBeGreaterThanOrEqual(8);
    expect(macos).toEqual(linux);
    // …and the reader is not vacuous: it found the step that matters.
    expect(macos).toContain('run: pnpm test');
    expect(macos).toContain('run: pnpm build');
    expect(macos.filter((s) => s.includes('electron'))).toEqual([]);
  });

  it('`pnpm test` is the whole suite, with no project filter', () => {
    // v2 S6c. Until the desktop app left, macOS ran `test:node`, an explicit
    // list of every vitest project except the Electron ones, and a row here
    // derived that list from the configs on disk. With no Electron project
    // left there is nothing to exclude, so the list and its script are gone
    // and the one suite command runs everything. An excluded file is an
    // untested file; a filter here would be the first exclusion.
    const pkg = JSON.parse(archRead('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test']).toBe('vitest run');
    expect(pkg.scripts['test:node']).toBeUndefined();
    for (const lane of [LINUX, MACOS])
      expect(archRead(lane)).not.toContain('--project');
  });

  it('the macOS lane holds exactly the gate job', () => {
    // The readers above name their job, so they can no longer notice a job
    // that was ADDED. This row is what replaces that: the job list is closed,
    // and growing it is a reviewed diff rather than a silent one.
    const jobsIn = (text: string): string[] =>
      [...sc17Jobs(text).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] ?? '');
    // S6b removed `pack-adhoc`: the Electron bundle no longer ships.
    expect(jobsIn(archRead(MACOS))).toEqual([GATE_JOB]);
    // Linux has one job and spells its name the same way, which is the whole
    // reason the step-for-step comparison above means anything.
    expect(jobsIn(archRead(LINUX))).toEqual([GATE_JOB]);
  });

  it('runs on a real macOS runner, and Linux still runs on Linux', () => {
    // S6b: the shipped floor, macOS 26 Tahoe, and nothing older.
    expect(archRead(MACOS)).toContain('runs-on: macos-26');
    expect(archRead(MACOS)).not.toMatch(/runs-on: macos-(?!26\b)/);
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
    // "signing is covered". The sweep reads the WHOLE file, so a signing
    // step added anywhere in it fails here.
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
    expect(archRead(rel)).not.toEqual(archRead(MACOS));
    expect(sc17Steps(sc17Job(archRead(rel), GATE_JOB))).not.toEqual(
      linuxAsMacos(archRead(LINUX)),
    );
  });

  it('LEGITIMATE NEAR-MISS: the same lane with a reworded comment is not a drift', () => {
    // Comments are not steps. A row that compared raw text would fail on a
    // typo fix, and a row that fails on a typo fix gets deleted.
    const rel = sc17Plant(
      '.github/workflows/__s8_sc17_probe__.yml',
      archRead(MACOS).replace(
        '# This is the ONE step that runs the suite',
        '# This is the single step that runs the suite',
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
    // 21 at S7 close; 22 since v2 F3 (#29), `thread.state`.
    expect(GATEWAY_EVENT_NAMES.length).toBe(22);
  });

  it('the route table, the frame table and the port allowlist are S7’s', () => {
    // Numbers, because these are the slice's closing counts and a count is
    // the one thing a relationship cannot express: "no new route" has no
    // second source to compare against inside this repo. Each is also
    // checked for the shape of drift a count alone would miss.
    //
    // 67 at S7 close; 69 since v2 A1 (#26): `GET /v1/threads`, the v2
    // conversations list, plus its auto-HEAD twin. 71 since v2 A2 (#27):
    // `GET /v1/threads/:guid/messages`, one conversation's page, plus its
    // twin. 73 since v2 F5 (#28): `GET /v1/threads/by-handle/:handle`, the
    // conversation a new draft would land in, plus its twin. Reads behind
    // the operator bearer; the frame table and the port allowlist did not
    // move. 76 since v2 F3 (#29): `GET /v1/threads/state`, its twin and
    // `PUT /v1/threads/:guid/state`, the stored Done, Snooze and Mute.
    // 78 since v2 F2b (#30): `GET /v1/search` and its twin, search over
    // the daemon's own index; no event, no frame, no port importer.
    // 80 since v2 F2c (#31): `GET /v1/threads/:guid/years` and its twin,
    // one conversation's turns by year; no event, no frame, no importer.
    // 82 since v2 F6b (#32): `GET /v1/attachments/:id` and its twin, one
    // attachment's bytes from the Attachments folder; no event, no frame,
    // no port importer.
    expect(ROUTE_TABLE.length).toBe(82);
    expect(new Set(ROUTE_TABLE).size).toBe(ROUTE_TABLE.length);
    expect(ROUTE_TABLE.filter((r) => !/^[A-Z]+ \//.test(r))).toEqual([]);

    expect(Object.keys(FRAME_SPECS).length).toBe(9);
    // INV-2 at the wire: there is no frame that sends. Every path to a send
    // goes through an approval the daemon validated, and a frame type would
    // be a way around that which no amount of GUI review would catch.
    expect(Object.keys(FRAME_SPECS)).not.toContain('send');

    // 15 at S7 close; 16 since s10 Slice 2 (#25, core late-verify.ts, a
    // chat.db reader with no send port). Routes and frames did not move.
    expect(PORT_IMPORTER_ALLOWLIST.length).toBe(16);
    expect(new Set(PORT_IMPORTER_ALLOWLIST).size).toBe(
      PORT_IMPORTER_ALLOWLIST.length,
    );
    // The GUI is not on it, and that is the whole of INV-2 in one line.
    expect(
      PORT_IMPORTER_ALLOWLIST.filter((f) => f.startsWith('apps/')),
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

  /* ── row 9 (meta, PUBLIC): the checkpoint added nothing identifying ── */

  it('nothing this scenario adds identifies an operator or a machine', () => {
    expect(publicRepoOffenders()).toEqual([]);
    const mine = [MACOS];
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
 * A 64-hex run, and the one value of that shape a tracked file may hold
 * without being a digest carrier. Lifted to module scope, unchanged, from
 * S9 Sc1 row 11 so that the v2 S0 contract-fixture rows reuse the same two
 * definitions instead of growing a second opinion about what a digest is.
 */
const HEX64 = /\b[0-9a-f]{64}\b/;
const NULL_DIGEST = '0'.repeat(64);

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
      'apps/__s9__',
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
   * s9 D5: the cleanup above removes the empty shells a plant created and
   * stops there. Without this row, the sweep could delete a file somebody else
   * put in one of those directories, and the failure would look like the file
   * was never written.
   *
   * Sc 5 once asserted survival against `bundle-daemon.mjs`, shipped in the
   * desktop app's scripts directory, which this helper used to sweep. v2 S6c
   * deleted that app, and the bundler moved to `tools/release/bin`, which no
   * plant here touches. So the row is back to its original two-halves shape,
   * on `apps/__s9__`, a namespaced path that can never become a real one: a
   * keeper survives, and the empty shell is then removed. The second half is
   * still proved on `packages/daemon/src/__s9__` as well.
   */
  it('cleanup removes the planted directory shells, but never a real file', () => {
    const shellDir = join(repoRoot, 'apps/__s9__');
    const keeper = join(shellDir, '__s9_keeper__.mjs');

    mkdirSync(shellDir, { recursive: true });
    writeFileSync(keeper, 'export const shipped = true;\n');
    try {
      s9RemovePlantedDirs();
      expect(
        existsSync(keeper),
        'a non-empty planted directory must survive cleanup',
      ).toBe(true);
    } finally {
      rmSync(keeper, { force: true });
    }
    s9RemovePlantedDirs();
    expect(existsSync(shellDir), 'its emptied shell is then removed').toBe(
      false,
    );

    // The other half, on a second namespaced path.
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
          ['check-ignore', '-q', '--', `packages/daemon/${name}/`],
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
      'dist-bundle-node',
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
        'apps/__s9__/__s9_probe__.svg',
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

    it('PLANTED: a .sh under apps/ naming the verb fails', () => {
      const rel = s9Plant(
        'apps/__s9__/__s9_probe__.sh',
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
        'apps/__s9__/__s9_probe__note.ts',
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
        'apps/__s9__/__s9_probe__ok.sh',
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

  /* ── v2 S2a: the launch shapes are exactly bundle, dev and host ────── */

  /**
   * `plist.ts` grew a third argument vector for the native app, and with it
   * the one key only that vector may carry. Both facts are about where a
   * thing is SPELLED:
   *
   *  - the shape union is written once, with exactly three members, in the
   *    module that refuses every other vector;
   *  - `AssociatedBundleIdentifiers` appears in that module and in no other
   *    SOURCE file under packages/ (paths with a `/src/` segment). Scoped to
   *    source on purpose: the specs that pin the key must name it, and a
   *    test naming it cannot put it into a plist. A second source file
   *    naming it would be a second place able to attribute an agent to the
   *    app, which is what the renderer's host-only rule exists to prevent.
   */
  describe('S2a: launchd shapes are exactly bundle, dev, host', () => {
    const PLIST = 'packages/daemon/src/launchd/plist.ts';
    const KEY = 'AssociatedBundleIdentifiers';
    const sourceFiles = (): string[] =>
      trackedTextFiles().filter(
        (f) => f.startsWith('packages/') && f.includes('/src/'),
      );
    const carriers = (): string[] =>
      sourceFiles()
        .filter((f) => readFileSync(join(repoRoot, f), 'utf8').includes(KEY))
        .sort();

    it('the shape union is declared once, with three members', () => {
      const decl =
        "export type ProgramArgumentsShape = 'bundle' | 'dev' | 'host';";
      expect(s9Read(PLIST).split(decl)).toHaveLength(2);
    });

    it('AssociatedBundleIdentifiers is in plist.ts and in no other source file under packages/', () => {
      const swept = sourceFiles();
      // Non-vacuity: the sweep reads the module that owns the key and its
      // nearest neighbour, so an empty or misrooted list cannot pass.
      expect(swept).toContain(PLIST);
      expect(swept).toContain('packages/daemon/src/launchd/service.ts');
      expect(carriers()).toEqual([PLIST]);
    });

    it('PLANTED: a second source file naming the key is caught', () => {
      const rel = s9Plant(
        'packages/daemon/src/__s9__/attribution.ts',
        `export const planted = '${KEY}';\n`,
        true,
      );
      expect(carriers()).toEqual([PLIST, rel].sort());
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
        'apps/__s9__/__s9_probe__daemon.ts',
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
      // v2 S6c: the daemon probe now lives in `apps/__s9__`, which no
      // committed file creates, so its emptied shell goes too.
      s9RemovePlantedDirs();
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

    it('row 8: the CLI thin-client rule text is byte-identical to s8', () => {
      // v2 S6c deleted the desktop app, and with it `desktop-thin-client`,
      // the rule that held its renderer to the client and protocol packages.
      // A rule about a directory that does not exist is a rule nothing can
      // break, so it went, and this row now proves it stays gone rather than
      // proving it is present.
      const config = s9Read('.dependency-cruiser.cjs');
      expect(config).toContain("name: 'cli-thin-client'");
      expect(config).toContain(
        "to: { path: '^packages/(?!client|protocol|cli)' }",
      );
      // The bare-specifier arm was the desktop rule's, so it went with it.
      expect(config).not.toContain("'^@wemessage/(?!client$|protocol$)'");
      expect(config).not.toContain("name: 'desktop-thin-client'");
      expect(config).not.toContain('apps/desktop');
      expect(config).not.toContain(`cli-desktop-${'thin'}-clients`);
    });

    it('row 8 PLANTED: the supervisor must spawn the daemon, not import it', () => {
      // Sc 7's supervisor is the reason this is re-proved here rather than
      // taken on trust from s8: the scenario that adds a supervisor is the
      // scenario most tempted to reach for the daemon's factory directly.
      expect(flaggedBy('nobody-imports-daemon')).toContain(
        'apps/__s9__/__s9_probe__daemon.ts',
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

  /*
   * Row 9 pinned the desktop app's dependency list (the s8 eight plus the
   * ship-era four: electron-builder and its kin). v2 S6c deleted that app,
   * and the tombstone row in 'v2 S6c: the desktop app is deleted, not
   * dormant' replaces it with the stronger claim: no manifest in the tree
   * declares the Electron toolchain at all.
   */

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
   *
   * v2 S2d adds the ninth, `pack:swift`, which assembles WeMessage.app from
   * the Swift host and the bundled Node. It joins the build drivers, so it
   * owes the same two proofs `pack.mjs` does: it reaches a child process,
   * and it still refuses with exit 2.
   *
   * v2 S6c deleted the desktop app and the two scripts that packed it,
   * `pack:adhoc` and `pack:release`, so the row is seven. `pack:swift` is the
   * only build driver left, and it carries both proofs alone.
   */
  describe('row 10: seven release scripts, each resolving to a real file', () => {
    const RELEASE_SCRIPTS: readonly string[] = [
      'release:notarize',
      'release:cask',
      'release:check-versions',
      'release:notes',
      'release:cut-tag',
      'pack:swift',
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
    const DRIVES_A_BUILD: readonly string[] = ['pack:swift'];

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

    it('all seven are declared', () => {
      const have = scripts();
      expect(RELEASE_SCRIPTS.filter((s) => !(s in have))).toEqual([]);
    });

    it('the root declares no eighth release script this row does not know about', () => {
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

    it('the four buckets partition the seven, with nothing in two or in none', () => {
      expect(BUCKETS.flat().sort()).toEqual([...RELEASE_SCRIPTS].sort());
      // Pairwise, so a failure names the two buckets that overlap instead of
      // printing two seven-element arrays side by side.
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
    // v2 S2b argued the fourth carrier: tools/swift/node.lock.json pins the
    // sha256 of the one Node tarball the Swift app ships. It is a real
    // digest, not the placeholder, so it joins the strict list by name.
    const DIGEST_CARRIERS: readonly string[] = [
      'packages/adapters/hermes/plugin/requirements.txt',
      'packages/core/test/audit-chain-core.spec.ts',
      'packages/store/test/audit-chain.spec.ts',
      'tools/swift/node.lock.json',
      // v2 S3: the XcodeGen release the CI UI lane fetches, same shape.
      'tools/swift/xcodegen.lock.json',
    ];

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
    // NULL_DIGEST is declared at module scope (shared with v2 S0).

    /** True when every 64-hex run in `text` is that placeholder. */
    const onlyNullDigests = (text: string): boolean =>
      [...text.matchAll(/\b[0-9a-f]{64}\b/g)].every(
        (m) => m[0] === NULL_DIGEST,
      );

    it('a 64-hex digest lives in exactly five files, all of them earned', () => {
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
    // v2 S6c: the decoder fixtures moved with the decoders, out of the
    // deleted desktop app's token spec and into the ship-era no-green spec.
    const HEX40_CARRIERS: readonly string[] = ['test/release/no-green.spec.ts'];

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
    /**
     * v2 S5b: THE SIGNING IDENTITY, admitted by line like the pins above.
     *
     * A self-signed release is known by its certificate leaf's SHA-1, and
     * two documents have to name it in full: RELEASING.md, on the one
     * `certificate leaf` line release.yml's `compare-leaf-with-releasing`
     * reads, and CHANGELOG.md, on the exact lines `dr-diff` reads (the leaf
     * established, and every rotation from one leaf to the next). Anywhere
     * else in those two files, a 40-hex run is still an offender.
     */
    const HEX40_LINE_CARRIERS: Readonly<Record<string, RegExp>> = {
      'RELEASING.md':
        /^Signing identity, certificate leaf SHA-1: `[0-9a-f]{40}`$/,
      'CHANGELOG.md':
        /^- Signing identity (?:established: [0-9a-f]{40}|rotated: [0-9a-f]{40} -> [0-9a-f]{40})$/,
    };
    const isLineCarrier = (rel: string): boolean =>
      Object.keys(HEX40_LINE_CARRIERS).includes(rel);

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
      expect(
        carriers.filter((f) => !isWorkflowFile(f) && !isLineCarrier(f)),
      ).toEqual([...HEX40_CARRIERS].sort());
      // The identity arm, line by line: RELEASING.md holds exactly one
      // leaf line (non-vacuous: the placeholder until S5d, the real leaf
      // after), CHANGELOG.md only the identity lines dr-diff reads.
      const strays: string[] = [];
      for (const [rel, shape] of Object.entries(HEX40_LINE_CARRIERS)) {
        const lines = readFileSync(join(repoRoot, rel), 'utf8').split('\n');
        const hits = [...lines.entries()].filter(([, l]) =>
          /[0-9a-fA-F]{40}/.test(l),
        );
        for (const [n, line] of hits)
          if (!shape.test(line)) strays.push(`${rel}:${n + 1}: ${line.trim()}`);
        if (rel === 'RELEASING.md') expect(hits.length, rel).toBe(1);
      }
      expect(strays).toEqual([]);
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
          .filter(
            (f) =>
              !HEX40_CARRIERS.includes(f) &&
              !isWorkflowFile(f) &&
              !isLineCarrier(f),
          ),
      ).toEqual([rel]);
    });

    it('PLANTED: the identity arm admits the leaf lines and nothing else', () => {
      const a = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
      const b = 'ab12'.repeat(10);
      const releasing = HEX40_LINE_CARRIERS['RELEASING.md'];
      const changelog = HEX40_LINE_CARRIERS['CHANGELOG.md'];
      expect(
        releasing?.test(`Signing identity, certificate leaf SHA-1: \`${a}\``),
      ).toBe(true);
      // A checksum or a second hash on the leaf line is not the leaf.
      expect(releasing?.test(`${a}  WeMessage-1.0.0-arm64.dmg`)).toBe(false);
      expect(
        releasing?.test(
          `Signing identity, certificate leaf SHA-1: \`${a}\` (was ${b})`,
        ),
      ).toBe(false);
      expect(changelog?.test(`- Signing identity established: ${a}`)).toBe(
        true,
      );
      expect(changelog?.test(`- Signing identity rotated: ${a} -> ${b}`)).toBe(
        true,
      );
      expect(changelog?.test(`- Fixed the build at ${a}`)).toBe(false);
      expect(
        changelog?.test(`- Signing identity rotated: ${a} -> ${b} (oops)`),
      ).toBe(false);
      // And the line shapes are the ones dr-diff and release.yml read.
      const rel = readFileSync(
        join(repoRoot, '.github/workflows/release.yml'),
        'utf8',
      );
      expect(rel).toContain('/certificate leaf/');
      const drDiff = readFileSync(
        join(repoRoot, 'tools/release/src/dr-diff.ts'),
        'utf8',
      );
      expect(drDiff).toContain('^- Signing identity rotated: ');
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
   * before Sc 3 landed. S9 minted nothing: it ships the product, it does
   * not extend the wire. s10 Slice 2 later minted `#25` for the port
   * allowlist only, and the row below records that rather than hiding it.
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

    it('the S8-close counts are unchanged, except the route table (#26, #27, #28, #29, #30, #31, #32) and thread.state (#29)', () => {
      // 67 at S8 close. v2 A1 minted #26 for `GET /v1/threads` (+ HEAD
      // twin), the conversations list the v2 messenger opens on: 67 -> 69.
      // v2 A2 minted #27 for `GET /v1/threads/:guid/messages` (+ HEAD
      // twin), one conversation's page: 69 -> 71. v2 F5 minted #28 for
      // `GET /v1/threads/by-handle/:handle` (+ HEAD twin), the lookup
      // compose asks before a new conversation's draft: 71 -> 73. No WS
      // event, no frame and no port importer moved with any of them. v2 F3
      // minted #29 for `GET /v1/threads/state` (+ HEAD twin) and
      // `PUT /v1/threads/:guid/state`: 73 -> 76, and for ONE event,
      // `thread.state`, declared and emitted together: 21 -> 22. No frame
      // and no port importer moved. v2 F2b minted #30 for `GET /v1/search`
      // (+ HEAD twin): 76 -> 78, and nothing else moved. v2 F2c minted #31
      // for `GET /v1/threads/:guid/years` (+ HEAD twin): 78 -> 80, and
      // nothing else moved. v2 F6b minted #32 for `GET /v1/attachments/:id`
      // (+ HEAD twin): 80 -> 82, and nothing else moved.
      expect(ROUTE_TABLE.length).toBe(82);
      expect(WS_EVENT_VOCABULARY.length).toBe(22);
      expect(GATEWAY_EVENT_NAMES.length).toBe(22);
      expect(EMITTED_WS_EVENTS.length).toBe(22);
      expect(UNEMITTED_WS_EVENTS).toEqual([]);
      // 15 at S8 close. s10 Slice 2 (#25) added core late-verify.ts, a
      // chat.db reader with no send port; every wire count above is S8's.
      expect(PORT_IMPORTER_ALLOWLIST.length).toBe(16);
      // `Object.keys`, not `.length`: `FRAME_SPECS` is a KEY TABLE, not an
      // array, and `.length` on it is `undefined` — an assertion that would
      // have failed for a reason that has nothing to do with the wire.
      expect(Object.keys(FRAME_SPECS).length).toBe(9);
    });

    it('S9 closed at #24; later updates are s10 Slice 2 (#25), v2 A1 (#26), v2 A2 (#27), v2 F5 (#28), v2 F3 (#29), v2 F2b (#30), v2 F2c (#31) and v2 F6b (#32), and #33 was never minted', () => {
      // S9 itself minted nothing, which is what this row was written to
      // prove. s10 Slice 2 minted #25 for the PORT allowlist (late
      // verification reads chat.db), not for the wire. v2 A1 minted #26 for
      // one read route, `GET /v1/threads`, v2 A2 #27 for one more,
      // `GET /v1/threads/:guid/messages`, and v2 F5 #28 for a third,
      // `GET /v1/threads/by-handle/:handle`, and nothing else on the wire:
      // the event and frame counts in the row above are S8's. v2 F3 minted
      // #29 for the thread-state pair and the `thread.state` event. v2 F2b
      // minted #30 for `GET /v1/search`. v2 F2c minted #31 for
      // `GET /v1/threads/:guid/years`. v2 F6b minted #32 for
      // `GET /v1/attachments/:id`. #33 is the next tooth.
      const text = s9Read(RATCHET);
      const seen = deliberateUpdates(text);
      expect(Math.max(...seen)).toBe(32);
      expect(seen).not.toContain(33);
      expect(text).toMatch(/#25 deliberate \(s10 Slice 2\), port allowlist/);
      expect(text).toMatch(/#26 deliberate \(v2 A1\)/);
      expect(text).toMatch(/#27 deliberate \(v2 A2\)/);
      expect(text).toMatch(/#28 deliberate \(v2 F5\)/);
      expect(text).toMatch(/#29 deliberate \(v2 F3/);
      expect(text).toMatch(/#30 deliberate \(v2 F2b\)/);
      expect(text).toMatch(/#31 deliberate \(v2 F2c\)/);
      expect(text).toMatch(/#32 deliberate \(v2 F6b\)/);
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

  it('row 14: nothing under apps/ can spawn a process', () => {
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
    /*
     * v2 S6c deleted the desktop app this row was written for. The Swift app
     * that replaced it lives under `apps/mac` and is written in Swift, which
     * this scan does not read; it launches the daemon through launchd, and
     * the Swift lane's own tests hold that seam. So today this scan reads no
     * files, and the non-vacuity floor it had is gone with its subject.
     *
     * The row stays, generalised from one directory to all of `apps/`, for
     * the day somebody adds a TypeScript app there: the invariant (launchd
     * owns the daemon, the app never starts a process) is about the product,
     * not about the toolkit the first app happened to use.
     */
    const desktopSrc = archFiles('apps').filter((f) =>
      /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(f),
    );

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
     * PUBLISH set; `row 10` above named `apps/desktop` until v2 S6c deleted it). Both are true and
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
      // v2 S6c deleted `apps/desktop`; the derivation must not resurrect it.
      expect(members).not.toContain('apps/desktop');
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
      // v2 S6c deleted the S8 blocks that cruised the desktop app's sources,
      // which took the count of real call sites from fourteen to thirteen.
      expect(codeHits).toBeGreaterThanOrEqual(13);
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

describe('v2 S0: contract fixtures', () => {
  /**
   * v2 S0 freezes the daemon's wire into fixtures/contract/ for the Swift
   * client: request JSON Schemas, golden responses and error envelopes, and
   * the SSE bytes. The daemon ratchet (packages/daemon/test/
   * contract.ratchet.spec.ts) owns their CONTENT. These rows own what is
   * structural about them: that they are tracked, listed, public-safe, and
   * produced by exactly one recorder. Text only (advisor 8): nothing here
   * imports @wemessage/daemon.
   */
  const CONTRACT = 'fixtures/contract';
  const RATCHET = 'packages/daemon/test/contract.ratchet.spec.ts';
  const RECORDER = 'packages/daemon/test/helpers/contract-recorder.ts';

  const tracked = (): string[] =>
    execFileSync('git', ['ls-files', '--', CONTRACT], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.length > 0);

  it('fixtures/contract is tracked and non-empty', () => {
    expect(tracked().length).toBeGreaterThanOrEqual(60);
  });

  it('manifest.json equals the tracked list', () => {
    const manifest = JSON.parse(archRead(`${CONTRACT}/manifest.json`)) as {
      files: string[];
    };
    const expected = tracked()
      .map((f) => f.slice(`${CONTRACT}/`.length))
      .filter((f) => f !== 'manifest.json')
      .sort();
    expect(manifest.files).toEqual(expected);
  });

  it('no fixture under fixtures/contract carries a non-null 64-hex', () => {
    // HEX64 is the row-11 shape; the lookaround form also sees a run glued
    // to `wm_`, which `\b` cannot (an underscore is a word character).
    const glued = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
    const offenders = tracked().filter((f) =>
      [...archRead(f).matchAll(glued)].some((m) => m[0] !== NULL_DIGEST),
    );
    expect(offenders).toEqual([]);
    // The glued form is a superset of HEX64: anything row 11 would see, it
    // sees too, so widening the shape here cannot have narrowed it.
    const real = `"${'c'.repeat(64)}"`;
    expect(HEX64.test(real)).toBe(true);
    expect([...real.matchAll(glued)]).toHaveLength(1);
    expect(HEX64.test(`wm_${'c'.repeat(64)}`)).toBe(false);
    expect([...`wm_${'c'.repeat(64)}`.matchAll(glued)]).toHaveLength(1);
    // Non-vacuity: the stabilised digests are present, as the placeholder.
    expect(tracked().some((f) => archRead(f).includes(NULL_DIGEST))).toBe(true);
  });

  it('the public sweep exempts the NULL adapter token under fixtures/contract and nothing else', () => {
    const nul = `wm_${NULL_DIGEST}`;
    const live = `wm_${'c'.repeat(64)}`;
    const swept = (f: string, t: string): string[] =>
      publicStringOffenders(publicSweepText(f, t)).map((o) => o.detail);
    // The recorder's placeholder passes where the recorder writes it ...
    expect(swept('fixtures/contract/responses/x.json', nul)).toEqual([]);
    // ... and nowhere else: the linter still convicts it everywhere outside.
    expect(swept('docs/x.md', nul)).toEqual(['adapter token']);
    expect(swept('fixtures/events/x.json', nul)).toEqual(['adapter token']);
    // A live-shaped token inside the directory still convicts, alone and
    // sitting next to the exempt one.
    expect(swept('fixtures/contract/responses/x.json', live)).toEqual([
      'adapter token',
    ]);
    expect(
      swept('fixtures/contract/responses/x.json', `${nul} ${live}`),
    ).toEqual(['adapter token']);
    // Non-vacuity: the fixtures really carry the placeholder token.
    expect(tracked().some((f) => archRead(f).includes(nul))).toBe(true);
  });

  it('the contract recorder lives in packages/daemon/test only', () => {
    const call = 'record' + 'Contract(';
    const callers = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f))
      .filter((f) => f !== 'test/arch.spec.ts')
      .filter((f) => archRead(f).includes(call));
    expect(
      callers.filter((f) => !f.startsWith('packages/daemon/test/')),
    ).toEqual([]);
    expect(callers.sort()).toEqual([RATCHET, RECORDER].sort());
  });

  it('the daemon ratchet owns REQUEST_SCHEMAS coverage of every ROUTE_TABLE body/query route', () => {
    const text = archRead(RATCHET);
    expect(text).toContain(
      "'every body or query route has a REQUEST_SCHEMAS entry or is in NO_BODY_ROUTES'",
    );
    expect(text).toContain(
      "'no REQUEST_SCHEMAS key is absent from ROUTE_TABLE'",
    );
    expect(text).toMatch(
      /import \{ NO_BODY_ROUTES, ROUTE_TABLE \} from '\.\/transport-surface\.snapshot\.js'/,
    );
    expect(archRead('.prettierignore')).toMatch(/^fixtures\/contract\/$/m);
  });
});

describe('v2 S1: the Swift tree', () => {
  /**
   * v2 S1 adds apps/mac: a SwiftPM package whose one library, WeMessageKit,
   * speaks the S0 contract in fixtures/contract. v2 S2c adds the host: the
   * WeMessageDaemonHost library and the WeMessage executable, which launchd
   * starts as `WeMessage --daemon` and which posix_spawns the bundled node
   * as its own child. Their tests run under `swift test`, on the ci-swift
   * lane and on a laptop, never under vitest. These rows own what is
   * structural about the tree: what each target may import, that it has no
   * package dependencies, that the host never leaves its own process tree,
   * that the public-repo sweeps read it, and that its lane is a real one.
   * Text only: nothing here spawns a Swift toolchain.
   */
  const MAC = 'apps/mac';
  const SOURCES: readonly string[] = [
    `${MAC}/Sources/WeMessageKit`,
    `${MAC}/Sources/WeMessageDaemonHost`,
    `${MAC}/Sources/WeMessage`,
    `${MAC}/Sources/WeMessageApp`,
  ];
  const HOST_SOURCES: readonly string[] = [
    `${MAC}/Sources/WeMessageDaemonHost`,
    `${MAC}/Sources/WeMessage`,
  ];
  // v2 S3: the window's target, and the XCUITest bundle that only the ci-swift
  // `ui` job ever builds (it is not a SwiftPM target).
  const APP_SOURCES = `${MAC}/Sources/WeMessageApp`;
  const UI_TESTS = `${MAC}/UITests/WeMessageUITests`;
  const PROJECT_YML = `${MAC}/project.yml`;
  const MAIN_SWIFT = `${MAC}/Sources/WeMessage/main.swift`;
  const TESTS: readonly string[] = [
    `${MAC}/Tests/WeMessageKitTests`,
    `${MAC}/Tests/WeMessageDaemonHostTests`,
    `${MAC}/Tests/WeMessageAppTests`,
  ];
  const CI_SWIFT = '.github/workflows/ci-swift.yml';
  const CI_MACOS = '.github/workflows/ci-macos.yml';
  // Escaped so this file obeys the rule it enforces.
  const EM_DASH = '\u2014';
  // Assembled, so no tracked file spells the import it forbids.
  const XCTEST = 'XC' + 'Test';

  const trackedUnder = (root: string): string[] =>
    execFileSync('git', ['ls-files', '--', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.length > 0);
  const swiftUnder = (root: string): string[] =>
    trackedUnder(root).filter((f) => f.endsWith('.swift'));
  const trackedSwift = (): string[] =>
    trackedTextFiles().filter((f) => f.endsWith('.swift'));

  /**
   * Every module a Swift file imports. Attributes (`@testable`,
   * `@preconcurrency`) and import kinds (`import struct Foundation.URL`) are
   * stripped, and the line may be indented, so an import tucked inside an
   * `#if canImport(...)` block is still an import.
   */
  const swiftImports = (text: string): string[] =>
    [
      ...text.matchAll(
        /^[ \t]*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_]\w*)/gm,
      ),
    ].map((m) => m[1] ?? '');
  const offendingImports = (
    files: string[],
    allowed: ReadonlySet<string>,
  ): string[] =>
    files.flatMap((f) =>
      swiftImports(archRead(f))
        .filter((m) => !allowed.has(m))
        .map((m) => `${f}: ${m}`),
    );

  it('every Sources/**/*.swift imports Foundation only (main.swift adds the host and the app; WeMessageApp adds the UI frameworks and the kit); tests add Testing and the target under test', () => {
    const sources = SOURCES.flatMap(swiftUnder);
    expect(sources.length).toBeGreaterThanOrEqual(25);
    expect(sources).toContain(MAIN_SWIFT);
    const app = swiftUnder(APP_SOURCES);
    expect(app.length).toBeGreaterThanOrEqual(6);
    expect(
      offendingImports(
        sources.filter((f) => f !== MAIN_SWIFT && !app.includes(f)),
        new Set(['Foundation']),
      ),
    ).toEqual([]);
    expect(
      offendingImports(
        [MAIN_SWIFT],
        new Set(['Foundation', 'WeMessageDaemonHost', 'WeMessageApp']),
      ),
    ).toEqual([]);
    // v2 S3: the window target may name the UI frameworks and the kit, never
    // the host (the GUI spawns nothing) and never Combine.
    const uiFrameworks = [
      'Foundation',
      'SwiftUI',
      'AppKit',
      'Observation',
      'WeMessageKit',
    ];
    const contactsHome = `${APP_SOURCES}/Models/ContactsAvatarProvider.swift`;
    // v2 S4l: UserNotifications is imported by the board 16 notifications
    // file and nothing else (AppHygiene H-A1 and H-S4-12).
    const notesHome = `${APP_SOURCES}/Boards/OSLayer/Notifications.swift`;
    expect(
      offendingImports(
        app.filter((f) => f !== contactsHome && f !== notesHome),
        new Set(uiFrameworks),
      ),
    ).toEqual([]);
    expect(app).toContain(notesHome);
    expect(
      offendingImports(
        [notesHome],
        new Set([...uiFrameworks, 'UserNotifications']),
      ),
    ).toEqual([]);
    expect(
      app.filter((f) =>
        swiftImports(archRead(f)).includes('UserNotifications'),
      ),
    ).toEqual([notesHome]);
    // v2 S4g: Contacts is imported by the avatar provider and nothing else,
    // so the one file that can reach the contacts store is the one the
    // AppHygiene H-S4-5 row guards.
    expect(app).toContain(contactsHome);
    expect(
      offendingImports([contactsHome], new Set([...uiFrameworks, 'Contacts'])),
    ).toEqual([]);
    expect(
      app.filter((f) => swiftImports(archRead(f)).includes('Contacts')),
    ).toEqual([contactsHome]);
    // Every tracked Swift file under Sources and Tests sits in a listed
    // directory, so a new target cannot pass this row by being unlisted.
    const listed = [...SOURCES, ...TESTS];
    expect(
      [...swiftUnder(`${MAC}/Sources`), ...swiftUnder(`${MAC}/Tests`)].filter(
        (f) => !listed.some((dir) => f.startsWith(`${dir}/`)),
      ),
    ).toEqual([]);
    const tests = TESTS.flatMap(swiftUnder);
    expect(tests.length).toBeGreaterThanOrEqual(19);
    for (const dir of TESTS) {
      const files = swiftUnder(dir);
      expect([dir, files.length > 0]).toEqual([dir, true]);
      // The target under test is the directory's name minus `Tests`; the
      // app's tests may also name the kit, whose types the model speaks.
      const target = basename(dir).replace(/Tests$/, '');
      const allowed = ['Foundation', 'Testing', target];
      if (target === 'WeMessageApp') allowed.push('WeMessageKit');
      expect(offendingImports(files, new Set(allowed))).toEqual([]);
    }
    // Non-vacuity: the reader sees every import form it is there to deny.
    expect(
      swiftImports(
        [
          'import AppKit',
          '@testable import WeMessageKit',
          `#if canImport(${XCTEST})`,
          `  import ${XCTEST}`,
          '#endif',
          'import struct Foundation.URL',
          '/// import SwiftUI is prose, not an import',
        ].join('\n'),
      ),
    ).toEqual(['AppKit', 'WeMessageKit', XCTEST, 'Foundation']);
  });

  it('XCTest is imported under apps/mac/UITests and nowhere else', () => {
    const swift = swiftUnder(MAC);
    expect(swift).toContain(`${MAC}/Package.swift`);
    // SwiftPM's tree (Sources, Tests, Package.swift) runs swift-testing only.
    expect(
      swift
        .filter((f) => !f.startsWith(`${UI_TESTS}/`))
        .filter((f) => swiftImports(archRead(f)).includes(XCTEST)),
    ).toEqual([]);
    // v2 S3: the XCUITest bundle is the one XCTest home. Every file there
    // imports it, and nothing there reaches a package target: the tests drive
    // the app through the accessibility tree only.
    const ui = swiftUnder(UI_TESTS);
    expect(ui.length).toBeGreaterThanOrEqual(2);
    expect(
      ui.filter((f) => !swiftImports(archRead(f)).includes(XCTEST)),
    ).toEqual([]);
    expect(
      offendingImports(ui, new Set([XCTEST, 'Foundation', 'AppKit'])),
    ).toEqual([]);
  });

  it('main.swift leaves for the window only after the daemon branch', () => {
    // v2 S3: the textual order beside the first-statement row. The daemon
    // branch exits before the first app symbol in source order; with the
    // first-statement row, before any app symbol in execution order.
    const statements = archRead(MAIN_SWIFT)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'))
      .filter((l) => !/^(?:@\w+\s+)*import\s/.test(l));
    const joined = statements.join('\n');
    const isDaemon = joined.indexOf('HostArguments.isDaemon');
    const daemonRun = joined
      .replace(/exit\(\s*\n\s*/g, 'exit(')
      .indexOf('exit(DaemonHost.run');
    const entry = joined
      .replace(/exit\(\s*\n\s*/g, 'exit(')
      .indexOf('AppEntry.run');
    expect(isDaemon).toBeGreaterThanOrEqual(0);
    expect(daemonRun).toBeGreaterThan(isDaemon);
    expect(entry).toBeGreaterThan(daemonRun);
    expect(joined.split('AppEntry').length - 1).toBe(1);
    expect(archRead(MAIN_SWIFT)).not.toContain('usage:');
    // AppEntry.run returns Never: nothing follows it.
    expect(statements[statements.length - 1] ?? '').toContain('AppEntry.run');
  });

  it('no @main under apps/mac', () => {
    // main.swift is the one entry point; SwiftUI's App.main() is called from
    // AppEntry, after the daemon branch, never by an attribute.
    const files = [...SOURCES.flatMap(swiftUnder), ...swiftUnder(UI_TESTS)];
    expect(files.length).toBeGreaterThanOrEqual(27);
    expect(files.filter((f) => archRead(f).includes('@main'))).toEqual([]);
  });

  it('Package.swift has no package dependencies, tools 6.2, macOS 26', () => {
    const text = archRead(`${MAC}/Package.swift`);
    // SwiftPM reads the tools version from the first line only.
    expect(text.split('\n')[0]).toMatch(/^\/\/ swift-tools-version:\s*6\.2$/);
    expect(text).toMatch(/\.macOS\(\.v26\)/);
    expect(text).not.toMatch(/dependencies:\s*\[\s*\.package/);
    expect(text).not.toMatch(/\.package\s*\(/);
    // Advisor S1 item 1: the kit is a library, so it does not opt every
    // type into the main actor; the app target chooses its own isolation.
    expect(text).not.toContain('defaultIsolation');
    expect(swiftImports(text)).toEqual(['PackageDescription']);
    // v2 S2c: exactly one executable target, WeMessage, and its only
    // dependency is the host library, so the kit never links into the exe.
    expect(text.split('.executableTarget(').length - 1).toBe(1);
    const exe = /\.executableTarget\(([^)]*)\)/.exec(text)?.[1] ?? '';
    expect(exe).toMatch(/name:\s*"WeMessage"/);
    // v2 S3: the one executable also links the window target; the kit still
    // reaches the exe only through WeMessageApp, never directly.
    expect(/dependencies:\s*\[([^\]]*)\]/.exec(exe)?.[1]?.trim()).toBe(
      '"WeMessageDaemonHost", "WeMessageApp"',
    );
    const targets = text
      .split(/(?=\.(?:target|executableTarget|testTarget)\()/)
      .slice(1);
    const app = targets.filter(
      (t) => t.startsWith('.target(') && /name:\s*"WeMessageApp"/.test(t),
    );
    expect(app.length).toBe(1);
    expect(/dependencies:\s*\[([^\]]*)\]/.exec(app[0] ?? '')?.[1]?.trim()).toBe(
      '"WeMessageKit"',
    );
    expect(app[0]).not.toContain('swiftSettings');
    expect(targets.filter((t) => t.startsWith('.testTarget(')).length).toBe(3);
  });

  it('the host never daemonises or disclaims', () => {
    // v2 S2c: node stays the host's child and the host stays the
    // responsible process, so no host source may exec away the host, start
    // a new process group or session, daemonise, or disclaim. Not even in a
    // comment: a spelling nobody wrote down is a call nobody brings back by
    // accident. Mirrors HostHygieneTests row 17.
    const NEVER: readonly string[] = [
      'POSIX_SPAWN_SETEXEC',
      'POSIX_SPAWN_SETPGROUP',
      'setsid',
      'setpgid',
      'daemon(',
      'responsibility_spawnattrs',
    ];
    // v2 S3: the window and its UI tests join the sweep (advisor P1), and
    // they spawn nothing at all, so they also never name a spawner.
    const files = [...HOST_SOURCES, APP_SOURCES, UI_TESTS].flatMap(swiftUnder);
    expect(files.length).toBeGreaterThanOrEqual(17);
    expect(
      files.flatMap((f) =>
        NEVER.filter((t) => archRead(f).includes(t)).map((t) => `${f}: ${t}`),
      ),
    ).toEqual([]);
    const GUI_NEVER: readonly string[] = [
      'posix_spawn',
      'Process(',
      'NSTask',
      'SignalForwarder',
      'DaemonHost',
      'Spawner',
      'WEMESSAGE_HOST',
    ];
    const gui = [APP_SOURCES, UI_TESTS].flatMap(swiftUnder);
    expect(gui.length).toBeGreaterThanOrEqual(8);
    expect(
      gui.flatMap((f) =>
        GUI_NEVER.filter((t) => archRead(f).includes(t)).map(
          (t) => `${f}: ${t}`,
        ),
      ),
    ).toEqual([]);
    // Non-vacuity: the spawner is in the sweep, and it sets what the host
    // does need.
    const spawner = `${MAC}/Sources/WeMessageDaemonHost/Spawner.swift`;
    expect(files).toContain(spawner);
    expect(archRead(spawner)).toContain('POSIX_SPAWN_SETSIGDEF');
    expect(archRead(spawner)).toContain('POSIX_SPAWN_CLOEXEC_DEFAULT');
  });

  it('main.swift checks --daemon before anything else', () => {
    // v2 S2c: the executable's first statement decides whether this is the
    // launchd path, so nothing a later slice adds to main.swift (a window,
    // an app delegate) runs ahead of it there.
    const statements = archRead(MAIN_SWIFT)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'))
      .filter((l) => !/^(?:@\w+\s+)*import\s/.test(l));
    expect(statements[0] ?? '').toContain('HostArguments.isDaemon');
  });

  it('.swift is a text extension and at least one is tracked', () => {
    expect(TEXT_EXTENSIONS.has('.swift')).toBe(true);
    expect(trackedSwift().length).toBeGreaterThan(0);
  });

  it('no .swift or fixtures/contract file carries an em dash', () => {
    const swift = trackedSwift();
    expect(swift.length).toBeGreaterThan(0);
    const files = [...swift, ...trackedUnder('fixtures/contract')];
    expect(files.filter((f) => archRead(f).includes(EM_DASH))).toEqual([]);
  });

  it('no .swift spells the token prefix followed by hex', () => {
    const TOKEN_HEX = /wm_[0-9a-f]{8,}/;
    const swift = trackedSwift();
    expect(swift.length).toBeGreaterThan(0);
    expect(swift.filter((f) => TOKEN_HEX.test(archRead(f)))).toEqual([]);
    // Non-vacuity: the token the Swift tests assemble at runtime would
    // convict if it were ever written out.
    expect(TOKEN_HEX.test(`wm_${'a'.repeat(64)}`)).toBe(true);
  });

  it('no .swift carries a 40-hex run or a literal ULID', () => {
    // The kit's tests load every id from fixtures/contract at runtime, so a
    // ULID or a digest written into a .swift file is a copy that can drift.
    const HEX40 = /[0-9a-fA-F]{40}/;
    const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;
    const swift = trackedSwift();
    expect(swift.length).toBeGreaterThan(0);
    expect(
      swift.filter((f) => HEX40.test(archRead(f)) || ULID.test(archRead(f))),
    ).toEqual([]);
    expect(ULID.test(`01${'A'.repeat(24)}`)).toBe(true);
    expect(HEX40.test('c'.repeat(40))).toBe(true);
  });

  it('ci-swift.yml is a real lane', () => {
    const text = archRead(CI_SWIFT);
    expect(text).toMatch(/^\s+runs-on: macos-26$/m);
    // Advisor S1 item 9: no fallback runner.
    expect(text).not.toContain('latest');
    expect(text).toContain('swift --version');
    expect(text).toContain('swift build --package-path apps/mac');
    expect(text).toContain('swift test --package-path apps/mac');
    expect(text).toMatch(/^ {2}pull_request:/m);
    expect(text).not.toContain('workflow_dispatch');
    // v2 S2c: the lane builds the release host and smokes `--daemon` with a
    // stub node. v2 S3: the otool step now proves the one executable DOES
    // link AppKit and SwiftUI (the window lives in it), and a second job,
    // `ui`, is the only place the app is ever launched.
    for (const needed of [
      'swift build -c release --package-path apps/mac',
      '--daemon',
      'otool -L',
      'AppKit',
      'SwiftUI',
      'xcodegen generate --spec apps/mac/project.yml',
      'tools/swift/xcodegen-fetch.sh',
      'xcodebuild test',
      '-test-timeouts-enabled YES',
      '-default-test-execution-time-allowance',
      '-maximum-test-execution-time-allowance',
      'automationmodetool',
      'DOES NOT REQUIRE',
      'AppleKeyboardUIMode -int 2',
      '>> "$GITHUB_ENV"',
      'RESULTS=$RUNNER_TEMP/results.xcresult',
      'needs: [kit]',
      'if-no-files-found: warn',
      // v2 S3b: the fake daemon starts before xcodebuild, in the background
      // with its pipes redirected, and is stopped whatever happened.
      'node tools/swift/fake-daemon.mjs --dir "$WEMESSAGE_DIR" --port "$WEMESSAGE_PORT"',
      '--pid-file "$RUNNER_TEMP/fake-daemon.pid"',
      // v2 S4b (advisor item 3): one port, the same start line, plus the
      // loopback control routes the UI tests reset and read the journal on.
      '--pid-file "$RUNNER_TEMP/fake-daemon.pid" --control >',
      '> "$RUNNER_TEMP/fake-daemon.ready" 2> "$RUNNER_TEMP/fake-daemon.err" &',
      'http://127.0.0.1:$WEMESSAGE_PORT/v1/health',
      'TEST_RUNNER_WEMESSAGE_DIR="$WEMESSAGE_DIR"',
      'TEST_RUNNER_WEMESSAGE_PORT="$WEMESSAGE_PORT"',
      'TEST_RUNNER_TZ=UTC',
      'WEMESSAGE_DIR=$RUNNER_TEMP/wm',
      'kill "$pid"',
    ])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
    // The daemon is up before the tests and stopped after them.
    const at = (s: string) => text.indexOf(s);
    expect(at('node tools/swift/fake-daemon.mjs')).toBeLessThan(
      at('xcodebuild test \\'),
    );
    expect(at('xcodebuild test \\')).toBeLessThan(at('kill "$pid"'));
    expect(/- name: stop the fake daemon\n\s+if: always\(\)\n/.test(text)).toBe(
      true,
    );
    // P0-3: both jobs carry a limit, so a hung launch fails in minutes.
    expect(text.match(/^\s+timeout-minutes: \d+$/gm)?.length).toBe(2);
    expect(text.match(/^\s+runs-on: macos-26$/gm)?.length).toBe(2);
    // P1-1: ad hoc signing from project.yml is the only mode; no override.
    expect(text).not.toContain('CODE_SIGNING_ALLOWED');
    // E20: `${{ runner.temp }}` is illegal in job env; it may appear only as
    // an upload `path:` inside a `with:` block.
    const temps = text
      .split('\n')
      .filter((l) => l.includes('runner.temp') && !l.trim().startsWith('#'));
    expect(temps.length).toBeGreaterThanOrEqual(1);
    expect(temps.filter((l) => !/^\s+path:/.test(l))).toEqual([]);
    // XcodeGen writes a local package's path verbatim relative to the
    // .xcodeproj, so the project is generated beside its spec (run
    // 37550471920 measured the failure from .build/xcodeproj), and that
    // generated project is ignored, never tracked.
    expect(text).toContain(
      'xcodegen generate --spec apps/mac/project.yml --project apps/mac --quiet',
    );
    expect(text).toContain('-project apps/mac/WeMessage.xcodeproj ');
    expect(text).not.toContain('.build/xcodeproj');
    expect(archRead('.gitignore').split('\n')).toContain(
      '/apps/mac/WeMessage.xcodeproj/',
    );
    // D3: bare launch opens a window now; the kit job never runs it. (The
    // stub's own "exits 0 on it" comments in checks 1-3 stay as S2c wrote them.)
    expect(text).not.toContain('usage line');
    expect(text).not.toMatch(/"\$exe";/);
    expect(text).toContain('echo "host smoke passed: 7, 0 after TERM, 78"');
    expect(text).not.toContain('WEMESSAGE_SNAPSHOT_DIR');
    // The word list of the Sc17 'neither signs' row, applied to this file.
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
  });

  it('the ui shards cover every XCUITest class once (S4j)', () => {
    // v2 S4j: the `ui` job is a two-way matrix and each shard names its
    // XCUITest classes explicitly through -only-testing. A class in neither
    // list would compile, launch nothing and stay green, so a new board test
    // must land in exactly one shard or this row goes red.
    const text = archRead(CI_SWIFT);
    const shards = [
      ...text.matchAll(/^ {10}- shard: (\w+)\n {12}classes: ([^\n]+)$/gm),
    ].map((m) => ({ shard: m[1]!, classes: m[2]!.trim().split(/\s+/) }));
    // v2 S7b: shard c is BoardSweepTests alone.
    expect(shards.map((s) => s.shard)).toEqual(['a', 'b', 'c']);
    expect(shards.find((s) => s.shard === 'c')?.classes).toEqual([
      'BoardSweepTests',
    ]);
    const classes = trackedUnder(UI_TESTS)
      .filter((f) => f.endsWith('.swift'))
      .flatMap((f) => [
        ...archRead(f).matchAll(
          /^\s*(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase\b/gm,
        ),
      ])
      .map((m) => m[1]!)
      .sort();
    // Non-vacuity: the reader sees the thirteen classes S4i shipped.
    expect(classes.length).toBeGreaterThanOrEqual(13);
    expect(classes).toContain('Board12Tests');
    // v2 S7a: the perf class rides shard a, where the G2 ui report is read.
    expect(shards.find((s) => s.shard === 'a')?.classes).toContain(
      'Board00PerfTests',
    );
    const named = shards.flatMap((s) => s.classes);
    expect(classes.filter((c) => !named.includes(c))).toEqual([]);
    expect(named.filter((c) => !classes.includes(c))).toEqual([]);
    expect(named.filter((c, k) => named.indexOf(c) !== k)).toEqual([]);
    // The list reaches xcodebuild, once per class, inside the one test step.
    for (const needed of [
      'UI_SHARD_CLASSES: ${{ matrix.classes }}',
      'for class in $UI_SHARD_CLASSES; do only="$only -only-testing:WeMessageUITests/$class"; done',
      '            $only \\\n',
      'fail-fast: false',
      'wemessage-ui-snapshots-${{ github.sha }}-${{ matrix.shard }}',
      'wemessage-ui-xcresult-${{ github.sha }}-${{ matrix.shard }}',
      '${{ env.SNAPSHOTS_OUT }}/manifest-${{ matrix.shard }}.json',
    ])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
    // Each shard keeps the job's 30 minutes; the cap is not the lever.
    expect(text).toMatch(
      /^ {2}ui:\n(?: {4}[^\n]*\n)*? {4}timeout-minutes: 30$/m,
    );
  });

  it('every board test has a case in the board sweep (S7b)', () => {
    // v2 S7b: BoardSweepTests iterates SweptBoard.allCases, so a board is
    // swept only if it has a case. Every BoardNNTests class (00 is the perf
    // class, not a board) must have its `case bNN = "NN"`, and no case may
    // name a board with no test of its own.
    const sweep = archRead(
      'apps/mac/UITests/WeMessageUITests/Support/BoardSweep.swift',
    );
    const cases = [...sweep.matchAll(/\bb(\d{2}) = "(\d{2})"/g)]
      .map((m) => {
        expect(m[1]).toBe(m[2]);
        return m[1]!;
      })
      .sort();
    const boards = trackedUnder(UI_TESTS)
      .map((f) => /(?:^|\/)Board(\d{2})Tests\.swift$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined && n !== '00')
      .sort();
    // Non-vacuity: the seventeen boards the wireframes define.
    expect(boards).toHaveLength(17);
    expect(cases).toEqual(boards);
  });

  it('the ui job turns Reduce Transparency off before the tests (S4a)', () => {
    // v2 S4a (S4.0 spike, run 37568873983): the macOS 26 image ships with
    // Reduce Transparency on, which draws every material opaque; the frost
    // legs would then measure a flat fill. The job writes it off, reads it
    // back and fails unless it reads 0, all before xcodebuild; the FROST
    // lines the snapshots print are kept from a raw log on every outcome.
    const text = archRead(CI_SWIFT);
    const write =
      'defaults write com.apple.universalaccess reduceTransparency -bool false';
    const read =
      'value=$(defaults read com.apple.universalaccess reduceTransparency)';
    const check = 'test "$value" = 0 || {';
    for (const needed of [write, read, check])
      expect([needed, text.split(needed).length - 1]).toEqual([needed, 1]);
    const at = (s: string) => text.indexOf(s);
    expect(at(write)).toBeLessThan(at(read));
    expect(at(read)).toBeLessThan(at(check));
    expect(at(check)).toBeLessThan(at('xcodebuild test \\'));
    expect(text).toMatch(
      /- name: Reduce Transparency off, so the window frost is real\n\s+run: \|\n\s+set -eu\n/,
    );
    // The raw log sits before xcbeautify, and its FROST lines print always.
    expect(text).toContain(
      '| tee "$RUNNER_TEMP/xcodebuild-raw.log" \\\n            | xcbeautify --renderer github-actions',
    );
    expect(/- name: frost evidence\n\s+if: always\(\)\n/.test(text)).toBe(true);
    expect(text).toContain("awk '/FROST\\|/");
  });

  it('project.yml is the CI-only spec', () => {
    const text = archRead(PROJECT_YML);
    expect(text.split('type: application').length - 1).toBe(1);
    expect(text.split('type: bundle.ui-testing').length - 1).toBe(1);
    // P2-3: the Xcode target cannot share the local package target's name;
    // the product name does, so the bundle is WeMessage.app.
    const targets = /^targets:\n([\s\S]*?)^\S/m.exec(text)?.[1] ?? '';
    expect(targets).toMatch(/^ {2}WeMessageMac:$/m);
    expect(targets).not.toMatch(/^ {2}WeMessage:$/m);
    expect(targets.match(/^ {2}\w+:$/gm)).toEqual([
      '  WeMessageMac:',
      '  WeMessageUITests:',
    ]);
    expect(text).toContain('PRODUCT_NAME: WeMessage\n');
    // Prettier writes the repo's YAML with single quotes; either is one string.
    expect(text).toMatch(/macOS: ['"]26\.0['"]/);
    expect(text).toMatch(/^packages:\n {2}WeMessage:\n {4}path: \.$/m);
    // P1-5: S2d's plist, reused as is; S3 adds none.
    expect(text.split('INFOPLIST_FILE: Resources/Info.plist').length - 1).toBe(
      1,
    );
    expect(text.match(/^\s+INFOPLIST_FILE:/gm)?.length).toBe(1);
    // The UI test runner bundle gets a generated plist; without one ad hoc
    // signing refuses it (run 37551542294). The app keeps S2d's.
    const uiTarget =
      /^ {2}WeMessageUITests:\n([\s\S]*?)(?=^\S)/m.exec(text)?.[1] ?? '';
    expect(uiTarget).toMatch(/^\s+GENERATE_INFOPLIST_FILE: ['"]YES['"]$/m);
    expect(text.match(/GENERATE_INFOPLIST_FILE: ['"]NO['"]/g)?.length).toBe(1);
    expect(text).not.toContain('NSPrincipalClass');
    expect(
      text.split('PRODUCT_BUNDLE_IDENTIFIER: sh.wemessage.gateway\n').length -
        1,
    ).toBe(1);
    expect(text).toMatch(/CODE_SIGN_IDENTITY: ['"]-['"]/);
    expect(text).not.toMatch(/DEVELOPMENT_TEAM: "?[A-Z0-9]{10}"?/);
    for (const forbidden of ['codesign', 'keychain', 'secrets.'])
      expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);
    // The project is generated beside this spec in CI and is never tracked.
    expect(trackedUnder(MAC).filter((f) => /\.xcodeproj\//.test(f))).toEqual(
      [],
    );
    expect(trackedUnder(MAC).filter((f) => f.endsWith('Info.plist'))).toEqual([
      `${MAC}/Resources/Info.plist`,
    ]);
  });

  it('the UI tests read the window size from the app, never a literal', () => {
    // v2 S3a ships the LaunchTests half of R-A13 early: the runner's display
    // (1024 x 768, visible ~674) is smaller than the default, so a literal
    // size would be red every run, and a monitor read in the runner differs
    // from the app's by a few points.
    const launch = archRead(`${UI_TESTS}/LaunchTests.swift`);
    expect(launch).toContain('shellGeometry');
    expect(launch).toContain('ProvisionalUI.windowDefaultWidth');
    const code = launch
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code.match(/\b(?:1180|760|870|560)\b/g) ?? []).toEqual([]);
    for (const banned of [
      'write(to:',
      'FileManager.default.createFile',
      'WEMESSAGE_SNAPSHOT_DIR',
    ])
      expect([banned, launch.includes(banned)]).toEqual([banned, false]);
  });

  it('the transcript mounts its rows lazily and reads the daemon page of 200 (S7a)', () => {
    // v2 S7a: the 2,000-turn bulk thread is read 200 turns at a time and
    // the stack mounts only the rows on screen; Board00PerfTests holds the
    // mounted count to G2Limits.mountedTranscriptRows in CI. This row is the
    // same promise in text, so a plain VStack is red before the ui lane runs.
    const view = archRead(
      `${MAC}/Sources/WeMessageApp/Boards/Thread/TranscriptView.swift`,
    );
    expect(view).toMatch(/LazyVStack\([^)]*\)\s*\{\s*ForEach\(rows\)/);
    const model = archRead(
      `${MAC}/Sources/WeMessageApp/Models/ThreadModel.swift`,
    );
    expect(model).toContain('public static let pageLimit = 200');
    expect(model).toContain('limit: Self.pageLimit');
  });

  it('the fake daemon imports node builtins only and serves the goldens from fixtures', () => {
    // v2 S3b R-A12 (§4.10, P2-12): loopback is not an option, the bearer
    // compare is constant-time, and every byte it answers is read from
    // fixtures/contract at runtime, never written into the script.
    const text = archRead('tools/swift/fake-daemon.mjs');
    const specs = [
      ...text.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm),
    ].map((m) => m[1]);
    expect(specs.length).toBeGreaterThanOrEqual(4);
    // v2 S7a: one sibling, the `bulk` scenario's generator, which itself
    // imports nothing at all (pure functions over a seed).
    expect(
      specs.filter((s) => !s?.startsWith('node:') && s !== './bulk.mjs'),
    ).toEqual([]);
    const bulk = archRead('tools/swift/bulk.mjs');
    expect(bulk).not.toMatch(/^\s*import\s/m);
    expect(bulk).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toMatch(/\brequire\s*\(/);
    for (const needed of [
      "'wm_'",
      'timingSafeEqual',
      'fixtures/contract',
      "'127.0.0.1'",
      '0o600',
      // v2 S4b: scenarios are read from fixtures too, and the control
      // routes exist only behind --control and a loopback peer.
      'fixtures/scenarios',
      "'--control'",
      'LOOPBACK_PEERS.has(',
      '!state.control',
    ])
      expect([needed, text.includes(needed)]).toEqual([needed, true]);
    expect(text).not.toContain('--host');
    expect(text).not.toContain("'localhost'");
    expect(text).not.toContain("'0.0.0.0'");
    for (const banned of [
      '+1555',
      '@example.com',
      'process.env.WEMESSAGE_TOKEN',
    ])
      expect([banned, text.includes(banned)]).toEqual([banned, false]);
    expect(text).not.toMatch(/wm_[0-9a-f]{64}/);
    // No literal golden: every status other than the parse-time fallback
    // comes from a fixture.
    expect(text).not.toMatch(/"connectionState"|fully-connected/);
    // The bearer is never compared with === or !==.
    expect(text).not.toMatch(/(token|bearer|authorization)\w*\s*[!=]==/i);
    expect(text).not.toMatch(/[!=]==\s*\w*(token|bearer)/i);
  });

  it('the fake daemon scenarios are synthetic data only', () => {
    // v2 S4b: fixtures/scenarios overlays the S0 goldens. Phones are +1555,
    // emails are example.com, and nothing in it is shaped like a bearer.
    // test/swift-scenarios.spec.ts validates the shapes; this row guards
    // the tracked bytes.
    const files = trackedUnder('fixtures/scenarios');
    expect(files.length).toBeGreaterThanOrEqual(30);
    let phones = 0;
    for (const file of files) {
      const text = archRead(file);
      expect([file, /\u2014/.test(text)]).toEqual([file, false]);
      for (const n of text.match(/\+1\d{10}/g) ?? [])
        expect([file, n.startsWith('+1555')]).toEqual([file, true]);
      phones += (text.match(/\+1555\d{7}/g) ?? []).length;
      for (const e of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [])
        expect([file, e.endsWith('@example.com')]).toEqual([file, true]);
      expect([file, /wm_[0-9a-f]{8}/.test(text)]).toEqual([file, false]);
      expect([file, publicStringOffenders(text)]).toEqual([file, []]);
    }
    expect(phones).toBeGreaterThan(20);
  });

  it('every UI test class resets the fake daemon in setUp', () => {
    // v2 S4b (advisor item 3): the control routes are one daemon shared by
    // every class, so each starts from the S0 goldens and an empty journal.
    const classes = trackedUnder(UI_TESTS).filter(
      (f) =>
        f.endsWith('.swift') &&
        !f.includes('/Support/') &&
        archRead(f).includes(': XCTestCase {'),
    );
    expect(classes.length).toBeGreaterThanOrEqual(5);
    expect(classes).toContain(`${UI_TESTS}/FakeDaemonControlTests.swift`);
    for (const f of classes) {
      const text = archRead(f);
      expect([f, text.includes('override func setUp() async throws')]).toEqual([
        f,
        true,
      ]);
      expect([f, text.includes('try await FakeDaemon.reset()')]).toEqual([
        f,
        true,
      ]);
    }
    const helper = archRead(`${UI_TESTS}/Support/FakeDaemon.swift`);
    for (const needed of [
      '"/v1/_reset"',
      '"/v1/_scenario"',
      '"/v1/_journal"',
      'http://127.0.0.1:',
      'func assertNoSend(',
      '"/v1/send"',
    ])
      expect([needed, helper.includes(needed)]).toEqual([needed, true]);
    const proof = archRead(`${UI_TESTS}/FakeDaemonControlTests.swift`);
    expect(proof).toContain('FakeDaemon.scenario(');
    expect(proof).toContain('FakeDaemon.assertNoSend()');
  });

  it('the UI tests copy the environment by name and never render the token', () => {
    // v2 S3b (TN-env-forward): nothing reaches the app wholesale; the
    // connection tests prove the line in words and look for any "wm_".
    const support = archRead(`${UI_TESTS}/Support/UITestApp.swift`);
    expect(support).not.toContain('launchEnvironment = ProcessInfo');
    expect(support).toContain(
      'for key in ["WEMESSAGE_DIR", "WEMESSAGE_PORT", "TZ"]',
    );
    const conn = archRead(`${UI_TESTS}/ConnectionTests.swift`);
    for (const needed of [
      'func testConnectsToFakeDaemon()',
      'func testDaemonDownIsSaidPlainly()',
      'ProvisionalUI.downLine',
      'ProvisionalUI.connectedLine(state:',
      'fully-connected',
      '"47199"',
      '"wm_"',
    ])
      expect([needed, conn.includes(needed)]).toEqual([needed, true]);
  });

  it('the UI tests audit accessibility and ignore nothing', () => {
    // v2 S3c R-A13 (§4.5, E12): the audit runs with a handler that keeps
    // every issue. An ignore, if one is ever needed, names the Xcode build
    // it was observed on (17F113) beside it.
    const a11y = archRead(`${UI_TESTS}/AccessibilityTests.swift`);
    for (const needed of [
      'func testShellPassesAccessibilityAudit()',
      'func testKeyboardPath()',
      'performAccessibilityAudit',
      'AppleKeyboardUIMode',
      'XCTSkipUnless',
      'modifierFlags: .command',
    ])
      expect([needed, a11y.includes(needed)]).toEqual([needed, true]);
    const ui = trackedUnder(UI_TESTS)
      .filter((f) => f.endsWith('.swift'))
      .map((f) => archRead(f))
      .join('\n');
    expect(ui).not.toMatch(
      /performAccessibilityAudit\([^)]*\)\s*\{[^}]*return true/,
    );
    const lines = ui.split('\n');
    lines.forEach((line, i) => {
      if (!/return true/.test(line)) return;
      const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      expect([line, near.includes('17F113')]).toEqual([line, true]);
    });
  });

  it('the audit ignores only the two pieces of runner chrome, each pinned to its element (R-A13b)', () => {
    // v2 S3c fix: the ci-swift runner's Xcode 26.6 (17F113) raises two issues
    // on elements the app does not draw (run 37555284794). The handler may
    // hand them to isSystemChrome and nothing else; that helper matches the
    // audit type, the description AND the element, and never says a bare
    // `true`, so it cannot widen into an ignore-everything.
    const a11y = archRead(`${UI_TESTS}/AccessibilityTests.swift`);
    const handler =
      /performAccessibilityAudit\(\)\s*\{([\s\S]*?)\n {4}\}/.exec(a11y)?.[1] ??
      '';
    expect(handler).not.toBe('');
    const returns = handler.match(/\breturn\b[^\n]*/g) ?? [];
    // R-A13c: the one other way out is a contrast issue whose own pixels
    // clear WCAG AA (see the PixelContrast row below).
    // v2 S4i adds two more ways out, each pinned below: AppKit's field
    // editor under a focused board 11 field, and a contrast issue on a
    // label its own scroll view has scrolled out of sight (run 37756434645).
    expect(returns).toEqual(['return chrome || editor || cleared || away']);
    expect(handler).toContain('Self.isSystemChrome(issue, in: app)');
    expect(handler).toContain(
      'let editor = Self.isFieldEditor(issue, in: app)',
    );
    // `away` is only ever asked after a contrast issue's own pixels failed.
    expect(handler).toContain(
      'if measured?.passes != true { away = Self.isScrolledAway(element, in: app) }',
    );
    expect(handler.match(/away = Self\./g) ?? []).toHaveLength(1);
    const editorHelper =
      /static func isFieldEditor[\s\S]*?\n {2}\}/.exec(a11y)?.[0] ?? '';
    for (const needed of [
      'issue.element == nil',
      'issue.auditType == .parentChild',
      'issue.compactDescription == "Parent/Child mismatch"',
      '[ID.searchField, ID.findField, ID.switcherField]',
      'hasKeyboardFocus == true',
      'fields.contains(focused.identifier)',
    ])
      expect([needed, editorHelper.includes(needed)]).toEqual([needed, true]);
    expect(editorHelper).not.toMatch(/return true/);
    const awayHelper =
      /static func isScrolledAway[\s\S]*?\n {2}\}/.exec(a11y)?.[0] ?? '';
    for (const needed of [
      'app.scrollViews',
      '!scroll.frame.contains(frame)',
      'node.frame == frame && node.elementType == element.elementType',
    ])
      expect([needed, awayHelper.includes(needed)]).toEqual([needed, true]);
    expect(awayHelper).not.toMatch(/return true/);
    const helper =
      /static func isSystemChrome[\s\S]*?\n {2}\}/.exec(a11y)?.[0] ?? '';
    for (const needed of [
      '17F113',
      '.sufficientElementDescription',
      '"Element has no description"',
      'element.elementType == .touchBar',
      '.parentChild',
      '"Parent/Child mismatch"',
      'element.elementType == .group',
      '"_XCUI:FullScreenWindow"',
      'element.identifier.isEmpty',
    ])
      expect([needed, helper.includes(needed)]).toEqual([needed, true]);
    expect(helper).not.toMatch(/return true/);
  });

  it('a contrast issue is set aside only when its own pixels clear WCAG AA (R-A13c)', () => {
    // v2 S3c fix: on the 1x runner (17F113) the audit flags the three inkDim
    // labels while their screenshots measure 9.6:1 to 10.1:1 (runs
    // 37557960836, 37558534074). The handler may set aside a .contrast issue
    // only on a measurement of that element's own screenshot, at the AA
    // floor, with more than a stray pixel of ink; every other audit type and
    // any measured failure still fails the run.
    const a11y = archRead(`${UI_TESTS}/AccessibilityTests.swift`);
    const handler =
      /performAccessibilityAudit\(\)\s*\{([\s\S]*?)\n {4}\}/.exec(a11y)?.[1] ??
      '';
    for (const needed of [
      'issue.auditType == .contrast',
      'element.screenshot()',
      'PixelContrast.measure(image)',
      'let cleared = measured?.passes ?? false',
    ])
      expect([needed, handler.includes(needed)]).toEqual([needed, true]);
    const pc = archRead(`${UI_TESTS}/Support/PixelContrast.swift`);
    expect(pc).toMatch(/static let floor = 4\.5\b/);
    expect(pc).toMatch(/static let minInkPixels = 4\b/);
    expect(pc).toContain(
      'ratio >= PixelContrast.floor && inkPixels >= PixelContrast.minInkPixels',
    );
    expect(pc).not.toMatch(/return true/);
  });

  it('snapshots are produced and swept in the test, not diffed (R-A13d)', () => {
    // v2 S3d (§5.4, E19, D5, P2-4): the light and dark PNGs leave only as
    // .keepAlways attachments that the job exports; the runner writes no
    // file, nothing is compared with a stored golden, and the sweep and its
    // traffic-light mask live in the test.
    const files = trackedUnder(UI_TESTS).filter((f) => f.endsWith('.swift'));
    expect(files).toContain(`${UI_TESTS}/SnapshotTests.swift`);
    expect(files).toContain(`${UI_TESTS}/Support/NoGreen.swift`);
    const ui = files.map((f) => archRead(f)).join('\n');
    for (const needed of [
      'pngRepresentation',
      'keepAlways',
      'NoGreen.offenders',
      'NoGreen.tinted',
      'NoGreen.isBlank',
      'NoGreen.meanLuminance',
      'trafficLightBand',
      'shellGeometry',
      // v2 S4a: each appearance twice, frost on and Reduce Transparency
      // forced, named for board 01, each with its frost evidence.
      'func testShellLightFrost()',
      'func testShellDarkFrost()',
      'func testShellLightOpaque()',
      'func testShellDarkOpaque()',
      'func testNoGreenSweepSeesGreen()',
      'func testFrostEvidenceSeesFlatFill()',
      '"board-01-shell-light.png"',
      '"board-01-shell-dark.png"',
      '"board-01-shell-opaque-light.png"',
      '"board-01-shell-opaque-dark.png"',
      'FrostEvidence.frostFailures(reading)',
      'FrostEvidence.opaqueFailures(reading, layer0: FrostEvidence.layer0(dark: appearance == "dark"))',
      'XCTAssertEqual(failures, [], ',
    ])
      expect([needed, ui.includes(needed)]).toEqual([needed, true]);
    for (const banned of [
      'write(to:',
      'FileManager.default.createFile',
      'WEMESSAGE_SNAPSHOT_DIR',
      'snapshotDir',
    ])
      expect([banned, ui.includes(banned)]).toEqual([banned, false]);
    // The geometry comes from the app, never a monitor assumption.
    const snap = archRead(`${UI_TESTS}/SnapshotTests.swift`)
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(snap.match(/\b(?:1180|760)\b/g) ?? []).toEqual([]);
    // The shots themselves are swept, not only the probes.
    for (const needed of [
      'XCTAssertEqual(NoGreen.offenders(png, excluding: band), 0',
      'NoGreen.tinted(png, hue: NoGreen.tintHue, tolerance: 15, minSaturation: 0.5), 0, "\\(name): no tint on screen")',
      'XCTAssertFalse(NoGreen.isBlank(png)',
      'band.width * band.height, 0.02 * area',
    ])
      expect([needed, snap.includes(needed)]).toEqual([needed, true]);
    // No stored goldens in S3.
    expect(
      [...trackedUnder(MAC), ...trackedUnder('fixtures')].filter((f) =>
        /\.png$/i.test(f),
      ),
    ).toEqual([]);
    // The job: export with the selected Xcode's xcresulttool after a green
    // test step, upload the PNGs with `error`, and keep the result bundle
    // upload on every outcome with `warn`.
    const ci = archRead(CI_SWIFT);
    for (const needed of [
      '"$(xcode-select -p)/usr/bin/xcresulttool" export attachments --path "$RESULTS" --output-path "$SNAPSHOTS_OUT"',
      '${{ env.SNAPSHOTS_OUT }}/*.png',
      'wemessage-ui-snapshots-${{ github.sha }}',
    ])
      expect([needed, ci.includes(needed)]).toEqual([needed, true]);
    const step = (name: string) =>
      new RegExp(
        `- name: ${name}\\n(?:\\s+[^\\n]*\\n)*?\\s+if: ([^\\n]+)\\n`,
      ).exec(ci)?.[1];
    expect(step('export snapshot attachments from the result bundle')).toBe(
      'success()',
    );
    expect(step('snapshots')).toBe('success()');
    expect(step('result bundle')).toBe('always()');
    const block = (name: string) =>
      ci.slice(ci.indexOf(`- name: ${name}\n`)).split(/\n {6}- /)[0];
    expect(block('snapshots')).toContain('if-no-files-found: error');
    expect(block('result bundle')).toContain('if-no-files-found: warn');
    const at = (s: string) => ci.indexOf(s);
    expect(at('xcodebuild test \\')).toBeLessThan(at('xcresulttool'));
    expect(at('xcresulttool')).toBeLessThan(at('- name: snapshots\n'));
  });

  it('the tint triple is written twice and equal (R-A14)', () => {
    // v2 S3d (§4.10, P0-1): the positive tint assertion reads NoGreen.tintRGB,
    // the one colour literal outside Tokens.swift; the two must move together.
    const ui = trackedUnder(UI_TESTS)
      .filter((f) => f.endsWith('.swift'))
      .map((f) => archRead(f))
      .join('\n');
    const tests = [
      ...ui.matchAll(
        /tintRGB: \(UInt8, UInt8, UInt8\) = \((0x[0-9A-F]{2}), (0x[0-9A-F]{2}), (0x[0-9A-F]{2})\)/g,
      ),
    ];
    expect(tests.length).toBe(1);
    const tokens = [
      ...archRead(`${MAC}/Sources/WeMessageApp/Tokens.swift`).matchAll(
        /static let tint = RGB\((0x[0-9A-F]{2}), (0x[0-9A-F]{2}), (0x[0-9A-F]{2})\)/g,
      ),
    ];
    expect(tokens.length).toBe(1);
    expect(tests[0]!.slice(1)).toEqual(tokens[0]!.slice(1));
  });

  it('apps/mac/README.md names every accessibility identifier the shell publishes (R-A15)', () => {
    // v2 S3e (§5.5): the identifier table is the contract a S4 builder reads;
    // it cannot drift from ShellView.swift without this row going red.
    const shell = archRead(`${MAC}/Sources/WeMessageApp/ShellView.swift`);
    const ids = [
      ...new Set(
        [...shell.matchAll(/"(wemessage(?:\.[a-z]+)*)"/g)].map((m) => m[1]!),
      ),
    ];
    expect(ids.length).toBeGreaterThanOrEqual(12);
    const readme = archRead(`${MAC}/README.md`);
    for (const id of ids)
      expect([id, readme.includes(`\`${id}\``)]).toEqual([id, true]);
    // ...and names none the shell does not publish.
    const named = [
      ...new Set(
        [...readme.matchAll(/`(wemessage\.[a-z.]+)`/g)].map((m) => m[1]!),
      ),
    ];
    expect(named.filter((id) => !ids.includes(id))).toEqual([]);
    for (const heading of ['## The CI UI lane', '## Known seams'])
      expect([heading, readme.includes(heading)]).toEqual([heading, true]);
    for (const doc of [`${MAC}/README.md`, 'tools/swift/README.md']) {
      const text = archRead(doc);
      expect([doc, /\/Users\//.test(text), text.includes('\u2014')]).toEqual([
        doc,
        false,
        false,
      ]);
    }
    const tools = archRead('tools/swift/README.md');
    for (const flag of ['--dir', '--port', '--pid-file', '--out'])
      expect([flag, tools.includes(flag)]).toEqual([flag, true]);
    const releasing = archRead('RELEASING.md');
    expect(releasing).toMatch(
      /`ui` job[\s\S]{0,200}ad hoc signed[\s\S]{0,200}never what ships/,
    );
  });

  it('tools/swift/xcodegen.lock.json pins one XcodeGen release by sha256', () => {
    const lock = JSON.parse(
      archRead('tools/swift/xcodegen.lock.json'),
    ) as Record<string, unknown>;
    expect(Object.keys(lock).sort()).toEqual([
      'asset',
      'sha256',
      'source',
      'version',
    ]);
    expect(String(lock.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(lock.source).endsWith(`/${String(lock.version)}/`)).toBe(
      true,
    );
    const fetch = archRead('tools/swift/xcodegen-fetch.sh');
    for (const needed of [
      'xcodegen.lock.json',
      'curl -fsSL --retry 3',
      'shasum -a 256',
      'exit 2',
      'unzip -q',
      'share',
    ])
      expect([needed, fetch.includes(needed)]).toEqual([needed, true]);
    // The digest lives in the lock only; the script reads it.
    expect(fetch).not.toContain(String(lock.sha256));
    // Commands, not prose: the header may say it never touches Homebrew.
    for (const banned of [/\bgrep\b/, /\bjq\b/, /\bnode\b/, /(?<!Home)brew\b/])
      expect([String(banned), banned.test(fetch)]).toEqual([
        String(banned),
        false,
      ]);
  });

  it('the Swift lane is not a step in ci-macos.yml', () => {
    expect(archRead(CI_MACOS)).not.toContain('swift ');
  });

  it('apps/mac has no vitest.config.ts', () => {
    // pnpm test sweeps the Swift tree as text; it never spawns it. A vitest
    // config here would join the `apps/*/vitest.config.ts` glob, and a
    // package.json would join the pnpm workspace's `apps/*` glob.
    expect(existsSync(join(repoRoot, MAC, 'Package.swift'))).toBe(true);
    expect(existsSync(join(repoRoot, MAC, 'vitest.config.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, MAC, 'package.json'))).toBe(false);
    expect(
      trackedUnder(MAC).filter((f) => /(^|\/)vitest\.[\w.]*$/.test(f)),
    ).toEqual([]);
  });

  it('/apps/mac/.build/ is ignored', () => {
    for (const probe of [`${MAC}/.build/x`, `${MAC}/.swiftpm/x`]) {
      const r = spawnSync('git', ['check-ignore', '-q', probe], {
        cwd: repoRoot,
      });
      expect([probe, r.status]).toEqual([probe, 0]);
    }
    // Non-vacuity: the sources themselves are not ignored.
    for (const dir of SOURCES) {
      const src = spawnSync('git', ['check-ignore', '-q', `${dir}/x.swift`], {
        cwd: repoRoot,
      });
      expect([dir, src.status]).toEqual([dir, 1]);
    }
  });
});

describe('v2 S2c.1: host hardening before a signed build gets Full Disk Access', () => {
  /**
   * The advisor's three P0s and the lead's PATH finding, as text. Each closes
   * a way for a same-user process to choose what the host's child runs or
   * loads, which becomes "run code with the app's Full Disk Access" the day
   * a signed build is granted it. The Swift rows (HostEnvironmentTests row 5,
   * HostLayoutTests row 4, DaemonHostTests rows 11 and 11b) prove the
   * behaviour; these rows pin the structure a release build depends on.
   */
  const HOST = 'apps/mac/Sources/WeMessageDaemonHost';
  const HOST_ENV = `${HOST}/HostEnvironment.swift`;
  const HOST_LAYOUT = `${HOST}/HostLayout.swift`;
  const PACKAGE = 'apps/mac/Package.swift';
  const CI_SWIFT = '.github/workflows/ci-swift.yml';
  const BUNDLER = 'tools/release/bin/bundle-daemon.mjs';
  const FLAG = 'WEMESSAGE_HOST_OVERRIDES';
  const NODE_KEY = 'WEMESSAGE_HOST_NODE';
  const MAIN_KEY = 'WEMESSAGE_HOST_MAIN';

  /** The string literals of `name: Set<String> = [ ... ]`, or null. */
  const setLiteral = (text: string, name: string): string[] | null => {
    const body = new RegExp(
      `\\b${name}:\\s*Set<String>\\s*=\\s*\\[([^\\]]*)\\]`,
    ).exec(text)?.[1];
    return body === undefined
      ? null
      : [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '').sort();
  };

  /**
   * `text` split into what sits inside `#if WEMESSAGE_HOST_OVERRIDES` ...
   * `#endif` blocks and what sits outside them.
   */
  const splitOnFlag = (text: string): { inside: string[]; outside: string } => {
    const inside: string[] = [];
    const outside = text.replace(
      new RegExp(`^[ \\t]*#if ${FLAG}\\b([\\s\\S]*?)^[ \\t]*#endif\\b`, 'gm'),
      (_, block: string) => {
        inside.push(block);
        return '';
      },
    );
    return { inside, outside };
  };

  it('P0-1/P0-4: HostEnvironment is an allowlist of exactly ten keys, with no denylist, and pins PATH', () => {
    const text = archRead(HOST_ENV);
    expect(text).not.toContain('strippedKeys');
    expect(setLiteral(text, 'forwardedKeys')).toEqual(
      [
        'WEMESSAGE_DIR',
        'WEMESSAGE_PORT',
        'WEMESSAGE_CHATDB',
        'WEMESSAGE_SUPERVISOR',
        'WEMESSAGE_LAUNCHD_LABEL',
        'HOME',
        'TMPDIR',
        'TZ',
        'USER',
        'LOGNAME',
      ].sort(),
    );
    expect(text).toContain(
      'public static let childPath = "/usr/bin:/bin:/usr/sbin:/sbin"',
    );
    // Non-vacuity: the reader sees a set literal across lines.
    expect(
      setLiteral(
        'static let forwardedKeys: Set<String> = [\n  "B", "A",\n]',
        'forwardedKeys',
      ),
    ).toEqual(['A', 'B']);
  });

  it('P0-2: Package.swift defines WEMESSAGE_HOST_OVERRIDES for debug only, on the host target only', () => {
    const text = archRead(PACKAGE);
    expect(text.split(FLAG).length - 1).toBe(1);
    const targets = text
      .split(/(?=\.(?:target|executableTarget|testTarget)\()/)
      .slice(1);
    // v2 S3 adds WeMessageApp and WeMessageAppTests; neither carries the flag.
    expect(targets.length).toBe(7);
    const naming = targets
      .filter((t) => t.includes(FLAG))
      .map((t) => /name:\s*"(\w+)"/.exec(t)?.[1]);
    expect(naming).toEqual(['WeMessageDaemonHost']);
    expect(targets.find((t) => t.includes(FLAG))).toMatch(
      /swiftSettings:\s*\[\s*\.define\("WEMESSAGE_HOST_OVERRIDES",\s*\.when\(configuration:\s*\.debug\)\)/,
    );
  });

  it('P0-2: HostLayout reads the override keys only inside #if WEMESSAGE_HOST_OVERRIDES', () => {
    const { inside, outside } = splitOnFlag(archRead(HOST_LAYOUT));
    expect(inside.length).toBeGreaterThanOrEqual(1);
    const block = inside.join('\n');
    // The block is the whole of the override path: both keys and the read.
    for (const needed of [NODE_KEY, MAIN_KEY, 'environment['])
      expect([needed, block.includes(needed)]).toEqual([needed, true]);
    // No #else arm can hide a second reading of them.
    expect(block).not.toMatch(/^[ \t]*#(?:else|elseif)\b/m);
    // Outside the block, a release build compiles nothing that names or
    // reads them, comments included.
    for (const banned of [NODE_KEY, MAIN_KEY, 'environment['])
      expect([banned, outside.includes(banned)]).toEqual([banned, false]);
    // Non-vacuity: the splitter separates a block from its surroundings.
    const probe = splitOnFlag(
      `a\n#if ${FLAG}\n  environment[x]\n#endif\nb environment[y]\n`,
    );
    expect(probe.inside).toEqual(['\n  environment[x]\n']);
    expect(probe.outside).toContain('b environment[y]');
    expect(probe.outside).not.toContain('environment[x]');
  });

  it('P0-2: ci-swift checks the release binary for the override keys, and the smoke runs a fake bundle with none', () => {
    const text = archRead(CI_SWIFT);
    const steps = text.split(/\n(?= {6}- )/);
    const release = steps.findIndex((s) =>
      s.includes('name: Build the host (release)'),
    );
    const strings = steps.findIndex((s) => s.includes('strings -a'));
    const smoke = steps.findIndex((s) => s.includes('name: Host smoke'));
    expect([release, strings, smoke].every((i) => i > 0)).toBe(true);
    expect(strings).toBeGreaterThan(release);
    const check = steps[strings] ?? '';
    for (const needed of [NODE_KEY, MAIN_KEY, 'awk', 'WEMESSAGE_HOST_PID'])
      expect([needed, check.includes(needed)]).toEqual([needed, true]);
    expect(check).not.toContain('grep');
    const run = steps[smoke] ?? '';
    for (const banned of [NODE_KEY, MAIN_KEY])
      expect([banned, run.includes(banned)]).toEqual([banned, false]);
    for (const needed of [
      'Fake.app/Contents/MacOS/WeMessage',
      'Contents/Resources/daemon',
      '--daemon',
    ])
      expect([needed, run.includes(needed)]).toEqual([needed, true]);
  });

  it('P0-3: bundle-daemon.mjs defines both WS_NO_* keys in its one esbuild call', () => {
    const text = archRead(BUNDLER);
    expect(text.split('await build({').length - 1).toBe(1);
    const call = /await build\(\{([\s\S]*?)\n {4}\}\);/.exec(text)?.[1] ?? '';
    expect(call).toContain('entryPoints');
    for (const key of ['WS_NO_BUFFER_UTIL', 'WS_NO_UTF_8_VALIDATE'])
      expect([key, call.includes(`'process.env.${key}': '"1"'`)]).toEqual([
        key,
        true,
      ]);
    expect(call).toMatch(/\bdefine:\s*\{/);
  });
});

describe("v2 S2f: Eric's first-install runbook for the Swift build", () => {
  /**
   * S2f has no production code. Its deliverable is a section of RELEASING.md
   * that Eric runs by hand once a signed build exists, and these rows pin
   * what that section must carry: the steps in order, the FDA experiment and
   * what each outcome means for the doctor copy, the double-click check the
   * S3 advisor review asked for (P2-11), the residual risks the S2 advisor
   * review asked to be written down before any FDA grant, the post-run
   * checklist, and an honest mark on everything that waits for custody (S5d).
   */
  const RELEASING = 'RELEASING.md';
  const MAC_README = 'apps/mac/README.md';
  const DOCTOR = 'packages/daemon/src/doctor.ts';
  const HEADING = '## First install on a Mac (the Swift build)';
  const SUBS = [
    '### Before you start',
    '### The steps',
    '### The FDA experiment',
    '### Double-click while the daemon runs',
    '### Residual risks to check before granting Full Disk Access',
    '### Post-run checklist',
    '### What S2 proves without this run',
  ] as const;

  /** The text from `heading` to the next heading of the same or higher level. */
  const sectionOf = (text: string, heading: string): string => {
    const at = text.indexOf(`${heading}\n`);
    if (at < 0) return '';
    const level = /^#+/.exec(heading)?.[0].length ?? 2;
    const rest = text.slice(at + heading.length + 1);
    const next = new RegExp(`^#{1,${String(level)}} `, 'm').exec(rest);
    return rest.slice(0, next === null ? rest.length : next.index);
  };
  const runbook = (): string => sectionOf(archRead(RELEASING), HEADING);
  const sub = (heading: string): string => sectionOf(runbook(), heading);
  /** Top-level numbered items (`N. ` at column 0), in document order. */
  const stepNumbers = (text: string): number[] =>
    [...text.matchAll(/^(\d+)\. \S/gm)].map((m) => Number(m[1]));

  it('RELEASING.md has the runbook section with its seven subsections, in order', () => {
    const text = archRead(RELEASING);
    expect(text.split(`${HEADING}\n`).length - 1).toBe(1);
    const body = runbook();
    const at = SUBS.map((h) => body.indexOf(`${h}\n`));
    expect(SUBS.map((h, i) => [h, at[i]! >= 0])).toEqual(
      SUBS.map((h) => [h, true]),
    );
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).toMatch(/nothing in this section is automated/i);
    // Non-vacuity: the section reader stops at the next same-level heading.
    expect(sectionOf('## A\nx\n### B\ny\n## C\nz\n', '## A')).toBe(
      'x\n### B\ny\n',
    );
  });

  it('the steps are numbered from 1 without gaps and name each manual act', () => {
    const steps = sub('### The steps');
    const n = stepNumbers(steps);
    expect(n.length).toBeGreaterThanOrEqual(10);
    expect(n).toEqual(n.map((_, i) => i + 1));
    for (const needed of [
      'SHA256SUMS',
      'DESIGNATED_REQUIREMENT.txt',
      'Open Anyway',
      'Full Disk Access',
      'wemessaged service install',
      'wemessaged service status --json',
      'wemessage doctor',
      'wemessage drafts create',
      'wemessage drafts approve',
      '+1555',
      'Automation',
      'restart the service',
    ])
      expect([needed, steps.includes(needed)]).toEqual([needed, true]);
    // The first send is approved by hand, never the one-call send verb.
    expect(steps).not.toMatch(/wemessage send\b/);
  });

  it('the runbook is honest that it waits for custody (S5d) once sign.sh exists (S5a)', () => {
    const body = runbook();
    // v2 S5a: sign.sh landed, so the wait is no longer for the script but
    // for the real identity. The runbook says so, and says the throwaway
    // run uploads nothing, so no reader goes looking for its zip.
    expect(existsSync(join(repoRoot, 'tools/swift/sign.sh'))).toBe(true);
    const before = sub('### Before you start');
    expect(before).toMatch(/Blocked on S5d/);
    expect(before).toMatch(/throwaway identity[\s\S]{0,200}uploads nothing/);
    expect(body).not.toContain('S2e');
    const tagged = sub('### The steps')
      .split('\n')
      .filter((l) => /^\d+\. /.test(l) && l.includes('[blocked on S5d]'));
    expect(tagged.length).toBeGreaterThanOrEqual(1);
    for (const needed of ['tools/swift/sign.sh', 'pack-swift', 'exit 2'])
      expect([needed, body.includes(needed)]).toEqual([needed, true]);
  });

  it('the FDA experiment names its observation, both outcomes and the doctor copy it decides', () => {
    const fda = sub('### The FDA experiment');
    for (const needed of [
      'Pass',
      'Fail',
      'FDA_EPERM',
      DOCTOR,
      'does not propagate to background items',
      'L1',
      'L2',
      'tccutil reset SystemPolicyAllFiles sh.wemessage.gateway',
    ])
      expect([needed, fda.includes(needed)]).toEqual([needed, true]);
    // The copy is revisited AFTER the result, not in S2f: the claim the
    // experiment tests is still the shipped string.
    expect(archRead(DOCTOR)).toContain(
      'FDA does not propagate to background items',
    );
  });

  it('the double-click row lives in the runbook, and apps/mac/README.md points at it (P2-11)', () => {
    const dbl = sub('### Double-click while the daemon runs');
    for (const needed of [
      'WeMessage --daemon',
      'double-click',
      'window',
      'LaunchServices',
    ])
      expect([needed, dbl.includes(needed)]).toEqual([needed, true]);
    const seams = sectionOf(archRead(MAC_README), '## Known seams');
    expect(seams).toContain('RELEASING.md');
    expect(seams).toContain('Double-click while the daemon runs');
    expect(seams).not.toContain('until the S2f runbook carries it');
  });

  it('the residual risks name the three escalation paths, PATH, and the two structural residues', () => {
    const risks = sub(
      '### Residual risks to check before granting Full Disk Access',
    );
    for (const needed of [
      'NODE_OPTIONS',
      'WEMESSAGE_HOST_NODE',
      'bufferutil',
      'PATH',
      '1f32743',
      'Contents/Resources/daemon/node',
      'sh.wemessage.test.',
      'EPERM',
      'WEMESSAGE_DIR',
      'openclaw',
    ])
      expect([needed, risks.includes(needed)]).toEqual([needed, true]);
  });

  it('the post-run checklist asks for what seeds the next slices', () => {
    const post = sub('### Post-run checklist');
    for (const needed of [
      'macOS',
      'L1',
      'L2',
      'service status --json',
      'doctor --json',
      'Automation',
      'double-click',
      'FDA_EPERM',
    ])
      expect([needed, post.includes(needed)]).toEqual([needed, true]);
  });

  it('RELEASING.md stays clean: no em dash, no killing verb, no bare table, no home path', () => {
    const text = archRead(RELEASING);
    const body = runbook();
    expect(body.length).toBeGreaterThan(0);
    expect(text.includes(String.fromCharCode(0x2014))).toBe(false);
    for (const banned of [`kick${'start'}`, `launchctl ${'kill'}`])
      expect([banned, text.includes(banned)]).toEqual([banned, false]);
    // The CLI owns launchd; the runbook neither escalates nor drives Messages.
    for (const banned of ['launchctl', 'sudo', 'osascript', 'chat.db'])
      expect([banned, body.includes(banned)]).toEqual([banned, false]);
    expect(/\/Users\//.test(text)).toBe(false);
    // Every table is fenced: no markdown pipe table anywhere in the file.
    expect(text.split('\n').filter((l) => /^\s*\|/.test(l))).toEqual([]);
  });
});

describe('v2 S6a: the Swift pack lane reads nothing under the Electron app', () => {
  /**
   * S6c deletes `apps/desktop`. Before it can, every input the Swift pack
   * lane reads has to live somewhere that survives: the bundler moved to
   * `tools/release/bin/bundle-daemon.mjs` with `esbuild` as a devDependency
   * of `@wemessage/release`, and the icon was copied to
   * `apps/mac/Resources/icon.icns`. These rows hold that line as text, so a
   * path that quietly reaches back into the Electron app goes red here
   * rather than the day the directory is gone.
   *
   * `bundle-daemon.mjs` itself still names the Electron app on purpose (its
   * Electron flavour writes there and measures the Electron installed
   * there), so it is held by its IMPORTS, not its text: no import may
   * resolve through the Electron app's tree.
   */
  const SWIFT_LANE_EXTRA = 'tools/release/bin/pack-swift.mjs';
  const BUNDLER = 'tools/release/bin/bundle-daemon.mjs';
  const RELEASE_PKG = 'tools/release/package.json';
  /** `apps/desktop`, `$repo/apps/desktop`, and `join(REPO, 'apps', 'desktop')`. */
  const DESKTOP_PATH = /apps['"]?\s*[,/]\s*['"]?desktop\b/;

  const swiftLaneFiles = (): string[] => [
    ...execFileSync('git', ['ls-files', '--', 'tools/swift'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.length > 0),
    SWIFT_LANE_EXTRA,
  ];

  /** Every module specifier: static `from`, side-effect `import`, dynamic `import()`. */
  const specifiers = (text: string): string[] =>
    [
      ...text.matchAll(/\bfrom\s*(['"])([^'"\n]+)\1/g),
      ...text.matchAll(/^\s*import\s*(['"])([^'"\n]+)\1/gm),
      ...text.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g),
    ].map((m) => m[2] ?? '');

  it('the path pattern is not vacuous: it catches each spelling and passes the new homes', () => {
    for (const hit of [
      'apps/desktop/build/icon.icns',
      'icon="$repo/apps/desktop/build/icon.icns"',
      "join(REPO, 'apps', 'desktop', 'dist-bundle-node')",
      "join(REPO, 'apps','desktop')",
    ])
      expect([hit, DESKTOP_PATH.test(hit)]).toEqual([hit, true]);
    for (const miss of [
      'apps/mac/Resources/icon.icns',
      "join(REPO, 'apps', 'mac', 'dist-bundle-node')",
      "join(REPO, 'tools', 'release', 'bin', 'bundle-daemon.mjs')",
    ])
      expect([miss, DESKTOP_PATH.test(miss)]).toEqual([miss, false]);
    expect(
      specifiers("import { a } from 'x';\nimport 'y';\nawait import('z');"),
    ).toEqual(['x', 'y', 'z']);
  });

  it('tools/swift and tools/release/bin/pack-swift.mjs contain no apps/desktop path', () => {
    const files = swiftLaneFiles();
    // The sweep reaches the two files the lane actually runs.
    expect(files).toContain('tools/swift/bundle.sh');
    expect(files).toContain(SWIFT_LANE_EXTRA);
    expect(files.length).toBeGreaterThanOrEqual(5);
    const offenders: string[] = [];
    for (const rel of files)
      archRead(rel)
        .split('\n')
        .forEach((line, i) => {
          if (DESKTOP_PATH.test(line))
            offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    expect(offenders).toEqual([]);
  });

  it("bundle-daemon.mjs imports nothing through the Electron app, and esbuild is its own package's devDependency", () => {
    const specs = specifiers(archRead(BUNDLER));
    expect(specs.length).toBeGreaterThan(0);
    expect(
      specs.filter((s) => DESKTOP_PATH.test(s) || /(^|\/)desktop\//.test(s)),
    ).toEqual([]);
    // Bare or node: only. A relative or absolute specifier is a path into
    // some other tree, and the only tree this file may load from is its own.
    expect(specs.filter((s) => s.startsWith('.') || s.startsWith('/'))).toEqual(
      [],
    );
    // And esbuild is loaded by its bare name, so it resolves from this
    // file's own package and nowhere else.
    expect(specs).toContain('esbuild');
    const pkg = JSON.parse(archRead(RELEASE_PKG)) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(typeof pkg.devDependencies?.esbuild).toBe('string');
    // A devDependency, not a runtime one: the release library itself loads
    // no esbuild, only this build-time script does.
    expect(pkg.dependencies?.esbuild).toBeUndefined();
  });
});

describe('v2 S5a: signing lives in release.yml and nowhere else in .github', () => {
  /**
   * S5a gives the release workflow a signing identity: a throwaway one it
   * mints, or (from S5d) the real one imported from two secrets. The words
   * that come with it must not leak into a CI workflow, where they would run
   * on every pull request: ci-swift and ci-macos already ban a longer list
   * (the Sc17 and S1 rows), and this row holds the signing words across
   * EVERY workflow git tracks, keyed off the directory rather than a list,
   * so a sixth workflow cannot be added without being swept.
   */
  const RELEASE = '.github/workflows/release.yml';
  const SIGNING_WORDS: readonly string[] = [
    'codesign',
    'keychain',
    'p12',
    'WEMESSAGE_SIGN',
    'security import',
    'add-trusted-cert',
  ];
  const workflows = (): string[] =>
    execFileSync('git', ['ls-files', '--', '.github/workflows'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => /\.ya?ml$/.test(f));

  it('release.yml carries every signing word (the row is not vacuous)', () => {
    const text = archRead(RELEASE);
    for (const w of SIGNING_WORDS)
      expect([w, text.includes(w)]).toEqual([w, true]);
  });

  it('no other workflow carries any of them', () => {
    const others = workflows().filter((f) => f !== RELEASE);
    // The four CI workflows at least; a fifth is swept the day it lands.
    for (const ci of [
      'ci-swift.yml',
      'ci-macos.yml',
      'ci-linux.yml',
      'ci-python.yml',
    ])
      expect(others).toContain(`.github/workflows/${ci}`);
    const offenders: string[] = [];
    for (const f of others) {
      const text = archRead(f);
      for (const w of SIGNING_WORDS)
        if (text.includes(w)) offenders.push(`${f}: ${w}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('v2 S5b: the disk image is built without Finder scripting', () => {
  /**
   * D-UI-181: the DMG window is plain, no artwork and no icon layout, so
   * hdiutil is the only tool it needs. Laying a window out takes Finder
   * scripting, and osascript is banned across the project. Held as text over
   * every tracked file under tools/swift and the stubs that stand in for its
   * tools, comments included: a line that names it is either a call or an
   * instruction to add one.
   */
  const BANNED = /osascript|applescript/i;
  const swiftToolFiles = (): string[] =>
    execFileSync('git', ['ls-files', '--', 'tools/swift', 'fixtures/swift'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((f) => f.length > 0);

  it('osascript absent from tools/swift', () => {
    const files = swiftToolFiles();
    // Non-vacuity: the sweep reaches the image builder and its stub.
    expect(files).toContain('tools/swift/dmg.sh');
    expect(files).toContain('fixtures/swift/mini-app/stubs/hdiutil');
    const offenders = files.filter((rel) => BANNED.test(archRead(rel)));
    expect(offenders).toEqual([]);
    // The image builder really is hdiutil-only: create and verify, plain.
    const dmg = archRead('tools/swift/dmg.sh');
    expect(dmg).toContain('hdiutil create -volname WeMessage');
    expect(dmg).toContain('ln -s /Applications');
    expect(
      /\.DS_Store|-fs HFS|background/i.test(dmg.replace(/^#.*$/gm, '')),
    ).toBe(false);
  });

  it('PLANTED: each spelling is caught', () => {
    for (const hit of [
      'osascript -e \'tell application "Finder"\'',
      '/usr/bin/osascript layout.scpt',
      '# set the window with AppleScript',
    ])
      expect([hit, BANNED.test(hit)]).toEqual([hit, true]);
    expect(BANNED.test('hdiutil create -volname WeMessage')).toBe(false);
  });
});

/* ── v2 S6b: the macOS floor is 26, everywhere a floor is named ──────── */

describe('v2 S6b: macOS floor files name 26', () => {
  /*
   * An explicit list of the files that state a floor to a reader, not a grep
   * of the tree for "15": "macOS 15" is correct in a dozen comments that
   * record history (the runner a GIF was captured on, the release that
   * removed right-click Open), and a sweep would convict all of them. Each
   * entry is the floor sentence the file must carry, and the older one it
   * must not. `Info.plist` and the cask are the machine-readable floor; the
   * rest are what a person reads before installing.
   *
   * Not here, by decision (D-S6b-3): `doctor.ts`'s MIN_SUPPORTED_MACOS (13).
   * That check guards the headless daemon and CLI, which run from source on
   * older systems; the app cannot launch below 26 whatever doctor says.
   * Its Darwin-to-macOS map is listed, for the 26 entry only.
   */
  const FLOOR: ReadonlyArray<readonly [string, string, RegExp]> = [
    [
      'README.md',
      'Requires macOS 26 (Tahoe) or later on Apple silicon.',
      /macOS 1\d \(/,
    ],
    [
      '.github/ISSUE_TEMPLATE/bug_report.yml',
      'placeholder: macOS 26',
      /placeholder: macOS 1\d/,
    ],
    [
      'site/docs/install.html',
      'A Mac running macOS 26 (Tahoe) or later',
      /running macOS 1\d/,
    ],
    [
      'tools/release/src/cask.ts',
      'depends_on macos: :tahoe',
      /:sequoia|:sonoma|:ventura/,
    ],
    [
      'apps/mac/Resources/Info.plist',
      '<string>26.0</string>',
      /<string>1\d\.\d<\/string>/,
    ],
    ['packages/daemon/src/doctor.ts', '25 ->\n * 26 Tahoe', /(?!)/],
  ];

  it('each floor file states 26 and no older floor', () => {
    for (const [file, floor, older] of FLOOR) {
      const text = archRead(file);
      expect([file, text.includes(floor)]).toEqual([file, true]);
      expect([file, older.test(text)]).toEqual([file, false]);
    }
  });

  it('PLANTED: the old README floor is caught', () => {
    const planted = archRead('README.md').replace(
      'Requires macOS 26 (Tahoe) or later',
      'Requires macOS 15 (Sequoia) or later',
    );
    expect(planted.includes(FLOOR[0]?.[1] ?? '')).toBe(false);
    expect(FLOOR[0]?.[2].test(planted)).toBe(true);
  });
});

describe('v2 F3: thread state rides a new table, never a changed one', () => {
  /*
   * C-3: the §2.3 tables are not altered. Until F3 the store had one
   * migration, so the rule was enforced by there being nothing to enforce it
   * on. 0002_thread_state.sql is the first file after it, and the rule now
   * has a reader: every migration after 0001 may only ADD (a table, an
   * index). An ALTER, a DROP or a rename of an existing table would change a
   * schema every store in the field already relies on, and the runner is
   * forward-only, so there is no taking it back.
   */
  const migrationsDir = join(repoRoot, 'packages/store/migrations');
  const later = (): string[] =>
    readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && f !== '0001_init.sql')
      .sort();
  const offences = (sql: string): string[] => {
    const code = sql.replace(/--[^\n]*/g, '');
    return [
      ...code.matchAll(/\b(ALTER\s+TABLE|DROP\s+TABLE|DROP\s+INDEX)\b/gi),
    ].map((m) => m[1] ?? '');
  };

  it('C-3: no migration after 0001 alters or drops anything', () => {
    // NOT VACUOUS: F3 ships 0002, so the list has something in it.
    expect(later()).toContain('0002_thread_state.sql');
    for (const f of later()) {
      const sql = readFileSync(join(migrationsDir, f), 'utf8');
      expect([f, offences(sql)]).toEqual([f, []]);
    }
  });

  it('PLANTED: an ALTER of drafts is caught', () => {
    expect(offences('ALTER TABLE drafts ADD COLUMN thread_act TEXT;')).toEqual([
      'ALTER TABLE',
    ]);
    // A comment that mentions the word is not an offence.
    expect(
      offences('-- never ALTER TABLE drafts\nCREATE TABLE t (a);'),
    ).toEqual([]);
  });

  it('0002 creates exactly one table, thread_state', () => {
    const sql = readFileSync(
      join(migrationsDir, '0002_thread_state.sql'),
      'utf8',
    ).replace(/--[^\n]*/g, '');
    expect(
      [...sql.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)].map((m) => m[1]),
    ).toEqual(['thread_state']);
  });

  it('v2 F2a: 0003 adds the search index and copies no message text', () => {
    // The migration runs inside open, on every store in the field: it may
    // add tables and indexes, and the only row it writes is the FTS
    // secure-delete switch. Text reaches the index through the time-boxed
    // backfill, never through a migration that could hold open for minutes.
    const sql = readFileSync(
      join(migrationsDir, '0003_search.sql'),
      'utf8',
    ).replace(/--[^\n]*/g, '');
    expect(
      [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(\w+)/gi)].map(
        (m) => m[1],
      ),
    ).toEqual(['message_fts', 'search_doc']);
    expect(
      [...sql.matchAll(/CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)/gi)].map(
        (m) => `${m[1] ?? ''} ON ${m[2] ?? ''}`,
      ),
    ).toEqual([
      'inbound_sent ON inbound_messages',
      'inbound_chat_sent ON inbound_messages',
      'inbound_rowid_src ON inbound_messages',
    ]);
    expect(
      [...sql.matchAll(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/gi)].map((m) => [
        m[1],
        m[2],
      ]),
    ).toEqual([['message_fts', 'message_fts, rank']]);
    expect(sql).not.toMatch(/\bSELECT\b/i);
  });
});

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
import { execFileSync } from 'node:child_process';
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
import { join, resolve } from 'node:path';
// s7 Sc9: the verification ledger reads BUILT modules, so it needs a file URL.
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// s8 Sc1 row 11: "which lint rules apply to this file" is a question only
// ESLint can answer without a second implementation of flat-config
// resolution — and answering it with a glob library would need a dependency
// the plan does not ratify.
import { ESLint } from 'eslint';
import {
  PORT_IMPORTER_ALLOWLIST,
  // s7 Sc12: a public document may only name a route that exists. The
  // ratchet snapshot is already the arbiter of the route surface, so the
  // documentation sweep asks it rather than growing a second list.
  ROUTE_TABLE,
} from '../packages/daemon/test/transport-surface.snapshot.js';
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
  const notText = /\.(bin|blob|db|png|ico|svg|jpg|jpeg|gif|pdf|zip|woff2?)$/;
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

function cruise(paths: string[]): CruiseSummary {
  // --output-type json always exits per violations; capture stdout regardless.
  let stdout: string;
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
  return JSON.parse(stdout) as CruiseSummary;
}

describe('arch invariants (dependency-cruiser)', () => {
  it('reports zero violations on the scaffold (INV-1 + §3.1 arrows)', () => {
    const result = cruise(['packages', 'apps', 'fixtures']);
    expect(result.summary.violations).toEqual([]);
    expect(result.summary.error).toBe(0);
  });

  describe('proven teeth', () => {
    const probe = join(repoRoot, 'packages/core/src/__arch_teeth_probe__.ts');

    afterEach(() => {
      rmSync(probe, { force: true });
    });

    it('flags a planted core -> store import (core-no-internal-deps)', () => {
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
    });

    it('flags a planted core -> node:fs I/O builtin import (core-no-node-io-builtins)', () => {
      writeFileSync(probe, "import 'node:fs';\nexport {};\n");
      const result = cruise(['packages/core']);
      const names = result.summary.violations.map((v) => v.rule.name);
      expect(names).toContain('core-no-node-io-builtins');
    });
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
    it('cruises the core rules/audit sources under the INV-1 rules (a)', () => {
      const result = cruise(['packages', 'apps', 'fixtures']);
      const sources = result.modules.map((m) => m.source);
      expect(sources).toContain('packages/core/src/rules/index.ts');
      expect(sources).toContain('packages/core/src/audit/index.ts');
      expect(result.summary.violations).toEqual([]);
    });

    describe('proven teeth: closed dependency list (b)', () => {
      const probe = join(
        repoRoot,
        'packages/core/src/__arch_s2_teeth_probe__.ts',
      );

      afterEach(() => {
        rmSync(probe, { force: true });
      });

      it('flags a planted core -> re2 import (core-no-unresolvable-imports)', () => {
        writeFileSync(probe, "import 're2';\nexport {};\n");
        const result = cruise(['packages/core']);
        const names = result.summary.violations.map((v) => v.rule.name);
        expect(names).toContain('core-no-unresolvable-imports');
        expect(result.summary.error).toBeGreaterThan(0);
      });

      it('flags a planted core -> ulid import (core-no-unresolvable-imports)', () => {
        writeFileSync(probe, "import 'ulid';\nexport {};\n");
        const result = cruise(['packages/core']);
        const names = result.summary.violations.map((v) => v.rule.name);
        expect(names).toContain('core-no-unresolvable-imports');
        expect(result.summary.error).toBeGreaterThan(0);
      });
    });

    describe('node:crypto is legal in core (c)', () => {
      const probe = join(
        repoRoot,
        'packages/core/src/audit/__arch_crypto_probe__.ts',
      );

      afterEach(() => {
        rmSync(probe, { force: true });
      });

      it('does not flag a core/audit -> node:crypto import', () => {
        writeFileSync(
          probe,
          "import { createHash } from 'node:crypto';\n" +
            'export const sha256hex = (s: string): string =>\n' +
            "  createHash('sha256').update(s, 'utf8').digest('hex');\n",
        );
        const result = cruise(['packages/core']);
        expect(result.summary.violations).toEqual([]);
        expect(result.summary.error).toBe(0);
      });
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

      it('sendkit -> node:child_process cruises clean', () => {
        writeFileSync(
          sendkitProbe,
          "import 'node:child_process';\nexport {};\n",
        );
        const result = cruise(['packages/sendkit']);
        expect(result.summary.violations).toEqual([]);
        expect(result.summary.error).toBe(0);
      });

      it('the identical import from core is flagged (core-no-node-io-builtins)', () => {
        writeFileSync(coreProbe, "import 'node:child_process';\nexport {};\n");
        const result = cruise(['packages/core']);
        const names = result.summary.violations.map((v) => v.rule.name);
        expect(names).toContain('core-no-node-io-builtins');
        expect(result.summary.error).toBeGreaterThan(0);
      });
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

    it('(b) adapters are thin clients: protocol + client only', () => {
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
    });

    it('(c) protocol keeps zero runtime deps and type-only core reach', () => {
      const result = cruise(['packages', 'apps', 'fixtures']);
      const names = result.summary.violations.map((v) => v.rule.name);
      expect(names).not.toContain('protocol-zero-runtime-deps');
      expect(names).not.toContain('protocol-core-type-only');
    });

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
      expect(topLevelTrackedDirs()).toEqual([
        '.github',
        'apps',
        'fixtures',
        'packages',
        'site',
        'skills',
        'test',
      ]);
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

  it('does not flag violations planted outside the cruised tree (sandbox sanity)', () => {
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
  });
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
    const offenders: string[] = [];
    for (const rel of shippedDocs())
      for (const f of lintTranscript(read(rel), policy)) {
        if (f.rule === 'non-synthetic-contact' && OURS.has(f.detail)) continue;
        offenders.push(`${rel}:${f.line}: ${f.rule} ${f.detail}`);
      }
    expect(offenders).toEqual([]);
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
    });
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

    it('client.send( appears in at most one file, and that file owns sendTest', () => {
      const callers = desktopSrcFiles()
        .filter((rel) => /\.(ts|tsx)$/.test(rel))
        .filter((rel) => /\bclient\.send\(/.test(s8Read(rel)));
      // Sc 1 ships constants only, so the honest assertion today is a subset
      // one: whoever adds the call has to add it in `gateway.ts`, in the
      // handler registered for `CHANNELS.sendTest`, and Sc 4 tightens this
      // to an equality once the file exists.
      expect(
        callers.filter((f) => f !== 'apps/desktop/src/main/gateway.ts'),
      ).toEqual([]);
      for (const rel of callers)
        expect(s8Read(rel)).toContain('CHANNELS.sendTest');
    });

    it('PLANTED: a send call outside gateway.ts is caught', () => {
      const rel = plant(
        'apps/desktop/src/__s8_probe__/quick-send.ts',
        [
          'export async function shortcut(client: { send: (a: unknown) => Promise<void> }) {',
          "  await client.send({ to: '+15550000000', body: 'hi' });",
          '}',
          '',
        ].join('\n'),
      );
      const callers = desktopSrcFiles()
        .filter((f) => /\.(ts|tsx)$/.test(f))
        .filter((f) => /\bclient\.send\(/.test(s8Read(f)));
      expect(callers).toContain(rel);
      expect(
        callers.filter((f) => f !== 'apps/desktop/src/main/gateway.ts'),
      ).not.toEqual([]);
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

    it('SCREENS and WIZARD_STEPS are byte-for-byte the §1.7 arrays', () => {
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
      expect(Object.keys(pkg().devDependencies ?? {}).sort()).toEqual([
        '@preact/preset-vite',
        'axe-core',
        'electron',
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
      const p = pkg();
      const names = [
        ...Object.keys(p.dependencies ?? {}),
        ...Object.keys(p.devDependencies ?? {}),
      ];
      expect(names.length).toBe(10);
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
    /** The two reference rasters Sc 17 will commit, and nothing else. */
    const SNAPSHOT_PNGS: readonly string[] = [
      'apps/desktop/test/__snapshots__/rt-dark.png',
      'apps/desktop/test/__snapshots__/rt-light.png',
    ];

    it('no brand string, no operator handle, no absolute home path', () => {
      expect(publicRepoOffenders()).toEqual([]);
    });

    it('every tracked PNG is a reduced-transparency reference snapshot', () => {
      // Subset until Sc 17 commits them; equality from Sc 17. Written this
      // way on purpose: the row is real NOW (a stray screenshot fails it)
      // rather than being a comment promising a future assertion.
      const pngs = tracked('*.png');
      expect(pngs.filter((p) => !SNAPSHOT_PNGS.includes(p))).toEqual([]);
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
      expect(pngs.filter((p) => !SNAPSHOT_PNGS.includes(p))).toEqual([rel]);
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
        tracked('*.png').filter((p) => !SNAPSHOT_PNGS.includes(p)),
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
     */
    const ALLOWED = [
      'approve',
      'bulk',
      'contacts',
      'drafts',
      'on',
      'recall',
      'reject',
      'rules',
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

    it('the store reaches exactly seven request channels and one subscription', () => {
      const files = archFiles(STORE_ROOT);
      expect(files).toContain(WIRING);
      expect(bridgeReach(files)).toEqual(ALLOWED);
      // The runtime list and the type-level `Pick` are the same names, so
      // widening one without the other is a diff somebody has to write on
      // purpose.
      const declared = /STORE_CHANNELS = \[([^\]]*)\]/.exec(archRead(WIRING));
      expect(declared).not.toBeNull();
      expect(
        [...(declared?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]),
      ).toEqual([
        'approve',
        'bulk',
        'contacts',
        'drafts',
        'recall',
        'reject',
        'rules',
      ]);
      // Written across lines in the source, so the type is matched by its
      // members rather than by one spelling of the union's whitespace.
      const pick = /Pick<\s*WmBridge,([\s\S]*?)>/.exec(archRead(WIRING));
      expect(pick).not.toBeNull();
      expect(
        [...(pick?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort(),
      ).toEqual(ALLOWED);
    });

    it('nothing in the store names a send, though the channel exists', () => {
      // Non-vacuous twice over: there IS a send-capable channel on the
      // bridge, and the store's prose talks about it constantly. The ban is
      // on the code.
      expect(archRead('apps/desktop/src/main/ipc-channels.ts')).toContain(
        "sendTest: 'wm:wizard.send-test'",
      );
      expect(/send/i.test(archRead(WIRING))).toBe(true);
      expect(sendOffenders(archFiles(STORE_ROOT))).toEqual([]);
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
      expect(bridgeReach(files)).toEqual(ALLOWED);
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
      // the thing the comments are warning about — but in NO renderer code.
      for (const rel of archFiles(RENDERER))
        expect([
          rel,
          codeOf(archRead(rel)).includes('undoGraceSeconds'),
        ]).toEqual([rel, false]);
    });
  });
});

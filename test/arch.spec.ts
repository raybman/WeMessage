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
import { afterEach, describe, expect, it } from 'vitest';
import { PORT_IMPORTER_ALLOWLIST } from '../packages/daemon/test/transport-surface.snapshot.js';

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
 * Brand strings and non-fictional phone numbers in anything git tracks.
 *
 * Hoisted to module scope by s7 Sc7 so that the row asserting it is clean
 * (S3 (d)) and the teeth proving it BITES on the file types Sc7 introduces
 * can be the same code. A sweep and its teeth that share no implementation
 * are two guards, and only one of them is the one that runs on CI.
 */
function publicRepoOffenders(): string[] {
  const bannedBrand = /flowstay|flowverse|flowindustries|vivaepic/i;
  const phoneRe = /\+1\d{10}/g;
  const offenders: string[] = [];
  for (const f of trackedTextFiles()) {
    const content = readFileSync(join(repoRoot, f), 'utf8');
    if (bannedBrand.test(content)) offenders.push(`${f}: brand string`);
    for (const n of content.match(phoneRe) ?? [])
      if (!n.startsWith('+1555')) offenders.push(`${f}: ${n}`);
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
      const roots = ['packages', 'skills', 'test', 'fixtures', 'apps'];
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
        'packages/adapters/hermes/README.md: conformance-only',
        'packages/adapters/luna/README.md: conformance-only',
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
      expect(await declaredTiers()).toEqual(['luna: conformance-only']);
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

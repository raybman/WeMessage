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
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const depcruiseBin = join(repoRoot, 'node_modules', '.bin', 'depcruise');

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
      const bannedBrand = /flowstay|flowverse|flowindustries|vivaepic/i;
      const phoneRe = /\+1\d{10}/g;
      const tracked = execFileSync('git', ['ls-files'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter((f) => f.length > 0)
        .filter((f) => codeIsh.test(f) || f.endsWith('.json'))
        .filter((f) => !binaryIsh.test(f))
        // this file IS the denylist source (has to spell the banned words
        // out to grep for them) — self-referential, not a real fixture.
        .filter((f) => f !== 'test/arch.spec.ts');

      const offenders: string[] = [];
      for (const f of tracked) {
        const content = readFileSync(join(repoRoot, f), 'utf8');
        if (bannedBrand.test(content)) offenders.push(`${f}: brand string`);
        for (const n of content.match(phoneRe) ?? []) {
          if (!n.startsWith('+1555')) offenders.push(`${f}: ${n}`);
        }
      }
      expect(offenders).toEqual([]);
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

    // (a) importer allowlist: exactly these 14 files mention SendBackend or
    // ChatDbReader in production source — the 13-file S3 baseline (841cd27)
    // plus the one deliberate s5 Scenario 6 addition (F-46) below.
    const SEND_BACKEND_CHAT_DB_READER_BASELINE = [
      'packages/core/src/drafts/recovery.ts',
      'packages/core/src/ports/index.ts',
      'packages/core/src/sending/dispatcher.ts',
      // s5 Scenario 6 (F-46), the ONE deliberate growth of this list in S5:
      // `adapters/dispatch.ts` reads conversation context through
      // `ChatDbReader.readChatTurns`. Reviewed here, in the same commit as
      // the file that joins it, exactly as this guard intends.
      'packages/daemon/src/adapters/dispatch.ts',
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
    // Actor union's own type declaration, which merely names the literal.
    const ACTOR_TYPE_DECL_FILE = 'packages/core/src/domain/types.ts';

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
        .filter((f) => f !== ACTOR_TYPE_DECL_FILE)
        .filter((f) =>
          /reason:\s*'auto-respond'/.test(
            readFileSync(join(repoRoot, f), 'utf8'),
          ),
        );
    }

    it('(a) SendBackend/ChatDbReader importers match the 14-file S3+S5 baseline exactly', () => {
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

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
import { afterEach, describe, expect, it } from 'vitest';
import { PORT_IMPORTER_ALLOWLIST } from '../packages/daemon/test/transport-surface.snapshot.js';

const repoRoot = resolve(import.meta.dirname, '..');
const depcruiseBin = join(repoRoot, 'node_modules', '.bin', 'depcruise');

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

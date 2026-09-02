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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '..');
const depcruiseBin = join(repoRoot, 'node_modules', '.bin', 'depcruise');

interface CruiseSummary {
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

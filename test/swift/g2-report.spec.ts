/**
 * v2 S7a: tools/swift/g2-report.sh, run for real over the fixture logs in
 * fixtures/swift/g2 (.txt, because the repo ignores *.log).
 *
 * What these rows pin: every well-formed `G2|` line that starts a line
 * becomes one table row in log order; a hard row over its limit, or never
 * measured, is red (exit 1) and the report is still written; a soft row is
 * reported and never red; a log with no G2 line is 3 and a malformed line is
 * 4, with no report. The last row ties the parser to the writer: the lines
 * the Kit's G2PerfTests pins for G2Limits.line are read back by the script,
 * so the Swift side and the shell side cannot drift apart on the format.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const REPORT = join(repoRoot, 'tools/swift/g2-report.sh');
const LOGS = join(repoRoot, 'fixtures/swift/g2');
const KIT_TEST = join(
  repoRoot,
  'apps/mac/Tests/WeMessageKitTests/G2PerfTests.swift',
);

const SLOW = { timeout: 30_000 };

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[]): Run {
  const r = spawnSync('bash', [REPORT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const log = (name: string): string => join(LOGS, name);

/** The table rows of a report, as [metric, value, unit, limit, kind, verdict]. */
function rows(report: string): string[][] {
  return report
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| metric '))
    .map((l) =>
      l
        .slice(2, -2)
        .split(' | ')
        .map((c) => c.trim()),
    );
}

describe('g2-report.sh (v2 S7a)', () => {
  it(
    'a green log: every line in order, hard rows ok, soft rows reported, exit 0',
    SLOW,
    () => {
      const r = run(['--title', 'ui (a)', log('green.txt')]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout.startsWith('# G2 report: ui (a)\n')).toBe(true);
      expect(rows(r.stdout)).toEqual([
        ['launch', '1840.12', 'ms', '-', 'soft', 'reported'],
        ['first-paint', '212.00', 'ms', '300', 'hard', 'ok'],
        ['mounted-rows', '38.00', 'rows', '120', 'hard', 'ok'],
        ['rss', '88.25', 'MB', '-', 'soft', 'reported'],
        ['event-to-ui', '-', 'ms', '-', 'soft', 'reported'],
      ]);
      expect(r.stdout).toContain('5 rows, 2 hard, 0 red.');
    },
  );

  it(
    'a line that only mentions G2| (a compiler echoing source) is not a measure',
    SLOW,
    () => {
      const text = readFileSync(log('green.txt'), 'utf8');
      // Non-vacuity: the fixture does carry such a line.
      expect(text).toContain('  print("G2|rss|-|MB|-|soft")');
      const r = run(['--title', 't', log('green.txt')]);
      expect(rows(r.stdout).filter((row) => row[0] === 'rss')).toHaveLength(1);
    },
  );

  it(
    'a hard row over its limit is red, and the report is still written',
    SLOW,
    () => {
      const r = run(['--title', 't', log('over.txt')]);
      expect(r.status).toBe(1);
      expect(rows(r.stdout)).toEqual([
        ['first-paint', '212.00', 'ms', '300', 'hard', 'ok'],
        ['mounted-rows', '2000.00', 'rows', '120', 'hard', 'OVER'],
        ['rss', '88.25', 'MB', '-', 'soft', 'reported'],
      ]);
      expect(r.stdout).toContain('3 rows, 2 hard, 1 red.');
    },
  );

  it('a hard row nobody measured is red', SLOW, () => {
    const r = run(['--title', 't', log('unmeasured.txt')]);
    expect(r.status).toBe(1);
    expect(rows(r.stdout)).toEqual([
      ['first-paint', '-', 'ms', '300', 'hard', 'UNMEASURED'],
    ]);
  });

  it(
    'a value exactly at its limit is ok; a carriage return is not part of the line',
    SLOW,
    () => {
      const work = mkdtempSync(join(tmpdir(), 'wm-g2-'));
      try {
        const at = join(work, 'at.txt');
        writeFileSync(at, 'G2|first-paint|300.00|ms|300|hard\n');
        expect(run(['--title', 't', at]).status).toBe(0);
        // Non-vacuity: the fixture really ends its line with CR LF.
        expect(readFileSync(log('crlf.txt'), 'utf8')).toContain('\r\n');
        const r = run(['--title', 't', log('crlf.txt')]);
        expect(r.status).toBe(0);
        expect(rows(r.stdout)).toEqual([
          ['reduce-p95', '0.04', 'ms', '50', 'hard', 'ok'],
        ]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );

  it('several logs make one report, in argument order', SLOW, () => {
    const r = run(['--title', 't', log('crlf.txt'), log('over.txt')]);
    expect(r.status).toBe(1);
    expect(rows(r.stdout).map((row) => row[0])).toEqual([
      'reduce-p95',
      'first-paint',
      'mounted-rows',
      'rss',
    ]);
  });

  it(
    'no G2 line is 3, a malformed line is 4, and neither writes a report',
    SLOW,
    () => {
      const none = run(['--title', 't', log('none.txt')]);
      expect(none.status).toBe(3);
      expect(none.stdout).toBe('');
      const bad = run(['--title', 't', log('malformed.txt')]);
      expect(bad.status).toBe(4);
      expect(bad.stdout).toBe('');
      expect(bad.stderr).toContain('G2|first paint|fast|ms|300|hard');
    },
  );

  it('usage and unreadable logs are 2', SLOW, () => {
    expect(run([log('green.txt')]).status).toBe(2);
    expect(run(['--title', 't']).status).toBe(2);
    expect(run(['--title']).status).toBe(2);
    expect(run(['--title', 't', log('no-such.txt')]).status).toBe(2);
  });

  it(
    'reads back exactly the lines the Kit pins for G2Limits.line',
    SLOW,
    () => {
      const swift = readFileSync(KIT_TEST, 'utf8');
      const pinned = [...swift.matchAll(/== "(G2\|[^"]+)"/g)].map((m) => m[1]!);
      // Non-vacuity: one hard and one soft sample.
      expect(pinned).toEqual([
        'G2|first-paint|212.00|ms|300|hard',
        'G2|rss|88.25|MB|-|soft',
      ]);
      const work = mkdtempSync(join(tmpdir(), 'wm-g2-'));
      try {
        const file = join(work, 'kit.txt');
        writeFileSync(file, pinned.join('\n') + '\n');
        const r = run(['--title', 'kit', file]);
        expect(r.status).toBe(0);
        expect(rows(r.stdout)).toEqual([
          ['first-paint', '212.00', 'ms', '300', 'hard', 'ok'],
          ['rss', '88.25', 'MB', '-', 'soft', 'reported'],
        ]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  );
});

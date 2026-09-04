/**
 * s5-execution Scenario 13 — TAP + JSON + the `CONFORMANT v1` badge line.
 *
 * Three renderings of one report object, and the object is the source of
 * truth: a badge that could disagree with the JSON would be a badge worth
 * nothing. `CONFORMANT` is printed only when every non-skipped check passed —
 * there is no partial credit, because the daemon offers none.
 *
 * No color, ever. The no-green sweep (C-9) is a repo-wide rule and a kit that
 * printed a green tick would be the first thing to break it.
 */
import type { CheckResult } from './checks.js';

/** The conformance level this kit certifies. Bumped with the wire, not the kit. */
export const CONFORMANCE_VERSION = 1;

export interface ConformanceReport {
  adapter: string;
  version: number;
  conformant: boolean;
  features: string[];
  checks: CheckResult[];
}

export function badgeLine(report: ConformanceReport): string {
  const v = `v${String(report.version)}`;
  if (report.conformant) return `CONFORMANT ${v} - ${report.adapter}`;
  const failed = report.checks.filter((c) => !c.ok).length;
  return `NOT CONFORMANT ${v} - ${report.adapter} (${String(failed)}/${String(report.checks.length)} failed)`;
}

export function formatTap(report: ConformanceReport): string {
  const lines: string[] = [
    'TAP version 13',
    `1..${String(report.checks.length)}`,
  ];
  for (const check of report.checks) {
    const status = check.ok ? 'ok' : 'not ok';
    const skip = check.skipped === true ? ' # SKIP' : '';
    lines.push(`${status} ${String(check.id)} - ${check.name}${skip}`);
    if (check.detail !== undefined) lines.push(`  # ${check.detail}`);
  }
  lines.push(`# ${badgeLine(report)}`);
  return lines.join('\n');
}

export function formatJson(report: ConformanceReport): string {
  return JSON.stringify(report, null, 2);
}

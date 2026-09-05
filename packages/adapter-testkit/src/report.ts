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

/**
 * The four ceilings the kit imposes on a child it did not write (s7 §1.7).
 *
 * A conformant adapter never approaches any of them; they exist because the
 * kit runs a stranger's process and a stranger's process is entitled to be
 * broken. Each one is tripped by a row in `test/spawn.spec.ts`, because a
 * budget nobody trips is a comment with a type annotation.
 */
export interface SpawnBudgets {
  /** Wall clock for any single check, and the ceiling on any single wait. */
  checkMs: number;
  /** How much child stdout/stderr the kit will relay before truncating. */
  transcriptBytes: number;
  /** How many frames one child may put on the wire in one session. */
  maxFrames: number;
  /** How large one frame may be before it is dropped rather than forwarded. */
  maxFrameBytes: number;
}

/**
 * What the kit observed about the process it ran. Absent on the in-process
 * path, where there is no process to observe.
 *
 * `argv` is deliberately unredacted: it is the argv the kit actually spawned,
 * so the row asserting the token is not in it can see a regression instead of
 * a mask. `transcript` is deliberately redacted, because the kit cannot stop
 * a stranger's process from printing its own token but it can refuse to relay
 * it into an operator's terminal. `tokenFingerprint` is a truncated SHA-256
 * of the run's synthetic token: enough to prove two runs got different
 * credentials, useless as a credential.
 */
export interface SpawnDiagnostics {
  transport: 'ws';
  /** Argv as spawned: `[cmd, ...args]`. Never carries the token. */
  argv: string[];
  /** Total children started across the whole run. One per check, at least. */
  children: number;
  /** Children still alive after the run reaped. Zero, or the kit leaked. */
  orphans: number;
  /** Exit of the last child to leave, `{null, null}` if none ever did. */
  lastExit: { code: number | null; signal: string | null };
  /** Redacted, budget-capped child output. */
  transcript: string;
  /** C-6 labels for frames the kit refused. Never `gate.denied`. */
  protocolViolations: string[];
  /** Which budgets were hit, by name. Empty for a well-behaved child. */
  budgetTrips: string[];
  /** The budgets in force, after any caller override. */
  budgets: SpawnBudgets;
  /** Truncated SHA-256 of the synthetic token. Not the token. */
  tokenFingerprint: string;
}

export interface ConformanceReport {
  adapter: string;
  version: number;
  conformant: boolean;
  features: string[];
  checks: CheckResult[];
  /**
   * How the subject was reached. Optional on purpose: S5 wrote reports with
   * neither key and S5's consumers must keep reading S7's reports, so these
   * are additions to a shape rather than a new shape (s7 Sc6 row 7).
   */
  transport?: 'spawn' | 'in-process';
  spawn?: SpawnDiagnostics;
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

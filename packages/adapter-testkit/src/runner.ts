/**
 * s5-execution Scenario 13 / s7-execution Scenario 6 — the suite driver.
 *
 * Split out of `index.ts` in s7 Sc6 so that `spawn.ts` can depend on it
 * without a cycle through the barrel. The behaviour it adds is the per-check
 * wall clock: a check that outruns its budget becomes a FAILED check with
 * reason `timeout`, never a hung process. The kit runs code it did not write,
 * and "the kit never came back" is the one report an adapter author cannot
 * act on.
 */
import {
  CHECKS,
  CHECK_NAMES,
  DEFAULT_CHECK_ENV,
  probeFeatures,
  type CheckEnv,
  type CheckResult,
} from './checks.js';
import { CONFORMANCE_VERSION, type ConformanceReport } from './report.js';
import type { AdapterUnderTest } from './types.js';

export interface ConformanceOptions {
  /** Overrides the in-process defaults. The spawn transport supplies its own. */
  env?: CheckEnv;
  /** Recorded in the report so a reader knows what was actually exercised. */
  transport?: 'spawn' | 'in-process';
  /** Wall clock per check. Unset means no ceiling beyond the checks' own. */
  budgetMs?: number;
}

/**
 * Race a check against its budget. The loser is a result, not an exception:
 * the whole point of the kit is that an adapter author gets six answers.
 */
async function bounded(
  index: number,
  work: Promise<CheckResult>,
  budgetMs: number | undefined,
): Promise<CheckResult> {
  if (budgetMs === undefined) return await work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        id: index + 1,
        name: CHECK_NAMES[index] ?? `check ${String(index + 1)}`,
        ok: false,
        detail: `timeout: the check did not finish within ${String(budgetMs)}ms`,
      });
    }, budgetMs);
    timer.unref();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Run the whole suite. Checks run in order and none of them throws: the
 * report is the output, and stopping at the first failure would tell an
 * adapter author one thing when they need six.
 */
export async function runConformance(
  subject: AdapterUnderTest,
  opts: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const env = opts.env ?? DEFAULT_CHECK_ENV;
  const checks: CheckResult[] = [];
  for (const [index, check] of CHECKS.entries())
    checks.push(await bounded(index, check(subject, env), opts.budgetMs));

  const features = await Promise.race([
    probeFeatures(subject, env),
    new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        resolve([]);
      }, opts.budgetMs ?? env.waitMs);
      timer.unref();
    }),
  ]);

  return {
    adapter: subject.name,
    version: CONFORMANCE_VERSION,
    conformant: checks.every((c) => c.ok),
    features,
    checks,
    transport: opts.transport ?? 'in-process',
  };
}

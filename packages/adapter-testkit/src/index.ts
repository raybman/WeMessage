/**
 * `@wemessage/adapter-testkit` — the adapter conformance kit (plan §3.7,
 * s5-execution Scenario 13).
 *
 * Six golden checks an adapter must pass before it is allowed anywhere near a
 * human's messages. The kit runs entirely in-process against a mock gateway:
 * no port, no spawn, no wall clock, and above all no send path — the kit
 * cannot send an iMessage because nothing in this package can, which is the
 * same reason an adapter cannot (INV-2).
 *
 * **Workspace-internal in S5 (F-52).** The public `npx` packaging, the
 * `--transport ws --cmd "..."` subprocess runner and the `wemessage adapters
 * test` wiring that would drive it are S7. This slice ships the kit and
 * dogfoods it on the two first-party adapters, echo and sol, which is what
 * makes the kit a claim about our own code before it is a demand on anyone
 * else's.
 */
export {
  createMockGateway,
  AGENT_TO_GATEWAY_TYPES,
  type MockGateway,
  type MockGatewayOptions,
  type RequestFixture,
  type WireMode,
} from './mock-gateway.js';
export {
  CHECKS,
  INJECTION_PROBE,
  probeFeatures,
  type CheckResult,
} from './checks.js';
export {
  badgeLine,
  formatJson,
  formatTap,
  CONFORMANCE_VERSION,
  type ConformanceReport,
} from './report.js';
export type {
  AdapterHandle,
  AdapterStartContext,
  AdapterUnderTest,
  TestkitSocket,
  TestkitSocketFactory,
  TestkitSocketHandlers,
} from './types.js';

import { CHECKS, probeFeatures } from './checks.js';
import { CONFORMANCE_VERSION, type ConformanceReport } from './report.js';
import type { AdapterUnderTest } from './types.js';

/**
 * Run the whole suite. Checks run in order and none of them throws: the
 * report is the output, and stopping at the first failure would tell an
 * adapter author one thing when they need six.
 */
export async function runConformance(
  subject: AdapterUnderTest,
): Promise<ConformanceReport> {
  const checks = [];
  for (const check of CHECKS) checks.push(await check(subject));

  return {
    adapter: subject.name,
    version: CONFORMANCE_VERSION,
    conformant: checks.every((c) => c.ok),
    features: await probeFeatures(subject),
    checks,
  };
}

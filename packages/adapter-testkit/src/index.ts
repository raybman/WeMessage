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
 * **s7 Sc6 added a second transport.** `runConformanceSpawned` runs the same
 * six checks against a CHILD PROCESS over a real `ws` listener, which is how
 * the Python plugin, the Hermes adapter, Luna and the OpenClaw shim are all
 * verified without any of them being importable JavaScript. The checks are
 * shared verbatim between the two paths on purpose: a spawned `CONFORMANT`
 * badge has to mean exactly what an in-process one means.
 *
 * Still no send path. The kit cannot send an iMessage because nothing in this
 * package can, and a spawned adapter that reaches for one is refused with the
 * daemon's own label (`adapter.no-send-frame`, C-6) rather than accepted.
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
  CHECK_NAMES,
  DEFAULT_CHECK_ENV,
  INJECTION_PROBE,
  probeFeatures,
  type CheckEnv,
  type CheckResult,
} from './checks.js';
export {
  badgeLine,
  formatJson,
  formatTap,
  CONFORMANCE_VERSION,
  type ConformanceReport,
  type SpawnBudgets,
  type SpawnDiagnostics,
} from './report.js';
export { runConformance, type ConformanceOptions } from './runner.js';
export {
  DEFAULT_SPAWN_BUDGETS,
  SPAWN_ENV_KEYS,
  TOKEN_REDACTION,
  buildChildEnv,
  classifyRefusal,
  killAllChildren,
  liveChildren,
  mintAdapterToken,
  parseCommand,
  redactTokens,
  runConformanceSpawned,
  type ChildEnvOptions,
  type SpawnedRunOptions,
} from './spawn.js';
export type {
  AdapterHandle,
  AdapterStartContext,
  AdapterUnderTest,
  TestkitSocket,
  TestkitSocketFactory,
  TestkitSocketHandlers,
} from './types.js';

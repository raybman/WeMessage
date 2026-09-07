/**
 * THE TEST-SIDE LANE (s9 Sc3, G3).
 *
 * This is the only file under `packages/daemon/test` that is permitted to
 * name the service manager, and `test/arch.spec.ts` pins that as an equality
 * over the test tree — the set is exactly this helper and
 * `test/launchctl.spec.ts`, and nothing else may grow into it.
 *
 * WHY A HELPER AND NOT A CONVENTION. Stage 2 of this scenario will run the
 * real macOS service manager from a test, on a machine that supervises the
 * operator's own agents through the same mechanism. `bootout` takes a label,
 * has no confirmation, no dry run and no undo, and the label that stops our
 * agent differs from the label that stops theirs by a few characters. A
 * review convention ("only ever use test labels") holds until somebody is
 * tired at the end of a long scenario. A function that throws holds always.
 *
 * FOUR REFUSALS, and every one of them runs BEFORE the delegate is looked up:
 *
 *   1. `testScopedSpawn` reads the argv it was handed — not the arguments
 *      that produced it — and refuses any mutating verb that references
 *      anything outside `sh.wemessage.test.`, any verb outside the union at
 *      all, and any read-only verb aimed outside this project's namespace.
 *   2. `sweepOwnDir` refuses a directory that is not inside the temp root,
 *      comparing realpaths, and refuses to delete a plist it did not name.
 *   3. `sweepOrphans` takes its labels from what the service manager itself
 *      reports and filters them through the same guard, so it cannot widen.
 *   4. `termOwnedDaemon` will not signal a pid unless launchd and our own
 *      lock file agree on it, and never signals this process, its parent,
 *      anything at or below pid 1, or the recorded sentinel.
 *
 * STAGE 1 INSTALLS NO REAL SPAWNER. The module-level delegate starts as
 * `null` and every spec here installs a recording fake, so the refusals are
 * proved against argv strings and not one of them can reach a process even
 * if every guard in this file were deleted.
 */
import { basename, join } from 'node:path';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { ulid } from 'ulid';
import { SERVICE_MANAGER, runLaunchctl } from '../../src/launchd/launchctl.js';
import {
  LAUNCH_AGENT_LABEL_PREFIX,
  LAUNCH_AGENT_TEST_LABEL_PREFIX,
  asLaunchAgentLabel,
  type LaunchAgentLabel,
  type ServiceManagerInvocation,
  type ServiceManagerResult,
  type ServiceManagerRun,
  type ServiceManagerSpawn,
} from '../../src/launchd/contract.js';
import { isUnderTempRoot } from '../../src/launchd/service.js';

/** The one namespace a test lane may create, mutate or delete. */
export const TEST_LABEL_PREFIX = LAUNCH_AGENT_TEST_LABEL_PREFIX;

/**
 * The verbs that cannot change anything, verified inert.
 *
 * TWO, not one. The dispatch describes the read-only allowance as
 * `args[0] === 'print'`; the ratified F-120 rule permits both read-only
 * subcommands, and `sweepOrphans` is specified to obtain its labels from
 * `list`. Widened deliberately, to an explicit allowlist that a row asserts
 * by value — never to a prefix test, which is how `listen` or `linger` would
 * one day be read as "starts with li, close enough".
 */
export const LANE_READ_ONLY_OPS = ['list', 'print'] as const;

/** The verbs that change something, and may only ever be test-scoped. */
const LANE_MUTATING_OPS = [
  'bootstrap',
  'bootout',
  'enable',
  'disable',
] as const;

/** A lane refusal. Never carries a spawn, never reaches a process. */
export class LaneRefused extends Error {
  constructor(detail: string) {
    super(`launchd test lane refused: ${detail}`);
    this.name = 'LaneRefused';
  }
}

/**
 * Build an invocation without spelling the tool's name.
 *
 * Exported because the specs need hand-built argvs — the whole point of the
 * guard is to catch a vector the runner never produced — and a spec that
 * wrote the file name itself would become a third test-side namer and fail
 * the arch guard's second leg, correctly.
 */
export function laneInvocation(
  args: readonly string[],
): ServiceManagerInvocation {
  return { file: SERVICE_MANAGER, args };
}

export function laneUid(): number {
  return process.getuid?.() ?? 501;
}

/**
 * A fresh test label.
 *
 * LOWERCASED, and that is not cosmetic: the id generator returns uppercase
 * Crockford base32 and the label grammar is lowercase alphanumerics and
 * hyphens, so `${prefix}${ulid()}` throws. Getting that wrong once here is
 * better than getting it wrong in every launchd spec that follows.
 */
export function mintTestLabel(): string {
  return `${TEST_LABEL_PREFIX}${ulid().toLowerCase()}`;
}

/* ── the delegate, which stage 1 never sets to anything real ──────────── */

let delegate: ServiceManagerSpawn | null = null;
let sentinelPid: number | null = null;

export function installLaneSpawner(spawn: ServiceManagerSpawn | null): void {
  delegate = spawn;
}

/**
 * Record the pid of the process tree these tests execute inside.
 *
 * Stage 2 sets this from the supervising agent's own pid. Anything that
 * matches it is refused even when every other check agrees, because a lock
 * file naming it is a lock file we should not believe.
 */
export function setLaneSentinelPid(pid: number | null): void {
  sentinelPid = pid;
}

export interface RecordingSpawner {
  readonly calls: ServiceManagerInvocation[];
  readonly argvs: () => string[][];
  readonly spawn: ServiceManagerSpawn;
}

export function recordingSpawner(
  reply: (i: ServiceManagerInvocation) => ServiceManagerResult = () => ({
    code: 0,
    stdout: '',
    stderr: '',
  }),
): RecordingSpawner {
  const calls: ServiceManagerInvocation[] = [];
  return {
    calls,
    argvs: () => calls.map((c) => [...c.args]),
    spawn: (i) => {
      calls.push(i);
      return Promise.resolve(reply(i));
    },
  };
}

/* ── refusal 1: the argv guard ────────────────────────────────────────── */

/**
 * What an argument REFERS to, as a label, or null if it names no label.
 *
 * Deliberately generic. There is no list of forbidden labels here and there
 * is no string in this repository spelling the operator's own: a guard
 * written as a denylist protects exactly the agents somebody thought of, and
 * the one that matters is always the one they did not. The rule is an
 * allowlist over OUR namespace, so every other label on the machine —
 * present, future, and unknown to us — is outside it by construction.
 */
function referencedLabel(arg: string): string | null {
  if (/^gui\/\d+$/.test(arg)) return null; // a domain, not a target
  if (arg.startsWith('gui/')) {
    const slash = arg.indexOf('/', 4);
    return slash === -1 ? arg : arg.slice(slash + 1);
  }
  if (arg.endsWith('.plist')) return basename(arg, '.plist');
  if (arg.startsWith('-')) return null; // a flag
  return arg;
}

function isTestScoped(label: string): boolean {
  return (
    label.startsWith(TEST_LABEL_PREFIX) &&
    label.length > TEST_LABEL_PREFIX.length
  );
}

function isOurs(label: string): boolean {
  return (
    label.startsWith(LAUNCH_AGENT_LABEL_PREFIX) &&
    label.length > LAUNCH_AGENT_LABEL_PREFIX.length
  );
}

/**
 * The lane's spawn: refuse, then delegate.
 *
 * The refusal is decided from `i.args` alone — the strings that would be
 * handed to a process — because every other input has already been through
 * somebody's idea of a check by the time it gets here, and the argv is the
 * last thing that is still true.
 */
export async function testScopedSpawn(
  i: ServiceManagerInvocation,
): Promise<ServiceManagerResult> {
  const args = [...i.args];
  const verb = args[0] ?? '';
  const readOnlyVerb = (LANE_READ_ONLY_OPS as readonly string[]).includes(verb);
  const mutatingVerb = (LANE_MUTATING_OPS as readonly string[]).includes(verb);
  if (!readOnlyVerb && !mutatingVerb)
    throw new LaneRefused(
      `${JSON.stringify(verb)} is not a verb this lane runs: the allowlist is ` +
        `${JSON.stringify([...LANE_READ_ONLY_OPS, ...LANE_MUTATING_OPS])}`,
    );
  for (const arg of args.slice(1)) {
    if (arg.includes('system/'))
      throw new LaneRefused(
        `${JSON.stringify(arg)} addresses the system domain; this lane is ` +
          'confined to the caller’s own GUI domain',
      );
    const label = referencedLabel(arg);
    if (label === null) continue;
    if (mutatingVerb && !isTestScoped(label))
      throw new LaneRefused(
        `${verb} would affect ${JSON.stringify(label)}, which is not under ` +
          `${TEST_LABEL_PREFIX}`,
      );
    if (readOnlyVerb && !isOurs(label))
      throw new LaneRefused(
        `${verb} would read ${JSON.stringify(label)}, which is not a label ` +
          'this project owns',
      );
  }
  // ONLY NOW. Everything above is decided without consulting the delegate,
  // so a lane with a real spawner behind it still creates no process on any
  // refusing path, and "refused" stays distinguishable from "not wired".
  if (delegate === null)
    throw new Error(
      'no spawner is installed in the launchd test lane (stage 1 installs none)',
    );
  return await delegate(i);
}

/** The two inert subcommands, and the only way this lane asks a question. */
export const readOnly = {
  list: async (): Promise<ServiceManagerResult> =>
    await testScopedSpawn(laneInvocation(['list'])),
  print: async (label: LaunchAgentLabel): Promise<ServiceManagerResult> =>
    await testScopedSpawn(
      laneInvocation(['print', `gui/${String(laneUid())}/${label}`]),
    ),
};

/** The runner, bound to a spawn. Not a second implementation of the guard. */
export function laneRun(spawn: ServiceManagerSpawn): ServiceManagerRun {
  return (op, label, options) => runLaunchctl(op, label, { ...options, spawn });
}

/* ── refusal 2: the directory sweep (plan row 14) ─────────────────────── */

/**
 * Boot out and delete every agent this lane installed in `dir`.
 *
 * Two conditions, and neither implies the other. The directory must be
 * inside the temp root, which is what keeps this away from
 * `~/Library/LaunchAgents`. And every plist in it must be one of ours, which
 * is what stops a sweep from deleting a file it did not put there — a temp
 * directory holding a plist we did not name is a broken assumption, and the
 * lane stops rather than guessing.
 *
 * Nothing is deleted until everything has been checked.
 */
export async function sweepOwnDir(dir: string): Promise<string[]> {
  if (!isUnderTempRoot(dir))
    throw new LaneRefused(
      `${JSON.stringify(dir)} is not inside the temp root: a sweep outside it ` +
        'would be a sweep of somebody’s real agents directory',
    );
  const labels: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.plist')) continue;
    const label = basename(entry, '.plist');
    if (!isTestScoped(label))
      throw new LaneRefused(
        `${JSON.stringify(entry)} in ${JSON.stringify(dir)} is not an agent ` +
          'this lane installed',
      );
    labels.push(label);
  }
  for (const label of labels) {
    await testScopedSpawn(
      laneInvocation(['bootout', `gui/${String(laneUid())}/${label}`]),
    );
    rmSync(join(dir, `${label}.plist`), { force: true });
  }
  return labels;
}

/* ── refusal 3: the orphan sweep ──────────────────────────────────────── */

/**
 * Boot out every test-scoped agent the service manager reports as loaded.
 *
 * The labels come from `list` rather than from a directory, because an
 * orphan is by definition an agent whose plist is already gone. Each one
 * goes back through `asLaunchAgentLabel` and through the same argv guard, so
 * this cannot widen past what the guard permits even if the parse is wrong.
 */
export async function sweepOrphans(): Promise<string[]> {
  const listed = await readOnly.list();
  if (listed.code !== 0)
    throw new Error(
      `the service manager's list subcommand failed (exit ` +
        `${String(listed.code)}): ${listed.stderr.trim()}`,
    );
  const labels: string[] = [];
  for (const line of listed.stdout.split('\n')) {
    const cols = line.split('\t');
    const label = cols[cols.length - 1]?.trim() ?? '';
    // `sh.wemessage.testing.not-a-test` is the trap this component-boundary
    // check exists for: a prefix test written without the trailing dot
    // sweeps it, and it is not ours to sweep.
    if (!isTestScoped(label)) continue;
    labels.push(asLaunchAgentLabel(label));
  }
  for (const label of labels)
    await testScopedSpawn(
      laneInvocation(['bootout', `gui/${String(laneUid())}/${label}`]),
    );
  return labels;
}

/* ── refusal 4: the only real signal in any launchd spec ──────────────── */

export type TermOutcome = 'absent' | 'signalled';

export interface TermOptions {
  /** Injected so stage 1 proves the DECISION without sending anything. */
  readonly signal?: (pid: number, sig: NodeJS.Signals) => void;
}

/**
 * Stop the daemon this lane started in `tmpDir`, or report it absent.
 *
 * TWO INDEPENDENT WITNESSES MUST AGREE. `print` reports whatever launchd has
 * under that label, which is a pid a stranger could have chosen; the lock
 * file reports what OUR daemon wrote about itself. Signalling on the
 * strength of either alone is signalling a number, and pids are reused.
 */
export async function termOwnedDaemon(
  tmpDir: string,
  label: LaunchAgentLabel,
  options: TermOptions = {},
): Promise<TermOutcome> {
  const checked = asLaunchAgentLabel(label);
  const printed = await readOnly.print(checked);
  if (printed.code !== 0) return 'absent';
  const m = /\bpid\s*=\s*(-?\d+)/.exec(printed.stdout);
  if (m?.[1] === undefined) return 'absent';
  const pid = Number(m[1]);

  let locked: number;
  try {
    locked = Number(readFileSync(join(tmpDir, 'daemon.lock'), 'utf8').trim());
  } catch {
    throw new LaneRefused(
      `no lock file in ${JSON.stringify(tmpDir)}: without one there is no ` +
        'second witness that this pid is ours',
    );
  }
  if (locked !== pid)
    throw new LaneRefused(
      `launchd reports pid ${String(pid)} and our lock file says ` +
        `${String(locked)}: they must agree before anything is signalled`,
    );
  if (pid <= 1 || pid === process.pid || pid === process.ppid)
    throw new LaneRefused(
      `pid ${String(pid)} is this process, its parent, or a process-group ` +
        'target; none of those is a daemon this lane started',
    );
  if (sentinelPid !== null && pid === sentinelPid)
    throw new LaneRefused(
      `pid ${String(pid)} is the recorded supervisor sentinel: a lock file ` +
        'naming it is a lock file to disbelieve, not to act on',
    );

  const send =
    options.signal ??
    ((p: number, s: NodeJS.Signals) => {
      process.kill(p, s);
    });
  send(pid, 'SIGTERM');
  return 'signalled';
}

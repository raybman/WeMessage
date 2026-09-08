/**
 * THE ONLY MODULE IN THIS REPOSITORY THAT MAY SPAWN macOS' SERVICE MANAGER.
 *
 * s9 Sc 1 rows 5 and 6, extended by s9 Sc 3's G1 and G2; the type-level half
 * of F-120.
 *
 * THE RULE THIS ENCODES, in one sentence: a process that can spawn a service
 * manager must never be able to reach the agent supervising it.
 *
 * The machine this project is developed on runs other people's launchd
 * agents — an editor's helper, a backup daemon, the operator's own assistant
 * — and every one of them is one mistyped label away from being stopped by
 * this code. `bootout` does not ask, does not confirm, and does not
 * distinguish "the service I wrote" from "the service watching me write it".
 * So the label is not a string. It is a BRAND that only `asLaunchAgentLabel`
 * can mint, minted only for this project's own reverse-DNS namespace, and the
 * brand is re-checked at runtime here because a brand is erased by a cast.
 *
 * The throw is SYNCHRONOUS even though the function returns a promise. An
 * `async function` would have made the refusal a rejection, and an unawaited
 * rejected promise is a warning printed on stderr rather than a stopped
 * program. That is not good enough for the last thing standing between this
 * code and somebody else's daemon.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * G1 (s9 Sc 3): THE ARGV IS BOUND TO THE LABEL, NOT MERELY ACCOMPANIED BY IT.
 *
 * Sc 1 left a real hole here, and it is worth naming precisely because the
 * shape of it recurs. Four of the five ops put the label INTO the argv, so
 * checking the label checks the operation. `bootstrap` does not: its argv is
 * a domain and a PATH, and Sc 1 validated the label and then never used it.
 * Two consequences followed, neither hypothetical:
 *
 *   - The label guard did not cover `bootstrap` at all. A caller could pass
 *     a perfectly legitimate label of ours together with a plist declaring
 *     somebody else's, and the guard would wave it through, because what
 *     launchd loads is decided by the file's `Label` key and not by the
 *     argument the guard inspected.
 *
 *   - `launchctl bootstrap <domain> <dir>` accepts a DIRECTORY and loads
 *     every plist in it. `~/Library/LaunchAgents` on a working machine holds
 *     dozens, including a `.disabled/` subdirectory of agents somebody
 *     deliberately turned off. One `dirname` used by accident turns them all
 *     back on.
 *
 * So `bootstrap` now requires all three to agree: the path is a FILE, its
 * basename is `<label>.plist`, and the `Label` inside it is that same label.
 * The scoped ops get the other half: exactly two arguments, and a target
 * matching `gui/<digits>/<one of our labels>` — re-checked after the argv is
 * built, because the argv is the last thing that is still true.
 *
 * And the domain is the CALLER's. `uid` was a free parameter in Sc 1, which
 * meant any caller could address any user's GUI domain; it is now refused
 * unless it is this process's own.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * G2: the real spawn lives here, in the one file the arch guard lets name the
 * tool, and it is injected everywhere else. Not for testability as such — for
 * the stronger property that the tests which prove these guards bite have no
 * way to reach a real service manager even by accident.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import {
  LaunchdInvocationRefused,
  LaunchdLabelRefused,
  isLaunchAgentLabel,
  type LaunchAgentLabel,
  type LaunchctlOp,
  type ServiceManagerFile,
  type ServiceManagerInvocation,
  type ServiceManagerResult,
  type ServiceManagerRun,
  type ServiceManagerSpawn,
} from './contract.js';
import { plistDeclaredLabel } from './plist.js';

/*
 * The vocabulary lives in `contract.ts` and is re-exported here so that Sc 1's
 * spec keeps reading exactly as it was written, and so that no other module
 * has to import THIS file — an import specifier is source, and a module that
 * named this file would become a second module naming the tool.
 */
export {
  asLaunchAgentLabel,
  isLaunchAgentLabel,
  LAUNCHCTL_OPS,
  LAUNCH_AGENT_LABEL_PREFIX,
  LAUNCH_AGENT_TEST_LABEL_PREFIX,
  LaunchdInvocationRefused,
  LaunchdLabelRefused,
} from './contract.js';
export type {
  LaunchAgentLabel,
  LaunchctlOp,
  ServiceManagerFile,
  ServiceManagerInvocation,
  ServiceManagerResult,
  ServiceManagerRun,
  ServiceManagerSpawn,
} from './contract.js';

/**
 * The tool's name, and the only value of its type anywhere.
 *
 * `ServiceManagerFile` has no public constructor, so an invocation cannot be
 * built by a module that has not obtained this constant — which makes the
 * arch spec's "one module names the tool" a fact the type system agrees with
 * rather than one it merely tolerates.
 */
export const SERVICE_MANAGER = 'launchctl' as ServiceManagerFile;

/** Sc 1's names for the shapes that now live in `contract.ts`. */
export type LaunchctlInvocation = ServiceManagerInvocation;
export type LaunchctlResult = ServiceManagerResult;

export interface LaunchctlOptions {
  /** The spawn. Injected; typed to accept only an invocation we built. */
  readonly spawn: ServiceManagerSpawn;
  /** The GUI domain's uid. Defaults to this process's. Never another's. */
  readonly uid?: number;
  /** Required by `bootstrap`, meaningless to every other op. */
  readonly plistPath?: string;
}

/**
 * `gui/<digits>/<a label we own>`. The only target shape that reaches a spawn.
 *
 * The label half is spelled out rather than delegated to the label matcher
 * because this is a check on the STRING THE PROCESS WILL RECEIVE, and the
 * value of re-deriving it from the same regex would be zero: the point is
 * that the assembled argv, not its inputs, is what gets inspected last.
 */
const TARGET_RE = /^gui\/\d+\/sh\.wemessage(?:\.[a-z0-9-]+)+$/;

/**
 * Run one scoped op against a label this project owns.
 *
 * Returns a promise; THROWS synchronously on every refusal. Nothing is
 * spawned on any refusing path.
 */
export function runLaunchctl(
  op: LaunchctlOp,
  label: LaunchAgentLabel,
  options: LaunchctlOptions,
): Promise<LaunchctlResult> {
  // THE RE-CHECK. Before the domain is computed, before the argv is built,
  // before anything is spawned. `label` arrives branded, and the brand is
  // erased by a cast, so the value is asked the same question a second time
  // at the only moment when the answer can still prevent a process.
  if (!isLaunchAgentLabel(label)) throw new LaunchdLabelRefused(label);

  const own = process.getuid?.();
  const uid = options.uid ?? own ?? 501;
  if (own !== undefined && uid !== own)
    throw new LaunchdInvocationRefused(
      `domain uid ${String(uid)} is not this process's (${String(own)}): ` +
        `this project only ever addresses the caller's own GUI domain`,
    );
  const domain = `gui/${String(uid)}`;

  let args: readonly string[];
  if (op === 'bootstrap') {
    args = [op, domain, bootstrapPath(label, options.plistPath)];
  } else {
    const target = `${domain}/${label}`;
    // Belt and braces on the assembled string. `label` passed the brand
    // check above; this asserts that the concatenation which is actually
    // handed over still has the one shape we mean.
    if (!TARGET_RE.test(target))
      throw new LaunchdInvocationRefused(
        `assembled target ${JSON.stringify(target)} is not gui/<uid>/<our label>`,
      );
    args = [op, target];
    if (args.length !== 2)
      throw new LaunchdInvocationRefused(
        `${op} takes exactly one target, built ${String(args.length)} arguments`,
      );
  }

  return options.spawn({ file: SERVICE_MANAGER, args });
}

/**
 * The plist path `bootstrap` may be given, or a refusal.
 *
 * Three questions, each of which the other two do not answer:
 *   1. is it a FILE (not the directory that would load everything in it);
 *   2. is it NAMED for the label (launchd's own convention, made binding);
 *   3. does it DECLARE the label (the only one launchd will actually obey).
 */
function bootstrapPath(label: LaunchAgentLabel, plistPath?: string): string {
  // `bootstrap` takes a DOMAIN and a path, not a target. Without the path
  // the argv would be `bootstrap gui/501`, which launchd reads as a
  // domain-wide operation — the exact class of accident this file exists to
  // prevent, so it is refused rather than shipped.
  if (plistPath === undefined || plistPath.length === 0)
    throw new LaunchdInvocationRefused(
      'bootstrap requires a plistPath: a bootstrap without one addresses the ' +
        'whole domain rather than this project’s agent',
    );

  let isFile = false;
  try {
    isFile = statSync(plistPath).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile)
    throw new LaunchdInvocationRefused(
      `${JSON.stringify(plistPath)} is not a regular file; bootstrap given a ` +
        'directory loads every plist inside it',
    );

  const expected = `${label}.plist`;
  if (basename(plistPath) !== expected)
    throw new LaunchdInvocationRefused(
      `${JSON.stringify(plistPath)} is not named ${JSON.stringify(expected)}: ` +
        'an agent file is named for its label',
    );

  let declared: string | null;
  try {
    declared = plistDeclaredLabel(readFileSync(plistPath, 'utf8'));
  } catch (cause) {
    throw new LaunchdInvocationRefused(
      `${JSON.stringify(plistPath)} could not be read as a property list: ` +
        String((cause as Error).message),
    );
  }
  if (declared !== label)
    throw new LaunchdInvocationRefused(
      `${JSON.stringify(plistPath)} declares Label ${JSON.stringify(declared)}, ` +
        `not ${JSON.stringify(label)}: launchd obeys the file, not the argument`,
    );

  return plistPath;
}

/**
 * How long the service manager gets before this process stops waiting on it.
 *
 * BOUNDED for the same reason the lane's ancestry walk is (s9 Sc3 stage 1b):
 * every one of these subcommands answers in milliseconds on a healthy
 * machine, and the case this covers is not a slow answer but no answer at
 * all — a wedged `bootstrap` inside a test run is a suite that hangs until
 * something outside it gives up, and a hang is the failure mode that gets
 * diagnosed as "flaky" and then ignored. `execFile`'s timeout signals the
 * SERVICE MANAGER, which is a short-lived client of launchd; it does not
 * reach any job launchd is supervising.
 */
export const SERVICE_MANAGER_TIMEOUT_MS = 30_000;

/**
 * The real spawn (G2).
 *
 * Defined here, called from exactly one place in this package — the
 * entrypoint that composes the CLI — and handed to the test lane as a VALUE,
 * so no second module ever names the tool. `execFile` rather than a shell:
 * the argv is an array this module built from a closed union, and there is
 * no interpreter between it and the process.
 *
 * A NON-ZERO EXIT IS A RESULT, NOT A THROW. `print` answering 113 for a job
 * that is not loaded is the single most-used fact in the lifecycle rows, and
 * a spawn that rejected on it would make "absent" indistinguishable from
 * "the tool is missing" at every call site. Only the callback's own error
 * shape decides the code, and a timeout or a missing binary arrives with no
 * numeric `code` and lands on 1.
 */
export const realLaunchctlSpawn: ServiceManagerSpawn = (i) =>
  new Promise<ServiceManagerResult>((ok) => {
    execFile(
      SERVICE_MANAGER,
      [...i.args],
      {
        timeout: SERVICE_MANAGER_TIMEOUT_MS,
        // `list` on a working machine is hundreds of lines and `print` is
        // dozens; the ceiling is generous and exists so a pathological
        // answer is an error rather than this process's memory.
        maxBuffer: 8 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : ((err as { code?: number }).code ?? 1);
        ok({ code, stdout, stderr });
      },
    );
  });

/**
 * The real runner: the guarded run, closed over the real spawn.
 *
 * WHY THIS MOVED HERE FROM THE ENTRYPOINT. Until S9 Sc 4 the only production
 * program that needed a runner was `bin.ts`, so composing it there cost
 * nothing and the arch guard could pin the composition to a single file.
 * Sc 4 gives the DAEMON a reason to run one op — `bootout` of its own label,
 * on disconnect — and the daemon is `main.ts`, a different program. Composing
 * it a second time in `main.ts` would have made two modules name the spawn
 * and widened the guard that says only one may.
 *
 * So the composition itself becomes the shared value. `bin.ts` and `main.ts`
 * both import THIS, and neither names the spawn; the set of files naming it
 * NARROWS to this one. That is the direction a guard is allowed to move. A
 * route, a helper, or a convenience wrapper still cannot obtain a runner
 * without importing this module, which the arch row continues to forbid for
 * everything that is not a program root.
 *
 * The guard is not weakened by being reachable from two programs: every
 * refusal in `runLaunchctl` — the label prefix, the uid, the assembled
 * target — runs before any spawn, and this value adds none of its own.
 */
export const realServiceManagerRun: ServiceManagerRun = (op, label, options) =>
  runLaunchctl(op, label, { ...options, spawn: realLaunchctlSpawn });

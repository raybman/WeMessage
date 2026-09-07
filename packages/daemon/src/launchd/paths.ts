/**
 * Where the LaunchAgent lives, what it is called, and where it logs
 * (s9 Sc3 row 15, plan §1.7).
 *
 * WHY THIS IS ITS OWN MODULE AND NOT FOUR CONSTANTS. Every one of these
 * strings is overridable, and every override is a place a test could reach
 * into the operator's real home. `~/Library/LaunchAgents` on a working macOS
 * machine holds the agents that keep the operator's editor, backups and
 * assistant running; the assistant on THIS machine is the process tree this
 * project is developed inside. So the defaults and the overrides are resolved
 * in one function, from an environment passed IN rather than read from the
 * ambient process, which is what lets a test assert what a fresh machine
 * would choose without a single write and without a single read of the real
 * directory.
 *
 * NOTHING HERE TOUCHES A FILESYSTEM. No `existsSync`, no `mkdir`. The row
 * that pins the defaults asserts strings, because a row that stat'd the real
 * agents directory would pass on this machine and would teach the next
 * builder that reading it is fine.
 *
 * THE LABEL PREFIX IS AN ALLOWLIST OF TWO. `sh.wemessage.` for what ships and
 * `sh.wemessage.test.` for what a test lane may create and delete. A third —
 * `sh.wemessage.staging.`, say — would be inside the namespace and outside
 * every sweep, which is the definition of an orphan nobody cleans up.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALLABLE_LABEL_PREFIXES,
  LAUNCH_AGENT_LABEL_PREFIX,
  LaunchdLabelRefused,
  asLaunchAgentLabel,
  type InstallableLabelPrefix,
  type LaunchAgentLabel,
} from './contract.js';
import {
  BUNDLE_DAEMON_MAIN_SUFFIX,
  BUNDLE_EXECUTABLE_SUFFIX,
} from './plist.js';

/** The environment this module reads. Passed in; never `process.env` here. */
export type PathEnv = Readonly<Record<string, string | undefined>>;

export interface BundlePaths {
  /** `~/Library/LaunchAgents` unless overridden. Never `/Library/…`. */
  readonly launchAgentsDir: string;
  /** `~/Library/Logs/WeMessage` unless overridden. */
  readonly logsDir: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** One of exactly two strings. */
  readonly labelPrefix: InstallableLabelPrefix;
  /** The agent this prefix installs: `<prefix>gateway`. */
  readonly label: LaunchAgentLabel;
}

/**
 * The one place a label prefix is validated.
 *
 * Returns the branded prefix or throws. Note what it does NOT do: fall back
 * to the default. A caller who asked for a prefix this product does not
 * install under has said something specific, and quietly installing under a
 * different one is how a test writes into the operator's real namespace.
 */
export function asInstallableLabelPrefix(raw: string): InstallableLabelPrefix {
  const hit = INSTALLABLE_LABEL_PREFIXES.find((p) => p === raw);
  if (hit === undefined) throw new LaunchdLabelRefused(raw);
  return hit;
}

export function resolveBundlePaths(
  env: PathEnv,
  home: string = homedir(),
): BundlePaths {
  const labelPrefix = asInstallableLabelPrefix(
    env['WEMESSAGE_LAUNCHD_LABEL_PREFIX'] ?? LAUNCH_AGENT_LABEL_PREFIX,
  );
  const launchAgentsDir =
    env['WEMESSAGE_LAUNCH_AGENTS_DIR'] ?? join(home, 'Library', 'LaunchAgents');
  const logsDir =
    env['WEMESSAGE_LOGS_DIR'] ?? join(home, 'Library', 'Logs', 'WeMessage');
  return {
    launchAgentsDir,
    logsDir,
    stdoutPath: join(logsDir, 'daemon.out.log'),
    stderrPath: join(logsDir, 'daemon.err.log'),
    labelPrefix,
    label: asLaunchAgentLabel(`${labelPrefix}gateway`),
  };
}

/**
 * The argument vector the installed agent should run.
 *
 * Derived rather than configured, because a plist whose `ProgramArguments`
 * came from a flag is a plist that can run anything at every login. Two
 * shapes, in priority order:
 *
 *  1. the packaged app, when we can see one — either named explicitly, or
 *     inferred from the fact that THIS process is running out of one;
 *  2. the development layout: this node, and the built entrypoint.
 *
 * `plist.ts` refuses anything that is neither, so a bad derivation here
 * becomes a refusal rather than a plist.
 */
export function resolveProgramArguments(
  env: PathEnv,
  daemonMain: string,
  execPath: string,
): readonly string[] {
  const explicitApp = env['WEMESSAGE_APP_PATH'];
  if (explicitApp !== undefined && explicitApp.length > 0)
    return [
      `${explicitApp}${BUNDLE_EXECUTABLE_SUFFIX}`,
      `${explicitApp}${BUNDLE_DAEMON_MAIN_SUFFIX}`,
    ];

  const marker = '/Contents/Resources/';
  const at = daemonMain.indexOf(marker);
  if (at > 0) {
    const app = daemonMain.slice(0, at);
    return [
      `${app}${BUNDLE_EXECUTABLE_SUFFIX}`,
      `${app}${BUNDLE_DAEMON_MAIN_SUFFIX}`,
    ];
  }

  const explicitMain = env['WEMESSAGE_DAEMON_MAIN'];
  if (explicitMain !== undefined && explicitMain.length > 0)
    return [execPath, explicitMain];

  // The development layout: this node, and the built entrypoint the caller
  // resolved from the package root (so it is the same path whether the CLI
  // is running from `src/` under a test runner or from `dist/` for real).
  return [execPath, daemonMain];
}

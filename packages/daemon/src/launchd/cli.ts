/**
 * `wemessaged service install | uninstall | status` (s9 Sc3 rows 5, 11, 12)
 * and G4, the command-line scoping guards.
 *
 * WHY THE GUARDS ARE HERE AND NOT ONLY DEEPER. The renderer binds a plist to
 * a label. The runner binds an argv to a label. Neither of them knows the one
 * thing a command line knows: that this invocation is a TEST. Under
 * `sh.wemessage.test.` both directories must resolve inside the process's
 * temp root or the command refuses before it has written a byte — because the
 * default for `--launch-agents-dir` is the operator's real
 * `~/Library/LaunchAgents`, and a test that forgets the flag would otherwise
 * install into it and be perfectly correct at every other layer.
 *
 * The rule binds the TEST prefix only, and that asymmetry is deliberate. The
 * legitimate production caller's directories are in the operator's home by
 * definition; a guard a legitimate caller has to be exempted from is the
 * wrong guard, so it is written to bind the case that needs binding.
 *
 * THE PREFIX ALLOWLIST IS TWO STRINGS. `sh.wemessage.staging.` is inside this
 * project's namespace and is not on it: "ours" is necessary and not
 * sufficient, because the test prefix is the one the sweeps may delete and a
 * third prefix would be inside the namespace and outside every sweep.
 *
 * PARSED BY HAND. The plan says commander; this is six flags and three
 * subcommands, and the argument that decides whether a directory is written
 * to should not arrive through a dependency's coercion rules.
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, AuditEvent, Clock } from '@wemessage/core';
import { SqliteStore } from '@wemessage/store';
import { createAuditSink } from '../audit-sink.js';
import {
  LAUNCH_AGENT_TEST_LABEL_PREFIX,
  LaunchdInvocationRefused,
  asLaunchAgentLabel,
  type LaunchAgentLabel,
  type ServiceManagerRun,
} from './contract.js';
import {
  asInstallableLabelPrefix,
  resolveBundlePaths,
  resolveProgramArguments,
  type PathEnv,
} from './paths.js';
import { renderLaunchAgentPlist } from './plist.js';
import {
  installService,
  isUnderTempRoot,
  statusService,
  uninstallService,
  type ServiceDeps,
} from './service.js';
import { mintServiceLabel } from './label.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The built entrypoint the agent will run.
 *
 * Resolved from the PACKAGE ROOT rather than from `process.argv[1]`, so it is
 * the same path whether this module is loaded from `src/` by a test runner or
 * from `dist/` for real. Deriving it from the running script produced
 * `<pkg>/src/main.js` under vitest, which is not a file and not the dev shape
 * the renderer accepts.
 */
const DAEMON_MAIN = join(resolve(HERE, '..', '..'), 'dist', 'main.js');

const SUBCOMMANDS = ['install', 'uninstall', 'status'] as const;

export interface CliIo {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

export interface CliOverrides {
  readonly env?: PathEnv;
  readonly home?: string;
  readonly execPath?: string;
  /** The runner, already bound to a spawn. Injected; never built here. */
  readonly run?: ServiceManagerRun;
  /**
   * Where audit rows go. Explicitly `| undefined` rather than merely
   * optional: under `exactOptionalPropertyTypes` a caller that wants the
   * real store has to be able to say so by passing `undefined`.
   */
  readonly appendAudit?: ((event: AuditEvent) => void) | undefined;
  readonly uid?: number;
  /** Return the taxonomy error instead of a sentence and an exit status. */
  readonly rethrow?: boolean;
}

const HELP = `wemessaged — the WeMessage gateway daemon

  wemessaged                       run the daemon in the foreground
  wemessaged service install       write the LaunchAgent plist and load it
  wemessaged service uninstall     unload the agent and remove its plist
  wemessaged service status        report whether the agent is loaded

Options for the service subcommands:
  --dir <path>                  the daemon's configuration directory
  --launch-agents-dir <path>    where the plist is written
  --label-prefix <prefix>       sh.wemessage. or sh.wemessage.test.
  --port <n>                    the port the agent's daemon listens on
  --no-load                     write the plist without handing it to launchd
  --json                        machine-readable output
`;

interface Flags {
  dir?: string;
  launchAgentsDir?: string;
  labelPrefix?: string;
  port?: number;
  json: boolean;
  load: boolean;
}

class CliUsageError extends Error {}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { json: false, load: true };
  const value = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--'))
      throw new CliUsageError(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--dir':
        flags.dir = value(i, arg);
        i += 1;
        break;
      case '--launch-agents-dir':
        flags.launchAgentsDir = value(i, arg);
        i += 1;
        break;
      case '--label-prefix':
        flags.labelPrefix = value(i, arg);
        i += 1;
        break;
      case '--port': {
        const raw = value(i, arg);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 65_535)
          throw new CliUsageError(
            `--port ${JSON.stringify(raw)} is not a port`,
          );
        flags.port = n;
        i += 1;
        break;
      }
      case '--json':
        flags.json = true;
        break;
      case '--no-load':
        flags.load = false;
        break;
      default:
        throw new CliUsageError(`unknown option ${JSON.stringify(arg)}`);
    }
  }
  return flags;
}

/** The one place a CLI invocation becomes an audit row in the real chain. */
function storeAppender(dir: string): (event: AuditEvent) => void {
  const clock: Clock = {
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
  };
  const actor: Actor = { kind: 'human', via: 'cli' };
  return (event) => {
    const store = new SqliteStore({ dir, clock });
    try {
      createAuditSink({ store, clock }).append(event, actor);
    } finally {
      store.close();
    }
  };
}

/**
 * Run one service subcommand. Returns the process exit status.
 *
 * 0 is success, 2 is a refusal — a usage error or a guard. Nothing here exits
 * the process: the caller decides, which is what lets every row in
 * `service-cli.spec.ts` run in-process against a fake.
 */
export async function runServiceCli(
  argv: readonly string[],
  io: CliIo,
  over: CliOverrides = {},
): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    io.out(HELP);
    return 0;
  }
  try {
    return await dispatch(argv, io, over);
  } catch (err) {
    if (over.rethrow === true) throw err;
    io.err(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

async function dispatch(
  argv: readonly string[],
  io: CliIo,
  over: CliOverrides,
): Promise<number> {
  if (argv[0] !== 'service')
    throw new CliUsageError(
      `unknown command ${JSON.stringify(argv[0] ?? '')}; try --help`,
    );
  const sub = argv[1] ?? '';
  if (!(SUBCOMMANDS as readonly string[]).includes(sub))
    throw new CliUsageError(
      `unknown service subcommand ${JSON.stringify(sub)}; expected one of ` +
        `${SUBCOMMANDS.join(', ')}`,
    );
  const flags = parseFlags(argv.slice(2));

  const baseEnv: PathEnv = over.env ?? process.env;
  const home = over.home ?? homedir();
  // The prefix is validated first, and it throws rather than defaulting: a
  // caller who named a prefix this product does not install under has said
  // something specific, and quietly using a different one is exactly how a
  // test writes into the operator's real namespace.
  const labelPrefix = asInstallableLabelPrefix(
    flags.labelPrefix ?? 'sh.wemessage.',
  );
  const env: PathEnv = {
    ...baseEnv,
    WEMESSAGE_LAUNCHD_LABEL_PREFIX: labelPrefix,
    ...(flags.launchAgentsDir === undefined
      ? {}
      : { WEMESSAGE_LAUNCH_AGENTS_DIR: flags.launchAgentsDir }),
  };
  const paths = resolveBundlePaths(env, home);
  const dir =
    flags.dir ??
    baseEnv['WEMESSAGE_DIR'] ??
    join(home, 'Library', 'Application Support', 'WeMessage');

  // G4. Decided from the RESOLVED STRINGS, before anything is created and
  // before anything is read: a refused path is never touched, not even to
  // ask whether it exists.
  if (labelPrefix === LAUNCH_AGENT_TEST_LABEL_PREFIX)
    for (const [name, path] of [
      ['--dir', dir],
      ['--launch-agents-dir', paths.launchAgentsDir],
    ] as const)
      if (!isUnderTempRoot(path))
        throw new LaunchdInvocationRefused(
          `${name} ${JSON.stringify(path)} is not inside the temp root: ` +
            `under ${LAUNCH_AGENT_TEST_LABEL_PREFIX} every directory this ` +
            'command writes must be a temporary one',
        );

  const deps: ServiceDeps = {
    run: requireRun(over),
    ...(over.uid === undefined ? {} : { uid: over.uid }),
    audit: over.appendAudit ?? storeAppender(dir),
  };

  if (sub === 'install') {
    const label = installLabel(baseEnv, labelPrefix, paths.label);
    const plistBytes = renderLaunchAgentPlist({
      label,
      programArguments: resolveProgramArguments(
        env,
        DAEMON_MAIN,
        over.execPath ?? process.execPath,
      ),
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      dir,
      ...(flags.port === undefined ? {} : { port: flags.port }),
    });
    const result = await installService(
      {
        dir,
        launchAgentsDir: paths.launchAgentsDir,
        label,
        plistBytes,
        load: flags.load,
      },
      deps,
    );
    emit(io, flags.json, result, [
      `installed ${result.label}`,
      `  plist   ${result.plistPath}`,
      `  loaded  ${String(result.bootstrapped)}`,
      `  changed ${String(result.changed)}`,
    ]);
    return 0;
  }

  if (sub === 'uninstall') {
    const result = await uninstallService(dir, deps);
    emit(io, flags.json, result, [
      result.changed
        ? `uninstalled ${String(result.label)}`
        : 'nothing installed in this directory',
    ]);
    return 0;
  }

  const result = await statusService(dir, deps);
  emit(io, flags.json, result, [
    `installed ${String(result.installed)}`,
    `running   ${String(result.running)}`,
    `label     ${String(result.label)}`,
    `pid       ${String(result.pid)}`,
  ]);
  return 0;
}

function emit(
  io: CliIo,
  json: boolean,
  result: unknown,
  lines: readonly string[],
): void {
  io.out(json ? `${JSON.stringify(result)}\n` : `${lines.join('\n')}\n`);
}

/**
 * The label this install writes.
 *
 * Under the production prefix there is exactly one agent and it has a
 * well-known name. Under the test prefix every install gets a fresh id, so
 * two specs running in the same second cannot collide on a label — and the
 * id is FOLDED TO LOWERCASE, because the generator emits uppercase Crockford
 * base32 and the label grammar does not accept it.
 */
function installLabel(
  env: PathEnv,
  labelPrefix: string,
  wellKnown: LaunchAgentLabel,
): LaunchAgentLabel {
  const explicit = env['WEMESSAGE_LAUNCHD_LABEL'];
  if (explicit !== undefined && explicit.length > 0) {
    if (!explicit.startsWith(labelPrefix))
      throw new LaunchdInvocationRefused(
        `WEMESSAGE_LAUNCHD_LABEL ${JSON.stringify(explicit)} is not under the ` +
          `requested prefix ${JSON.stringify(labelPrefix)}`,
      );
    return asLaunchAgentLabel(explicit);
  }
  if (labelPrefix === LAUNCH_AGENT_TEST_LABEL_PREFIX)
    return asLaunchAgentLabel(mintServiceLabel(labelPrefix));
  return wellKnown;
}

function requireRun(over: CliOverrides): ServiceManagerRun {
  if (over.run === undefined)
    throw new Error(
      'no service-manager runner was supplied to the CLI: the entrypoint ' +
        'binds the real one and every test binds a fake',
    );
  return over.run;
}

/**
 * Install, uninstall and status for the LaunchAgent (s9 Sc3 rows 6, 7, 11,
 * 12) — everything that touches disk, and nothing that parses argv.
 *
 * THE STATE FILE IS THE POINT. `<dir>/service.json` records the label and the
 * plist path this directory installed, so `uninstall` and `status` know what
 * to act on WITHOUT enumerating an agents directory. That is a safety
 * property, not a convenience: the alternative is a command that lists
 * `~/Library/LaunchAgents`, decides which entries look like ours, and acts on
 * the result — and "looks like ours" is a judgement about somebody else's
 * files made by a program holding `bootout`. There is no directory listing in
 * this module and `service-cli.spec.ts` asserts that, by reading the source.
 *
 * §1.8 ORDERING. The audit row is appended before the plist is written and
 * before anything is handed to the service manager, because an install that
 * is recorded only after it succeeds is missing from exactly the run somebody
 * needs to explain. The spec asserts it as an ORDER against a shared spy,
 * never as a comparison of two timestamps: two clock reads in the same
 * millisecond compare equal and prove nothing.
 *
 * C-5 EVERYWHERE. `waitForLaunchdState` is a bounded poll with a named
 * deadline. It exists because a rewrite is `bootout` followed by
 * `bootstrap`, and launchd tears a job down asynchronously: the second
 * command lands on a half-dead job and fails with an I/O error, sometimes.
 * A sleep would paper over that at the cost of making every green run slower
 * and every red run a mystery.
 */
import {
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AuditEvent } from '@wemessage/core';
import {
  asLaunchAgentLabel,
  type LaunchAgentLabel,
  type ServiceManagerResult,
  type ServiceManagerRun,
  type ServiceManagerRunOptions,
} from './contract.js';

/** The file that remembers what this directory installed. */
export const SERVICE_STATE_FILENAME = 'service.json';

/** How long a teardown may take before the poll gives up (C-5). */
export const LAUNCHD_SETTLE_BUDGET_MS = 5_000;

export interface ServiceState {
  readonly label: string;
  readonly plistPath: string;
  /** Whether the last install actually handed the plist to launchd. */
  readonly bootstrapped: boolean;
}

export interface ServiceDeps {
  readonly run: ServiceManagerRun;
  readonly uid?: number;
  /** §1.8: called before any observable side effect. */
  readonly audit: (event: AuditEvent) => void;
}

/* ── the temp-root containment rule (G4, and the lane's row 14) ───────── */

/**
 * Is `p` inside the process's temp root?
 *
 * REALPATH ON BOTH SIDES, and the order of the two checks is the interesting
 * part. On macOS `os.tmpdir()` reports `/var/folders/...` while `/var` is a
 * symlink into `/private`, so a legitimate temp directory looks foreign
 * exactly half the time depending on which spelling the caller happens to
 * hold. Both spellings of the ROOT are therefore accepted.
 *
 * The candidate is resolved lexically first and only realpath'd if it passes
 * — which is what lets a caller ask "is the operator's real LaunchAgents
 * directory inside the temp root?" and get `false` WITHOUT this function
 * touching that path at all. A rejected path is never read. A path that
 * passes lexically is then realpath'd, because a symlink planted inside the
 * temp root pointing out of it would otherwise be the whole gap.
 */
export function isUnderTempRoot(p: string): boolean {
  const roots = [...new Set([resolve(tmpdir()), realish(tmpdir())])];
  const contained = (root: string, cand: string): boolean =>
    cand === root || cand.startsWith(root.endsWith(sep) ? root : root + sep);
  const lexical = resolve(p);
  if (!roots.some((r) => contained(r, lexical))) return false;
  const real = realish(p);
  return roots.some((r) => contained(r, real));
}

/** `realpathSync` that tolerates a path whose leaf does not exist yet. */
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

/* ── the state file ───────────────────────────────────────────────────── */

export function serviceStatePath(dir: string): string {
  return join(dir, SERVICE_STATE_FILENAME);
}

export function readServiceState(dir: string): ServiceState | null {
  let raw: string;
  try {
    raw = readFileSync(serviceStatePath(dir), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceState>;
    if (
      typeof parsed.label !== 'string' ||
      typeof parsed.plistPath !== 'string'
    )
      return null;
    return {
      label: parsed.label,
      plistPath: parsed.plistPath,
      bootstrapped: parsed.bootstrapped === true,
    };
  } catch {
    return null;
  }
}

function writeServiceState(dir: string, state: ServiceState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(serviceStatePath(dir), `${JSON.stringify(state, null, 2)}\n`);
}

/* ── the bounded poll ─────────────────────────────────────────────────── */

function runOptions(
  uid: number | undefined,
  plistPath?: string,
): ServiceManagerRunOptions {
  // Built branch by branch rather than with a spread of possibly-undefined
  // values: `exactOptionalPropertyTypes` makes "absent" and "present and
  // undefined" different types, and this is the seam where that matters.
  if (uid === undefined) return plistPath === undefined ? {} : { plistPath };
  return plistPath === undefined ? { uid } : { uid, plistPath };
}

/**
 * Poll `print` until the predicate holds, or fail with a named deadline.
 *
 * Never a sleep (C-5). The caller says what it is waiting FOR, so the timeout
 * message names the condition rather than the duration.
 */
export async function waitForLaunchdState(
  label: LaunchAgentLabel,
  predicate: (r: ServiceManagerResult) => boolean,
  deadlineMs: number,
  deps: ServiceDeps,
): Promise<ServiceManagerResult> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const r = await deps.run('print', label, runOptions(deps.uid));
    if (predicate(r)) return r;
    if (Date.now() >= deadline)
      throw new Error(
        `launchd did not settle for ${label} within ${String(deadlineMs)}ms`,
      );
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

/* ── install ──────────────────────────────────────────────────────────── */

export interface InstallInput {
  readonly dir: string;
  readonly launchAgentsDir: string;
  readonly label: LaunchAgentLabel;
  readonly plistBytes: string;
  /** `--no-load` makes this false; stage 1 hands nothing to launchd. */
  readonly load: boolean;
}

export interface InstallResult {
  readonly label: string;
  readonly plistPath: string;
  readonly bootstrapped: boolean;
  readonly changed: boolean;
}

export async function installService(
  input: InstallInput,
  deps: ServiceDeps,
): Promise<InstallResult> {
  const plistPath = join(input.launchAgentsDir, `${input.label}.plist`);
  const previous = existsSync(plistPath)
    ? readFileSync(plistPath, 'utf8')
    : null;
  // CONTENT, not mtime and not existence. A rewrite that fires because a
  // file was touched boots the agent out and back in for nothing, and an
  // install that skips because the file exists ships yesterday's plist.
  const changed = previous !== input.plistBytes;

  // §1.8. Before the write, before the service manager, before stdout.
  deps.audit({ type: 'service.installed', label: input.label, plistPath });

  mkdirSync(input.launchAgentsDir, { recursive: true });
  if (changed) writeFileSync(plistPath, input.plistBytes);

  let bootstrapped = false;
  if (input.load) {
    const wasBootstrapped = readServiceState(input.dir)?.bootstrapped ?? false;
    if (changed && wasBootstrapped) {
      await deps.run('bootout', input.label, runOptions(deps.uid));
      // The poll that pays for itself: launchd tears down asynchronously and
      // a bootstrap issued into a half-dead job fails intermittently.
      await waitForLaunchdState(
        input.label,
        (r) => r.code !== 0,
        LAUNCHD_SETTLE_BUDGET_MS,
        deps,
      );
    }
    if (changed)
      await deps.run('bootstrap', input.label, runOptions(deps.uid, plistPath));
    bootstrapped =
      (await deps.run('print', input.label, runOptions(deps.uid))).code === 0;
  }

  writeServiceState(input.dir, {
    label: input.label,
    plistPath,
    bootstrapped,
  });
  return { label: input.label, plistPath, bootstrapped, changed };
}

/* ── restart ──────────────────────────────────────────────────────────── */

export interface RestartResult {
  readonly label: string;
  readonly plistPath: string;
  readonly bootstrapped: boolean;
}

/**
 * s9 Sc7 row 6. `bootout` then `bootstrap`, unconditionally — the fourth verb
 * pair on the guarded runner, and still not the reload-in-place verb this
 * project refuses to use.
 *
 * `installService` only reloads when the plist CONTENT changed, which is
 * correct for an install and wrong for a restart: the whole point of the
 * button this serves is "macOS granted the permission after the agent last
 * started", a fact the plist bytes say nothing about. So this skips the
 * content diff entirely and always tears down and reloads whatever
 * `service.json` already points at.
 *
 * Throws if nothing is installed in `dir` — there is no plist to restart, and
 * a caller reaching this without checking first has a bug worth surfacing
 * rather than a no-op worth swallowing.
 */
export async function serviceRestart(
  dir: string,
  deps: ServiceDeps,
): Promise<RestartResult> {
  const state = readServiceState(dir);
  if (state === null)
    throw new Error(`serviceRestart: nothing installed in ${dir}`);
  const label = asLaunchAgentLabel(state.label);

  // §1.8, same as install: the row is appended before anything is asked of
  // the service manager. Reuses `service.installed` rather than minting a
  // new audit event type — the fact recorded ("this label is loaded under
  // launchd, from this plist") is exactly as true after a restart as after
  // an install, and `AuditEvent`'s union is not this file's to widen.
  deps.audit({ type: 'service.installed', label, plistPath: state.plistPath });

  await deps.run('bootout', label, runOptions(deps.uid));
  await waitForLaunchdState(
    label,
    (r) => r.code !== 0,
    LAUNCHD_SETTLE_BUDGET_MS,
    deps,
  );
  await deps.run('bootstrap', label, runOptions(deps.uid, state.plistPath));
  const bootstrapped =
    (await deps.run('print', label, runOptions(deps.uid))).code === 0;

  writeServiceState(dir, {
    label: state.label,
    plistPath: state.plistPath,
    bootstrapped,
  });
  return { label: state.label, plistPath: state.plistPath, bootstrapped };
}

/* ── uninstall ────────────────────────────────────────────────────────── */

export interface UninstallResult {
  readonly installed: boolean;
  readonly changed: boolean;
  readonly label: string | null;
}

export async function uninstallService(
  dir: string,
  deps: ServiceDeps,
): Promise<UninstallResult> {
  const state = readServiceState(dir);
  // Nothing installed means nothing happened, and — the part worth stating —
  // no audit row. An idempotent no-op that appends to a hash chain turns a
  // status loop into an audit log.
  if (state === null) return { installed: false, changed: false, label: null };

  const label = asLaunchAgentLabel(state.label);
  deps.audit({ type: 'service.uninstalled', label });

  if (state.bootstrapped) {
    await deps.run('bootout', label, runOptions(deps.uid));
    await waitForLaunchdState(
      label,
      (r) => r.code !== 0,
      LAUNCHD_SETTLE_BUDGET_MS,
      deps,
    );
  }
  rmSync(state.plistPath, { force: true });
  rmSync(serviceStatePath(dir), { force: true });
  return { installed: false, changed: true, label };
}

/* ── status ───────────────────────────────────────────────────────────── */

export interface StatusResult {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly label: string | null;
  readonly plistPath: string | null;
  readonly lastExitStatus: number | null;
}

const ABSENT: StatusResult = {
  installed: false,
  running: false,
  pid: null,
  label: null,
  plistPath: null,
  lastExitStatus: null,
};

export async function statusService(
  dir: string,
  deps: ServiceDeps,
): Promise<StatusResult> {
  const state = readServiceState(dir);
  // No state file, no question to ask: nothing is spawned on this path.
  if (state === null) return ABSENT;

  const label = asLaunchAgentLabel(state.label);
  const installed = isFile(state.plistPath);
  const printed = await deps.run('print', label, runOptions(deps.uid));
  if (printed.code !== 0)
    return {
      installed,
      running: false,
      pid: null,
      label: state.label,
      plistPath: state.plistPath,
      lastExitStatus: null,
    };
  return {
    installed,
    running: /^\s*state\s*=\s*running\b/m.test(printed.stdout),
    pid: firstNumber(/\bpid\s*=\s*(-?\d+)/, printed.stdout),
    label: state.label,
    plistPath: state.plistPath,
    lastExitStatus: firstNumber(
      /\blast exit code\s*=\s*(-?\d+)/,
      printed.stdout,
    ),
  };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function firstNumber(re: RegExp, text: string): number | null {
  const m = re.exec(text);
  return m?.[1] === undefined ? null : Number(m[1]);
}

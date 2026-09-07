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
 *      anything outside `sh.wemessage.test.`, any mutating verb that
 *      references NO label at all, any verb outside the union at all, and
 *      any read-only verb aimed outside this project's namespace.
 *   2. `sweepOwnDir` refuses a directory that is not inside the temp root,
 *      comparing realpaths, and refuses to delete a plist it did not name.
 *   3. `sweepOrphans` takes its labels from what the service manager itself
 *      reports and filters them through the same guard, so it cannot widen.
 *   4. `termOwnedDaemon` will not signal a pid unless launchd and our own
 *      lock file agree on it, and never signals this process, anything in
 *      its ANCESTRY, anything at or below pid 1, or the recorded sentinel.
 *
 * STAGE 1 INSTALLS NO REAL SPAWNER. The module-level delegate starts as
 * `null` and every spec here installs a recording fake, so the refusals are
 * proved against argv strings and not one of them can reach a process even
 * if every guard in this file were deleted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STAGE 1b CLOSED TWO HOLES IN THE ABOVE, both found by reading the guard
 * rather than by it failing, and both closed while the delegate is still
 * `null` — which is the only time closing them is cheap.
 *
 *   A. A MUTATING VERB THAT REFERENCED NOTHING WAS NOT REFUSED BY ANYTHING.
 *      The per-argument loop skipped every argument that names no label, so
 *      an argv whose arguments ALL name no label ran the loop to completion
 *      with nothing to object to. `['bootout', 'gui/501']` is that shape: a
 *      domain with no service, which is not a smaller operation than booting
 *      out one agent but a much larger one — it removes the whole GUI domain
 *      and logs the operator out. The manual's own example spells the domain
 *      target with a trailing slash, so the empty-label form is one string
 *      concatenation away from any test that builds a target by interpolating
 *      a label that turned out to be empty. The rule is now about the VERB
 *      CLASS and not about `bootout`: a mutating verb must reference at least
 *      one label, and every label it references must be test-scoped.
 *
 *   B. `process.ppid` IS ONE HOP. Under vitest the chain above this process
 *      is worker → runner → package manager → whatever started the run, so
 *      the process it would be worst to signal is typically three or four
 *      hops up and was invisible to a parent check. `termOwnedDaemon` now
 *      walks the parent chain and refuses anything in it — and refuses when
 *      the chain cannot be read at all.
 */
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { ulid } from 'ulid';
import {
  SERVICE_MANAGER,
  realLaunchctlSpawn,
  runLaunchctl,
} from '../../src/launchd/launchctl.js';
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

/**
 * The verbs that change something, and may only ever be test-scoped.
 *
 * Exported since stage 1b so the rule that follows from membership — a
 * mutating verb must reference at least one label — can be asserted over the
 * whole class by a row, rather than spot-checked on the one verb somebody
 * happened to worry about.
 */
export const LANE_MUTATING_OPS = [
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
let sentinelLabel: string | null = null;

export function installLaneSpawner(spawn: ServiceManagerSpawn | null): void {
  delegate = spawn;
}

/**
 * STAGE 2: install the REAL spawner (G2).
 *
 * A separate, named function rather than a value a spec could pass to
 * `installLaneSpawner`, so that "this run can reach the machine's service
 * manager" is a call somebody has to write out and a reviewer can grep for.
 * The spawner itself still lives in the runner — the one module permitted to
 * name the tool — and arrives here as a value, so this file gains a real
 * process and still gains no string.
 *
 * Nothing about the four refusals changes when this is called, and that is
 * the property stage 2 rests on: every one of them is decided from the argv
 * BEFORE the delegate is consulted, so wiring a real spawn behind them adds
 * a consequence to the paths that were already permitted and adds nothing at
 * all to the paths that were already refused.
 */
export function installRealLaneSpawner(): void {
  installLaneSpawner(realLaunchctlSpawn);
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

/**
 * Register the ONE foreign label this lane may READ, and only read (stage 2).
 *
 * THIS IS AN ALLOWANCE AND IT IS WORTH ARGUING FOR RATHER THAN ASSUMING.
 *
 * Stage 1's read-only rule was "a label this project owns", and F-120's
 * runtime half cannot be satisfied under it: the whole content of that row is
 * that an agent which is NOT ours is in exactly the state it was in before
 * the run — same print exit code, same `pid`, same `runs`. A row that can
 * only look at our own labels cannot state that, and the two ways of getting
 * around it are both worse than this. Printing it outside the lane means a
 * second test-side file naming the tool, which `test/arch.spec.ts` row 5
 * refuses, correctly. Widening the read-only rule to "any label" means the
 * guard no longer says anything.
 *
 * So the allowance is a SET OF ONE, registered by name, and it is the same
 * registration that arms the refusal on the other side: `termOwnedDaemon`
 * will not signal `sentinelPid`, and nothing may address `sentinelLabel` with
 * a mutating verb, because `isTestScoped` is unchanged and the sentinel is
 * not under the test prefix. The net effect is that the one foreign agent
 * this lane can see is precisely the one foreign agent it can never touch.
 *
 * THE LABEL IS NEVER A LITERAL IN THIS REPOSITORY. It arrives from the
 * environment at run time (`WEMESSAGE_F120_SENTINEL_LABEL`) or from what the
 * service manager itself reports; see `resolveSentinel`.
 */
export function setLaneSentinelLabel(label: string | null): void {
  sentinelLabel = label;
}

/** What is currently registered, for a row that asserts non-vacuity. */
export function laneSentinelLabel(): string | null {
  return sentinelLabel;
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
 *
 * THE THREE FORMS THAT ANSWER `null`, enumerated because the answer is
 * "this argument constrains nothing" and an unconstrained argument is only
 * safe while some OTHER rule is doing the constraining:
 *
 *   1. `gui/<digits>` — a domain, not a target.
 *   2. anything beginning with `-` — a flag.
 *   3. (vacuously) an argument that is not present at all.
 *
 * Each of the three is now covered for mutating verbs by the non-empty rule
 * in `testScopedSpawn`, which is where it belongs: whether an argv is safe
 * is a property of the whole argv, and this function only ever sees one
 * argument at a time.
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
  const referenced = new Set<string>();
  for (const arg of args.slice(1)) {
    if (arg.includes('system/'))
      throw new LaneRefused(
        `${JSON.stringify(arg)} addresses the system domain; this lane is ` +
          'confined to the caller’s own GUI domain',
      );
    const label = referencedLabel(arg);
    if (label === null) continue;
    referenced.add(label);
    if (mutatingVerb && !isTestScoped(label))
      throw new LaneRefused(
        `${verb} would affect ${JSON.stringify(label)}, which is not under ` +
          `${TEST_LABEL_PREFIX}`,
      );
    // The registered sentinel is the ONE exception, and only here: a
    // mutating verb aimed at it has already been refused two lines up,
    // because it is not under the test prefix and never can be.
    if (readOnlyVerb && !isOurs(label) && label !== sentinelLabel)
      throw new LaneRefused(
        `${verb} would read ${JSON.stringify(label)}, which is neither a ` +
          'label this project owns nor the registered F-120 sentinel',
      );
  }
  /*
   * STAGE 1b: A MUTATING VERB MUST REFERENCE SOMETHING (an ADDITIONAL
   * condition, not a replacement for the loop above).
   *
   * The loop is a per-argument rule, and every per-argument rule has the same
   * blind spot: it says nothing about an argv with no arguments it applies
   * to. `referencedLabel` answers `null` for a bare domain, for a flag and
   * for an argument that is not there at all, and `null` was `continue`. So
   * `['bootout', 'gui/501']` walked the loop, found nothing to object to, and
   * reached the delegate — and that argv is not a narrower operation than
   * booting out one agent, it is the widest one available: launchd reads a
   * domain with no service as the WHOLE DOMAIN, and removing a user's GUI
   * domain logs them out of the machine.
   *
   * Stated over the verb class rather than over `bootout`, because `bootout`
   * is not special — it is merely the member of the class whose domain-wide
   * form is the most expensive. A rule written as "if the verb is bootout"
   * is a rule that has to be re-derived for the fifth verb somebody adds.
   *
   * The legitimate shapes are unaffected, and that is the test of whether
   * this rule is the right one: `['bootstrap', 'gui/<uid>', '<tmp>/
   * sh.wemessage.test.x.plist']` references exactly one label, from the
   * plist's basename, so it still passes without being exempted from
   * anything. A guard a legitimate caller must be exempted from is the
   * wrong guard.
   *
   * Read-only verbs keep their old rule: `list` legitimately takes no target
   * and asking launchd a question with no target changes nothing.
   */
  if (mutatingVerb && referenced.size === 0)
    throw new LaneRefused(
      `${verb} references no label at all (argv ${JSON.stringify(args)}): a ` +
        'mutating verb whose arguments name no service addresses the whole ' +
        'GUI domain, which is every agent the operator is running and not ' +
        'one of ours',
    );
  // ONLY NOW. Everything above is decided without consulting the delegate,
  // so a lane with a real spawner behind it still creates no process on any
  // refusing path, and "refused" stays distinguishable from "not wired".
  if (delegate === null)
    throw new Error(
      'no spawner is installed in the launchd test lane (stage 1 installs none)',
    );
  // THE JOURNAL RECORDS ONLY WHAT SURVIVED. Appended here, one line below
  // the last refusal, so it is a list of the argvs that really did reach a
  // process — not a list of the argvs somebody tried. A row that asserts on
  // it is asserting what ran.
  journal.push(args);
  return await delegate(i);
}

/* ── the journal: exactly what reached a process, in order ────────────── */

const journal: string[][] = [];

/** Every argv this lane has permitted since the last reset, in order. */
export function laneJournal(): readonly (readonly string[])[] {
  return journal.map((a) => [...a]);
}

export function resetLaneJournal(): void {
  journal.length = 0;
}

/** The two inert subcommands, and the only way this lane asks a question. */
export const readOnly = {
  list: async (): Promise<ServiceManagerResult> =>
    await testScopedSpawn(laneInvocation(['list'])),
  print: async (label: LaunchAgentLabel): Promise<ServiceManagerResult> =>
    await testScopedSpawn(
      laneInvocation(['print', `gui/${String(laneUid())}/${label}`]),
    ),
  /**
   * Print the registered sentinel, or refuse.
   *
   * A NAMED OPERATION rather than a widened parameter on `print`. `print`
   * keeps its branded `LaunchAgentLabel`, so there is still no way to ask
   * this lane about an arbitrary foreign agent by passing a string; the one
   * foreign read the F-120 row needs has its own verb, and calling it without
   * a registration is a refusal rather than a no-op.
   */
  printSentinel: async (): Promise<ServiceManagerResult> => {
    if (sentinelLabel === null)
      throw new LaneRefused(
        'no F-120 sentinel is registered: the one foreign label this lane ' +
          'may read has to be named before it can be read',
      );
    return await testScopedSpawn(
      laneInvocation(['print', `gui/${String(laneUid())}/${sentinelLabel}`]),
    );
  },
};

/**
 * One `key = value` field out of a `print`, as a string, or `null`.
 *
 * `null` for "the job is not loaded" and `null` for "loaded but has no pid"
 * are deliberately the same answer, because the row that uses this compares
 * a BEFORE against an AFTER and both of those are states the sentinel could
 * legitimately be in for the whole run. What the row must catch is a CHANGE,
 * and a change between the two is a change either way round.
 */
export function printField(stdout: string, key: string): string | null {
  const re = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.+)$`,
    'm',
  );
  return re.exec(stdout)?.[1]?.trim() ?? null;
}

/** The three facts row 13 compares, as one value. */
export interface SentinelReading {
  readonly code: number;
  readonly pid: string | null;
  readonly runs: string | null;
}

export async function readSentinel(): Promise<SentinelReading> {
  const r = await readOnly.printSentinel();
  return {
    code: r.code,
    pid: printField(r.stdout, 'pid'),
    runs: printField(r.stdout, 'runs'),
  };
}

/**
 * Find the agent this run must leave alone, and register it.
 *
 * TWO SOURCES, in this order, and neither of them is a string in this
 * repository:
 *
 *  1. `WEMESSAGE_F120_SENTINEL_LABEL`. On the machine this project is
 *     developed on the honest subject is the agent supervising the session
 *     the tests are running inside — the one whose loss would take the run,
 *     the editor and the operator's login with it. That label is the single
 *     most dangerous string this project could contain, so it is not
 *     contained: it is passed in.
 *
 *  2. Failing that, the lowest-pid RUNNING label the service manager reports
 *     that is not one of ours. CI has no supervising assistant, and a row
 *     whose subject is absent is a row that passes because it did nothing.
 *     Lowest pid rather than first line, because `list` is not ordered and a
 *     subject chosen by ordering changes between runs.
 *
 * Registers both halves: the label (the one foreign thing that may be read)
 * and the pid (the one pid that may never be signalled).
 */
export async function resolveSentinel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly label: string; readonly pid: number | null }> {
  const named = env['WEMESSAGE_F120_SENTINEL_LABEL'];
  let label = named !== undefined && named.length > 0 ? named : null;
  let pid: number | null = null;

  if (label === null) {
    const listed = await readOnly.list();
    if (listed.code !== 0)
      throw new Error(
        `the service manager's list subcommand failed (exit ` +
          `${String(listed.code)}): ${listed.stderr.trim()}`,
      );
    let best: { label: string; pid: number } | null = null;
    for (const line of listed.stdout.split('\n')) {
      const cols = line.split('\t');
      const rawPid = (cols[0] ?? '').trim();
      const candidate = (cols[cols.length - 1] ?? '').trim();
      if (!/^\d+$/.test(rawPid)) continue; // '-' means loaded, not running
      if (candidate.length === 0 || isOurs(candidate)) continue;
      const n = Number(rawPid);
      if (best === null || n < best.pid) best = { label: candidate, pid: n };
    }
    if (best === null)
      throw new Error(
        'no running foreign launchd label was reported, so the F-120 row ' +
          'would have had no subject: refusing to run it vacuously',
      );
    label = best.label;
    pid = best.pid;
  }

  setLaneSentinelLabel(label);
  if (pid === null) {
    const printed = await readOnly.printSentinel();
    const raw = printField(printed.stdout, 'pid');
    pid = raw === null ? null : Number(raw);
  }
  setLaneSentinelPid(pid);
  return { label, pid };
}

/* ── the tripwire: the only contact this repository has with the real dir ─ */

/**
 * `ls -1 ~/Library/LaunchAgents | shasum`, and nothing else, ever.
 *
 * THE RETURN TYPE IS THE GUARD. This function enumerates the operator's real
 * agents directory exactly once per call and returns a HASH — never the
 * names, never a handle, never a path. There is therefore no way for a
 * caller to turn "prove nothing was written here" into "act on what is
 * here", which is the only reason it is safe for this file to look at that
 * directory at all.
 *
 * Computed with the same bytes `ls -1` prints and the same digest `shasum`
 * defaults to, so the value a human records at a terminal and the value a
 * row asserts are the same string.
 */
export function launchAgentsTripwire(): string {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  // A MISSING DIRECTORY IS A LISTING, AND IT IS THE EMPTY ONE.
  //
  // A fresh CI runner need not have this directory at all, and a tripwire
  // that THREW there would turn "there was nothing here to protect" into a
  // failed run. The empty listing hashes to a perfectly good value and the
  // property the row actually wants -- before equals after -- holds for it
  // exactly as well.
  //
  // Only absence is tolerated. Any other error still raises, because a
  // tripwire that swallowed a permissions error would be a tripwire that
  // reports success precisely when it has been blinded.
  let listing: string;
  try {
    listing = execFileSync('/bin/ls', ['-1', dir], { encoding: 'utf8' });
  } catch (e) {
    if (existsSync(dir)) throw e;
    listing = '';
  }
  return createHash('sha1').update(listing).digest('hex');
}

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

/**
 * How far up the process tree the ancestry walk goes before it gives up.
 *
 * BOUNDED, and not because the tree is deep — on this platform it is single
 * digits. An unbounded walk over a table this code did not build is a hang,
 * and a guard that can hang is a guard somebody deletes on a Friday. Running
 * off the end of the ceiling is treated as "unknown", not as "far enough".
 */
const ANCESTRY_MAX_HOPS = 64;

/**
 * Every visible process's parent, or `null` if the question went unanswered.
 *
 * ONE SPAWN, AND IT IS NOT THE SERVICE MANAGER. This platform has no `/proc`
 * and node exposes only `process.ppid` — the IMMEDIATE parent — so there is
 * no in-process route to a chain. The cost is one `ps` per `termOwnedDaemon`
 * call that gets far enough to need it, and it buys a single consistent
 * snapshot: walked hop by hop with one query each, the tree can change
 * underneath the walk and the chain that comes back never existed.
 *
 * Deliberately not a process-name matcher of any kind. A matcher that
 * searches for a name finds itself, which is a class of bug this project has
 * already paid for once. This asks for pids and parents and matches nothing.
 */
function processParentTable(): ReadonlyMap<number, number> | null {
  let out: string;
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const table = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    const pid = m?.[1];
    const ppid = m?.[2];
    if (pid === undefined || ppid === undefined) continue;
    table.set(Number(pid), Number(ppid));
  }
  return table.size === 0 ? null : table;
}

/**
 * The pids from `from` up to the root of its process tree, or `null`.
 *
 * `null` IS THE IMPORTANT RETURN VALUE, and the caller refuses on it.
 *
 * This is the same reasoning `pidLiveness` applies at
 * `packages/daemon/src/lock.ts:22`, run in the opposite direction, and the
 * two only look contradictory until the question is stated properly. That
 * comment resolves an unknown towards ALIVE, because leaving a lock alone
 * costs an operator one command while deleting a live process's lock
 * corrupts an audit chain nobody notices for a week. This resolves an
 * unknown towards DO NOT SIGNAL, because failing to stop a test daemon costs
 * a sweep while signalling a process we cannot place stops whatever is
 * supervising the machine. Both rules are the same rule: choose the outcome
 * whose failure is recoverable. They point different ways because which
 * outcome is recoverable is different.
 *
 * Both parameters are injectable so a row can prove the walk against a table
 * it wrote, rather than against whatever tree the run happens to have.
 */
export function laneAncestry(
  from: number = process.pid,
  table: ReadonlyMap<number, number> | null = processParentTable(),
): readonly number[] | null {
  if (table === null) return null;
  const chain: number[] = [from];
  let cur = from;
  for (let hop = 0; hop < ANCESTRY_MAX_HOPS; hop += 1) {
    if (cur <= 1) return chain;
    const parent = table.get(cur);
    if (parent === undefined) return null; // a link we cannot see
    if (chain.includes(parent)) return null; // a cycle: the table is wrong
    chain.push(parent);
    cur = parent;
  }
  return null; // deeper than the ceiling, which is unknown and not "fine"
}

export type TermOutcome = 'absent' | 'signalled';

export interface TermOptions {
  /** Injected so stage 1 proves the DECISION without sending anything. */
  readonly signal?: (pid: number, sig: NodeJS.Signals) => void;
  /**
   * Injected so a row can prove the ancestry refusal without depending on
   * the shape of the process tree it happens to be running inside.
   */
  readonly ancestry?: () => readonly number[] | null;
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

  /*
   * STAGE 1b: ANCESTRY, NOT PARENTAGE.
   *
   * Every check above this line is satisfied by a pid two hops up. Under
   * vitest the chain is worker → runner → package manager → whatever started
   * the run, so `process.ppid` excludes the least interesting member of it
   * and none of the rest. An unknown chain is refused rather than walked
   * past; see `laneAncestry` for why that is the safe direction here and the
   * unsafe one in `src/lock.ts:22`.
   */
  const chain = (options.ancestry ?? laneAncestry)();
  if (chain === null)
    throw new LaneRefused(
      `the parent chain above pid ${String(process.pid)} could not be read, ` +
        `so there is no way to know whether pid ${String(pid)} is supervising ` +
        'this test run: an ancestry we cannot determine is refused, not ' +
        'assumed clear',
    );
  if (chain.includes(pid))
    throw new LaneRefused(
      `pid ${String(pid)} is an ancestor of this process (chain ` +
        `${chain.join(' < ')}): a lock file naming a process this one is ` +
        'descended from is a lock file to disbelieve, not to act on',
    );

  const send =
    options.signal ??
    ((p: number, s: NodeJS.Signals) => {
      process.kill(p, s);
    });
  send(pid, 'SIGTERM');
  return 'signalled';
}

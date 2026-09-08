/**
 * s9 Sc3 stage 2 — THE FIRST FILE IN THIS PROJECT THAT RUNS A REAL LAUNCHD.
 *
 * Everything here goes through `test/helpers/launchd-lane.ts`, which is the
 * only test-side module permitted to name the service manager and the only
 * place the four refusals live. Nothing in this file spells a target by
 * hand; nothing here reaches a spawn that has not already been through the
 * lane's guard AND the production runner's guard, in that order.
 *
 * ── THE ROW EVERY LAUNCHD TEST FILE MUST COPY (row 13) ──────────────────
 *
 * `afterAll` below enumerates ONLY this run's own temp directory, boots out
 * ONLY labels it finds there, deletes that directory, and then asserts two
 * things about the world outside it: the operator's `~/Library/LaunchAgents`
 * listing hashes to the same value it did in `beforeAll`, and the registered
 * F-120 sentinel's `print` exit code, `pid =` and `runs =` are unchanged.
 * IF ANOTHER LAUNCHD SPEC IS EVER ADDED, IT COPIES THAT BLOCK VERBATIM.
 * A launchd test without it is a test that cannot say what it left behind.
 *
 * ── WHY THE PROBES ARE LATCHED OFF, AND WHY THAT IS NOT A DODGE ─────────
 *
 * `startDaemon` probes capabilities at boot, and the automation probe shells
 * out to the real scripting runner. A launchd job's environment is the
 * plist's `EnvironmentVariables` dict and nothing else, so — unlike
 * `main-lock.spec.ts`, which stubs PATH for a child it spawns itself — there
 * is no way to interpose on that shell-out from out here. Left alone, this
 * file would reach the operator's real Messages.app, which is exactly what
 * `test/arch.spec.ts` gate (b) exists to forbid; doing it by way of launchd
 * would be going around that gate rather than through it.
 *
 * The alternative considered and REJECTED was a `PATH` key in the plist
 * renderer. That is a production change with a real security surface — a
 * supervised daemon that resolves an arbitrary binary by that name — added
 * for no reason except to let a test fit through. A guard a legitimate
 * caller must be exempted from is the wrong guard, and the same logic
 * forbids inventing a hole so a test can pass.
 *
 * So this file pre-seeds `connection.userDisconnected`, which is a state the
 * product itself writes (POST /v1/disconnect) and reads at boot. That is
 * fixture work, not a bypass. It is PROVEN, not assumed, in
 * `doctor-probe-latch.spec.ts`: the real probe factory over a spy exec seam,
 * the real `startDaemon`, and an assertion the seam was never reached —
 * with a companion row that goes red when the latch is cleared.
 *
 * ── WHY LIVENESS IS /v1/health AND SUPERVISION COMES FROM LAUNCHD ───────
 *
 * The plan's row 8 asks for `/v1/doctor` reporting `supervisor: 'launchd'`.
 * Neither half survives contact with the tree. `DoctorReport` has no
 * `supervisor` field — that is Sc4's GREEN, and Sc4 depends on Sc3, so the
 * plan is circular there. And `/v1/doctor` IS `runDoctor`, so calling it
 * would shell out regardless of the latch (a row in the latch spec pins
 * that, deliberately, so this cannot be quietly "restored").
 *
 * What replaces it is stronger, not weaker. Supervision is read out of
 * LAUNCHD'S OWN VIEW of the job — the `WEMESSAGE_SUPERVISOR => launchd`
 * entry in `print`'s environment block — rather than out of a JSON field the
 * daemon writes about itself. A process claiming to be supervised is an
 * assertion; the supervisor listing it is a fact. Liveness is `/v1/health`,
 * which has no probe in it. DO NOT "RESTORE" THIS ROW TO THE PLAN'S FORM.
 */
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEvent, Clock } from '@wemessage/core';
import { SETTING_USER_DISCONNECTED } from '@wemessage/core';
import { SqliteStore } from '@wemessage/store';
import { createChatDb } from '@wemessage/fixtures';
import { asLaunchAgentLabel } from '../src/launchd/contract.js';
import { parseLaunchAgentPlist } from '../src/launchd/plist.js';
import { runServiceCli } from '../src/launchd/cli.js';
import {
  waitForLaunchdState,
  type ServiceDeps,
} from '../src/launchd/service.js';
import {
  installRealLaneSpawner,
  laneJournal,
  laneRun,
  launchAgentsTripwire,
  printField,
  readOnly,
  readSentinel,
  resetLaneJournal,
  resolveSentinel,
  sweepOrphans,
  sweepOwnDir,
  termOwnedDaemon,
  testScopedSpawn,
  type SentinelReading,
} from './helpers/launchd-lane.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(HERE, '..', 'dist', 'main.js');
const TEST_PREFIX = 'sh.wemessage.test.';

/** Covers `ExitTimeOut` (20s) with room, per the plan's bootout/bootstrap note. */
const SETTLE_BUDGET_MS = 25_000;
/** A `RunAtLoad` job goes through `xpcproxy` before it is `running`. */
const RUNNING_BUDGET_MS = 25_000;
/** ThrottleInterval is 1 in this plist; the restart still needs a moment. */
const RESTART_BUDGET_MS = 25_000;
const HTTP_BUDGET_MS = 20_000;

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const darwin = process.platform === 'darwin';

interface Bed {
  readonly dir: string;
  readonly la: string;
  readonly logs: string;
  readonly chatDb: string;
  readonly port: number;
}

let bed: Bed;
let label: string;
let plistPath: string;
let sentinelBefore: SentinelReading;
let tripwireBefore: string;
const audit: AuditEvent[] = [];

/**
 * ONE dependency object, shared by the CLI helper and the bounded poll.
 *
 * `ServiceDeps` requires `audit` because §1.8 puts the log before every
 * observable side effect, and a caller permitted to omit it would be a
 * caller permitted to act unlogged. `waitForLaunchdState` happens never to
 * reach that path -- it only ever prints -- but it takes the same type, and
 * sharing one value rather than writing a second literal is what makes the
 * row that polls and the row that installs demonstrably the same runner, the
 * same uid and the same sink, rather than two that merely look alike.
 */
/**
 * The uid every target in this file is built from, resolved once.
 *
 * A definite `number`, not `ServiceDeps['uid']`, which is optional and so
 * widens to `number | undefined` -- and under `exactOptionalPropertyTypes`
 * an optional-and-absent is not interchangeable with a
 * present-and-undefined. Reading it back off `deps` to pass somewhere that
 * requires a number is therefore a type error, and rightly: the value this
 * file needs is a uid, not "a uid or nothing".
 */
const LANE_UID: number = process.getuid?.() ?? 501;

const deps: ServiceDeps = {
  run: laneRun(testScopedSpawn),
  uid: LANE_UID,
  audit: (e: AuditEvent) => {
    audit.push(e);
  },
};

/* ── harness ──────────────────────────────────────────────────────────── */

async function freePort(): Promise<number> {
  // Bound to 0 and read back: never a fixed port, and never the 47100
  // default, which on a developer machine is very likely a real daemon.
  return await new Promise<number>((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => {
        ok(port);
      });
    });
  });
}

async function until<T>(
  what: string,
  budgetMs: number,
  attempt: () => Promise<T | null>,
): Promise<T> {
  // C-5: a bounded poll with a named deadline. Never a sleep-and-hope.
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const got = await attempt();
    if (got !== null) return got;
    if (Date.now() >= deadline)
      throw new Error(
        `timed out after ${String(budgetMs)}ms waiting for ${what}`,
      );
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

async function printLabel(): Promise<{ code: number; stdout: string }> {
  return await readOnly.print(asLaunchAgentLabel(label));
}

async function health(port: number): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/health`);
    return res.status;
  } catch {
    return null;
  }
}

function lockPid(): number | null {
  try {
    const raw = readFileSync(join(bed.dir, 'daemon.lock'), 'utf8').trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The last of whatever the supervised daemon wrote, for a failure message.
 *
 * `bed.logs` is inside the temp root `afterAll` removes, so this is only ever
 * readable from inside the row that failed. Bounded to the tail because the
 * point is the last thing the process said, and an unbounded dump into a test
 * reporter is a different kind of unreadable.
 */
function daemonLogTails(): string {
  const tail = (name: string): string => {
    try {
      const raw = readFileSync(join(bed.logs, name), 'utf8');
      const lines = raw.split('\n').filter((l) => l !== '');
      return lines.length === 0
        ? `${name}: (empty)`
        : `${name}:\n${lines.slice(-12).join('\n')}`;
    } catch {
      return `${name}: (not written)`;
    }
  };
  return [tail('daemon.out.log'), tail('daemon.err.log')].join('\n');
}

/**
 * The subject rows 9 and 10 inherit from row 8, or a named refusal.
 *
 * Rows 9 and 10 do not install anything. Their subject is the agent row 8
 * left running, so when row 8 goes red they do not test a different thing,
 * they test NOTHING, and the two extra reds they produce are noise on top of
 * the one real failure. Worse, row 10 would still spawn a real daemon and sit
 * on it for its full thirty-second timeout before reporting a `code` of 0 it
 * was never going to see, which is thirty seconds of a stray process nobody
 * asked for.
 *
 * So the precondition is stated once and THROWN, with a sentence naming which
 * witness disagreed. A throw and not `ctx.skip()`: a skip would let a row 8
 * that quietly stopped installing anything turn rows 9 and 10 green-by-
 * absence, which is the failure mode this whole file exists to catch. A
 * thrown row is still a red row. It just says why, and it says it in a second
 * instead of thirty.
 */
async function subjectPidOf(row: string): Promise<number> {
  const refuse = (why: string): never => {
    throw new Error(`${row} has no subject: ${why}`);
  };
  if (typeof label !== 'string' || label === '') {
    return refuse('row 8 never named a label');
  }
  const printed = await printLabel();
  if (printed.code !== 0) {
    return refuse(
      `row 8 left no loaded job (print exited ${String(printed.code)})`,
    );
  }
  const supervised = Number(printField(printed.stdout, 'pid'));
  if (!Number.isInteger(supervised)) {
    return refuse('the job is loaded but the service manager reports no pid');
  }
  const locked = lockPid();
  if (locked !== supervised) {
    return refuse(
      `the lock names ${String(locked)} and the service manager names ${String(supervised)}, so the daemon row 8 started is not the one running now`,
    );
  }
  return supervised;
}

async function cli(argv: readonly string[]): Promise<{
  code: number;
  out: string;
  err: string;
}> {
  let out = '';
  let err = '';
  const code = await runServiceCli(
    argv,
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    {
      uid: LANE_UID,
      appendAudit: deps.audit,
      // BOTH guards, in order: the production runner checks the assembled
      // target and the plist/label agreement, then the lane checks the verb
      // and every label the argv references, and only then does anything
      // reach the machine.
      run: deps.run,
      env: {
        WEMESSAGE_CHATDB: bed.chatDb,
        WEMESSAGE_LOGS_DIR: bed.logs,
        // Row 9 needs a restart inside a test's patience; §1.7's default of
        // 10 seconds would spend the budget waiting on launchd's throttle.
        WEMESSAGE_LAUNCHD_THROTTLE_INTERVAL: '1',
      },
    },
  );
  return { code, out, err };
}

function installArgv(): readonly string[] {
  return [
    'service',
    'install',
    '--dir',
    bed.dir,
    '--launch-agents-dir',
    bed.la,
    '--label-prefix',
    TEST_PREFIX,
    '--port',
    String(bed.port),
    '--json',
  ];
}

describe.skipIf(!darwin)(
  's9 Sc3 stage 2 rows 8-13: a real launch agent, start to finish',
  () => {
    beforeAll(async () => {
      // The real spawner, named once, in a function whose name says so.
      installRealLaneSpawner();

      // BEFORE ANYTHING ELSE: boot out anything of OURS still loaded.
      //
      // This row exists because of how this file came to be written. The run
      // that produced it was killed mid-flight, and the question "did that
      // leave a KeepAlive job respawning a daemon forever?" had to be
      // answered by hand at a terminal. A suite that can strand a job should
      // be the suite that notices, and the next run is the only moment it
      // reliably can: a process killed between `bootstrap` and `afterAll`
      // never gets to clean up after itself, by definition.
      //
      // This is the ONE place a label the service manager itself reported
      // reaches a mutating verb, so note what still holds it. `sweepOrphans`
      // filters on `isTestScoped`, which requires the trailing dot; the argv
      // then passes the lane's refusals and the runner's `TARGET_RE` exactly
      // like every other one. Nothing here is exempted from anything.
      await sweepOrphans();

      // Reset AFTER the sweep, so the journal describes this run's work
      // rather than the previous run's wreckage.
      resetLaneJournal();

      // The two things this run must leave exactly as it found them.
      tripwireBefore = launchAgentsTripwire();
      await resolveSentinel();
      sentinelBefore = await readSentinel();

      const root = mkdtempSync(join(tmpdir(), 'wm-lifecycle-'));
      const dir = join(root, 'config');
      const la = join(root, 'agents');
      const logs = join(root, 'logs');
      for (const d of [dir, la, logs]) mkdirSync(d, { recursive: true });
      const chatDb = join(root, 'chat.db');
      createChatDb(chatDb).close();
      bed = { dir, la, logs, chatDb, port: await freePort() };

      // THE LATCH, seeded before anything is installed. `startDaemon` reads
      // it and skips the capability probes; see this file's header and
      // `doctor-probe-latch.spec.ts` for why that is what makes running the
      // real daemon under launchd acceptable on this machine at all.
      const store = new SqliteStore({ dir, clock });
      try {
        store.setSetting(SETTING_USER_DISCONNECTED, '1');
      } finally {
        store.close();
      }
    }, 60_000);

    afterAll(async () => {
      // ── ROW 13. COPY THIS BLOCK INTO ANY NEW LAUNCHD SPEC. ──────────
      // Only our own directory is enumerated, only labels found in it are
      // booted out, and the two witnesses outside it are then compared.
      if (!darwin) return;
      try {
        if (bed !== undefined) {
          await sweepOwnDir(bed.la);
          rmSync(dirname(bed.dir), { recursive: true, force: true });
        }
      } finally {
        expect(launchAgentsTripwire()).toBe(tripwireBefore);
        expect(await readSentinel()).toEqual(sentinelBefore);
      }
    }, 60_000);

    it('the fixture actually latched the probes off before anything installs', async () => {
      // Addition to the plan, and the reason it is a ROW and not a comment:
      // if a later edit stops seeding the latch, the failure must be a red
      // test here and not a shell-out on the operator's desktop. Read back
      // from the store on disk, not from the variable that wrote it.
      const store = new SqliteStore({ dir: bed.dir, clock });
      try {
        expect(store.getSetting(SETTING_USER_DISCONNECTED)).toBe('1');
      } finally {
        store.close();
      }
      expect(existsSync(bed.chatDb)).toBe(true);
      // Nothing of ours is loaded yet: the rows below are about what THIS
      // run starts, so a leftover would make them lie.
      expect(readdirSync(bed.la)).toEqual([]);
    });

    it('row 8 — lifecycle (dev runtime, capability probes latched off)', async () => {
      const r = await cli(installArgv());
      expect(r.code).toBe(0);
      const json = JSON.parse(r.out) as {
        label: string;
        plistPath: string;
        bootstrapped: boolean;
      };
      label = json.label;
      plistPath = json.plistPath;
      expect(label.startsWith(TEST_PREFIX)).toBe(true);
      expect(json.bootstrapped).toBe(true);
      expect(plistPath).toBe(join(bed.la, `${label}.plist`));

      // THE DEV RUNTIME SUBSTITUTION, recorded in the row's own name: there
      // is no packaged app until Sc 6, so the agent runs this repository's
      // node against the built entrypoint, and `ELECTRON_RUN_AS_NODE` — a
      // variable that means nothing to a plain node — is absent.
      const plist = parseLaunchAgentPlist(readFileSync(plistPath, 'utf8'));
      expect(plist['ProgramArguments']).toEqual([process.execPath, MAIN]);
      const penv = plist['EnvironmentVariables'] as Record<string, string>;
      expect(penv['ELECTRON_RUN_AS_NODE']).toBeUndefined();
      expect(penv['WEMESSAGE_SUPERVISOR']).toBe('launchd');
      expect(penv['WEMESSAGE_DIR']).toBe(bed.dir);
      expect(penv['WEMESSAGE_CHATDB']).toBe(bed.chatDb);
      expect(penv['WEMESSAGE_PORT']).toBe(String(bed.port));
      expect(plist['ThrottleInterval']).toBe(1);
      // Nothing this run writes may land outside the temp root.
      expect(String(plist['StandardOutPath']).startsWith(bed.logs)).toBe(true);
      expect(String(plist['StandardErrorPath']).startsWith(bed.logs)).toBe(
        true,
      );

      // launchd reaches `running` through `xpcproxy`; a single print here
      // would be a flake, which is why this is a bounded poll.
      const printed = await waitForLaunchdState(
        asLaunchAgentLabel(label),
        (p) => p.code === 0 && /^\s*state\s*=\s*running\b/m.test(p.stdout),
        RUNNING_BUDGET_MS,
        deps,
      );
      expect(printed.code).toBe(0);

      // SUPERVISION, FROM THE SUPERVISOR. Not a field the daemon writes
      // about itself — the entry launchd keeps about the job it is running.
      expect(printed.stdout).toMatch(/WEMESSAGE_SUPERVISOR\s*=>\s*launchd/);

      // LIVENESS: /v1/health, which has no capability probe in it.
      //
      // Wrapped because `afterAll` deletes the bed, logs and all, so a
      // timeout here used to be the least diagnosable failure in the repo:
      // the one artefact that would say WHY the daemon never served was
      // removed microseconds after the message that asked. The rethrow keeps
      // the original deadline sentence, and appends what the daemon itself
      // wrote before it stopped. It does not widen the budget or retry.
      let status: number;
      try {
        status = await until(
          'the daemon to serve /v1/health',
          HTTP_BUDGET_MS,
          () => health(bed.port).then((s) => (s === 200 ? s : null)),
        );
      } catch (e) {
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}\n${daemonLogTails()}`,
        );
      }
      expect(status).toBe(200);

      // PID IDENTITY, two witnesses. launchd's `pid =` is what the
      // supervisor believes; `daemon.lock` is what the daemon wrote about
      // itself, and it writes that BEFORE it binds the port, so a lock and
      // a listening socket that agree are the same process. Deliberately
      // NOT taken from any process list.
      const launchdPid = Number(printField(printed.stdout, 'pid'));
      expect(Number.isInteger(launchdPid)).toBe(true);
      expect(
        await until('the lock file', HTTP_BUDGET_MS, async () => lockPid()),
      ).toBe(launchdPid);
    }, 90_000);

    it('row 9 — KeepAlive brings it back after a SIGTERM through the lane', async () => {
      // The two witnesses must already agree before this row sends a signal;
      // see `subjectPidOf`. It throws rather than asserting because a row 8
      // failure is not a row 9 finding.
      const pidBefore = await subjectPidOf('row 9');

      // THE ONLY REAL SIGNAL THIS SCENARIO SENDS. `termOwnedDaemon` requires
      // launchd and our own lock file to name the same pid, refuses this
      // process, any ancestor of it, and the registered sentinel. The pid
      // comes from `print`, never from `pgrep` and never from a process
      // list — a pid read out of `ps` is a number, and numbers get reused.
      await expect(
        termOwnedDaemon(bed.dir, asLaunchAgentLabel(label)),
      ).resolves.toBe('signalled');

      const pidAfter = await until(
        'launchd to restart the agent with a new pid',
        RESTART_BUDGET_MS,
        async () => {
          const p = await printLabel();
          if (p.code !== 0) return null;
          if (!/^\s*state\s*=\s*running\b/m.test(p.stdout)) return null;
          const n = Number(printField(p.stdout, 'pid'));
          return Number.isInteger(n) && n !== pidBefore ? n : null;
        },
      );
      expect(pidAfter).not.toBe(pidBefore);

      const status = await until(
        'the restarted daemon to serve',
        HTTP_BUDGET_MS,
        () => health(bed.port).then((s) => (s === 200 ? s : null)),
      );
      expect(status).toBe(200);
      // …and the restarted process wrote its own lock, so the two witnesses
      // agree again rather than the old one merely surviving.
      expect(
        await until('the new lock', HTTP_BUDGET_MS, async () => {
          const p = lockPid();
          return p === pidAfter ? p : null;
        }),
      ).toBe(pidAfter);
    }, 90_000);

    it('row 10 — a manual daemon in the same dir exits 1 with the launchd pid', async () => {
      // Checked BEFORE a second daemon is spawned, not after. Without this
      // the child below would run for its full thirty-second timeout against
      // a lock nobody holds, and report a `code` of 0 that says nothing about
      // the behaviour this row is named for.
      const supervised = await subjectPidOf('row 10');

      // Resolved BEFORE the promise, because a promise executor is not an
      // async function and cannot await. A second free port, not the
      // supervised one: this child must lose the race for the LOCK, which
      // is the thing row 10 is about, and a child that instead failed to
      // bind an occupied port would exit for a different reason and prove
      // nothing.
      const manualPort = await freePort();
      const res = await new Promise<{ code: number | null; stderr: string }>(
        (ok) => {
          const child = execFile(
            process.execPath,
            [MAIN],
            {
              env: {
                ...process.env,
                WEMESSAGE_DIR: bed.dir,
                WEMESSAGE_CHATDB: bed.chatDb,
                WEMESSAGE_PORT: String(manualPort),
              },
              timeout: 30_000,
            },
            (err, _stdout, stderr) => {
              ok({
                code: (err as { code?: number } | null)?.code ?? 0,
                stderr,
              });
            },
          );
          void child;
        },
      );
      expect(res.code).toBe(1);
      // Exactly the taxonomy's sentence, and the pid is the SUPERVISED one:
      // the lock names the process launchd is running, so a second start is
      // told which process to go look at.
      expect(res.stderr).toBe(`already running (pid ${String(supervised)})\n`);
    }, 90_000);

    it('row 11 — status reports the six fields, uninstall removes and audits', async () => {
      const before = await cli([
        'service',
        'status',
        '--dir',
        bed.dir,
        '--json',
      ]);
      expect(before.code).toBe(0);
      const s = JSON.parse(before.out) as Record<string, unknown>;
      expect(Object.keys(s).sort()).toEqual([
        'installed',
        'label',
        'lastExitStatus',
        'pid',
        'plistPath',
        'running',
      ]);
      expect(s['installed']).toBe(true);
      expect(s['running']).toBe(true);
      expect(s['label']).toBe(label);
      expect(s['plistPath']).toBe(plistPath);
      expect(typeof s['pid']).toBe('number');

      audit.length = 0;
      const un = await cli([
        'service',
        'uninstall',
        '--dir',
        bed.dir,
        '--json',
      ]);
      expect(un.code).toBe(0);
      expect(existsSync(plistPath)).toBe(false);
      expect(audit.map((e) => e.type)).toContain('service.uninstalled');

      // THE BOOTOUT/BOOTSTRAP RACE. `bootout` returns before launchd has
      // finished tearing the job down, and a `bootstrap` in that window
      // fails with "Input/output error". Anything that re-installs this
      // label must first poll `print` to non-zero — bounded, never a sleep,
      // with a deadline that covers `ExitTimeOut`.
      const gone = await until(
        'launchd to forget the label',
        SETTLE_BUDGET_MS,
        async () => {
          const p = await printLabel();
          return p.code !== 0 ? p.code : null;
        },
      );
      expect(gone).not.toBe(0);

      const after = await cli([
        'service',
        'status',
        '--dir',
        bed.dir,
        '--json',
      ]);
      const s2 = JSON.parse(after.out) as Record<string, unknown>;
      expect(s2['installed']).toBe(false);
      expect(s2['running']).toBe(false);
    }, 90_000);

    it('every invocation this file made went through the lane, and is on the record', () => {
      // The journal records only argvs that survived every refusal, so it
      // is a list of what actually reached a process rather than a list of
      // what something tried.
      //
      // THE MUTATING SET, STATED EXACTLY -- and the reason it is an equality
      // is worth leaving on the record, because the first version of this
      // row was wrong in an instructive way. It asserted two properties:
      // nothing mutating names a label outside the test prefix, and no
      // mutating verb is ever handed a bare domain. The second is false of
      // correct input. `bootstrap` takes `[verb, domain, path]`, so the
      // domain is a legitimate positional argument there, and a blanket
      // "no bare domain in any position" refuses the one right invocation
      // this file makes.
      //
      // That is the same shape as the stage 1b hole seen from the other
      // side. The property that matters is not "no argument looks like a
      // domain" but "the argv references at least one label, and every
      // label it references is ours" -- which is the lane's refusal, stated
      // over argv positions it understands. A spec property merely adjacent
      // to a guard is worse than none: it fails on good input, and it
      // teaches the next reader to widen it.
      //
      // So this states the whole mutating set, in order, by value. An
      // equality cannot be satisfied by an argv that merely looks plausible,
      // and any new launchctl mutation this file learns to make has to be
      // written down here before it can pass.
      const j = laneJournal();
      expect(j.length).toBeGreaterThan(0);

      const uid = String(LANE_UID);
      const mutating = j
        .filter((a) => a[0] !== 'list' && a[0] !== 'print')
        .map((a) => [...a]);
      expect(mutating).toEqual([
        ['bootstrap', `gui/${uid}`, join(bed.la, `${label}.plist`)],
        ['bootout', `gui/${uid}/${label}`],
      ]);

      // Non-vacuity for the equality above, and the prefix property the
      // original row was reaching for, stated where it is actually true.
      expect(label.startsWith(TEST_PREFIX)).toBe(true);

      // Nothing this file did used a verb outside the four it is allowed.
      for (const argv of j)
        expect(['list', 'print', 'bootstrap', 'bootout']).toContain(argv[0]);
    });
  },
);

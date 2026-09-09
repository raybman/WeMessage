// Foreground dev entrypoint (F-1: no launchd packaging in S1). Boot order
// recovery -> watcher -> listen per §2.5; live FSEvents + clock-skew wake
// (F-9). The demo script (spec 4.2) runs this via WEMESSAGE_DIR/PORT.
import { homedir, release as osRelease } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Clock } from '@wemessage/core';
import { systemActor } from '@wemessage/core';
import {
  createClockSkewWakeSignal,
  createNodeFsWatcher,
} from '@wemessage/ingest';
import { openDaemonStore } from './open-store.js';
import { AppleScriptSendBackend, type ExecFn } from '@wemessage/sendkit';
import { createAuditSink } from './audit-sink.js';
import { startDaemon } from './daemon.js';
import { createRealDoctorProbes } from './doctor.js';
import { realServiceManagerRun } from './launchd/launchctl.js';
import { DAEMON_ERROR_SPECS, isDaemonError } from './errors.js';
import { acquireInstanceLock, staleReclaimEvent } from './lock.js';

// Real execFile-backed ExecFn (s3-execution Scenario 7): deliberately
// generic (cmd/args are caller-supplied) so this file names no specific
// AppleScript-runner binary — that literal stays confined to
// packages/sendkit/src per test/arch.spec.ts's S3 production-source gate.
// This is just the shell-out primitive sendkit's probes are injected with.
const execFileAsync = promisify(execFile);
const realExec: ExecFn = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
};

const Env = z.object({
  // R7 rename map: WEMESSAGE_DIR overrides the config dir (tests/dev).
  WEMESSAGE_DIR: z.string().min(1).optional(),
  // §2.6: local API defaults to 127.0.0.1:47100.
  WEMESSAGE_PORT: z.coerce.number().int().min(1).max(65535).default(47100),
  // Live tail target; overridable for demos against a fixture DB.
  WEMESSAGE_CHATDB: z.string().min(1).optional(),
  /*
   * WHO IS SUPERVISING THIS PROCESS (s9 Sc4).
   *
   * Written into the plist by `wemessaged service install`, and by the app
   * when it spawns the daemon itself. Absent means nobody is: a developer
   * ran `node dist/main.js` by hand, and a disconnect has no job to unload.
   * Absent is therefore the SAFE reading, which is why there is no default
   * here that would make an unsupervised process claim supervision.
   */
  WEMESSAGE_SUPERVISOR: z.enum(['launchd', 'app']).optional(),
  /*
   * The label of the job launchd is running us as.
   *
   * DELIBERATELY UNVALIDATED AT BOOT, and this is the whole reason it is a
   * bare `string` next to an `enum` that is not. The plist that carries
   * this variable also carries `KeepAlive`, so a process that exits on a
   * malformed label does not fail once: launchd restarts it, it reads the
   * same bad label, and it exits again, forever. A boot-time `refine` here
   * would convert a typo in one plist string into a throttled crash loop
   * that survives reboots and takes a `bootout` to stop.
   *
   * The label is needed at exactly one moment -- a disconnect that wants to
   * unload the job -- and that moment already has somewhere to put a
   * refusal: a FAILED STEP in the disconnect report, which the operator
   * reads. So validation happens there, where being wrong is a sentence on
   * a screen instead of a loop in the supervisor.
   */
  WEMESSAGE_LAUNCHD_LABEL: z.string().optional(),
});

const env = Env.parse(process.env);
const configDir =
  env.WEMESSAGE_DIR ??
  join(homedir(), 'Library', 'Application Support', 'WeMessage');
const chatDbPath =
  env.WEMESSAGE_CHATDB ?? join(homedir(), 'Library', 'Messages', 'chat.db');

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/**
 * The one place a taxonomy error becomes a process exit (s9 Sc2, C-6).
 *
 * One line on stderr, nothing on stdout, and the exit status the spec for
 * that code names. Anything NOT in the taxonomy is rethrown with its stack
 * intact: a defect deserves a stack trace, and a condition we planned for
 * deserves a sentence. Collapsing the two is how "already running" ends up
 * looking like a crash, and how a crash ends up looking routine.
 */
function refuseToStart(err: unknown): never {
  if (!isDaemonError(err)) throw err;
  process.stderr.write(`${err.message}\n`);
  process.exit(DAEMON_ERROR_SPECS[err.code].exitCode);
}

/*
 * BOOT ORDER (§2.5, revised by s9 Sc2): lock -> dependencies -> listen.
 *
 * The lock comes first because it is what establishes that this process owns
 * the directory, and everything after it writes to things that ownership
 * covers: the store, the tail cursor, the audit chain. Before this scenario
 * the second daemon in a directory ran all of that and then died inside
 * `listen` on EADDRINUSE — exit 1, so it looked handled, having already
 * opened and recovered a database belonging to another process.
 *
 * The port is checked inside the acquire, after the lock is held, so a bound
 * port is reported as a bound port instead of as a running daemon. The two
 * have different fixes and only one of them is "stop the other one".
 */
const lock = await acquireInstanceLock({
  dir: configDir,
  port: env.WEMESSAGE_PORT,
  onStaleReclaim: (stalePid) => {
    // §1.8, and the reason this callback exists at all: the row goes down
    // BEFORE the stale file comes off disk. A store opened here and closed
    // again is the whole cost, paid once, only on the crash-recovery path.
    const store = openDaemonStore({ dir: configDir, clock });
    try {
      createAuditSink({ store, clock }).append(
        staleReclaimEvent(stalePid),
        systemActor('recovery'),
      );
    } finally {
      store.close();
    }
  },
}).catch(refuseToStart);

const wake = createClockSkewWakeSignal(clock);
wake.start();

const daemon = await startDaemon({
  configDir,
  chatDbPath,
  clock,
  watcher: createNodeFsWatcher(),
  wake,
  port: env.WEMESSAGE_PORT,
  doctorProbes: createRealDoctorProbes({
    osRelease,
    chatDbPath,
    exec: realExec,
  }),
  // s3-execution Scenario 8: the only production SendBackend — the real
  // AppleScript runner via the injected execFile primitive above (never a
  // bespoke scripting-runner literal in this file; that stays confined to
  // packages/sendkit/src per test/arch.spec.ts's gate (a)).
  backend: new AppleScriptSendBackend({ exec: realExec }),
  backendName: 'applescript',
  /*
   * s9 Sc4: WHO IS SUPERVISING US, read from the environment the supervisor
   * itself set. `WEMESSAGE_SUPERVISOR` is written into the plist by
   * `wemessaged service install`, so a daemon that launchd started says
   * `launchd` because launchd told it to, not because it guessed from its
   * own ppid or argv.
   *
   * The runner is attached ONLY under `launchd`. Under `app` or absent
   * there is no job to unload, and handing the disconnect a working
   * launchctl runner it has no legal reason to call would be arming
   * something for no purpose.
   */
  supervision: {
    supervisor: env.WEMESSAGE_SUPERVISOR ?? 'none',
    label: env.WEMESSAGE_LAUNCHD_LABEL ?? null,
    run: env.WEMESSAGE_SUPERVISOR === 'launchd' ? realServiceManagerRun : null,
    // The same directory the lock, the store and the audit chain live in;
    // `service install` wrote `service.json` here, and phase A reads it
    // BEFORE a purge can delete it.
    serviceDir: configDir,
  },
  onUnloadError: (e: unknown) => {
    // After the response. No reply to fail, no store to append to: the
    // process log is the only reader left.
    console.error('wemessage daemon: unload request failed:', e);
  },
  onError: (error) => {
    console.error('wemessage daemon: pipeline error (loop continues):', error);
  },
})
  .catch((err: unknown) => {
    // The lock is ours and this process is not going to use it. A lock left
    // behind by a start that failed names a pid that has already exited, and
    // the next honest start would report a holder nobody can find.
    lock.release();
    throw err;
  })
  // A SECOND catch, so the release above stays unconditional. Everything
  // `startDaemon` raises used to arrive here as an unhandled rejection and
  // print a stack, the taxonomy included: `refuseToStart` rethrows anything
  // outside it, so a defect keeps exactly the trace it has today.
  .catch(refuseToStart);

/*
 * BEFORE THE READINESS LINE, NOT AFTER IT.
 *
 * This used to sit below the `listening on …` log, and under a saturated
 * machine `main-lock.spec.ts` row 7 caught what that costs: the test waits
 * for that exact line on stdout, sends SIGTERM, and got back an exit code of
 * `null` with the lock still on disk. `null` means the default disposition
 * killed the process, which means the signal landed in the window between
 * announcing readiness and being able to act on it. Node runs those
 * statements back to back, so the window is normally microseconds wide; a
 * descheduled process widens it, and launchd under `KeepAlive` will
 * eventually find it.
 *
 * The ordering rule is the general one, not a test accommodation: a process
 * must not tell the world it is up until it can be told to stop. Everything
 * `shutdown` closes over (`wake`, `daemon`, `lock`) already exists here, so
 * there is nothing to trade for it.
 */
const shutdown = async (): Promise<void> => {
  wake.stop();
  await daemon.stop();
  // Last, and after the server is down: while the lock is on disk this
  // directory has an owner, and it should keep having one until there is
  // nothing left running to own it.
  lock.release();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

if (daemon.server.token === null) {
  console.error(
    `wemessage daemon: NO AUTH TOKEN (could not read or create ${configDir}); serving 503 on all routes (fail closed)`,
  );
} else {
  console.log(`wemessage daemon: listening on 127.0.0.1:${daemon.port}`);
  console.log(`wemessage daemon: tailing ${chatDbPath} (read-only)`);
}

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
import { SqliteStore } from '@wemessage/store';
import { AppleScriptSendBackend, type ExecFn } from '@wemessage/sendkit';
import { createAuditSink } from './audit-sink.js';
import { startDaemon } from './daemon.js';
import { createRealDoctorProbes } from './doctor.js';
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
    const store = new SqliteStore({ dir: configDir, clock });
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
  onError: (error) => {
    console.error('wemessage daemon: pipeline error (loop continues):', error);
  },
}).catch((err: unknown) => {
  // The lock is ours and this process is not going to use it. A lock left
  // behind by a start that failed names a pid that has already exited, and
  // the next honest start would report a holder nobody can find.
  lock.release();
  throw err;
});

if (daemon.server.token === null) {
  console.error(
    `wemessage daemon: NO AUTH TOKEN (could not read or create ${configDir}); serving 503 on all routes (fail closed)`,
  );
} else {
  console.log(`wemessage daemon: listening on 127.0.0.1:${daemon.port}`);
  console.log(`wemessage daemon: tailing ${chatDbPath} (read-only)`);
}

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

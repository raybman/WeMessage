/**
 * The instance lock: one daemon per directory (plan.md §2.5).
 *
 * WHAT THE LOCK IS FOR. A wemessage daemon owns a SQLite store, a tail cursor
 * into a chat database, and a hash-chained audit log that assumes a single
 * writer. Two of them in one directory is not a noisy failure — it is a quiet
 * one. Both tail, both mirror, both append, and the chain that exists to make
 * the record tamper-evident records two interleaved histories as one.
 *
 * WHAT MAKES IT HARD. A lock file is trivial (`open` with `wx`, which is
 * atomic: it creates or it fails, never both). Deciding what a lock file that
 * ALREADY exists means is not, because the process that wrote it may have been
 * stopped without warning, and a lock nobody can reclaim turns one crash into
 * a machine that never starts again.
 *
 * So the file names its holder and the holder is probed with the null signal:
 *
 *     process.kill(pid, 0) throws ESRCH   no such process   -> DEAD
 *     process.kill(pid, 0) throws EPERM   exists, not ours  -> ALIVE
 *     process.kill(pid, 0) returns        exists, ours      -> ALIVE
 *
 * Two of the three outcomes mean alive. The one that catches people is EPERM,
 * because it arrives as a thrown error and reads like "I could not reach it",
 * so it falls naturally into the same `catch` as ESRCH under a conclusion of
 * "gone". It is the opposite: EPERM is the strongest evidence available that
 * the process is there, because the kernel had to find it in order to refuse.
 * Read it as dead and this daemon deletes a live process's lock and starts
 * beside it. `pidLiveness` therefore treats DEAD as the narrow, named case and
 * everything else — including errnos this code has never seen — as alive.
 *
 * Alive-by-default is the right bias in one direction only, and it is this
 * one: refusing to start when we should have started is an operator reading
 * one line and running one command, and starting when we should have refused
 * is a corrupted audit chain nobody notices for a week.
 */
import { createServer } from 'node:net';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AuditEvent } from '@wemessage/core';
import {
  AlreadyRunningError,
  LockDirUnwritableError,
  PortInUseError,
} from './errors.js';

/** plan.md §2.5. The name is part of the contract: a second instance looks here. */
export const LOCK_FILENAME = 'daemon.lock';

/**
 * How many times we will reclaim a stale lock in one acquire before deciding
 * that whatever keeps recreating it is a peer rather than a corpse (C-10).
 * In practice the loop runs once; the ceiling exists so a pathological race
 * cannot spin here forever.
 */
const MAX_RECLAIMS = 5;

export type Liveness = 'alive' | 'dead';

/** The signalling primitive, injectable so an errno can be exercised directly. */
export type SignalProbe = (pid: number, signal: 0) => void;

const realSignal: SignalProbe = (pid, signal) => {
  process.kill(pid, signal);
};

/**
 * Is the process named by `pid` still there?
 *
 * See the header. DEAD is exactly one errno; everything else is alive.
 */
export function pidLiveness(
  pid: number,
  signal: SignalProbe = realSignal,
): Liveness {
  try {
    signal(pid, 0);
    // Returned cleanly: the process exists and we are allowed to signal it.
    return 'alive';
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    // ESRCH — and ONLY ESRCH — means there is no such process. EPERM means
    // there is one and it is not ours; an errno we do not recognise means we
    // do not know, and "leave the lock alone" is the safe answer to both.
    if (errno === 'ESRCH') return 'dead';
    return 'alive';
  }
}

/**
 * The pid a lock file names, or `null` if it does not name one.
 *
 * Truncated, empty and garbage files are all `null` rather than an error: a
 * lock file is written by a process that may have been stopped between `open`
 * and `write`, so a partial one is an ordinary outcome of a crash, not a
 * corruption to report. `0` and negatives are rejected too — they are not pids
 * any process can have, and passing them to a signal call means something else
 * entirely (`kill(0, …)` addresses a whole process group).
 */
function parsePid(body: string): number | null {
  const trimmed = body.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed)) return null;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) ? pid : null;
}

/** The C-7 audit event for a reclaim. One definition, checked against the union. */
export function staleReclaimEvent(pid: number | null): AuditEvent {
  return { type: 'daemon.lock.stale_reclaimed', pid };
}

export interface InstanceLock {
  /** Absolute path of the lock file this process holds. */
  readonly path: string;
  /** The pid written into it. */
  readonly pid: number;
  /** Remove it, but only while it still names us. Idempotent. */
  release(): void;
}

export interface AcquireInstanceLockOptions {
  /** The directory the daemon owns; the lock goes in it, never anywhere else. */
  readonly dir: string;
  /** The local API port, checked after the lock is held (see below). */
  readonly port: number;
  /** The pid to claim with. Defaults to this process. */
  readonly pid?: number;
  /** Liveness verdict for a holder pid. Defaults to the real signal probe. */
  readonly liveness?: (pid: number) => Liveness;
  /** Is this port already bound on the loopback? Defaults to a real bind. */
  readonly probePort?: (port: number) => Promise<boolean>;
  /**
   * Called with the stale pid (or `null`) BEFORE the stale file is removed.
   * §1.8: the log is the record. After the unlink there is no evidence a
   * previous daemon was ever here except whatever this wrote down.
   */
  readonly onStaleReclaim?: (pid: number | null) => void;
}

/** Default port probe: bind it, and let the kernel answer. */
async function bindProbe(port: number): Promise<boolean> {
  return await new Promise<boolean>((ok, fail) => {
    const probe = createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') ok(true);
      else fail(err);
    });
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => {
        ok(false);
      });
    });
  });
}

function readHolder(path: string): number | null | 'gone' {
  try {
    return parsePid(readFileSync(path, 'utf8'));
  } catch (err) {
    // It was reclaimed by somebody between our failed create and this read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw err;
  }
}

/**
 * Take the instance lock for `dir`, or explain why not.
 *
 * ORDER MATTERS, and it is: lock first, port second.
 *
 * Lock first because the lock is the thing that says who owns the directory,
 * and a daemon that binds a port before establishing that is a daemon that has
 * already opened the store it may not be entitled to.
 *
 * Port second because a held lock and a bound port are different failures with
 * different fixes, and the only way to tell them apart is to establish the
 * first before testing the second. The cost of that ordering is the case this
 * function must not get wrong: if the port check fails, the lock we just took
 * has to come back off. A dangling lock naming a pid that exited seconds ago
 * makes the NEXT honest start report "already running" about a ghost.
 */
export async function acquireInstanceLock(
  opts: AcquireInstanceLockOptions,
): Promise<InstanceLock> {
  const pid = opts.pid ?? process.pid;
  const liveness = opts.liveness ?? ((p: number) => pidLiveness(p));
  const probePort = opts.probePort ?? bindProbe;
  const path = join(opts.dir, LOCK_FILENAME);

  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch (err) {
    throw new LockDirUnwritableError(opts.dir, err);
  }

  let lastHolder: number | null = null;
  let taken = false;
  for (let reclaims = 0; reclaims <= MAX_RECLAIMS && !taken;) {
    let fd: number;
    try {
      // 'wx' is the whole mutual exclusion: create-or-fail, atomically, with
      // no window between the check and the create for a peer to slip into.
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno !== 'EEXIST') {
        // EACCES, EPERM, EROFS, ENOENT on a vanished parent: all of them mean
        // this directory will not hold the lock. One error, naming the dir.
        throw new LockDirUnwritableError(opts.dir, err);
      }
      const holder = readHolder(path);
      if (holder === 'gone') continue;
      lastHolder = holder;
      if (holder !== null && liveness(holder) === 'alive')
        throw new AlreadyRunningError(holder);
      // Stale. Write the row down first (§1.8), then take the file off disk.
      opts.onStaleReclaim?.(holder);
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new LockDirUnwritableError(opts.dir, unlinkErr);
      }
      reclaims += 1;
      continue;
    }
    try {
      writeSync(fd, `${String(pid)}\n`);
    } finally {
      closeSync(fd);
    }
    taken = true;
  }

  if (!taken) {
    // The ceiling. Something recreates this file faster than we reclaim it,
    // which is a peer racing us rather than a corpse; refusing is the same
    // answer as a live holder, and `lastHolder` is the best name we have for
    // it. Unreachable outside a pathological race.
    throw new AlreadyRunningError(lastHolder ?? 0);
  }

  const lock: InstanceLock = {
    path,
    pid,
    release() {
      try {
        // Only if it is still OURS. By the time a shutdown path runs, a
        // successor may have reclaimed this file, and deleting it then would
        // hand the directory to a third process.
        if (parsePid(readFileSync(path, 'utf8')) !== pid) return;
        unlinkSync(path);
      } catch {
        // Already gone. Release is called from both the failure path and the
        // shutdown path, and a throw here would turn a clean stop into a
        // non-zero exit.
      }
    },
  };

  if (await probePort(opts.port)) {
    lock.release();
    throw new PortInUseError(opts.port);
  }
  return lock;
}

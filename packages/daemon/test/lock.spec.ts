/**
 * s9 Sc2 — single instance: `daemon.lock`, and the three answers a liveness
 * probe can give.
 *
 * WHY THIS FILE IS WORTH READING BEFORE THE CODE IT TESTS.
 *
 * The whole scenario turns on one system call with three outcomes:
 *
 *   process.kill(pid, 0) throws ESRCH   no such process   -> DEAD
 *   process.kill(pid, 0) throws EPERM   exists, not ours  -> ALIVE
 *   process.kill(pid, 0) returns        exists, ours      -> ALIVE
 *
 * Two of the three mean ALIVE, and the one that trips people is EPERM. It
 * reads like a failure — "I could not signal it" — and the natural mistake is
 * to fold it in with ESRCH under a `catch` that concludes "gone". It is the
 * opposite: EPERM is the strongest possible evidence the process is there,
 * because the kernel had to find it before it could refuse.
 *
 * What that mistake costs: the lock file names a live pid, this daemon reads
 * EPERM as dead, deletes somebody else's lock, and takes it. Two daemons then
 * run against one SQLite store and one chat database, both tailing, both
 * appending to a hash-chained audit log that assumes a single writer. Nothing
 * crashes. The rows interleave. That is the named tooth for this scenario,
 * and pid 1 is the row it has to survive: the first process on the machine is
 * owned by root, is unquestionably alive, and answers EPERM to every user on
 * the system.
 *
 * So the probe is exercised against REAL pids, not only an injected fake:
 * this process (returns), pid 1 (EPERM), and the pid of a child that has
 * already exited (ESRCH). An injected `liveness` would let the tooth's
 * mutation pass by construction, since the mutation is in the code that maps
 * a caught error to a verdict.
 *
 * Rows here: 1-5 and 9 of the scenario, plus the C-6 taxonomy rows. Rows 6,
 * 7 and 8 need a real process and live in `main-lock.spec.ts`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '@wemessage/core';
import {
  DAEMON_ERROR_CODES,
  DAEMON_ERROR_SPECS,
  AlreadyRunningError,
  LockDirUnwritableError,
  PortInUseError,
  type DaemonErrorCode,
} from '../src/errors.js';
import {
  LOCK_FILENAME,
  acquireInstanceLock,
  pidLiveness,
  staleReclaimEvent,
} from '../src/lock.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wemessage-lock-'));
  dirs.push(dir);
  return dir;
}

const released: Array<{ release: () => void }> = [];
afterEach(() => {
  for (const lock of released.splice(0)) {
    try {
      lock.release();
    } catch {
      /* a row may have released already; teardown is best-effort */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* the dir may already be gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A free TCP port, released before the caller uses it. */
async function freePort(): Promise<number> {
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

/** A port this test holds open for the duration of `body`. */
async function withBoundPort<T>(
  body: (port: number) => Promise<T>,
): Promise<T> {
  const holder = createServer();
  const port = await new Promise<number>((ok, fail) => {
    holder.on('error', fail);
    holder.listen(0, '127.0.0.1', () => {
      const addr = holder.address();
      ok(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  try {
    return await body(port);
  } finally {
    await new Promise<void>((ok) => {
      holder.close(() => {
        ok();
      });
    });
  }
}

/** The pid of a child that has already exited: guaranteed ESRCH, briefly. */
function deadPid(): number {
  const done = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  expect(done.status).toBe(0);
  expect(done.pid).toBeTypeOf('number');
  return done.pid as number;
}

async function acquire(
  dir: string,
  overrides: Partial<Parameters<typeof acquireInstanceLock>[0]> = {},
): ReturnType<typeof acquireInstanceLock> {
  const lock = await acquireInstanceLock({
    dir,
    port: await freePort(),
    ...overrides,
  });
  released.push(lock);
  return lock;
}

describe('s9 Sc2 row 9: the lock file is named and placed by the plan', () => {
  it('is exactly `daemon.lock`, in the directory it is given', async () => {
    // plan.md §2.5 names the file. A daemon that took `.lock`, or put it in
    // a temp directory, would pass every other row here and would not be the
    // file a second instance looks for.
    expect(LOCK_FILENAME).toBe('daemon.lock');
    const dir = tempDir();
    const lock = await acquire(dir);
    expect(lock.path).toBe(join(dir, 'daemon.lock'));
    expect(readdirSync(dir)).toContain('daemon.lock');
  });

  it('adds no table and no index: the store migrations are untouched', () => {
    // C-8. A lock is a file, not a row, and a scenario that reached for a
    // `instances` table would be building a second answer to "who is
    // running" that outlives the process it describes.
    const diff = execFileSync(
      'git',
      ['diff', '--name-only', 'HEAD', '--', 'packages/store/migrations'],
      { cwd: REPO, encoding: 'utf8' },
    ).trim();
    expect(diff).toBe('');
    // Non-vacuity: the directory exists and has migrations in it, so an
    // empty diff is a fact about this commit rather than about the path.
    expect(
      readdirSync(join(REPO, 'packages/store/migrations')).length,
    ).toBeGreaterThan(0);
  });
});

describe('s9 Sc2 rows 1 and 2: `wx`, and who is allowed to be alive', () => {
  it('row 1: the first acquire creates the file and writes its own pid', async () => {
    const dir = tempDir();
    const lock = await acquire(dir);
    expect(existsSync(lock.path)).toBe(true);
    expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid));
    expect(lock.pid).toBe(process.pid);
  });

  it('row 1: `wx` means the second acquire does not overwrite the first', async () => {
    const dir = tempDir();
    const first = await acquire(dir);
    const before = readFileSync(first.path, 'utf8');
    await expect(acquire(dir)).rejects.toThrow(AlreadyRunningError);
    // The refusal left the incumbent's file byte-identical. A lock that is
    // rewritten on the way to reporting "already running" has already lost.
    expect(readFileSync(first.path, 'utf8')).toBe(before);
  });

  it('row 2: the error names the holder and carries the taxonomy code', async () => {
    const dir = tempDir();
    await acquire(dir);
    let caught: unknown;
    try {
      await acquire(dir);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AlreadyRunningError);
    const err = caught as AlreadyRunningError;
    expect(err.code).toBe('ALREADY_RUNNING');
    expect(err.pid).toBe(process.pid);
    expect(err.message).toBe(`already running (pid ${String(process.pid)})`);
  });

  /*
   * The sub-case the tooth has to bite. Everything above holds a lock whose
   * pid is OURS, and `process.kill(ourPid, 0)` returns — the easy third of
   * the three outcomes. This row hands the daemon a holder it is not allowed
   * to signal at all.
   */
  it.skipIf(IS_ROOT)(
    'row 2: a holder this process may not signal is ALIVE, not stale',
    async () => {
      const dir = tempDir();
      const lockPath = join(dir, LOCK_FILENAME);
      // pid 1 is the first process on the machine: owned by root, running
      // for as long as the machine is, and `process.kill(1, 0)` answers
      // EPERM to every unprivileged user. Read that as "dead" and this
      // daemon deletes a live process's lock.
      writeFileSync(lockPath, '1\n');
      let caught: unknown;
      try {
        await acquire(dir);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AlreadyRunningError);
      expect((caught as AlreadyRunningError).pid).toBe(1);
      expect((caught as AlreadyRunningError).message).toBe(
        'already running (pid 1)',
      );
      // And the file is untouched. This is the assertion the mutation
      // actually breaks: a daemon that mis-read EPERM would have reclaimed.
      expect(readFileSync(lockPath, 'utf8')).toBe('1\n');
    },
  );
});

describe('s9 Sc2: the liveness probe, against three real pids', () => {
  it('returns: a pid that exists and is ours is alive', () => {
    expect(pidLiveness(process.pid)).toBe('alive');
  });

  it.skipIf(IS_ROOT)(
    'EPERM: a pid that exists and is not ours is alive',
    () => {
      // Asserted through the real system call, so the row is a fact about the
      // mapping from errno to verdict rather than about an injected stub.
      let errno = '';
      try {
        process.kill(1, 0);
      } catch (e) {
        errno = (e as NodeJS.ErrnoException).code ?? '';
      }
      expect(errno).toBe('EPERM');
      expect(pidLiveness(1)).toBe('alive');
    },
  );

  it('ESRCH: a pid that has exited is dead', () => {
    const gone = deadPid();
    let errno = '';
    try {
      process.kill(gone, 0);
    } catch (e) {
      errno = (e as NodeJS.ErrnoException).code ?? '';
    }
    expect(errno).toBe('ESRCH');
    expect(pidLiveness(gone)).toBe('dead');
  });

  it('an errno nobody planned for is alive, because alive is the safe read', () => {
    // The closed set above is what macOS and Linux document. A third errno
    // is a situation this code does not understand, and the only safe thing
    // to do with a lock you do not understand is leave it alone.
    const odd = (): never => {
      const e = new Error('boom') as NodeJS.ErrnoException;
      e.code = 'EINVAL';
      throw e;
    };
    expect(pidLiveness(4242, odd)).toBe('alive');
  });
});

describe('s9 Sc2 rows 3 and 4: what counts as stale, and the row that says so', () => {
  it('row 3: a lock held by an exited pid is reclaimed', async () => {
    const dir = tempDir();
    const gone = deadPid();
    const lockPath = join(dir, LOCK_FILENAME);
    writeFileSync(lockPath, `${String(gone)}\n`);
    const reclaimed: Array<number | null> = [];
    const lock = await acquire(dir, {
      onStaleReclaim: (pid) => {
        reclaimed.push(pid);
      },
    });
    expect(reclaimed).toEqual([gone]);
    expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid));
  });

  it('row 3: §1.8 — the row goes down BEFORE the file comes off disk', async () => {
    /*
     * "The log is the record, the event is the courtesy." Reclaiming a lock
     * is an observable side effect: after the unlink, the only evidence that
     * a previous daemon ever held this directory is whatever was written
     * down first. A callback fired after the unlink would produce an audit
     * trail that is correct in every run that succeeds and empty in exactly
     * the run where somebody needs it.
     */
    const dir = tempDir();
    const lockPath = join(dir, LOCK_FILENAME);
    writeFileSync(lockPath, `${String(deadPid())}\n`);
    const stillOnDisk: boolean[] = [];
    await acquire(dir, {
      onStaleReclaim: () => {
        stillOnDisk.push(existsSync(lockPath));
      },
    });
    expect(stillOnDisk).toEqual([true]);
  });

  it('row 3: a callback that throws leaves the stale lock exactly as it was', async () => {
    /*
     * The §1.8 ordering has a consequence worth asserting rather than
     * reasoning about, because `main.ts` runs a real audit append in this
     * callback: it opens a `SqliteStore` against a directory whose previous
     * owner died, writes one row, and closes it. That append can throw — a
     * corrupt store, a full disk, a chain the previous process left
     * half-written.
     *
     * Because the row goes down BEFORE the unlink, a throw here has to leave
     * the directory untouched: the stale file still on disk, byte for byte,
     * and no lock taken. The alternative shape — unlink first, append after
     * — would lose the file AND the row, and hand the directory to whoever
     * asked next. This row is the difference between the two.
     */
    const dir = tempDir();
    const lockPath = join(dir, LOCK_FILENAME);
    const stale = `${String(deadPid())}\n`;
    writeFileSync(lockPath, stale);
    const before = readFileSync(lockPath);

    const boom = new Error('the audit append failed');
    let caught: unknown;
    try {
      await acquire(dir, {
        onStaleReclaim: () => {
          throw boom;
        },
      });
    } catch (e) {
      caught = e;
    }

    // The failure is the caller's, reported as itself rather than swallowed
    // into a misleading AlreadyRunningError.
    expect(caught).toBe(boom);
    // Byte-identical, not merely present: no truncation, no rewrite.
    expect(readFileSync(lockPath).equals(before)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(stale);
    // And nothing else was created: no half-acquired lock, no fallback file.
    expect(readdirSync(dir)).toEqual([LOCK_FILENAME]);
  });

  it('row 3: the audit event is a real AuditEvent carrying the stale pid', () => {
    // C-7. The event is built by a named function rather than an object
    // literal at the call site, so the shape has exactly one definition and
    // the compiler checks it against the union.
    const event: AuditEvent = staleReclaimEvent(4242);
    expect(event).toEqual({ type: 'daemon.lock.stale_reclaimed', pid: 4242 });
    expect(staleReclaimEvent(null)).toEqual({
      type: 'daemon.lock.stale_reclaimed',
      pid: null,
    });
  });

  it('row 4: an empty lock file is stale, not a crash', async () => {
    const dir = tempDir();
    const lockPath = join(dir, LOCK_FILENAME);
    writeFileSync(lockPath, '');
    const reclaimed: Array<number | null> = [];
    const lock = await acquire(dir, {
      onStaleReclaim: (pid) => {
        reclaimed.push(pid);
      },
    });
    // `null`, not `0`: there was no pid to name, and naming pid 0 in an
    // audit row would be a fact the file never contained.
    expect(reclaimed).toEqual([null]);
    expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid));
  });

  it('row 4: a non-numeric lock file is stale, not a crash', async () => {
    for (const body of ['not-a-pid\n', '  \n', '12x\n', '-3\n', '0\n']) {
      const dir = tempDir();
      writeFileSync(join(dir, LOCK_FILENAME), body);
      const reclaimed: Array<number | null> = [];
      const lock = await acquire(dir, {
        onStaleReclaim: (pid) => {
          reclaimed.push(pid);
        },
      });
      expect(reclaimed, JSON.stringify(body)).toEqual([null]);
      expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid));
    }
  });
});

describe('s9 Sc2 row 5: a bound port is a different error, and it releases', () => {
  it('throws PortInUseError naming the port', async () => {
    await withBoundPort(async (port) => {
      const dir = tempDir();
      let caught: unknown;
      try {
        released.push(await acquireInstanceLock({ dir, port }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PortInUseError);
      expect((caught as PortInUseError).code).toBe('PORT_IN_USE');
      expect((caught as PortInUseError).port).toBe(port);
      // Not the other error. "Already running" and "somebody else has the
      // port" are different situations with different fixes, and collapsing
      // them tells an operator to go and stop a process that is not there.
      expect(caught).not.toBeInstanceOf(AlreadyRunningError);
    });
  });

  it('leaves NO lock behind when the port check fails', async () => {
    /*
     * The failure this row exists to forbid: acquire the file, fail the
     * bind, exit. The next honest start then reads a lock naming a pid that
     * exited seconds ago, reports "already running (pid N)" about a process
     * nobody can find, and an operator is sent looking for a ghost.
     */
    await withBoundPort(async (port) => {
      const dir = tempDir();
      await expect(acquireInstanceLock({ dir, port })).rejects.toThrow(
        PortInUseError,
      );
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
      // And the directory is genuinely usable afterwards: a free port on the
      // same dir acquires, which it could not do if a lock had survived.
      const lock = await acquire(dir);
      expect(existsSync(lock.path)).toBe(true);
    });
  });
});

describe('s9 Sc2: release is idempotent and does not steal', () => {
  it('release removes only a file that still names this process', async () => {
    const dir = tempDir();
    const lock = await acquire(dir);
    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    // Twice is not an error: the shutdown path and the failure path can both
    // run, and a release that threw on the second call would turn a clean
    // stop into a non-zero exit.
    lock.release();
    // A successor's lock is not ours to delete.
    writeFileSync(lock.path, '999999\n');
    lock.release();
    expect(readFileSync(lock.path, 'utf8')).toBe('999999\n');
  });
});

describe('s9 Sc2: the C-6 error taxonomy is total in both directions', () => {
  it('every code has a spec, and every spec has a code', () => {
    // `Readonly<Record<DaemonErrorCode, DaemonErrorSpec>>` is what makes
    // this structural: TypeScript rejects a missing key and rejects a key
    // outside the union, so the map cannot drift from the union either way.
    // The runtime assertion below is the non-vacuity witness for that.
    const specKeys = Object.keys(DAEMON_ERROR_SPECS).sort();
    expect(specKeys).toEqual([...DAEMON_ERROR_CODES].sort());
    expect(DAEMON_ERROR_CODES.length).toBeGreaterThan(0);
  });

  it('the union grew by exactly this scenario’s three codes', () => {
    expect([...DAEMON_ERROR_CODES].sort()).toEqual([
      'ALREADY_RUNNING',
      // s9 Sc1 minted this one; Sc2 is where it joins a taxonomy rather
      // than being a lone `readonly code` on one class.
      'LAUNCHD_LABEL_REFUSED',
      'LOCK_DIR_UNWRITABLE',
      'PORT_IN_USE',
    ]);
  });

  it('every `code` literal in the daemon’s source is in the union', () => {
    /*
     * The half TypeScript cannot do. A new error class with
     * `readonly code = 'WHATEVER' as const` compiles perfectly and is
     * invisible to the map above; the taxonomy would then be a list of the
     * codes somebody remembered. So the source is the input.
     */
    const src = join(REPO, 'packages/daemon/src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(src);
    expect(files.length).toBeGreaterThan(10);
    const found = new Set<string>();
    for (const file of files)
      for (const m of readFileSync(file, 'utf8').matchAll(
        /readonly code = '([A-Z_]+)' as const/g,
      ))
        if (m[1] !== undefined) found.add(m[1]);
    expect([...found].sort()).toEqual([...DAEMON_ERROR_CODES].sort());
  });

  it('each class is an Error, keeps its name, and reports its own code', () => {
    const cases: ReadonlyArray<
      readonly [Error & { code: string }, DaemonErrorCode]
    > = [
      [new AlreadyRunningError(4242), 'ALREADY_RUNNING'],
      [new PortInUseError(47100), 'PORT_IN_USE'],
      [new LockDirUnwritableError('/nowhere'), 'LOCK_DIR_UNWRITABLE'],
    ];
    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.name).toBe(err.constructor.name);
      expect(DAEMON_ERROR_SPECS[code].exitCode).toBe(1);
      expect(DAEMON_ERROR_SPECS[code].summary.length).toBeGreaterThan(0);
    }
  });
});

describe('s9 Sc2 row 8 (unit half): an unwritable directory is its own error', () => {
  it.skipIf(IS_ROOT)('names the directory and creates nothing', async () => {
    // Root ignores the mode bits, so under root this row would assert that
    // an unwritable directory is writable. Skipped rather than weakened.
    const parent = tempDir();
    const dir = join(parent, 'locked');
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    let caught: unknown;
    try {
      released.push(await acquireInstanceLock({ dir, port: await freePort() }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LockDirUnwritableError);
    expect((caught as LockDirUnwritableError).code).toBe('LOCK_DIR_UNWRITABLE');
    expect((caught as LockDirUnwritableError).dir).toBe(dir);
    expect((caught as LockDirUnwritableError).message).toContain(dir);
    expect(readdirSync(dir)).toEqual([]);
    // The fallback that must not exist. "We could not write there so we
    // wrote here" is how one machine ends up with two daemons that each
    // believe they are the only one.
    expect(readdirSync(parent)).toEqual(['locked']);
  });
});

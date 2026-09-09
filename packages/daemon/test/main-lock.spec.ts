/**
 * s9 Sc2 rows 3 (end-to-end half), 6, 7 and 8 — two real daemons, one
 * directory.
 *
 * `lock.spec.ts` proves the lock module. This file proves the ORDERING in
 * `main.ts`, which is a different claim and the one an operator meets: a
 * second `wemessage` in a second terminal must refuse in one line and must
 * not have touched the store on its way out.
 *
 * WHY ROW 6 ASSERTS BYTES AND NOT AN EXIT CODE. Before this scenario the
 * second process DID exit 1 — it started, opened the store, ran recovery,
 * and then died inside `listen` with an `EADDRINUSE` stack trace, because
 * the first one already had the port. Same exit code, entirely the wrong
 * reason, and every step it took before dying was a write to a database
 * another process owns. An exit-code-only row would have been green on the
 * commit before this one. So the assertion is the exact stderr line, an
 * EMPTY stdout, and a first process that is provably undisturbed.
 *
 * WHY THERE IS A SCRIPTING-RUNNER STUB ON THE CHILD'S PATH. `main.ts` boots
 * the real capability probes, two of which shell out to macOS' scripting
 * runner. Left alone, running this file would ask the operator's machine for
 * an Automation permission and would consult a real Messages install. The
 * child is therefore given a `PATH` whose first entry holds a two-line stub
 * of that name, so the real binary is not merely unused — it is unreachable
 * from the process under test. That is the same promise arch gate (b)
 * makes; this file keeps it by construction rather than by not mentioning
 * it. The chat database is a fixture built here, never the live one.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb } from '@wemessage/fixtures';
import { DB_FILENAME, SqliteStore, verifyAuditChain } from '@wemessage/store';
import type { Clock } from '@wemessage/core';
import { LOCK_FILENAME } from '../src/lock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The built entrypoint. Spawned, never imported: it is a process, not a module. */
const MAIN = resolve(HERE, '..', 'dist', 'main.js');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** How long a daemon gets to come up, and to go down. Generous; bounded. */
const BOOT_BUDGET_MS = 20_000;
const SHUTDOWN_BUDGET_MS = 10_000;

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/* ── harness ──────────────────────────────────────────────────────────── */

const temps: string[] = [];
const children: ChildProcess[] = [];

function tempDir(prefix = 'wemessage-main-lock-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  // Every child, even on failure. A survivor holds the port AND the lock,
  // and the next run then fails for a reason that looks like a code defect.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((ok) => {
        child.once('exit', () => {
          ok();
        });
      });
    }
  }
  for (const dir of temps.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already gone, or never restricted */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  what: string,
  budgetMs: number,
): Promise<void> {
  // C-5: a bounded poll with a named deadline. Never a fixed sleep, and
  // never "wait longer" as the fix for a flake.
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(
        `timed out after ${String(budgetMs)}ms waiting for ${what}`,
      );
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

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

/**
 * A directory holding a stub of the scripting runner's name, first on the
 * child's PATH. The name is a filesystem entry here, not an argument to a
 * spawn: nothing in this file can reach the real tool.
 */
function stubbedPath(): string {
  const bin = tempDir('wemessage-stub-bin-');
  const stub = join(bin, 'osascript');
  writeFileSync(stub, '#!/bin/sh\nexit 1\n');
  chmodSync(stub, 0o755);
  return `${bin}:${process.env['PATH'] ?? ''}`;
}

interface Daemon {
  readonly child: ChildProcess;
  readonly dir: string;
  readonly port: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

function launch(opts: {
  dir: string;
  port: number;
  chatDb: string;
  path: string;
}): Daemon {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      PATH: opts.path,
      WEMESSAGE_DIR: opts.dir,
      WEMESSAGE_PORT: String(opts.port),
      WEMESSAGE_CHATDB: opts.chatDb,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => {
    out += b.toString('utf8');
  });
  child.stderr?.on('data', (b: Buffer) => {
    err += b.toString('utf8');
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (ok) => {
      child.once('exit', (code, signal) => {
        ok({ code, signal });
      });
    },
  );
  return {
    child,
    dir: opts.dir,
    port: opts.port,
    stdout: () => out,
    stderr: () => err,
    exited,
  };
}

/** A configured, isolated place for one daemon to live. */
function bed(): { dir: string; chatDb: string; path: string } {
  const dir = tempDir();
  const dbDir = tempDir('wemessage-chatdb-');
  const chatDb = join(dbDir, 'fixture.db');
  createChatDb(chatDb).close();
  return { dir, chatDb, path: stubbedPath() };
}

async function bearer(dir: string): Promise<string> {
  await waitFor(
    () => existsSync(join(dir, 'daemon.token')),
    'the daemon to mint its token',
    BOOT_BUDGET_MS,
  );
  return readFileSync(join(dir, 'daemon.token'), 'utf8').trim();
}

/* ── row 6 ────────────────────────────────────────────────────────────── */

describe('s9 Sc2 row 6: the second instance says one line and stops', () => {
  it(
    'exits 1 with an empty stdout and the exact refusal on stderr',
    async () => {
      const { dir, chatDb, path } = bed();
      const port = await freePort();

      const first = launch({ dir, port, chatDb, path });
      await waitFor(
        () => first.stdout().includes('listening on 127.0.0.1'),
        'the first daemon to listen',
        BOOT_BUDGET_MS,
      );
      const holder = first.child.pid;
      expect(holder).toBeTypeOf('number');
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);
      expect(readFileSync(join(dir, LOCK_FILENAME), 'utf8').trim()).toBe(
        String(holder),
      );

      const second = launch({ dir, port, chatDb, path });
      const end = await second.exited;

      expect(end.code).toBe(1);
      // Exactly these bytes. Not `toContain`: a stack trace, a banner, or a
      // second line about the port would all pass a containment check and
      // all mean the process got further than it should have.
      expect(second.stderr()).toBe(`already running (pid ${String(holder)})\n`);
      // Nothing on stdout. The success banner is written after `listen`, so
      // a byte here is proof the refusal came too late.
      expect(second.stdout()).toBe('');

      // And the incumbent is untouched: still listening, still answering.
      const token = await bearer(dir);
      const res = await fetch(`http://127.0.0.1:${String(port)}/v1/doctor`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      expect(first.child.exitCode).toBeNull();
      // The lock still names the FIRST process. A refusal that rewrote it
      // would have handed the directory to a process that then exited.
      expect(readFileSync(join(dir, LOCK_FILENAME), 'utf8').trim()).toBe(
        String(holder),
      );
    },
    BOOT_BUDGET_MS * 3,
  );
});

/* ── row 7 ────────────────────────────────────────────────────────────── */

describe('s9 Sc2 row 7: a stop releases the lock', () => {
  it(
    'SIGTERM removes daemon.lock inside the shutdown deadline',
    async () => {
      const { dir, chatDb, path } = bed();
      const port = await freePort();
      const daemon = launch({ dir, port, chatDb, path });
      await waitFor(
        () => daemon.stdout().includes('listening on 127.0.0.1'),
        'the daemon to listen',
        BOOT_BUDGET_MS,
      );
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);

      daemon.child.kill('SIGTERM');
      const end = await daemon.exited;
      expect(end.code).toBe(0);
      await waitFor(
        () => !existsSync(join(dir, LOCK_FILENAME)),
        'the lock file to be released',
        SHUTDOWN_BUDGET_MS,
      );

      // The point of releasing it: the very next start is an ordinary start,
      // with no reclaim and no message about a process that is not there.
      const again = launch({ dir, port, chatDb, path });
      await waitFor(
        () => again.stdout().includes('listening on 127.0.0.1'),
        'the successor to listen',
        BOOT_BUDGET_MS,
      );
      expect(again.stderr()).toBe('');
    },
    BOOT_BUDGET_MS * 3,
  );
});

/* ── row 3, end-to-end half ───────────────────────────────────────────── */

describe('s9 Sc2 row 3: a reclaim is written down before it happens', () => {
  it(
    'the audit log carries daemon.lock.stale_reclaimed with the stale pid',
    async () => {
      const { dir, chatDb, path } = bed();
      const port = await freePort();

      // A daemon that held this directory and is gone. Started and stopped
      // for real, rather than a pid invented in a file, so the stale pid is
      // one that genuinely existed and genuinely does not now.
      const previous = launch({ dir, port, chatDb, path });
      await waitFor(
        () => previous.stdout().includes('listening on 127.0.0.1'),
        'the previous daemon to listen',
        BOOT_BUDGET_MS,
      );
      const stalePid = previous.child.pid as number;
      previous.child.kill('SIGKILL');
      await previous.exited;
      // A process that was stopped without warning leaves its lock behind.
      // Put it back, because SIGKILL is exactly the case this row is about.
      writeFileSync(join(dir, LOCK_FILENAME), `${String(stalePid)}\n`);

      const successor = launch({ dir, port, chatDb, path });
      await waitFor(
        () => successor.stdout().includes('listening on 127.0.0.1'),
        'the successor to listen',
        BOOT_BUDGET_MS,
      );
      /*
       * Suspicion answered rather than reasoned about: the reclaim callback
       * in `main.ts` opens a SECOND `SqliteStore` against this directory,
       * appends one row, and closes it in a `finally`. If that close were
       * ever skipped, the daemon would run with two handles on an
       * append-only chain that assumes one writer, and nothing else in the
       * suite would notice — SQLite is perfectly happy to hand out a second
       * connection.
       *
       * So count the handles while the successor is still alive. `lsof` on
       * the child's own pid, filtered to the store file, has to name it
       * exactly once. This is the assertion that makes `finally` a fact.
       */
      const dbPath = realpathSync(join(dir, DB_FILENAME));
      const openHandles = execFileSync(
        'lsof',
        ['-p', String(successor.child.pid), '-Fn'],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      )
        .split('\n')
        .filter((line) => line === `n${dbPath}`);
      // Exactly one: the daemon's own store. Two means the reclaim
      // connection was never closed.
      expect(openHandles).toHaveLength(1);

      successor.child.kill('SIGTERM');
      await successor.exited;

      const store = new SqliteStore({ dir, clock });
      try {
        const rows = store.listAudit({
          event: 'daemon.lock.stale_reclaimed',
          limit: 10,
        });
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]?.eventJson ?? '{}')).toEqual({
          type: 'daemon.lock.stale_reclaimed',
          pid: stalePid,
        });
        // §1.8's other half: the row carries an actor, and it is the system
        // rather than a person. Nobody asked for this reclaim.
        expect(JSON.parse(rows[0]?.actorJson ?? '{}')).toMatchObject({
          kind: 'system',
        });

        /*
         * C-7's other half, and the reason this assertion is here rather
         * than in a store spec: `main.ts` writes this one row from a place
         * nothing else in the daemon writes from. The reclaim callback runs
         * before `startDaemon`, so it opens its OWN `SqliteStore` against
         * this directory, appends, and closes — a second writer against an
         * append-only hash chain whose whole design assumes one.
         *
         * The chain is what proves the two writers did not interleave: the
         * reclaim row hashes the row before it, the daemon's own boot rows
         * hash the reclaim row, and a chain that verifies end to end is a
         * chain nobody wrote into the middle of. A row count cannot see
         * that; only the walk can.
         */
        const verified = verifyAuditChain({
          readAuditRows: (afterSeq, limit) =>
            store.readAuditRows(afterSeq, limit),
        });
        expect(verified.ok, JSON.stringify(verified)).toBe(true);
        // Non-vacuity: the chain walked really did contain rows, including
        // the reclaim row and whatever the successor wrote after it, so
        // `ok: true` is a fact about a populated log rather than an empty
        // one. `> 1` because a log holding only the reclaim row would prove
        // the second writer never handed off to the first.
        expect(verified.length).toBeGreaterThan(1);
        const reclaimSeq = rows[0]?.seq ?? 0;
        expect(reclaimSeq).toBeGreaterThan(0);
        expect(verified.length).toBeGreaterThanOrEqual(reclaimSeq);
      } finally {
        store.close();
      }
    },
    BOOT_BUDGET_MS * 4,
  );
});

/* ── row 8 ────────────────────────────────────────────────────────────── */

describe('s9 Sc2 row 8: an unwritable directory stops the daemon', () => {
  it.skipIf(IS_ROOT)(
    'exits 1, names the directory, and leaves no lock anywhere else',
    async () => {
      // Root ignores the mode bits entirely, so as root this row would be
      // asserting that a writable directory is unwritable. Skipped, not
      // weakened: a guard that has to be relaxed for one caller is the
      // wrong guard, and "sometimes not applicable" is not a relaxation.
      const parent = tempDir();
      const dir = join(parent, 'read-only');
      mkdirSync(dir);
      const { chatDb, path } = bed();
      chmodSync(dir, 0o500);

      const port = await freePort();
      const daemon = launch({ dir, port, chatDb, path });
      const end = await daemon.exited;

      expect(end.code).toBe(1);
      expect(daemon.stdout()).toBe('');
      expect(daemon.stderr()).toContain(dir);
      expect(daemon.stderr().trimEnd().split('\n')).toHaveLength(1);
      // Nothing written where it was told to write.
      expect(readdirSync(dir)).toEqual([]);
      // And nothing written ANYWHERE ELSE. "We could not write there, so we
      // wrote next door" is the failure this row exists to forbid: it is how
      // a machine ends up with two daemons that each hold a lock nobody else
      // is looking at.
      expect(readdirSync(parent)).toEqual(['read-only']);
      expect(existsSync(join(tmpdir(), LOCK_FILENAME))).toBe(false);
      expect(existsSync(join(process.cwd(), LOCK_FILENAME))).toBe(false);
    },
    BOOT_BUDGET_MS * 2,
  );
});

/* ── D4: an older build, pointed at a newer build's directory ─────────── */

/** Make this directory's store look like a newer build wrote it. */
function plantFutureMigration(dir: string): void {
  const store = new SqliteStore({ dir, clock });
  try {
    store.db
      .prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)')
      .run('9999_future.sql', '2027-01-01T00:00:00.000Z');
  } finally {
    store.close();
  }
}

/** The one line, byte for byte, both paths below must print. */
const refusal = (dir: string): string =>
  `the store in ${dir} was written by a newer build ` +
  `(it has applied 9999_future.sql, which this build does not ship): ` +
  'start that build again, or run `wemessaged service status` to see which one is installed\n';

describe('s9 D4: an older build refuses a store a newer one wrote', () => {
  it(
    'exits 1 with one line on stderr, and leaves no lock behind',
    async () => {
      const { dir, chatDb, path } = bed();
      plantFutureMigration(dir);

      const child = launch({ dir, port: await freePort(), chatDb, path });
      const end = await child.exited;

      expect(end.code).toBe(1);
      // Exactly these bytes, for the reason row 6 gives: a stack trace would
      // pass `toContain` and would mean this arrived as a defect rather than
      // as a condition. That is the whole difference this change makes.
      expect(child.stderr()).toBe(refusal(dir));
      expect(child.stdout()).toBe('');
      // The lock was taken before the store was opened, and a process that
      // is not going to use it must not leave it naming a pid that has
      // exited. This is the second `.catch` in `main.ts` doing its job.
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(false);
    },
    BOOT_BUDGET_MS * 2,
  );

  it(
    'says the same thing when the newer build died and left a stale lock',
    async () => {
      // THE path this actually arrives by. Nobody downgrades a daemon that is
      // running fine; they downgrade because the newer one crashed. So the
      // store is met in `onStaleReclaim` -- which writes the recovery row
      // BEFORE clearing the lock (§1.8) and therefore opens the store first
      // -- and not in `startDaemon` at all. A translation installed only at
      // the `startDaemon` site is never reached here, and this row is the
      // difference between one sentence and a stack trace every ten seconds
      // under `KeepAlive`.
      const { dir, chatDb, path } = bed();
      const port = await freePort();

      const first = launch({ dir, port, chatDb, path });
      await waitFor(
        () => first.stdout().includes('listening on 127.0.0.1'),
        'the first daemon to listen',
        BOOT_BUDGET_MS,
      );
      first.child.kill('SIGKILL');
      await first.exited;
      // A crash leaves the file; that is what makes the next start a reclaim.
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);

      plantFutureMigration(dir);

      const second = launch({ dir, port, chatDb, path });
      const end = await second.exited;

      expect(end.code).toBe(1);
      expect(second.stderr()).toBe(refusal(dir));
      expect(second.stdout()).toBe('');
      // Still there, and correctly so: nothing was reclaimed, so nothing
      // should claim to have reclaimed it.
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);
    },
    BOOT_BUDGET_MS * 3,
  );

  it('opens the store through one door, so no path can miss the translation', () => {
    // The two rows above cover the two paths that exist TODAY. This one
    // covers the third somebody adds next year: a fresh `new SqliteStore(`
    // compiles, passes every row in this file, and quietly reintroduces the
    // stack trace on whichever path its author did not have in mind. The
    // translation is only a property of the daemon if this is the only door.
    const src = resolve(HERE, '..', 'src');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk(src);
    expect(files.length).toBeGreaterThan(10);
    expect(
      files
        .filter((f) => readFileSync(f, 'utf8').includes('new SqliteStore('))
        .map((f) => relative(src, f))
        .sort(),
    ).toEqual(['open-store.ts']);
  });
});

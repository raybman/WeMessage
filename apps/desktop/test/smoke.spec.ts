/**
 * s9 Sc12: THE RELEASE SMOKE SUITE, over the artefact a stranger downloads.
 *
 * Every subject here is the shipped ad-hoc bundle: unzipped from
 * `dist-pack/WeMessage-<version>-arm64-UNSIGNED.zip`, asked of Gatekeeper,
 * installed as a REAL launch agent by its OWN `wemessaged` shim, driven from
 * the PACKAGED app over CDP, replaced under the running job, refused when the
 * store is newer than it, and uninstalled. Nothing is stubbed. The only
 * fixtures are the directory it is pointed at and the chat database it reads.
 *
 * ── THE ROW EVERY LAUNCHD TEST FILE MUST COPY (row 13) ──────────────────
 *
 * `beforeAll` and `afterAll` below are the block from
 * `packages/daemon/test/launchd-lifecycle.spec.ts`, copied because that file
 * says in its header that any new launchd spec copies it verbatim. It sweeps
 * this lane's orphans before it starts, records the two witnesses outside its
 * own directory, and compares them again at the end: the operator's
 * `~/Library/LaunchAgents` listing hashes to the same value, and the
 * registered F-120 sentinel's exit code, pid and run count are unchanged. A
 * launchd test without it is a test that cannot say what it left behind.
 *
 * ── THE LATCH, AND WHY IT IS SEEDED BEFORE ANYTHING IS INSTALLED ────────
 *
 * The shipped daemon hard-wires the AppleScript send backend. There is no
 * loopback backend in the packaged binary, and a capability probe from a
 * process launchd started reaches the operator's real Messages.app, because a
 * launchd job's environment is its plist and there is nothing to interpose
 * on. So `connection.userDisconnected` is written into the store BEFORE the
 * first install and is never cleared, which is the state the product itself
 * writes and reads at boot. That is fixture work, not a bypass, and it is
 * proven separately in `packages/daemon/test/doctor-probe-latch.spec.ts`.
 *
 * Liveness is therefore `/v1/health`, which has no probe in it, and NEVER
 * `/v1/doctor`, which IS the probe runner and is not defended by the boot
 * latch. Supervision is read out of launchd's own view of the job.
 *
 * ── WHAT THE PLAN ASKS FOR AND THIS FILE DOES NOT DO ────────────────────
 *
 * Rows 4 and 5 are RESCOPED away from the plan's "onboarding happy path to a
 * send test". The plan's wizard verdict is a `DoctorReport`, the renderer can
 * only obtain one from `GET /v1/doctor`, and `openWizardMode` fires that probe
 * whenever the stream is connected, which is exactly the state row 4 asserts.
 * That probe would shell out on the operator's desktop AND would rewrite
 * `connection.state`, the key the send gate actually reads, moving it off its
 * fail-closed value while the disconnect latch still said `1`. Row 4 therefore
 * asserts what can be asserted honestly: the packaged app connects with the
 * real token, lands on the queue, offers no wizard step, and the daemon's
 * `connectionState` is still `disconnected` because nothing probed.
 *
 * Row 6 does not replace the bundle in place either. `installService`
 * computes `changed` from the plist BYTES and both the bootout and the
 * bootstrap live inside `if (changed)`, so re-running the same install over
 * the same paths is a no-op that proves nothing. The next bundle is cloned to
 * a SECOND PATH, which changes `ProgramArguments`, which is what makes the
 * install actually tear the job down and bring it back.
 */
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import type {
  SettingsPatchResult,
  SettingsPayload,
} from '../../../packages/client/dist/index.js';
import type { AuditRow, Clock } from '../../../packages/core/dist/index.js';
import { SETTING_USER_DISCONNECTED } from '../../../packages/core/dist/index.js';
import {
  DB_FILENAME,
  SqliteStore,
} from '../../../packages/store/dist/index.js';
import { createChatDb } from '../../../fixtures/dist/index.js';
import { asLaunchAgentLabel } from '../../../packages/daemon/src/launchd/contract.js';
import { parseLaunchAgentPlist } from '../../../packages/daemon/src/launchd/plist.js';
import {
  installRealLaneSpawner,
  launchAgentsTripwire,
  mintTestLabel,
  printField,
  readOnly,
  readSentinel,
  resetLaneJournal,
  resolveSentinel,
  sweepOrphans,
  sweepOwnDir,
  termOwnedDaemon,
  type SentinelReading,
} from '../../../packages/daemon/test/helpers/launchd-lane.js';

const darwin = process.platform === 'darwin';

const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const PACK_OUT = join(DESKTOP, 'dist-pack');
const VERIFY = join(DESKTOP, 'scripts', 'verify-bundle.sh');

/** Read once, from the same file electron-builder reads it from. */
const VERSION = (
  JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/** THE ARTEFACT. Its absence is what the `describe` gate keys off. */
const ZIP = join(PACK_OUT, `WeMessage-${VERSION}-arm64-UNSIGNED.zip`);

const TEST_PREFIX = 'sh.wemessage.test.';

/** Covers `ExitTimeOut` (20s) with room, per the plan's bootout note. */
const RUNNING_BUDGET_MS = 25_000;
const HTTP_BUDGET_MS = 20_000;
/** A packaged Electron cold start, plus the compositor, plus a handshake. */
const UI_BUDGET_MS = 90_000;
/** A crash loop at `ThrottleInterval: 1` needs a few rounds to be visible. */
const REFUSAL_BUDGET_MS = 60_000;

/**
 * The value row 5 writes and rows 5 and 6 read back.
 *
 * `send.undoGraceSeconds` and not a rule: it is an integer in the closed
 * settings list, it is durable, it is reachable with the latch on (a settings
 * write consults no adapter and no send path), and moving it UP lengthens the
 * window in which a send can be undone. There is no value of this key that
 * opens anything.
 */
const WITNESS_GRACE = 37;

/** The id a newer build would have applied, from `lock.spec.ts`'s shape. */
const FUTURE_MIGRATION = '9999_future.sql';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

interface Bed {
  readonly root: string;
  readonly dir: string;
  readonly la: string;
  readonly logs: string;
  readonly chatDb: string;
  readonly port: number;
  /** The unzipped bundle. Rows 1 to 5's subject. */
  readonly app: string;
  /** The clone at a second path. Row 6's subject. */
  readonly nextApp: string;
}

let bed: Bed;
let label: string;
let plistPath: string;
let sentinelBefore: SentinelReading;
let tripwireBefore: string;
/** The audit log as row 5 left it, which is what row 6 compares against. */
let auditAfterRow5: AuditRow[] = [];

/**
 * `playwright-core` is CommonJS and is asked for by `createRequire`, for the
 * reason `test/e2e/harness.ts` spells out at length: it publishes ESM-shaped
 * types over a CJS implementation, so a named ESM import typechecks and then
 * fails at run time under Node's CJS named-export detection.
 */
const need = createRequire(import.meta.url);
const { chromium } = need(
  'playwright-core',
) as typeof import('playwright-core');

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

/**
 * A bounded poll with a named deadline (C-5), yielding on the macrotask
 * queue rather than on the clock.
 *
 * `setImmediate` and never a timed wait: arch row 14 bans timed waits under
 * this whole tree as a text scan, and it is right to. Every attempt below is
 * itself an I/O operation, so the loop is paced by the work it is waiting on
 * rather than by a number somebody guessed.
 */
async function until<T>(
  what: string,
  budgetMs: number,
  attempt: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const got = await attempt();
    if (got !== null) return got;
    if (Date.now() >= deadline)
      throw new Error(
        `timed out after ${String(budgetMs)}ms waiting for ${what}`,
      );
    await new Promise<void>((ok) => {
      setImmediate(ok);
    });
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

/** The last of whatever the supervised daemon wrote, for a failure message. */
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

function daemonStderr(): string {
  try {
    return readFileSync(join(bed.logs, 'daemon.err.log'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * The environment a child of this file gets.
 *
 * EVERY `WEMESSAGE_` variable the child sees is one this file set. The
 * ambient ones are dropped rather than inherited, because `WEMESSAGE_APP_PATH`
 * and `WEMESSAGE_DAEMON_MAIN` both redirect what ends up in a plist, and a
 * variable left over in somebody's shell is not a thing a release check should
 * be able to notice.
 */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith('WEMESSAGE_')) out[key] = value;
  return { ...out, ...extra };
}

/** The shipped shim inside a bundle, which is what a release actually runs. */
function shim(app: string): string {
  return join(app, 'Contents', 'Resources', 'bin', 'wemessaged');
}

function exeOf(app: string): string {
  return join(app, 'Contents', 'MacOS', 'WeMessage');
}

/**
 * Run the shipped shim.
 *
 * THE LABEL IS PINNED, and that is mandatory rather than tidy. Under the test
 * prefix `installLabel` mints a FRESH id on every install when the environment
 * names none, so row 6 would bootstrap a SECOND KeepAlive job into the same
 * directory, crash-looping on the first one's lock forever.
 */
function serviceCli(
  app: string,
  argv: readonly string[],
  extra: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(shim(app), [...argv], {
    encoding: 'utf8',
    env: childEnv({
      WEMESSAGE_LAUNCHD_LABEL: label,
      WEMESSAGE_CHATDB: bed.chatDb,
      WEMESSAGE_LOGS_DIR: bed.logs,
      // §1.7's default of ten seconds would spend rows 6 and 7's whole budget
      // sitting in launchd's restart throttle.
      WEMESSAGE_LAUNCHD_THROTTLE_INTERVAL: '1',
      ...extra,
    }),
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A real assertion on an exit status that still SHOWS the output when it
 * fails.
 *
 * `expect(status).toBe(0)` reports `-1 !== 0` and nothing else, and the whole
 * reason a row runs a subprocess is that the subprocess knows why it refused.
 * The value under assertion is `'exit 0'` exactly when the status is zero, so
 * this cannot pass for a non-zero exit, and the failure diff carries stdout
 * and stderr with it.
 */
function assertExitZero(
  r: { status: number | null; stdout: string; stderr: string },
  what: string,
): void {
  expect(
    r.status === 0
      ? 'exit 0'
      : `${what} exited ${String(r.status)}\n` +
          `stdout: ${r.stdout.trim().slice(-4000)}\n` +
          `stderr: ${r.stderr.trim().slice(-4000)}`,
  ).toBe('exit 0');
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

function token(): string {
  return readFileSync(join(bed.dir, 'daemon.token'), 'utf8').trim();
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${String(bed.port)}${path}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok)
    throw new Error(
      `GET ${path} answered ${String(res.status)}: ${await res.text()}`,
    );
  return (await res.json()) as T;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${String(bed.port)}${path}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `PATCH ${path} answered ${String(res.status)}: ${await res.text()}`,
    );
  return (await res.json()) as T;
}

async function auditRows(): Promise<AuditRow[]> {
  return await apiGet<AuditRow[]>('/v1/audit?limit=1000');
}

function eventOf(row: AuditRow): { type: string } & Record<string, unknown> {
  return JSON.parse(row.eventJson) as { type: string } & Record<
    string,
    unknown
  >;
}

/** Raw SQL against the store, from outside any build that ships a schema. */
function sqlite(sql: string): string {
  return execFileSync(
    '/usr/bin/sqlite3',
    ['-cmd', '.timeout 10000', join(bed.dir, DB_FILENAME), sql],
    { encoding: 'utf8' },
  );
}

/**
 * Every Mach-O under a bundle, found the way the loader would: by reading the
 * magic, not by trusting an extension. Same set as `pack.spec.ts` row 10.
 */
const MACH_O_MAGIC = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
function machOFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.isFile()) continue;
      if (statSync(p).size < 4) continue;
      const head = readFileSync(p).subarray(0, 4);
      if (
        MACH_O_MAGIC.has(head.readUInt32BE(0)) ||
        MACH_O_MAGIC.has(head.readUInt32LE(0))
      )
        out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The directory's contents, hashed, EXCLUDING everything a live daemon owns.
 *
 * The sqlite main file, its write-ahead log and its shared-memory index are
 * rewritten by any transaction and by every checkpoint, `daemon.lock` names a
 * pid that is supposed to change across a restart, and `service.json` is
 * rewritten by `installService` itself at the end of every install. Hashing
 * any of them would be a flake by construction (C-11), and a row that
 * tolerated it would have had to be loosened until it asserted nothing.
 */
function stableDigest(dir: string): Record<string, string> {
  const owned = new Set([
    DB_FILENAME,
    `${DB_FILENAME}-wal`,
    `${DB_FILENAME}-shm`,
    'daemon.lock',
    'service.json',
  ]);
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || owned.has(e.name)) continue;
    out[e.name] = createHash('sha256')
      .update(readFileSync(join(dir, e.name)))
      .digest('hex');
  }
  return out;
}

/* ── the packaged app, over CDP ───────────────────────────────────────── */

/**
 * The app is FUSED, so `_electron.launch` cannot drive it.
 *
 * `EnableNodeCliInspectArguments` is blown in the shipped bundle, and
 * `_electron.launch` drives Electron through exactly that. What is NOT fused
 * is Chromium's own remote debugging port, which is a browser switch rather
 * than a Node one, so the packaged binary is started by hand and attached to
 * with `connectOverCDP`.
 *
 * The handle is kept, and the process is stopped by ITS OWN pid, twice: once
 * from `afterAll`, and once from an `exit` listener for the run that never
 * reaches `afterAll` at all. A packaged Electron left behind by a crashed
 * worker holds a window on the operator's desktop until they find it.
 */
let appChild: ChildProcess | null = null;
let appBrowser: Browser | null = null;
const appSaid: string[] = [];

process.on('exit', () => {
  const pid = appChild?.pid;
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already reaped. Nothing to do, and nothing to report from an exit hook.
  }
});

async function stopApp(): Promise<void> {
  const child = appChild;
  const browser = appBrowser;
  appChild = null;
  appBrowser = null;
  if (browser !== null) {
    try {
      await browser.close();
    } catch {
      // The far side is a process we are about to signal anyway.
    }
  }
  if (child === null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  // The waiting is the point: `kill` returns when the signal is delivered,
  // not when the process is gone, and what follows this call deletes the
  // directory the app has open.
  await until('the packaged app to exit', 30_000, async () =>
    child.exitCode !== null || child.signalCode !== null ? true : null,
  );
}

/* ── the suite ────────────────────────────────────────────────────────── */

describe.skipIf(!darwin || !existsSync(ZIP))(
  's9 Sc12: the release smoke suite, over the shipped ad-hoc bundle',
  () => {
    beforeAll(async () => {
      // ── ROW 13, COPIED VERBATIM FROM `launchd-lifecycle.spec.ts`. ────
      // The real spawner, named once, in a function whose name says so.
      installRealLaneSpawner();

      // BEFORE ANYTHING ELSE: boot out anything of OURS still loaded. A run
      // killed between `bootstrap` and `afterAll` never gets to clean up
      // after itself, by definition, and the next run is the only moment it
      // reliably can.
      await sweepOrphans();

      // Reset AFTER the sweep, so the journal describes this run's work
      // rather than the previous run's wreckage.
      resetLaneJournal();

      // The two things this run must leave exactly as it found them.
      tripwireBefore = launchAgentsTripwire();
      await resolveSentinel();
      sentinelBefore = await readSentinel();

      /*
       * REALPATH, and not as a tidiness measure.
       *
       * `tmpdir()` on macOS answers under `/var/folders`, and `/var` is a
       * symlink to `/private/var`. Every path this bed hands out is built by
       * joining onto this root, so the whole suite would speak the `/var`
       * spelling, while the things it CHECKS resolve their own paths and
       * answer in the `/private/var` one: `service install` renders
       * `ProgramArguments` from the daemon entry's real location, and row 6
       * compares that plist against a path it composed itself. On the first
       * run of this file the two differed by exactly that prefix, in a diff
       * where the strings otherwise matched character for character, which
       * is a failure that reads as a packaging bug and is not one.
       *
       * Resolving ONCE here rather than at each comparison is deliberate: a
       * per-assertion `realpathSync` would have to be remembered at every
       * future assertion, and the one that forgets is the one that fails
       * months later.
       */
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'wm-smoke-')));
      const dir = join(root, 'config');
      const la = join(root, 'agents');
      const logs = join(root, 'logs');
      const apps = join(root, 'Applications');
      const appsNext = join(root, 'Applications-next');
      for (const d of [dir, la, logs, apps, appsNext])
        mkdirSync(d, { recursive: true });
      const chatDb = join(root, 'chat.db');
      createChatDb(chatDb).close();
      bed = {
        root,
        dir,
        la,
        logs,
        chatDb,
        port: await freePort(),
        app: join(apps, 'WeMessage.app'),
        nextApp: join(appsNext, 'WeMessage.app'),
      };

      // THE LATCH, seeded before anything is installed and before the bundle
      // is even unpacked. `startDaemon` reads it and skips the capability
      // probes; see this file's header for why that is what makes running the
      // shipped daemon under launchd acceptable on this machine at all.
      const store = new SqliteStore({ dir, clock });
      try {
        store.setSetting(SETTING_USER_DISCONNECTED, '1');
      } finally {
        store.close();
      }

      // ONE label for the whole file. Rows 3, 6, 7 and 8 all name it, and
      // row 6 in particular depends on the SECOND install landing on the
      // FIRST install's job rather than beside it.
      label = mintTestLabel();

      // `ditto -x -k` and not `unzip`: the archive carries resource forks and
      // an ad-hoc signature, and `unzip` is not required to preserve either.
      execFileSync('ditto', ['-x', '-k', ZIP, apps], { stdio: 'ignore' });
    }, 900_000);

    afterAll(async () => {
      if (!darwin) return;
      // Ours to stop, and stopped before the directory it has open is deleted.
      await stopApp();
      // ── ROW 13. COPY THIS BLOCK INTO ANY NEW LAUNCHD SPEC. ──────────
      // Only our own directory is enumerated, only labels found in it are
      // booted out, and the two witnesses outside it are then compared.
      try {
        if (bed !== undefined) {
          await sweepOwnDir(bed.la);
          rmSync(dirname(bed.dir), { recursive: true, force: true });
        }
      } finally {
        expect(launchAgentsTripwire()).toBe(tripwireBefore);
        expect(await readSentinel()).toEqual(sentinelBefore);
      }
    }, 120_000);

    /* ── row 1: what the bundle IS, before anything runs it ──────────── */

    it('row 1: the unzipped bundle links nothing off a build machine, and verify-bundle agrees', () => {
      expect(existsSync(bed.app)).toBe(true);

      /*
       * `dyld_info` AND NOT `otool -L`. `otool` still parses the ancient
       * `archive(member.o)` notation, so it splits any argument at its first
       * `(` and opens the prefix, and Electron ships `WeMessage Helper (GPU)`,
       * `(Renderer)` and `(Plugin)`. `pack.spec.ts` row 10 documents the four
       * files that answered `can't open file` and the silent pass that came
       * of it. `dyld_info` also prints `-rpaths`, which `otool -L` does not,
       * and an rpath into a home directory is this row's bug one indirection
       * later, so the scan covers the whole output.
       */
      const files = machOFiles(bed.app);
      const offenders: string[] = [];
      for (const rel of files) {
        const out = execFileSync(
          'dyld_info',
          ['-dependents', join(bed.app, rel)],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        // `dyld_info` exits 0 on a file it could not read, so the SHAPE of
        // the output is the proof and not the exit status. A check that
        // cannot run must fail, not pass.
        if (!out.includes('-linked_dylibs:'))
          offenders.push(`${rel}: dyld_info could not read it: ${out.trim()}`);
        // The first line is `<path> [arch]:`, dropped by shape and not by
        // index so a multi-slice file drops all of its headers.
        for (const line of out.split('\n'))
          if (
            !line.trimEnd().endsWith(']:') &&
            /(^|\s)(\/opt\/homebrew|\/usr\/local|\/Users)\//.test(line)
          )
            offenders.push(`${rel}: ${line.trim()}`);
      }
      expect(offenders).toEqual([]);
      // Non-vacuity: thirteen Mach-O files today. An empty list would also
      // have had no offenders.
      expect(files.length).toBeGreaterThan(8);

      // The verifier a human with no checkout can run against a bundle they
      // downloaded, asked of the copy that came OUT OF THE ZIP rather than of
      // the one electron-builder left in `dist-pack/mac-arm64/`.
      const verified = spawnSync(VERIFY, [bed.app, 'adhoc'], {
        encoding: 'utf8',
      });
      assertExitZero(verified, 'verify-bundle.sh');
      // Not just "exit 0": exit 2 is its precondition refusal and exit 1 is a
      // real failure, so the summary line is what says it actually ran the
      // whole lane rather than bailing early.
      expect(verified.stdout).toContain('verify-bundle: ok');
      expect(verified.stdout).toContain('lane=adhoc');
    });

    /* ── row 2: and Gatekeeper refuses it ────────────────────────────── */

    it('row 2: quarantined the way a browser quarantines it, macOS refuses to run it', () => {
      // Some hosts turn assessments off entirely, and on such a host
      // `--assess` cannot answer the question this row asks: it would report
      // "accepted" for a reason that has nothing to do with our bundle. That
      // is an answer being unavailable, not the answer changing.
      const gatekeeperOn = spawnSync('spctl', ['--status'], {
        encoding: 'utf8',
      }).stdout.includes('assessments enabled');
      if (!gatekeeperOn) return;

      // The four-field value LaunchServices writes: flags, hex timestamp,
      // the agent that downloaded it, and an event id.
      const quarantine = [
        '0081',
        Math.floor(Date.now() / 1000).toString(16),
        'Safari',
        randomUUID().toUpperCase(),
      ].join(';');
      execFileSync('xattr', [
        '-w',
        'com.apple.quarantine',
        quarantine,
        bed.app,
      ]);
      let assessed: { status: number | null; stderr: string };
      try {
        assessed = spawnSync(
          'spctl',
          ['--assess', '--type', 'execute', '--verbose=4', bed.app],
          { encoding: 'utf8' },
        );
      } finally {
        // Off again whatever happened above, because every row after this
        // one runs the bundle and a quarantined app is a dialog nobody asked
        // for on the operator's screen.
        execFileSync('xattr', ['-d', 'com.apple.quarantine', bed.app]);
      }

      /*
       * ONLY WHAT IS OBSERVED. `spctl` says `rejected` on stderr and exits
       * non-zero when it refuses; the `source=` line it prints alongside is
       * not asserted, because `pack.spec.ts` row 9b does not assert it either
       * and a release check that pinned a reason string would go red on a
       * macOS point release that reworded it while the refusal itself was
       * exactly as strong.
       */
      expect(assessed.stderr).toContain('rejected');
      expect(assessed.status).not.toBe(0);

      // The attribute really is gone: `xattr -p` exits non-zero when the
      // named attribute is absent.
      expect(
        spawnSync('xattr', ['-p', 'com.apple.quarantine', bed.app], {
          encoding: 'utf8',
        }).status,
      ).not.toBe(0);
    });

    /* ── row 3: the shipped shim installs a real launch agent ────────── */

    it('row 3: the shim installs a real agent, and the daemon it supervises is alive', async () => {
      /*
       * THE LATCH, READ BACK FROM DISK before a single thing is installed.
       * Not from the variable that wrote it. If a later edit stops seeding
       * it, the failure must be a red assertion here and not a shell-out on
       * the operator's desktop.
       */
      const seeded = new SqliteStore({ dir: bed.dir, clock });
      try {
        expect(seeded.getSetting(SETTING_USER_DISCONNECTED)).toBe('1');
      } finally {
        seeded.close();
      }

      const installed = serviceCli(bed.app, installArgv());
      assertExitZero(installed, 'service install');
      const json = JSON.parse(installed.stdout) as {
        label: string;
        plistPath: string;
        bootstrapped: boolean;
        changed: boolean;
      };
      // The label is the one this file minted, not one the CLI invented.
      expect(json.label).toBe(label);
      expect(json.label.startsWith(TEST_PREFIX)).toBe(true);
      expect(json.changed).toBe(true);
      expect(json.bootstrapped).toBe(true);
      plistPath = json.plistPath;
      expect(plistPath).toBe(join(bed.la, `${label}.plist`));

      // THE PACKAGED LAYOUT, derived from the bundle's own location and not
      // from a flag: this is the property row 6 goes on to exploit.
      const plist = parseLaunchAgentPlist(readFileSync(plistPath, 'utf8'));
      expect(plist['ProgramArguments']).toEqual([
        exeOf(bed.app),
        join(bed.app, 'Contents', 'Resources', 'daemon', 'main.mjs'),
      ]);
      const penv = plist['EnvironmentVariables'] as Record<string, string>;
      expect(penv['ELECTRON_RUN_AS_NODE']).toBe('1');
      expect(penv['WEMESSAGE_SUPERVISOR']).toBe('launchd');
      expect(penv['WEMESSAGE_DIR']).toBe(bed.dir);
      expect(penv['WEMESSAGE_CHATDB']).toBe(bed.chatDb);
      expect(penv['WEMESSAGE_PORT']).toBe(String(bed.port));
      // Nothing this run writes may land outside the temp root.
      expect(String(plist['StandardOutPath']).startsWith(bed.logs)).toBe(true);
      expect(String(plist['StandardErrorPath']).startsWith(bed.logs)).toBe(
        true,
      );

      // LIVENESS IS `/v1/health`. It is the one route exempt from the bearer
      // and it has no probe in it. `/v1/doctor` IS `runDoctor` and would
      // shell out regardless of the boot latch, so it is never called here.
      const status = await until(
        `the supervised daemon to answer /v1/health\n${daemonLogTails()}`,
        HTTP_BUDGET_MS,
        async () => await health(bed.port),
      );
      expect(status).toBe(200);

      // SUPERVISION, FROM THE SUPERVISOR. Not a field the daemon writes
      // about itself: a process claiming to be supervised is an assertion,
      // the supervisor listing it is a fact. launchd reaches `running`
      // through `xpcproxy`, so a single print here would be a flake.
      const printed = await until(
        'the job to reach running',
        RUNNING_BUDGET_MS,
        async () => {
          const p = await printLabel();
          return p.code === 0 && /^\s*state\s*=\s*running\b/m.test(p.stdout)
            ? p
            : null;
        },
      );
      expect(printed.stdout).toMatch(/WEMESSAGE_SUPERVISOR\s*=>\s*launchd/);
      // TWO WITNESSES, AND THEY AGREE. The supervisor's pid, and the pid our
      // own daemon wrote into its lock file. Either alone is a number; the
      // pair is an identity, and it is the same pair `termOwnedDaemon`
      // insists on before it will signal anything.
      const held = await until(
        'the supervised daemon to claim its lock',
        RUNNING_BUDGET_MS,
        async () => lockPid(),
      );
      expect(printField(printed.stdout, 'pid')).toBe(String(held));

      // The version under smoke, from the shim itself.
      const version = serviceCli(bed.app, ['--version']);
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(VERSION);
    });

    /* ── row 4: the packaged app, against the supervised daemon ──────── */

    it('row 4: the packaged app connects with the real token and probes nothing', async () => {
      const cdpPort = await freePort();
      // Chromium's own profile, in the temp root. Without this the packaged
      // app writes a browser profile into the operator's real
      // `~/Library/Application Support/WeMessage`, beside a config directory
      // this run has nothing to do with.
      const profile = join(bed.root, 'electron-profile');

      const child = spawn(
        exeOf(bed.app),
        [
          `--remote-debugging-port=${String(cdpPort)}`,
          `--user-data-dir=${profile}`,
        ],
        {
          env: childEnv({
            WEMESSAGE_DIR: bed.dir,
            WEMESSAGE_PORT: String(bed.port),
            // Honoured in the PACKAGED app: there is no `isPackaged` gate on
            // it. It skips the single-instance lock and exposes the
            // observation hooks, and it changes nothing else.
            WEMESSAGE_DESKTOP_TEST: '1',
            ELECTRON_ENABLE_LOGGING: '1',
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      appChild = child;
      child.stdout?.on('data', (d: Buffer) => appSaid.push(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => appSaid.push(d.toString('utf8')));

      await until(
        'the packaged app to publish a debugging endpoint',
        UI_BUDGET_MS,
        async () => {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              `the packaged app exited (code=${String(child.exitCode)} ` +
                `signal=${String(child.signalCode)}):\n${appSaid.join('')}`,
            );
          try {
            const res = await fetch(
              `http://127.0.0.1:${String(cdpPort)}/json/version`,
            );
            return res.ok ? true : null;
          } catch {
            return null;
          }
        },
      );

      /*
       * `connectOverCDP` AND NOT `_electron.launch`. The shipped bundle blows
       * `EnableNodeCliInspectArguments`, which is exactly the mechanism
       * `_electron.launch` drives Electron through; Chromium's remote
       * debugging port is a browser switch and survives the fuse. The extra
       * switches are safe against the deep-link parser, which only considers
       * an argument that starts with the `wemessage://` scheme.
       */
      const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${String(cdpPort)}`,
      );
      appBrowser = browser;
      const page = await until<Page>(
        'the app document to appear on the debugging endpoint',
        UI_BUDGET_MS,
        async () =>
          browser
            .contexts()
            .flatMap((c) => c.pages())
            .find((p) => p.url().startsWith('app://')) ?? null,
      );

      // THE SANCTIONED WAIT, and the only one in this file that watches the
      // product's own readiness attribute: the same one the operator's state
      // strip reads, so a wait that passes and a UI that lies cannot coexist.
      await page.waitForSelector('html[data-conn="connected"]', {
        timeout: UI_BUDGET_MS,
      });

      const html = page.locator('html');
      expect(await html.getAttribute('data-conn')).toBe('connected');
      // The default screen, and NO wizard step. The wizard is what the plan
      // asked to be driven here, and driving it is what this file will not
      // do: `openWizardMode` fires `GET /v1/doctor` whenever the stream is
      // connected, which is this exact state.
      expect(await html.getAttribute('data-screen')).toBe('queue');
      expect(await html.getAttribute('data-wizard-step')).toBeNull();

      /*
       * AND NOTHING PROBED. This is the honest half of the row.
       *
       * `runDoctor` writes `connection.state`, which is the key
       * `readGateSettings` actually consults, and a successful probe would
       * move the send gate off its fail-closed value while
       * `connection.userDisconnected` still read `1`. So the assertion is
       * that the daemon's own connection state is still the unset one: the
       * latch has not been defeated one indirection away.
       */
      const observed = await apiGet<{ connectionState: string }>('/v1/status');
      expect(observed.connectionState).toBe('disconnected');
    });

    /* ── row 5: durable state, written through the API ───────────────── */

    it('row 5: a setting written through the app tier is durable and audited', async () => {
      /*
       * A SETTING AND NOT A DRAFT APPROVAL. The plan's row is an approve, and
       * an approve needs a draft, and a draft needs ingest to have proposed
       * one. Ingest is reading a fixture chat database that nothing appends
       * to, and the disconnect latch means the daemon would refuse the send
       * anyway. A settings write is durable, audited, reachable with the
       * latch on, and touches no send path at all.
       */
      const before = await auditRows();

      /*
       * The SHIPPED types, not a local restatement of them.
       *
       * These two calls were first written against a hand-rolled
       * `{ settings: Record<string, unknown> }`, which typechecks against any
       * response at all and so let the row assert `settings[key] === 37` when
       * the daemon answers with a DESCRIPTOR, `{ value, default, ... }`. The
       * row failed on a shape the local type had already agreed to. Naming
       * the real exports instead means the next change to the settings
       * contract lands here as a type error rather than as a puzzle at
       * runtime.
       */
      const patched = await apiPatch<SettingsPatchResult>('/v1/settings', {
        'send.undoGraceSeconds': WITNESS_GRACE,
      });
      expect(patched.changed).toEqual(['send.undoGraceSeconds']);
      expect(patched.settings['send.undoGraceSeconds']?.value).toBe(
        WITNESS_GRACE,
      );

      // Read back over a second request, so the answer is the store's and
      // not the response body's.
      const reread = await apiGet<{ settings: SettingsPayload }>(
        '/v1/settings',
      );
      expect(reread.settings['send.undoGraceSeconds']?.value).toBe(
        WITNESS_GRACE,
      );

      const after = await auditRows();
      expect(after.length).toBe(before.length + 1);
      // Reverse-chronological, so the newest row is at the head.
      expect(eventOf(after[0]!)).toMatchObject({
        type: 'setting.changed',
        key: 'send.undoGraceSeconds',
        to: WITNESS_GRACE,
      });

      // The chain still verifies as a whole, over the real store, from the
      // process that wrote it.
      const verified = await apiGet<{ ok: boolean }>('/v1/audit/verify');
      expect(verified.ok).toBe(true);

      auditAfterRow5 = after;

      // The app has done its job. Everything after this row restarts the
      // daemon repeatedly and the window would only be a spectator, so it
      // comes down here rather than sitting on the operator's desktop for it.
      await stopApp();
    });

    /* ── row 6: a NEW bundle over a RUNNING job, state intact ────────── */

    it('row 6: installing the next bundle replaces the job and keeps the directory', async () => {
      // teeth: TN-fresh-dir-on-upgrade (row 6): applied, bit, reverted.
      //
      // Two mutations were needed, and the FIRST ONE FAILING is the part
      // worth keeping. It was aimed at `resolveServiceDir` in
      // `packages/daemon/src/launchd/cli.ts`, wrapping the resolved config
      // directory in `join(dir, 'v2')` so an install would point the job at
      // a fresh path. That reddened this row, and it proved nothing: it also
      // reddened rows 3 through 8, because the FIRST install moved too, so
      // the daemon never came up on the seeded directory at all. This row
      // then failed after 2ms on `expect(beforePid).not.toBeNull()`, a
      // PRECONDITION. A row that dies on its setup has not been shown to
      // test anything; it has been shown to be downstream of something else.
      //
      // The second mutation was made upgrade-only so that the blast radius
      // was exactly one row. In `installService`, immediately after
      // `changed` is computed, and guarded on `previous !== null && changed`,
      // which is true only when a plist was already on disk and its bytes
      // moved:
      //
      //   rmSync(input.dir, { recursive: true, force: true });
      //   mkdirSync(input.dir, { recursive: true });
      //
      // That is the bug this tooth is named for, written out: an upgrade
      // that hands the next build a clean directory and throws the user's
      // store, token and audit log away. Rows 1 to 5 and row 8 stayed green,
      // and this row failed alone, after 27.8 SECONDS rather than 2ms, which
      // is the signature of a row that did its work before it disagreed.
      //
      // It failed at the two-witness liveness check and not at the digest
      // comparison below, and the reason is a second bug riding inside the
      // first: wiping the directory also removes the service state file, so
      // `readServiceState` answered `bootstrapped: false`, the installer
      // skipped the bootout and bootstrap it would otherwise have run, and
      // the OLD process was still serving under the OLD pid. The row's
      // message was `timed out after 25000ms waiting for the replacement job
      // to reach running`. Recorded because it is the more valuable reading:
      // insisting on a NEW pid catches an upgrade that silently did not
      // happen, which no assertion about the plist's CONTENT can see.
      //
      // Reverted in source, `pnpm --filter @wemessage/daemon build`, and
      // `pnpm pack:adhoc` re-run, because the subject of this file is the
      // packaged bundle and a revert that stops at the source tree would
      // leave the mutation inside the artefact the next run unzips.
      const firstExe = exeOf(bed.app);
      const nextExe = exeOf(bed.nextApp);
      const beforePid = lockPid();
      expect(beforePid).not.toBeNull();
      const digestBefore = stableDigest(bed.dir);
      // Non-vacuity: `daemon.token` at the very least, and it is exactly the
      // file that must survive, since the app read its bearer out of it.
      expect(Object.keys(digestBefore)).toContain('daemon.token');

      /*
       * A SECOND PATH, NOT A REPLACEMENT IN PLACE.
       *
       * `installService` computes `changed` from the plist BYTES, and both
       * the bootout and the bootstrap are inside `if (changed)`. A bundle
       * swapped in at the same path renders the same plist, so `changed` is
       * false and the install does nothing at all: it would not even restart
       * the daemon, and the row would be asserting that a no-op preserved
       * state. `resolveProgramArguments` derives the app path from the
       * daemon entry's OWN location, so a clone at a different path renders
       * a different plist, `changed` is true, and the install itself does the
       * bootout, the settle and the bootstrap.
       *
       * `cp -Rc` clones on APFS, so a 130MB bundle is copied in milliseconds
       * and the ad-hoc signature and every extended attribute come with it.
       */
      execFileSync('cp', ['-Rc', bed.app, bed.nextApp]);
      expect(existsSync(shim(bed.nextApp))).toBe(true);

      // THE SAME directory, THE SAME label, THE SAME port. Only the bundle
      // moved.
      const upgraded = serviceCli(bed.nextApp, installArgv());
      assertExitZero(upgraded, 'service install (next bundle)');
      const json = JSON.parse(upgraded.stdout) as {
        label: string;
        plistPath: string;
        bootstrapped: boolean;
        changed: boolean;
      };
      expect(json.label).toBe(label);
      expect(json.plistPath).toBe(plistPath);
      expect(json.changed).toBe(true);
      expect(json.bootstrapped).toBe(true);

      const plist = parseLaunchAgentPlist(readFileSync(plistPath, 'utf8'));
      expect(plist['ProgramArguments']).toEqual([
        nextExe,
        join(bed.nextApp, 'Contents', 'Resources', 'daemon', 'main.mjs'),
      ]);
      expect(
        (plist['EnvironmentVariables'] as Record<string, string>)[
          'WEMESSAGE_DIR'
        ],
      ).toBe(bed.dir);

      // A NEW PROCESS, AND IT IS THE NEXT BUNDLE'S. Two witnesses that have
      // to agree: launchd's pid and the lock file our own daemon wrote.
      const printed = await until(
        `the replacement job to reach running\n${daemonLogTails()}`,
        RUNNING_BUDGET_MS,
        async () => {
          const p = await printLabel();
          if (p.code !== 0) return null;
          if (!/^\s*state\s*=\s*running\b/m.test(p.stdout)) return null;
          const pid = printField(p.stdout, 'pid');
          return pid !== null && pid !== String(beforePid) ? p : null;
        },
      );
      expect(printed.stdout).toContain(nextExe);
      expect(printed.stdout).not.toContain(firstExe);
      const afterPid = await until(
        'the replacement daemon to claim the lock',
        RUNNING_BUDGET_MS,
        async () => {
          const held = lockPid();
          return held !== null && held !== beforePid ? held : null;
        },
      );
      expect(printField(printed.stdout, 'pid')).toBe(String(afterPid));

      await until(
        `the replacement daemon to answer /v1/health\n${daemonLogTails()}`,
        HTTP_BUDGET_MS,
        async () => ((await health(bed.port)) === 200 ? true : null),
      );

      /*
       * THE WITNESS GOES THROUGH THE NEW PROCESS, with the token read out of
       * the ORIGINAL directory. A directory the upgrade had quietly moved on
       * from would answer 401 here, or would answer with an empty log.
       */
      const settings = await apiGet<{ settings: SettingsPayload }>(
        '/v1/settings',
      );
      expect(settings.settings['send.undoGraceSeconds']?.value).toBe(
        WITNESS_GRACE,
      );

      const after = await auditRows();
      // EXACTLY one new row. `installService` appends `service.installed`
      // first on every install, before the write and before the service
      // manager, so one install is one row and nothing else moved.
      expect(after.length).toBe(auditAfterRow5.length + 1);
      expect(eventOf(after[0]!)).toMatchObject({
        type: 'service.installed',
        label,
        plistPath,
      });
      // And the chain UNDERNEATH it is byte for byte what row 5 saw.
      expect(after.slice(1)).toEqual(auditAfterRow5);

      // Nothing else in the directory was rewritten. The sqlite files, the
      // lock and `service.json` are excluded by construction; see
      // `stableDigest`.
      expect(stableDigest(bed.dir)).toEqual(digestBefore);

      /*
       * WHAT THIS ROW DOES NOT PROVE, said plainly rather than implied.
       *
       * It proves that replacing the BUNDLE under a running job preserves the
       * directory, the audit chain, the token and the settings. It does NOT
       * prove a version bump, because there is no way to build a second
       * bundle at a different version from this tree: `pack.mjs` takes no
       * version argument, and `--extra-version` does not exist. Both copies
       * report the same version, and the row says so.
       */
      const nextVersion = serviceCli(bed.nextApp, ['--version']);
      expect(nextVersion.stdout.trim()).toBe(VERSION);
    });

    /* ── row 7: a store a newer build wrote is refused ───────────────── */

    it('row 7: an older build refuses a store a newer one wrote, and recovers when it is gone', async () => {
      /*
       * PLANTED AND UNPLANTED THROUGH RAW SQL, not through `SqliteStore`.
       *
       * `applyMigrations` computes the set difference between what
       * `_migrations` records and what the build ships, and throws BEFORE it
       * runs anything. So the moment the plant lands, `new SqliteStore` is
       * itself a refusal and there would be no way to take it back out again.
       */
      sqlite(
        `INSERT INTO _migrations (id, applied_at) VALUES ` +
          `('${FUTURE_MIGRATION}', '2027-01-01T00:00:00.000Z');`,
      );

      let planted = true;
      try {
        /*
         * TRAP 1: EVERY CLI VERB EXCEPT `status` REFUSES FIRST.
         *
         * `deps.audit` is `storeAppender(dir)`, which opens the store, so a
         * planted directory refuses at the audit step before the service
         * manager is reached at all. `status` never appends and so never
         * opens the store, which is why it is the one verb that can still
         * answer a question about a directory in this state.
         */
        const refused = serviceCli(bed.nextApp, [
          'service',
          'restart',
          '--dir',
          bed.dir,
          '--json',
        ]);
        expect(refused.status).toBe(2);
        expect(refused.stderr).toContain(FUTURE_MIGRATION);
        expect(refused.stdout).toBe('');

        /*
         * TRAP 2: THE RUNNING DAEMON HAS ITS STORE OPEN ALREADY.
         *
         * The guard is at OPEN. A process that opened the store before the
         * plant landed keeps serving happily, so the plant on its own proves
         * nothing about the daemon; it has to be made to open the store
         * again. `termOwnedDaemon` signals it, by a pid launchd and our own
         * lock file both name, and `KeepAlive` brings it back into the
         * refusal.
         */
        expect(await termOwnedDaemon(bed.dir, asLaunchAgentLabel(label))).toBe(
          'signalled',
        );

        // The refusal itself, in the supervised process's own stderr: one
        // sentence naming the migration and the directory.
        await until(
          'the respawned daemon to refuse the store',
          REFUSAL_BUDGET_MS,
          async () =>
            daemonStderr().includes(
              `the store in ${bed.dir} was written by a newer build`,
            ) && daemonStderr().includes(FUTURE_MIGRATION)
              ? true
              : null,
        );

        // AND THE SUPERVISOR AGREES ON THE EXIT STATUS. Polled for the
        // exit-code field ONLY: `state` and `pid` are whatever a job in a
        // throttled restart loop happens to be showing at the instant of the
        // print, and asserting on either would be a race with launchd.
        const exited = await until(
          'the supervisor to report a non-zero last exit code',
          REFUSAL_BUDGET_MS,
          async () => {
            const p = await printLabel();
            if (p.code !== 0) return null;
            const code = printField(p.stdout, 'last exit code');
            return code !== null && code !== '0' ? code : null;
          },
        );
        // `StoreNewerThanBuildError`'s spec says 1, and the taxonomy is the
        // only thing that turns an error into an exit status in `main.ts`.
        expect(exited).toBe('1');
      } finally {
        // UNPLANT BEFORE ROW 8, ALWAYS. `service uninstall` opens the store
        // for its own audit row, so a directory left planted makes the
        // teardown exit 2 having done nothing, and the agent survives the
        // run.
        sqlite(`DELETE FROM _migrations WHERE id = '${FUTURE_MIGRATION}';`);
        planted = false;
      }
      expect(planted).toBe(false);
      expect(sqlite(`SELECT count(*) FROM _migrations;`).trim()).toBe('1');

      // And the same build comes straight back up over the same directory,
      // which is what makes this a refusal and not a corruption.
      const status = await until(
        `the daemon to recover once the future migration is gone\n${daemonLogTails()}`,
        REFUSAL_BUDGET_MS,
        async () => await health(bed.port),
      );
      expect(status).toBe(200);
      const settings = await apiGet<{ settings: SettingsPayload }>(
        '/v1/settings',
      );
      expect(settings.settings['send.undoGraceSeconds']?.value).toBe(
        WITNESS_GRACE,
      );
    });

    /* ── row 8: and it all comes off again ───────────────────────────── */

    it('row 8: uninstall removes the plist and the supervisor forgets the job', async () => {
      const removed = serviceCli(bed.nextApp, [
        'service',
        'uninstall',
        '--dir',
        bed.dir,
        '--json',
      ]);
      assertExitZero(removed, 'service uninstall');
      const json = JSON.parse(removed.stdout) as {
        label: string | null;
        changed: boolean;
      };
      expect(json.label).toBe(label);
      expect(json.changed).toBe(true);

      expect(existsSync(plistPath)).toBe(false);
      expect(readdirSync(bed.la)).toEqual([]);

      // The supervisor no longer has it. A bounded poll and not a single
      // print, for the same reason row 3's `running` was one: a bootout is
      // asynchronous.
      const gone = await until(
        'the supervisor to forget the label',
        RUNNING_BUDGET_MS,
        async () => {
          const p = await printLabel();
          return p.code !== 0 ? p.code : null;
        },
      );
      expect(gone).not.toBe(0);

      // Nothing is answering on the port either.
      expect(
        await until('the port to go quiet', HTTP_BUDGET_MS, async () =>
          (await health(bed.port)) === null ? true : null,
        ),
      ).toBe(true);
    });
  },
);

/**
 * s9 Sc3 stage 1, rows 5, 6, 7, 11, 12, 16 and the G4 command-line scoping
 * guards — `wemessaged service install|uninstall|status`.
 *
 * STAGE 1, AND WHAT THAT MEANS HERE. Every service-manager call in this file
 * goes to a recording fake. The real spawner exists (one module owns it) and
 * nothing in this stage is wired to it, so the entire install/status/uninstall
 * lifecycle is exercised as ARGV — strings, compared to strings — before any
 * of it is ever handed to launchd. Row 16 is the point of that: the exact
 * argument vectors this product will one day hand to the service manager are
 * reviewed here as literal data.
 *
 * The one process this file starts is the daemon itself (row 5), spawned
 * directly with `node dist/bin.js`, given a temp directory and a free port,
 * and stopped with a SIGTERM to a child this file created. No service manager
 * is involved in that either.
 *
 * G4, THE GUARD THIS FILE IS REALLY ABOUT. The renderer's guard binds a plist
 * to a label; the runner's guard binds an argv to a label; neither of them
 * knows that a test run must not install anything into the operator's real
 * LaunchAgents directory. That is a command-line-level property, so it is a
 * command-line-level guard: under the test label prefix, both directories
 * must resolve inside the temp root, or the command refuses before it has
 * written a byte.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@wemessage/store';
import { createChatDb } from '@wemessage/fixtures';
import type { AuditEvent, Clock } from '@wemessage/core';
import { LaunchdLabelRefused } from '../src/launchd/contract.js';
import { runServiceCli, type CliOverrides } from '../src/launchd/cli.js';
import { parseLaunchAgentPlist } from '../src/launchd/plist.js';
import { SERVICE_STATE_FILENAME } from '../src/launchd/service.js';
import { laneRun, recordingSpawner } from './helpers/launchd-lane.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The built entrypoint `package.json` points `wemessaged` at. */
const BIN = resolve(HERE, '..', 'dist', 'bin.js');
const MAIN = resolve(HERE, '..', 'dist', 'main.js');
const BOOT_BUDGET_MS = 20_000;
const TEST_PREFIX = 'sh.wemessage.test.';
/** Pinned so row 16's transcript is a literal a reader can check by eye. */
const PINNED = `${TEST_PREFIX}01j5transcript`;
/**
 * The caller's own uid, and the only GUI domain this runner will address.
 *
 * It is interpolated into the transcript below rather than hard-coded,
 * because G1 now refuses ANY uid that is not this process's — which is the
 * property the transcript is partly there to show. On the machine this
 * scenario was built on the value is 501, and the report records the
 * transcript with that substitution made.
 */
const U = String(process.getuid?.() ?? 501);

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

/* ── harness ──────────────────────────────────────────────────────────── */

const temps: string[] = [];
const children: ChildProcess[] = [];

function tempDir(prefix = 'wm-service-cli-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

afterEach(async () => {
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
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function waitFor(
  predicate: () => boolean,
  what: string,
  budgetMs: number,
): Promise<void> {
  // C-5: a bounded poll with a named deadline, never a fixed sleep.
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
 * A stateful stand-in for the service manager.
 *
 * It is stateful because the transcript rows are about a SEQUENCE — a
 * bootstrap makes the next print succeed, a bootout makes it fail — and a
 * fake that always answered the same thing would let an install that never
 * bootstrapped report itself as loaded.
 */
function fakeServiceManager(opts: { loaded?: boolean; pid?: number } = {}) {
  let loaded = opts.loaded ?? false;
  const pid = opts.pid ?? 4242;
  const rec = recordingSpawner((i) => {
    const [op] = i.args;
    if (op === 'bootstrap') {
      loaded = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (op === 'bootout') {
      loaded = false;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (op === 'print')
      return loaded
        ? {
            code: 0,
            stdout: `\tpid = ${String(pid)}\n\tstate = running\n\tlast exit code = 0\n`,
            stderr: '',
          }
        : { code: 113, stdout: '', stderr: 'Could not find service\n' };
    return { code: 0, stdout: '', stderr: '' };
  });
  return { rec, isLoaded: () => loaded };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly json: <T>() => T;
  readonly order: readonly string[];
}

/**
 * One CLI invocation, entirely in-process, against the fake.
 *
 * `order` is the ordered spy §1.8 is asserted with: the audit appender and
 * the stdout writer push into the SAME array, so "the row went down before
 * anything was printed" is a fact about a sequence rather than a comparison
 * of two clocks.
 */
async function cli(
  argv: readonly string[],
  over: CliOverrides & { readonly events?: AuditEvent[] } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const order: string[] = [];
  const events = over.events ?? [];
  const code = await runServiceCli(
    argv,
    {
      out: (s) => {
        order.push(`stdout:${s.slice(0, 24)}`);
        out += s;
      },
      err: (s) => {
        err += s;
      },
    },
    {
      uid: process.getuid?.() ?? 501,
      appendAudit: (e: AuditEvent) => {
        order.push(`audit:${e.type}`);
        events.push(e);
      },
      ...over,
    },
  );
  return {
    code,
    out,
    err,
    order,
    json: <T>() => JSON.parse(out) as T,
  };
}

interface InstallJson {
  readonly label: string;
  readonly plistPath: string;
  readonly bootstrapped: boolean;
  readonly changed: boolean;
}
/** s9 Sc7 row 6. Same shape as install, minus `changed` — a restart has no
 *  content to compare against. */
interface RestartJson {
  readonly label: string;
  readonly plistPath: string;
  readonly bootstrapped: boolean;
}
interface StatusJson {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  readonly label: string;
  readonly plistPath: string;
  readonly lastExitStatus: number | null;
}
interface UninstallJson {
  readonly installed: boolean;
  readonly changed: boolean;
  readonly label: string | null;
}

/** A temp config dir and a temp LaunchAgents dir, both inside the temp root. */
function bed(): { dir: string; la: string } {
  return { dir: tempDir(), la: tempDir('wm-service-la-') };
}

function installArgs(b: { dir: string; la: string }, ...extra: string[]) {
  return [
    'service',
    'install',
    '--dir',
    b.dir,
    '--launch-agents-dir',
    b.la,
    '--label-prefix',
    TEST_PREFIX,
    '--json',
    ...extra,
  ];
}

/** s9 Sc7 row 6. `--launch-agents-dir` is unused by `serviceRestart` itself
 *  (the plist path comes from `service.json`), but G4 checks it regardless
 *  of which subcommand is running whenever `--label-prefix` is the test one,
 *  so it is supplied here for the same reason `installArgs` supplies it. */
function restartArgs(b: { dir: string; la: string }, ...extra: string[]) {
  return [
    'service',
    'restart',
    '--dir',
    b.dir,
    '--launch-agents-dir',
    b.la,
    '--label-prefix',
    TEST_PREFIX,
    '--json',
    ...extra,
  ];
}

/* ── row 5: the entrypoint is a daemon first and a CLI second ─────────── */

describe('s9 Sc3 row 5: wemessaged --help, and wemessaged with no args', () => {
  it('--help names all four service subcommands', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    for (const line of [
      'service install',
      'service uninstall',
      'service status',
      'service restart',
    ])
      expect(r.out, line).toContain(line);
    // …and it does not silently accept a verb it does not have. (s9 Sc7:
    // 'restart' used to BE this example; it is now a real fourth verb — see
    // "s9 Sc7 row 6: service restart" below — so the placeholder moved to a
    // word that can never become one.)
    const bad = await cli(['service', 'bogus']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('bogus');
  });

  it('an unknown top-level command is a refusal, not a daemon start', async () => {
    const r = await cli(['srevice', 'install']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
  });

  it(
    'with no args it runs the daemon, answers /v1/doctor, and stops on SIGTERM',
    async () => {
      // The one process this file starts. Spawned directly — no service
      // manager anywhere near it — and stopped with a signal to a child
      // this test created and owns.
      const dir = tempDir();
      const port = await freePort();
      // A REAL fixture chat database and a stubbed `osascript`, exactly as
      // `main-lock.spec.ts` builds them. The first draft of this row pointed
      // WEMESSAGE_CHATDB at a file that does not exist and asserted the
      // daemon would come up; it does not, and it should not — the boot
      // opens that database. The row was wrong about the product, so the row
      // was fixed rather than the budget raised.
      const chatDb = join(tempDir('wm-service-chatdb-'), 'fixture.db');
      createChatDb(chatDb).close();
      const stubBin = tempDir('wm-service-stub-bin-');
      writeFileSync(join(stubBin, 'osascript'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(stubBin, 'osascript'), 0o755);
      const child = spawn(process.execPath, [BIN], {
        env: {
          ...process.env,
          PATH: `${stubBin}:${process.env['PATH'] ?? ''}`,
          WEMESSAGE_DIR: dir,
          WEMESSAGE_PORT: String(port),
          WEMESSAGE_CHATDB: chatDb,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      let out = '';
      child.stdout?.on('data', (b: Buffer) => {
        out += b.toString('utf8');
      });
      const exited = new Promise<number | null>((ok) => {
        child.once('exit', (c) => {
          ok(c);
        });
      });

      await waitFor(
        () => out.includes('listening on 127.0.0.1'),
        'the daemon started by `wemessaged` with no args to listen',
        BOOT_BUDGET_MS,
      );
      await waitFor(
        () => existsSync(join(dir, 'daemon.token')),
        'the daemon to mint its token',
        BOOT_BUDGET_MS,
      );
      const token = readFileSync(join(dir, 'daemon.token'), 'utf8').trim();
      const res = await fetch(`http://127.0.0.1:${String(port)}/v1/doctor`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);

      child.kill('SIGTERM');
      expect(await exited).toBe(0);
      // The lock comes off: `bin.js` is `main.js` with an argv check in
      // front of it, not a second, subtly different boot.
      expect(existsSync(join(dir, 'daemon.lock'))).toBe(false);
    },
    BOOT_BUDGET_MS * 2,
  );

  it('the built bin exists and the daemon entrypoint still does too', () => {
    // Cheap, and it is the row that fails first with a comprehensible
    // message when somebody forgets that vitest runs against `dist/`.
    expect(existsSync(BIN)).toBe(true);
    expect(existsSync(MAIN)).toBe(true);
  });
});

/* ── row 6: install writes a plist and audits before it prints ────────── */

describe('s9 Sc3 row 6: install writes the plist, audits, then prints', () => {
  it('writes <la>/<label>.plist, prints the JSON, and audits FIRST', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const events: AuditEvent[] = [];
    const r = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fake.rec.spawn),
      events,
      env: { WEMESSAGE_LAUNCHD_LABEL: PINNED },
    });
    expect(r.code).toBe(0);
    const json = r.json<InstallJson>();
    expect(json.label).toBe(PINNED);
    expect(json.plistPath).toBe(join(b.la, `${PINNED}.plist`));
    expect(existsSync(json.plistPath)).toBe(true);
    expect(readdirSync(b.la)).toEqual([`${PINNED}.plist`]);
    // `bootstrapped` is FALSE in this stage, and the row says so out loud:
    // stage 1 does not hand anything to a service manager, so `--no-load`
    // is the only install this file performs and the field reports it
    // honestly rather than optimistically.
    expect(json.bootstrapped).toBe(false);
    expect(json.changed).toBe(true);
    // …and with `--no-load` the fake was never reached at all.
    expect(fake.rec.calls).toEqual([]);

    // §1.8: the audit row is appended BEFORE the observable side effect.
    // Asserted as an ORDER, not as two timestamps: two clock reads that
    // land in the same millisecond compare equal and prove nothing.
    expect(r.order[0]).toBe('audit:service.installed');
    expect(
      r.order.filter((s) => s.startsWith('stdout:')).length,
    ).toBeGreaterThan(0);
    expect(r.order.indexOf('audit:service.installed')).toBeLessThan(
      r.order.findIndex((s) => s.startsWith('stdout:')),
    );
    expect(events).toEqual([
      { type: 'service.installed', label: PINNED, plistPath: json.plistPath },
    ]);
  });

  it('the label is minted from the id generator, LOWERCASED, when none is given', async () => {
    // The daemon's id generator returns uppercase Crockford base32 and the
    // label grammar is lowercase. Minting without the fold throws inside
    // the installer, which is a failure mode worth one row.
    const b = bed();
    const r = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
    });
    const json = r.json<InstallJson>();
    expect(json.label.startsWith(TEST_PREFIX)).toBe(true);
    expect(json.label).toBe(json.label.toLowerCase());
    expect(json.label).toMatch(/^sh\.wemessage\.test\.[a-z0-9]{26}$/);
  });

  it('the state file records the label, so nothing has to go looking for it', async () => {
    const b = bed();
    await cli(installArgs(b, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
      env: { WEMESSAGE_LAUNCHD_LABEL: PINNED },
    });
    const state = JSON.parse(
      readFileSync(join(b.dir, SERVICE_STATE_FILENAME), 'utf8'),
    ) as { label: string; plistPath: string };
    expect(state.label).toBe(PINNED);
    expect(state.plistPath).toBe(join(b.la, `${PINNED}.plist`));
  });

  it('the real audit path lands a service.installed row in the store', async () => {
    // The rows above inject the appender so §1.8's ordering can be
    // observed. This one does not: it runs the installer's own audit path
    // and reads the row back out of the hash-chained store, so the
    // injection above is proving an ordering rather than papering over a
    // sink that was never wired.
    const b = bed();
    await cli(installArgs(b, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
      env: { WEMESSAGE_LAUNCHD_LABEL: PINNED },
      appendAudit: undefined,
    });
    const store = new SqliteStore({ dir: b.dir, clock });
    try {
      const rows = store.readAuditRows(0, 100);
      const types = rows.map(
        (r) => (JSON.parse(r.eventJson) as AuditEvent).type,
      );
      expect(types).toContain('service.installed');
    } finally {
      store.close();
    }
  });
});

/* ── row 7: idempotence ───────────────────────────────────────────────── */

describe('s9 Sc3 stage 2: the two environment values the plist must carry', () => {
  /*
   * Both of these are read from `baseEnv` in exact parallel with the
   * existing `WEMESSAGE_DIR` fallback, because that is the seam the CLI
   * already has for "a value the caller set in the environment belongs in
   * the plist". Neither gets a flag: a flag is a promise to support it
   * forever on the command line, and the only callers today are this
   * scenario's lifecycle rows and a developer debugging a real install.
   */

  function envOf(plistPath: string): Record<string, string> {
    const parsed = parseLaunchAgentPlist(readFileSync(plistPath, 'utf8'));
    return parsed['EnvironmentVariables'] as Record<string, string>;
  }

  it('WEMESSAGE_CHATDB reaches the plist, so a supervised daemon never defaults to the real one', async () => {
    const b = bed();
    const chatDb = join(b.dir, 'fixture-chat.db');
    const r = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
      env: { WEMESSAGE_LAUNCHD_LABEL: PINNED, WEMESSAGE_CHATDB: chatDb },
    });
    expect(r.code).toBe(0);
    expect(envOf(r.json<InstallJson>().plistPath)['WEMESSAGE_CHATDB']).toBe(
      chatDb,
    );
  });

  it('NEAR-MISS: with WEMESSAGE_CHATDB unset the key is ABSENT, not empty', async () => {
    // The legitimate near-miss for the row above. An empty string here
    // would be worse than an absent key: `main.ts` treats the variable as
    // optional-with-a-default, and `z.string().min(1)` would reject ''
    // outright, so a daemon installed on a machine that merely lacks the
    // variable must get a plist that does not mention it.
    const b = bed();
    const r = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
      env: { WEMESSAGE_LAUNCHD_LABEL: PINNED },
    });
    expect(r.code).toBe(0);
    const env = envOf(r.json<InstallJson>().plistPath);
    expect('WEMESSAGE_CHATDB' in env).toBe(false);
  });

  it('WEMESSAGE_LAUNCHD_THROTTLE_INTERVAL reaches the plist, and is 10 without it', async () => {
    // Row 9 needs 1: launchd will not restart a KeepAlive job sooner than
    // ThrottleInterval seconds after it died, and a 10-second floor turns
    // "the daemon came back" into a test that spends its budget waiting.
    const b1 = bed();
    const d = await cli(installArgs(b1, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
      env: { WEMESSAGE_LAUNCHD_LABEL: PINNED },
    });
    expect(
      parseLaunchAgentPlist(
        readFileSync(d.json<InstallJson>().plistPath, 'utf8'),
      )['ThrottleInterval'],
    ).toBe(10);

    const b2 = bed();
    const t = await cli(installArgs(b2, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
      env: {
        WEMESSAGE_LAUNCHD_LABEL: PINNED,
        WEMESSAGE_LAUNCHD_THROTTLE_INTERVAL: '1',
      },
    });
    expect(
      parseLaunchAgentPlist(
        readFileSync(t.json<InstallJson>().plistPath, 'utf8'),
      )['ThrottleInterval'],
    ).toBe(1);
  });

  it('PLANTED: a throttle interval that is not a positive integer is refused, not coerced', async () => {
    /*
     * `Number('')` is 0 and `Number('abc')` is NaN; both would render a
     * plist launchd reads as "restart immediately, forever" or ignores.
     * The command refuses instead, and refuses BEFORE it writes.
     *
     * SELF-TRIP. This row was first written as `.rejects.toThrow(...)`,
     * which is what a helper that throws does — and it is not what this
     * command does. `runServiceCli` catches the taxonomy error and returns
     * exit code 2 with an empty stdout, which is the whole point of having
     * a taxonomy: a refusal a caller planned for is a status, not a stack
     * trace. The row was wrong about the product, so the row changed, and
     * it is stronger for it: it now pins the exit code, the silence on
     * stdout, the variable being named on stderr, and the empty directory,
     * where before it pinned only that something was thrown.
     */
    for (const bad of ['', 'abc', '0', '-1', '1.5', '1e3', ' 1', '01']) {
      const b = bed();
      const r = await cli(installArgs(b, '--no-load'), {
        run: laneRun(fakeServiceManager().rec.spawn),
        env: {
          WEMESSAGE_LAUNCHD_LABEL: PINNED,
          WEMESSAGE_LAUNCHD_THROTTLE_INTERVAL: bad,
        },
      });
      expect(r.code).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toContain('THROTTLE_INTERVAL');
      // Refused BEFORE it wrote: G4's property, restated for this value.
      expect(readdirSync(b.la)).toEqual([]);
    }
  });
});

describe('s9 Sc3 row 7: a second install with the same content changes nothing', () => {
  it('identical content → changed:false, no rewrite, no bootout/bootstrap', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    const first = await cli(installArgs(b), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    expect(first.json<InstallJson>().changed).toBe(true);
    const plistPath = first.json<InstallJson>().plistPath;
    const bytes = readFileSync(plistPath, 'utf8');

    fake.rec.calls.length = 0;
    const second = await cli(installArgs(b), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    expect(second.json<InstallJson>().changed).toBe(false);
    expect(readFileSync(plistPath, 'utf8')).toEqual(bytes);
    // The agent is already loaded, so the second install ASKS and does
    // nothing else. One read-only verb; no bootout, no bootstrap.
    expect(fake.rec.argvs()).toEqual([['print', `gui/${U}/${PINNED}`]]);
  });

  it('different content → rewritten, and booted out before it is bootstrapped', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    await cli(installArgs(b), { run: laneRun(fake.rec.spawn), env });
    fake.rec.calls.length = 0;

    // A different port is a different EnvironmentVariables dict, which is a
    // different plist.
    const second = await cli(installArgs(b, '--port', '47999'), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    expect(second.json<InstallJson>().changed).toBe(true);
    expect(
      readFileSync(second.json<InstallJson>().plistPath, 'utf8'),
    ).toContain('47999');
    // THE ORDER THAT MATTERS: bootout, then a poll that proves the old one
    // is gone, then bootstrap. A bootstrap issued while launchd is still
    // tearing the old job down fails with an I/O error, and the failure is
    // intermittent, which is the worst kind.
    const argvs = fake.rec.argvs();
    expect(argvs[0]).toEqual(['bootout', `gui/${U}/${PINNED}`]);
    expect(argvs[1]).toEqual(['print', `gui/${U}/${PINNED}`]);
    expect(argvs[2]).toEqual([
      'bootstrap',
      `gui/${U}`,
      second.json<InstallJson>().plistPath,
    ]);
  });

  it('a rewrite is decided by CONTENT, not by mtime or by existence', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    const first = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    const p = first.json<InstallJson>().plistPath;
    // Same bytes, new mtime.
    writeFileSync(p, readFileSync(p));
    const again = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    expect(again.json<InstallJson>().changed).toBe(false);
    // Different bytes, same path.
    writeFileSync(p, `${readFileSync(p, 'utf8')}\n`);
    const third = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    expect(third.json<InstallJson>().changed).toBe(true);
  });
});

/* ── s9 Sc7 row 6: restart — bootout then bootstrap, unconditionally ──── */

describe('s9 Sc7 row 6: service restart', () => {
  it('bootout, poll, bootstrap, poll — in that order, regardless of plist content', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    const installed = await cli(installArgs(b), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    const plistPath = installed.json<InstallJson>().plistPath;
    fake.rec.calls.length = 0;

    const r = await cli(restartArgs(b), { run: laneRun(fake.rec.spawn), env });
    expect(r.code).toBe(0);
    const json = r.json<RestartJson>();
    expect(json).toEqual({ label: PINNED, plistPath, bootstrapped: true });

    // Same order as an install whose content changed (row 7 above), because
    // a restart is exactly that sequence run unconditionally: bootout, a
    // poll that proves the old job is gone, bootstrap, then a poll that
    // reports whether the new one took.
    expect(fake.rec.argvs()).toEqual([
      ['bootout', `gui/${U}/${PINNED}`],
      ['print', `gui/${U}/${PINNED}`],
      ['bootstrap', `gui/${U}`, plistPath],
      ['print', `gui/${U}/${PINNED}`],
    ]);
  });

  it('the audit row lands before anything is written to stdout (§1.8)', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    await cli(installArgs(b), { run: laneRun(fake.rec.spawn), env });
    fake.rec.calls.length = 0;

    const r = await cli(restartArgs(b), { run: laneRun(fake.rec.spawn), env });
    // Reuses `service.installed` rather than minting a new audit event type
    // (see the comment on `serviceRestart` in service.ts) — the fact
    // recorded is exactly as true after a restart as after an install.
    expect(r.order[0]).toBe('audit:service.installed');
  });

  it('refuses, without spawning anything, when nothing is installed in --dir', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const r = await cli(restartArgs(b), {
      run: laneRun(fake.rec.spawn),
      env: {},
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain('nothing installed');
    expect(fake.rec.calls).toHaveLength(0);
  });
});

/* ── rows 11 and 12: status and uninstall ─────────────────────────────── */

describe('s9 Sc3 rows 11 and 12: status, uninstall, and the second uninstall', () => {
  it('status --json reports the six fields, from the state file', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    await cli(installArgs(b), { run: laneRun(fake.rec.spawn), env });
    fake.rec.calls.length = 0;

    const st = await cli(['service', 'status', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    expect(st.code).toBe(0);
    const s = st.json<StatusJson>();
    expect(Object.keys(s).sort()).toEqual([
      'installed',
      'label',
      'lastExitStatus',
      'pid',
      'plistPath',
      'running',
    ]);
    expect(s).toEqual({
      installed: true,
      running: true,
      pid: 4242,
      label: PINNED,
      plistPath: join(b.la, `${PINNED}.plist`),
      lastExitStatus: 0,
    });
    // ONE read-only call, and no `--launch-agents-dir` was passed: the
    // label came from the state file, not from a directory listing.
    expect(fake.rec.argvs()).toEqual([['print', `gui/${U}/${PINNED}`]]);
  });

  it('uninstall removes the plist, boots out, audits, and reports', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    await cli(installArgs(b), { run: laneRun(fake.rec.spawn), env });
    fake.rec.calls.length = 0;

    const events: AuditEvent[] = [];
    const un = await cli(['service', 'uninstall', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
      events,
    });
    expect(un.code).toBe(0);
    expect(un.json<UninstallJson>()).toEqual({
      installed: false,
      changed: true,
      label: PINNED,
    });
    expect(existsSync(join(b.la, `${PINNED}.plist`))).toBe(false);
    expect(readdirSync(b.la)).toEqual([]);
    expect(existsSync(join(b.dir, SERVICE_STATE_FILENAME))).toBe(false);
    expect(events).toEqual([{ type: 'service.uninstalled', label: PINNED }]);
    expect(un.order[0]).toBe('audit:service.uninstalled');
    expect(fake.isLoaded()).toBe(false);

    // …and a status afterwards says so.
    const st = await cli(['service', 'status', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    const s = st.json<StatusJson>();
    expect(s.installed).toBe(false);
    expect(s.running).toBe(false);
  });

  it('uninstall with nothing installed exits 0 and changed:false', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const un = await cli(['service', 'uninstall', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    expect(un.code).toBe(0);
    expect(un.json<UninstallJson>()).toEqual({
      installed: false,
      changed: false,
      label: null,
    });
    // Nothing to boot out means nothing is spawned, and — the row that
    // matters — no audit row either. An idempotent no-op that appends to a
    // hash chain turns `service status` in a loop into an audit log.
    expect(fake.rec.calls).toEqual([]);
  });

  it('status with nothing installed is a report, not an error', async () => {
    const b = bed();
    const fake = fakeServiceManager();
    const st = await cli(['service', 'status', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    expect(st.code).toBe(0);
    expect(st.json<StatusJson>()).toEqual({
      installed: false,
      running: false,
      pid: null,
      label: null,
      plistPath: null,
      lastExitStatus: null,
    });
    expect(fake.rec.calls).toEqual([]);
  });
});

/* ── G4: the command line's own scoping guards ────────────────────────── */

describe('s9 Sc3 G4: the command line refuses before it writes', () => {
  it('PLANTED: a label prefix outside this project is refused', async () => {
    const b = bed();
    const foreign = ['com.', 'user.'].join('');
    const r = await cli([
      'service',
      'install',
      '--dir',
      b.dir,
      '--launch-agents-dir',
      b.la,
      '--label-prefix',
      foreign,
      '--json',
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(readdirSync(b.la)).toEqual([]);
  });

  it('PLANTED: a prefix that is ours but not one of the two is refused', async () => {
    // `sh.wemessage.staging.` is inside the namespace and is still not a
    // prefix this product installs under. The allowlist is two strings.
    const b = bed();
    const r = await cli(
      installArgs(b).map((a) =>
        a === TEST_PREFIX ? 'sh.wemessage.staging.' : a,
      ),
    );
    expect(r.code).toBe(2);
    expect(readdirSync(b.la)).toEqual([]);
  });

  it('PLANTED: under the test prefix, a --dir outside the temp root is refused', async () => {
    const b = bed();
    const r = await cli([
      'service',
      'install',
      '--dir',
      join(homedir(), 'Library', 'Application Support', 'WeMessage'),
      '--launch-agents-dir',
      b.la,
      '--label-prefix',
      TEST_PREFIX,
      '--json',
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/temp|tmp/i);
    expect(readdirSync(b.la)).toEqual([]);
  });

  it('PLANTED: under the test prefix, a --launch-agents-dir outside the temp root is refused', async () => {
    // THE ROW THIS GUARD EXISTS FOR. The path is assembled rather than
    // spelled, and nothing reads it: the refusal is decided from the
    // resolved string, so a green run of this row never touched the
    // operator's real agents directory even to ask whether it exists.
    const b = bed();
    const real = join(homedir(), 'Library', 'LaunchAgents');
    const r = await cli([
      'service',
      'install',
      '--dir',
      b.dir,
      '--launch-agents-dir',
      real,
      '--label-prefix',
      TEST_PREFIX,
      '--json',
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/temp|tmp/i);
    expect(existsSync(join(b.dir, SERVICE_STATE_FILENAME))).toBe(false);
  });

  it('PLANTED: a temp-root LOOKALIKE is refused (realpath, both sides)', async () => {
    const b = bed();
    const lookalike = `${realpathSync(tmpdir())}-not-really`;
    const r = await cli([
      'service',
      'install',
      '--dir',
      b.dir,
      '--launch-agents-dir',
      lookalike,
      '--label-prefix',
      TEST_PREFIX,
      '--json',
    ]);
    expect(r.code).toBe(2);
  });

  it('NEAR-MISS: both spellings of a real temp dir are accepted', async () => {
    // On macOS `os.tmpdir()` is `/var/folders/...` and `/var` is a symlink
    // into `/private`. A containment check on raw strings accepts a
    // legitimate directory or rejects it depending only on which spelling
    // the caller happened to hold, so both are asserted.
    const b = bed();
    const first = await cli(installArgs(b, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
    });
    expect(first.code).toBe(0);

    const b2 = { dir: realpathSync(bed().dir), la: realpathSync(tempDir()) };
    const second = await cli(installArgs(b2, '--no-load'), {
      run: laneRun(fakeServiceManager().rec.spawn),
    });
    expect(second.code).toBe(0);
  });

  it('NEAR-MISS: the production prefix is NOT constrained to the temp root', async () => {
    // A guard a legitimate caller must be exempted from is the wrong
    // guard, and the legitimate caller here is the real installer, whose
    // directories are in the operator's home by definition. The temp-root
    // rule binds the TEST prefix only. Asserted against temp directories,
    // because a green test must never be able to write into the real one.
    const b = bed();
    const r = await cli(
      [
        'service',
        'install',
        '--dir',
        b.dir,
        '--launch-agents-dir',
        b.la,
        '--label-prefix',
        'sh.wemessage.',
        '--json',
        '--no-load',
      ],
      { run: laneRun(fakeServiceManager().rec.spawn) },
    );
    expect(r.code).toBe(0);
    expect(r.json<InstallJson>().label).toBe('sh.wemessage.gateway');
  });

  it('the refusal is the taxonomy error, thrown before any write', async () => {
    const b = bed();
    await expect(
      runServiceCli(
        [
          'service',
          'install',
          '--dir',
          b.dir,
          '--launch-agents-dir',
          b.la,
          '--label-prefix',
          ['com.', 'user.'].join(''),
        ],
        { out: () => undefined, err: () => undefined },
        { uid: process.getuid?.() ?? 501, rethrow: true },
      ),
    ).rejects.toThrow(LaunchdLabelRefused);
  });

  it('status and uninstall never enumerate a LaunchAgents directory', async () => {
    // Two proofs, because either alone is weak. The behavioural one: a
    // decoy plist for a DIFFERENT label sits beside ours and is neither
    // read nor removed. The static one: neither module contains a
    // directory-listing call at all, so there is no code path that could.
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    await cli(installArgs(b), { run: laneRun(fake.rec.spawn), env });
    const decoy = join(b.la, `${TEST_PREFIX}decoy.plist`);
    writeFileSync(decoy, '<plist/>');
    fake.rec.calls.length = 0;

    await cli(['service', 'status', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    await cli(['service', 'uninstall', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    expect(existsSync(decoy)).toBe(true);
    expect(readdirSync(b.la)).toEqual([`${TEST_PREFIX}decoy.plist`]);
    expect(JSON.stringify(fake.rec.argvs())).not.toContain('decoy');

    for (const rel of ['cli.ts', 'service.ts']) {
      const src = readFileSync(join(HERE, '..', 'src', 'launchd', rel), 'utf8');
      for (const call of ['readdir', 'globSync', 'opendir'])
        expect(src.includes(call), `${rel} names ${call}`).toBe(false);
    }
  });
});

/* ── row 16: the argv transcript, reviewed as data ────────────────────── */

describe('s9 Sc3 row 16: the whole lifecycle, as a literal argv transcript', () => {
  it('install -> status -> uninstall produces exactly these five vectors', async () => {
    /*
     * THE ROW THIS STAGE EXISTS FOR.
     *
     * Every one of these strings will, in stage 2, be handed to the real
     * macOS service manager. Reviewing them as a literal list, before the
     * spawner is wired, is the difference between "we believe the argv is
     * right" and "the argv is right and here it is". Read it as a reviewer
     * would: five vectors, one domain (`gui/501`, never `system/`), one
     * label, one path, and no verb outside the five scoped ones.
     */
    const b = bed();
    const fake = fakeServiceManager();
    const env = { WEMESSAGE_LAUNCHD_LABEL: PINNED };
    const plistPath = join(b.la, `${PINNED}.plist`);

    const inst = await cli(installArgs(b), {
      run: laneRun(fake.rec.spawn),
      env,
    });
    expect(inst.json<InstallJson>().bootstrapped).toBe(true);
    await cli(['service', 'status', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });
    await cli(['service', 'uninstall', '--dir', b.dir, '--json'], {
      run: laneRun(fake.rec.spawn),
    });

    expect(fake.rec.argvs()).toEqual([
      ['bootstrap', `gui/${U}`, plistPath],
      ['print', `gui/${U}/sh.wemessage.test.01j5transcript`],
      ['print', `gui/${U}/sh.wemessage.test.01j5transcript`],
      ['bootout', `gui/${U}/sh.wemessage.test.01j5transcript`],
      ['print', `gui/${U}/sh.wemessage.test.01j5transcript`],
    ]);

    // Read as bytes, the transcript contains no root domain, no
    // whole-domain verb, and no label but ours.
    const flat = JSON.stringify(fake.rec.argvs());
    expect(flat).not.toContain('system/');
    expect(flat).not.toContain(['com.', 'user.'].join(''));
    // The ratified F-120 banned list, in full: the obvious mutators, the
    // non-obvious ones (`config`, `setenv`, `limit`, `umask`, `submit`,
    // `attach` all change state without looking like it), and the restart
    // verb, which is banned outright and forever because it is the one that
    // would restart the operator's own supervisor.
    //
    // The restart verb is ASSEMBLED rather than spelled. Arch row 4 scans
    // raw text, comments included, so a file that spells a name it is
    // asserting the absence of convicts itself -- including in a comment
    // explaining why it does not spell it. The two carriers that row does
    // exempt use this same idiom, for this same reason.
    for (const banned of [
      'attach',
      'config',
      `kick${'start'}`,
      'kill',
      'limit',
      'load',
      'remove',
      'setenv',
      'submit',
      'umask',
      'unload',
    ])
      expect(flat.includes(`"${banned}"`), banned).toBe(false);
  });
});

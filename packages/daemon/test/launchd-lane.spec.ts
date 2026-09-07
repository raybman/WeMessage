/**
 * s9 Sc3 stage 1, G3 — the test-side lane, and the four ways it refuses.
 *
 * WHAT THIS IS. Stage 2 of this scenario will, for the first time in this
 * repository, run the real macOS service manager from a test. Everything it
 * does will go through `test/helpers/launchd-lane.ts`. This file is that
 * helper's unit test, and it runs entirely against a RECORDING FAKE: stage 1
 * installs no real spawner, so every row here is a row about argv strings and
 * refusals, and not one of them can reach a service manager even if the
 * refusals were all deleted.
 *
 * WHY A LANE AND NOT A CONVENTION. The machine this runs on supervises the
 * operator's own agent — the process tree these tests execute inside. The
 * verb that would stop it is the same verb that stops ours, spelled with a
 * different label, and `bootout` has no confirmation and no undo. A code
 * review convention ("only ever use test labels") is a guard that holds until
 * somebody is tired. A function that throws is a guard that holds.
 *
 * THE FOUR REFUSALS, each with a planted offender AND a legitimate near-miss,
 * because a lane that refuses everything is not a lane:
 *   1. `testScopedSpawn` refuses a mutating verb aimed anywhere outside
 *      `sh.wemessage.test.` — BEFORE it delegates, so a lane with a real
 *      spawner behind it still creates no process.
 *   2. `sweepOwnDir` refuses a directory that is not under the temp root,
 *      comparing REALPATHS on both sides.
 *   3. `sweepOrphans` refuses to widen: it boots out only labels the service
 *      manager itself reported under our test prefix.
 *   4. `termOwnedDaemon` refuses to signal a pid that is not the pid in our
 *      own lock file, and refuses this process, its parent, anything <= 1,
 *      and the recorded sentinel.
 *
 * ONE DIVERGENCE FROM THE DISPATCH, argued at the row: the dispatch describes
 * the read-only allowance as `args[0] === 'print'`. `list` is allowed too,
 * because the ratified F-120 rule permits both read-only subcommands and
 * `sweepOrphans` is specified to obtain its labels from `list`. The allowance
 * is an explicit, asserted two-element allowlist rather than a prefix test.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asLaunchAgentLabel } from '../src/launchd/contract.js';
import { resolveBundlePaths } from '../src/launchd/paths.js';
import { isUnderTempRoot } from '../src/launchd/service.js';
import type { ServiceManagerInvocation } from '../src/launchd/contract.js';
import {
  LANE_READ_ONLY_OPS,
  LaneRefused,
  laneInvocation,
  TEST_LABEL_PREFIX,
  installLaneSpawner,
  laneRun,
  laneUid,
  mintTestLabel,
  readOnly,
  recordingSpawner,
  setLaneSentinelPid,
  sweepOrphans,
  sweepOwnDir,
  termOwnedDaemon,
  testScopedSpawn,
} from './helpers/launchd-lane.js';

/** The operator's own supervisor, assembled so no tracked file spells it. */
const OPERATORS_OWN_LABEL = ['com.', 'user.', 'sol', '-agent'].join('');

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wm-lane-'));
  dirs.push(d);
  return d;
}

/**
 * Write a plist into a directory — but only after proving the directory is
 * inside the temp root.
 *
 * THIS LINE IS LOAD-BEARING AND IT IS NOT DEFENSIVE PROGRAMMING. Two rows
 * below obtain their directory from `resolveBundlePaths`, which is exactly
 * the module the named tooth TN-real-launchagents-dir mutates so that every
 * override is ignored and the answer is always the operator's real
 * `~/Library/LaunchAgents`. Without the check, arming that tooth would not
 * merely turn a row red: the row would first plant a plist in the operator's
 * agents directory and go red afterwards. The check runs BEFORE the write,
 * so the mutation cannot coexist with a write no matter what order anyone
 * runs these rows in — safe by construction rather than by care.
 *
 * It is also a strengthening in its own right: a test that writes a plist
 * should have to say where it thinks it is writing.
 */
function plantPlist(dir: string, name: string): string {
  expect(isUnderTempRoot(dir), dir).toBe(true);
  const p = join(dir, name);
  writeFileSync(p, '<plist/>');
  return p;
}

beforeEach(() => {
  installLaneSpawner(null);
  setLaneSentinelPid(null);
});

afterEach(() => {
  installLaneSpawner(null);
  setLaneSentinelPid(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/* ── the recording fake, and the fact that nothing else is installed ──── */

describe('s9 Sc3 G3: stage 1 installs no real spawner', () => {
  it('with nothing installed, an ALLOWED invocation still creates no process', async () => {
    // The strongest single statement this stage can make. The lane's default
    // state is "there is no spawner", so even the invocation the guard would
    // wave through dies at the seam rather than at the service manager.
    await expect(readOnly.list()).rejects.toThrow(/no spawner/i);
  });

  it('the read-only allowlist is exactly two verbs, named', async () => {
    expect([...LANE_READ_ONLY_OPS]).toEqual(['list', 'print']);
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await readOnly.list();
    await readOnly.print(asLaunchAgentLabel(`${TEST_LABEL_PREFIX}alpha`));
    expect(rec.argvs()).toEqual([
      ['list'],
      ['print', `gui/${String(laneUid())}/${TEST_LABEL_PREFIX}alpha`],
    ]);
  });

  it('a minted test label is lowercase and in the test namespace', () => {
    // The daemon's id generator returns UPPERCASE Crockford base32, which
    // the label grammar (lowercase alphanumerics and hyphens) rejects. That
    // is a real trap: `sh.wemessage.test.${ulid()}` throws, and it throws in
    // the helper every future launchd test will call first.
    const a = mintTestLabel();
    const b = mintTestLabel();
    expect(a).not.toBe(b);
    expect(a.startsWith(TEST_LABEL_PREFIX)).toBe(true);
    expect(a).toBe(a.toLowerCase());
    expect(asLaunchAgentLabel(a)).toBe(a);
  });
});

/* ── refusal 1: testScopedSpawn ───────────────────────────────────────── */

describe('s9 Sc3 G3 refusal 1: the lane refuses before it delegates', () => {
  /*
   * Built by hand rather than through the runner, because the point of this
   * guard is to catch an argv the runner never built. The invocation is
   * assembled by the lane helper: the binary's name is spelled in exactly
   * two files in this repository, and a spec that spelled it would make a
   * third — which the arch guard's second leg would (correctly) fail on.
   */
  const invocation = (...args: string[]): ServiceManagerInvocation =>
    laneInvocation(args);

  it('PLANTED: a bootout aimed at the operator supervisor is refused, undelegated', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await expect(
      testScopedSpawn(invocation('bootout', `gui/501/${OPERATORS_OWN_LABEL}`)),
    ).rejects.toThrow(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: a bootout aimed at our own PRODUCTION label is refused too', async () => {
    // The label this project installs for real is not a test label. A lane
    // that boots it out would leave the operator's gateway stopped after a
    // green test run, which is a smaller disaster than the one above and
    // still a disaster.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await expect(
      testScopedSpawn(invocation('bootout', 'gui/501/sh.wemessage.gateway')),
    ).rejects.toThrow(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: a bootstrap of a plist whose basename is not test-scoped is refused', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await expect(
      testScopedSpawn(
        invocation('bootstrap', 'gui/501', '/tmp/sh.wemessage.gateway.plist'),
      ),
    ).rejects.toThrow(LaneRefused);
    // And the directory-shaped argument, which is the inherited defect this
    // stage also fixes one layer down: a bootstrap given a DIRECTORY loads
    // every plist in it.
    await expect(
      testScopedSpawn(invocation('bootstrap', 'gui/501', '/tmp')),
    ).rejects.toThrow(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: a verb outside the allowlist is refused even when test-scoped', async () => {
    // The banned-outright verb is not in the runner's union, so the only way
    // it reaches a spawn is a hand-built argv — which is exactly what this
    // guard reads. Spelled from fragments so no tracked file contains it.
    const banned = ['kick', 'start'].join('');
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await expect(
      testScopedSpawn(invocation(banned, `gui/501/${TEST_LABEL_PREFIX}alpha`)),
    ).rejects.toThrow(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: the supervisor label anywhere in the argv is refused, in any position', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    for (const argv of [
      ['print', `gui/501/${OPERATORS_OWN_LABEL}`],
      ['list', OPERATORS_OWN_LABEL],
      ['bootstrap', 'gui/501', `/tmp/${OPERATORS_OWN_LABEL}.plist`],
    ]) {
      await expect(
        testScopedSpawn(invocation(...argv)),
        argv.join(' '),
      ).rejects.toThrow(LaneRefused);
    }
    expect(rec.calls).toEqual([]);
  });

  it('NEAR-MISS: the legitimate mutating calls DO delegate', async () => {
    // Without this row every assertion above is satisfied by `throw` on line
    // one, and stage 2 would have a lane that cannot install anything.
    const label = `${TEST_LABEL_PREFIX}beta`;
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await testScopedSpawn(invocation('bootout', `gui/501/${label}`));
    await testScopedSpawn(invocation('enable', `gui/501/${label}`));
    await testScopedSpawn(invocation('disable', `gui/501/${label}`));
    await testScopedSpawn(
      invocation('bootstrap', 'gui/501', `/tmp/${label}.plist`),
    );
    expect(rec.argvs()).toEqual([
      ['bootout', `gui/501/${label}`],
      ['enable', `gui/501/${label}`],
      ['disable', `gui/501/${label}`],
      ['bootstrap', 'gui/501', `/tmp/${label}.plist`],
    ]);
  });

  it('NEAR-MISS: a read-only print of a NON-test label of ours is allowed', async () => {
    // Read-only verbs are inert, and stage 2 needs to be able to ask
    // whether the production agent is loaded without being allowed to
    // change the answer.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await testScopedSpawn(invocation('print', 'gui/501/sh.wemessage.gateway'));
    expect(rec.argvs()).toEqual([['print', 'gui/501/sh.wemessage.gateway']]);
  });

  it('the refusal happens even when NO spawner is installed', async () => {
    // Ordering, stated as a row: the guard runs before the delegate is
    // looked up, so "refused" and "no spawner" are distinguishable and the
    // guard is not accidentally load-bearing on the delegate existing.
    await expect(
      testScopedSpawn(invocation('bootout', `gui/501/${OPERATORS_OWN_LABEL}`)),
    ).rejects.toThrow(LaneRefused);
  });
});

/* ── refusal 2: sweepOwnDir ───────────────────────────────────────────── */

describe('s9 Sc3 G3 refusal 2 (plan row 14): the sweep stays in its own dir', () => {
  it('PLANTED: the real LaunchAgents directory is refused, not swept', async () => {
    // The path is OBTAINED, not spelled: it is whatever the installer would
    // choose with nothing overridden, which is also what makes this row and
    // the near-miss below the pair the directory tooth bites. Nothing reads
    // it — the refusal is decided from the resolved string alone, so a green
    // run of this row never touched the operator's agents directory even to
    // ask whether it exists.
    await expect(
      sweepOwnDir(resolveBundlePaths({}).launchAgentsDir),
    ).rejects.toThrow(LaneRefused);
  });

  it('PLANTED: a sibling of the temp root is refused', async () => {
    await expect(sweepOwnDir('/etc')).rejects.toThrow(LaneRefused);
    await expect(
      sweepOwnDir(`${realpathSync(tmpdir())}-not-really`),
    ).rejects.toThrow(LaneRefused);
  });

  it('NEAR-MISS: the SAME directory reached by its unresolved name is swept', async () => {
    // THE ROW THAT PAYS FOR THE REALPATH. On macOS `os.tmpdir()` reports
    // `/var/folders/...`, and `/var` is a symlink to `/private/var`. Compare
    // the raw strings and a legitimate temp directory looks foreign exactly
    // half the time, depending on which of the two spellings the caller
    // happened to have. Both spellings are swept here.
    const d = resolveBundlePaths({
      WEMESSAGE_LAUNCH_AGENTS_DIR: tempDir(),
    }).launchAgentsDir;
    plantPlist(d, `${TEST_LABEL_PREFIX}gamma.plist`);
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    const swept = await sweepOwnDir(d);
    expect(swept).toEqual([`${TEST_LABEL_PREFIX}gamma`]);
    expect(readdirSync(d)).toEqual([]);
    expect(rec.argvs()).toEqual([
      ['bootout', `gui/${String(laneUid())}/${TEST_LABEL_PREFIX}gamma`],
    ]);
    // …and the resolved spelling of the very same directory.
    const d2 = tempDir();
    plantPlist(d2, `${TEST_LABEL_PREFIX}delta.plist`);
    installLaneSpawner(recordingSpawner().spawn);
    expect(await sweepOwnDir(realpathSync(d2))).toEqual([
      `${TEST_LABEL_PREFIX}delta`,
    ]);
  });

  it('PLANTED: a foreign plist inside our own temp dir is refused, not deleted', async () => {
    // Containment is necessary and not sufficient. A temp directory that
    // somehow holds a plist we did not name is a broken assumption, and the
    // lane stops rather than guessing.
    const d = tempDir();
    plantPlist(d, `${OPERATORS_OWN_LABEL}.plist`);
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    await expect(sweepOwnDir(d)).rejects.toThrow(LaneRefused);
    expect(readdirSync(d)).toEqual([`${OPERATORS_OWN_LABEL}.plist`]);
    expect(rec.calls).toEqual([]);
  });

  it('NEAR-MISS: non-plist files in the directory are left alone', async () => {
    const d = tempDir();
    expect(isUnderTempRoot(d), d).toBe(true);
    writeFileSync(join(d, 'service.json'), '{}');
    plantPlist(d, `${TEST_LABEL_PREFIX}eps.plist`);
    installLaneSpawner(recordingSpawner().spawn);
    expect(await sweepOwnDir(d)).toEqual([`${TEST_LABEL_PREFIX}eps`]);
    expect(readdirSync(d)).toEqual(['service.json']);
  });

  it('an empty temp directory sweeps to nothing and spawns nothing', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    expect(await sweepOwnDir(tempDir())).toEqual([]);
    expect(rec.calls).toEqual([]);
  });
});

/* ── refusal 3: sweepOrphans ──────────────────────────────────────────── */

describe('s9 Sc3 G3 refusal 3: the orphan sweep cannot widen', () => {
  const LIST_OUTPUT = [
    'PID\tStatus\tLabel',
    '-\t0\t' + OPERATORS_OWN_LABEL,
    '901\t0\tsh.wemessage.gateway',
    '902\t0\t' + TEST_LABEL_PREFIX + 'orphan-one',
    '-\t0\t' + TEST_LABEL_PREFIX + 'orphan-two',
    '903\t0\tsh.wemessage.testing.not-a-test',
    '',
  ].join('\n');

  it('only the test-prefixed labels are booted out, and each one individually', async () => {
    const rec = recordingSpawner((i) =>
      i.args[0] === 'list'
        ? { code: 0, stdout: LIST_OUTPUT, stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    installLaneSpawner(rec.spawn);
    const uid = String(laneUid());
    expect(await sweepOrphans()).toEqual([
      `${TEST_LABEL_PREFIX}orphan-one`,
      `${TEST_LABEL_PREFIX}orphan-two`,
    ]);
    expect(rec.argvs()).toEqual([
      ['list'],
      ['bootout', `gui/${uid}/${TEST_LABEL_PREFIX}orphan-one`],
      ['bootout', `gui/${uid}/${TEST_LABEL_PREFIX}orphan-two`],
    ]);
    // NON-VACUITY, and the whole point: three labels were on the list that
    // are not ours, including one whose prefix is a STRING prefix of ours
    // (`sh.wemessage.testing.`) and would have been swept by `startsWith`.
    const transcript = JSON.stringify(rec.argvs());
    expect(transcript).not.toContain(OPERATORS_OWN_LABEL);
    expect(transcript).not.toContain('sh.wemessage.gateway');
    expect(transcript).not.toContain('testing');
  });

  it('a list that fails is an error, not an empty sweep', async () => {
    // Silence is the dangerous answer here: an orphan sweep that reports
    // "nothing to do" because it could not ask leaves agents loaded and
    // tells the next run everything is clean.
    const rec = recordingSpawner(() => ({
      code: 1,
      stdout: '',
      stderr: 'boom',
    }));
    installLaneSpawner(rec.spawn);
    await expect(sweepOrphans()).rejects.toThrow(/list/i);
  });
});

/* ── refusal 4: termOwnedDaemon ───────────────────────────────────────── */

describe('s9 Sc3 G3 refusal 4: the only real signal in any launchd spec', () => {
  const LABEL = asLaunchAgentLabel(`${TEST_LABEL_PREFIX}zeta`);
  const printing = (pid: number | null) =>
    recordingSpawner(() => ({
      code: 0,
      stdout:
        pid === null
          ? `${LABEL} = {\n\tstate = not running\n}\n`
          : `${LABEL} = {\n\tpid = ${String(pid)}\n\tstate = running\n}\n`,
      stderr: '',
    }));

  function lockedDir(pid: number): string {
    const d = tempDir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'daemon.lock'), `${String(pid)}\n`);
    return d;
  }

  it('PLANTED: a pid that disagrees with our lock file is refused', async () => {
    // THE ROW. `print` reports whatever launchd has under that label. The
    // lock file reports what OUR daemon wrote about itself. Signalling on
    // the strength of one of those alone is signalling a pid a stranger
    // chose. They must agree.
    installLaneSpawner(printing(4242).spawn);
    await expect(termOwnedDaemon(lockedDir(4243), LABEL)).rejects.toThrow(
      LaneRefused,
    );
  });

  it('PLANTED: this process, its parent, pid 1 and pid 0 are all refused', async () => {
    for (const pid of [process.pid, process.ppid, 1, 0, -1]) {
      installLaneSpawner(printing(pid).spawn);
      await expect(
        termOwnedDaemon(lockedDir(pid), LABEL),
        String(pid),
      ).rejects.toThrow(LaneRefused);
    }
  });

  it('PLANTED: the recorded sentinel pid is refused even if the lock agrees', async () => {
    // The sentinel is the pid of the process tree these tests execute
    // inside. A lock file that named it would be a lock file we should not
    // believe, and believing it is the single worst outcome available to
    // this scenario.
    setLaneSentinelPid(4242);
    installLaneSpawner(printing(4242).spawn);
    await expect(termOwnedDaemon(lockedDir(4242), LABEL)).rejects.toThrow(
      LaneRefused,
    );
  });

  it('PLANTED: a missing lock file is a refusal, not a fallback to the print pid', async () => {
    installLaneSpawner(printing(4242).spawn);
    await expect(termOwnedDaemon(tempDir(), LABEL)).rejects.toThrow(
      LaneRefused,
    );
  });

  it('a label that is not loaded is reported absent, and nothing is signalled', async () => {
    const rec = recordingSpawner(() => ({
      code: 113,
      stdout: '',
      stderr: 'Could not find service',
    }));
    installLaneSpawner(rec.spawn);
    expect(await termOwnedDaemon(lockedDir(4242), LABEL)).toBe('absent');
    expect(rec.argvs()).toEqual([
      ['print', `gui/${String(laneUid())}/${LABEL}`],
    ]);
  });

  it('a loaded label with no pid is absent too', async () => {
    installLaneSpawner(printing(null).spawn);
    expect(await termOwnedDaemon(lockedDir(4242), LABEL)).toBe('absent');
  });

  it('NEAR-MISS: an agreeing pid IS signalled, through the injected signal', async () => {
    // The signal is injected so this row proves the DECISION without
    // sending anything. The one real `process.kill` with a real signal in
    // this scenario is the helper's default, exercised only in stage 2
    // against a daemon this lane started itself.
    installLaneSpawner(printing(4242).spawn);
    const sent: Array<[number, NodeJS.Signals]> = [];
    expect(
      await termOwnedDaemon(lockedDir(4242), LABEL, {
        signal: (pid, sig) => sent.push([pid, sig]),
      }),
    ).toBe('signalled');
    expect(sent).toEqual([[4242, 'SIGTERM']]);
  });

  it('a foreign label cannot even be asked about', async () => {
    installLaneSpawner(printing(4242).spawn);
    await expect(
      termOwnedDaemon(
        lockedDir(4242),
        OPERATORS_OWN_LABEL as unknown as typeof LABEL,
      ),
    ).rejects.toThrow();
  });
});

/* ── the runner binding the lane hands to product code ────────────────── */

describe('s9 Sc3 G3: laneRun is the runner, not a second implementation', () => {
  it('every op goes through the real guard, and a foreign label still throws', () => {
    const rec = recordingSpawner();
    const run = laneRun(rec.spawn);
    expect(() =>
      run(
        'bootout',
        OPERATORS_OWN_LABEL as unknown as ReturnType<typeof asLaunchAgentLabel>,
        {},
      ),
    ).toThrow();
    expect(rec.calls).toEqual([]);
  });
});

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
 *      own lock file, and refuses this process, anything in its ancestry,
 *      anything <= 1, and the recorded sentinel.
 *
 * STAGE 1b ADDED TWO GROUPS OF ROWS, both for holes found by reading the
 * guard rather than by it failing, and both closed while the delegate is
 * still `null`:
 *
 *   - the argv that referenced NOTHING. Every check in refusal 1 was
 *     per-argument, and `['bootout', 'gui/<uid>']` has no argument that
 *     references a label — so nothing refused it, and a domain with no
 *     service is not a smaller operation than one agent but the whole GUI
 *     domain.
 *   - ANCESTRY, not parentage. `process.ppid` is one hop; under vitest the
 *     process it would be worst to signal is three or four.
 *
 * ONE DIVERGENCE FROM THE DISPATCH, argued at the row: the dispatch describes
 * the read-only allowance as `args[0] === 'print'`. `list` is allowed too,
 * because the ratified F-120 rule permits both read-only subcommands and
 * `sweepOrphans` is specified to obtain its labels from `list`. The allowance
 * is an explicit, asserted two-element allowlist rather than a prefix test.
 */
import { spawn } from 'node:child_process';
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
  LANE_MUTATING_OPS,
  LANE_READ_ONLY_OPS,
  LaneRefused,
  laneAncestry,
  laneInvocation,
  TEST_LABEL_PREFIX,
  installLaneSpawner,
  laneRun,
  laneUid,
  mintTestLabel,
  readOnly,
  recordingSpawner,
  setLaneSentinelLabel,
  setLaneSentinelPid,
  laneSentinelLabel,
  laneJournal,
  resetLaneJournal,
  launchAgentsTripwire,
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
  setLaneSentinelLabel(null);
  resetLaneJournal();
});

afterEach(() => {
  installLaneSpawner(null);
  setLaneSentinelPid(null);
  setLaneSentinelLabel(null);
  resetLaneJournal();
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

  /* ── stage 1b: the argv that referenced nothing, and so refused nothing ── */

  it('PLANTED: a mutating verb aimed at a BARE DOMAIN is refused, undelegated', async () => {
    // THE ROW THIS FIX EXISTS FOR. Before stage 1b every check in the guard
    // was per-argument, and `gui/<uid>` is an argument that references no
    // label — so the loop found nothing to object to and the argv reached
    // the delegate. It is not a narrower operation than booting out one
    // agent. A domain with no service IS the whole domain, and removing the
    // operator's GUI domain logs them out of the machine they are working
    // on. Inert in stage 1 (the delegate is a recording fake); wired to a
    // real spawner in stage 2, which is why it closes now.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    const uid = String(laneUid());
    await expect(
      testScopedSpawn(invocation('bootout', `gui/${uid}`)),
    ).rejects.toThrow(LaneRefused);
    // …and the refusal SAYS what it is refusing, because the next person to
    // read it will be reading it at the moment they wrote the argv.
    await expect(
      testScopedSpawn(invocation('bootout', `gui/${uid}`)),
    ).rejects.toThrow(/whole GUI domain/);
    // The trailing-slash spelling, which is the one the manual's own example
    // for a domain target uses, and therefore the one an interpolated
    // `gui/${uid}/${label}` collapses to when `label` comes back empty.
    await expect(
      testScopedSpawn(invocation('bootout', `gui/${uid}/`)),
    ).rejects.toThrow(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: a mutating verb with NO arguments at all is refused', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    for (const verb of LANE_MUTATING_OPS)
      await expect(testScopedSpawn(invocation(verb)), verb).rejects.toThrow(
        LaneRefused,
      );
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: a mutating verb whose only arguments are FLAGS is refused', async () => {
    // `referencedLabel` answers null for anything starting with `-`, which
    // is correct on its own terms and was the second way to reach the
    // delegate having referenced nothing.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    for (const argv of [
      ['bootout', '-w'],
      ['enable', '--force'],
      ['disable', '-'],
      ['bootstrap', '-w', '--force'],
    ])
      await expect(
        testScopedSpawn(invocation(...argv)),
        argv.join(' '),
      ).rejects.toThrow(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('EVERY no-label argument form is refused for EVERY mutating verb', async () => {
    // The enumeration as a row rather than as a claim in a report. These are
    // the three shapes `referencedLabel` maps to null — a bare domain, a
    // flag, and an argument that is not there — crossed with the whole
    // mutating class, because the rule is about the verb class and not about
    // the one verb whose domain-wide form is most expensive.
    expect([...LANE_MUTATING_OPS]).toEqual([
      'bootstrap',
      'bootout',
      'enable',
      'disable',
    ]);
    const uid = String(laneUid());
    const NO_LABEL_FORMS: readonly string[][] = [
      [], // not there at all
      [`gui/${uid}`], // a domain, not a target
      ['-w'], // a short flag
      ['--force'], // a long flag
      ['-'], // a lone dash
      ['-w', `gui/${uid}`], // both, together, still nothing
    ];
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    let refusals = 0;
    for (const verb of LANE_MUTATING_OPS)
      for (const form of NO_LABEL_FORMS) {
        await expect(
          testScopedSpawn(invocation(verb, ...form)),
          [verb, ...form].join(' '),
        ).rejects.toThrow(LaneRefused);
        refusals += 1;
      }
    // NON-VACUITY: the loops ran, and none of the 24 reached the delegate.
    expect(refusals).toBe(LANE_MUTATING_OPS.length * NO_LABEL_FORMS.length);
    expect(refusals).toBe(24);
    expect(rec.calls).toEqual([]);
  });

  it('NEAR-MISS: the legitimate bootstrap shape, with a REAL temp plist, passes', async () => {
    // THE ROW THAT PAYS FOR THE RULE BEING THE RIGHT RULE. `bootstrap` is
    // the one legitimate shape whose first argument is a bare domain, and it
    // is not exempted from anything: it references exactly one label, from
    // the plist's basename, and that label is test-scoped. If this row had
    // gone red the answer would have been to fix the rule, never to carve
    // `bootstrap` out of it.
    const d = tempDir();
    const label = `${TEST_LABEL_PREFIX}x`;
    const plist = plantPlist(d, `${label}.plist`);
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    const domain = `gui/${String(laneUid())}`;
    await testScopedSpawn(invocation('bootstrap', domain, plist));
    expect(rec.argvs()).toEqual([['bootstrap', domain, plist]]);
  });

  it('NEAR-MISS: the read-only verbs keep their old rule, target or not', async () => {
    // `list` legitimately has no target, and a question with no target
    // changes nothing — so the non-empty rule is scoped to mutating verbs
    // and this row is what says so.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    const target = `gui/${String(laneUid())}/${TEST_LABEL_PREFIX}x`;
    await testScopedSpawn(invocation('list'));
    await testScopedSpawn(invocation('print', target));
    expect(rec.argvs()).toEqual([['list'], ['print', target]]);
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

// teeth: TN-real-launchagents-dir (row 14): resolving every path to the real ~/Library/LaunchAgents made the sweep accept it; this row failed, and so did all four rows of Sc3 row 6. Reverted.
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

  /* ── stage 1b: ancestry, not merely parentage ────────────────────────── */

  it('the ancestry walk is bounded, and answers "unknown" in four ways', () => {
    // Proved against tables this row wrote, so the shape of whatever tree
    // the run happens to be inside cannot make it pass or fail.
    expect(
      laneAncestry(
        100,
        new Map([
          [100, 90],
          [90, 80],
          [80, 1],
        ]),
      ),
    ).toEqual([100, 90, 80, 1]);
    // a link we cannot see
    expect(laneAncestry(100, new Map([[100, 90]]))).toBeNull();
    // no table at all (the `ps` snapshot failed)
    expect(laneAncestry(100, null)).toBeNull();
    // a cycle, which cannot happen and is therefore a table to disbelieve
    expect(
      laneAncestry(
        100,
        new Map([
          [100, 90],
          [90, 100],
        ]),
      ),
    ).toBeNull();
    // deeper than the ceiling: unknown, not "far enough"
    const deep = new Map<number, number>();
    for (let p = 1000; p > 800; p -= 1) deep.set(p, p - 1);
    expect(laneAncestry(1000, deep)).toBeNull();
  });

  it('the real chain above this process is LONGER than one hop', () => {
    // NON-VACUITY for every row below: if the chain were `[self, ppid]` the
    // ancestry rule would add nothing the parent check did not already have.
    const chain = laneAncestry();
    expect(
      chain,
      'this machine must be able to answer the ancestry question',
    ).not.toBeNull();
    const c = chain ?? [];
    expect(c[0]).toBe(process.pid);
    expect(c[1]).toBe(process.ppid);
    expect(c.length).toBeGreaterThan(2);
    expect(c[c.length - 1]).toBeLessThanOrEqual(1);
  });

  it('PLANTED: an ancestor TWO OR MORE hops up is refused, lock agreement and all', async () => {
    // THE ROW. Constructed against a REAL ancestor of this very process,
    // read out of the real process table rather than reasoned about: `c[2]`
    // is the process that started the process that started this one, which
    // under vitest is the runner's own parent. Every pre-existing check is
    // stepped around deliberately — the pid is above 1, is not this process
    // and is not its parent, the lock file agrees with `print`, and no
    // sentinel is set — so a green row here can only be the new rule biting.
    //
    // THE SIGNAL IS INJECTED, and in this row that is not a convenience. The
    // target is a live process that supervises this test run. If the guard
    // were broken, an injected signal makes the failure a red row; a real
    // one would make it an ended session.
    const chain = laneAncestry();
    expect(chain).not.toBeNull();
    const c = chain ?? [];
    const target = c
      .slice(2)
      .find((p) => p > 1 && p !== process.pid && p !== process.ppid);
    expect(
      target,
      `ancestry ${c.join(' < ')} has no grandparent above pid 1`,
    ).toBeDefined();
    const pid = target ?? 0;
    installLaneSpawner(printing(pid).spawn);
    const sent: Array<[number, NodeJS.Signals]> = [];
    await expect(
      termOwnedDaemon(lockedDir(pid), LABEL, {
        signal: (p, s) => sent.push([p, s]),
      }),
    ).rejects.toThrow(/ancestor/);
    expect(sent).toEqual([]);
  });

  it('PLANTED: an ancestry that cannot be read is a refusal, not a shrug', async () => {
    // The `lock.ts:22` rule, aimed the other way. There an unrecognised
    // errno resolves towards "alive" because leaving a lock alone is the
    // recoverable failure. Here an unreadable chain resolves towards "do not
    // signal", because failing to stop a test daemon is the recoverable one.
    installLaneSpawner(printing(4242).spawn);
    const sent: Array<[number, NodeJS.Signals]> = [];
    await expect(
      termOwnedDaemon(lockedDir(4242), LABEL, {
        ancestry: () => null,
        signal: (p, s) => sent.push([p, s]),
      }),
    ).rejects.toThrow(/could not be read/);
    expect(sent).toEqual([]);
  });

  it('NEAR-MISS: containment, not proximity — a pid beside the chain passes', async () => {
    // A guard that refused anything NEAR an ancestor would refuse half the
    // pids on the machine and stage 2 would be unable to stop its own
    // daemon. The chain is injected so this row asserts the rule rather
    // than the shape of the tree it is running in.
    const chain: readonly number[] = [4240, 4241, 4242];
    installLaneSpawner(printing(4243).spawn);
    const sent: Array<[number, NodeJS.Signals]> = [];
    expect(
      await termOwnedDaemon(lockedDir(4243), LABEL, {
        ancestry: () => chain,
        signal: (p, s) => sent.push([p, s]),
      }),
    ).toBe('signalled');
    expect(sent).toEqual([[4243, 'SIGTERM']]);
    // …and the member one below it, which differs by a single digit, is not.
    installLaneSpawner(printing(4242).spawn);
    await expect(
      termOwnedDaemon(lockedDir(4242), LABEL, {
        ancestry: () => chain,
        signal: (p, s) => sent.push([p, s]),
      }),
    ).rejects.toThrow(/ancestor/);
    expect(sent).toEqual([[4243, 'SIGTERM']]); // nothing further was sent
  });

  it('NEAR-MISS: a GENUINE child daemon whose lock names it is really signalled', async () => {
    // The only real signal in this file, and it goes to a process spawned
    // four lines above it — a descendant, never an ancestor, and one this
    // task owns end to end. Every other row proves the DECISION through an
    // injected signal; this one proves the whole path, ancestry walk
    // included, against a pid that actually exists.
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000);'],
      { stdio: 'ignore' },
    );
    const exited = new Promise<NodeJS.Signals | null>((ok) => {
      child.once('exit', (_code, sig) => ok(sig));
    });
    await new Promise<void>((ok) => {
      child.once('spawn', () => ok());
    });
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    try {
      // Non-vacuity: the thing we are about to signal is NOT an ancestor,
      // so the near-miss is a near-miss and not a different case entirely.
      expect((laneAncestry() ?? []).includes(pid)).toBe(false);
      installLaneSpawner(printing(pid).spawn);
      expect(await termOwnedDaemon(lockedDir(pid), LABEL)).toBe('signalled');
      expect(await exited).toBe('SIGTERM');
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
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

/* ── stage 2: the registered sentinel, the journal, the tripwire ──────── */

describe('s9 Sc3 stage 2: the one foreign agent this lane can see', () => {
  /*
   * F-120's runtime half needs the lane to READ one label it does not own —
   * the agent supervising the run — so that `afterAll` can prove the run
   * left it exactly as it found it. The obvious ways to get that are both
   * wrong: a second test-side module doing a raw print is refused by
   * arch row 5's pinned namer list, and widening the read-only guard to
   * "any label" leaves a guard that says nothing.
   *
   * So it is a SET OF ONE. Exactly one foreign label may be registered, it
   * may only be read, and registering it is also what arms the pid refusal
   * in `termOwnedDaemon`. The property, in the words it should be checked
   * against: THE ONE FOREIGN AGENT THIS LANE CAN SEE IS PRECISELY THE ONE
   * FOREIGN AGENT IT CAN NEVER TOUCH.
   */
  const FOREIGN = 'com.example.not-the-sentinel';

  it('the one foreign agent this lane can see is precisely the one it can never touch', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    setLaneSentinelLabel(OPERATORS_OWN_LABEL);
    expect(laneSentinelLabel()).toBe(OPERATORS_OWN_LABEL);

    // SEEN: a read-only verb aimed at it is delegated.
    await testScopedSpawn(
      laneInvocation([
        'print',
        `gui/${String(laneUid())}/${OPERATORS_OWN_LABEL}`,
      ]),
    );
    expect(rec.calls.length).toBe(1);

    // NEVER TOUCHED: every mutating verb aimed at the same label refuses,
    // and refuses before the delegate is consulted.
    for (const verb of LANE_MUTATING_OPS) {
      await expect(
        testScopedSpawn(
          laneInvocation([
            verb,
            `gui/${String(laneUid())}/${OPERATORS_OWN_LABEL}`,
          ]),
        ),
      ).rejects.toBeInstanceOf(LaneRefused);
    }
    // Non-vacuity on the count: the read got through, the mutations did not.
    expect(rec.calls.length).toBe(1);
    expect(LANE_MUTATING_OPS.length).toBeGreaterThan(0);
  });

  it('PLANTED: a DIFFERENT foreign label is still refused, even read-only', async () => {
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    setLaneSentinelLabel(OPERATORS_OWN_LABEL);
    for (const verb of LANE_READ_ONLY_OPS) {
      if (verb === 'list') continue; // takes a domain, not a label
      await expect(
        testScopedSpawn(
          laneInvocation([verb, `gui/${String(laneUid())}/${FOREIGN}`]),
        ),
      ).rejects.toBeInstanceOf(LaneRefused);
    }
    expect(rec.calls).toEqual([]);
  });

  it('PLANTED: with NOTHING registered, even the sentinel label is refused', async () => {
    // The allowance is the registration, not the string. A run that forgot
    // to resolve a sentinel gets the ordinary refusal.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    expect(laneSentinelLabel()).toBe(null);
    await expect(
      testScopedSpawn(
        laneInvocation([
          'print',
          `gui/${String(laneUid())}/${OPERATORS_OWN_LABEL}`,
        ]),
      ),
    ).rejects.toBeInstanceOf(LaneRefused);
    expect(rec.calls).toEqual([]);
  });

  it('NEAR-MISS: registering a sentinel does not widen what the lane may own', async () => {
    // The registration is a read allowance, nothing more. `isTestScoped` is
    // untouched, so an ordinary foreign mutation is refused exactly as it
    // was before any sentinel existed.
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    setLaneSentinelLabel(OPERATORS_OWN_LABEL);
    await expect(
      testScopedSpawn(
        laneInvocation(['bootout', `gui/${String(laneUid())}/${FOREIGN}`]),
      ),
    ).rejects.toBeInstanceOf(LaneRefused);
    // …while a label we DO own still passes, so the row is not vacuous.
    await testScopedSpawn(
      laneInvocation([
        'bootout',
        `gui/${String(laneUid())}/${mintTestLabel()}`,
      ]),
    );
    expect(rec.calls.length).toBe(1);
  });
});

describe('s9 Sc3 stage 2: the journal records what actually ran', () => {
  it('only invocations that survived every refusal are journalled', async () => {
    /*
     * The journal exists so a report can state the exact argv this run
     * handed to the machine, rather than the argv it meant to. It is
     * written on the last line before the delegate, so a refused
     * invocation — which never reaches a delegate — is never recorded as
     * having run. That ordering is the whole value of the thing.
     */
    const rec = recordingSpawner();
    installLaneSpawner(rec.spawn);
    const label = mintTestLabel();
    const good = ['bootout', `gui/${String(laneUid())}/${label}`];

    await expect(
      testScopedSpawn(laneInvocation(['bootout', `gui/${String(laneUid())}`])),
    ).rejects.toBeInstanceOf(LaneRefused);
    expect(laneJournal()).toEqual([]);

    await testScopedSpawn(laneInvocation(good));
    expect(laneJournal()).toEqual([good]);
    // The journal is a COPY: a caller cannot edit the record of what ran.
    const snapshot = laneJournal();
    (snapshot as unknown as string[][])[0]?.splice(0);
    expect(laneJournal()).toEqual([good]);
  });
});

describe('s9 Sc3 stage 2 / F-120: the tripwire returns a hash, never the names', () => {
  it('the return type is the guard, and the value is stable across two reads', () => {
    /*
     * The only permitted contact with the operator's real LaunchAgents
     * directory in this entire scenario is a listing folded to a digest.
     * THE RETURN TYPE IS THE GUARD: a helper that returned the names would
     * be a helper somebody iterates, and iterating that directory is one
     * short step from bootstrapping it — which loads all 40-odd plists in
     * it. A 40-character hex string cannot be iterated into a mistake.
     */
    const a = launchAgentsTripwire();
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(launchAgentsTripwire()).toBe(a);
  });
});

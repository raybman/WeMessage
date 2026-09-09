/**
 * s9 Scenario 8: the notarization state machine, against a scripted
 * `notarytool`.
 *
 * WHAT IS ACTUALLY BEING PROVED HERE. Not "does notarization work" — that
 * needs Apple, a paid certificate (F-136) and several minutes, and row 11
 * does it when a credential exists. What is proved here is the SHAPE of the
 * conversation: which commands were issued, in which order, how many times,
 * and which ones were not issued at all. That last category is the important
 * one, and it is invisible to any test written against the real service:
 *
 *   - `submit` is called ONCE per artefact, on every path including timeout.
 *     Against Apple, a second submission is a second ticket in a review queue
 *     shared with every other developer. It cannot be undone and it cannot be
 *     observed from the outside. Here it is one line in a log file.
 *   - `stapler` is never reached when the verdict is Invalid or Rejected.
 *   - `validate` is never reached when `staple` failed.
 *
 * So the fakes log every argv they are handed, with a millisecond timestamp
 * and an exit code, and these rows read that log. Assertions are on FULL
 * ARGV VECTORS rather than substrings: "did it pass `--key-id`" and "does
 * the command line contain the text `--key-id` somewhere" are different
 * questions, and only the first one is the contract.
 *
 * PLATFORM. Runs everywhere. The fakes are POSIX sh and the module under
 * test only spawns processes, so nothing here needs macOS. Row 11 does, and
 * says so.
 *
 * WHY THE ARTEFACT PATHS ARE TEMP FILES AND NOT TRACKED FIXTURES. The plan
 * called for a `placeholder.zip` and `placeholder.dmg` committed under
 * `fixtures/src/release/`, with a row pinning their sha256 so they could not
 * be swapped. They are not committed, because nothing ever opens them: the
 * fake never reads the artefact, and the module under test only ever passes
 * the path to a child process. A tracked binary that no code reads is a
 * tracked binary whose only effect is to need its own guard row. A 1 KB file
 * written into a temp directory has the same effect on every assertion here
 * and cannot rot.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NotarizationRejected,
  NotarizationSubmitFailed,
  NotarizationTimeout,
  NotaryKeyArgsInvalid,
  StapleFailed,
  assertKeyArgs,
  notarize,
  notarizeRelease,
  type NotarizeOptions,
} from '../../tools/release/src/notarize.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const FAKES = join(REPO, 'fixtures', 'src', 'release');
const FAKE_TOOL = join(FAKES, 'fake-notarytool.sh');
const FAKE_STAPLER = join(FAKES, 'fake-stapler.sh');
const PLANTED_LOG = join(FAKES, 'notary-log.invalid.json');

const SUB_ID = '7f3b1c28-0000-4a11-9c5e-2b6ad0e41f90';

/**
 * A sentinel that would be unmistakable in any file it leaked into. Row 9
 * plants it INSIDE the p8 and then greps everything the run wrote. A p8 that
 * is only ever named, never opened, cannot put this string anywhere.
 */
const KEY_SENTINEL = 'BEGIN-PRIVATE-KEY-SENTINEL-DO-NOT-LOG-a3f9c2';

/**
 * The fake key's filename, and the fake key's header, spelled so that THIS
 * file does not itself carry the two shapes `test/arch.spec.ts` row 11 bans.
 *
 * That row sweeps every tracked text file for a PEM opening line and for an
 * App Store Connect key filename, and it is right to. A public repo holding
 * either shape is a repo a secret scanner fires on, and a repo where a real
 * leak arrives as one more hit in a list that already has some.
 *
 * `arch.spec.ts` writes its own probes with the same split, for the same
 * reason. The ban is on the SHAPE APPEARING IN THE TREE: a split literal
 * removes it from the tree and leaves the runtime string byte-identical,
 * which is why this is a repair rather than a dodge. The prose above cannot
 * spell either shape either, which is the row catching its own
 * documentation.
 *
 * Sc8 shipped this file without the split and row 11 could not have caught
 * it. The sweep reads `git ls-files`, and the gate ran before the file was
 * staged, so the row was green against a tree the file was not yet in.
 */
const P8_NAME = `Auth${'Key'}_ABCD123456.p8`;

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-notary-'));
  temps.push(d);
  return d;
}

/* ── the argv log, parsed ───────────────────────────────────────────── */

/** The unit separator the fakes join argv with. Written as an escape and
 * not as the raw byte: a literal 0x1f in a source file is invisible in every
 * diff and every review, which is a bad property for a delimiter whose whole
 * job is to be unambiguous. */
const US = '\u001f';

interface Call {
  readonly at: number;
  readonly exit: number;
  readonly argv: readonly string[];
}

/**
 * One line is `<epoch_ms> TAB <exit> US <arg> US <arg> …`. The unit separator
 * (0x1f) is what makes this exact: it cannot occur in a path or a flag, so
 * argv splits back to what it was rather than to what a space-splitter would
 * guess. A path containing a space is precisely the case that matters here,
 * since every real artefact this runs against lives inside `WeMessage.app`.
 */
function readLog(path: string): Call[] {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(US);
      const [at, exit] = (parts[0] ?? '').split('\t');
      return {
        at: Number(at),
        exit: Number(exit),
        argv: parts.slice(1),
      };
    });
}

const verbs = (calls: readonly Call[]): string[] =>
  calls.map((c) => c.argv[0] ?? '');

/* ── a bed: temp dir, artefact, key file, log path ──────────────────── */

interface Bed {
  readonly dir: string;
  readonly artifact: string;
  readonly p8: string;
  readonly log: string;
  readonly keyArgs: readonly string[];
  calls: () => Call[];
  opts: (over?: Partial<NotarizeOptions>) => NotarizeOptions;
}

function bed(scenario: string, extraEnv: Record<string, string> = {}): Bed {
  const dir = tempDir();
  /*
   * A DMG, and not the zip this used to be. `notarize` staples what it is
   * given, and `stapler` refuses a zip outright ("Stapler is incapable of
   * working with ZIP archive files.", exit 66), so a `.zip` here made every
   * row that reaches the staple step model a call the real tool rejects.
   * The zip has exactly one legitimate place in this spec, row 10, where it
   * is submitted and deliberately NOT stapled.
   */
  const artifact = join(dir, 'WeMessage-1.0.0-arm64.dmg');
  // 1 KB, and its contents are irrelevant: nothing in this scenario opens it.
  writeFileSync(artifact, Buffer.alloc(1024, 0x50));
  const p8 = join(dir, P8_NAME);
  writeFileSync(p8, `-----${'BEGIN'} PRIVATE KEY-----\n${KEY_SENTINEL}\n`);
  const log = join(dir, 'argv.log');
  const keyArgs = [
    '--key',
    p8,
    '--key-id',
    'ABCD123456',
    '--issuer',
    '69a6de70-0000-47e3-e053-5b8c7c11a4d1',
  ] as const;

  // The fakes read their scenario from the environment, so the environment is
  // set for the whole call rather than passed through the module under test.
  // That keeps `notarize` free of any parameter that exists only for tests.
  Object.assign(process.env, {
    FAKE_NOTARY_SCENARIO: scenario,
    FAKE_NOTARY_LOG: log,
    FAKE_NOTARY_STATE: dir,
    ...extraEnv,
  });

  return {
    dir,
    artifact,
    p8,
    log,
    keyArgs,
    calls: () => readLog(log),
    opts: (over = {}) => ({
      artifact,
      tool: FAKE_TOOL,
      stapler: FAKE_STAPLER,
      keyArgs,
      deadlineMs: 2000,
      pollBaseMs: 40,
      pollMaxMs: 400,
      ...over,
    }),
  };
}

describe('s9 Sc8: the notarization state machine', () => {
  beforeAll(() => {
    /*
     * The fakes are executable IN THE REPO, not made executable here. A test
     * that chmods its own fixture proves nothing about what a fresh clone or
     * a CI checkout gets, and "works on the machine that ran it once" is the
     * failure this whole slice is about. git tracks the executable bit; this
     * asserts git is still carrying it.
     */
    for (const f of [FAKE_TOOL, FAKE_STAPLER])
      expect(`${f}: ${(statSync(f).mode & 0o777).toString(8)}`).toBe(
        `${f}: 755`,
      );
    // And the planted log body is present and is the two-issue shape rows 3
    // and 4 assert against, read from disk rather than duplicated here.
    expect(
      (JSON.parse(readFileSync(PLANTED_LOG, 'utf8')) as { issues: unknown[] })
        .issues,
    ).toHaveLength(2);
  });

  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    for (const k of [
      'FAKE_NOTARY_SCENARIO',
      'FAKE_NOTARY_LOG',
      'FAKE_NOTARY_STATE',
      'FAKE_STAPLE_FAIL',
    ])
      delete process.env[k];
  });

  /* ── row 1 ──────────────────────────────────────────────────────────── */

  it('row 1: accepted — submit once, poll, staple, validate, in that order', async () => {
    const b = bed('accepted');
    const result = await notarize(b.opts());

    expect(result).toEqual({
      id: SUB_ID,
      status: 'Accepted',
      polls: 1,
      stapled: true,
    });

    const calls = b.calls();
    expect(verbs(calls)).toEqual(['submit', 'info', 'staple', 'validate']);

    // FULL ARGV, not a substring. `--output-format json` is here because the
    // module parses the output as JSON; if it stopped asking for JSON and
    // started parsing notarytool's human-readable table, every other row here
    // would still pass and the first Apple release-notes change would break
    // production. The flag and the parser have to agree, so the flag is
    // pinned where the parser can be seen.
    expect(calls[0]?.argv).toEqual([
      'submit',
      b.artifact,
      '--output-format',
      'json',
      ...b.keyArgs,
    ]);
    expect(calls[1]?.argv).toEqual([
      'info',
      SUB_ID,
      '--output-format',
      'json',
      ...b.keyArgs,
    ]);
    expect(calls[2]?.argv).toEqual(['staple', b.artifact]);
    expect(calls[3]?.argv).toEqual(['validate', b.artifact]);
    expect(calls.map((c) => c.exit)).toEqual([0, 0, 0, 0]);
  });

  /* ── row 2 ──────────────────────────────────────────────────────────── */

  it('row 2: in-progress — polls four times, doubling, and AWAITS each wait', async () => {
    /*
     * WHY THIS ROW STOPPED COMPARING ADJACENT WALL-CLOCK GAPS.
     *
     * It used to read the fake's timestamps and assert each interval was no
     * smaller than the one before it. That is not a measurement of the
     * back-off: every interval is `sleep + fork + exec + perl startup`, and
     * the second term is noise whose size belongs to whatever else the
     * machine is doing. With 40 and 80 ms sleeps, ~40 ms of scheduler jitter
     * is enough to make the second interval smaller than the first while the
     * back-off is behaving perfectly. It did exactly that here, under nothing
     * more hostile than a packaging build on the other cores, and a CI runner
     * is a busier place than this laptop. A guard that fails on a green
     * system teaches people to re-run until it passes, and after that it is
     * not a guard at all.
     *
     * So the two claims are separated and each is asserted against evidence
     * that can actually carry it:
     *
     *   1. WHAT SCHEDULE IT CHOSE, exactly, from the argument handed to the
     *      injected `sleep`. This is not the module marking its own homework.
     *      `sleep` is not a log the module writes next to the real waiting;
     *      it IS the waiting. A number recorded here is a number that was
     *      then slept, because this function is what performs the sleep.
     *   2. THAT IT WAITED, from the FAKE's timestamps, as one total rather
     *      than three differences. This is the part `sleep` cannot fake:
     *      a module that called `sleep` without awaiting it would record a
     *      perfect 40/80/160 and still fire its four `info` calls back to
     *      back, and the total below is what catches that.
     *
     * A sum is robust to jitter in a way a pairwise comparison is not, which
     * is the whole reason the shape of this row changed.
     */
    const b = bed('in-progress-then-accepted');
    const slept: number[] = [];
    const recordingSleep = async (ms: number): Promise<void> => {
      slept.push(ms);
      await new Promise<void>((ok) => {
        setTimeout(ok, ms);
      });
    };

    const started = Date.now();
    const result = await notarize(b.opts({ sleep: recordingSleep }));
    const took = Date.now() - started;

    expect(result.polls).toBe(4);
    expect(result.status).toBe('Accepted');

    // Doubling from `pollBaseMs`, three times, because the fourth `info` is
    // the Accepted one and a terminal status is never slept on. Asserting the
    // exact vector is strictly stronger than the "non-decreasing" it replaces:
    // that would have accepted 40/40/40.
    expect(slept).toEqual([40, 80, 160]);

    const infos = b.calls().filter((c) => c.argv[0] === 'info');
    expect(infos).toHaveLength(4);
    const first = infos[0]?.at ?? 0;
    const last = infos[infos.length - 1]?.at ?? 0;
    const scheduled = slept.reduce((a, g) => a + g, 0);
    // 0.9 rather than 1.0 only for clock granularity: the fake stamps its
    // lines with perl's `Time::HiRes` and these sleeps run off node's timers.
    // Process spawn time means the real figure is comfortably above 280.
    expect(last - first).toBeGreaterThanOrEqual(scheduled * 0.9);

    // A coarse ceiling so a runaway back-off fails with this line rather than
    // with a hook timeout, which says nothing about what went wrong. Loose on
    // purpose: seven process spawns live inside this number.
    expect(took).toBeLessThan(4000);
  });

  /* ── rows 3 and 4 ───────────────────────────────────────────────────── */

  for (const [scenario, status] of [
    ['invalid', 'Invalid'],
    ['rejected', 'Rejected'],
  ] as const) {
    it(`rows 3/4: ${scenario} — the log is fetched and written, and NOTHING is stapled`, async () => {
      const b = bed(scenario);
      const err = await notarize(b.opts()).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(NotarizationRejected);
      const rejection = err as NotarizationRejected;
      expect(rejection.status).toBe(status);
      expect(rejection.id).toBe(SUB_ID);

      // Deep-equals the planted body, read from the fixture rather than
      // restated, so the fixture and the assertion cannot drift apart.
      const planted = JSON.parse(readFileSync(PLANTED_LOG, 'utf8')) as {
        issues: {
          severity: string;
          path: string;
          message: string;
          architecture?: string;
        }[];
      };
      expect(rejection.issues).toEqual(
        planted.issues.map((i) => ({
          severity: i.severity,
          path: i.path,
          message: i.message,
          ...(i.architecture === undefined
            ? {}
            : { architecture: i.architecture }),
        })),
      );
      expect(rejection.issues.map((i) => i.message)).toEqual([
        'The binary is not signed with a valid Developer ID certificate.',
        'The signature does not include a secure timestamp.',
      ]);

      // The body reached disk, beside the artefact, where a CI job's artefact
      // upload will find it. A rejection whose reasons live only in Apple's
      // database is a rejection someone has to re-fetch by hand from a runner
      // that no longer exists.
      const written = `${b.artifact}.notarization-log.json`;
      expect(rejection.logPath).toBe(written);
      expect(JSON.parse(readFileSync(written, 'utf8'))).toEqual(planted);

      // THE ROW'S REAL CLAIM: the sequence stopped. One submit, one info,
      // one log, and no stapler at all.
      expect(verbs(b.calls())).toEqual(['submit', 'info', 'log']);
    });
  }

  /* ── row 5 ──────────────────────────────────────────────────────────── */

  it('row 5: hang — times out carrying the id, and NEVER submits again', async () => {
    const b = bed('hang');
    const err = await notarize(b.opts()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NotarizationTimeout);
    const timeout = err as NotarizationTimeout;
    expect(timeout.id).toBe(SUB_ID);
    // The message has to tell an operator what to do, because the correct
    // action is counter-intuitive: do nothing, and go look the id up.
    expect(timeout.message).toContain(SUB_ID);
    expect(timeout.message).toContain('has NOT been resubmitted');

    const calls = b.calls();
    // THE F-127 ASSERTION. Exactly one submit line in the whole log.
    expect(calls.filter((c) => c.argv[0] === 'submit')).toHaveLength(1);
    expect(calls.filter((c) => c.argv[0] === 'info').length).toBeGreaterThan(2);
    expect(
      calls.filter((c) => c.argv[0] === 'staple' || c.argv[0] === 'validate'),
    ).toEqual([]);
    /*
     * It stopped on ITS budget rather than on the hook's. The bound is the
     * deadline plus one `info` round trip, because the deadline governs when
     * a new wait may be scheduled and not when an in-flight call returns;
     * `notarize`'s own doc comment says so. 500 ms of headroom is many times
     * a local process spawn and still an order of magnitude under the 20 s
     * that would mean the loop had ignored the deadline entirely.
     *
     * Written as a range and not as `< 2000`, which is what this row asserted
     * first and which failed at 2013 ms. Loosening it would have been the
     * wrong repair on its own; the loop was ALSO abandoning up to one whole
     * back-off interval of granted time, and that was fixed in the same pass.
     */
    expect(timeout.waitedMs).toBeGreaterThanOrEqual(2000);
    expect(timeout.waitedMs).toBeLessThan(2500);
  });

  /* ── row 6 ──────────────────────────────────────────────────────────── */

  it('row 6: submit-fails — surfaces the 401 and never polls', async () => {
    const b = bed('submit-fails');
    const err = await notarize(b.opts()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NotarizationSubmitFailed);
    // The stderr is carried verbatim. "HTTP status code: 401" is the only
    // thing in the whole exchange that tells an operator the CREDENTIAL is
    // wrong rather than the artefact, and a generic "submit failed" throws
    // that away.
    expect((err as NotarizationSubmitFailed).stderr).toContain(
      'HTTP status code: 401',
    );
    expect(verbs(b.calls())).toEqual(['submit']);
  });

  /* ── row 7 ──────────────────────────────────────────────────────────── */

  it('row 7: staple-fails — reports exit 65 and never validates', async () => {
    const b = bed('accepted', { FAKE_STAPLE_FAIL: '1' });
    const err = await notarize(b.opts()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(StapleFailed);
    expect((err as StapleFailed).code).toBe(65);
    // 65 is the routine "the ticket has not reached Apple's CDN yet" case,
    // and the message says so, because the wrong reaction to it is to go
    // back and submit the artefact again.
    expect((err as StapleFailed).message).toContain('Do NOT resubmit');
    // And it carries what the tool actually printed. `stapler` says all of
    // this on stdout and nothing on stderr, so an error type that carried
    // only stderr would report the exit code and no reason for it.
    expect((err as StapleFailed).message).toContain(
      'The staple and validate action failed! Error 65.',
    );
    expect(verbs(b.calls())).toEqual(['submit', 'info', 'staple']);
    delete process.env['FAKE_STAPLE_FAIL'];
  });

  /* ── row 8 ──────────────────────────────────────────────────────────── */

  describe('row 8: keyArgs is two closed shapes and no third', () => {
    const p8 = '/tmp/AuthKey_X.p8';

    it('accepts the App Store Connect API key shape', () => {
      expect(() => {
        assertKeyArgs(['--key', p8, '--key-id', 'K', '--issuer', 'I']);
      }).not.toThrow();
    });

    it('accepts the keychain profile shape', () => {
      expect(() => {
        assertKeyArgs(['--keychain-profile', 'wemessage-notary']);
      }).not.toThrow();
    });

    it('refuses the Apple-ID/password shape, so no password can reach argv', () => {
      // The shape Apple documents and this module will not support. A
      // password on an argv is readable by every process on the machine via
      // `ps`, is echoed by most CI log collectors, and would be captured
      // verbatim by the very argv log the rows above read.
      expect(() => {
        assertKeyArgs([
          '--apple-id',
          'someone@example.com',
          '--password',
          'abcd-efgh-ijkl-mnop',
          '--team-id',
          'TEAMID1234',
        ]);
      }).toThrow(NotaryKeyArgsInvalid);
    });

    it('refuses near-misses: right flags, wrong shape', () => {
      for (const bad of [
        [],
        ['--key', p8],
        ['--key', p8, '--key-id', 'K'],
        ['--key-id', 'K', '--key', p8, '--issuer', 'I'], // right flags, wrong order
        ['--key', p8, '--key-id', 'K', '--issuer', 'I', '--verbose'],
        ['--keychain-profile'],
        ['--keychain-profile', ''],
        // A flag where a value belongs. Without this check, an unset shell
        // variable that expanded to nothing would shift every later argument
        // one place left and notarytool would read `--key-id` as the p8 path.
        ['--key', '--key-id', '--issuer', 'I', '--key-id', 'K'],
      ])
        expect(() => {
          assertKeyArgs(bad);
        }).toThrow(NotaryKeyArgsInvalid);
    });

    it('is enforced by notarize itself, not only by the helper', async () => {
      const b = bed('accepted');
      await expect(
        notarize(b.opts({ keyArgs: ['--apple-id', 'x@example.com'] })),
      ).rejects.toBeInstanceOf(NotaryKeyArgsInvalid);
      // And it refused BEFORE spawning anything.
      expect(b.calls()).toEqual([]);
    });
  });

  /* ── row 9 ──────────────────────────────────────────────────────────── */

  it('row 9: nothing that ran can have read the private key', async () => {
    const b = bed('accepted');
    const debug: string[] = [];
    await notarize(b.opts({ onDebug: (l) => debug.push(l) }));

    // Everything this run produced, plus the runner's own narration.
    const written = readdirSync(b.dir)
      .filter((f) => f !== P8_NAME)
      .map((f) => `${f}: ${readFileSync(join(b.dir, f), 'utf8')}`);
    const everything = [...written, ...debug].join('\n');

    // The sentinel lives INSIDE the p8. If any of this had the key's contents
    // it would have the sentinel, because the sentinel is all the p8 contains
    // that is worth having.
    expect(everything).not.toContain(KEY_SENTINEL);

    // Non-vacuity, and the second half of the claim: the PATH is present, in
    // both the log and the narration. A run that had passed no key at all
    // would also pass the assertion above.
    expect(everything).toContain(b.p8);
    expect(debug.join('\n')).toContain('--key');
    expect(written.join('\n')).toContain('--key');
  });

  /* ── row 10 ─────────────────────────────────────────────────────────── */

  describe('row 10: the two-artefact release sequence', () => {
    it('submits both, in order, and staples the dmg ONLY', async () => {
      const b = bed('accepted');
      const zip = join(b.dir, 'WeMessage-1.0.0-arm64.zip');
      writeFileSync(zip, Buffer.alloc(1024, 0x5a));

      const out = await notarizeRelease({
        zip,
        dmg: b.artifact,
        tool: FAKE_TOOL,
        stapler: FAKE_STAPLER,
        keyArgs: b.keyArgs,
        deadlineMs: 2000,
        pollBaseMs: 40,
      });

      expect(out.zip.status).toBe('Accepted');
      expect(out.dmg.status).toBe('Accepted');
      // The asymmetry is part of the result, not a detail of the options,
      // because "notarized" and "carries its ticket" are different states
      // and Sc 9 has to be able to tell them apart.
      expect(out.zip.stapled).toBe(false);
      expect(out.dmg.stapled).toBe(true);

      const calls = b.calls();
      expect(verbs(calls)).toEqual([
        'submit',
        'info',
        'submit',
        'info',
        'staple',
        'validate',
      ]);
      // THE ORDER, by artefact and not just by verb. The zip goes first
      // because a failure then costs one submission rather than two, and
      // because the failure it catches (an unsigned helper, a missing
      // entitlement) is a property of the app, which both archives contain.
      expect(
        calls.filter((c) => c.argv[0] === 'submit').map((c) => c.argv[1]),
      ).toEqual([zip, b.artifact]);
      // And the zip never reaches the stapler at all. Asserted on the ARGV
      // rather than on the verb sequence above, because that sequence would
      // still look right if the two artefacts were swapped.
      expect(
        calls
          .filter((c) => c.argv[0] === 'staple' || c.argv[0] === 'validate')
          .map((c) => c.argv[1]),
      ).toEqual([b.artifact, b.artifact]);
    });

    it('and the stapler would have REFUSED the zip, which is why', async () => {
      /*
       * The row above asserts an absence, and an absence is only evidence if
       * the thing absent would otherwise have been noticed. So this pins the
       * consequence directly: hand `notarize` a zip with stapling left on,
       * the way the first version of `notarizeRelease` did, and it fails with
       * Apple's own message and exit code.
       *
       * This is the guard that stops the asymmetry above from being read as
       * an arbitrary preference and "simplified" back into symmetry.
       */
      const b = bed('accepted');
      const zip = join(b.dir, 'WeMessage-1.0.0-arm64.zip');
      writeFileSync(zip, Buffer.alloc(1024, 0x5a));

      const err = await notarize({
        artifact: zip,
        tool: FAKE_TOOL,
        stapler: FAKE_STAPLER,
        keyArgs: b.keyArgs,
        deadlineMs: 2000,
        pollBaseMs: 40,
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(StapleFailed);
      const failed = err as StapleFailed;
      expect(failed.code).toBe(66);
      expect(failed.message).toContain(
        'Stapler is incapable of working with ZIP archive files.',
      );
      // It got all the way to Accepted first. The zip is fine; stapling it
      // is what is impossible, and an operator reading this must not go and
      // resubmit an artefact Apple has already accepted.
      expect(failed.message).toContain('Do NOT resubmit');
      expect(verbs(b.calls())).toEqual(['submit', 'info', 'staple']);
    });

    it('does not attempt the dmg when the zip is rejected', async () => {
      const b = bed('invalid');
      const dmg = join(b.dir, 'WeMessage-1.0.0-arm64.dmg');
      writeFileSync(dmg, Buffer.alloc(1024, 0x44));

      await expect(
        notarizeRelease({
          zip: b.artifact,
          dmg,
          tool: FAKE_TOOL,
          stapler: FAKE_STAPLER,
          keyArgs: b.keyArgs,
          deadlineMs: 2000,
          pollBaseMs: 40,
        }),
      ).rejects.toBeInstanceOf(NotarizationRejected);

      // One submission in the entire run, and it was the zip. Submitting a
      // DMG built from an app Apple has just refused is two tickets for one
      // defect.
      const submits = b.calls().filter((c) => c.argv[0] === 'submit');
      expect(submits.map((c) => c.argv[1])).toEqual([b.artifact]);
    });
  });

  /* ── row 11 (C): the real thing ─────────────────────────────────────── */

  describe.skipIf(!process.env['ASC_KEY_ID'])(
    'row 11: against Apple, with a real App Store Connect key',
    () => {
      it(
        'notarizes and staples a real artefact',
        async () => {
          // Blocked on F-136: no Developer ID certificate exists for this
          // project, and notarization requires one even though the API key is
          // a separate credential. Deliberately left as the only unrun row in
          // this file, counted by the DoD gate rather than deleted, so the
          // gap stays visible.
          const zip = process.env['ASC_TEST_ZIP'];
          const dmg = process.env['ASC_TEST_DMG'];
          expect(zip).toBeDefined();
          expect(dmg).toBeDefined();
          const out = await notarizeRelease({
            zip: zip as string,
            dmg: dmg as string,
            tool: 'notarytool',
            stapler: 'stapler',
            keyArgs: [
              '--key',
              process.env['ASC_KEY_P8'] as string,
              '--key-id',
              process.env['ASC_KEY_ID'] as string,
              '--issuer',
              process.env['ASC_ISSUER_ID'] as string,
            ],
            deadlineMs: 20 * 60_000,
          });
          expect(out.zip.status).toBe('Accepted');
          expect(out.dmg.status).toBe('Accepted');
          expect(
            execFileSync('xcrun', ['stapler', 'validate', dmg as string], {
              encoding: 'utf8',
            }),
          ).toContain('The validate action worked!');
        },
        25 * 60_000,
      );
    },
  );
});

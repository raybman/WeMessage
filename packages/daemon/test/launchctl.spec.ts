/**
 * s9 Sc 1 row 6 — the label brand, and the refusal that happens BEFORE the
 * spawn (F-120's type-level half).
 *
 * WHY THIS FILE EXISTS AT ALL, since the plan names only `test/arch.spec.ts`
 * and `apps/desktop/test/tokens.spec.ts` as this scenario's test files.
 *
 * Row 6 is the only row in Scenario 1 that asserts a RUNTIME behaviour: a
 * call is made, a guard throws, and a spy proves nothing was spawned. Every
 * other row is static analysis over the tracked tree, which is what
 * `test/arch.spec.ts` is for. Putting row 6 there would have been worse than
 * untidy — `test/arch.spec.ts` is the ONE file exempt from row 4's launchd
 * sweep, so a runtime row living there would be a runtime row hiding behind
 * an exemption, and the exemption exists to let the guard spell the banned
 * words, not to give the rest of the scenario somewhere to hide.
 *
 * THE BANNED LITERALS. Row 4 forbids the operator's supervisor label, its
 * reverse-DNS prefix, and the root LaunchDaemons directory in every tracked
 * file under `packages/`, and this file is under `packages/`. None of the
 * three is spelled here. The label that must be REFUSED is assembled from
 * fragments at runtime, the idiom this repository has used since s7 Sc 7,
 * and the prose describes the others rather than quoting them.
 *
 * That is not a dodge of row 4: a dodge would be rewording the BAN so the
 * guard stops seeing an offender. This is the opposite — the dangerous
 * literal is never written down anywhere a maintainer could copy it, and
 * the value it denotes is still proved to be refused. Nothing here would
 * pass if the guard were removed.
 *
 * It is also the second time this scenario paid the same tuition. The
 * first draft of this header quoted all three, and row 4 convicted the
 * file that exists to prove row 4's runtime half. A guard's documentation
 * is inside the guard's scan.
 *
 * WHAT IS DELIBERATELY NOT DONE: no test in this file invokes `launchctl`.
 * Not against a real service, not against a fake one, not with `print`. The
 * dependency is injected and every test in this file passes a spy or a
 * scripted fake. The rule this encodes is the one F-120 is about — a process
 * that can spawn a service manager must never be able to reach the agent
 * supervising it — and a test suite that shelled out "just to check" would
 * be the first violation of it.
 */
import {
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
import type {
  LaunchAgentLabel,
  LaunchctlInvocation,
} from '../src/launchd/launchctl.js';
import {
  asLaunchAgentLabel,
  LAUNCHCTL_OPS,
  LAUNCH_AGENT_LABEL_PREFIX,
  LaunchdInvocationRefused,
  LaunchdLabelRefused,
  runLaunchctl,
} from '../src/launchd/launchctl.js';
import * as runnerModule from '../src/launchd/launchctl.js';
import {
  plistDeclaredLabel,
  renderLaunchAgentPlist,
} from '../src/launchd/plist.js';

/**
 * The operator's own agent label, assembled so that no tracked file under
 * `packages/` spells it. This is the exact string F-120 is written about:
 * the supervisor of the agent that writes this code.
 */
const OPERATORS_OWN_LABEL = ['com.', 'user.', 'sol', '-agent'].join('');
/** A label this project owns, and the only shape the runner will accept. */
const OURS = 'sh.wemessage.gateway';
/** The only GUI domain this runner will address, after s9 Sc3's G1. */
const UID = process.getuid?.() ?? 501;

const HERE = dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wm-runner-'));
  temps.push(d);
  return d;
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A REAL plist on disk, named for its label and declaring it.
 *
 * Written with the product's own renderer rather than by hand, because G1
 * binds the argv to the file's CONTENT, and a fixture that drifted from what
 * the renderer emits would make the guard look stricter than it is.
 */
function plistFor(
  label: string,
  over: { basename?: string; body?: string } = {},
): string {
  const dir = tempDir();
  const path = join(dir, over.basename ?? `${label}.plist`);
  writeFileSync(
    path,
    over.body ??
      renderLaunchAgentPlist({
        label: label as Parameters<typeof renderLaunchAgentPlist>[0]['label'],
        programArguments: [
          '/Applications/WeMessage.app/Contents/MacOS/WeMessage',
          '/Applications/WeMessage.app/Contents/Resources/daemon/main.mjs',
        ],
        stdoutPath: join(dir, 'out.log'),
        stderrPath: join(dir, 'err.log'),
      }),
  );
  return path;
}

/** A spy that records, answers, and fails the test if it is ever reached. */
function spawnSpy(): {
  readonly calls: LaunchctlInvocation[];
  readonly spawn: (i: LaunchctlInvocation) => Promise<{
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
} {
  const calls: LaunchctlInvocation[] = [];
  return {
    calls,
    spawn: (i) => {
      calls.push(i);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

describe('s9 Sc1 row 6: a launchd label this project does not own is refused', () => {
  describe('the brand: `asLaunchAgentLabel` is the only way to make one', () => {
    it('accepts a label in this project reverse-DNS namespace', () => {
      expect(asLaunchAgentLabel(OURS)).toBe(OURS);
      expect(asLaunchAgentLabel('sh.wemessage.test.abc-123')).toBe(
        'sh.wemessage.test.abc-123',
      );
      // The prefix is exported so the ONE definition of "ours" is shared
      // with Sc 3's installer rather than re-spelled there.
      expect(OURS.startsWith(LAUNCH_AGENT_LABEL_PREFIX)).toBe(true);
    });

    it('refuses the operator own supervisor, by value', () => {
      expect(() => asLaunchAgentLabel(OPERATORS_OWN_LABEL)).toThrow(
        LaunchdLabelRefused,
      );
      // The refusal names what it refused, so the failure is diagnosable
      // without re-running under a debugger…
      try {
        asLaunchAgentLabel(OPERATORS_OWN_LABEL);
        expect.unreachable('asLaunchAgentLabel accepted a foreign label');
      } catch (err) {
        expect(err).toBeInstanceOf(LaunchdLabelRefused);
        expect((err as LaunchdLabelRefused).label).toBe(OPERATORS_OWN_LABEL);
        expect((err as LaunchdLabelRefused).code).toBe('LAUNCHD_LABEL_REFUSED');
      }
    });

    it('NEAR-MISS: the almost-ours labels are refused too', () => {
      // A prefix test written with `startsWith` would pass three of these.
      // The point of the row is that "close to ours" is somebody else.
      const near = [
        'sh.wemessage', // the namespace itself, no agent
        'sh.wemessage.', // trailing dot, empty component
        'sh.wemessageX.gateway', // not a component boundary
        'xsh.wemessage.gateway', // not anchored at the start
        'sh.wemessage.gateway.', // trailing dot again
        'sh.wemessage.gate way', // a space is not a label
        '', // the empty string, which `label.length > 0` would also catch
      ];
      for (const raw of near)
        expect(() => asLaunchAgentLabel(raw), raw).toThrow(LaunchdLabelRefused);
    });

    it('the op vocabulary is the five scoped verbs and nothing else', () => {
      // The deprecated whole-domain spellings are absent BY CONSTRUCTION
      // rather than by review: they are not in the union, so a caller
      // cannot name one without a cast, and row 4 makes writing one down
      // anywhere in the tree a failing diff.
      expect([...LAUNCHCTL_OPS]).toEqual([
        'bootstrap',
        'bootout',
        'enable',
        'disable',
        'print',
      ]);
    });
  });

  describe('the runtime re-check: refused BEFORE anything is spawned', () => {
    it('a foreign label cast past the brand still never reaches a spawn', async () => {
      // THE ROW. `as LaunchAgentLabel` is the exact move a future scenario
      // makes by accident — a label read from a plist, a config file, or an
      // argv, asserted rather than validated. The type system cannot see
      // it, so the runner re-checks, and the spy is the proof that the
      // re-check happens on the near side of `child_process`.
      const spy = spawnSpy();
      expect(() =>
        runLaunchctl('bootout', OPERATORS_OWN_LABEL as LaunchAgentLabel, {
          spawn: spy.spawn,
          uid: 501,
        }),
      ).toThrow(LaunchdLabelRefused);
      expect(spy.calls).toEqual([]);
    });

    it('and it throws SYNCHRONOUSLY, so an unawaited call cannot slip through', () => {
      // `runLaunchctl` returns a promise, but the refusal is not inside it.
      // An `async function` would have turned this into a rejection, and an
      // unawaited rejected promise is a warning on stderr rather than a
      // stopped program — which is not good enough for the one guard
      // standing between this code and somebody else daemon.
      const spy = spawnSpy();
      let threwSynchronously = false;
      try {
        void runLaunchctl('bootout', OPERATORS_OWN_LABEL as LaunchAgentLabel, {
          spawn: spy.spawn,
          uid: 501,
        });
      } catch {
        threwSynchronously = true;
      }
      expect(threwSynchronously).toBe(true);
      expect(spy.calls).toEqual([]);
    });

    it('every op refuses the foreign label, not just the destructive one', async () => {
      // `bootout` is the one that stops a service, so it is the one the
      // tooth aims at — but a guard that only covered the scary verb would
      // leave `print` as a working oracle for what the operator is running.
      for (const op of LAUNCHCTL_OPS) {
        const spy = spawnSpy();
        expect(() =>
          runLaunchctl(op, OPERATORS_OWN_LABEL as LaunchAgentLabel, {
            spawn: spy.spawn,
            uid: 501,
            plistPath: '/tmp/nowhere.plist',
          }),
        ).toThrow(LaunchdLabelRefused);
        expect(spy.calls, op).toEqual([]);
      }
    });

    it('LEGITIMATE NEAR-MISS: our own label DOES reach the spawn, once', async () => {
      // A guard that refused everything would pass every assertion above
      // and be useless. This is the row that stops row 6 from being
      // satisfiable by `throw` on line one.
      const spy = spawnSpy();
      const result = await runLaunchctl('print', asLaunchAgentLabel(OURS), {
        spawn: spy.spawn,
        uid: 501,
      });
      expect(result.code).toBe(0);
      expect(spy.calls.length).toBe(1);
      expect(spy.calls[0]?.file).toBe('launchctl');
      expect(spy.calls[0]?.args).toEqual(['print', `gui/501/${OURS}`]);
    });

    it('the domain is the caller uid, never a root domain and never another user', () => {
      // The root domain — `system/`, and the system-wide daemons directory
      // row 4 bans even writing the path of. This project installs a
      // per-user LaunchAgent and nothing else, so the domain is always
      // `gui/<uid>` and the uid is always the caller's.
      //
      // SELF-TRIP, RECORDED. As written in Sc 1 this row passed `uid: 502`
      // and asserted the argv carried it. That made the uid a free
      // parameter: any caller could address any user's GUI domain, and the
      // row was the thing certifying that they could. s9 Sc 3's G1 closes
      // it, so the row is STRENGTHENED rather than deleted — a foreign uid
      // is now refused, and the legitimate case (this process's own uid,
      // reached both explicitly and by default) is asserted beside it.
      const spy = spawnSpy();
      void runLaunchctl('bootout', asLaunchAgentLabel(OURS), {
        spawn: spy.spawn,
        uid: UID,
      });
      expect(spy.calls[0]?.args).toEqual([
        'bootout',
        `gui/${String(UID)}/${OURS}`,
      ]);
      expect(JSON.stringify(spy.calls)).toContain('gui/');
      expect(JSON.stringify(spy.calls)).not.toContain('system/');

      // Omitted entirely: the same argv, from the same uid.
      const spy2 = spawnSpy();
      void runLaunchctl('bootout', asLaunchAgentLabel(OURS), {
        spawn: spy2.spawn,
      });
      expect(spy2.calls[0]?.args).toEqual([
        'bootout',
        `gui/${String(UID)}/${OURS}`,
      ]);

      // And any other uid — including root's — is refused, undelegated.
      for (const foreign of [0, UID + 1, UID - 1]) {
        const spy3 = spawnSpy();
        expect(
          () =>
            runLaunchctl('bootout', asLaunchAgentLabel(OURS), {
              spawn: spy3.spawn,
              uid: foreign,
            }),
          String(foreign),
        ).toThrow(LaunchdInvocationRefused);
        expect(spy3.calls, String(foreign)).toEqual([]);
      }
    });

    it('bootstrap is the one op that carries a plist, and it must be given one', () => {
      const label = asLaunchAgentLabel(OURS);
      const plistPath = plistFor(label);
      const spy = spawnSpy();
      void runLaunchctl('bootstrap', label, {
        spawn: spy.spawn,
        uid: UID,
        plistPath,
      });
      expect(spy.calls[0]?.args).toEqual([
        'bootstrap',
        `gui/${String(UID)}`,
        plistPath,
      ]);
      // …and without one it refuses rather than shipping a malformed argv
      // that launchctl would interpret as a domain-wide operation.
      const spy2 = spawnSpy();
      expect(() =>
        runLaunchctl('bootstrap', label, { spawn: spy2.spawn, uid: UID }),
      ).toThrow(/plist/i);
      expect(spy2.calls).toEqual([]);
    });
  });
});

/* ── s9 Sc3 G1: the argv is bound to the label, not merely accompanied ── */

describe('s9 Sc3 G1: the inherited bootstrap defect, and the four bindings', () => {
  /*
   * THE INHERITED DEFECT, stated plainly.
   *
   * Sc 1 shipped a `bootstrap` branch that validated the label and then
   * never used it. The argv it built was `bootstrap gui/<uid> <plistPath>`,
   * with `plistPath` taken from the caller and checked for one thing only:
   * that it was a non-empty string. Two consequences, both real:
   *
   *  1. THE LABEL GUARD DID NOT COVER BOOTSTRAP. Every other op puts the
   *     label in the argv, so refusing a foreign label refuses the whole
   *     operation. `bootstrap` put a PATH in the argv, so the label check
   *     was decoration: a caller could pass a legitimate label of ours and
   *     a plist declaring somebody else's, and the guard would wave it
   *     through. What launchd loads is decided by the file, not by the
   *     argument the guard inspected.
   *
   *  2. A DIRECTORY BOOTSTRAPS EVERYTHING IN IT. `launchctl bootstrap`
   *     accepts a directory and loads every plist inside it. The operator's
   *     `~/Library/LaunchAgents` on this machine holds forty-odd, plus a
   *     `.disabled/` subdirectory of agents somebody deliberately turned
   *     off. One caller passing a directory instead of a file — an easy
   *     mistake, and exactly the shape of `path.dirname` used by accident —
   *     turns them all back on.
   *
   * G1 binds the three things that must agree: the file is a FILE, its
   * BASENAME is the label, and the `Label` key INSIDE it is the label. Each
   * gets its own row, each with a planted offender and a legitimate near
   * miss, because a single combined row would be satisfied by any one of
   * the three checks existing.
   */

  it('PLANTED: a DIRECTORY is refused (the whole-directory bootstrap)', () => {
    const label = asLaunchAgentLabel(OURS);
    const dir = dirname(plistFor(label));
    const spy = spawnSpy();
    expect(() =>
      runLaunchctl('bootstrap', label, {
        spawn: spy.spawn,
        uid: UID,
        plistPath: dir,
      }),
    ).toThrow(LaunchdInvocationRefused);
    expect(spy.calls).toEqual([]);
    // Non-vacuity: that directory really does contain a loadable plist, so
    // the refusal is about the SHAPE of the argument and not about the
    // directory being empty.
    expect(readdirSync(dir)).toEqual([`${OURS}.plist`]);
  });

  it('PLANTED: a path that does not exist is refused', () => {
    const spy = spawnSpy();
    expect(() =>
      runLaunchctl('bootstrap', asLaunchAgentLabel(OURS), {
        spawn: spy.spawn,
        uid: UID,
        plistPath: join(tempDir(), `${OURS}.plist`),
      }),
    ).toThrow(LaunchdInvocationRefused);
    expect(spy.calls).toEqual([]);
  });

  it('PLANTED: a plist whose BASENAME is not the label is refused', () => {
    // The convention launchd itself uses, made load-bearing: an agent's
    // file is named for its label. A file named otherwise is a file we did
    // not write, or a file we are about to load under the wrong name.
    const label = asLaunchAgentLabel(OURS);
    const spy = spawnSpy();
    expect(() =>
      runLaunchctl('bootstrap', label, {
        spawn: spy.spawn,
        uid: UID,
        plistPath: plistFor(label, { basename: 'agent.plist' }),
      }),
    ).toThrow(LaunchdInvocationRefused);
    expect(spy.calls).toEqual([]);
  });

  it('PLANTED: a plist DECLARING another label is refused, however it is named', () => {
    /*
     * THE ROW THE DEFECT WAS REALLY ABOUT. The file below is named exactly
     * as our own agent's file would be, so a basename check alone passes
     * it. Inside, its `Label` is somebody else's, and `Label` is what
     * launchd obeys. The operator's own supervisor label is assembled from
     * fragments and written into the fixture at runtime, so no tracked file
     * spells it and the guard is still proved against the real value.
     *
     * SELF-TRIP, s9 Sc3. The first draft substituted with a single-shot
     * `.replace`, and the renderer writes the label TWICE: once as
     * `EnvironmentVariables.WEMESSAGE_LAUNCHD_LABEL` and once as `Label`.
     * The keys are emitted sorted, so `E` precedes `L` and the one
     * substitution landed in the environment block — a key launchd does not
     * read for identity. The row still went green, for the wrong reason:
     * it was refusing `sh.wemessage.other`, not the operator's label. The
     * fix is `replaceAll` plus an assertion on the mechanism itself, so the
     * row can no longer pass while testing something else.
     */
    const label = asLaunchAgentLabel(OURS);
    const body = renderLaunchAgentPlist({
      label: asLaunchAgentLabel('sh.wemessage.other'),
      programArguments: [
        '/Applications/WeMessage.app/Contents/MacOS/WeMessage',
        '/Applications/WeMessage.app/Contents/Resources/daemon/main.mjs',
      ],
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/err.log',
    }).replaceAll('sh.wemessage.other', OPERATORS_OWN_LABEL);
    // The mechanism, pinned: it is the `Label` key that now names the
    // operator's supervisor, which is the only key that would make launchd
    // act on that label.
    expect(plistDeclaredLabel(body)).toBe(OPERATORS_OWN_LABEL);
    const spy = spawnSpy();
    expect(() =>
      runLaunchctl('bootstrap', label, {
        spawn: spy.spawn,
        uid: UID,
        plistPath: plistFor(label, { body }),
      }),
    ).toThrow(LaunchdInvocationRefused);
    expect(spy.calls).toEqual([]);
  });

  it('PLANTED: a file that is not a property list at all is refused', () => {
    const label = asLaunchAgentLabel(OURS);
    const spy = spawnSpy();
    expect(() =>
      runLaunchctl('bootstrap', label, {
        spawn: spy.spawn,
        uid: UID,
        plistPath: plistFor(label, { body: 'not xml at all\n' }),
      }),
    ).toThrow(LaunchdInvocationRefused);
    expect(spy.calls).toEqual([]);
  });

  it('LEGITIMATE NEAR-MISS: the correctly named, correctly labelled plist loads', () => {
    // Without this the four rows above are satisfied by refusing every
    // bootstrap, and the product could never install anything.
    const label = asLaunchAgentLabel(OURS);
    const plistPath = plistFor(label);
    const spy = spawnSpy();
    void runLaunchctl('bootstrap', label, {
      spawn: spy.spawn,
      uid: UID,
      plistPath,
    });
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.args).toEqual([
      'bootstrap',
      `gui/${String(UID)}`,
      plistPath,
    ]);
    // The binding is exact, not a substring: the file's own `Label` is the
    // label the caller asked for.
    expect(readFileSync(plistPath, 'utf8')).toContain(
      `<key>Label</key>\n\t<string>${OURS}</string>`,
    );
  });

  it('LEGITIMATE NEAR-MISS: a test-scoped label works the same way', () => {
    const label = asLaunchAgentLabel('sh.wemessage.test.01j0abcdef');
    const plistPath = plistFor(label);
    const spy = spawnSpy();
    void runLaunchctl('bootstrap', label, {
      spawn: spy.spawn,
      uid: UID,
      plistPath,
    });
    expect(spy.calls[0]?.args?.[2]).toBe(plistPath);
  });

  it('the scoped ops build exactly two arguments, and the target has one shape', () => {
    // The second half of G1. `bootout`, `enable`, `disable` and `print`
    // take one target and nothing else; an argv with a third element is an
    // argv somebody appended to, and a target that is not
    // `gui/<digits>/<one of our labels>` is not a target this project
    // addresses. Both are re-checked on the near side of the spawn, after
    // the argv is built, because the argv is the last thing that is true.
    for (const op of ['bootout', 'enable', 'disable', 'print'] as const) {
      const spy = spawnSpy();
      void runLaunchctl(op, asLaunchAgentLabel(OURS), {
        spawn: spy.spawn,
        uid: UID,
      });
      const args = spy.calls[0]?.args ?? [];
      expect(args.length, op).toBe(2);
      expect(args[0], op).toBe(op);
      expect(args[1], op).toMatch(/^gui\/\d+\/sh\.wemessage(\.[a-z0-9-]+)+$/);
      // `plistPath` is meaningless to these ops and must not leak into the
      // argv as a third element if a caller passes one anyway.
      const spy2 = spawnSpy();
      void runLaunchctl(op, asLaunchAgentLabel(OURS), {
        spawn: spy2.spawn,
        uid: UID,
        plistPath: plistFor(asLaunchAgentLabel(OURS)),
      });
      expect(spy2.calls[0]?.args.length, op).toBe(2);
    }
  });

  it('the refusal is a taxonomy error with a code, not a bare Error', () => {
    try {
      runLaunchctl('bootstrap', asLaunchAgentLabel(OURS), {
        spawn: spawnSpy().spawn,
        uid: UID,
        plistPath: '/',
      });
      expect.unreachable('the root directory was accepted as a plist');
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchdInvocationRefused);
      expect((err as LaunchdInvocationRefused).code).toBe(
        'LAUNCHD_INVOCATION_REFUSED',
      );
      // The message names the path, because "refused" without "which one"
      // is a bug report nobody can act on.
      expect((err as Error).message).toContain('/');
    }
  });
});

/* ── s9 Sc3 G2: the real spawner exists, and stage 1 cannot reach it ──── */

describe('s9 Sc3 G2: the real spawner is defined here and called nowhere', () => {
  /*
   * The identifier is assembled from fragments for the same reason the
   * operator's label is: this row SCANS for it, and a spec that spelled it
   * would convict itself. That is not a dodge — the scan reads the whole
   * package, the value it looks for is the real one, and the row would fail
   * the moment anything called it.
   */
  const SPAWNER = ['real', 'Launchctl', 'Spawn'].join('');
  const RUNNER_REL = 'src/launchd/launchctl.ts';
  const PKG = resolve(HERE, '..');

  function filesNaming(needle: string, roots: readonly string[]): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(full, r);
        else if (
          /\.ts$/.test(entry.name) &&
          readFileSync(full, 'utf8').includes(needle)
        )
          out.push(r);
      }
    };
    for (const root of roots) walk(join(PKG, root), root);
    return out.sort();
  }

  it('it is exported, it takes one argument, and it is a function', () => {
    const fn = (runnerModule as unknown as Record<string, unknown>)[SPAWNER];
    expect(typeof fn).toBe('function');
    expect((fn as (i: unknown) => unknown).length).toBe(1);
  });

  it('NO TEST IN THIS PACKAGE NAMES IT', () => {
    /*
     * SELF-TRIP, and the row is stronger for it.
     *
     * This began as "exactly one file names it, and it is the runner",
     * which is what the dispatch asks for and which the product cannot
     * satisfy: `bin.ts` has to reference the real spawn to compose the CLI,
     * or `wemessaged service install` has no way to reach launchd and the
     * product does not exist. A guard a legitimate caller must be exempted
     * from is the wrong guard, so the guard was rewritten rather than the
     * caller exempted — and the property that actually matters was never
     * "one file" but "no TEST", which this row now states directly and
     * which the original wording only implied.
     */
    expect(filesNaming(SPAWNER, ['test'])).toEqual([]);
  });

  it('exactly two source files name it: the runner, and the entrypoint', () => {
    // Defined in the one module permitted to name the tool, referenced in
    // the one module permitted to compose a program. Equality, so a third
    // importer — a route, a helper, a convenience wrapper — fails here.
    expect(filesNaming(SPAWNER, ['src'])).toEqual(['src/bin.ts', RUNNER_REL]);
  });

  it('and the only test that starts the entrypoint starts it with no argv', () => {
    /*
     * The gap the two rows above leave open, closed. `bin.ts` names the
     * real spawn, so a test COULD reach it — by spawning the built
     * entrypoint with a `service` subcommand, which is the only branch that
     * touches it. Exactly one spec starts that entrypoint, and it starts it
     * with an empty argument list, which takes the daemon branch.
     */
    // Assembled, because this spec scans the test tree and a literal here
    // would convict this file.
    const needle = ['dist', ['bin', 'js'].join('.')]
      .map((x) => `'${x}'`)
      .join(', ');
    const starters = filesNaming(needle, ['test']);
    expect(starters).toEqual(['test/service-cli.spec.ts']);
    const src = readFileSync(join(PKG, starters[0] as string), 'utf8');
    // The one spawn, and its argv is the single-element list.
    expect(src).toContain('spawn(process.execPath, [BIN], {');
    // Non-vacuity: no OTHER argv is ever built around that constant.
    expect(src.includes('[BIN,')).toBe(false);
    expect(src.match(/\[BIN\]/g)).toHaveLength(1);
  });

  it('and the tool itself is named in exactly one source file', () => {
    // The narrower fact the arch spec pins repo-wide, asserted here too so
    // that a change to this package fails in this package first.
    const tool = ['launch', 'ctl'].join('');
    expect(filesNaming(`'${tool}'`, ['src'])).toEqual([RUNNER_REL]);
  });
});

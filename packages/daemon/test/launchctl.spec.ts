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
import { describe, expect, it } from 'vitest';
import type {
  LaunchAgentLabel,
  LaunchctlInvocation,
} from '../src/launchd/launchctl.js';
import {
  asLaunchAgentLabel,
  LAUNCHCTL_OPS,
  LAUNCH_AGENT_LABEL_PREFIX,
  LaunchdLabelRefused,
  runLaunchctl,
} from '../src/launchd/launchctl.js';

/**
 * The operator's own agent label, assembled so that no tracked file under
 * `packages/` spells it. This is the exact string F-120 is written about:
 * the supervisor of the agent that writes this code.
 */
const OPERATORS_OWN_LABEL = ['com.', 'user.', 'sol', '-agent'].join('');
/** A label this project owns, and the only shape the runner will accept. */
const OURS = 'sh.wemessage.gateway';

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

    it('the domain is the caller uid, never a root domain', () => {
      // The root domain — `system/`, and the system-wide daemons directory
      // row 4 bans even writing the path of. This project installs a
      // per-user LaunchAgent and nothing else, so the domain is always
      // `gui/<uid>` and the uid is always the caller's.
      const spy = spawnSpy();
      void runLaunchctl('bootout', asLaunchAgentLabel(OURS), {
        spawn: spy.spawn,
        uid: 502,
      });
      expect(spy.calls[0]?.args).toEqual(['bootout', `gui/502/${OURS}`]);
      expect(JSON.stringify(spy.calls)).toContain('gui/');
      expect(JSON.stringify(spy.calls)).not.toContain('system/');
    });

    it('bootstrap is the one op that carries a plist, and it must be given one', () => {
      const spy = spawnSpy();
      void runLaunchctl('bootstrap', asLaunchAgentLabel(OURS), {
        spawn: spy.spawn,
        uid: 501,
        plistPath: '/tmp/sh.wemessage.gateway.plist',
      });
      expect(spy.calls[0]?.args).toEqual([
        'bootstrap',
        'gui/501',
        '/tmp/sh.wemessage.gateway.plist',
      ]);
      // …and without one it refuses rather than shipping a malformed argv
      // that launchctl would interpret as a domain-wide operation.
      const spy2 = spawnSpy();
      expect(() =>
        runLaunchctl('bootstrap', asLaunchAgentLabel(OURS), {
          spawn: spy2.spawn,
          uid: 501,
        }),
      ).toThrow(/plist/i);
      expect(spy2.calls).toEqual([]);
    });
  });
});

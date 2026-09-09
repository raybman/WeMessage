/**
 * s9 Sc3/Sc7 (CLI half) — F-125: `service` is on the daemon, and this
 * binary says so instead of shrugging.
 *
 * WHAT IS BEING PROVED, AND WHY IT IS WORTH A FILE.
 *
 * F-125 ratified that `install|uninstall|status|restart` live on
 * `wemessaged`, not on `wemessage`. That decision is sound and it is
 * enforced structurally: `cli-thin-client` forbids this package from
 * importing `@wemessage/daemon`, so the verb COULD NOT be implemented here
 * even if someone wanted it. What was never landed is the other half of the
 * ratification, the sentence the operator gets when they type the wrong
 * one.
 *
 * They will type the wrong one. Two binaries that differ by a single
 * trailing `d` is not a distinction that survives being read once in a
 * README, and the README, the Homebrew caveats and the onboarding wizard
 * all name `wemessaged service install` in prose a person skims. Until this
 * commit the answer was commander's "unknown command": exit 2, correct,
 * and indistinguishable from a typo. The whole content of these rows is
 * that a dead end became a signpost, and that it is still a refusal.
 *
 * WHY A SUBPROCESS. `bin.ts` calls `program.parseAsync` as a module side
 * effect, so no test may import it — the deviation `cli-s8.spec.ts`
 * records. The binary is therefore run the way an operator runs it, which
 * is also the only way to observe an exit status at all.
 *
 * WHY `spawnSync` AND NOT `execFileSync`. `execFileSync` throws on a
 * non-zero exit, and every row here EXPECTS a non-zero exit. Catching a
 * throw to read `status` off it would make the assertion depend on the
 * shape of node's error rather than on the program's behaviour.
 *
 * PLATFORM. Runs everywhere; this is argv in and a string out.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
const CLI_BIN = join(repoRoot, 'packages/cli/dist/bin.js');

/** The daemon's own help text, read as BYTES and never imported. */
const DAEMON_CLI_SRC = join(repoRoot, 'packages/daemon/src/launchd/cli.ts');

/** Usage error, per §3.8. Named so the rows read as intent, not as `2`. */
const EXIT_USAGE = 2;

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const run = (...args: string[]): Ran => {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe('s9 F-125: wemessage service points at wemessaged', () => {
  it('names the exact command to run instead, and still exits 2', () => {
    const r = run('service', 'install');
    expect(r.status).toBe(EXIT_USAGE);
    // The whole point: the operator can copy the second half of this line.
    expect(r.stderr).toContain('wemessaged service install');
    // On stderr, not stdout. A script doing `wemessage service install >f`
    // must not end up with a redirect in the file it was collecting output
    // into, and a human piping to `less` must still see it.
    expect(r.stdout).toBe('');
  });

  it('with no subcommand, lists the four the daemon actually has', () => {
    const r = run('service');
    expect(r.status).toBe(EXIT_USAGE);
    for (const verb of ['install', 'uninstall', 'status', 'restart'])
      expect([verb, r.stderr.includes(verb)]).toEqual([verb, true]);
  });

  it('reaches the redirect even mid-paste, with options it does not define', () => {
    // The person most likely to need this line is the one who copied a whole
    // command from somewhere. If `--dir` made commander refuse before the
    // action ran, the redirect would never print for exactly them.
    const r = run('service', 'install', '--dir', 'somewhere', '--verbose');
    expect(r.status).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('wemessaged service install');
  });

  it('NEAR-MISS: an actual typo is still an unknown command, not a redirect', () => {
    /*
     * The row that makes the three above non-vacuous. Every one of them
     * asserts exit 2, and exit 2 is what this CLI returns for ANY usage
     * error, so on their own they are consistent with a program that prints
     * the redirect for everything, or for nothing and happens to fail. This
     * one pins the discrimination: a real typo gets commander's answer and
     * must NOT be told to go run a daemon verb that has nothing to do with
     * what they typed.
     */
    const r = run('servce', 'install');
    expect(r.status).toBe(EXIT_USAGE);
    expect(r.stderr).not.toContain('wemessaged service');
  });

  it('the verb it redirects to is one the daemon really has', () => {
    /*
     * A signpost pointing at nothing is worse than no signpost, and nothing
     * in `bin.ts` can know whether `wemessaged service install` exists: the
     * fence that made this redirect necessary is the same fence that stops
     * this package importing the module that would answer.
     *
     * So the daemon's CLI is read as TEXT. Not an import, and deliberately
     * not a spawn of `wemessaged` either: that would need the daemon built
     * and would make a row about one sentence depend on a build order. The
     * file is the source of the help the operator will see next.
     */
    const help = readFileSync(DAEMON_CLI_SRC, 'utf8');
    for (const verb of ['install', 'uninstall', 'status', 'restart'])
      expect([verb, help.includes(`wemessaged service ${verb}`)]).toEqual([
        verb,
        true,
      ]);
  });
});

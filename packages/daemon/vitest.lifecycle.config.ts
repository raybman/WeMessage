import { defineConfig } from 'vitest/config';

/**
 * The launch-agent lifecycle spec, as a project of its own.
 *
 * `test/launchd-lifecycle.spec.ts` installs a REAL LaunchAgent, waits for the
 * service manager to report it running, and then talks to the daemon that
 * agent started. The plist runs that daemon as `ProcessType: 'Background'`:
 * low CPU priority and throttled I/O, on purpose, because that is what the
 * product ships. Run alone, the row settles in five to seven seconds against
 * ceilings of 25s and 20s. Run inside the full parallel suite, those ceilings
 * stop describing the daemon and start describing how long Darwin will starve
 * a background-class process behind N test workers plus one `tsc` per
 * project. That number is not a property of this code, so it is not encoded
 * here: the observed failure was `timed out after 20000ms waiting for the
 * daemon to serve /v1/health`, with the service manager itself having already
 * reported the job running well inside its own budget. Nothing was broken.
 * The machine was busy.
 *
 * So the file is SEQUENCED rather than padded. `sequence.groupOrder: 1` puts
 * this project in a later group than every other project, all of which
 * default to 0, and the runner awaits every pool of a group, the type-check
 * pool included, before it starts the next. Nothing else is in flight while
 * this runs except this project's own type-check.
 *
 * This is NOT a skip, and the distinction is the whole point. The file runs on
 * every `pnpm test`, with the same rows, the same assertions and the same four
 * budgets. A genuinely broken service manager still goes red in exactly the
 * time it did before: about a second if the bootstrap is refused, 25s if the
 * job never reaches `running`, 25s + 20s if it runs but never serves. The only
 * thing that changed is that it now measures an idle machine. Raising the
 * constants instead would have bought green by making every one of those
 * red paths slower, and would still lose on a smaller CI runner.
 *
 * `singleFork` is a no-op today, there being one file, and it is here for the
 * spec's own header: the orphan sweep this suite performs is scoped to a test
 * label PREFIX, not to a run, so a second launch-agent spec added to this
 * project must run AFTER this one, never beside it, or the two sweeps boot
 * out each other's jobs.
 */
export default defineConfig({
  test: {
    name: 'daemon-lifecycle',
    environment: 'node',
    globals: false,
    include: ['test/launchd-lifecycle.spec.ts'],
    sequence: { groupOrder: 1 },
    poolOptions: { forks: { singleFork: true } },
    typecheck: {
      enabled: true,
      include: ['test/launchd-lifecycle.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

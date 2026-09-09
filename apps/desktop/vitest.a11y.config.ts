import { defineConfig } from 'vitest/config';

/**
 * The accessibility sweep, as a project of its own.
 *
 * `a11y.spec.ts` contains one row that walks EVERY screen, every surface and
 * every rendering variant the product has against a single long-lived
 * Electron instance. In the full parallel run that row takes ~241s, and for
 * its whole duration this repo's other desktop specs are launching and
 * tearing down Electron instances beside it on the same WindowServer / same
 * X display. Measured on the reference laptop: inside the 54-file run the
 * four rows that launch AFTER the sweep each died at exactly ~30.6s in
 * `firstWindow`, the window never arriving at all; the same file run on its
 * own is 18 of 18 green, repeatedly. Clean HEAD reproduces it identically,
 * so it is not a regression in any row.
 *
 * The cause is contention in window creation, not an assertion that is too
 * strict and not a wait that is too short. Raising the `firstWindow` ceiling
 * would be padding a deadline: in every failing run the window was never
 * created, so a longer wait buys a slower red and nothing else. The runners
 * make this worse rather than better, ubuntu-latest getting 3 forks and
 * macos-15 only 2, which is the shape of CI root cause #8.
 *
 * So the file is SEQUENCED. `sequence.groupOrder: 3` puts it in a group after
 * every other project (0), after the daemon lifecycle project (1) and after
 * the tray project (2); the runner drains each group's pools, type-check
 * included, before starting the next. When the sweep runs, nothing else in
 * this repo is asking the compositor for a window.
 *
 * THIS IS NOT A SKIP. The file runs on every `pnpm test`, with the same rows,
 * the same assertions, the same axe rule set and the same ceilings as the
 * `desktop` project it came out of. A genuinely inaccessible surface goes red
 * in the time it did before.
 *
 * `singleFork` is a no-op today, there being one file, and it is here for the
 * same reason as in the tray and lifecycle projects: a second file added to
 * this project must run AFTER this one, never beside it, or the collision
 * this config exists to remove comes straight back.
 */
export default defineConfig({
  test: {
    name: 'desktop-a11y',
    environment: 'node',
    globals: false,
    // C-11, inherited verbatim: a flaky test in this project is a bug.
    retry: 0,
    include: ['test/e2e/a11y.spec.ts'],
    // The `desktop` project's ceilings, copied unchanged. These are chosen
    // numbers, not defaults, and moving them here would be padding a deadline
    // under cover of a file move.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    sequence: { groupOrder: 3 },
    poolOptions: { forks: { singleFork: true } },
    typecheck: {
      enabled: true,
      include: ['test/e2e/a11y.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

import { defineConfig } from 'vitest/config';

/**
 * The tray spec, as a project of its own.
 *
 * Every desktop e2e instance registers the summon shortcut at boot
 * (`src/main/shortcut.ts`), and under `WEMESSAGE_DESKTOP_TEST` the
 * single-instance lock is bypassed on purpose, so two or three instances are
 * alive at once across vitest's workers. On X11 a key grab belongs to ONE
 * client per display, and `xvfb-run -a` gives the whole run one display. So
 * the one row that asserts the grab SUCCEEDED reads `'taken'` whenever a
 * neighbour got there first. That is a fact about the neighbour, not about
 * the tray, and no amount of waiting inside the row can change it.
 *
 * So the file is SEQUENCED rather than padded or retried. `sequence.groupOrder: 2`
 * puts it in a group after every other project (0) and after the daemon
 * lifecycle project (1); the runner drains each group's pools, type-check
 * included, before starting the next. Nothing else holds the display.
 *
 * THIS IS NOT A SKIP. The file runs on every `pnpm test`, with the same rows,
 * the same assertions and the same ceilings as the `desktop` project it came
 * out of. A genuinely broken tray goes red in the time it did before.
 *
 * `singleFork` is a no-op today, there being one file, and it is here for the
 * same reason as in the lifecycle project: a second file added to this
 * project must run AFTER this one, never beside it, or the collision this
 * config exists to remove comes straight back.
 */
export default defineConfig({
  test: {
    name: 'desktop-tray',
    environment: 'node',
    globals: false,
    // C-11, inherited verbatim: a flaky test in this project is a bug.
    retry: 0,
    include: ['test/e2e/tray.e2e.spec.ts'],
    // The `desktop` project's ceilings, copied unchanged. These are chosen
    // numbers, not defaults, and moving them here would be padding a deadline
    // under cover of a file move.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    sequence: { groupOrder: 2 },
    poolOptions: { forks: { singleFork: true } },
    typecheck: {
      enabled: true,
      include: ['test/e2e/tray.e2e.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

import { defineConfig } from 'vitest/config';

/**
 * v2 F8d: the search budgets, as a project of their own.
 *
 * `test/search-perf.spec.ts` times CPU-bound queries against a 530k-row
 * mirror: a filter-only query must answer in <= 60 ms. Run alone, the median
 * is about 22 ms. Run inside the full parallel suite on a 4-core CI runner,
 * it shared the CPU with every other project's workers and type-checkers, and
 * the median measured the neighbours instead (67.7 ms, then 80.3 ms on
 * linux). That number is not a property of this code, so the budget is not
 * raised to fit it.
 *
 * The file is SEQUENCED, as `packages/daemon/vitest.lifecycle.config.ts` is:
 * `sequence.groupOrder: 2` runs it after group 0 (every other project) and
 * group 1 (the launch-agent lifecycle), and the runner awaits each group
 * before starting the next. The rows, assertions and budgets are unchanged,
 * and it still runs on every `pnpm test`. It just measures an idle machine.
 */
export default defineConfig({
  test: {
    name: 'store-perf',
    environment: 'node',
    globals: false,
    include: ['test/search-perf.spec.ts'],
    sequence: { groupOrder: 2 },
    poolOptions: { forks: { singleFork: true } },
    typecheck: {
      enabled: true,
      include: ['test/search-perf.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

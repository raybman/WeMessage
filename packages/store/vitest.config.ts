import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'store',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // v2 F8d: the search budgets time CPU-bound queries, so they run in their
    // own sequenced project (`vitest.perf.config.ts`), not in this pool.
    exclude: [...configDefaults.exclude, 'test/search-perf.spec.ts'],
    // S2 Scenario 6: store specs are also compiled by tsc so the
    // append-only @ts-expect-error probes are enforced (esbuild alone
    // would strip them) — same pattern as packages/core.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      // Type ownership moves with the file: the project that runs it checks it.
      exclude: [
        ...configDefaults.typecheck.exclude,
        'test/search-perf.spec.ts',
      ],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

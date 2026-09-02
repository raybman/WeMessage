import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'store',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // S2 Scenario 6: store specs are also compiled by tsc so the
    // append-only @ts-expect-error probes are enforced (esbuild alone
    // would strip them) — same pattern as packages/core.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

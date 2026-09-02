import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // Scenario 2: the domain-types spec is also compiled by tsc so the
    // @ts-expect-error probes are enforced (esbuild alone would strip them).
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

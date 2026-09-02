import { defineConfig } from 'vitest/config';

// Root Vitest config. Enumerates per-package projects plus a root project for
// repo-level tests (test/arch.spec.ts). §1.3: "one root vitest config enumerating
// per-package configs plus a root project for repo-level tests".
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'packages/adapters/*/vitest.config.ts',
      'fixtures/vitest.config.ts',
      {
        test: {
          name: 'root',
          environment: 'node',
          globals: false,
          include: ['test/**/*.spec.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
    },
  },
});

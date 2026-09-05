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
          // s7 Sc1 (F-80): the repo-level project gets the same treatment as
          // every package. `test/arch.spec.ts` is the file that ENFORCES
          // typechecking everywhere else; leaving the enforcer itself
          // unchecked would be the one gap the guard cannot see.
          typecheck: {
            enabled: true,
            include: ['test/**/*.spec.ts'],
            tsconfig: './tsconfig.vitest.json',
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
    },
  },
});

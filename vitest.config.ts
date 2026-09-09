import { defineConfig } from 'vitest/config';

// Root Vitest config. Enumerates per-package projects plus a root project for
// repo-level tests (test/arch.spec.ts). §1.3: "one root vitest config enumerating
// per-package configs plus a root project for repo-level tests".
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      // The launch-agent lifecycle project. It is a SECOND config inside the
      // daemon package, so the glob above structurally cannot see it; it is
      // listed by hand because its `sequence.groupOrder` is the whole point,
      // sequencing one spec after the entire rest of the suite without
      // changing how any other daemon spec runs.
      'packages/daemon/vitest.lifecycle.config.ts',
      'packages/adapters/*/vitest.config.ts',
      // s8 Sc1: `apps/desktop` grows its first tests. The glob is `apps/*`
      // rather than the one path, for the same reason the enumerations in
      // test/arch.spec.ts key off structure: the next app must not be able
      // to be invisible to `pnpm test` by omission.
      'apps/*/vitest.config.ts',
      // The tray project. A SECOND config inside `apps/desktop`, so the glob
      // above structurally cannot see it; listed by hand for the same reason
      // the lifecycle project is, its `sequence.groupOrder` being the point.
      'apps/desktop/vitest.tray.config.ts',
      // The a11y project. A THIRD config inside `apps/desktop`, invisible to
      // the glob for the same reason, listed by hand for the same reason: its
      // `sequence.groupOrder` is the point.
      'apps/desktop/vitest.a11y.config.ts',
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

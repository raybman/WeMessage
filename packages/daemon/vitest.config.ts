import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'daemon',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // One spec installs a REAL launch agent and then waits on a
    // background-priority daemon it did not start itself. It cannot share the
    // machine with the other workers plus one type-checker per project, so it
    // lives in its own project (`vitest.lifecycle.config.ts`, groupOrder 1)
    // and is excluded here so it does not ALSO run in this pool. The defaults
    // are spread rather than replaced: `exclude` overwrites vitest's list, so
    // omitting them would start collecting specs out of `node_modules`.
    exclude: [...configDefaults.exclude, 'test/launchd-lifecycle.spec.ts'],
    // s7 Sc1 (F-80): every package's tests are typechecked, not just
    // transpiled. esbuild strips types without reading them, so until this
    // block existed the specs here were the one part of the tree the
    // compiler never saw.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      // Type ownership moves with the file: one project checks it, and it is
      // the project that runs it.
      exclude: [
        ...configDefaults.typecheck.exclude,
        'test/launchd-lifecycle.spec.ts',
      ],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

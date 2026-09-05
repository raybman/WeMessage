import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cli',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // s7 Sc1 (F-80): every package's tests are typechecked, not just
    // transpiled. esbuild strips types without reading them, so until this
    // block existed the specs here were the one part of the tree the
    // compiler never saw.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

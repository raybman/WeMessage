import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapter-luna',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // s7 Sc1 (F-80): tests are typechecked, not merely transpiled. This
    // package had no test/ directory until Sc9, which is exactly why the arch
    // row that requires this block is keyed off "has a test/ dir" rather than
    // off a hand-maintained list somebody has to remember to append to.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

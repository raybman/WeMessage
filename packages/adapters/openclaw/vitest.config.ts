import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapter-openclaw',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // s7 Sc1 (F-80): tests are typechecked, not merely transpiled. This
    // package was a bare `export {}` stub until Sc10; the moment it gained a
    // test/ directory the structural guard required this block, which is why
    // that row is keyed off "has a test/ dir" rather than off a hand-kept
    // list somebody has to remember to append to.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

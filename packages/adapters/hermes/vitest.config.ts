import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapter-hermes',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // s7 Sc7: this package's rows spawn a real Python child against a real
    // loopback listener, which is slower than every other project here and
    // slowest on the first run, when `uv` may still be materialising an
    // interpreter and a wheel. The per-row timeouts are set in the spec; this
    // is the hook timeout for the reaping `afterEach`.
    hookTimeout: 30_000,
    // s7 Sc1 (F-80): tests are typechecked, not merely transpiled. This
    // package had no test/ directory until now, which is exactly why the
    // arch row that requires this block is keyed off "has a test/ dir".
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

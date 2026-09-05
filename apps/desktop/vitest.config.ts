import { defineConfig } from 'vitest/config';

// s8 Sc1. The desktop app's first tests. `retry: 0` from the first commit
// (C-11): a flaky test in this project is a bug, and the e2e lane Sc 4 adds
// here is exactly the lane where a retry would hide one.
export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    globals: false,
    retry: 0,
    include: ['test/**/*.spec.ts'],
    // s8 Sc4. Launching a real Electron binary, loading a document and
    // handshaking with a real daemon does not fit in vitest's 5s default,
    // and a per-test timeout argument on thirty rows is thirty places for
    // one to be forgotten. The waits inside the suite are all bounded by
    // their own selector timeouts, so this ceiling only ever converts a hang
    // into a named failure.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // s7 Sc1 (F-80), obeyed by the newest package in the tree: every package
    // with a test/ directory typechecks its tests. `test/arch.spec.ts` row
    // (a) keys off structure, so `apps/desktop` gaining a test/ directory
    // DEMANDED this block in the same commit — which is the fourth time that
    // row has done its job and the first time it has done it for an app.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

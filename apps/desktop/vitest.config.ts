import { configDefaults, defineConfig } from 'vitest/config';

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
    // s9: four specs are SEQUENCED into projects of their own and excluded
    // here so they do not ALSO run in this pool. The tray spec asserts a
    // display-wide key grab (`vitest.tray.config.ts`, groupOrder 2); the a11y
    // sweep holds one Electron instance for minutes while every other spec in
    // this project launches its own beside it (`vitest.a11y.config.ts`,
    // groupOrder 3); the pack spec BUILDS a signed `.app` and a DMG before it
    // asserts anything, which is minutes of `electron-builder` that must not
    // run beside eleven Electron launches (`vitest.pack.config.ts`,
    // groupOrder 4); and the release smoke spec drives the PACKAGED app
    // against a REAL launch agent, whose sweep must not overlap the daemon's
    // (`vitest.smoke.config.ts`, groupOrder 5). None is a skip: all four run
    // on every `pnpm test`.
    //
    // `test/gif.spec.ts` is deliberately NOT here. It launches Electron like
    // the other eleven and belongs in their queue; its cost is bounded by its
    // own 300s hook argument rather than by a project of its own.
    // The defaults are spread rather than replaced: `exclude` overwrites
    // vitest's own list, and an empty one starts collecting specs out of
    // `node_modules`.
    exclude: [
      ...configDefaults.exclude,
      'test/e2e/tray.e2e.spec.ts',
      'test/e2e/a11y.spec.ts',
      'test/pack.spec.ts',
      'test/smoke.spec.ts',
    ],
    // s8 Sc4. Launching a real Electron binary, loading a document and
    // handshaking with a real daemon does not fit in vitest's 5s default,
    // and a per-test timeout argument on thirty rows is thirty places for
    // one to be forgotten. The waits inside the suite are all bounded by
    // their own selector timeouts, so this ceiling only ever converts a hang
    // into a named failure.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // s9: one Electron at a time, in THIS project only.
    //
    // The sibling tray/a11y configs each carry `singleFork` with a comment
    // saying it is a no-op there, and it is: a project holding one file has
    // nothing to serialise, and `groupOrder` is what actually bought those
    // two their isolation. Here it is not a no-op. This project holds eleven
    // files, every one of which launches its own Electron, and the comment on
    // `exclude` above already names the consequence. One fork runs them in
    // sequence while the other forks keep draining the rest of the suite.
    //
    // Known cost, accepted: a crashed Electron takes the shared fork and
    // every later desktop file with it. The harness's SIGKILL try/catch is
    // the mitigation, and a crash is a failure we want loud anyway.
    poolOptions: { forks: { singleFork: true } },
    // s7 Sc1 (F-80), obeyed by the newest package in the tree: every package
    // with a test/ directory typechecks its tests. `test/arch.spec.ts` row
    // (a) keys off structure, so `apps/desktop` gaining a test/ directory
    // DEMANDED this block in the same commit — which is the fourth time that
    // row has done its job and the first time it has done it for an app.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      // Type ownership moves with the file: one project checks it, and it is
      // the project that runs it.
      exclude: [
        ...configDefaults.typecheck.exclude,
        'test/e2e/tray.e2e.spec.ts',
        'test/e2e/a11y.spec.ts',
        'test/pack.spec.ts',
        'test/smoke.spec.ts',
      ],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

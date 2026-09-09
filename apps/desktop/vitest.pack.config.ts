import { defineConfig } from 'vitest/config';

/**
 * The packed-artefact project (s9 Sc 6).
 *
 * `pack.spec.ts` asserts things that are only true of a REAL bundle: the
 * signature, the entitlement set, the fuse wire, the one Mach-O that is both
 * GUI and daemon (F-121), and the listing of what rode along beside the asar.
 * None of that can be faked from a fixture, so the file's `beforeAll` runs
 * `pnpm pack:adhoc`, which builds the workspace, bundles the daemon, and hands
 * the result to electron-builder. Measured on the reference laptop, that is
 * about 1.2 minutes inside electron-builder and roughly two to three minutes
 * end to end.
 *
 * WHY ITS OWN PROJECT. Three reasons, in order of how much they cost:
 *
 *   1. That pack writes `apps/desktop/dist/`, `dist-bundle/` and `dist-pack/`.
 *      Every other desktop spec reads the first two. Running the pack beside
 *      them would rewrite files out from under a spec mid-assertion, and the
 *      failure would land on the spec that was reading, not the one that was
 *      writing, which is the worst possible place for it.
 *   2. Inside the `desktop` project the pack would serialise into that
 *      project's single fork and hold every other desktop file behind it.
 *   3. It launches the packed app, which asks the compositor for a window.
 *      That is the same contention `vitest.a11y.config.ts` was created to
 *      remove, and the same answer applies.
 *
 * `sequence.groupOrder: 4` puts it after every other project (0), the daemon
 * lifecycle project (1), the tray project (2) and the a11y sweep (3). By the
 * time it runs, nothing else in this repo is building, reading `dist/`, or
 * asking for a window.
 *
 * THIS IS NOT A SKIP ON DARWIN. On macOS arm64, the host this ships for, the
 * file runs on every `pnpm test` and packs a real app. Elsewhere the spec
 * itself skips, because `electron-builder --mac` needs macOS and the bundle
 * carries one prebuild, `darwin-arm64` (F-135). The gate lives in the spec,
 * next to the rows it governs, rather than here.
 */
export default defineConfig({
  test: {
    name: 'desktop-pack',
    environment: 'node',
    globals: false,
    // C-11, inherited verbatim: a flaky test in this project is a bug.
    retry: 0,
    include: ['test/pack.spec.ts'],
    // The pack is the hook, not the test. Rows assert against an artefact
    // that already exists by the time they run, so they keep the `desktop`
    // project's ceiling; only the hook gets the long budget.
    testTimeout: 30_000,
    hookTimeout: 900_000,
    sequence: { groupOrder: 4 },
    poolOptions: { forks: { singleFork: true } },
    typecheck: {
      enabled: true,
      include: ['test/pack.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

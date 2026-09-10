import { defineConfig } from 'vitest/config';

/**
 * The release smoke project (s9 Sc 12).
 *
 * `test/smoke.spec.ts` takes the artefact `vitest.pack.config.ts` already
 * built and runs it: it unzips the shipped `.zip`, asks Gatekeeper about it,
 * installs the SHIPPED `wemessaged` shim as a REAL launch agent under
 * `sh.wemessage.test.`, drives the PACKAGED app against the daemon that agent
 * supervises, replaces the bundle under the running job, plants a migration a
 * newer build would have applied, and uninstalls. Nothing here is a fixture:
 * every row's subject is the file a stranger downloads.
 *
 * WHY ITS OWN PROJECT, and why `groupOrder: 5` is load-bearing.
 *
 *   1. THE ORDER IS THE SAFETY PROPERTY. `packages/daemon`'s launchd
 *      lifecycle project runs at `groupOrder: 1` and its `afterAll` sweeps
 *      every test-scoped agent the service manager reports, orphan or not.
 *      This file's `beforeAll` does the same sweep. Two launchd sweeps that
 *      overlap would each see the other's live job as an orphan and boot it
 *      out mid-assertion, and the failure would land on whichever file was
 *      READING at the time. 5 is after 1, so the two sweeps are strictly
 *      sequential and each one only ever sees its own wreckage.
 *   2. It runs after the pack project (4), which is what produces the zip
 *      this file's `describe` gates on. In a full `pnpm test` the artefact is
 *      therefore fresh; run alone against a stale `dist-pack/` it still works,
 *      which is what makes the file usable as a release check by hand.
 *   3. It launches the packaged app and asks the compositor for a window,
 *      which is the same contention `vitest.a11y.config.ts` exists to remove.
 *
 * `singleFork` is not a no-op even though the project holds one file: the file
 * holds ONE launch agent and ONE Electron process across eight rows, and a
 * pool that could move a row to a second fork would move it away from both.
 *
 * `retry: 0`, C-11, inherited verbatim from every other project in this repo.
 * A retried row here would boot a second daemon into a directory the first one
 * still holds the lock on, and report the collision as a pass on the way past.
 *
 * `hookTimeout` and `testTimeout` are both fifteen minutes. Unlike the pack
 * project, the long budget cannot live on the hook alone: the rows themselves
 * wait on launchd settling, on a supervised daemon binding a port, and on a
 * packaged Electron app painting its first window. The suite's measured cost
 * is a small number of minutes; the ceiling only ever converts a hang into a
 * named failure.
 *
 * THIS IS A SKIP WITHOUT THE ARTEFACT, and the gate lives in the spec next to
 * the rows it governs, spelled against the zip's real path, so a run with no
 * `dist-pack/` reports a skip rather than eight reds about a missing file.
 */
export default defineConfig({
  test: {
    name: 'release-smoke',
    environment: 'node',
    globals: false,
    retry: 0,
    include: ['test/smoke.spec.ts'],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    sequence: { groupOrder: 5 },
    poolOptions: { forks: { singleFork: true } },
    typecheck: {
      enabled: true,
      include: ['test/smoke.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});

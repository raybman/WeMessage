#!/usr/bin/env node
/**
 * `release:notarize` — DECLARED, NOT IMPLEMENTED. Scenario 8 owns this.
 *
 * s9 Sc 1 row 10 requires that every release script named in the root
 * package.json resolves to a file that exists, so that a typo in a script
 * body fails at review time rather than at 3am with MODULE_NOT_FOUND.
 *
 * It exits 2 rather than 0, and that is the entire point of the stub. A
 * release script that is a no-op is the most dangerous shape in the list:
 * `pnpm release:notarize && ship` would ship an unnotarised, unsigned,
 * unsmoked artefact and report success. Refusing loudly means the pipeline
 * stops at the step that has not been built yet.
 *
 * STATUS AFTER Sc 8 (2026-09-09): the state machine itself is BUILT and green.
 * `tools/release/src/notarize.ts` submits once, polls to a bounded deadline,
 * fetches and writes the rejection log, staples the DMG and validates it, and
 * is tested against scripted `notarytool` and `stapler` fakes by 32 rows in
 * `test/release/notarize.spec.ts`. What is missing here is only the argv
 * parsing and the credential plumbing.
 *
 * IT STAYS A STUB ON PURPOSE UNTIL Sc 9. This file would move from `STUBS` to
 * `IMPLEMENTED` in `test/arch.spec.ts`, and that partition is keyed on whether
 * the bin reaches a child process. A bin that delegates to a library spawns
 * nothing itself, so promoting it would mean loosening the very guard that
 * makes the two sets mean something. The guard is right and the timing is
 * wrong: the CLI's shape is decided by the workflow that calls it, the
 * credential lane is `if: mode == 'release'`, and Sc 9 owns both. Wiring an
 * interface now to a caller that does not exist yet is how interfaces end up
 * wrong in both places.
 *
 * Until then this refuses, which is the correct answer for a lane that has no
 * certificate to notarise with (F-136).
 */
process.stderr.write(
  'release:notarize: not implemented yet (Scenario 8 of s9-execution owns it).\n' +
    'This stub exists so the script resolves; it refuses rather than ' +
    'succeeding by doing nothing.\n',
);
process.exit(2);

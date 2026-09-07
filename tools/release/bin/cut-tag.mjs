#!/usr/bin/env node
/**
 * `release:cut-tag` — DECLARED, NOT IMPLEMENTED. Scenario 14 owns this.
 *
 * s9 Sc 1 row 10 requires that every release script named in the root
 * package.json resolves to a file that exists, so that a typo in a script
 * body fails at review time rather than at 3am with MODULE_NOT_FOUND.
 *
 * It exits 2 rather than 0, and that is the entire point of the stub. A
 * release script that is a no-op is the most dangerous shape in the list:
 * `pnpm release:cut-tag && ship` would ship an unnotarised, unsigned,
 * unsmoked artefact and report success. Refusing loudly means the pipeline
 * stops at the step that has not been built yet.
 *
 * When implemented, this will: refuse a dirty tree, anything staged under docs/, a missing CHANGELOG section or an existing tag, then write the annotated tag.
 */
process.stderr.write(
  'release:cut-tag: not implemented yet (Scenario 14 of s9-execution owns it).\n' +
    'This stub exists so the script resolves; it refuses rather than ' +
    'succeeding by doing nothing.\n',
);
process.exit(2);

#!/usr/bin/env node
/**
 * `smoke:automated` — DECLARED, NOT IMPLEMENTED. Scenario 13 owns this.
 *
 * s9 Sc 1 row 10 requires that every release script named in the root
 * package.json resolves to a file that exists, so that a typo in a script
 * body fails at review time rather than at 3am with MODULE_NOT_FOUND.
 *
 * It exits 2 rather than 0, and that is the entire point of the stub. A
 * release script that is a no-op is the most dangerous shape in the list:
 * `pnpm smoke:automated && ship` would ship an unnotarised, unsigned,
 * unsmoked artefact and report success. Refusing loudly means the pipeline
 * stops at the step that has not been built yet.
 *
 * When implemented, this will: unpack the artefact into a temp prefix, install a throwaway LaunchAgent, and drive the wizard end to end against it.
 */
process.stderr.write(
  'smoke:automated: not implemented yet (Scenario 13 of s9-execution owns it).\n' +
    'This stub exists so the script resolves; it refuses rather than ' +
    'succeeding by doing nothing.\n',
);
process.exit(2);

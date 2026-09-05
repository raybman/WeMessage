#!/usr/bin/env node
/**
 * s7-execution Scenario 6 — the bin `npx @wemessage/adapter-testkit` resolves.
 *
 * Deliberately three lines of glue over `dist/cli.js`: the argument parsing,
 * the exit codes and the spawn transport are all typechecked TypeScript with
 * rows against them, and a bin that grew logic would be the one file in the
 * package nothing tests.
 */
import { main } from '../dist/cli.js';

process.exitCode = await main(process.argv.slice(2), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});

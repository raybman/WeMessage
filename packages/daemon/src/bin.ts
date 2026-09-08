#!/usr/bin/env node
/**
 * `wemessaged` — the daemon, and the service commands that install it.
 *
 * A DAEMON FIRST AND A CLI SECOND. With no arguments this is exactly
 * `main.js`: the same boot, the same lock, the same signals. That is what
 * makes the plist's `ProgramArguments` honest — the thing launchd runs at
 * login is the thing a developer runs by hand, not a second, subtly
 * different entrypoint that happens to work today.
 *
 * A PROGRAM ROOT, AND SO ONE OF THE TWO FILES ALLOWED TO IMPORT THE RUNNER.
 * Everything else in this package takes an injected `ServiceManagerRun`.
 * Until S9 Sc 4 this file was the ONLY importer, because it was the only
 * program that ran an op; Sc 4 gives `main.js` one too (`bootout` of its own
 * label, on disconnect), and `main.js` is a different program, not a helper
 * reaching for a capability. `test/arch.spec.ts` therefore pins the importer
 * set to the package's PROGRAM ROOTS, derived from `package.json#bin` plus
 * the plist's dev-daemon target, rather than to a hand-written list a fourth
 * file could be appended to.
 *
 * This file no longer names the spawn at all: the composition moved into
 * `launchctl.ts` as `realServiceManagerRun`, which NARROWED the set of files
 * naming it from two to one.
 */
import { realServiceManagerRun } from './launchd/launchctl.js';
import { runServiceCli } from './launchd/cli.js';

const argv = process.argv.slice(2);

if (argv.length === 0) {
  // The daemon. A dynamic import so the CLI path never pays for — or, more
  // to the point, never RUNS — the daemon's top-level boot.
  await import('./main.js');
} else {
  const code = await runServiceCli(
    argv,
    {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    },
    { run: realServiceManagerRun },
  );
  if (code !== 0) process.exit(code);
}

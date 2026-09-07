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
 * THE ONE PRODUCTION IMPORTER OF THE RUNNER. Everything else in this package
 * takes an injected `ServiceManagerRun`, so this file is the only place where
 * the guarded runner meets the real spawn. `test/arch.spec.ts` pins that set
 * to exactly this file, and the reason it can is that the vocabulary lives in
 * `contract.ts`: a module that imported the runner merely to name its types
 * would have become a second module naming the tool.
 */
import { realLaunchctlSpawn, runLaunchctl } from './launchd/launchctl.js';
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
    {
      run: (op, label, options) =>
        runLaunchctl(op, label, { ...options, spawn: realLaunchctlSpawn }),
    },
  );
  if (code !== 0) process.exit(code);
}

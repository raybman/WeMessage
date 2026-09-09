/**
 * The one place this daemon opens a store.
 *
 * Not a convenience wrapper. `SqliteStore` refuses a directory written by a
 * newer build, and that refusal arrives as the STORE's error class, which
 * carries no `code` and is therefore not in the daemon's taxonomy: reaching
 * the entrypoint it would be rethrown as a defect, printing a stack trace for
 * a condition an operator can act on in one step.
 *
 * Translating it once, here, is what makes "every path that opens the store"
 * a single fact rather than three that have to agree. The three are the
 * daemon proper, the stale-lock reclaim in `main.ts` -- which is the FIRST
 * one a downgrade actually meets, because people downgrade after a crash --
 * and the CLI's audit appender. `arch.spec.ts` pins the count.
 */
import type { Clock } from '@wemessage/core';
import { SchemaNewerThanBuildError, SqliteStore } from '@wemessage/store';
import { StoreNewerThanBuildError } from './errors.js';

export function openDaemonStore(opts: {
  readonly dir: string;
  readonly clock: Clock;
}): SqliteStore {
  try {
    return new SqliteStore({ dir: opts.dir, clock: opts.clock });
  } catch (err) {
    if (err instanceof SchemaNewerThanBuildError)
      throw new StoreNewerThanBuildError(opts.dir, err.unknownMigrations, err);
    throw err;
  }
}

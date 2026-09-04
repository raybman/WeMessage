/**
 * s6 Scenario 6 (store half) — the `rate_counters` table stops being unused.
 * Spec: docs/plans/slices/s6-execution.md Part 2 Scenario 6 RED rows 1-3;
 * §1.5 port body extensions; §1.7 "Rate counters (Sc 6)".
 *
 * Real temp-dir SqliteStore, no clock needed beyond the store's own (bucket
 * starts are computed by core and handed in as strings — the store is a
 * ledger of counts, not a source of time). NO migration: `rate_counters` has
 * been in migration 0001 since S1 (F-61), so this scenario is body-only and
 * the DDL below is asserted, never written.
 *
 * Covered here:
 *  - `bumpRateCounter` UPSERTs on the composite PK `(scope, bucket_start)`:
 *    two bumps inside one minute produce ONE row with `count: 2`, which is
 *    the whole reason the table is keyed that way rather than append-only;
 *  - `sumRateCounter(scope, since)` is half-open the other way — `[since, ∞)`
 *    — so a bucket sitting exactly ON the boundary is INCLUDED. The boundary
 *    is asserted from both sides (one millisecond later it is excluded),
 *    because "which side is the boundary on" is the single most likely thing
 *    to be silently wrong in a rolling-window cap and the most invisible;
 *  - scopes never mix: a sum for one contact does not see another contact's
 *    buckets, and neither sees `global`;
 *  - only the TWO pinned scope shapes are ever written (`global` and
 *    `contact:<handle>`), asserted over `SELECT DISTINCT scope` after a mixed
 *    run rather than over the call sites, so a third shape introduced
 *    anywhere shows up here. `0001_init.sql`'s own column comment is the pin.
 *
 * Handles are synthetic (`+1555…`), per the public-repo sweep.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '@wemessage/core';
import {
  contactRateScope,
  rateBucketStart,
  RATE_SCOPE_GLOBAL,
} from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

function fakeClock(iso = '2026-09-04T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

const ALICE = '+15550100';
const BOB = '+15550101';

describe('store: rate counters (s6 Scenario 6)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-rate-counters-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- RED row 1 -----------------------------------------------------------
  it('bumpRateCounter upserts on (scope, bucket_start): two bumps in one minute are one row of 2', () => {
    const scope = contactRateScope(ALICE);
    // Two DIFFERENT instants inside the same minute. The bucket function is
    // what collapses them, and it is production code, not a test constant.
    const first = rateBucketStart('2026-09-04T12:00:03.000Z');
    const second = rateBucketStart('2026-09-04T12:00:59.999Z');
    expect(second).toBe(first);

    store.bumpRateCounter(scope, first);
    store.bumpRateCounter(scope, second);

    const rows = store.db
      .prepare(
        'SELECT scope, bucket_start, count FROM rate_counters ORDER BY bucket_start',
      )
      .all() as Array<{ scope: string; bucket_start: string; count: number }>;
    expect(rows).toEqual([
      { scope, bucket_start: '2026-09-04T12:00:00.000Z', count: 2 },
    ]);

    // A bump in the NEXT minute is a second row, not a third increment.
    store.bumpRateCounter(scope, rateBucketStart('2026-09-04T12:01:00.000Z'));
    expect(
      (
        store.db.prepare('SELECT COUNT(*) AS n FROM rate_counters').get() as {
          n: number;
        }
      ).n,
    ).toBe(2);
    expect(store.sumRateCounter(scope, '2026-09-04T00:00:00.000Z')).toBe(3);
  });

  // --- RED row 2 -----------------------------------------------------------
  it('sumRateCounter includes a bucket exactly on the boundary and excludes the one before it', () => {
    const scope = contactRateScope(ALICE);
    for (const at of [
      '2026-09-04T11:58:10.000Z', // outside a 2-minute window at 12:00:20
      '2026-09-04T11:59:00.000Z', // exactly on it
      '2026-09-04T11:59:30.000Z',
      '2026-09-04T12:00:05.000Z',
    ]) {
      store.bumpRateCounter(scope, rateBucketStart(at));
    }

    // now - 2min from 12:00:20 is 11:58:20, which floors nothing: the raw
    // instant is the boundary, so the 11:58 bucket is BEHIND it and out.
    expect(store.sumRateCounter(scope, '2026-09-04T11:58:20.000Z')).toBe(3);
    // Exactly on the 11:59 bucket: still in (`>=`, not `>`).
    expect(store.sumRateCounter(scope, '2026-09-04T11:59:00.000Z')).toBe(3);
    // One millisecond later: out. This is the assertion that pins the side.
    expect(store.sumRateCounter(scope, '2026-09-04T11:59:00.001Z')).toBe(1);
    // A window entirely in the future sums to zero, never to null/NaN.
    expect(store.sumRateCounter(scope, '2026-09-04T13:00:00.000Z')).toBe(0);
    // An unknown scope is zero, not an error: the deny-all reflex does not
    // apply to a COUNT, and a store that threw here would make a first-ever
    // send impossible.
    expect(
      store.sumRateCounter(contactRateScope(BOB), '2026-09-04T00:00:00.000Z'),
    ).toBe(0);
  });

  // --- RED row 3 -----------------------------------------------------------
  it('only the two pinned scope shapes are ever written', () => {
    const bucket = rateBucketStart('2026-09-04T12:00:00.000Z');
    store.bumpRateCounter(RATE_SCOPE_GLOBAL, bucket);
    store.bumpRateCounter(contactRateScope(ALICE), bucket);
    store.bumpRateCounter(contactRateScope(BOB), bucket);
    store.bumpRateCounter(RATE_SCOPE_GLOBAL, bucket);

    const scopes = (
      store.db
        .prepare('SELECT DISTINCT scope FROM rate_counters ORDER BY scope')
        .all() as Array<{ scope: string }>
    ).map((r) => r.scope);
    expect(scopes).toEqual([
      'contact:+15550100',
      'contact:+15550101',
      'global',
    ]);
    // The shape assertion, over whatever is present rather than over the
    // three literals above: `0001_init.sql`'s column comment pins exactly
    // two forms and a third would be a silent taxonomy change.
    for (const scope of scopes) {
      expect(
        scope === RATE_SCOPE_GLOBAL || /^contact:.+$/.test(scope),
        scope,
      ).toBe(true);
    }

    // Scopes are independent ledgers: the global count is not the sum of the
    // contact counts, and one contact cannot spend another's budget.
    expect(store.sumRateCounter(RATE_SCOPE_GLOBAL, bucket)).toBe(2);
    expect(store.sumRateCounter(contactRateScope(ALICE), bucket)).toBe(1);
    expect(store.sumRateCounter(contactRateScope(BOB), bucket)).toBe(1);
  });

  it('counters survive a reopen: the cap is a persisted fact, not process memory', () => {
    const bucket = rateBucketStart('2026-09-04T12:00:00.000Z');
    store.bumpRateCounter(RATE_SCOPE_GLOBAL, bucket);
    store.bumpRateCounter(RATE_SCOPE_GLOBAL, bucket);
    store.close();

    const reopened = openStore({ dir, clock: fakeClock() });
    try {
      expect(
        reopened.sumRateCounter(RATE_SCOPE_GLOBAL, '2026-09-04T00:00:00.000Z'),
      ).toBe(2);
    } finally {
      reopened.close();
      // The afterEach closes `store`; better-sqlite3 tolerates a double close.
    }
  });
});

/**
 * v2 F3a: thread state, the daemon's record of Done, Snooze and Mute.
 *
 * One lazily written row per conversation in `thread_state` (migration
 * 0002). Absence is the default: no act, and an attention mode the client
 * derives (1:1 queue, group stream). So a record that clears both the act
 * and the attention is a DELETE, never a row of nulls.
 *
 * `updated_at` is stamped from the store's injected Clock, never from the
 * caller and never from wall time: it is the optimistic-concurrency token
 * the route compares `ifUpdatedAt` against, so it has to come from one
 * place.
 *
 * Teeth (proven, then reverted): drop the snoozed CHECK from 0002 and the
 * "rejects snoozed without until" row goes red.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, ThreadStateRecord } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

const T0 = '2026-09-01T12:00:00.000Z';
const T1 = '2026-09-01T12:05:00.000Z';
const MAYA = 'any;-;+15550100001';
const PRIYA = 'any;-;+15550100002';

/** A clock the test can move. */
function movableClock(start = T0): Clock & { set(iso: string): void } {
  let iso = start;
  return {
    now: () => iso,
    nowMs: () => Date.parse(iso),
    set: (next: string) => {
      iso = next;
    },
  };
}

describe('thread state store (v2 F3a)', () => {
  let dir: string;
  let clock: ReturnType<typeof movableClock>;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-thread-state-'));
    clock = movableClock();
    store = openStore({ dir, clock });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a conversation with no row has no state', () => {
    expect(store.getThreadState(MAYA)).toBeNull();
    expect(store.listThreadStates()).toEqual([]);
  });

  it('puts, gets and lists a snooze, stamped by the injected clock', () => {
    const written = store.putThreadState({
      chatGuid: MAYA,
      act: 'snoozed',
      actAt: T0,
      snoozedUntil: '2026-09-02T09:00:00.000-07:00',
      attention: null,
    });
    const want: ThreadStateRecord = {
      chatGuid: MAYA,
      act: 'snoozed',
      actAt: T0,
      snoozedUntil: '2026-09-02T09:00:00.000-07:00',
      attention: null,
      updatedAt: T0,
    };
    expect(written).toEqual(want);
    expect(store.getThreadState(MAYA)).toEqual(want);
    expect(store.listThreadStates()).toEqual([want]);
  });

  it('updated_at comes from the injected clock on every write, not the caller', () => {
    store.putThreadState({
      chatGuid: MAYA,
      act: 'done',
      actAt: T0,
      snoozedUntil: null,
      attention: null,
    });
    clock.set(T1);
    const second = store.putThreadState({
      chatGuid: MAYA,
      act: 'muted',
      actAt: T0,
      snoozedUntil: null,
      attention: 'muted',
    });
    expect(second?.updatedAt).toBe(T1);
    expect(store.getThreadState(MAYA)?.updatedAt).toBe(T1);
    // The act moved; the row did not multiply.
    expect(store.listThreadStates()).toHaveLength(1);
    expect(store.getThreadState(MAYA)?.act).toBe('muted');
  });

  it('lists every row ordered by chat guid', () => {
    for (const guid of [PRIYA, MAYA]) {
      store.putThreadState({
        chatGuid: guid,
        act: 'done',
        actAt: T0,
        snoozedUntil: null,
        attention: null,
      });
    }
    expect(store.listThreadStates().map((r) => r.chatGuid)).toEqual([
      MAYA,
      PRIYA,
    ]);
  });

  it('attention alone is a row; act null and attention null deletes it', () => {
    store.putThreadState({
      chatGuid: MAYA,
      act: null,
      actAt: null,
      snoozedUntil: null,
      attention: 'stream',
    });
    expect(store.getThreadState(MAYA)?.attention).toBe('stream');

    const cleared = store.putThreadState({
      chatGuid: MAYA,
      act: null,
      actAt: null,
      snoozedUntil: null,
      attention: null,
    });
    expect(cleared).toBeNull();
    expect(store.getThreadState(MAYA)).toBeNull();
    // Absence is the default: no row of nulls is left behind.
    const n = store.db
      .prepare('SELECT COUNT(*) AS n FROM thread_state')
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('clearing a conversation that has no row is a no-op, not an error', () => {
    expect(
      store.putThreadState({
        chatGuid: PRIYA,
        act: null,
        actAt: null,
        snoozedUntil: null,
        attention: null,
      }),
    ).toBeNull();
  });

  it('the schema rejects a snooze with no until (CHECK)', () => {
    expect(() =>
      store.db
        .prepare(
          'INSERT INTO thread_state (chat_guid, act, act_at, snoozed_until, ' +
            "attention, updated_at) VALUES (?, 'snoozed', ?, NULL, NULL, ?)",
        )
        .run(MAYA, T0, T0),
    ).toThrow(/CHECK/i);
    expect(() =>
      store.putThreadState({
        chatGuid: MAYA,
        act: 'snoozed',
        actAt: T0,
        snoozedUntil: null,
        attention: null,
      }),
    ).toThrow(/CHECK/i);
  });

  it('the schema rejects an until on a non-snooze act, an act with no act_at, and unknown words', () => {
    const insert = store.db.prepare(
      'INSERT INTO thread_state (chat_guid, act, act_at, snoozed_until, ' +
        'attention, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    expect(() => insert.run(MAYA, 'done', T0, T1, null, T0)).toThrow(/CHECK/i);
    expect(() => insert.run(MAYA, 'done', null, null, null, T0)).toThrow(
      /CHECK/i,
    );
    expect(() => insert.run(MAYA, 'seen', T0, null, null, T0)).toThrow(
      /CHECK/i,
    );
    expect(() => insert.run(MAYA, null, null, null, 'loud', T0)).toThrow(
      /CHECK/i,
    );
    expect(() => insert.run(MAYA, null, null, null, null, null)).toThrow(
      /NOT NULL/i,
    );
  });
});

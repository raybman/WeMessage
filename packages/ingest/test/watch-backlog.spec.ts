/**
 * v2 F8b: a paged catch-up keeps paging. After a successful scan that
 * reports a backlog (`hasMore`), the trigger queues the next page behind
 * pending I/O instead of waiting out the 3 s poll; a failed scan never
 * re-kicks (the poll paces retries, so an unreadable chat.db cannot spin).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createWatchTrigger } from '@wemessage/ingest';
import type { Clock, FsWatcher } from '@wemessage/core';

const clock: Clock = {
  now: () => '2026-01-05T12:00:00.000Z',
  nowMs: () => 0,
};

function fakeWatcher(): FsWatcher & { fire: () => void } {
  const handlers: (() => void)[] = [];
  return {
    watch(_paths, onChange) {
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
}

const settle = (ms = 50): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()?.();
});

describe('v2 F8b: watch trigger drains a backlog', () => {
  it('re-kicks after each successful page until hasMore is false, with no fs event', async () => {
    let pagesLeft = 4;
    let scans = 0;
    const watcher = fakeWatcher();
    const trigger = createWatchTrigger({
      chatDbPath: '/nonexistent/chat.db',
      watcher,
      clock,
      pollIntervalMs: 60_000,
      scan: () => {
        scans += 1;
        pagesLeft = Math.max(0, pagesLeft - 1);
        return Promise.resolve();
      },
      hasMore: () => pagesLeft > 0,
    });
    stops.push(() => trigger.stop());
    trigger.start();
    watcher.fire();
    await settle();
    expect(scans).toBe(4);
  });

  it('a failed scan does not re-kick even with a backlog', async () => {
    let scans = 0;
    const errors: unknown[] = [];
    const watcher = fakeWatcher();
    const trigger = createWatchTrigger({
      chatDbPath: '/nonexistent/chat.db',
      watcher,
      clock,
      pollIntervalMs: 60_000,
      scan: () => {
        scans += 1;
        return Promise.reject(new Error('SQLITE_CANTOPEN'));
      },
      hasMore: () => true,
      onError: (e) => errors.push(e),
    });
    stops.push(() => trigger.stop());
    trigger.start();
    watcher.fire();
    await settle();
    expect(scans).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

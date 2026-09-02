/**
 * Scenario 10 — Watch trigger: fs events, coalescing, poll fallback, wake
 * rescan (spec Part 2 #10; §2.2.1 "FSEvents-triggered reads with a 3s polling
 * fallback"; §1.3.8 "Sleep/wake"; F-9 disposition: WakeSignal port + clock-
 * skew default impl, no native code in S1).
 *
 * Ports/fakes: FsWatcher fake, Clock fake, WakeSignal fake; vitest fake
 * timers drive the 3s poll. Real FSEvents observation on a live Mac is a
 * demo-script step ([macOS smoke]), not a CI test.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClockSkewWakeSignal,
  createNodeFsWatcher,
  createWatchTrigger,
  type WakeSignal,
} from '@wemessage/ingest';
import type { Clock, FsWatcher } from '@wemessage/core';

const fakeClock: Clock = {
  now: () => '2026-01-05T12:00:00.000Z',
  nowMs: () => 0,
};

interface FakeWatcher extends FsWatcher {
  paths: string[][];
  fire: () => void;
  unsubscribed: number;
}

function fakeWatcher(): FakeWatcher {
  const handlers: (() => void)[] = [];
  const w: FakeWatcher = {
    paths: [],
    unsubscribed: 0,
    watch(paths, onChange) {
      w.paths.push([...paths]);
      handlers.push(onChange);
      return () => {
        w.unsubscribed += 1;
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
  return w;
}

interface FakeWake extends WakeSignal {
  fire: () => void;
  unsubscribed: number;
}

function fakeWake(): FakeWake {
  const handlers: (() => void)[] = [];
  const w: FakeWake = {
    unsubscribed: 0,
    onWake(handler) {
      handlers.push(handler);
      return () => {
        w.unsubscribed += 1;
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
  return w;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('watch trigger (Scenario 10, §2.2.1 / §1.3.8 / F-9)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('watches BOTH chat.db and chat.db-wal (§2.2.1)', () => {
    const watcher = fakeWatcher();
    const trigger = createWatchTrigger({
      chatDbPath: '/fixture/chat.db',
      scan: () => Promise.resolve([]),
      watcher,
      clock: fakeClock,
    });
    trigger.start();
    expect(watcher.paths).toEqual([
      ['/fixture/chat.db', '/fixture/chat.db-wal'],
    ]);
    trigger.stop();
  });

  it('coalesces N rapid wal events: one in-flight scan + one trailing re-scan, no pile-up', async () => {
    const watcher = fakeWatcher();
    const resolvers: (() => void)[] = [];
    const scan = vi.fn(
      () =>
        new Promise<unknown[]>((resolve) => resolvers.push(() => resolve([]))),
    );
    const trigger = createWatchTrigger({
      chatDbPath: '/fixture/chat.db',
      scan,
      watcher,
      clock: fakeClock,
    });
    trigger.start();

    for (let i = 0; i < 10; i++) watcher.fire();
    await settle();
    expect(scan).toHaveBeenCalledTimes(1); // one in-flight, 9 coalesced

    resolvers[0]?.();
    await settle();
    expect(scan).toHaveBeenCalledTimes(2); // trailing-edge re-scan, exactly one

    resolvers[1]?.();
    await settle();
    expect(scan).toHaveBeenCalledTimes(2); // nothing left pending
    trigger.stop();
  });

  it('silent watcher: the 3s poll fallback keeps triggering scans', async () => {
    const watcher = fakeWatcher();
    const scan = vi.fn(() => Promise.resolve([]));
    const trigger = createWatchTrigger({
      chatDbPath: '/fixture/chat.db',
      scan,
      watcher,
      clock: fakeClock,
    });
    trigger.start();
    expect(scan).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(3000);
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(scan).toHaveBeenCalledTimes(2);
    trigger.stop();
  });

  it('wake signal forces an immediate poll (§1.3.8 sleep/wake, meowSleep lesson)', async () => {
    const watcher = fakeWatcher();
    const wake = fakeWake();
    const scan = vi.fn(() => Promise.resolve([]));
    const trigger = createWatchTrigger({
      chatDbPath: '/fixture/chat.db',
      scan,
      watcher,
      clock: fakeClock,
      wake,
    });
    trigger.start();
    wake.fire();
    await settle();
    expect(scan).toHaveBeenCalledTimes(1); // no timer advance needed
    trigger.stop();
  });

  it('a failing scan does not kill the loop; the error is surfaced', async () => {
    const watcher = fakeWatcher();
    const errors: unknown[] = [];
    let calls = 0;
    const scan = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('scan blew up'))
        : Promise.resolve([]);
    });
    const trigger = createWatchTrigger({
      chatDbPath: '/fixture/chat.db',
      scan,
      watcher,
      clock: fakeClock,
      onError: (err) => errors.push(err),
    });
    trigger.start();
    watcher.fire();
    await settle();
    expect(errors).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(scan).toHaveBeenCalledTimes(2); // poll still alive after the error
    trigger.stop();
  });

  it('stop() unsubscribes the watcher and wake signal and halts the poll', async () => {
    const watcher = fakeWatcher();
    const wake = fakeWake();
    const scan = vi.fn(() => Promise.resolve([]));
    const trigger = createWatchTrigger({
      chatDbPath: '/fixture/chat.db',
      scan,
      watcher,
      clock: fakeClock,
      wake,
    });
    trigger.start();
    trigger.stop();
    expect(watcher.unsubscribed).toBe(1);
    expect(wake.unsubscribed).toBe(1);

    watcher.fire();
    wake.fire();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scan).toHaveBeenCalledTimes(0);
  });
});

describe('clock-skew WakeSignal (F-9 default impl)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function skewCtx(): {
    clock: Clock;
    advance: (timerMs: number, clockMs?: number) => Promise<void>;
    wakes: number[];
    stop: () => void;
  } {
    let ms = 0;
    const clock: Clock = {
      now: () => new Date(ms).toISOString(),
      nowMs: () => ms,
    };
    const signal = createClockSkewWakeSignal(clock);
    const wakes: number[] = [];
    const unsub = signal.onWake(() => wakes.push(ms));
    signal.start();
    return {
      clock,
      wakes,
      advance: async (timerMs, clockMs) => {
        ms += clockMs ?? timerMs;
        await vi.advanceTimersByTimeAsync(timerMs);
      },
      stop: () => {
        unsub();
        signal.stop();
      },
    };
  }

  it('normal ticks (clock tracks timers) never fire a wake', async () => {
    const c = skewCtx();
    for (let i = 0; i < 20; i++) await c.advance(3000);
    expect(c.wakes).toEqual([]);
    c.stop();
  });

  it('a tick observing now - lastTick > 30s implies sleep: wake fires once', async () => {
    const c = skewCtx();
    await c.advance(3000); // baseline tick
    await c.advance(3000, 90_000); // laptop slept: clock jumped 90s
    expect(c.wakes).toHaveLength(1);
    await c.advance(3000); // recovered: no repeat fire
    expect(c.wakes).toHaveLength(1);
    c.stop();
  });

  it('skew at exactly the threshold does not fire (strictly greater per F-9)', async () => {
    const c = skewCtx();
    await c.advance(3000); // baseline tick
    await c.advance(3000, 30_000); // now - lastTick == 30_000 exactly
    expect(c.wakes).toEqual([]);
    await c.advance(3000, 30_001); // one ms past: fires
    expect(c.wakes).toHaveLength(1);
    c.stop();
  });
});

describe('node FsWatcher impl (real fs.watch; FSEvents smoke is demo-script)', () => {
  it('returns a working unsubscribe for existing paths and tolerates missing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-watch-'));
    try {
      const dbPath = join(dir, 'chat.db');
      writeFileSync(dbPath, 'x');
      const watcher = createNodeFsWatcher();
      // chat.db exists, chat.db-wal does not yet — must not throw (§2.2.1:
      // the wal appears/disappears across checkpoints).
      const unsubscribe = watcher.watch(
        [dbPath, `${dbPath}-wal`],
        () => undefined,
      );
      expect(typeof unsubscribe).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

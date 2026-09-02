/**
 * @wemessage/ingest/watch — chat.db change detection (Scenario 10).
 *
 * Spec: Part 2 #10; §2.2.1 (watch BOTH chat.db and chat.db-wal, FSEvents-
 * triggered reads with a 3s polling fallback); §1.3.8 sleep/wake; F-9
 * disposition (WakeSignal port + clock-skew default impl, no native code).
 *
 * Design notes:
 * - The trigger is fully injectable: FsWatcher (core port), Clock (core
 *   port), WakeSignal (this module), and the scan callable (typically
 *   createScanLoop(...).scanOnce). Tests run with fakes + vitest fake timers.
 * - Coalescing: at most one scan in flight. Change events (or wake/poll
 *   kicks) arriving mid-scan set a single pending flag; when the in-flight
 *   scan settles, exactly one trailing-edge re-scan runs. Bursts of N events
 *   therefore cost at most 2 scans — no unbounded pile-up.
 * - The 3s poll is a fallback, not the primary trigger: if FSEvents goes
 *   silent (§2.2.1 failure mode), messages still land within one poll.
 * - [macOS smoke] Observing live FSEvents fire on a real chat.db is a
 *   demo-script step, not a CI test. True NSWorkspace wake hookup is
 *   deferred to launchd/packaging (deferral 4.3 #12).
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import type { Clock, FsWatcher } from '@wemessage/core';

/**
 * WakeSignal port (F-9): notifies subscribers that the machine likely slept
 * and woke, so the ingest loop must force a full poll immediately instead of
 * waiting out timers that were suspended.
 *
 * Faked in tests; default impl is createClockSkewWakeSignal (no native code).
 */
export interface WakeSignal {
  /** Register a wake handler. Returns an unsubscribe function. */
  onWake(handler: () => void): () => void;
}

export interface ClockSkewWakeSignalOptions {
  /** Tick cadence in ms. Default 3000 (rides the same 3s cadence as the poll). */
  tickMs?: number;
  /**
   * Skew threshold in ms. A tick observing now - lastTick strictly greater
   * than this implies the process was suspended (sleep). Default 30_000 (F-9).
   */
  skewThresholdMs?: number;
}

export interface ClockSkewWakeSignal extends WakeSignal {
  start(): void;
  stop(): void;
}

/**
 * F-9 pragmatic default WakeSignal: clock-skew detection. A periodic tick
 * records clock.nowMs(); if a tick observes now - lastTick > skewThresholdMs,
 * timers were suspended long enough that sleep is the only plausible cause,
 * so wake handlers fire. No native code; NSWorkspace hookup deferred (4.3 #12).
 */
export function createClockSkewWakeSignal(
  clock: Clock,
  options: ClockSkewWakeSignalOptions = {},
): ClockSkewWakeSignal {
  const tickMs = options.tickMs ?? 3000;
  const skewThresholdMs = options.skewThresholdMs ?? 30_000;
  const handlers = new Set<() => void>();
  let timer: NodeJS.Timeout | null = null;
  let lastTick: number | null = null;

  const tick = (): void => {
    const now = clock.nowMs();
    const slept = lastTick !== null && now - lastTick > skewThresholdMs;
    lastTick = now;
    if (slept) {
      for (const handler of [...handlers]) handler();
    }
  };

  return {
    onWake(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    start() {
      if (timer !== null) return;
      lastTick = clock.nowMs();
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      lastTick = null;
    },
  };
}

export interface WatchTriggerOptions {
  /** Path to chat.db; the -wal sibling is derived (§2.2.1: watch BOTH). */
  chatDbPath: string;
  /** The scan to trigger — typically createScanLoop(...).scanOnce. */
  scan: () => Promise<unknown>;
  /** FsWatcher port (core seam). Faked in tests; real impl: createNodeFsWatcher. */
  watcher: FsWatcher;
  /** Clock port. Reserved for trigger-side timestamps; poll uses timers. */
  clock: Clock;
  /** Optional WakeSignal (F-9). Wake => forced poll immediately. */
  wake?: WakeSignal;
  /** Poll fallback cadence in ms. Default 3000 (§2.2.1). */
  pollIntervalMs?: number;
  /** Scan failures are surfaced here and never kill the loop. */
  onError?: (error: unknown) => void;
}

export interface WatchTrigger {
  /** Subscribe (fs events, wake) and arm the poll fallback. Idempotent. */
  start(): void;
  /** Unsubscribe everything and disarm the poll. Idempotent. */
  stop(): void;
}

/**
 * Wires change detection to the scan loop: fs events on chat.db/chat.db-wal,
 * a 3s polling fallback, and an optional wake signal all funnel into a
 * single coalescing kick (one in-flight scan, one trailing re-scan max).
 */
export function createWatchTrigger(options: WatchTriggerOptions): WatchTrigger {
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const walPath = `${options.chatDbPath}-wal`;

  let started = false;
  let inFlight = false;
  let pending = false;
  let unsubscribers: (() => void)[] = [];
  let pollTimer: NodeJS.Timeout | null = null;

  const kick = (): void => {
    if (!started) return;
    if (inFlight) {
      pending = true; // coalesce: at most one trailing-edge re-scan
      return;
    }
    inFlight = true;
    void options
      .scan()
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .then(() => {
        inFlight = false;
        if (pending && started) {
          pending = false;
          kick();
        }
      });
  };

  return {
    start() {
      if (started) return;
      started = true;
      unsubscribers.push(
        options.watcher.watch([options.chatDbPath, walPath], kick),
      );
      if (options.wake) {
        unsubscribers.push(options.wake.onWake(kick));
      }
      pollTimer = setInterval(kick, pollIntervalMs);
      pollTimer.unref?.();
    },
    stop() {
      if (!started) return;
      started = false;
      pending = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const unsubscribe of unsubscribers) unsubscribe();
      unsubscribers = [];
    },
  };
}

/**
 * Real FsWatcher (core port impl) over node:fs.watch — FSEvents-backed on
 * macOS. Watches every requested path that exists; paths that do not exist
 * yet (chat.db-wal appears/disappears across WAL checkpoints, §2.2.1) are
 * skipped without error — the 3s poll fallback covers the gap. Watcher
 * errors are swallowed for the same reason: the poll is the safety net.
 */
export function createNodeFsWatcher(): FsWatcher {
  return {
    watch(paths, onChange) {
      const watchers: FSWatcher[] = [];
      for (const path of paths) {
        try {
          const w = fsWatch(path, { persistent: false }, () => {
            onChange();
          });
          w.on('error', () => undefined);
          watchers.push(w);
        } catch {
          // Missing path (e.g. wal not present yet): poll fallback covers it.
        }
      }
      return () => {
        for (const w of watchers) w.close();
      };
    },
  };
}

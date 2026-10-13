/**
 * HOST-DEATH WATCH (v2 F12).
 *
 * Under the Swift host (`WeMessageDaemonHost`) launchd's job is the HOST,
 * not this process. The host forwards TERM/INT/HUP and reaps us, so an
 * orderly stop is already handled. What it cannot handle is its own death:
 * a SIGKILL to the host (a forced job restart, a crash, the OOM
 * killer) leaves this process reparented to pid 1, still holding the
 * instance lock and the port. launchd then starts a fresh host, whose node
 * refuses with "already running", and KeepAlive turns that into a loop.
 * Observed live on 2026-10-13: the orphan survived five, then nine,
 * restarts until it was killed by hand.
 *
 * The fix is on this side because this is the side that survives. The host
 * passes its pid as `WEMESSAGE_HOST_PID`; while our parent is still that
 * pid the host is alive. The moment it is not, we stop through the same
 * `shutdown` a SIGTERM takes, which releases the lock last.
 *
 * Parsing is lenient on purpose, for the reason `WEMESSAGE_LAUNCHD_LABEL`
 * is unvalidated in main.ts: a malformed value here must not become a boot
 * failure under KeepAlive. A value we cannot read means "no watch", which
 * is exactly today's behaviour.
 */

/** Poll period. A second is the same cadence as the tick loop. */
export const HOST_WATCH_EVERY_MS = 1_000;

/**
 * The host pid to watch, or null when this process is not running under
 * the Swift host or the value is unusable. Pure.
 */
export function hostPidFrom(
  env: Readonly<Record<string, string | undefined>>,
): number | null {
  if (env['WEMESSAGE_HOST'] !== 'swift') return null;
  const raw = env['WEMESSAGE_HOST_PID'];
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  const pid = Number(raw);
  // 0 and 1 cannot be a host we outlive: 1 is launchd itself.
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  return pid;
}

export interface HostWatchOptions {
  readonly hostPid: number;
  /** Reads the CURRENT parent pid. Production: `() => process.ppid`. */
  readonly parentPid: () => number;
  /** Called once, the first time the parent is no longer the host. */
  readonly onHostGone: () => void;
  readonly everyMs?: number;
}

export interface HostWatch {
  stop(): void;
}

/**
 * Starts the watch. Checks once immediately (a host that died between our
 * spawn and this line is already gone), then every `everyMs`. The timer is
 * unref'd: the watch is never a reason to stay alive.
 */
export function watchHost(opts: HostWatchOptions): HostWatch {
  let fired = false;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const check = (): void => {
    if (fired) return;
    if (opts.parentPid() === opts.hostPid) return;
    fired = true;
    stop();
    opts.onHostGone();
  };
  check();
  if (!fired) {
    timer = setInterval(check, opts.everyMs ?? HOST_WATCH_EVERY_MS);
    timer.unref();
  }
  return { stop };
}

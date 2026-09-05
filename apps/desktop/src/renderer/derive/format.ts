/**
 * Time, as a person reads it. Pure, and the renderer's only formatter.
 *
 * Two functions and no dependency, because both are things the app has to
 * agree with itself about in three places: the card's relative label, the
 * strip's horizon and the strip's last-sync line all describe instants the
 * daemon supplied, and three local spellings of "half past two" is three
 * chances for the screen to contradict itself in a screenshot.
 *
 * `hhmm` is 24-hour and locale-neutral on purpose. It is compared against
 * the daemon's own record in the e2e, and a 12-hour rendering would make
 * that comparison depend on the host's region — the class of row that passes
 * on the author's Mac and fails on the reviewer's.
 */

/** An instant as `hh:mm`, 24-hour, in the host's zone. */
export function hhmm(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--:--';
  return at.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * How long ago, in the coarsest honest unit.
 *
 * Uppercase because every derived word on this screen is: the card mixes the
 * operator's own message text with labels the app wrote, and case is the
 * cheapest way to keep the two apart at a glance.
 *
 * A future instant reads `JUST NOW` rather than a negative age. The daemon's
 * clock and this one can legitimately differ by a second, and `-1M AGO` is a
 * bug report about the wrong system.
 */
export function ago(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return 'UNKNOWN';
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return 'JUST NOW';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}H AGO`;
  return `${String(Math.floor(hours / 24))}D AGO`;
}

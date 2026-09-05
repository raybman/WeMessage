/**
 * The schedule, at a glance, for a screen with nothing else to say.
 *
 * The empty queue is the one place in this app where the absence of work is
 * the whole message, and an operator looking at it has exactly one question:
 * is this empty because nothing happened, or empty because nothing CAN
 * happen? The state strip answers the second half for a busy screen; an
 * empty one has room to say it plainly.
 *
 * Three shapes and no fourth. The daemon reports arming as a reason plus an
 * optional horizon (§1.3.6: `until` is the earliest REAL horizon across
 * every dimension, not the winning reason's own clock), so a horizon is
 * rendered as a bare `UNTIL` rather than attributed to anything.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is name a deny reason. S6's
 * dormant-deny-literal row pins the exact set of production files allowed to
 * spell each of the gate's reasons, and a comment is not an exemption; more
 * to the point, an empty queue does not need to litigate WHY it is disarmed
 * when the strip above it is already carrying the daemon's own word. So the
 * disarmed shape says what it costs the operator — drafts still collect,
 * nothing goes out — and leaves the reason to the line that owns it.
 */
import { hhmm } from './format.js';

/** The daemon's arming record, exactly as the stream carries it. */
export interface ArmingRecord {
  readonly reason: string;
  readonly until: string | null;
}

/** The one reason that means "sending is on". Everything else is a hold. */
const ARMED = 'armed';

export function armingGlance(armed: ArmingRecord | null): string {
  // `null` is the daemon saying it has no store to derive arming from, which
  // is not the same as a hold and must not read like one either — but from
  // the operator's side both mean nothing leaves, so the honest rendering is
  // the disarmed one. The strip distinguishes them.
  if (armed === null || armed.reason !== ARMED) return 'DISARMED · QUEUE-ONLY';
  return armed.until === null ? 'ARMED' : `ARMED UNTIL ${hhmm(armed.until)}`;
}

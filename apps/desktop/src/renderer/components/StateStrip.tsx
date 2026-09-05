/**
 * The state strip: two independent axes, said out loud, in one line.
 *
 *   LINK      can we hear the daemon at all?
 *   OUTBOUND  is the daemon allowed to speak right now, and until when?
 *
 * Sc4 had only the first, and the shape it pushed could only render the
 * second as a suffix. That was survivable while the app was a shell and
 * became a lie the moment there was a queue on screen: a `read-only` daemon
 * on a perfectly healthy socket is CONNECTED on the link axis and SEND
 * DISABLED on the outbound one, and an operator looking at twenty drafts
 * needs the second sentence far more than the first.
 *
 * §3.10 — state is carried by a GLYPH, never by hue alone. The strip is
 * coloured as well, but a reader who cannot distinguish the tint from the
 * danger red still reads ● against ⊘ against ◌, and `data-state` and
 * `data-outbound` carry the same two facts to assistive technology and to
 * the e2e.
 *
 * The arming text is the daemon's own word, uppercased, and nothing else.
 * Rewording a deny reason into a friendlier sentence here would put a second
 * vocabulary in front of the operator, and the CLI's is the one they will
 * read in a support thread. (Most of the reasons are not spelled in this
 * file at all: S6's dormant-deny-literal row pins the exact set of files
 * allowed to name each one, and a comment is not an exemption. The two this
 * file does name are the two that change the GLYPH, and neither is on that
 * list.)
 */
import type { VNode } from 'preact';
import { ago, hhmm } from '../derive/format.js';
import { HEALTH_GLYPH } from '../derive/state.js';
import type { StreamPayload } from '../../main/gateway.js';

export interface StripProps {
  readonly stream: StreamPayload;
  /** Cards the operator still owes a decision. */
  readonly pending: number;
  /** The last instant a fetch actually answered, or absent if none has. */
  readonly syncedAt: string | undefined;
  readonly now: string;
}

/** What the strip is FOR, as one word each, plus the glyph that carries it. */
interface Headline {
  readonly glyph: string;
  readonly word: string;
}

/**
 * The headline, resolved on the outbound axis first.
 *
 * Precedence is deliberate and is the opposite of the obvious one: the link
 * is checked FIRST only because a link we do not have makes every other
 * claim unverifiable. After that the outbound axis wins, because "connected"
 * is not news to somebody watching a queue and "nothing you approve will go
 * anywhere" very much is.
 */
function headline(stream: StreamPayload): Headline {
  if (stream.state !== 'connected')
    return { glyph: '◌', word: 'DAEMON UNREACHABLE' };
  const reason = stream.armed?.reason;
  if (reason === 'kill-switch') return { glyph: '⊘', word: 'OUTBOUND: KILLED' };
  // The daemon is answering and Messages is not sending: automation was
  // refused, the Mac is unsupported, or the bridge is down. All three mean
  // the same thing to a person holding a queue.
  if (reason === 'read-only' || reason === 'unsupported')
    return { glyph: '◐', word: 'SEND DISABLED' };
  return { glyph: '●', word: 'CONNECTED' };
}

/**
 * The hold, and its horizon.
 *
 * `until` is the earliest REAL horizon among every dimension, not the winning
 * reason's own clock (§1.3.6), so it is rendered as a bare `UNTIL` rather
 * than as "paused until", which would be attributing it.
 */
function armingText(stream: StreamPayload): string {
  if (stream.state === 'reconnecting')
    return `RETRYING · ATTEMPT ${String(stream.attempt)}`;
  if (stream.state === 'down') return stream.reason.toUpperCase();
  // `null` is the daemon saying it has no store to derive arming from, which
  // is not the same as "not armed" and must not read like it.
  if (stream.armed === null) return 'NO SCHEDULE';
  const word = stream.armed.reason.toUpperCase();
  return stream.armed.until === null
    ? word
    : `${word} UNTIL ${hhmm(stream.armed.until)}`;
}

/**
 * The second line's worth of fact, on one line.
 *
 * Connected: how much work is waiting, which is the number the operator came
 * to the app for. Killed: that number AND the sentence that stops them
 * closing the window — the drafts are still being collected, so the queue
 * they come back to will be complete.
 *
 * Not connected: when we last actually heard anything. A reconnecting app
 * that shows a pending count is showing a count it cannot vouch for, and the
 * honest thing to put there is the age of the number instead.
 */
function detailText(props: StripProps): string {
  const { stream, pending, syncedAt } = props;
  if (stream.state === 'connected') {
    const count = `${String(pending)} PENDING`;
    return stream.armed?.reason === 'kill-switch'
      ? `${count} · NOTHING SENDS · DRAFTS STILL COLLECT`
      : count;
  }
  if (syncedAt === undefined) return 'NEVER SYNCED';
  return `LAST SYNC ${hhmm(syncedAt)} · ${ago(syncedAt, props.now)}`;
}

export function StateStrip(props: StripProps): VNode {
  const { stream } = props;
  const head = headline(stream);
  return (
    <div
      id="state-strip"
      data-state={stream.state}
      data-outbound={
        stream.state === 'connected' ? (stream.armed?.reason ?? 'unknown') : ''
      }
    >
      <span id="state-strip-label">{`${head.glyph} ${head.word}`}</span>
      <span id="state-strip-arming">{armingText(stream)}</span>
      <span id="state-strip-detail">{detailText(props)}</span>
      {stream.adapters.map((adapter) => (
        <span
          key={adapter.id}
          class="adapter-dot"
          data-health={adapter.health}
          title={adapter.id}
        >
          {`${HEALTH_GLYPH[adapter.health] ?? '◌'} ${adapter.id.toUpperCase()}`}
        </span>
      ))}
    </div>
  );
}

/**
 * The state strip: the one thing on screen at Sc 4, and the surface every
 * later screen hangs under.
 *
 * §3.10 — state is carried by a GLYPH, never by hue alone. The strip is
 * coloured as well, but a reader who cannot distinguish the tint from the
 * danger red still reads ● against ◌, and `data-state` carries the same fact
 * to assistive technology and to the e2e.
 *
 * The arming text is the daemon's own word, uppercased, and nothing else.
 * Rewording a deny reason into a friendlier sentence here would put a second
 * vocabulary in front of the operator, and the CLI's is the one they will
 * read in a support thread. (The reasons themselves are not spelled in this
 * file: S6's dormant-deny-literal row pins the exact set of files allowed to
 * name each one, and a comment is not an exemption.)
 */
import type { VNode } from 'preact';
import type { StreamPayload } from '../../main/gateway.js';

/** §3.10's vocabulary, restricted to the three connection states. */
const GLYPH: Readonly<Record<StreamPayload['state'], string>> = {
  connected: '●',
  reconnecting: '◐',
  down: '◌',
};

function armingText(stream: StreamPayload): string {
  switch (stream.state) {
    case 'connected':
      // `null` is the daemon saying it has no store to derive arming from,
      // which is not the same as "not armed" and must not read like it.
      return stream.armed === null
        ? 'NO SCHEDULE'
        : stream.armed.reason.toUpperCase();
    case 'reconnecting':
      return `ATTEMPT ${String(stream.attempt)}`;
    case 'down':
      return stream.reason.toUpperCase();
  }
}

export function StateStrip({ stream }: { stream: StreamPayload }): VNode {
  return (
    <div id="state-strip" data-state={stream.state}>
      <span id="state-strip-label">
        {`${GLYPH[stream.state]} ${stream.state.toUpperCase()}`}
      </span>
      <span id="state-strip-arming">{armingText(stream)}</span>
    </div>
  );
}

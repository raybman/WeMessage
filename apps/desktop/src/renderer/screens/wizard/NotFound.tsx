/**
 * The card the operator sees when there is no link at all.
 *
 * Written in Sc 4 as the whole of the wizard, and kept verbatim here in Sc
 * 15 when the other four steps arrived. It moved rather than being rewritten
 * on purpose: two desktop e2e rows and one settings row read this card's
 * text and its `data-reason`, and the copy is the only thing in the app that
 * tells somebody with no daemon what to go and do.
 *
 * The four whys are genuinely different and the operator's next action is
 * different for each, which is why this is a `switch` over the closed
 * `DownReason` set rather than one sentence with a variable in it. Nothing
 * has ever run on this Mac; something ran and what it left behind is no
 * longer accepted; something is running and refused the subscription; or
 * nothing is listening at all.
 *
 * The path is rendered from the value main resolved, never reconstructed
 * here. This file may not even NAME the credential: the arch row over
 * `src/renderer` fails on the env var, the reader, the header, the file name
 * and the prefix, so the only way the path can appear on screen is for main
 * to have computed it and pushed it.
 *
 * There is no RECONNECT button, and Sc 15 settled that argument. The S8
 * plan's Scenario 14 says the app "then shows the wizard WELCOME step with
 * RECONNECT" after the danger zone disconnects. The app does land here, but
 * `disconnectDaemon` ROTATES the daemon's own credential, so the bearer this
 * process holds is dead the instant that call returns: a RECONNECT button
 * would be a control that cannot work, offered at the exact moment somebody
 * is deciding whether to trust the product. What is offered instead is what
 * is actually true — where the credential lives, and a relaunch.
 */
import type { VNode } from 'preact';
import type { StreamPayload } from '../../../main/gateway.js';

export type Down = Extract<StreamPayload, { state: 'down' }>;

interface Copy {
  title: string;
  body: string;
  pathLabel: string;
}

function copyFor(reason: Down['reason']): Copy {
  switch (reason) {
    case 'no-token':
      return {
        title: 'wemessaged is not set up on this Mac',
        body:
          'Start the daemon once from a terminal. It mints its credential on ' +
          'first run, keeps it readable only by you, and this app picks it up ' +
          'from the file below the next time it launches.',
        pathLabel: 'It will be written to',
      };
    case 'token-rejected':
      return {
        title: 'wemessaged refused this credential',
        body:
          'The daemon is running and answering, but it did not accept what ' +
          'this app presented. That usually means the credential was rotated ' +
          'after the app read it. Restart wemessaged, then relaunch this app.',
        pathLabel: 'The file it is read from',
      };
    case 'stream-refused':
      return {
        title: 'wemessaged refused the event subscription',
        body:
          'The daemon is running and accepted this app’s credential, but it ' +
          'rejected the subscription this app opened to watch the queue. ' +
          'That is a version mismatch rather than a fault: update whichever ' +
          'of the two is older, then relaunch.',
        pathLabel: 'Configuration lives beside',
      };
    case 'unreachable':
      return {
        title: 'wemessaged is not answering',
        body:
          'Nothing is listening on the port this app was pointed at. Start ' +
          'the daemon, or point the app at the port it is actually on.',
        pathLabel: 'Configuration lives beside',
      };
  }
}

export function NotFoundCard({ stream }: { stream: Down }): VNode {
  const copy = copyFor(stream.reason);
  return (
    <section id="daemon-not-found" data-reason={stream.reason}>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <p>{copy.pathLabel}:</p>
      <code>{stream.tokenPath}</code>
    </section>
  );
}

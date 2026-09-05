/**
 * The `wizard` screen. At Sc 4 it is exactly one step: the card the operator
 * sees when the app has no usable connection.
 *
 * Sc 15 owns the other four steps. This one is here now because it is the
 * other half of the auth bootstrap: an app that cannot reach the daemon has
 * to say WHY in the operator's own terms, and the two whys are genuinely
 * different — nothing has ever run on this Mac, versus something ran and
 * what it left behind is no longer accepted.
 *
 * The path is rendered from the value main resolved, never reconstructed
 * here. This file may not even NAME the credential: the arch row over
 * `src/renderer` fails on the env var, the reader, the header, the file name
 * and the prefix, so the only way the path can appear on screen is for main
 * to have computed it and pushed it.
 */
import type { VNode } from 'preact';
import type { StreamPayload } from '../../../main/gateway.js';

type Down = Extract<StreamPayload, { state: 'down' }>;

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

export default function WizardScreen({ stream }: { stream: Down }): VNode {
  const copy = copyFor(stream.reason);
  return (
    <section id="daemon-not-found" data-reason={stream.reason}>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <p>{copy.pathLabel}:</p>
      <code>{stream.tokenPath}</code>
    </section>
  );
}

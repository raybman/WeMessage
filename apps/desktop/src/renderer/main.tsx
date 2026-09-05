/**
 * The renderer's entry point.
 *
 * Three jobs and no more, because Sc 4 is the shell rather than the app:
 * subscribe to the two pushes the shell needs, mirror the connection state
 * onto `<html>`, and render the strip (plus the wizard card, when there is
 * nothing to be connected to).
 *
 * The `<html>` attributes are the contract with the test suite. `data-conn`
 * is the ONLY wait primitive the desktop e2e has, and it is written from the
 * same value the strip renders, so a harness that proceeds and a UI that is
 * lying about the connection cannot happen at the same time.
 *
 * Every payload arriving over the bridge is narrowed before it is used. It
 * comes from our own main process today, but the renderer is the process
 * that handles untrusted content, and a renderer that trusts its input shape
 * is one bad push away from a blank window with an empty console.
 */
import { render } from 'preact';
import type { VNode } from 'preact';
import './theme/tokens.css';
import './app.css';
import { StateStrip } from './components/StateStrip.js';
import { DEFAULT_SCREEN } from './router.js';
import WizardScreen from './screens/wizard/index.js';
import { applyTheme, asTheme } from './theme/theme.js';
import type { StreamPayload } from '../main/gateway.js';

const mount = document.getElementById('root');
if (mount === null) throw new Error('the document has no #root');
/**
 * Re-declared with the narrowed type rather than relying on the check above.
 * `paint` is a hoisted function declaration, and TypeScript will not carry a
 * control-flow narrowing into one; typing the binding says the same thing in
 * a way the compiler can use everywhere.
 */
const root: HTMLElement = mount;

/**
 * The state before main has said anything.
 *
 * `unreachable` rather than `no-token`: at this instant the app genuinely
 * does not know why, and guessing the friendlier of the two reasons would
 * mean flashing a card that tells the operator to go and look at a file that
 * may be perfectly fine.
 */
let stream: StreamPayload = {
  state: 'down',
  reason: 'unreachable',
  tokenPath: '',
};

function asStream(payload: unknown): StreamPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const state = p['state'];
  if (state === 'connected' || state === 'reconnecting' || state === 'down')
    return payload as StreamPayload;
  return null;
}

function Shell({ stream: current }: { stream: StreamPayload }): VNode {
  return (
    <div id="app">
      <StateStrip stream={current} />
      {current.state === 'down' ? <WizardScreen stream={current} /> : null}
    </div>
  );
}

function paint(): void {
  const html = document.documentElement;
  html.dataset['conn'] = stream.state;
  if (stream.state === 'down') {
    html.dataset['screen'] = 'wizard';
    html.dataset['wizardStep'] = 'welcome';
  } else {
    html.dataset['screen'] = DEFAULT_SCREEN;
    delete html.dataset['wizardStep'];
  }
  render(<Shell stream={stream} />, root);
}

window.wm.on('stream', (payload: unknown) => {
  const next = asStream(payload);
  if (next === null) return;
  stream = next;
  paint();
});

window.wm.on('theme', (payload: unknown) => {
  const theme = asTheme(payload);
  if (theme !== null) applyTheme(theme);
});

paint();

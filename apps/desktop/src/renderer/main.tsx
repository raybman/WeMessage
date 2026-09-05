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
import { bindStore, type StoreBinding } from './store/index.js';
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

/**
 * The queue, bound to the bridge.
 *
 * Sc5 gives the renderer a model; Sc6 gives it a screen. Until then the
 * store is mounted, reconciling, and observable — as `<html>` attributes for
 * the e2e's readiness waits, and as one handle for the rows that need to ask
 * a question no attribute should encode. Mounting it now rather than with
 * the queue view is deliberate: the reconnect and resync behaviour is what
 * this scenario is about, and it has to be provable before anything renders
 * on top of it.
 */
const binding: StoreBinding = bindStore(window.wm, {
  now: () => new Date().toISOString(),
});

/**
 * The queue handle the e2e drives.
 *
 * Not on `window.wm`: that object's key set is asserted against the channel
 * registry, and neither a debugging affordance nor a test hook has any
 * business widening the bridge. What is exposed here is the binding, whose
 * whole reachable surface is the three channels in `STORE_CHANNELS` — so a
 * renderer holding this handle can approve a draft and can no more send a
 * message than the keymap Sc6 will put on top of it.
 */
declare global {
  interface Window {
    __wmQueue: StoreBinding;
  }
}
window.__wmQueue = binding;

binding.store.subscribe(() => {
  paintStore();
});

function paintStore(): void {
  const html = document.documentElement;
  const store = binding.store;
  html.dataset['storeRows'] = String(store.rows().length);
  html.dataset['storeMissed'] = String(store.missed());
  html.dataset['storeStale'] = store.needsSnapshot() ? 'yes' : 'no';
  const at = store.syncedAt();
  if (at === undefined) delete html.dataset['storeSyncedAt'];
  else html.dataset['storeSyncedAt'] = at;
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
paintStore();

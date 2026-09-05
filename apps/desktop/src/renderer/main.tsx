/**
 * The renderer's entry point, and the app's composition root.
 *
 * Everything that is not a pure function lives here, on purpose and in one
 * place: the bridge subscriptions, the queue's cursor, the paint schedule
 * and the `<html>` attributes the e2e waits on. An arch row asserts that no
 * file under `components/`, `screens/`, `keys/` or `derive/` names
 * `window.wm` or a bridge member, so "the view cannot fetch" is a property
 * of the tree rather than a habit — and the other half of that bargain is
 * that this file holds the state those views render.
 *
 * The `<html>` attributes are the contract with the test suite. `data-conn`
 * is the ONLY connection wait primitive the desktop e2e has and is written
 * from the same value the strip renders, so a harness that proceeds and a UI
 * that is lying about the connection cannot happen at the same time.
 * `data-store-*` is the same idea for the queue.
 *
 * Every payload arriving over the bridge is narrowed before it is used. It
 * comes from our own main process today, but the renderer is the process
 * that handles untrusted content, and a renderer that trusts its input shape
 * is one bad push away from a blank window with an empty console.
 *
 * NO TIMER. The app owns exactly one `setTimeout` and it is main's reconnect
 * backoff; an arch row proves the renderer has none. A burst of frames —
 * five hundred `message.received` in one ingest poll — is coalesced on a
 * MICROTASK instead, which is not a timer and cannot be tuned into a
 * debounce that hides a slow render.
 */
import { render } from 'preact';
import type { VNode } from 'preact';
import './theme/tokens.css';
import './app.css';
import { StateStrip } from './components/StateStrip.js';
import { byAge, cardOf, type CardModel } from './derive/queue.js';
import { moveTo, type QueueVerb } from './keys/index.js';
import { DEFAULT_SCREEN } from './router.js';
import QueueScreen from './screens/queue/index.js';
import WizardScreen from './screens/wizard/index.js';
import { bindStore, type StoreBinding } from './store/index.js';
import type { Conversation } from './store/optimistic.js';
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
  demo: false,
  armed: null,
  adapters: [],
};

function asStream(payload: unknown): StreamPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const state = p['state'];
  if (state === 'connected' || state === 'reconnecting' || state === 'down')
    return payload as StreamPayload;
  return null;
}

/* ── the queue's own state ────────────────────────────────────────────── */

/**
 * The cursor, held as an ID rather than as an index.
 *
 * An index is a claim about a list that changes underneath it: a draft
 * expiring two rows above the cursor would silently move the cursor onto a
 * different card, and the operator's next `a` would approve something they
 * were not looking at. An id survives that — the card either is still in the
 * queue or is not, and "is not" is resolved once, visibly, at derive time.
 */
let activeId: string | null = null;
/** The draft whose context turns are open inline, or none. */
let expandedId: string | null = null;
/** Sc9 fills this in; the listbox already declares itself multi-selectable. */
const selected = new Set<string>();
/** So the catalogue is fetched when a link exists, and once per link. */
let catalogueFor: 'none' | 'connected' = 'none';

const binding: StoreBinding = bindStore(window.wm, {
  now: () => new Date().toISOString(),
});

/**
 * The queue handle the e2e drives.
 *
 * Not on `window.wm`: that object's key set is asserted against the channel
 * registry, and neither a debugging affordance nor a test hook has any
 * business widening the bridge. What is exposed here is the binding, whose
 * whole reachable surface is the five channels in `STORE_CHANNELS` — so a
 * renderer holding this handle can approve a draft and can no more send a
 * message than the keymap on top of it.
 */
declare global {
  interface Window {
    __wmQueue: StoreBinding;
  }
}
window.__wmQueue = binding;

/** Everything the queue screen renders, derived fresh from the store. */
interface QueueView {
  readonly cards: readonly CardModel[];
  readonly activeIndex: number;
  readonly thread: Conversation;
  readonly pending: number;
}

/**
 * Rows in, cards out. Pure with respect to the store, and cheap enough to
 * run again inside a key handler rather than being cached into a variable
 * that can go stale between a keystroke and the paint it caused.
 */
function derive(): QueueView {
  const store = binding.store;
  const catalogue = store.catalogue();
  const now = new Date().toISOString();
  const cards = store
    .rows()
    .map((row) => row.server)
    .sort(byAge)
    .map((draft) =>
      cardOf(draft, {
        catalogue,
        // The three-layer read, in the one place entitled to do it. A card
        // shows what we just did, else what we were told, else what we last
        // fetched — and every one of those is a display fact.
        state: store.stateOf(draft.id) ?? draft.state,
        chip: store.chip(draft.id),
        clampedBy: store.clampOf(draft.id),
        failedWith: store.failureOf(draft.id),
        now,
      }),
    );
  // An id that is no longer in the queue resolves to the top rather than to
  // nothing: the draft it named is gone, and a cursor pointing at a card
  // that does not exist is how `a` ends up doing nothing at all.
  const found =
    activeId === null ? -1 : cards.findIndex((c) => c.draftId === activeId);
  const activeIndex = cards.length === 0 ? -1 : found === -1 ? 0 : found;
  const active = activeIndex === -1 ? undefined : cards[activeIndex];
  return {
    cards,
    activeIndex,
    thread:
      active === undefined
        ? { total: 0, recent: [] }
        : binding.store.conversation(active.chatGuid),
    // What the operator still owes a decision on, which is not the length of
    // the list: a card that has been approved and is waiting on the daemon
    // is on screen and is no longer work.
    pending: cards.filter((card) => card.state === 'pending').length,
  };
}

/**
 * What assistive technology is told, and the whole of it.
 *
 * The SIZE of the queue and nothing else. The listbox announces its own
 * active option through `aria-activedescendant`, so a live region that also
 * described the cursor would make every `j` speak twice and make the
 * twenty-in-a-minute run unlistenable. What it cannot announce is a change
 * the operator did not cause — a draft arriving, a draft expiring — and that
 * is exactly what this says. Because the sentence is derived, the text node
 * only changes when the number does, so the region is silent between them.
 */
function announcementFor(view: QueueView): string {
  if (view.cards.length === 0) return 'NO DRAFTS WAITING';
  return `${String(view.cards.length)} DRAFTS WAITING`;
}

/**
 * A verb, applied. The only place the queue's state moves.
 *
 * Navigation clears the expansion. The inline turns are the ACTIVE
 * conversation's, so an expanded card left behind by the cursor would be
 * showing somebody else's messages under its own body — which is the single
 * worst thing this screen could do.
 */
function onVerb(verb: QueueVerb): void {
  const view = derive();
  const current = view.cards[view.activeIndex];
  if (current === undefined) return;
  if (verb === 'approve') {
    void binding.approve(current.draftId);
    return;
  }
  if (verb === 'expand') {
    expandedId = expandedId === current.draftId ? null : current.draftId;
    schedulePaint();
    return;
  }
  const next = view.cards[moveTo(verb, view.activeIndex, view.cards.length)];
  if (next === undefined) return;
  if (next.draftId !== current.draftId) expandedId = null;
  activeId = next.draftId;
  schedulePaint();
}

function Shell({
  stream: current,
  view,
}: {
  stream: StreamPayload;
  view: QueueView;
}): VNode {
  return (
    <div id="app">
      <StateStrip
        stream={current}
        pending={view.pending}
        syncedAt={binding.store.syncedAt()}
        now={new Date().toISOString()}
      />
      {current.state === 'down' ? (
        <WizardScreen stream={current} />
      ) : (
        <QueueScreen
          cards={view.cards}
          activeIndex={view.activeIndex}
          expandedId={expandedId}
          selected={selected}
          thread={view.thread}
          demo={current.demo}
          announcement={announcementFor(view)}
          onVerb={onVerb}
        />
      )}
    </div>
  );
}

/* ── painting ─────────────────────────────────────────────────────────── */

/**
 * The store's own facts, as attributes.
 *
 * The readiness idiom the whole desktop suite waits on. Written from the
 * same store read the screen renders from, in the same paint, so a harness
 * that proceeds on `data-store-rows` and a list that has not drawn those
 * rows yet cannot happen.
 */
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
  const view = derive();
  // Written back so the cursor SURVIVES the resolution above. A queue whose
  // active card expired keeps re-resolving to the top on every paint; naming
  // the card it landed on makes the next `j` move from there.
  activeId = view.cards[view.activeIndex]?.draftId ?? null;
  paintStore();
  render(<Shell stream={stream} view={view} />, root);
}

/**
 * One paint per microtask, however many facts changed.
 *
 * Five hundred `message.received` frames arrive from one ingest poll as five
 * hundred synchronous `notify()` calls, and painting each would be five
 * hundred renders of a list that ends in one state. Coalescing on a
 * microtask is the version of that fix which needs no timer, cannot be
 * "tuned" into a delay that hides a slow render, and still guarantees the
 * DOM is correct before control returns to the event loop — which is what
 * lets the e2e assert on the very next tick.
 */
let painting = false;
function schedulePaint(): void {
  if (painting) return;
  painting = true;
  queueMicrotask(() => {
    painting = false;
    paint();
  });
}

binding.store.subscribe(schedulePaint);

window.wm.on('stream', (payload: unknown) => {
  const next = asStream(payload);
  if (next === null) return;
  stream = next;
  // The catalogue is fetchable only while there is a daemon to fetch it
  // from, so the composition root asks on the edge INTO `connected` rather
  // than at mount: at mount the request is guaranteed to fail, and a name
  // catalogue that is empty because nobody was listening is indistinguishable
  // on screen from one that is empty because there are no contacts.
  //
  // On the edge and not on every push: `stream` fires for every reconnect
  // attempt, and a fetch per attempt would put a request storm behind a
  // flapping socket. `bindStore` itself never does this — four unit rows pin
  // the exact channel sequence its connect path produces — because the
  // decision about when names are worth a round trip belongs to the root.
  const linked = next.state === 'connected' ? 'connected' : 'none';
  if (linked !== catalogueFor) {
    catalogueFor = linked;
    if (linked === 'connected') void binding.loadCatalogue().then(paint, paint);
  }
  paint();
});

window.wm.on('theme', (payload: unknown) => {
  const theme = asTheme(payload);
  if (theme !== null) applyTheme(theme);
});

paint();

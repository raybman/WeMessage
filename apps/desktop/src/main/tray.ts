/**
 * The tray: the one surface that acts while the window is invisible.
 *
 * Everything about what it SAYS lives next door in `tray-model.ts`, as pure
 * functions over a plain value. This file is the part that cannot be pure —
 * it owns the `Tray`, the `Menu` and the five `NativeImage`s, it holds the
 * model, and it decides WHEN to look again. Three of those decisions are
 * load-bearing.
 *
 * **How it stays truthful without a clock.** There is no timer here. Not a
 * `setInterval` refreshing the count, not a `setTimeout` counting a pause
 * down, and no tick anywhere in the file — an arch row asserts it, over this
 * file and its four neighbours, with the process-wide census that leaves
 * exactly one `setTimeout` in the tree (the reconnect ladder's backoff).
 *
 * Instead it re-reads on EVENTS. The daemon already says everything that
 * matters: `draft.*` moves the queue, `toggle.changed` and `arming.changed`
 * and `adapter.health` move the posture, and the gateway turns all three of
 * the latter into a fresh status push. So the tray listens to the same two
 * streams the windows do and rebuilds from what it was told. What it never
 * does is compute elapsed time: a pause is rendered as the wall-clock instant
 * the daemon reported, in UTC, with a `Z` on it. "In 42 minutes" would be
 * wrong one second after it was written, and this menu has nothing to correct
 * it with. `arming.changed` is what corrects it.
 *
 * **What carries state besides colour.** A macOS tray image is a TEMPLATE
 * image: the system paints it with the menu bar's ink and inverts it in dark
 * mode, so the icon physically cannot carry a hue. §1.7's rule is satisfied
 * structurally rather than by discipline — five distinct SHAPES, plus an
 * uppercase WORD as the first line of the menu and as the whole of the
 * tooltip. An operator who cannot tell the shapes apart can still read it.
 *
 * **What the title may contain.** The title is a strip of text next to the
 * clock, in front of anyone who walks past the machine and, on some systems,
 * in front of accessibility tooling. It is a count and nothing else: no
 * message body, no handle, no adapter name, no token. `trayBadge` returns
 * `''`, a digit, or `9+`, and `trayTooltip` is a glyph, a word, and that same
 * count. An e2e row seeds a distinctive body and handle and proves neither
 * reaches either string.
 */
import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
} from 'electron';

import type { DeepLink } from './deep-link.js';
import type { GatewayWatcher, StreamPayload, TrayKey } from './gateway.js';
import { record } from './test-state.js';
import { TRAY_GLYPHS } from './tray-glyphs.js';
import {
  TRAY_POSTURES,
  TRAY_POSTURE_SPEC,
  trayBadge,
  trayMenu,
  trayPosture,
  trayQueueOf,
  traySignificant,
  trayTooltip,
  type ShortcutState,
  type TrayCommand,
  type TrayDraftInput,
  type TrayItem,
  type TrayModel,
} from './tray-model.js';

export interface TrayDeps {
  /** The four handlers a tray may reach. Narrower than `RequestKey`. */
  invoke(key: TrayKey, args: readonly unknown[]): Promise<unknown>;
  /** Re-read the daemon's posture, for the disconnected menu's repair item. */
  checkNow(): void;
  /**
   * Bring the one window forward, optionally on a screen or a card.
   *
   * INJECTED rather than imported. `index.ts` owns the window lifetime and
   * `index.ts` imports this file, so importing back would be a module cycle
   * — and a cycle whose first evaluation order depends on which side the
   * bundler happens to enter is a class of boot bug nobody wants to debug
   * inside a tray callback.
   */
  showMainWindow(link?: DeepLink): void;
  quit(): void;
  /** What the OS said about the chord, decided before the tray is built. */
  shortcut: ShortcutState;
}

export interface TrayHandle extends GatewayWatcher {
  dispose(): void;
}

/** The queue read. `{}` rather than a filter: the store's default IS the queue. */
const QUEUE_QUERY: Readonly<Record<string, never>> = {};

/**
 * Narrow one row of `GET /v1/drafts` into what a menu may show.
 *
 * Structural, and deliberately not a cast to `DraftPayload`. This is a
 * response from another process; a row that is missing a field is a row the
 * tray declines to render rather than a crash inside a menu build.
 */
function asDraft(value: unknown): TrayDraftInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const { id, body, state, createdAt } = row;
  if (typeof id !== 'string') return null;
  if (typeof state !== 'string') return null;
  if (typeof createdAt !== 'string') return null;
  return { id, body: typeof body === 'string' ? body : '', state, createdAt };
}

export function createTray(deps: TrayDeps): TrayHandle {
  /* ── the five icons, minted once ─────────────────────────────────────── */

  const images: Record<string, Electron.NativeImage> = {};
  for (const [name, build] of Object.entries(TRAY_GLYPHS)) {
    const bitmap = build();
    const image = nativeImage.createFromBitmap(Buffer.from(bitmap.buffer), {
      width: bitmap.width,
      height: bitmap.height,
    });
    // macOS then paints it with the menu bar's own ink, which is what makes
    // the shape the carrier of state and the colour nobody's business.
    image.setTemplateImage(true);
    images[name] = image;
  }
  for (const posture of TRAY_POSTURES) {
    const name = TRAY_POSTURE_SPEC[posture].image;
    // A posture with no bitmap is a tray that silently shows the last icon,
    // which is the worst possible failure for a control whose entire job is
    // to say which state you are in. Fail at boot, where it can be seen.
    if (images[name] === undefined)
      throw new Error(`tray-glyph-missing:${name}`);
  }
  record({ images });

  /* ── the model ───────────────────────────────────────────────────────── */

  let model: TrayModel = {
    conn: 'down',
    killSwitch: null,
    armed: null,
    adapters: [],
    queue: trayQueueOf([]),
    shortcut: deps.shortcut,
    lastSync: null,
  };

  const first = TRAY_POSTURE_SPEC[trayPosture(model)].image;
  const tray = new Tray(images[first] as Electron.NativeImage);
  record({ tray });

  /* ── running a command ───────────────────────────────────────────────── */

  /**
   * What happens when the daemon refuses.
   *
   * `POST /v1/toggles/pause` answers 409 `not-armed` for `rest-of-window`
   * when no schedule window is open, and any of these can fail outright while
   * the socket is going down. There is no menu in which to render an error, so
   * the honest response is to go and re-read the truth: the posture line and
   * the pause label are rebuilt from the daemon's own answer, and an operator
   * who clicked something that did not take sees it did not take. What this
   * must never do is assume it worked and relabel itself.
   */
  function settle(work: Promise<unknown>): void {
    void work.then(
      () => undefined,
      () => {
        deps.checkNow();
      },
    );
  }

  function run(command: TrayCommand): void {
    switch (command.kind) {
      case 'navigate':
        deps.showMainWindow({
          screen: command.screen,
          draftId: command.draftId,
        });
        return;
      case 'pause':
        settle(deps.invoke('pause', [command.until]));
        return;
      case 'resume':
        settle(deps.invoke('resume', []));
        return;
      case 'kill':
        // `[true]` and there is no other spelling. The kill switch is a DENY
        // and a deny binds everyone including the operator, so it is armed
        // from a surface that can be mis-clicked and released only from the
        // window, where the person doing it can see what they are looking at.
        settle(deps.invoke('killSwitch', [true]));
        return;
      case 'open':
        deps.showMainWindow();
        return;
      case 'quit':
        deps.quit();
        return;
      case 'retry':
        deps.checkNow();
        return;
      case 'doctor':
        // The setup checks are what the settings screen performs when it
        // mounts. There is no headless second path that runs them, and
        // inventing one would be two owners of one answer.
        deps.showMainWindow({ screen: 'settings' });
        return;
    }
  }

  /* ── building the real menu ──────────────────────────────────────────── */

  /**
   * Every item gets an `id` and a real `click`, separators included.
   *
   * Not decoration. The e2e invokes items by calling `MenuItem.click()` on
   * the item the operating system would have called, which is what makes
   * "this entry does not approve" a statement about the wiring rather than
   * about a mirror. `MenuItem.click` is `undefined` when none was supplied,
   * so an item without one is an item a negative row cannot exercise — and
   * the negative row is the one that clicks EVERYTHING.
   */
  function template(items: readonly TrayItem[]): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
      const command = item.command;
      return {
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        ...(item.separator === true ? { type: 'separator' as const } : {}),
        ...(item.submenu === undefined
          ? {}
          : { submenu: template(item.submenu) }),
        click: () => {
          if (command !== undefined) run(command);
        },
      };
    });
  }

  function render(): void {
    const spec = TRAY_POSTURE_SPEC[trayPosture(model)];
    const menu = Menu.buildFromTemplate(template(trayMenu(model)));
    tray.setContextMenu(menu);
    tray.setImage(images[spec.image] as Electron.NativeImage);
    // Recorded whatever the platform does with them, so the e2e can assert
    // the DECISION on every lane and the READBACK on the one that has it.
    record({
      menu,
      title: trayBadge(model),
      tooltip: trayTooltip(model),
      image: spec.image,
    });
    // Feature tests, not style. `setTitle` is darwin-only on this Electron
    // and `setToolTip` is not implemented on every lane either; both are
    // absent rather than inert where they are unsupported, so calling one
    // unguarded is a TypeError on the platform CI actually runs.
    if (typeof tray.setTitle === 'function') tray.setTitle(trayBadge(model));
    if (typeof tray.setToolTip === 'function')
      tray.setToolTip(trayTooltip(model));
  }

  /* ── going and looking again ─────────────────────────────────────────── */

  /**
   * One read at a time, with a re-run bit rather than a queue.
   *
   * A burst of `draft.created` frames arrives as fast as the daemon writes
   * them, and one request per frame would put the tray's own load on the
   * daemon at exactly the moment it is busiest. Coalescing to "at most one in
   * flight, and one more afterwards if anything happened while it was" is the
   * cheapest shape that cannot end on a stale answer. There is no debounce,
   * because a debounce is a timer.
   */
  let inFlight = false;
  let again = false;

  function refetch(): void {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void deps.invoke('drafts', [QUEUE_QUERY]).then(
      (rows) => {
        if (Array.isArray(rows)) {
          const parsed = rows
            .map((row) => asDraft(row))
            .filter((row): row is TrayDraftInput => row !== null);
          model = {
            ...model,
            queue: trayQueueOf(parsed),
            // The instant we last heard a complete answer, which is what the
            // disconnected menu reports. Read in MAIN, where §1.7's ban on
            // `Date` in `screens/` does not apply and where the alternative
            // would be inventing a clock the daemon did not send.
            lastSync: new Date().toISOString(),
          };
        }
        finish();
      },
      () => {
        // A failed read leaves the last known queue in place. A count that
        // dropped to zero because a request failed would tell an operator
        // their queue had drained.
        finish();
      },
    );
  }

  function finish(): void {
    inFlight = false;
    render();
    if (again) {
      again = false;
      refetch();
    }
  }

  /* ── the two things the gateway tells us ─────────────────────────────── */

  render();

  return {
    stream(payload: StreamPayload): void {
      const wasConnected = model.conn === 'connected';
      model = {
        ...model,
        conn: payload.state,
        killSwitch: payload.killSwitch,
        armed: payload.armed,
        adapters: payload.adapters,
      };
      // The edge INTO connected is the one moment the tray has to ask,
      // because everything before it was a guess and no event will announce
      // the drafts that were already there.
      if (!wasConnected && payload.state === 'connected') refetch();
      else render();
    },
    frame(event): void {
      if (traySignificant(event)) refetch();
    },
    dispose(): void {
      tray.destroy();
      record({ tray: null, menu: null, images: {} });
    },
  };
}

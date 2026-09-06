/**
 * The one system-wide keystroke, and the argument for what it is allowed to
 * do.
 *
 * A global shortcut is not a keyboard shortcut. It fires when this app is not
 * focused, not visible and possibly not thought about — while the operator is
 * in a terminal, in a browser, in someone else's full-screen video call. The
 * plan names the chord ⌘⇧K and asks it to toggle the kill switch.
 *
 * **This refuses that, and the refusal is the point.**
 *
 * A toggle needs context and this chord has none. The operator pressing it
 * cannot see which state they are in, because the surface that would tell
 * them is the window they have not looked at. So half the presses of a chord
 * that MEANS "stop the world" would instead RELEASE the deny — and that half
 * is precisely the half where somebody is panicking, pressing it twice
 * because nothing appeared to happen. A control whose effect depends on
 * invisible state is not a safety control; it is a coin flip with a safety
 * control's name on it.
 *
 * The alternative the brief allows — act, but only after bringing the window
 * forward and confirming in-app — collapses into this one on inspection. Once
 * the window is forward and a confirmation is required, the chord has already
 * done everything it can safely do, and the confirmation is a button that
 * exists anyway. So the chord SUMMONS, and it summons onto `settings`, whose
 * first control is the kill switch. The cost is one keystroke in the case
 * that matters. The saving is an entire class of catastrophic misfire, and a
 * `globalShortcut` handler that is structurally incapable of writing.
 *
 * There is no `unregisterAll()` here either. That call is global to the
 * process, and a file that owns one accelerator should not be able to reach
 * every accelerator, including ones a future scenario registers.
 */
import { globalShortcut } from 'electron';

import type { DeepLink } from './deep-link.js';
import { record } from './test-state.js';
import {
  TRAY_ACCELERATOR,
  shortcutStateOf,
  type ShortcutState,
} from './tray-model.js';

export interface ShortcutDeps {
  /** Bring the one window forward, optionally on a screen. Injected. */
  readonly showMainWindow: (link?: DeepLink) => void;
}

export interface ShortcutHandle {
  readonly accelerator: string;
  /** `registered`, `taken` or `declined` — said out loud, never swallowed. */
  readonly state: ShortcutState;
  dispose(): void;
}

/**
 * The pane the chord lands on.
 *
 * `settings` and not `queue`: the chord is the panic key, and the first
 * control on the settings screen is the kill switch. Landing on the queue
 * would put an approve button under the operator's cursor at the moment they
 * least want one there.
 */
const SUMMON: DeepLink = { screen: 'settings' };

/**
 * Claim the chord, and report honestly what the OS said.
 *
 * Two booleans, because they answer different questions and either can be
 * the false one. `register` reports whether this call was accepted; another
 * application already owning the combination is the documented false. But an
 * accepted registration is not the same as a held one — a platform with no
 * global shortcut support at all accepts and holds nothing — so the answer is
 * only trustworthy after `isRegistered` agrees. Both go into `shortcutStateOf`,
 * which is pure, total, and unit-tested over all four combinations.
 *
 * Neither answer is dropped on the floor. The state reaches the tray menu and
 * the settings pane as a sentence, so an operator whose chord is dead finds
 * out by reading rather than by pressing it and wondering.
 */
export function createShortcut(deps: ShortcutDeps): ShortcutHandle {
  const fire = (): void => {
    deps.showMainWindow(SUMMON);
  };

  let accepted = false;
  try {
    accepted = globalShortcut.register(TRAY_ACCELERATOR, fire);
  } catch {
    // Some platforms throw rather than answer for an accelerator they cannot
    // parse. A throw during boot would take the whole app down over a
    // convenience, so it is folded into the same closed vocabulary.
    accepted = false;
  }
  const state = shortcutStateOf(
    accepted,
    globalShortcut.isRegistered(TRAY_ACCELERATOR),
  );

  record({ shortcut: { accelerator: TRAY_ACCELERATOR, state }, fire });

  return {
    accelerator: TRAY_ACCELERATOR,
    state,
    dispose(): void {
      if (state === 'registered') globalShortcut.unregister(TRAY_ACCELERATOR);
      record({ fire: null });
    },
  };
}

/**
 * The main-process observation window, for the surfaces with no DOM behind
 * them.
 *
 * Everything else this app does can be seen from the page: a screen is
 * `data-screen`, a request is a line in the TCP tee, a refusal is an
 * attribute. A `Tray` is not like that. It has no DOM, no accessibility tree
 * Playwright can query, and on Electron 44 no `tray.getImage()` to read an
 * icon back from. A global shortcut is worse: it is a fact held by the window
 * server about a process that is not focused.
 *
 * The plan's answer was to mirror the menu onto `<html>` as a
 * `data-tray-menu` JSON blob and assert on that. This file exists because
 * that answer is wrong twice over. It would put the menu's contents — draft
 * previews included — into the renderer, which is the one place Sc4 spent a
 * whole scenario keeping things OUT of; and asserting on a mirror proves the
 * mirror was written, not that the menu says anything.
 *
 * So instead main RETAINS the real objects and the e2e reaches them with
 * `electronApp.evaluate`, which runs here. A row that clicks a menu item is
 * calling `MenuItem.click()` on the item the operating system would have
 * called, and a row that reads an icon is reading the bytes of the
 * `NativeImage` the tray is actually showing.
 *
 * Three properties keep this from becoming a back door:
 *
 *  - **It is gated.** Without `WEMESSAGE_DESKTOP_TEST=1` nothing is published
 *    and `record` is a no-op. A shipped build has no `__wmTrayState`.
 *  - **It holds no secret.** The tray title, the tooltip, the menu and the
 *    images. There is no token here, no daemon URL, no message body beyond
 *    the preview the menu itself displays — and an e2e row asserts that the
 *    title and tooltip contain no content, no handle and no token prefix.
 *  - **It cannot act.** It is a bag of references. Nothing on it is a verb
 *    except `fire`, which is the shortcut callback the window server would
 *    have invoked, and which — by row 9's construction — only summons.
 *
 * Kept separate from Sc4's `__wmTestState` deliberately. That one is owned by
 * `window.ts` and describes the WINDOW; merging the two would give `tray.ts`
 * and `window.ts` a shared mutable module and an import edge in a direction
 * the dependency graph does not otherwise have.
 */
import type { Menu, NativeImage, Tray } from 'electron';

import { TEST_FLAG } from './policy.js';

/** Everything the e2e is allowed to see, and nothing that could be used. */
export interface TrayTestState {
  tray: Tray | null;
  menu: Menu | null;
  /** What was last passed to `setTitle`. Recorded because macOS-only. */
  title: string;
  tooltip: string;
  /** The NAME of the posture image currently set, e.g. `armedTemplate`. */
  image: string;
  /** All five, minted once, so a row can prove they are five and not one. */
  images: Record<string, NativeImage>;
  shortcut: { accelerator: string; state: string };
  /** The chord's own callback, invoked the way the window server would. */
  fire: (() => void) | null;
}

const testing = process.env[TEST_FLAG] === '1';

const state: TrayTestState = {
  tray: null,
  menu: null,
  title: '',
  tooltip: '',
  image: '',
  images: {},
  shortcut: { accelerator: '', state: '' },
  fire: null,
};

if (testing)
  (globalThis as unknown as { __wmTrayState: TrayTestState }).__wmTrayState =
    state;

/**
 * Record a fact about the tray or the shortcut.
 *
 * A function rather than an exported object, so that a caller cannot hold a
 * reference to the bag and start reading FROM it. Facts flow one way: main
 * decides, this remembers, the test reads.
 */
export function record(patch: Partial<TrayTestState>): void {
  if (!testing) return;
  Object.assign(state, patch);
}

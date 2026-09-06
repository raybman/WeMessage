/**
 * The three system switches, owned by main and pushed to the renderer.
 *
 * Two of the three could have been left to CSS media queries alone
 * (`prefers-color-scheme`, `prefers-reduced-motion`), and the sheet does
 * carry them, because a renderer that can restyle itself without a round
 * trip is a renderer that never flashes the wrong theme on boot. The third
 * cannot: "reduce transparency" has to remove the WINDOW's vibrancy, which
 * only main can do, and opaque layers behind a still-vibrant window is the
 * exact defect the setting exists to prevent. So all three travel the same
 * path, and the e2e asserts the pair moves together.
 */
import { nativeTheme } from 'electron';
import { CHANNELS } from './ipc-channels.js';
import { TEST_FLAG } from './policy.js';
import { applyVibrancyToAll, pushToWindows } from './window.js';

export interface ThemePayload {
  dark: boolean;
  reducedTransparency: boolean;
  /**
   * Reported for completeness; the sheet's own `prefers-reduced-motion`
   * block is what zeroes the durations. Electron exposes no reduced-motion
   * signal, so this is only ever moved by the test hook.
   */
  reducedMotion: boolean;
}

let current: ThemePayload = {
  dark: true,
  reducedTransparency: false,
  reducedMotion: false,
};

/** The theme as last computed, replayed to a window that reloads. */
export function currentTheme(): ThemePayload {
  return current;
}

function fromSystem(): ThemePayload {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    reducedTransparency: nativeTheme.prefersReducedTransparency,
    reducedMotion: current.reducedMotion,
  };
}

/**
 * No window argument, on purpose.
 *
 * Sc16 gave the app a life without a window: the tray keeps it running after
 * the last one closes, and a deep link or the chord builds a new one. A theme
 * that had captured a window at boot would be re-vibrancying a destroyed
 * object from inside a `nativeTheme` listener. Both halves therefore ask for
 * the live set at the moment they act.
 */
function apply(): void {
  applyVibrancyToAll(!current.reducedTransparency);
  pushToWindows(CHANNELS.theme, current);
}

/**
 * Re-assert the current theme, for a window that has just been created.
 *
 * `WINDOW_OPTIONS` gives a new window the vibrant material unconditionally,
 * which is right for the common case and wrong for exactly one: an operator
 * with "reduce transparency" on, who closed the window and opened a new one.
 * That window would be born transparent. This is the call that corrects it,
 * and it is a re-assertion of state main already holds rather than a second
 * source of truth.
 */
export function refreshTheme(): void {
  apply();
}

/**
 * Begin tracking the system theme.
 *
 * Under `WEMESSAGE_DESKTOP_TEST` a `__wmPushTheme` hook is exposed on main's
 * `globalThis`. It is an OBSERVATION point, not a capability: it moves the
 * same state `nativeTheme` would move, through the same code path, and it
 * exists because no CI machine can be asked to toggle "reduce transparency"
 * in System Settings. The e2e proves the hook is absent without the flag.
 */
export function startTheme(): void {
  current = fromSystem();
  apply();
  nativeTheme.on('updated', () => {
    current = fromSystem();
    apply();
  });
  if (process.env[TEST_FLAG] === '1')
    (
      globalThis as unknown as {
        __wmPushTheme?: (patch: Partial<ThemePayload>) => void;
      }
    ).__wmPushTheme = (patch: Partial<ThemePayload>): void => {
      current = { ...current, ...patch };
      apply();
    };
}

/**
 * Navigation, as a pure function of one keystroke.
 *
 * The app is a keymap, not a sidebar, and that is forced rather than
 * chosen. Sc6 asserts the whole window has exactly ONE tab stop while the
 * queue is up — the listbox — because a virtualised option that grew a
 * focusable node would unmount the focus holder mid-scroll. A persistent
 * clickable nav rail is six more tab stops in front of every screen, so the
 * rail cannot exist while that claim does. §1.7 sanctions the alternative
 * from the other side: "no key is bound while `data-conn !== 'connected'`
 * except navigation" names navigation as a key.
 *
 * ⌘-digit, and only ⌘-digit:
 *
 *  - `verbOf` returns `null` for ANY stroke carrying meta, ctrl or alt, so a
 *    navigation stroke cannot collide with a queue verb today or after some
 *    later scenario binds another letter.
 *  - `event.code` rather than `event.key`. `code` is the physical key, so
 *    ⌘2 reaches the rules screen on Dvorak, AZERTY and Colemak, where `key`
 *    would be a different character on each.
 *  - unmodified digits are left alone. They belong to whatever has focus,
 *    and a text field that swallowed the operator's `2` because the shell
 *    wanted it would be the worst kind of global shortcut.
 *
 * The table is TOTAL over F-113's closed registry: its type is satisfied
 * only when the pairs name every `Screen` and nothing else, so a
 * seventeenth screen fails to compile here rather than shipping
 * unreachable. An arch row asserts the same thing from the outside, by
 * reading `SCREENS` out of `router.ts`.
 *
 * Pure: no subscription, no DOM. The composition root owns the app's one
 * `addEventListener` and hands strokes here; this decides, it does not
 * listen. An arch row proves that is still true.
 */
import type { Screen } from '../router.js';

/** The fields of a `KeyboardEvent` this decision is allowed to see. */
export interface ScreenStroke {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/**
 * Every screen, and the physical key that reaches it.
 *
 * PAIRS rather than a record literal, and that is not a style choice. A
 * record puts the six screen names in KEY position, where the formatter is
 * free to drop their quotes; the arch row that proves every member of
 * `SCREENS` is reachable reads this file's code and looks for each name as
 * a string literal. Written as pairs, the names stay what they actually
 * are: values drawn from `router.ts`'s closed registry, quoted like any
 * other string, and stable under `prettier --write`.
 */
const PAIRS = [
  ['queue', 'Digit1'],
  ['rules', 'Digit2'],
  ['schedule', 'Digit3'],
  ['people', 'Digit4'],
  ['audit', 'Digit5'],
  ['settings', 'Digit6'],
] as const;

/**
 * Totality over F-113's closed registry, in both directions, at compile time.
 *
 * The element type refuses a pair naming something that is not a screen;
 * the `Exclude` is empty only when every screen is named. A seventeenth
 * screen added to `SCREENS` and forgotten here fails to compile rather than
 * shipping unreachable behind a keymap nobody re-read.
 */
type TotalOverScreens = [Exclude<Screen, (typeof PAIRS)[number][0]>] extends [
  never,
]
  ? readonly (readonly [Screen, string])[]
  : never;

const DIGIT_FOR: TotalOverScreens = PAIRS;

/** The reverse, built once. */
const SCREEN_FOR: ReadonlyMap<string, Screen> = new Map(
  DIGIT_FOR.map(([screen, code]): [string, Screen] => [code, screen]),
);

// Two screens on one stroke is the one mistake the pair form allows that a
// record did not: the second would silently win the map and the first would
// become unreachable. Caught at import, loudly, rather than in a bug report
// about a screen that stopped opening.
if (SCREEN_FOR.size !== DIGIT_FOR.length)
  throw new Error('two screens claim one navigation stroke');

/** The screen this stroke asks for, or `null` when it asks for nothing. */
export function screenFor(stroke: ScreenStroke): Screen | null {
  // ⌘ alone. ⌃⌘2 and ⌥⌘2 are system and app-menu territory on macOS, and a
  // shell that claimed them would be claiming strokes whose meaning it
  // cannot see.
  if (!stroke.metaKey || stroke.ctrlKey || stroke.altKey) return null;
  return SCREEN_FOR.get(stroke.code) ?? null;
}

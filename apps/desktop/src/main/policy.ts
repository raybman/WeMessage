/**
 * The shell's policy constants (§1.7).
 *
 * Everything here is a string three parties have to agree on: the window
 * that is constructed, the protocol handler that serves the document, and
 * the e2e that reads both back. It is a separate module with NO `electron`
 * import so a spec can import it in a plain Node worker and compare against
 * a running app, rather than restating the values and hoping.
 */

/**
 * The renderer is served over a custom scheme, not `file:`.
 *
 * `file:` has no response headers, so a CSP could only be attached as a
 * `<meta>` tag — which the document itself carries, which means a document
 * that can be modified can drop its own policy. A registered scheme with a
 * handler in main puts the header on the wire, outside the renderer's reach,
 * and gives the document a real origin so `'self'` means something.
 */
export const APP_SCHEME = 'app';

/**
 * The host component. A single `-`, because `app:///index.html` (empty host)
 * and `app://index.html` (host, no path) are both easy to typo into each
 * other, and a named host makes the origin explicit in every URL the tests
 * compare.
 */
export const APP_HOST = '-';

/** The document's origin, and therefore what `'self'` resolves to. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The one document this app ever loads. */
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

/** The window title, asserted against `getTitle()` and `document.title`. */
export const WINDOW_TITLE = 'WeMessage';

/**
 * The Content-Security-Policy, served as a real header by the app scheme.
 *
 * §1.7 specifies `default-src 'self'; style-src 'self' 'unsafe-inline'` —
 * the style relaxation is not decoration, it is what lets the renderer set
 * a custom property on `document.documentElement.style` for the theme
 * switches. Two directives are added here because they do NOT fall back to
 * `default-src` and their absence is a real hole:
 *
 *  - `base-uri 'none'` — without it, injected markup can rewrite `<base>`
 *    and re-point every relative URL in the document.
 *  - `form-action 'none'` — without it, a form can post to anywhere, which
 *    is an exfiltration channel that `default-src` does not close.
 *
 * There is deliberately no `'unsafe-eval'`: the e2e proves `new Function`
 * is refused inside the document, which is the difference between a policy
 * that is present and a policy that is enforced.
 */
export const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * The environment variable that puts the app in harness mode.
 *
 * It changes exactly two things and the e2e pins both: `__wmTestState` and
 * `__wmPushTheme` exist on main's `globalThis`, and the single-instance
 * lock is skipped so concurrent launches do not fight. It grants no
 * capability: no channel appears, no guard relaxes, and the credential is
 * handled identically.
 */
export const TEST_FLAG = 'WEMESSAGE_DESKTOP_TEST';

/**
 * The closed set of System Settings panes the app may open (§1.7).
 *
 * `shell.openExternal` on an operator-supplied string is a command-execution
 * primitive on macOS, so the renderer names a KEY and main resolves the URL.
 * A renderer that has been compromised can ask for `fullDisk`; it cannot ask
 * for anything that is not on this list.
 */
export const SYSTEM_SETTINGS_PANES = {
  fullDisk:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  automation:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  accessibility:
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
} as const;

export type SystemSettingsPane = keyof typeof SYSTEM_SETTINGS_PANES;

/** Whether `value` names a pane on the allowlist. */
export function isSystemSettingsPane(
  value: string,
): value is SystemSettingsPane {
  return Object.prototype.hasOwnProperty.call(SYSTEM_SETTINGS_PANES, value);
}

/**
 * Content types for the files the app scheme serves.
 *
 * Spelled out rather than sniffed: a module script served without a
 * JavaScript MIME type is refused by Chromium, and "the app is blank and
 * the console is empty" is an expensive way to learn that.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

/** The connection states the renderer renders, and `data-conn` carries. */
export const CONN_STATES = ['connected', 'reconnecting', 'down'] as const;
export type ConnState = (typeof CONN_STATES)[number];

/** Why the app has no usable connection. Rendered as `data-reason`. */
export const DOWN_REASONS = [
  'no-token',
  'token-rejected',
  'unreachable',
  // s8 Sc5: the daemon is up, answering, and REFUSED the event subscription
  // itself. Distinct from `unreachable` because it is not a transient and
  // will not fix itself: retrying a filter the daemon rejects is a loop, and
  // the operator is the only one who can end it.
  'stream-refused',
] as const;
export type DownReason = (typeof DOWN_REASONS)[number];

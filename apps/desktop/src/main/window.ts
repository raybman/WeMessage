/**
 * The one window, and the boundary around it.
 *
 * Every hardening decision in the app is in this file, in one frozen options
 * object, constructed once. `test/arch.spec.ts` counts the construction
 * sites across the whole app and requires the single one to be spelled with
 * the frozen constant; `test/e2e/shell.e2e.spec.ts` asks the RUNNING
 * Chromium what it received. Both halves are needed. A source scan cannot
 * see a flag Electron silently ignored, and a runtime read cannot fail a
 * second window built somewhere the e2e never looks.
 *
 * That counting row is also why no comment in this file may spell the
 * constructor call: the row is a text scan, and prose about a rule is
 * indistinguishable from a breach of it.
 *
 * The renderer is served over a registered `app:` scheme rather than from
 * `file:`. That is what makes the CSP a header instead of a `<meta>` tag the
 * document could be made to drop, and it gives the document a real origin so
 * `'self'` means one specific thing.
 *
 * Colour appears nowhere here. `no-green-static.ts` rule 1 puts every colour
 * literal in `tokens.css` and nowhere else, which is why the window is
 * created hidden and shown on `ready-to-show` rather than given a background
 * colour to paint while it loads.
 */
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BrowserWindow,
  protocol,
  type BrowserWindowConstructorOptions,
} from 'electron';
import {
  APP_INDEX_URL,
  APP_SCHEME,
  CONTENT_TYPES,
  CSP,
  TEST_FLAG,
  WINDOW_TITLE,
} from './policy.js';

/** The Vite renderer bundle, beside the compiled main output. */
const RENDERER_ROOT = fileURLToPath(
  new URL('../app/renderer/', import.meta.url),
);

/**
 * The preload, as CommonJS.
 *
 * `sandbox: true` is not negotiable, and a sandboxed preload is loaded as a
 * CJS script: it has no ESM loader and no `import`. The package is
 * `"type": "module"`, so the file has to be `.cjs` and it has to be bundled
 * (a sandboxed preload also cannot `require` a relative sibling). Vite's
 * lib mode builds it with `electron` external.
 */
const PRELOAD_ENTRY = fileURLToPath(
  new URL('../app/preload/index.cjs', import.meta.url),
);

/**
 * The window, written down once and frozen.
 *
 * Frozen because these are security settings and a mutable module-scoped
 * options object is a settings table any later import can edit. Frozen also
 * means the object the e2e reads out of `__wmTestState` is provably the
 * object the constructor received, not a copy that has since drifted.
 */
export const WINDOW_OPTIONS: BrowserWindowConstructorOptions = Object.freeze({
  width: 1180,
  height: 800,
  minWidth: 960,
  minHeight: 620,
  title: WINDOW_TITLE,
  /** §2.1: the traffic lights float over the sidebar, no title bar. */
  titleBarStyle: 'hiddenInset',
  /** §2.2: the material behind `--layer-*`. Removed under reduced transparency. */
  vibrancy: 'sidebar',
  show: false,
  webPreferences: Object.freeze({
    preload: PRELOAD_ENTRY,
    /** The renderer's world and the preload's world are separate. */
    contextIsolation: true,
    /** No `require`, no `process`, no `Buffer` in the document. */
    nodeIntegration: false,
    /** The renderer runs in the OS sandbox. */
    sandbox: true,
    /** Same-origin policy stays on; the app has a real origin to enforce. */
    webSecurity: true,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    /** `<webview>` is a second, unhardened embedder. */
    webviewTag: false,
    experimentalFeatures: false,
    spellcheck: false,
  }),
});

/**
 * What `WEMESSAGE_DESKTOP_TEST` exposes: observations, never capabilities.
 *
 * Each field exists because Electron has no getter for it. There is no
 * `getVibrancy()` in this version (the plan assumed one; the probe says
 * otherwise), and a denial is by definition an event that left no trace, so
 * the alternative to recording them is asserting on a log line.
 */
export interface ShellTestState {
  windowOptions: BrowserWindowConstructorOptions;
  vibrancy: string | null;
  deniedWindowOpen: string[];
  deniedNavigate: string[];
}

const testing = process.env[TEST_FLAG] === '1';

const testState: ShellTestState | null = testing
  ? {
      windowOptions: WINDOW_OPTIONS,
      vibrancy: null,
      deniedWindowOpen: [],
      deniedNavigate: [],
    }
  : null;

if (testState !== null)
  (globalThis as unknown as { __wmTestState?: ShellTestState }).__wmTestState =
    testState;

/**
 * Declare the app scheme. MUST run before `app.whenReady()`.
 *
 * `standard` gives the scheme an origin (so `'self'`, `localStorage` and
 * relative URLs behave), `secure` puts it in a secure context, and
 * `supportFetchAPI` is what lets the renderer read its own response headers
 * — which is how the e2e proves the CSP is a header rather than a hope.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Resolve a request path inside the bundle, or `null` if it escapes it. */
function resolveAsset(pathname: string): string | null {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const abs = normalize(join(RENDERER_ROOT, rel === '' ? 'index.html' : rel));
  // Traversal is refused rather than clamped. `app://-/../../etc/passwd` is
  // not a typo to be helpful about.
  return abs.startsWith(RENDERER_ROOT) ? abs : null;
}

function headersFor(abs: string): Record<string, string> {
  return {
    'content-type': CONTENT_TYPES[extname(abs)] ?? 'application/octet-stream',
    // The policy travels with every response the scheme serves, so a
    // sub-document or a worker cannot be loaded without it either.
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
  };
}

/**
 * Serve the renderer bundle.
 *
 * Deliberately synchronous, and deliberately not Electron's own network
 * module: `arch.spec.ts` row 3 bans the raw HTTP entry point anywhere under
 * `apps/desktop/src` (as a text scan, so not in prose either), because a
 * file that can reach the network is a file that can build a second
 * transport to the daemon. Reading a bundled asset off disk needs no such
 * power.
 */
function serveApp(request: Request): Response {
  const abs = resolveAsset(new URL(request.url).pathname);
  if (abs === null)
    return new Response('forbidden', {
      status: 403,
      headers: { 'content-type': 'text/plain', 'content-security-policy': CSP },
    });
  let body: string;
  try {
    body = readFileSync(abs, 'utf8');
  } catch {
    return new Response('not found', {
      status: 404,
      headers: { 'content-type': 'text/plain', 'content-security-policy': CSP },
    });
  }
  return new Response(body, { status: 200, headers: headersFor(abs) });
}

/** Install the handler. MUST run after `app.whenReady()`. */
export function serveAppScheme(): void {
  protocol.handle(APP_SCHEME, (request) => serveApp(request));
}

/**
 * Create the one window.
 *
 * The two navigation guards are deny-by-default and they are different
 * refusals: `setWindowOpenHandler` refuses a SECOND renderer (which would
 * have its own webPreferences that no row here reads), and `will-navigate`
 * refuses this renderer being re-pointed at somebody else's document while
 * keeping the preload bridge it was given.
 */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow(WINDOW_OPTIONS);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (testState !== null) testState.deniedWindowOpen.push(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url === APP_INDEX_URL) return;
    if (testState !== null) testState.deniedNavigate.push(url);
    event.preventDefault();
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  if (testState !== null) testState.vibrancy = 'sidebar';
  void win.loadURL(APP_INDEX_URL);
  return win;
}

/**
 * Apply (or remove) the window material.
 *
 * Main owns this and the renderer owns the layer tokens, so the two have to
 * move together: opaque layers over a still-vibrant window is precisely the
 * visual defect "reduce transparency" exists to prevent. Row 4 asserts both
 * halves in one test for that reason.
 */
export function applyVibrancy(win: BrowserWindow, on: boolean): void {
  const wanted = on ? 'sidebar' : null;
  if (process.platform === 'darwin') win.setVibrancy(wanted);
  if (testState !== null) testState.vibrancy = wanted;
}

/** Push a payload to every live window. */
export function pushToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows())
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

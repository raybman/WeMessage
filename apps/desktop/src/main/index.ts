/**
 * The app's entry point, and the only place a window is born.
 *
 * Boot order is load-bearing and mostly forced by Electron:
 *
 *  1. `registerAppScheme()` BEFORE `whenReady`, because a privileged scheme
 *     must be declared before Chromium's network service starts.
 *  2. `serveAppScheme()` after ready, because a handler needs the session.
 *  3. The window, then the theme, then the tray and the chord, then the
 *     gateway. The window first so the renderer is loading while the daemon
 *     handshake is in flight, and the gateway last so nothing is pushed at a
 *     `webContents` that does not exist yet. Anything either of them pushed
 *     before the document finished loading is replayed on `did-finish-load`,
 *     so a renderer cannot boot into a state nobody told it about.
 *
 * The credential is read here, from the environment or the token file, and
 * handed to the gateway. It never reaches a window, a log line or argv;
 * `shell.e2e.spec.ts` row 5 asserts all three.
 *
 * Sc16 changed one premise of this file: the window is no longer the app.
 * Closing it leaves a tray running, and three separate things can ask for it
 * back — the tray's OPEN, the global chord, and a `wemessage://` URL. So the
 * window has a lifetime now, `showMainWindow` is the one function that owns
 * it, and everything else asks rather than constructs.
 *
 * **The two doors a deep link arrives by, and why there is only one road.**
 *
 * On macOS a `wemessage://` URL reaches a RUNNING app as `open-url`, and it
 * reaches a COLD app the same way — but possibly before `app.whenReady()`
 * has resolved, when there is no window and no gateway to show it in. On
 * Windows and Linux the same URL arrives as an argv element, either of this
 * process at startup or of a second process the shell launched, which the
 * single-instance lock hands back here as `second-instance`. Three doors,
 * three arrival times.
 *
 * All three call `handleDeepLink`, which is the only function in the app that
 * calls `parseDeepLink` (an arch row pins the namer list to exactly two
 * files). Anything arriving before boot finished is held in `coldStart` and
 * replayed through the same call, so "early" is a delay and never a second
 * grammar. The URL is untrusted input from any website the operator merely
 * visits: it is parsed into a closed union first and only then acted on, and
 * the only thing that can be done with the result is to show a window on a
 * screen.
 */
import { app, type BrowserWindow } from 'electron';
import { resolveBootstrap } from './auth.js';
import {
  DEEP_LINK_SCHEME,
  deepLinkFromArgv,
  parseDeepLink,
  type DeepLink,
} from './deep-link.js';
import { createGateway } from './gateway.js';
import { CHANNELS } from './ipc-channels.js';
import { TEST_FLAG } from './policy.js';
import { createShortcut } from './shortcut.js';
import { currentTheme, refreshTheme, startTheme } from './theme.js';
import { createTray } from './tray.js';
import { SHORTCUT_LINE } from './tray-model.js';
import { createWindow, registerAppScheme, serveAppScheme } from './window.js';

registerAppScheme();

/**
 * Claim the scheme, by the constant and never by a literal.
 *
 * Row 1 asserts that the string `'wemessage'` appears in exactly one place in
 * the app, because a scheme registered under one spelling and parsed under
 * another is a door that opens onto nothing, or worse, a door that opens onto
 * something and is never validated.
 */
app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

const bootstrap = resolveBootstrap();
const gateway = createGateway({ bootstrap });

/**
 * A second copy of a single-operator app fighting the first over one daemon
 * is not a feature. The test flag skips the lock because the e2e launches
 * several apps at once, against several daemons, on purpose; it is the only
 * behaviour the flag changes besides exposing the observation hooks.
 *
 * Sc16 gave the lock a second job. Without it, a `wemessage://` URL on a
 * platform that delivers by argv starts a SECOND app rather than reaching
 * the running one, and the operator gets two trays and two sockets. With it,
 * the second process exits and its argv arrives here as `second-instance`.
 */
const singleInstance =
  process.env[TEST_FLAG] === '1' || app.requestSingleInstanceLock();

/* ── the window's lifetime ───────────────────────────────────────────── */

let mainWindow: BrowserWindow | null = null;

/**
 * A link that arrived before there was a document to tell about it.
 *
 * Held rather than dropped, and replayed on `did-finish-load` alongside the
 * stream and the theme, which is the same replay Sc4 built for exactly this
 * reason. One slot and not a queue: two links in the time it takes a window
 * to load means the operator clicked twice, and the second one is the one
 * they meant.
 */
let pendingNavigate: DeepLink | null = null;

/** Everything the app must let go of on the way out. Set once, in `boot`. */
let teardown: (() => void) | null = null;

/**
 * Bring the one window forward, optionally on a screen or a card.
 *
 * This is the ONLY caller of `createWindow` outside `window.ts` itself, which
 * an arch row pins by name. Three spellings of "make a window" would be three
 * places for Sc4's frozen `WINDOW_OPTIONS` to be bypassed, and the whole of
 * that scenario's hardening lives in that object.
 *
 * Note what this function can and cannot do with `link`. It can select a
 * screen and it can name a card. It cannot approve, send, pause, unpause,
 * kill, write a setting or mint anything, because the value it is handed is a
 * `DeepLink` and a `DeepLink` has no verb in it — `screen`, `draftId`,
 * `notFound`, `refused`, and the union is closed. The renderer's subscriber
 * is the same shape on the other side.
 */
function showMainWindow(link?: DeepLink): void {
  if (link !== undefined) pendingNavigate = link;

  const existing = mainWindow;
  if (existing !== null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    deliverPending(existing);
    return;
  }

  const win = createWindow();
  mainWindow = win;
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(CHANNELS.stream, gateway.lastStream());
    win.webContents.send(CHANNELS.theme, currentTheme());
    deliverPending(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // A window born under "reduce transparency" would otherwise be vibrant,
  // because the material is in the frozen options and the preference is not.
  refreshTheme();
}

/**
 * Hand the held link to a document that is ready for it, once.
 *
 * Cleared on delivery so that a later reload does not re-navigate a window
 * the operator has since moved somewhere else themselves.
 */
function deliverPending(win: BrowserWindow): void {
  const link = pendingNavigate;
  if (link === null) return;
  pendingNavigate = null;
  if (!win.webContents.isDestroyed())
    win.webContents.send(CHANNELS.navigate, link);
}

/* ── the one road every URL travels ──────────────────────────────────── */

/**
 * The single validated path. Every door leads here and nowhere else.
 *
 * Before boot completes the raw string is held, NOT parsed-and-held: parsing
 * early would put the result in a variable whose meaning depends on when it
 * was written, and holding the input means the replay is byte-identical to a
 * live arrival. After boot it is parsed and shown, and that is the entire
 * repertoire.
 */
const coldStart: string[] = [];
let booted = false;

function handleDeepLink(raw: string): void {
  if (!booted) {
    coldStart.push(raw);
    return;
  }
  showMainWindow(parseDeepLink(raw));
}

app.on('open-url', (event, url) => {
  // Unhandled, macOS may try to open it some other way. Claimed here whether
  // or not it survives validation, because a URL naming this scheme is ours
  // to refuse rather than somebody else's to attempt.
  event.preventDefault();
  handleDeepLink(url);
});

app.on('second-instance', (_event, argv) => {
  const raw = deepLinkFromArgv(argv);
  // A second launch with no URL is an operator double-clicking the app while
  // it is already running. The right answer to that is the window, not a
  // second app and not nothing at all.
  if (raw === null) showMainWindow();
  else handleDeepLink(raw);
});

app.on('activate', () => {
  if (booted) showMainWindow();
});

/* ── boot ────────────────────────────────────────────────────────────── */

async function boot(): Promise<void> {
  await app.whenReady();
  serveAppScheme();
  startTheme();
  showMainWindow();

  // The chord first, because the tray's own menu quotes what the OS said
  // about it: an operator whose combination is owned by another application
  // reads that in the menu rather than discovering it by pressing.
  const shortcut = createShortcut({ showMainWindow });
  gateway.setShortcut({
    state: shortcut.state,
    line: SHORTCUT_LINE[shortcut.state],
  });

  const tray = createTray({
    invoke: (key, args) => gateway.invoke(key, args),
    checkNow: () => {
      gateway.checkNow();
    },
    showMainWindow,
    quit: () => {
      app.quit();
    },
    shortcut: shortcut.state,
  });
  gateway.watch(tray);
  teardown = (): void => {
    shortcut.dispose();
    tray.dispose();
  };

  // Argv is the cold-start door on the platforms that do not have `open-url`.
  const launched = deepLinkFromArgv(process.argv);
  if (launched !== null) coldStart.push(launched);

  booted = true;
  for (const raw of coldStart.splice(0)) handleDeepLink(raw);

  await gateway.start();
}

if (singleInstance) void boot();
else {
  /*
   * SAY SO ON THE WAY OUT. This branch is the app's one SILENT exit: it
   * writes nothing, opens nothing, and returns 0, which is indistinguishable
   * from a process that hung before `whenReady` ever resolved.
   *
   * That ambiguity cost a full CI run to diagnose and still did not resolve
   * it. `test/e2e/harness.ts` reports a failed launch as `launchApp: no
   * window` followed by everything main said, and on the run that found this
   * the transcript was EMPTY 168 times over. Empty is consistent with two
   * completely different faults: a second instance losing the lock and
   * quitting here, or the GUI session never coming up so `whenReady` never
   * settles. The first is our bug, the second is the runner's, and there was
   * no way to tell them apart from the artefact the failure left behind.
   *
   * One line on stderr is the whole fix. It is not a log level, not a
   * setting, and not conditional on the test flag: the operator who
   * double-clicks a second copy deserves the same sentence.
   */
  process.stderr.write(
    'wemessage: another instance already holds the single-instance lock; exiting\n',
  );
  app.quit();
}

/**
 * Closing the last window does not end the app any more.
 *
 * The listener cannot simply be deleted: with NO subscriber Electron applies
 * its own default, which is to quit on every platform but macOS. So it stays,
 * and it does nothing but forget the window. The way out is the tray's own
 * QUIT item, which is an explicit act by the operator rather than a side
 * effect of closing a window they only wanted out of the way.
 */
app.on('window-all-closed', () => {
  mainWindow = null;
});

app.on('before-quit', () => {
  teardown?.();
  void gateway.stop();
});

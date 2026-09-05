/**
 * The app's entry point.
 *
 * Boot order is load-bearing and mostly forced by Electron:
 *
 *  1. `registerAppScheme()` BEFORE `whenReady`, because a privileged scheme
 *     must be declared before Chromium's network service starts.
 *  2. `serveAppScheme()` after ready, because a handler needs the session.
 *  3. The window, then the theme, then the gateway. The window first so the
 *     renderer is loading while the daemon handshake is in flight, and the
 *     gateway last so nothing is pushed at a `webContents` that does not
 *     exist yet. Anything either of them pushed before the document finished
 *     loading is replayed on `did-finish-load`, so a renderer cannot boot
 *     into a state nobody told it about.
 *
 * The credential is read here, from the environment or the token file, and
 * handed to the gateway. It never reaches a window, a log line or argv;
 * `shell.e2e.spec.ts` row 5 asserts all three.
 */
import { app } from 'electron';
import { resolveBootstrap } from './auth.js';
import { createGateway } from './gateway.js';
import { CHANNELS } from './ipc-channels.js';
import { TEST_FLAG } from './policy.js';
import { currentTheme, startTheme } from './theme.js';
import { createWindow, registerAppScheme, serveAppScheme } from './window.js';

registerAppScheme();

const bootstrap = resolveBootstrap();
const gateway = createGateway({ bootstrap });

/**
 * A second copy of a single-operator app fighting the first over one daemon
 * is not a feature. The test flag skips the lock because the e2e launches
 * several apps at once, against several daemons, on purpose; it is the only
 * behaviour the flag changes besides exposing the two observation hooks.
 */
const singleInstance =
  process.env[TEST_FLAG] === '1' || app.requestSingleInstanceLock();

async function boot(): Promise<void> {
  await app.whenReady();
  serveAppScheme();

  const win = createWindow();
  win.webContents.on('did-finish-load', () => {
    win.webContents.send(CHANNELS.stream, gateway.lastStream());
    win.webContents.send(CHANNELS.theme, currentTheme());
  });

  startTheme(win);
  await gateway.start();
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  void gateway.stop();
});

if (singleInstance) void boot();
else app.quit();

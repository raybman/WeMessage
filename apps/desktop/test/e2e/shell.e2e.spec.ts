/**
 * s8 Sc 4 — the Electron shell, end to end.
 *
 * This is the first scenario in S8 that renders anything, and almost every
 * row here is a SECURITY row wearing a UI costume. The app holds a bearer
 * credential that can approve a send; it renders remote content in a
 * Chromium process; and it is the second process in the system that could,
 * if built carelessly, reach the send port. So the shell is asserted the way
 * a boundary is asserted, not the way a screen is:
 *
 *  - The bridge is CLOSED OVER `ipc-channels.ts` in both directions. The
 *    renderer's `window.wm` is exactly the request keys plus `on`, and the
 *    handler table `ipcMain` actually holds is exactly the request channel
 *    values. Either list drifting from the registry fails a row.
 *  - The token never enters the renderer. Not in the DOM, not in storage,
 *    not in a resource URL, not on a window property — and not on main's
 *    argv, which `ps` publishes to every user on the machine.
 *  - There is no send. `wm:wizard.send-test` exists, is the only channel
 *    whose name matches /send/i, and refuses outside the wizard. INV-2's
 *    single call site is `dispatchApproved`, in the daemon, and this
 *    process does not become a second one.
 *  - The hardening is read back from the RUNNING window
 *    (`getLastWebPreferences`), not scanned for in the source. A string
 *    scan proves somebody typed `sandbox: true`; this proves Chromium
 *    received it.
 *
 * F-102: a real daemon in-process, `playwright-core`'s `_electron`, and
 * `html[data-conn="connected"]` as the only wait.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHANNELS,
  PUSH_KEYS,
  REQUEST_CHANNELS,
  REQUEST_KEYS,
} from '../../src/main/ipc-channels.js';
import { APP_INDEX_URL, CSP, WINDOW_TITLE } from '../../src/main/policy.js';
import {
  bootFixtureDaemon,
  launchApp,
  waitForConn,
  waitForConnected,
  type FixtureDaemon,
  type LaunchedApp,
} from './harness.js';
import { runtimeGreenOffenders } from './no-green-runtime.js';

/** The token prefix, spelled once. Row 5 hunts for it everywhere. */
const TOKEN_PREFIX = `wm${'_'}`;

/**
 * What a channel that hands over a credential would be CALLED.
 *
 * Row 5 needs one thing it does not derive from the registry, because a
 * mistake that adds itself to the registry is invisible to everything that
 * does. Names are the surface the mistake cannot hide from: nobody adds a
 * credential accessor and calls it `drafts`.
 */
const CREDENTIAL_SHAPE = 'token|secret|credential|password|bearer';

/** What main exposes on `globalThis` under `WEMESSAGE_DESKTOP_TEST`. */
interface TestState {
  /** The very object handed to `new BrowserWindow(...)`, frozen. */
  windowOptions: Record<string, unknown>;
  /** The vibrancy main last applied; there is no getter for it in Electron. */
  vibrancy: string | null;
  deniedWindowOpen: string[];
  deniedNavigate: string[];
}

const testState = (app: LaunchedApp): Promise<TestState | null> =>
  app.app.evaluate(
    () =>
      (globalThis as unknown as { __wmTestState?: TestState }).__wmTestState ??
      null,
  );

const TOKENS_CSS = fileURLToPath(
  new URL('../../src/renderer/theme/tokens.css', import.meta.url),
);

/**
 * The custom properties `tokens.css` declares, read from the sheet itself.
 *
 * Row 3 wants "every custom property named in the §2.2 sheet resolves". The
 * list is derived from the file and then pinned to a literal: derived alone
 * would pass on an empty sheet, pinned alone would pass on a sheet that says
 * something else.
 */
function declaredTokens(): string[] {
  const text = readFileSync(TOKENS_CSS, 'utf8');
  return [
    ...new Set(
      [...text.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1] as string),
    ),
  ].sort();
}

describe('s8 Sc4: the shell, the bridge and the token', () => {
  let fixture: FixtureDaemon;
  let app: LaunchedApp;

  beforeAll(async () => {
    fixture = await bootFixtureDaemon({
      seed: (db) => {
        const handleId = db.addHandle('+15550001111');
        db.addChat({ identifier: '+15550001111', handleIds: [handleId] });
      },
    });
    app = await launchApp({ configDir: fixture.configDir, port: fixture.port });
    await waitForConnected(app.page);
    // The HOST machine's appearance must not decide what this suite sees.
    // macOS flips itself to dark in the evening, and a suite that reads the
    // dark layer tokens at 02:00 and the light ones at 09:00 is not a suite.
    // Row 4 flips these deliberately and restores them here-abouts.
    await app.page.emulateMedia({
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
    });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await fixture?.stop();
  });

  /* ── row 1: it boots, it connects, and it looks like the product ───── */

  describe('row 1: the shell reaches CONNECTED against a real daemon', () => {
    it('the window is titled, chromeless in the macOS way, and vibrant', async () => {
      const state = await testState(app);
      expect(state).not.toBeNull();
      // The options object read here is the SAME object `window.ts` passes to
      // the constructor (frozen, module-scoped, one construction site — the
      // arch row pins that). Electron exposes no getter for `titleBarStyle`
      // or `vibrancy`, so this is the closest thing to reading the window.
      expect(state?.windowOptions['titleBarStyle']).toBe('hiddenInset');
      expect(state?.windowOptions['vibrancy']).toBe('sidebar');
      expect(state?.windowOptions['title']).toBe(WINDOW_TITLE);
      const title = await app.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.getTitle(),
      );
      expect(title).toBe(WINDOW_TITLE);
      expect(await app.page.title()).toBe(WINDOW_TITLE);
    });

    it('the state strip shows CONNECTED and the daemon’s own arming text', async () => {
      // The expected text is DERIVED from the daemon rather than written
      // down: a strip that renders a plausible constant would pass a literal
      // assertion and be lying about the system it is describing.
      const status = await fixture.client.status();
      const strip = await app.page.textContent('#state-strip');
      expect(strip).toContain('● CONNECTED');
      expect(await app.page.textContent('#state-strip-arming')).toContain(
        status.armed === null
          ? 'NO SCHEDULE'
          : status.armed.reason.toUpperCase(),
      );
    });

    it('exactly one window exists, and it is the one that loaded', async () => {
      const windows = await app.app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      );
      expect(windows).toBe(1);
      expect(app.page.url()).toBe(APP_INDEX_URL);
    });
  });

  /* ── row 2: the bridge is closed, and the process is hardened ──────── */

  describe('row 2: the bridge is closed over the channel registry', () => {
    it('window.wm is exactly the request keys plus on', async () => {
      const keys = await app.page.evaluate(() =>
        Object.keys(
          (window as unknown as { wm: Record<string, unknown> }).wm,
        ).sort(),
      );
      expect(keys).toEqual([...REQUEST_KEYS, 'on'].sort());
      // Named absences: the generic escape hatches. A bridge that exposed
      // `invoke` would be closed over nothing at all.
      for (const escape of ['invoke', 'send', 'postMessage', 'ipcRenderer'])
        expect(keys).not.toContain(escape);
    });

    it('every registered handler is a registry channel, and every registry channel is registered', async () => {
      // The other direction, asked of `ipcMain` itself. `eventNames()` does
      // NOT report `handle`-registered channels (they live in a separate
      // invoke-handler map), so this reads that map.
      const registered = await app.app.evaluate(({ ipcMain }) => {
        const map = (
          ipcMain as unknown as { _invokeHandlers: Map<string, unknown> }
        )._invokeHandlers;
        return [...map.keys()].filter((k) => k.startsWith('wm'));
      });
      expect(registered.sort()).toEqual([...REQUEST_CHANNELS].sort());
    });

    it('an unknown channel has nowhere to be called from', async () => {
      const outcome = await app.page.evaluate(async () => {
        const wm = window as unknown as {
          wm: Record<string, unknown> & {
            on: (k: string, cb: () => void) => void;
          };
        };
        const results: string[] = [];
        results.push(typeof wm.wm['wm:dispatch']);
        try {
          wm.wm.on('not-a-push-channel', () => {});
          results.push('on-accepted');
        } catch (e) {
          results.push(`on-refused:${(e as Error).message}`);
        }
        return results;
      });
      expect(outcome[0]).toBe('undefined');
      expect(outcome[1]).toBe('on-refused:unknown-channel');
    });

    it('the renderer has no Node, no Electron and no preload globals', async () => {
      const probe = await app.page.evaluate(() => ({
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        electron: typeof (window as unknown as { electron?: unknown }).electron,
        module: typeof (window as unknown as { module?: unknown }).module,
        // Set by the preload in its OWN world. Visible here would mean
        // contextIsolation is off in fact whatever the flag says.
        preloadWorld: typeof (
          window as unknown as { __wmPreloadWorld?: unknown }
        ).__wmPreloadWorld,
      }));
      expect(probe).toEqual({
        require: 'undefined',
        process: 'undefined',
        electron: 'undefined',
        module: 'undefined',
        preloadWorld: 'undefined',
      });
    });

    it('Chromium received the hardening, not just the source', async () => {
      const prefs = await app.app.evaluate(({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows()[0]?.webContents as unknown as {
          getLastWebPreferences(): Record<string, unknown> | null;
        };
        return wc.getLastWebPreferences();
      });
      expect(prefs?.['contextIsolation']).toBe(true);
      expect(prefs?.['nodeIntegration']).toBe(false);
      expect(prefs?.['sandbox']).toBe(true);
      expect(prefs?.['webSecurity']).toBe(true);
      expect(prefs?.['nodeIntegrationInWorker']).toBe(false);
      expect(prefs?.['nodeIntegrationInSubFrames']).toBe(false);
      expect(prefs?.['webviewTag']).toBe(false);
      expect(prefs?.['experimentalFeatures']).toBe(false);
    });

    it('the document was served with the CSP, and the CSP is enforced', async () => {
      const header = await app.page.evaluate(async () => {
        const res = await fetch(window.location.href);
        return res.headers.get('content-security-policy');
      });
      expect(header).toBe(CSP);
      // Enforced, not merely present — and enforced against the DOCUMENT,
      // which is the only party that matters. The document is made to load a
      // cross-origin image and the policy's own violation event is the
      // witness. No network happens: CSP refuses before the request, which
      // is why an offline CI machine sees the same result.
      //
      // `new Function` was tried first and is NOT a valid probe here. Code
      // entered through the debugger protocol is deliberately exempt from
      // CSP in Chromium, so `page.evaluate` compiling a string proves
      // nothing about the page. Resource loads have no such exemption.
      const violation = await app.page.evaluate(
        () =>
          new Promise<{ directive: string; blocked: string }>((resolve) => {
            document.addEventListener(
              'securitypolicyviolation',
              (event) => {
                resolve({
                  directive: event.violatedDirective,
                  blocked: event.blockedURI,
                });
              },
              { once: true },
            );
            const img = document.createElement('img');
            img.id = 'csp-probe';
            img.src = 'https://example.com/blocked.png';
            document.body.append(img);
          }),
      );
      // Chromium reports the EFFECTIVE directive; `default-src` is the one
      // written down and `img-src` is what it falls back to.
      expect(['img-src', 'default-src']).toContain(violation.directive);
      expect(violation.blocked).toContain('example.com');
      await app.page.evaluate(() => {
        document.getElementById('csp-probe')?.remove();
      });
    });

    it('a new window is denied and a navigation away is refused', async () => {
      await app.page.evaluate(() => {
        window.open('https://example.com/');
      });
      await app.page.evaluate(() => {
        window.location.href = 'https://example.com/';
      });
      await expect
        .poll(
          async () => {
            const state = await testState(app);
            return {
              open: state?.deniedWindowOpen.length ?? 0,
              nav: state?.deniedNavigate.length ?? 0,
            };
          },
          { timeout: 15_000 },
        )
        .toEqual({ open: 1, nav: 1 });
      // And the refusal held: still one window, still the app document.
      expect(
        await app.app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      ).toBe(1);
      expect(app.page.url()).toBe(APP_INDEX_URL);
    });
  });

  /* ── row 3: the token sheet resolves, and none of it is green ──────── */

  describe('row 3: the design tokens', () => {
    it('the sheet declares exactly the closed §2.2 list', () => {
      expect(declaredTokens()).toEqual([
        '--backdrop',
        '--danger',
        '--dur-base',
        '--dur-fast',
        '--ink',
        '--ink-dim',
        '--layer-0',
        '--layer-1',
        '--layer-2',
        '--stroke',
        '--stroke-strong',
        '--tint',
        '--tint-2',
        '--tint-light',
        '--tint-pressed',
        '--tint-soft',
        '--warn',
      ]);
    });

    it('the tint is the product blue and every declared token resolves', async () => {
      const resolved = await app.page.evaluate((names: string[]) => {
        const style = window.getComputedStyle(document.documentElement);
        const out: Record<string, string> = {};
        for (const name of names)
          out[name] = style.getPropertyValue(name).trim();
        return out;
      }, declaredTokens());
      expect((resolved['--tint'] ?? '').toLowerCase()).toBe(
        `#0A84FF`.toLowerCase(),
      );
      expect(
        Object.entries(resolved)
          .filter(([, v]) => v === '')
          .map(([k]) => k),
      ).toEqual([]);
    });

    it('the runtime no-green sweep passes on the empty shell', async () => {
      // Non-vacuity first: a sweep that found no elements would pass for the
      // wrong reason, and this shell has a handful.
      expect(
        (await app.page.evaluate(() => document.querySelectorAll('*').length)) >
          3,
      ).toBe(true);
      expect(await runtimeGreenOffenders(app.page)).toEqual([]);
    });
  });

  /* ── row 4: the three switches ─────────────────────────────────────── */

  describe('row 4: colour scheme, reduced motion, reduced transparency', () => {
    /**
     * Waits for main's theme push to reach the document.
     *
     * `page.waitForSelector` would be the obvious call and it HANGS here:
     * the refused-navigation row above leaves Chromium with a navigation
     * that was cancelled in `will-navigate` and therefore never commits and
     * never fails, and Playwright's selector wait is navigation-aware
     * ("waiting for navigation to finish"). `page.evaluate` is not, so the
     * attribute is polled directly. The dependency between the two rows is
     * real and this is the cheaper end to fix: the alternative is ordering
     * the file so nothing follows the navigation row, which is a constraint
     * no future reader would know they were under.
     */
    const waitForTransparency = (want: 'on' | 'off'): Promise<void> =>
      expect
        .poll(
          () =>
            app.page.evaluate(() =>
              document.documentElement.getAttribute(
                'data-reduced-transparency',
              ),
            ),
          { timeout: 15_000 },
        )
        .toBe(want);

    const readToken = (name: string): Promise<string> =>
      app.page.evaluate(
        (n: string) =>
          window
            .getComputedStyle(document.documentElement)
            .getPropertyValue(n)
            .trim(),
        name,
      );

    afterAll(async () => {
      await app.page.emulateMedia({
        colorScheme: 'dark',
        reducedMotion: 'no-preference',
      });
      await pushTheme(app, { reducedTransparency: false });
    });

    it('prefers-color-scheme flips the layer tokens', async () => {
      // Compared as NUMBERS, not as text. A custom property's value survives
      // the cascade verbatim, and "verbatim" includes whatever the CSS
      // minifier decided: `0.72` ships as `.72` and `220ms` as `.22s`. The
      // sheet's meaning is the assertion; its spelling after minification is
      // the build tool's business.
      expect(rgbaOf(await readToken('--layer-1'))).toEqual([44, 44, 46, 0.72]);
      await app.page.emulateMedia({ colorScheme: 'light' });
      expect(rgbaOf(await readToken('--layer-1'))).toEqual([
        255, 255, 255, 0.78,
      ]);
      await app.page.emulateMedia({ colorScheme: 'dark' });
      expect(rgbaOf(await readToken('--layer-1'))).toEqual([44, 44, 46, 0.72]);
    });

    it('prefers-reduced-motion zeroes the durations', async () => {
      expect(msOf(await readToken('--dur-base'))).toBe(220);
      await app.page.emulateMedia({ reducedMotion: 'reduce' });
      expect(msOf(await readToken('--dur-base'))).toBe(0);
      expect(msOf(await readToken('--dur-fast'))).toBe(0);
      await app.page.emulateMedia({ reducedMotion: 'no-preference' });
      expect(msOf(await readToken('--dur-base'))).toBe(220);
    });

    it('reduced transparency makes every layer opaque, drops the backdrop, and removes the vibrancy', async () => {
      // The three have to move TOGETHER: opaque layers on a still-vibrant
      // window is the exact visual bug the setting exists to prevent, and
      // main owns the vibrancy while the renderer owns the layers.
      await pushTheme(app, { reducedTransparency: true });
      await waitForTransparency('on');
      for (const layer of ['--layer-0', '--layer-1', '--layer-2'])
        expect(alphaOf(await readToken(layer)), layer).toBe(1);
      expect(await readToken('--backdrop')).toBe('none');
      expect(
        await app.page.evaluate(
          () =>
            window.getComputedStyle(document.getElementById('app') as Element)
              .backdropFilter,
        ),
      ).toBe('none');
      // POLLED, not read once. `#app` transitions its background over
      // `--dur-base`, so a single read lands somewhere on the interpolation
      // — the first run of this row read the pre-transition alpha exactly.
      // The product behaviour under test is where the paint ENDS UP.
      await expect
        .poll(
          async () =>
            alphaOf(
              await app.page.evaluate(
                () =>
                  window.getComputedStyle(
                    document.getElementById('app') as Element,
                  ).backgroundColor,
              ),
            ),
          { timeout: 5_000 },
        )
        .toBe(1);
      expect((await testState(app))?.vibrancy).toBeNull();

      await pushTheme(app, { reducedTransparency: false });
      await waitForTransparency('off');
      await expect
        .poll(
          async () =>
            alphaOf(
              await app.page.evaluate(
                () =>
                  window.getComputedStyle(
                    document.getElementById('app') as Element,
                  ).backgroundColor,
              ),
            ),
          { timeout: 5_000 },
        )
        .toBeLessThan(1);
      expect(alphaOf(await readToken('--layer-1'))).toBeLessThan(1);
      expect(await readToken('--backdrop')).not.toBe('none');
      expect((await testState(app))?.vibrancy).toBe('sidebar');
    });
  });

  /* ── row 5: the token is nowhere a renderer or a log can reach ─────── */

  describe('row 5: the operator token never leaves main', () => {
    it('nothing in the renderer carries the token prefix', async () => {
      // The daemon's REAL token is live in this process. If any of these
      // surfaces carried it, an XSS in a rendered draft body would be an
      // approve-anything credential.
      const hits = await app.page.evaluate((prefix: string) => {
        const found: string[] = [];
        if (document.documentElement.outerHTML.includes(prefix))
          found.push('dom');
        for (const store of ['localStorage', 'sessionStorage']) {
          const s = (window as unknown as Record<string, Storage>)[
            store
          ] as Storage;
          for (let i = 0; i < s.length; i += 1) {
            const key = s.key(i);
            if (key === null) continue;
            if (key.includes(prefix) || (s.getItem(key) ?? '').includes(prefix))
              found.push(store);
          }
        }
        for (const entry of performance.getEntries())
          if (entry.name.includes(prefix)) found.push(`perf:${entry.name}`);
        for (const key of Object.keys(window)) {
          const value = (window as unknown as Record<string, unknown>)[key];
          if (typeof value === 'string' && value.includes(prefix))
            found.push(`window.${key}`);
        }
        return found;
      }, TOKEN_PREFIX);
      expect(hits).toEqual([]);
      expect(fixture.token.startsWith(TOKEN_PREFIX)).toBe(true);
    });

    it('the bridge itself hands back no credential', async () => {
      const values = await app.page.evaluate((prefix: string) => {
        const wm = (window as unknown as { wm: Record<string, unknown> }).wm;
        return Object.entries(wm)
          .filter(
            ([, v]) => typeof v === 'string' && (v as string).includes(prefix),
          )
          .map(([k]) => k);
      }, TOKEN_PREFIX);
      expect(values).toEqual([]);

      // And any member that ASKS for one is called and read.
      //
      // The teeth for this row are "expose the token over the bridge for
      // debugging", and the thorough form of that mistake wires the channel
      // through `ipc-channels.ts` properly — at which point every row that
      // derives its expectation FROM the registry passes, because the
      // registry now says the channel is legitimate. So this half does not
      // derive: it names the shapes a credential accessor comes in, calls
      // whatever it finds, and reads the answer.
      const leaked = await app.page.evaluate(
        async ([prefix, shape]: [string, string]) => {
          const wm = (window as unknown as { wm: Record<string, unknown> }).wm;
          const re = new RegExp(shape, 'i');
          const found: string[] = [];
          for (const [key, value] of Object.entries(wm)) {
            if (!re.test(key) || typeof value !== 'function') continue;
            try {
              const answer: unknown = await (value as () => unknown)();
              if (JSON.stringify(answer ?? null)?.includes(prefix) === true)
                found.push(key);
            } catch {
              /* a refusal is the correct answer; only a value is a leak. */
            }
          }
          return found;
        },
        [TOKEN_PREFIX, CREDENTIAL_SHAPE] as [string, string],
      );
      expect(leaked).toEqual([]);
    });

    it('the registry offers no way to ASK for the credential', () => {
      // The bridge is closed over the registry, so "can the renderer obtain
      // the token" reduces to "does the registry name a channel that hands
      // one over". This is the same move row 6 makes for the send port.
      const re = new RegExp(CREDENTIAL_SHAPE, 'i');
      expect(
        Object.entries(CHANNELS)
          .filter(([key, value]) => re.test(key) || re.test(value))
          .map(([key]) => key),
      ).toEqual([]);
    });

    it('main never printed it and never put it on argv', async () => {
      expect(app.transcript()).not.toContain(TOKEN_PREFIX);
      const argv = await app.app.evaluate(() => process.argv);
      expect(argv.filter((a) => a.includes(TOKEN_PREFIX))).toEqual([]);
      // `ps` publishes argv to every user on the machine; the environment is
      // the only carrier the daemon's own bootstrap accepts, and this app
      // uses the same one.
      expect(argv.join(' ')).not.toContain(fixture.token);
    });
  });

  /* ── row 6: there is no send ───────────────────────────────────────── */

  describe('row 6: INV-2 holds at the GUI boundary', () => {
    it('the registry names exactly one sendable channel, and it is the wizard test', () => {
      expect(Object.values(CHANNELS).filter((v) => /send/i.test(v))).toEqual([
        'wm:wizard.send-test',
      ]);
      expect(REQUEST_CHANNELS).toContain(CHANNELS.sendTest);
      expect([...PUSH_KEYS]).toEqual(['event', 'stream', 'theme', 'navigate']);
    });

    it('sendTest refuses outside the wizard', async () => {
      const refusal = await app.page.evaluate(async () => {
        const wm = (
          window as unknown as {
            wm: { sendTest: (to: string, body: string) => Promise<unknown> };
          }
        ).wm;
        try {
          await wm.sendTest('+15550001111', 'ABCD');
          return 'accepted';
        } catch (e) {
          return (e as Error).message;
        }
      });
      expect(refusal).toContain('wizard-only');
      // …and it really did not send: the loopback backend never saw a call.
      expect(await fixture.client.listDrafts()).toEqual([]);
    });
  });
});

/* ── row 7: auth bootstrap ───────────────────────────────────────────── */

describe('s8 Sc4 row 7: auth bootstrap', () => {
  it('an empty config dir shows the wizard welcome card and touches no daemon', async () => {
    const fixture = await bootFixtureDaemon();
    // A directory the daemon never wrote to: the app must not invent a
    // token, and must not go asking without one.
    const emptyDir = join(fixture.configDir, '..', 'empty');
    const app = await launchApp({ configDir: emptyDir, port: fixture.port });
    try {
      await waitForConn(app.page, 'down');
      await app.page.waitForSelector('#daemon-not-found', { timeout: 15_000 });
      expect(await app.page.getAttribute('html', 'data-screen')).toBe('wizard');
      expect(await app.page.getAttribute('html', 'data-wizard-step')).toBe(
        'welcome',
      );
      const card = (await app.page.textContent('#daemon-not-found')) ?? '';
      expect(card).toContain('wemessaged');
      expect(card).toContain(join(emptyDir, 'daemon.token'));
      expect(
        await app.page.getAttribute('#daemon-not-found', 'data-reason'),
      ).toBe('no-token');
      // The load-bearing half: no token means no request, not a request that
      // fails. An app that probes anyway teaches operators to ignore 401s.
      expect(fixture.requests.requests()).toEqual([]);
    } finally {
      await app.close();
      await fixture.stop();
    }
  }, 90_000);

  it('a rejected token shows the same card once, and does not retry in a loop', async () => {
    const fixture = await bootFixtureDaemon();
    const app = await launchApp({
      configDir: fixture.configDir,
      port: fixture.port,
      env: { WEMESSAGE_TOKEN: `${TOKEN_PREFIX}wrong` },
    });
    try {
      await waitForConn(app.page, 'down');
      await app.page.waitForSelector('#daemon-not-found', { timeout: 15_000 });
      const card = (await app.page.textContent('#daemon-not-found')) ?? '';
      expect(card).toContain('wemessaged');
      expect(card).toContain(join(fixture.configDir, 'daemon.token'));
      expect(
        await app.page.getAttribute('#daemon-not-found', 'data-reason'),
      ).toBe('token-rejected');
      expect(fixture.requests.requests()).toEqual([
        { method: 'GET', url: '/v1/events' },
      ]);
      expect(fixture.requests.statuses()).toEqual([401]);
      // The card must not echo the credential it was handed, wrong or not.
      expect(card).not.toContain(TOKEN_PREFIX);
    } finally {
      await app.close();
      await fixture.stop();
    }
  }, 90_000);
});

/* ── the test flag changes exactly what it says it changes ───────────── */

describe('s8 Sc4: WEMESSAGE_DESKTOP_TEST', () => {
  it('without the flag there is no test hook and no test state', async () => {
    const fixture = await bootFixtureDaemon();
    const app = await launchApp({
      configDir: fixture.configDir,
      port: fixture.port,
      withoutTestFlag: true,
    });
    try {
      await waitForConnected(app.page);
      const exposed = await app.app.evaluate(() => ({
        push: typeof (globalThis as unknown as Record<string, unknown>)
          .__wmPushTheme,
        state: typeof (globalThis as unknown as Record<string, unknown>)
          .__wmTestState,
      }));
      expect(exposed).toEqual({ push: 'undefined', state: 'undefined' });
    } finally {
      await app.close();
      await fixture.stop();
    }
  }, 90_000);
});

/** The four components of an `rgb()`/`rgba()` value, alpha defaulting to 1. */
function rgbaOf(value: string): number[] {
  const m = /rgba?\(([^)]*)\)/.exec(value);
  if (m === null) return [];
  const parts = (m[1] as string).split(/[,/]/).map((p) => Number(p.trim()));
  return parts.length === 3 ? [...parts, 1] : parts;
}

/** A CSS duration in milliseconds, whichever unit it was minified into. */
function msOf(value: string): number {
  const v = value.trim();
  if (v.endsWith('ms')) return Number(v.slice(0, -2));
  if (v.endsWith('s')) return Number(v.slice(0, -1)) * 1000;
  return Number.NaN;
}

/** Alpha of a computed colour string; 1 for every opaque form. */
function alphaOf(value: string): number {
  const rgba = /rgba?\(([^)]*)\)/.exec(value);
  if (rgba !== null) {
    const parts = (rgba[1] as string).split(/[,/]/).map((p) => p.trim());
    return parts.length < 4 ? 1 : Number(parts[3]);
  }
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value.trim());
  if (hex !== null) {
    const digits = hex[1] as string;
    if (digits.length === 4) return parseInt(digits[3] as string, 16) / 15;
    if (digits.length === 8) return parseInt(digits.slice(6), 16) / 255;
  }
  return 1;
}

/** Push a theme patch from MAIN, the way `nativeTheme` would. */
async function pushTheme(
  app: LaunchedApp,
  patch: { dark?: boolean; reducedTransparency?: boolean },
): Promise<void> {
  await app.app.evaluate(
    (_electron, arg) => {
      const push = (
        globalThis as unknown as {
          __wmPushTheme?: (p: Record<string, boolean>) => void;
        }
      ).__wmPushTheme;
      if (push === undefined) throw new Error('__wmPushTheme is not exposed');
      push(arg);
    },
    patch as Record<string, boolean>,
  );
}

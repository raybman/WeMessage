/**
 * s8 Sc 4 — the desktop e2e harness (F-102).
 *
 * Three things, and deliberately nothing else:
 *
 *  - `bootFixtureDaemon()` — a REAL daemon in the vitest worker, on an
 *    ephemeral port, over a fixture chat.db, with the loopback send backend,
 *    scriptable doctor probes and a hand-driven clock. A fake daemon here
 *    would be our TypeScript agreeing with our TypeScript (S7 §0.1), and the
 *    production daemon binary is hard-wired to AppleScript and cannot run in
 *    CI. This is the S6 e2e pattern with a different client on the far side.
 *  - `launchApp()` — the built Electron app under `playwright-core`'s
 *    `_electron`, never `@playwright/test` (C-4: one runner).
 *  - `waitForConnected()` — the ONLY wait primitive in the desktop suite.
 *    It waits on `html[data-conn="connected"]`, which is the same attribute
 *    the operator's state strip reads, so a wait that passes and a UI that
 *    lies cannot coexist. `test/arch.spec.ts` row 14 forbids the alternative
 *    by banning both timer calls under this whole tree — as a text scan, so
 *    this comment may not spell them either.
 *
 * The daemon is reached through `startRequestLog`, a TCP tee, so that "no
 * request was made" and "exactly one 401" are observations rather than
 * assumptions. See `request-log.ts`.
 *
 * Paths are resolved from `import.meta.url`. A repo that is public may not
 * carry an absolute home path in a tracked file (arch row 13), and a harness
 * that only runs from one checkout is not a harness.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright-core';
import type { Clock, FsWatcher } from '../../../../packages/core/dist/index.js';
import {
  createAuditSink,
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '../../../../packages/daemon/dist/index.js';
import {
  createClient,
  type WeMessageClient,
} from '../../../../packages/client/dist/index.js';
import {
  createChatDb,
  type ChatDbFixture,
} from '../../../../fixtures/dist/index.js';
import {
  createLoopbackSendBackend,
  type LoopbackSendBackend,
} from '../../../../packages/daemon/test/helpers/loopback-backend.js';
import { startRequestLog, type RequestLog } from './request-log.js';

/** The compiled main entry `_electron.launch` is pointed at. */
export const MAIN_ENTRY = fileURLToPath(
  new URL('../../dist/main/index.js', import.meta.url),
);
/**
 * `playwright-core` and `electron` are CommonJS, and both are asked for by
 * `createRequire` rather than imported.
 *
 * That is not a style choice. `playwright-core` publishes ESM-shaped types
 * over a CJS implementation, so a named ESM import typechecks and then fails
 * at run time under Node's CJS named-export detection; and `electron`'s
 * runtime export is the path to the binary while its types are the Electron
 * API surface, so there is no import form that yields both. `require` is the
 * shape both packages actually are, and `typeof import(...)` still types it.
 */
const need = createRequire(import.meta.url);
const { _electron } = need(
  'playwright-core',
) as typeof import('playwright-core');

/** A clock the test moves, never the wall (C-11: no test races real time). */
export interface TestClock extends Clock {
  set(iso: string): void;
}

export function createTestClock(at = '2026-03-02T18:00:00.000Z'): TestClock {
  let ms = Date.parse(at);
  return {
    now: () => new Date(ms).toISOString(),
    nowMs: () => ms,
    set: (iso: string) => {
      ms = Date.parse(iso);
    },
  };
}

function fakeWatcher(): FsWatcher {
  return {
    watch() {
      return () => {};
    },
  };
}

const DEFAULT_PROBES: DoctorProbes = {
  osMajor: () => 15,
  fda: () => Promise.resolve('ok'),
  automation: () => Promise.resolve('ok'),
  messagesRunning: () => Promise.resolve(true),
};

export interface BootOptions {
  /** Seed the fixture chat.db before the daemon boots. */
  seed?: (fixture: ChatDbFixture) => void;
  clockAt?: string;
  probes?: Partial<DoctorProbes>;
}

/**
 * One §1.8 observation: a frame leaving the daemon, and the log AS IT STOOD
 * at the instant it left.
 *
 * §1.8 is "the log is the record, the event is the courtesy": every emit
 * site appends its audit row through `sink.append` BEFORE it hands a frame
 * to `sink.broadcast`. The finished log is IDENTICAL whichever order the two
 * lines run in, so no assertion made after the fact can tell them apart.
 * The only witness is the log read from inside `broadcast`, which is what
 * this record is.
 *
 * `auditAtBroadcast` holds the `type` of the newest few audit rows, newest
 * first, rather than the whole log: the question is only ever "was THIS
 * act's row already written", and a 5 000-row fixture would otherwise pay
 * for a full table scan per frame.
 */
export interface BroadcastWitness {
  /** The `event` name on the frame — the §3.4 wire vocabulary. */
  readonly event: string;
  /** `AuditEvent.type` for the newest rows, newest first, at that instant. */
  readonly auditAtBroadcast: readonly string[];
}

/** How deep into the log each witness looks. Five acts of slack, not one. */
const WITNESS_DEPTH = 5;

export interface FixtureDaemon {
  daemon: RunningDaemon;
  /** A client aimed at the SAME port the app is given, tee included. */
  client: WeMessageClient;
  /**
   * A client aimed at the daemon DIRECTLY, bypassing the tee.
   *
   * The other terminal: an operator (or an agent) acting on the same daemon
   * while the app is watching. Its requests never appear in the tee's log,
   * so a row can assert what the APP asked for without its own setup
   * showing up in the answer — and it keeps working while the tee is
   * severed, which is what makes an outage observable rather than merely
   * simulated.
   */
  directClient: WeMessageClient;
  configDir: string;
  /** The port the app is pointed at: the tee, not the daemon. */
  port: number;
  /** The daemon's own token. Never leaves the test process. */
  token: string;
  clock: TestClock;
  probes: DoctorProbes;
  fixture: ChatDbFixture;
  requests: RequestLog;
  /**
   * The send PORT, exposed so a row can count what crossed it.
   *
   * s8 Sc8 needs this and no earlier scenario did, because this is the first
   * scenario whose claim is about SPEED: the pressure that produces an
   * optimistic local send, or a batch around the approval record, is the
   * pressure to make approving fast. Counting approve POSTs proves the GUI
   * asked correctly; counting `send()` proves nothing answered it early.
   *
   * It is also what makes the INV-2 rows non-vacuous. A backend that is
   * never called is indistinguishable from a backend that is not wired, so
   * the checkpoint asserts zero DURING triage and then ticks the daemon and
   * asserts one call per approval, with the approved body — the sanctioned
   * path working is what gives the zero its meaning.
   */
  loopback: LoopbackSendBackend;
  /**
   * Every frame this daemon has broadcast, with the log as it stood then.
   *
   * s8 Sc13. The audit screen is the first surface where §1.8's ordering is
   * VISIBLE — an act, its row on disk, and only then its frame on the wire —
   * so it is the honest place to prove the ordering end to end rather than
   * inside the daemon's own unit suite. The sink is spread-wrapped, which is
   * exactly the shape `audit-sink.ts` documents as supported ("nothing here
   * uses `this`"), so this observes production behaviour instead of
   * substituting for it.
   *
   * NOT every broadcast has an audit row: `connection.state` and
   * `adapter.health` are derived facts about the host, not decisions, and
   * §1.8 is a claim about the ORDER of the two when there are two — never
   * that the two sets are equal. Rows assert against the acts they exercise.
   */
  broadcasts: readonly BroadcastWitness[];
  stop(): Promise<void>;
}

export async function bootFixtureDaemon(
  options: BootOptions = {},
): Promise<FixtureDaemon> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-desktop-e2e-'));
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  options.seed?.(fixture);
  const configDir = join(dir, 'config');
  const clock = createTestClock(options.clockAt);
  const probes: DoctorProbes = { ...DEFAULT_PROBES, ...options.probes };
  const loopback = createLoopbackSendBackend(fixture, clock);
  /**
   * The verify poll's wait, which ADVANCES the fixture clock instead of the
   * wall (s8 Sc9; the same closure `packages/daemon/test/helpers/draft-
   * harness.ts` has had since s4).
   *
   * `dispatchApproved` verifies a send by re-reading the fixture chat.db
   * until the outbound row appears or `VERIFY_BUDGET_MS` of CLOCK time has
   * elapsed. This suite's clock is FROZEN (C-11), so with the real timer the
   * budget can never be spent: a send that is accepted and never lands —
   * which is exactly what `loopback.sabotageBody` simulates and what Sc9's
   * partial-failure row is about — would poll for ever and the tick would
   * never return. Advancing the clock through the wait is what makes the
   * failure terminate, and it costs the happy path nothing: a verified send
   * finds its row on the FIRST poll, before any wait, so no row that does
   * not deliberately fail moves this clock by a millisecond.
   */
  const delay = (ms: number): Promise<void> => {
    clock.set(new Date(clock.nowMs() + ms).toISOString());
    return Promise.resolve();
  };
  const broadcasts: BroadcastWitness[] = [];
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    delay,
    watcher: fakeWatcher(),
    doctorProbes: probes,
    backend: loopback,
    backendName: 'loopback',
    // §1.8's declared test seam, used for what it was declared for. The
    // wrapper reads the log INSIDE `broadcast`, before the real one runs,
    // which is the only vantage point from which "the append already
    // happened" is an observation rather than an assumption.
    createAuditSink: (deps) => {
      const sink = createAuditSink(deps);
      return {
        ...sink,
        broadcast(payload) {
          broadcasts.push({
            event: payload.event,
            auditAtBroadcast: deps.store
              .listAudit({ limit: WITNESS_DEPTH })
              .map((row) => {
                try {
                  const parsed: unknown = JSON.parse(row.eventJson);
                  const type =
                    typeof parsed === 'object' && parsed !== null
                      ? (parsed as { type?: unknown }).type
                      : undefined;
                  return typeof type === 'string' ? type : '?';
                } catch {
                  return '?';
                }
              }),
          });
          sink.broadcast(payload);
        },
      };
    },
  });
  const token = daemon.server.token;
  if (token === null)
    throw new Error('the fixture daemon minted no token; it would 503');
  const requests = await startRequestLog(daemon.port);
  const client = createClient({
    baseUrl: `http://127.0.0.1:${String(requests.port)}`,
    token,
  });
  const directClient = createClient({
    baseUrl: `http://127.0.0.1:${String(daemon.port)}`,
    token,
  });
  return {
    daemon,
    client,
    directClient,
    configDir,
    port: requests.port,
    token,
    clock,
    probes,
    fixture,
    requests,
    loopback,
    broadcasts,
    stop: async () => {
      await requests.close();
      await daemon.stop();
      fixture.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface LaunchOptions {
  /** `WEMESSAGE_DIR`. The app reads its token file from here. */
  configDir: string;
  /** `WEMESSAGE_PORT`. */
  port: number;
  /** Extra environment. `WEMESSAGE_TOKEN` goes here, never on argv. */
  env?: Record<string, string>;
  /** Omit the test flag, to prove what it does and does not change. */
  withoutTestFlag?: boolean;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  /** Everything main wrote to stdout and stderr, so far. */
  transcript(): string;
  close(): Promise<void>;
}

export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  const chunks: string[] = [];
  const env: Record<string, string> = {
    ...definedEnv(),
    WEMESSAGE_DIR: options.configDir,
    WEMESSAGE_PORT: String(options.port),
    ELECTRON_ENABLE_LOGGING: '1',
    ...(options.withoutTestFlag ? {} : { WEMESSAGE_DESKTOP_TEST: '1' }),
    ...options.env,
  };
  // The token, when a test supplies one, travels in `env` and never in
  // `args` — argv is world-readable through `ps`, which is the whole reason
  // the daemon's own bootstrap refuses a `--token` flag.
  const app = await _electron.launch({
    executablePath: need('electron') as string,
    // `--force-color-profile=srgb` pins what the COMPOSITOR hands back to a
    // screenshot. Sc 17's pixel rows compare a screenshot against a colour
    // read out of the CSSOM, and those two travel different paths: the CSSOM
    // returns the authored sRGB triple, while a captured frame is colour
    // MANAGED and converted into whatever profile the attached display is
    // running. On a machine whose profile is not sRGB the same opaque
    // `--layer-0` surface comes back as #1a1a1c instead of #1c1c1e, and the
    // row fails hours after it passed with nothing in the tree having
    // changed. Found exactly that way at the s8 close: green in the morning,
    // red in the afternoon, identical bytes, and the flag makes it green
    // again on both. This narrows the test's environment rather than
    // widening its tolerance — no threshold moves, and a real colour
    // regression still fails.
    //
    // `--force-device-scale-factor=1` is the same shape of fix for the same
    // shape of bug, found at the s9 close by Sc 13's row 7, which encodes the
    // launch GIF twice and requires the two passes to be equal byte for byte.
    // They were not: one run differed from the next by a single 671-px
    // horizontal line, always at the bottom edge of a card, at y=651 in one
    // pass and y=652 in the other.
    //
    // Layout was not the cause and was measured, not assumed: a temporary
    // `getBoundingClientRect` probe taken before and after a capture agreed
    // to four decimals, so the DOM was identical across the passes. What it
    // also reported was the reason. The display runs at `dpr` 2 and the cards
    // are 78.7344 CSS px tall, so every card edge falls in the MIDDLE of a
    // device pixel; Playwright's `scale: 'css'` then downsamples 2x back to
    // 1x, and which side of the boundary a half-covered row rounds to is not
    // guaranteed to repeat. Pinning the device scale to 1 means the
    // compositor rasterises at the scale the capture is taken at and the
    // rounding step disappears. Same principle as the flag above: narrow the
    // environment, do not widen a tolerance. Row 7 still demands byte
    // equality, and a real rendering regression still fails it.
    args: [
      '--force-color-profile=srgb',
      '--force-device-scale-factor=1',
      // The THIRD raster pin, and the same argument as the two above.
      //
      // Subpixel text antialiasing weights a glyph's edge pixels per CHANNEL
      // rather than per luminance, so one side of every stem lands
      // green-dominant and the other magenta-dominant. `greenVerdict`'s first
      // arm is exactly `g > max(r, b) + 16`, so on a host that renders text
      // that way the no-green sweep reports hundreds of one-pixel offenders
      // strewn along the edges of ordinary black-on-white type. That is what
      // ci-linux found in the captured GIF (798 of them, densest in the
      // caption frame) while macOS, which does not render these surfaces
      // subpixel, saw none.
      //
      // The pixels are real, so the sweep is right to report them; they are
      // just not this product's colour, they are the host's font rasteriser
      // leaking a hue into a capture. The fix therefore goes where E.3 says
      // it goes: remove the rendering mode from the capture environment and
      // leave the assertion at zero. Widening the band, or excusing runs of
      // one pixel, would blind the sweep to a genuine hairline of green in
      // the UI, which is the exact thing INV-2 exists to catch.
      //
      // Verified a no-op on macOS: with this flag the GIF still encodes to
      // bytes identical to the committed artefact, so pinning it costs the
      // shipping platform nothing.
      '--disable-lcd-text',
      MAIN_ENTRY,
    ],
    env,
  });
  const child = app.process();
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
  let page: Page;
  try {
    // Playwright's own 30s default, deliberately NOT raised. In every run
    // where this fired the window never arrived at all, so a longer wait buys
    // nothing but a slower red.
    page = await app.firstWindow();
  } catch (error: unknown) {
    /*
     * Before this catch, the timeout threw straight past this frame. Two
     * things followed, and both of them made the next failure harder to read
     * than this one: the Electron process stayed alive until the whole worker
     * exited, competing for the machine with every file that ran after it,
     * and everything main had written to stderr was collected into `chunks`
     * and then dropped on the floor, because the only reader of `chunks` is
     * the `transcript()` on the object this function never got to return.
     *
     * A shell that cannot open a window must die here, and it must say what
     * it said on the way down.
     */
    /*
     * WHAT THE PROCESS WAS DOING WHEN THE WAIT RAN OUT, captured BEFORE the
     * kill, because after `SIGKILL` every process looks the same.
     *
     * `exitCode`/`signalCode` are null while a child is running and set once
     * it is reaped, so the pair answers the one question the transcript on
     * its own cannot: did main DIE or is it STUCK? An empty transcript is
     * consistent with both, and the two have nothing to do with each other.
     * Dead with code 0 is main's single-instance branch quitting silently
     * (`src/main/index.ts` now prints a line there, so a transcript that is
     * still empty rules that out too). Dead on a signal is a crash. Still
     * running is `app.whenReady()` never settling, which on a hosted macOS
     * runner means the GUI session, not this repository.
     *
     * A CI run that fails 168 times should say which of those it was. The
     * one that prompted this said only "no window", 168 times, with nothing
     * after it.
     */
    const state =
      child.exitCode !== null
        ? `exited code=${String(child.exitCode)}`
        : child.signalCode !== null
          ? `killed signal=${child.signalCode}`
          : 'STILL RUNNING (never became ready)';
    child.kill('SIGKILL');
    const reason = error instanceof Error ? error.message : String(error);
    const said = chunks.join('');
    throw new Error(
      `launchApp: no window: ${reason}\n` +
        `--- main process: ${state}, pid=${String(child.pid)} ---\n` +
        `--- main transcript (${String(said.length)} bytes) ---\n${said}`,
    );
  }
  /*
   * The same reasoning as `--force-color-profile=srgb` above, for one more
   * input the renderer takes from the MACHINE rather than from the product.
   *
   * `prefers-reduced-transparency` is a real system setting, and the product
   * honours it on purpose (`tokens.css` swaps the translucent layers opaque),
   * because Reduce Transparency is an accessibility preference and ignoring
   * it would be the bug. GitHub's macos-15 runners report `reduce`, so every
   * layer was already opaque before any row pushed a theme, and the rows that
   * assert translucency failed against a preference nobody in the tree chose.
   *
   * Pinned to `no-preference` for this page, which narrows the ENVIRONMENT
   * and not the assertion: no threshold moves, and the product's own path is
   * still under test, since `__wmPushTheme` drives
   * `data-reduced-transparency` and the Sc17 rows assert both states through
   * it. The session is deliberately kept open: Chromium drops a session's
   * emulation when it detaches.
   */
  const media = await app.context().newCDPSession(page);
  await media.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-transparency', value: 'no-preference' },
    ],
  });
  return {
    app,
    page,
    transcript: () => chunks.join(''),
    close: async () => {
      await app.close();
    },
  };
}

/**
 * The one wait primitive. `data-conn` is set by the renderer from the
 * stream state main pushes, and it is the same value the state strip
 * renders, so this cannot pass while the window is lying.
 */
export async function waitForConnected(page: Page): Promise<void> {
  await page.waitForSelector('html[data-conn="connected"]', {
    timeout: 15_000,
  });
}

/** Wait for the app to settle into any terminal connection state. */
export async function waitForConn(page: Page, state: string): Promise<void> {
  await page.waitForSelector(`html[data-conn="${state}"]`, { timeout: 15_000 });
}

/**
 * `process.env` with the holes removed.
 *
 * `exactOptionalPropertyTypes` makes the difference load-bearing: an env
 * whose value is literally `undefined` is not the same thing as an env that
 * does not carry the key, and Playwright spreads what it is given.
 */
function definedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) out[key] = value;
  return out;
}

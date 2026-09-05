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
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher: fakeWatcher(),
    doctorProbes: probes,
    backend: loopback,
    backendName: 'loopback',
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
    args: [MAIN_ENTRY],
    env,
  });
  const child = app.process();
  child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
  child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
  const page = await app.firstWindow();
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

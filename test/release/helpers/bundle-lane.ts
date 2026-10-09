/**
 * THE BUNDLE LANE (s9 Sc 5, kept by v2 S6c).
 *
 * `bundle-daemon.spec.ts` launches a daemon that was built rather than
 * imported, waits for it to say it is listening, and talks to it over a
 * loopback port. The lane is the machinery for that: temp directories it
 * cleans up, a free port, a synthetic home and chat.db, and a `waitFor` that
 * polls on `setImmediate` and never on a timer.
 *
 * WHY THIS IS A HELPER RATHER THAN INLINE. A second copy of `waitFor` is a
 * second place for the polling rule below to be got wrong, and the rule is not
 * obvious. `packages/daemon/test/helpers/launchd-lane.ts` set the precedent
 * for a test-side lane in this repo; this is the same idea with far less at
 * stake, since nothing here can touch anything outside a temp directory.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const need = createRequire(import.meta.url);

const temps: string[] = [];

/** A temp directory this lane will remove in `cleanupTemps`. */
export function tempDir(prefix = 'wemessage-bundle-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * Remove every directory this lane handed out. Specs call it from `afterAll`;
 * it is idempotent, so a spec that calls it twice is not a bug.
 */
export function cleanupTemps(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function freePort(): Promise<number> {
  return await new Promise((ok, bad) => {
    const srv = createServer();
    srv.on('error', bad);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        bad(new Error('no port'));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        ok(port);
      });
    });
  });
}

/**
 * Poll a predicate on the macrotask queue. `setTimeout` is banned under this
 * tree, and `setImmediate` is not a timer: it yields to I/O, which is exactly
 * what a test waiting on a child's stdout needs.
 */
export async function waitFor(
  cond: () => boolean,
  what: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((ok) => {
      setImmediate(ok);
    });
  }
}

export interface Launched {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /**
   * Signal the child and WAIT for it to be gone. The waiting is the point.
   * `kill()` returns as soon as the signal is delivered, so a row that ends
   * with a bare `kill` hands the next row a process that still holds its
   * port, its temp directory and an open handle inside the bundle the next
   * row reads.
   *
   * Idempotent, and safe on an already-dead child: `exited` is a settled
   * promise by then and `kill` on a reaped pid is a no-op.
   */
  stop: (signal?: NodeJS.Signals) => Promise<void>;
}

export function launch(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Launched {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()));
  child.stderr?.on('data', (b: Buffer) => (err += b.toString()));
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((ok) => {
    child.on('close', (code, signal) => {
      ok({ code, signal });
    });
  });
  const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    child.kill(signal);
    await exited;
  };
  return { child, stdout: () => out, stderr: () => err, exited, stop };
}

/** A chat.db the daemon can tail without touching the operator's real one. */
export function bed(): { dir: string; chatDb: string } {
  const dir = tempDir();
  const dbDir = tempDir('wemessage-chatdb-');
  const chatDb = join(dbDir, 'fixture.db');
  const fixtures = need('../../../fixtures/dist/index.js') as {
    createChatDb: (p: string) => { close: () => void };
  };
  fixtures.createChatDb(chatDb).close();
  return { dir, chatDb };
}

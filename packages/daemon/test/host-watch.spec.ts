/**
 * v2 F12: the host-death watch.
 *
 * Unit rows prove the module; the process row proves the claim an operator
 * meets: SIGKILL the host and the daemon it spawned goes down on its own,
 * taking its lock with it, so the next host's daemon can start. Before this
 * fix that daemon was reparented to pid 1 and held the lock forever
 * (observed live 2026-10-13, nine refused restarts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatDb } from '@wemessage/fixtures';
import { hostPidFrom, watchHost } from '../src/host-watch.js';
import { LOCK_FILENAME } from '../src/lock.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = resolve(HERE, '..', 'dist', 'main.js');
const BOOT_BUDGET_MS = 20_000;
const SHUTDOWN_BUDGET_MS = 10_000;

/* ── unit ─────────────────────────────────────────────────────────────── */

describe('hostPidFrom', () => {
  it('reads the pid only under the swift host', () => {
    expect(
      hostPidFrom({ WEMESSAGE_HOST: 'swift', WEMESSAGE_HOST_PID: '4242' }),
    ).toBe(4242);
    expect(hostPidFrom({ WEMESSAGE_HOST_PID: '4242' })).toBeNull();
    expect(
      hostPidFrom({ WEMESSAGE_HOST: 'electron', WEMESSAGE_HOST_PID: '4242' }),
    ).toBeNull();
  });

  it('treats an unreadable value as no watch, never as a boot failure', () => {
    for (const raw of [
      undefined,
      '',
      'abc',
      '12x',
      '-5',
      '0',
      '1',
      '1e3',
      ' 42',
    ]) {
      expect(
        hostPidFrom({ WEMESSAGE_HOST: 'swift', WEMESSAGE_HOST_PID: raw }),
      ).toBeNull();
    }
  });
});

describe('watchHost', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays quiet while the parent is the host, fires once when it is not', () => {
    vi.useFakeTimers();
    let ppid = 500;
    const onHostGone = vi.fn();
    watchHost({
      hostPid: 500,
      parentPid: () => ppid,
      onHostGone,
      everyMs: 100,
    });
    vi.advanceTimersByTime(1_000);
    expect(onHostGone).not.toHaveBeenCalled();
    ppid = 1;
    vi.advanceTimersByTime(100);
    expect(onHostGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onHostGone).toHaveBeenCalledTimes(1);
  });

  it('fires immediately when the host died before the watch started', () => {
    const onHostGone = vi.fn();
    const w = watchHost({ hostPid: 500, parentPid: () => 1, onHostGone });
    expect(onHostGone).toHaveBeenCalledTimes(1);
    w.stop();
  });

  it('stop() ends the watch', () => {
    vi.useFakeTimers();
    let ppid = 500;
    const onHostGone = vi.fn();
    const w = watchHost({
      hostPid: 500,
      parentPid: () => ppid,
      onHostGone,
      everyMs: 100,
    });
    w.stop();
    ppid = 1;
    vi.advanceTimersByTime(1_000);
    expect(onHostGone).not.toHaveBeenCalled();
  });
});

/* ── process row ──────────────────────────────────────────────────────── */

const temps: string[] = [];
const children: ChildProcess[] = [];
const orphans: number[] = [];

afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  }
  for (const pid of orphans.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone: the expected case */
    }
  }
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

async function waitFor(
  pred: () => boolean,
  what: string,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline)
      throw new Error(
        `timed out after ${String(budgetMs)}ms waiting for ${what}`,
      );
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((ok, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const a = probe.address();
      const port = typeof a === 'object' && a !== null ? a.port : 0;
      probe.close(() => {
        ok(port);
      });
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A stand-in for WeMessageDaemonHost: spawns main.js with the host keys set
 * to ITS OWN pid, prints the daemon's pid, and idles. Killing it with
 * SIGKILL is exactly the event the host can do nothing about.
 */
const FAKE_HOST = `
const { spawn } = require('node:child_process');
const env = { ...process.env, WEMESSAGE_HOST: 'swift', WEMESSAGE_HOST_PID: String(process.pid) };
const c = spawn(process.execPath, [process.argv[1]], { env, stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write('DAEMON_PID=' + c.pid + '\\n');
setInterval(() => {}, 1000);
`;

describe('v2 F12: a SIGKILLed host does not leave its daemon behind', () => {
  it(
    'the orphaned daemon exits and removes daemon.lock',
    async () => {
      const dir = tempDir('wemessage-host-watch-');
      const chatDb = join(tempDir('wemessage-chatdb-'), 'fixture.db');
      createChatDb(chatDb).close();
      const bin = tempDir('wemessage-stub-bin-');
      writeFileSync(join(bin, 'osascript'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(bin, 'osascript'), 0o755);
      const port = await freePort();

      const host = spawn(process.execPath, ['-e', FAKE_HOST, MAIN], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          WEMESSAGE_DIR: dir,
          WEMESSAGE_PORT: String(port),
          WEMESSAGE_CHATDB: chatDb,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(host);
      let out = '';
      let err = '';
      host.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
      host.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')));

      await waitFor(
        () => out.includes('listening on 127.0.0.1'),
        'the daemon under the fake host to listen',
        BOOT_BUDGET_MS,
      );
      const m = /DAEMON_PID=(\d+)/.exec(out);
      expect(m).not.toBeNull();
      const daemonPid = Number(m?.[1]);
      orphans.push(daemonPid);
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(true);
      // While the host lives, the watch must not fire.
      await new Promise((ok) => setTimeout(ok, 1_500));
      expect(alive(daemonPid)).toBe(true);

      host.kill('SIGKILL');

      await waitFor(
        () => !alive(daemonPid),
        'the orphaned daemon to exit',
        SHUTDOWN_BUDGET_MS,
      );
      expect(existsSync(join(dir, LOCK_FILENAME))).toBe(false);
      await waitFor(
        () => err.includes('is gone; shutting down'),
        'the shutdown line',
        2_000,
      );
    },
    BOOT_BUDGET_MS * 2,
  );
});

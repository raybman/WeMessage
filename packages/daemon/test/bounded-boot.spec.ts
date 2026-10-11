/**
 * v2 F8b + F8c: bounded startup and a graceful no-Full-Disk-Access boot.
 *
 * F8b: the boot scan pages. Every read the scan makes is bounded by the page
 * size; boot pages within its budget and the cursor reaches chat.db's head.
 *
 * F8c: a daemon that cannot open chat.db (no Full Disk Access, or a grant
 * gone stale with a rebuild) used to throw SQLITE_CANTOPEN out of
 * startDaemon, which launchd's KeepAlive turned into a crash loop. Now it
 * boots, listens, reports the doctor's state over /v1/status, and once the
 * open succeeds it runs the deferred recovery and starts tailing on its own.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import {
  createChatDbReader,
  type FdaProbeResult,
  type IngestChatDbReader,
} from '@wemessage/ingest';
import { createChatDb } from '@wemessage/fixtures';
import {
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const watcher: FsWatcher = { watch: () => () => undefined };

function probes(): DoctorProbes & { setFda(v: FdaProbeResult): void } {
  let fda: FdaProbeResult = 'eperm';
  return {
    osMajor: () => 15,
    fda: () => Promise.resolve(fda),
    automation: () => Promise.resolve('ok'),
    messagesRunning: () => Promise.resolve(true),
    setFda: (v) => {
      fda = v;
    },
  };
}

const backend = {
  isAvailable: () => Promise.resolve(true),
  send: () => Promise.reject(new Error('bounded-boot: no sends')),
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wm-bounded-boot-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function status(daemon: RunningDaemon): Promise<{
  connectionState: string;
  cursor: { lastRowid: number } | null;
}> {
  const res = await daemon.server.app.inject({
    method: 'GET',
    url: '/v1/status',
    headers: { authorization: `Bearer ${daemon.server.token ?? ''}` },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function until(check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('v2 F8b: the boot scan pages', () => {
  it('every scan read is bounded by the page size, and boot still reaches the head', async () => {
    const dir = tempDir();
    const chatDbPath = join(dir, 'chat.db');
    const fixture = createChatDb(chatDbPath);
    cleanups.push(() => fixture.close());
    const handleId = fixture.addHandle('+15556660101');
    const chatId = fixture.addChat({
      identifier: '+15556660101',
      handleIds: [handleId],
    });
    const refs = fixture.addMessageBurst(25, {
      chatId,
      handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    const limits: (number | undefined)[] = [];
    const p = probes();
    p.setFda('ok');
    const daemon = await startDaemon({
      autonomy: 'parked',
      configDir: join(dir, 'config'),
      chatDbPath,
      clock,
      watcher,
      doctorProbes: p,
      backend,
      backendName: 'bounded-boot-fake',
      scanPageSize: 10,
      scanOpenReader: (path, opts): IngestChatDbReader => {
        const real = createChatDbReader(path, opts);
        return {
          ...real,
          close: () => real.close(),
          readSince: (rowid: number, limit?: number) => {
            limits.push(limit);
            return real.readSince(rowid, limit as number);
          },
        };
      },
    });
    cleanups.push(() => daemon.stop());

    expect(daemon.bootLog).toEqual(['recovery', 'watcher', 'listen']);
    expect(limits.length).toBeGreaterThanOrEqual(3);
    expect(limits.every((l) => l === 10)).toBe(true);
    expect((await status(daemon)).cursor?.lastRowid).toBe(refs[24]?.rowid);
  });
});

describe('v2 F8c: no chat.db access is a state, not a crash', () => {
  it('boots, listens and reports disconnected; tails once access arrives', async () => {
    const dir = tempDir();
    const chatDbPath = join(dir, 'chat.db'); // does not exist yet
    const p = probes();
    const errors: unknown[] = [];
    const daemon = await startDaemon({
      autonomy: 'parked',
      configDir: join(dir, 'config'),
      chatDbPath,
      clock,
      watcher,
      doctorProbes: p,
      backend,
      backendName: 'bounded-boot-fake',
      chatDbRetryMs: 20,
      onError: (e) => errors.push(e),
    });
    cleanups.push(() => daemon.stop());

    expect(daemon.bootLog).toEqual(['recovery', 'watcher', 'listen']);
    const before = await status(daemon);
    expect(before.connectionState).toBe('disconnected');
    expect(
      errors.some((e) => (e as { code?: string }).code === 'SQLITE_CANTOPEN'),
    ).toBe(true);

    // The grant arrives: chat.db becomes readable and the probe agrees.
    const fixture = createChatDb(chatDbPath);
    cleanups.push(() => fixture.close());
    const handleId = fixture.addHandle('+15556660102');
    const chatId = fixture.addChat({
      identifier: '+15556660102',
      handleIds: [handleId],
    });
    const refs = fixture.addMessageBurst(3, {
      chatId,
      handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    p.setFda('ok');

    await until(async () => {
      const s = await status(daemon);
      return (
        s.connectionState === 'fully-connected' &&
        s.cursor?.lastRowid === refs[2]?.rowid
      );
    });
  });

  it('a human disconnect is never undone by the retry', async () => {
    const dir = tempDir();
    const chatDbPath = join(dir, 'chat.db');
    const p = probes();
    const daemon = await startDaemon({
      autonomy: 'parked',
      configDir: join(dir, 'config'),
      chatDbPath,
      clock,
      watcher,
      doctorProbes: p,
      backend,
      backendName: 'bounded-boot-fake',
      chatDbRetryMs: 20,
    });
    cleanups.push(() => daemon.stop());
    const res = await daemon.server.app.inject({
      method: 'POST',
      url: '/v1/disconnect',
      headers: { authorization: `Bearer ${daemon.server.token ?? ''}` },
    });
    expect(res.statusCode).toBeLessThan(300);
    // Disconnect rotates the token, so this reads the store directly.
    const fixture = createChatDb(chatDbPath);
    cleanups.push(() => fixture.close());
    const handleId = fixture.addHandle('+15556660103');
    const chatId = fixture.addChat({
      identifier: '+15556660103',
      handleIds: [handleId],
    });
    fixture.addMessageBurst(2, {
      chatId,
      handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    p.setFda('ok');
    await new Promise((r) => setTimeout(r, 200));
    expect(daemon.store.getCursor()).toBeNull();
  });
});

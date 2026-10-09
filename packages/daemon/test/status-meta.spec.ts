/**
 * v2 B4: `GET /v1/status` never carries `meta`.
 *
 * Board 07's voice dock is drawn from `status.meta.voice`, which only the
 * Swift fake daemon's `fixtures/scenarios/preview-voice*` serve. There is no
 * speech engine in this version, so the released app must never see a voice
 * state: the guarantee is that this daemon has no way to produce the key.
 * Every status branch is held to it, the same three that B0's channel rows
 * cover: the store-less fallback, the store-backed fallback and the
 * composed daemon's own `getStatus`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb } from '@wemessage/fixtures';
import {
  buildServer,
  startDaemon,
  type DaemonServer,
  type DoctorProbes,
} from '@wemessage/daemon';
import { boot, cleanupHarness, get } from './helpers/draft-harness.js';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await cleanupHarness();
});

function assertNoMeta(body: unknown, text: string): void {
  expect(body).toBeTypeOf('object');
  expect(Object.keys(body as object)).not.toContain('meta');
  expect(text).not.toMatch(/"meta"\s*:/);
  expect(text).not.toMatch(/"voice"\s*:/);
}

describe('B4: no status branch emits meta', () => {
  it('a store-less server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-status-meta-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const server: DaemonServer = await buildServer({
      autonomy: 'live',
      configDir: dir,
    });
    cleanups.push(() => server.app.close());
    const res = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${server.token ?? ''}` },
    });
    expect(res.statusCode).toBe(200);
    assertNoMeta(res.json(), res.body);
  });

  it('a store-backed server', async () => {
    const h = await boot();
    const res = await get(h, '/v1/status');
    expect(res.statusCode).toBe(200);
    assertNoMeta(res.json(), res.body);
  });

  it("the composed daemon's own getStatus", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-status-meta-daemon-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const chatDbPath = join(dir, 'chat.db');
    createChatDb(chatDbPath).close();
    const clock: Clock = {
      now: () => new Date().toISOString(),
      nowMs: () => Date.now(),
    };
    const watcher: FsWatcher = { watch: () => () => undefined };
    const doctorProbes: DoctorProbes = {
      osMajor: () => 15,
      fda: async () => 'ok',
      automation: async () => 'ok',
      messagesRunning: async () => true,
    };
    const daemon = await startDaemon({
      autonomy: 'live',
      configDir: join(dir, 'config'),
      chatDbPath,
      clock,
      watcher,
      doctorProbes,
      backend: createUnusedSendBackend(),
      backendName: 'unused',
    });
    cleanups.push(() => daemon.stop());
    const res = await daemon.server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${daemon.server.token ?? ''}` },
    });
    expect(res.statusCode).toBe(200);
    assertNoMeta(res.json(), res.body);
  });
});

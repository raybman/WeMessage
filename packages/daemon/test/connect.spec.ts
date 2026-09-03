/**
 * Scenario 9 (part 2) — POST /v1/connect (s3-execution §1.3.7, §2.4.1).
 *
 * The inverse of disconnect.spec.ts's disconnect suite: clears the
 * `SETTING_USER_DISCONNECTED` latch, re-runs the Scenario 7 doctor engine,
 * and re-arms the watcher when the resulting state can send or ingest.
 * Conventions mirrored from tail-pipeline.spec.ts (fakeWatcher/waitFor/boot)
 * and doctor.spec.ts (fakeProbes-style fixed DoctorProbes fakes) — never a
 * real osascript call, never a real iMessage (test/arch.spec.ts gates
 * (a)/(b)).
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import {
  readToken,
  startDaemon,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const fullyConnectedProbes: DoctorProbes = {
  osMajor: () => 15,
  fda: async () => 'ok',
  automation: async () => 'ok',
  messagesRunning: async () => true,
};

interface FakeWatcher extends FsWatcher {
  fire: () => void;
  startCount: number;
}

function fakeWatcher(): FakeWatcher {
  const handlers: (() => void)[] = [];
  const w: FakeWatcher = {
    startCount: 0,
    watch(_paths, onChange) {
      w.startCount += 1;
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
  return w;
}

interface Ctx {
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  watcher: FakeWatcher;
  configDir: string;
  chatId: number;
  handleId: number;
  token: string;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function boot(): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-connect-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');

  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle('+15550008888');
  const chatId = fixture.addChat({
    identifier: '+15550008888',
    handleIds: [handleId],
  });

  const watcher = fakeWatcher();
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher,
    doctorProbes: fullyConnectedProbes,
    backend: createUnusedSendBackend(),
    backendName: 'unused',
  });
  cleanups.push(() => daemon.stop());

  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');
  return { daemon, fixture, watcher, configDir, chatId, handleId, token };
}

/** Disconnects, returning the rotated bearer required for subsequent calls. */
async function disconnect(ctx: Ctx): Promise<string> {
  const res = await ctx.daemon.server.app.inject({
    method: 'POST',
    url: '/v1/disconnect',
    headers: { authorization: `Bearer ${ctx.token}` },
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  const rotated = readToken(ctx.configDir);
  if (rotated === null) throw new Error('expected a rotated token');
  return rotated;
}

describe('POST /v1/connect — reconnect after a disconnect (§1.3.7)', () => {
  it('fully-connected probes -> state:"fully-connected" with a checks array and probedAt', async () => {
    const ctx = await boot();
    const bearer = await disconnect(ctx);

    const res = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/connect',
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      state: string;
      checks: unknown[];
      probedAt: string;
    };
    expect(body.state).toBe('fully-connected');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(typeof body.probedAt).toBe('string');
  });

  it('never touches the token file: mtime and content are unchanged by connect', async () => {
    const ctx = await boot();
    const bearer = await disconnect(ctx);
    const tokenPath = join(ctx.configDir, 'daemon.token');
    const before = statSync(tokenPath);
    const beforeContent = readToken(ctx.configDir);

    await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/connect',
      headers: { authorization: `Bearer ${bearer}` },
    });

    const after = statSync(tokenPath);
    const afterContent = readToken(ctx.configDir);
    expect(afterContent).toBe(beforeContent);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('re-arms the watcher: a fixture message ingests again once fired', async () => {
    const ctx = await boot();
    const bearer = await disconnect(ctx);

    // confirm the drain: nothing ingests while still disconnected
    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX pre-connect, must not ingest',
    });
    ctx.watcher.fire();
    await new Promise((r) => setTimeout(r, 100));
    let status = await ctx.daemon.server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${bearer}` },
    });
    // boot()'s own catch-up scan already ran (cursor exists at 0); the
    // drain guarantee under test is that it stays at 0 while disconnected.
    expect(
      (status.json() as { cursor: { lastRowid: number } | null }).cursor
        ?.lastRowid,
    ).toBe(0);

    const connectRes = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/connect',
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(connectRes.statusCode).toBe(200);

    ctx.fixture.addMessage({
      chatId: ctx.chatId,
      handleId: ctx.handleId,
      text: 'GL-FIX post-connect, should ingest',
    });
    ctx.watcher.fire();

    const deadline = Date.now() + 2000;
    let cursor: { lastRowid: number } | null = null;
    while (Date.now() < deadline) {
      status = await ctx.daemon.server.app.inject({
        method: 'GET',
        url: '/v1/status',
        headers: { authorization: `Bearer ${bearer}` },
      });
      cursor = (status.json() as { cursor: { lastRowid: number } | null })
        .cursor;
      // connect's own catch-up scan already picks up the pre-connect row too
      if (cursor !== null && cursor.lastRowid >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(cursor?.lastRowid).toBeGreaterThanOrEqual(2);
  });

  it('a second connect call is idempotent: 200, same fully-connected state, no errors', async () => {
    const ctx = await boot();
    const bearer = await disconnect(ctx);

    const first = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/connect',
      headers: { authorization: `Bearer ${bearer}` },
    });
    const second = await ctx.daemon.server.app.inject({
      method: 'POST',
      url: '/v1/connect',
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((first.json() as { state: string }).state).toBe('fully-connected');
    expect((second.json() as { state: string }).state).toBe('fully-connected');
  });
});

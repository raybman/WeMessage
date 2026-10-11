/**
 * v2 B0: `GET /v1/status` carries `channels: [{ channel, state, reason? }]`,
 * and the real daemon cannot say `preview`.
 *
 * `preview` is the state that renders a channel's board over fixture data.
 * The Swift fake daemon serves it from `fixtures/scenarios/preview-*` so CI
 * can build and snapshot boards whose adapters do not exist. The released app
 * talks to this daemon only, so the guarantee that no user ever sees a
 * fixture board is exactly the guarantee that this package has no way to
 * produce one. Three rows hold it:
 *
 *  1. the output union. `state` is `connected | not_connected` at the type
 *     level and in the zod schema the route's answer is parsed through;
 *  2. every status branch. The store-less fallback, the store-backed
 *     fallback and the composed daemon's own `getStatus` all answer with
 *     entries the schema admits, and none of them spells the word;
 *  3. no source spells it. No file under `packages/` source carries the
 *     quoted literal, so a later route cannot reach for it either.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { Clock, FsWatcher } from '@wemessage/core';
import { createChatDb } from '@wemessage/fixtures';
import {
  buildServer,
  channelStatusSchema,
  channelsSchema,
  channelStatuses,
  CHANNEL_NAMES,
  startDaemon,
  type ChannelStatusEntry,
  type DaemonServer,
  type DoctorProbes,
} from '@wemessage/daemon';
import { boot, cleanupHarness, get } from './helpers/draft-harness.js';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const FIXTURE_STATE = 'preview';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  await cleanupHarness();
});

/** What every branch answers in this version. */
const EXPECTED: ChannelStatusEntry[] = [
  { channel: 'imessage', state: 'connected' },
  {
    channel: 'whatsapp',
    state: 'not_connected',
    reason: 'not_in_this_version',
  },
  {
    channel: 'linkedin',
    state: 'not_connected',
    reason: 'not_in_this_version',
  },
  { channel: 'email', state: 'not_connected', reason: 'not_in_this_version' },
];

/**
 * `withFacts`: v2 F7 puts lastSyncAt, today and handle on the composed
 * daemon's connected iMessage entry. The union is the same; the comparison
 * is on channel, state and reason, and the facts are pinned to that entry.
 */
function assertChannels(body: unknown, text: string, withFacts = false): void {
  const channels = (body as { channels?: unknown }).channels;
  expect(channelsSchema.safeParse(channels).success).toBe(true);
  if (withFacts) {
    const entries = channels as Record<string, unknown>[];
    expect(
      entries.map(({ channel, state, reason }) =>
        reason === undefined ? { channel, state } : { channel, state, reason },
      ),
    ).toEqual(EXPECTED);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      'channel',
      'handle',
      'lastSyncAt',
      'state',
      'today',
    ]);
    for (const entry of entries.slice(1)) {
      expect(Object.keys(entry).sort()).toEqual(['channel', 'reason', 'state']);
    }
  } else {
    expect(channels).toEqual(EXPECTED);
  }
  expect(text).not.toContain(FIXTURE_STATE);
}

describe('B0 row 1: the output union has no fixture state', () => {
  it('the zod state enum is connected and not_connected, nothing else', () => {
    expect([...channelStatusSchema.shape.state.options].sort()).toEqual([
      'connected',
      'not_connected',
    ]);
    expect(channelStatusSchema.shape.state.options).not.toContain(
      FIXTURE_STATE,
    );
  });

  it('the TypeScript state type is the same two literals', () => {
    expectTypeOf<ChannelStatusEntry['state']>().toEqualTypeOf<
      'connected' | 'not_connected'
    >();
  });

  it('the schema refuses an entry in the fixture state, and an unknown key', () => {
    expect(
      channelStatusSchema.safeParse({
        channel: 'whatsapp',
        state: FIXTURE_STATE,
      }).success,
    ).toBe(false);
    expect(
      channelStatusSchema.safeParse({
        channel: 'whatsapp',
        state: 'connected',
        scenario: 'x',
      }).success,
    ).toBe(false);
  });

  it('names the four channels in rail order, iMessage the one connected', () => {
    expect(CHANNEL_NAMES).toEqual([
      'imessage',
      'whatsapp',
      'linkedin',
      'email',
    ]);
    expect(channelStatuses()).toEqual(EXPECTED);
  });
});

describe('B0 row 2: every status branch answers with the union', () => {
  it('a store-less server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-channels-'));
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
    assertChannels(res.json(), res.body);
  });

  it('a store-backed server', async () => {
    const h = await boot();
    const res = await get(h, '/v1/status');
    expect(res.statusCode).toBe(200);
    assertChannels(res.json(), res.body);
  });

  it("the composed daemon's own getStatus", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-channels-daemon-'));
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
    assertChannels(res.json(), res.body, true);
  });
});

/** Every .ts file under packages/<pkg>/src, adapters included. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts') && path.includes(`${sep}src${sep}`))
        out.push(path);
    }
  };
  walk(join(REPO, 'packages'));
  return out;
}

describe('B0 row 3: no package source spells the fixture state', () => {
  it('no quoted literal of it under packages/*/src', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    const quoted = new RegExp(`['"\`]${FIXTURE_STATE}['"\`]`);
    const offenders = files
      .filter((f) => quoted.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO, f));
    expect(offenders).toEqual([]);
  });
});

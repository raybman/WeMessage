/**
 * Scenario 4 — Daemon fails closed without a token (Track B).
 * Named S1 checkpoint (spec s1-execution Part 2 #4); plan §2.4.2 row 1, §2.6.
 *
 * Part A: no obtainable token (config dir unwritable, so first-run self-heal
 * cannot generate one) → every route is 503 {"error":"no-auth-token"} and no
 * route handler executes. "No anonymous localhost mode exists."
 *
 * Part B: first run with a writable config dir → daemon generates a 256-bit
 * token (wm_ prefix per the WeMessage rename map R11) at daemon.token mode
 * 0600; bearer 200 / wrong 401 / missing 401; WS upgrade authenticates at
 * connect time; listener binds 127.0.0.1 only.
 *
 * F-4 (open flag, asserted as proposed): when a token exists, unauthenticated
 * GET /v1/health returns 200 {status:'ok'} — liveness only, no state payload;
 * every information-bearing route requires the bearer.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildServer,
  startServer,
  TOKEN_FILENAME,
  type DaemonServer,
} from '@wemessage/daemon';

const dirs: string[] = [];
const servers: DaemonServer[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-daemon-'));
  dirs.push(d);
  return d;
}

async function boot(configDir: string): Promise<DaemonServer> {
  const server = await buildServer({ configDir });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

/** Raw HTTP upgrade attempt so WS auth is asserted at the handshake itself. */
function wsUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/events',
      agent: false, // fresh socket per attempt: rejected upgrades close theirs

      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Part A — no obtainable auth token (§2.4.2 row 1)', () => {
  async function bootTokenless(): Promise<DaemonServer> {
    const dir = tempDir();
    chmodSync(dir, 0o500); // unwritable: first-run token generation must fail
    const server = await boot(dir);
    expect(server.token).toBeNull();
    return server;
  }

  it('serves 503 {"error":"no-auth-token"} on every route, health included', async () => {
    const server = await bootTokenless();
    for (const url of ['/v1/health', '/v1/status', '/v1/events']) {
      const res = await server.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toEqual({ error: 'no-auth-token' });
    }
  });

  it('is 503 even when the caller presents some bearer (no anonymous or guessed mode)', async () => {
    const server = await bootTokenless();
    const res = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer wm_${'a'.repeat(64)}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'no-auth-token' });
  });

  it('executes no route handler', async () => {
    const server = await bootTokenless();
    await server.app.inject({ method: 'GET', url: '/v1/health' });
    await server.app.inject({ method: 'GET', url: '/v1/status' });
    await server.app.inject({ method: 'GET', url: '/v1/events' });
    expect(server.counters.handlerCalls).toBe(0);
  });
});

describe('Part B — first run generates a token; bearer auth is fail-closed (§2.6)', () => {
  it('generates a 256-bit wm_ token at daemon.token, mode 0600', async () => {
    const dir = tempDir();
    const server = await boot(dir);
    const path = join(dir, TOKEN_FILENAME);
    const onDisk = readFileSync(path, 'utf8').trim();
    expect(server.token).toBe(onDisk);
    // wm_ prefix (rename map R11) + 64 hex chars = 32 random bytes = 256 bits
    expect(onDisk).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reuses the existing token on re-boot (no silent rotation)', async () => {
    const dir = tempDir();
    const first = await boot(dir);
    const second = await boot(dir);
    expect(second.token).toBe(first.token);
  });

  it('accepts the bearer (200), rejects wrong (401) and missing (401) — never open', async () => {
    const dir = tempDir();
    const server = await boot(dir);
    const ok = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer ${server.token!}` },
    });
    expect(ok.statusCode).toBe(200);

    const wrong = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: `Bearer wm_${'0'.repeat(64)}` },
    });
    expect(wrong.statusCode).toBe(401);

    const missing = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
    });
    expect(missing.statusCode).toBe(401);

    const malformed = await server.app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: server.token! }, // no "Bearer " scheme
    });
    expect(malformed.statusCode).toBe(401);
  });

  it('health without bearer is liveness-only 200 {status:"ok"} (Open flag F-4)', async () => {
    const dir = tempDir();
    const server = await boot(dir);
    const res = await server.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' }); // no state payload
  });

  it('refuses WS upgrade without/with wrong bearer, upgrades with the bearer (§2.6)', async () => {
    const dir = tempDir();
    const server = await boot(dir);
    const port = await startServer(server); // ephemeral port

    await expect(wsUpgrade(port, {})).resolves.toBe(401);
    await expect(
      wsUpgrade(port, { authorization: `Bearer wm_${'f'.repeat(64)}` }),
    ).resolves.toBe(401);
    await expect(
      wsUpgrade(port, { authorization: `Bearer ${server.token!}` }),
    ).resolves.toBe(101);
  });

  it('binds 127.0.0.1 only (§2.6, §1.4.2 #3)', async () => {
    const dir = tempDir();
    const server = await boot(dir);
    await startServer(server);
    const addresses = server.app.addresses();
    expect(addresses.length).toBeGreaterThan(0);
    for (const a of addresses) expect(a.address).toBe('127.0.0.1');
  });
});

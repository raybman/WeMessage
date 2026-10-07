/**
 * v2 S3b: tools/swift/fake-daemon.mjs, the S0 goldens served over loopback
 * for the CI UI lane (docs/plans/v2-swift-S3.md §3.10, §4.9, §5.2 F1-F9).
 *
 * The CI `ui` job is the only place the window meets this server, and it
 * runs on one runner image. These rows are the local proof: the pure parts
 * (argument parsing, the token shape, the golden index, the routing table)
 * are called directly, and F8/F9 start the real server on port 0, bound to
 * 127.0.0.1, for the length of one test.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadGoldens,
  mintToken,
  parseArgs,
  route,
  start,
} from '../tools/swift/fake-daemon.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const contract = join(repoRoot, 'fixtures/contract');

function golden(rel: string): { route: string; status: number; body: unknown } {
  return JSON.parse(readFileSync(join(contract, rel), 'utf8')) as {
    route: string;
    status: number;
    body: unknown;
  };
}

/** Bytes the route answered, whatever shape the body took. */
function bodyOf(answer: { body?: unknown }): unknown {
  return answer.body;
}

const TOKEN = mintToken(Buffer.alloc(32, 7));

describe('v2 S3b F1: parseArgs', () => {
  it('reads --dir, --port and --pid-file', () => {
    expect(
      parseArgs(
        ['--dir', '/x/wm', '--port', '47191', '--pid-file', '/x/p'],
        {},
      ),
    ).toEqual({ dir: '/x/wm', port: 47191, pidFile: '/x/p', control: false });
  });
  it('falls back to WEMESSAGE_DIR and WEMESSAGE_PORT, then 47100', () => {
    expect(
      parseArgs([], { WEMESSAGE_DIR: '/e/wm', WEMESSAGE_PORT: '47192' }),
    ).toEqual({ dir: '/e/wm', port: 47192, pidFile: null, control: false });
    expect(parseArgs([], { WEMESSAGE_DIR: '/e/wm' })).toEqual({
      dir: '/e/wm',
      port: 47100,
      pidFile: null,
      control: false,
    });
  });
  it('allows port 0 (the OS picks)', () => {
    expect(parseArgs(['--dir', '/x', '--port', '0'], {}).port).toBe(0);
  });
  it('throws without a directory, and on an unknown flag', () => {
    expect(() => parseArgs([], {})).toThrow();
    expect(() => parseArgs(['--dir', '/x', '--host', '0.0.0.0'], {})).toThrow();
  });
});

describe('v2 S3b F2: mintToken', () => {
  it('is wm_ plus 64 lowercase hex over 32 bytes in', () => {
    expect(TOKEN).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(mintToken()).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(mintToken()).not.toBe(mintToken());
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(mintToken(bytes)).toBe('wm_' + bytes.toString('hex'));
  });
});

describe('v2 S3b F3: loadGoldens', () => {
  it('keys responses by each golden route field, never by file name', () => {
    const g = loadGoldens(contract);
    for (const key of [
      'GET /v1/health',
      'GET /v1/status',
      'GET /v1/threads',
      'GET /v1/drafts',
    ]) {
      expect(g.responses.has(key), key).toBe(true);
    }
    expect(g.responses.has('health.json')).toBe(false);
    // Two goldens share GET /v1/drafts; the window's first read is the empty list.
    expect(g.responses.get('GET /v1/drafts')?.body).toEqual(
      golden('responses/drafts.list.empty.json').body,
    );
    expect(g.wire.sse.keepaliveMs).toBe(15000);
    expect(g.sse.greeting.length).toBe(92);
  });
});

describe('v2 S3b F4-F7: route', () => {
  const g = loadGoldens(contract);
  const call = (method: string, path: string, auth?: string) =>
    route({ method, path, authorization: auth }, TOKEN, g);

  it('F4 health needs no bearer', () => {
    const a = call('GET', '/v1/health');
    expect(a.status).toBe(200);
    expect(bodyOf(a)).toEqual(golden('responses/health.json').body);
  });
  it('F5 status: missing, wrong (same and different length) and right bearer', () => {
    const missing = call('GET', '/v1/status');
    expect(missing.status).toBe(401);
    expect(bodyOf(missing)).toEqual(golden('errors/401.missing.json').body);
    const wrong = call(
      'GET',
      '/v1/status',
      `Bearer ${mintToken(Buffer.alloc(32, 9))}`,
    );
    expect(wrong.status).toBe(401);
    expect(bodyOf(wrong)).toEqual(golden('errors/401.unauthorized.json').body);
    const short = call('GET', '/v1/status', 'Bearer wm_');
    expect(short.status).toBe(401);
    const prefix = call('GET', '/v1/status', `Bearer ${TOKEN}0`);
    expect(prefix.status).toBe(401);
    const right = call('GET', '/v1/status', `Bearer ${TOKEN}`);
    expect(right.status).toBe(200);
    expect(bodyOf(right)).toEqual(golden('responses/status.json').body);
  });
  it('F5b drafts and threads answer the goldens with a bearer, ignoring the query', () => {
    const drafts = call('GET', '/v1/drafts?limit=50', `Bearer ${TOKEN}`);
    expect(drafts.status).toBe(200);
    expect(bodyOf(drafts)).toEqual(
      golden('responses/drafts.list.empty.json').body,
    );
    const threads = call('GET', '/v1/threads', `Bearer ${TOKEN}`);
    expect(threads.status).toBe(200);
    expect(bodyOf(threads)).toEqual(golden('responses/threads.list.json').body);
    expect(call('GET', '/v1/threads').status).toBe(401);
  });
  it('F6 schedules, send and toggles are parked (409)', () => {
    const parked = golden('errors/409.parked.json').body;
    for (const [m, p] of [
      ['POST', '/v1/schedules'],
      ['POST', '/v1/send'],
      ['POST', '/v1/toggles/kill-switch'],
      ['PATCH', '/v1/toggles/pause'],
    ] as const) {
      const a = call(m, p, `Bearer ${TOKEN}`);
      expect(a.status, `${m} ${p}`).toBe(409);
      expect(bodyOf(a)).toEqual(parked);
    }
  });
  it('F7 anything else is 404', () => {
    const a = call('GET', '/v1/nothing-here', `Bearer ${TOKEN}`);
    expect(a.status).toBe(404);
    expect(bodyOf(a)).toEqual(golden('errors/404.not-found.json').body);
    expect(call('DELETE', '/v1/health').status).toBe(404);
  });
});

describe('v2 S3b F8-F9: start on port 0', () => {
  let dir = '';
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (close) await close();
    close = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function boot() {
    dir = mkdtempSync(join(tmpdir(), 'wm-fake-daemon-'));
    const lines: string[] = [];
    const daemon = await start({
      dir: join(dir, 'wm'),
      port: 0,
      pidFile: join(dir, 'pid'),
      write: (s: string) => lines.push(s),
    });
    close = daemon.close;
    return { daemon, lines };
  }

  it('F8 writes a 0600 token, prints one ready line, and serves health and the stream', async () => {
    const { daemon, lines } = await boot();
    const tokenPath = join(dir, 'wm', 'daemon.token');
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, 'utf8')).toBe(daemon.token + '\n');
    expect(readFileSync(join(dir, 'pid'), 'utf8').trim()).toBe(
      String(process.pid),
    );
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.server.address()).toMatchObject({
      address: '127.0.0.1',
      port: daemon.port,
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ready: true,
      port: daemon.port,
      dir: join(dir, 'wm'),
    });

    const base = `http://127.0.0.1:${daemon.port}`;
    const health = await fetch(`${base}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual(golden('responses/health.json').body);

    const ac = new AbortController();
    const sse = await fetch(`${base}/v1/events/sse`, {
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    const greeting = readFileSync(join(contract, 'sse/greeting.txt'));
    const reader = sse.body!.getReader();
    let got = Buffer.alloc(0);
    while (got.length < greeting.length) {
      const { value, done } = await reader.read();
      if (done) break;
      got = Buffer.concat([got, Buffer.from(value)]);
    }
    expect(got.subarray(0, greeting.length).equals(greeting)).toBe(true);
    ac.abort();
    await reader.cancel().catch(() => undefined);

    const refused = await fetch(`${base}/v1/events/sse`);
    expect(refused.status).toBe(401);
    await refused.body?.cancel();
  });

  it('F9 the token is never in what the daemon prints', async () => {
    const { daemon, lines } = await boot();
    expect(daemon.token).toMatch(/^wm_[0-9a-f]{64}$/);
    for (const line of lines) {
      expect(line).not.toContain(daemon.token);
      expect(line).not.toContain('wm_');
    }
  });
});

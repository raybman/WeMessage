/**
 * s5-execution Scenario 11 (client half): the adapter-registry surface on
 * `@wemessage/client` — `listAdapters` / `getAdapter` / `createAdapter` /
 * `updateAdapter` / `deleteAdapter` / `rotateAdapterToken`.
 *
 * Same posture as client-s3/client-s4: pure unit tests over a stubbed
 * `fetch`, because this package is a thin transport (§2.5) and the only
 * question worth asking here is "did it build the right request and unwrap
 * the right field". Registry behaviour is proven at the daemon.
 *
 * Two pieces of real judgement:
 *  - The token-bearing responses (create, token-rotate) are typed as
 *    carrying `{ token; connectCmd }` and are the ONLY place a plaintext
 *    adapter token ever exists client-side. There is deliberately no
 *    `getAdapterToken`: the daemon answers `hasToken`, a boolean, and the
 *    absence of a read-back verb on the client is part of that contract.
 *  - `DELETE` on an adapter a rule still points at is a 409 carrying
 *    `ruleIds`. Flattening that into a generic request error would leave
 *    the CLI unable to say WHICH rules are in the way, which is the entire
 *    actionable content of that refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonConflictError,
  type AdapterPayload,
  type WeMessageClient,
} from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function alwaysJson(status: number, body: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonResponse(status, body)),
  );
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (): WeMessageClient =>
  createClient({ baseUrl: 'http://127.0.0.1:47100', token: 'wm_test' });

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function sentBody(): unknown {
  return JSON.parse(String(lastCall().init.body));
}

const ADAPTER: AdapterPayload = {
  id: 'echo-1',
  kind: 'echo',
  displayName: 'Echo',
  enabled: true,
  hasToken: true,
  health: 'connected',
  lastSeenAt: '2026-09-03T00:00:00.000Z',
  config: {},
};

describe('s5 client: adapter registry reads', () => {
  it('listAdapters unwraps the {adapters} envelope', async () => {
    alwaysJson(200, { adapters: [ADAPTER] });
    expect(await client().listAdapters()).toEqual([ADAPTER]);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/adapters');
    expect(lastCall().init.method).toBe('GET');
  });

  it('getAdapter unwraps {adapter} and percent-encodes the id', async () => {
    alwaysJson(200, { adapter: ADAPTER });
    expect(await client().getAdapter('echo 1/x')).toEqual(ADAPTER);
    expect(lastCall().url).toBe(
      'http://127.0.0.1:47100/v1/adapters/echo%201%2Fx',
    );
  });

  it('exposes no verb that reads a token back — mint-once is a type-level guarantee', () => {
    // The daemon answers `hasToken`, a boolean; there is no route that
    // returns stored token material, so there must be no client verb that
    // implies one. This row exists so that adding one is a deliberate act.
    const surface = client() as unknown as Record<string, unknown>;
    for (const key of Object.keys(surface)) {
      expect(key.toLowerCase()).not.toMatch(/^(get|read|show|fetch).*token/);
    }
  });
});

describe('s5 client: adapter registry writes', () => {
  it('createAdapter POSTs the record and returns the shown-once credential', async () => {
    alwaysJson(201, {
      adapter: ADAPTER,
      token: 'wm_deadbeef',
      connectCmd: 'wemessage-adapter-echo --url ws://x --token wm_deadbeef',
    });
    const result = await client().createAdapter({
      id: 'echo-1',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/adapters');
    expect(lastCall().init.method).toBe('POST');
    expect(sentBody()).toEqual({
      id: 'echo-1',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(result.adapter).toEqual(ADAPTER);
    expect(result.token).toBe('wm_deadbeef');
    expect(result.connectCmd).toContain('--token wm_deadbeef');
  });

  it('createAdapter omits `config` entirely when it was not given (exactOptionalPropertyTypes)', async () => {
    alwaysJson(201, { adapter: ADAPTER, token: 'wm_x', connectCmd: 'c' });
    await client().createAdapter({
      id: 'echo-1',
      kind: 'echo',
      displayName: 'Echo',
    });
    expect(Object.keys(sentBody() as object)).not.toContain('config');

    await client().createAdapter({
      id: 'echo-1',
      kind: 'echo',
      displayName: 'Echo',
      config: { a: 1 },
    });
    expect(sentBody()).toMatchObject({ config: { a: 1 } });
  });

  it('updateAdapter PATCHes only the fields given', async () => {
    alwaysJson(200, { adapter: { ...ADAPTER, enabled: false } });
    const adapter = await client().updateAdapter('echo-1', { enabled: false });
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/adapters/echo-1');
    expect(lastCall().init.method).toBe('PATCH');
    expect(sentBody()).toEqual({ enabled: false });
    expect(adapter.enabled).toBe(false);
  });

  it('deleteAdapter DELETEs and survives the 204 empty body', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    expect(await client().deleteAdapter('echo-1')).toEqual({
      deleted: 'echo-1',
    });
    expect(lastCall().init.method).toBe('DELETE');
  });

  it('rotateAdapterToken POSTs to /token and returns the new credential', async () => {
    alwaysJson(200, {
      adapter: ADAPTER,
      token: 'wm_newtoken',
      connectCmd: 'wemessage-adapter-echo --url ws://x --token wm_newtoken',
    });
    const result = await client().rotateAdapterToken('echo-1');
    expect(lastCall().url).toBe(
      'http://127.0.0.1:47100/v1/adapters/echo-1/token',
    );
    expect(lastCall().init.method).toBe('POST');
    expect(result.token).toBe('wm_newtoken');
    expect(result.connectCmd).toContain('--token wm_newtoken');
  });
});

describe('s5 client: adapter conflicts', () => {
  it('409 adapter-referenced surfaces as DaemonConflictError carrying ruleIds', async () => {
    alwaysJson(409, { error: 'adapter-referenced', ruleIds: ['r1', 'r2'] });
    const error = await client()
      .deleteAdapter('echo-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonConflictError);
    const conflict = error as DaemonConflictError;
    expect(conflict.statusCode).toBe(409);
    expect(conflict.detail.error).toBe('adapter-referenced');
    expect(conflict.detail.ruleIds).toEqual(['r1', 'r2']);
  });

  it('409 adapter-exists surfaces as DaemonConflictError too', async () => {
    alwaysJson(409, { error: 'adapter-exists', id: 'echo-1' });
    const error = await client()
      .createAdapter({ id: 'echo-1', kind: 'echo', displayName: 'Echo' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonConflictError);
    expect((error as DaemonConflictError).detail.error).toBe('adapter-exists');
  });
});

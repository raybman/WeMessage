/**
 * v2 A1 client: `listThreads`, and the one 503 that is not about auth.
 *
 * `GET /v1/threads` is a read with a cursor, so the wrapper's whole job is to
 * carry two optional parameters and hand the page back untouched. The part
 * worth a row of its own is the failure: the daemon answers 503 both when it
 * has no token (an auth state, `DaemonAuthError`, CLI exit 4) and when the
 * list's source is down while auth is fine. Mapped the old way, the second
 * would tell the operator to look at their token. So the body decides, and
 * only the exact `{error:'source-unavailable'}` is the second kind.
 *
 * `fetch` is stubbed; no daemon runs. Synthetic handles only (`+1555…`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonAuthError,
  DaemonRequestError,
  DaemonSourceUnavailableError,
  type ThreadsPage,
  type WeMessageClient,
} from '../src/index.js';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = 'wm_0123456789abcdef';
const BASE = 'http://127.0.0.1:47100';

const client = (): WeMessageClient =>
  createClient({ baseUrl: BASE, token: TOKEN });

function respond(status: number, body: string): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

const PAGE: ThreadsPage = {
  threads: [
    {
      chatGuid: 'any;-;+15550000201',
      channel: 'imessage',
      title: '+15550000201',
      isGroup: false,
      lastLine: 'see you at six',
      lastFromMe: false,
      lastAt: '2026-09-04T16:41:00.000Z',
    },
  ],
  nextCursor: 'MTIzLjQ1',
  total: 4000,
  asOf: '2026-09-04T23:42:00.000Z',
};

describe('v2 A1 client: listThreads', () => {
  it('GETs /v1/threads with the bearer and no query, and returns the page untouched', async () => {
    respond(200, JSON.stringify(PAGE));
    const page = await client().listThreads();

    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/v1/threads`);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(page).toEqual(PAGE);
  });

  it('carries limit and the cursor verbatim, and nothing else', async () => {
    respond(200, JSON.stringify(PAGE));
    await client().listThreads({ limit: 100, cursor: 'MTIzLjQ1' });

    const url = new URL(lastCall().url);
    expect(url.pathname).toBe('/v1/threads');
    expect([...url.searchParams.keys()].sort()).toEqual(['cursor', 'limit']);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('cursor')).toBe('MTIzLjQ1');
  });

  it('a source that is down is DaemonSourceUnavailableError, not an auth failure', async () => {
    respond(503, JSON.stringify({ error: 'source-unavailable' }));
    const err = await client()
      .listThreads()
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(DaemonSourceUnavailableError);
    expect(err).toBeInstanceOf(DaemonRequestError);
    expect(err).not.toBeInstanceOf(DaemonAuthError);
    expect((err as DaemonSourceUnavailableError).statusCode).toBe(503);
  });

  it('every other 503 keeps the auth mapping (no token, or a body it cannot read)', async () => {
    for (const body of [
      JSON.stringify({ error: 'no-auth-token' }),
      'not json',
      '',
    ]) {
      respond(503, body);
      const err = await client()
        .listThreads()
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err, body).toBeInstanceOf(DaemonAuthError);
      expect((err as DaemonAuthError).statusCode, body).toBe(503);
    }
  });

  it('a cursor the daemon did not mint is a 400 DaemonRequestError naming it', async () => {
    respond(400, JSON.stringify({ error: 'invalid-cursor' }));
    const err = await client()
      .listThreads({ cursor: 'forged' })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(DaemonRequestError);
    expect((err as DaemonRequestError).statusCode).toBe(400);
    expect(JSON.parse((err as DaemonRequestError).body)).toEqual({
      error: 'invalid-cursor',
    });
  });
});

/**
 * v2 A2 client: `readThread`, one page of one conversation.
 *
 * `GET /v1/threads/:guid/messages` takes a chat guid in the PATH, and real
 * guids carry `;`, `+` and, for groups, characters a URL would read as
 * structure. So the first job is to encode it, once, the way the daemon's
 * router decodes it. The second is to carry `limit`, `before` and `until`
 * and nothing else. The third is the failures: a chat the source has never
 * seen is a 404 that names itself, a source that is down is the same
 * `DaemonSourceUnavailableError` the list uses, and a cursor the daemon did
 * not mint stays a plain 400.
 *
 * `fetch` is stubbed; no daemon runs. Synthetic handles only (`+1555…`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonAuthError,
  DaemonRequestError,
  DaemonSourceUnavailableError,
  DaemonUnknownChatError,
  type ThreadMessagesPage,
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
const GUID = 'any;-;+15550000201';

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

async function failure(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

const PAGE: ThreadMessagesPage = {
  chatGuid: GUID,
  channel: 'imessage',
  turns: [
    {
      guid: 'msg-0001',
      from: 'them',
      kind: 'text',
      text: 'see you at six',
      at: '2026-09-04T16:41:00.000Z',
      handle: '+15550000201',
      attachments: 0,
    },
    {
      guid: 'msg-0002',
      from: 'me',
      kind: 'attachment-only',
      text: null,
      at: '2026-09-04T16:42:00.000Z',
      attachments: 2,
    },
  ],
  nextBefore: 'dC4xMjMuNDU',
  asOf: '2026-09-04T23:42:00.000Z',
};

describe('v2 A2 client: readThread', () => {
  it('GETs the encoded path with the bearer and no query, and returns the page untouched', async () => {
    respond(200, JSON.stringify(PAGE));
    const page = await client().readThread(GUID);

    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/v1/threads/${encodeURIComponent(GUID)}/messages`);
    expect(url).toContain('any%3B-%3B%2B15550000201');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(page).toEqual(PAGE);
  });

  it('a guid with a slash, a ? or a # stays one path segment', async () => {
    respond(200, JSON.stringify(PAGE));
    const odd = 'iMessage;+;chat/../x?y#z';
    await client().readThread(odd);

    const url = new URL(lastCall().url);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    const segments = url.pathname.split('/');
    expect(segments).toHaveLength(5);
    expect(decodeURIComponent(segments[3] ?? '')).toBe(odd);
  });

  it('carries limit and before verbatim, and nothing else', async () => {
    respond(200, JSON.stringify(PAGE));
    await client().readThread(GUID, { limit: 50, before: 'dC4xMjMuNDU' });

    const url = new URL(lastCall().url);
    expect([...url.searchParams.keys()].sort()).toEqual(['before', 'limit']);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('before')).toBe('dC4xMjMuNDU');
  });

  it('carries until verbatim', async () => {
    respond(200, JSON.stringify(PAGE));
    await client().readThread(GUID, { until: '2026-01-01T00:00:00.000Z' });

    const url = new URL(lastCall().url);
    expect([...url.searchParams.keys()]).toEqual(['until']);
    expect(url.searchParams.get('until')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a chat the source has never seen is DaemonUnknownChatError, a 404 request error', async () => {
    respond(404, JSON.stringify({ error: 'unknown-chat' }));
    const err = await failure(client().readThread(GUID));

    expect(err).toBeInstanceOf(DaemonUnknownChatError);
    expect(err).toBeInstanceOf(DaemonRequestError);
    expect((err as DaemonUnknownChatError).statusCode).toBe(404);
  });

  it('any other 404 (no route, no source) stays a plain DaemonRequestError', async () => {
    for (const body of [JSON.stringify({ error: 'not-found' }), 'nope', '']) {
      respond(404, body);
      const err = await failure(client().readThread(GUID));
      expect(err, body).toBeInstanceOf(DaemonRequestError);
      expect(err, body).not.toBeInstanceOf(DaemonUnknownChatError);
    }
  });

  it('a source that is down is DaemonSourceUnavailableError, not an auth failure', async () => {
    respond(503, JSON.stringify({ error: 'source-unavailable' }));
    const err = await failure(client().readThread(GUID));

    expect(err).toBeInstanceOf(DaemonSourceUnavailableError);
    expect(err).not.toBeInstanceOf(DaemonAuthError);
  });

  it('a cursor the daemon did not mint is a 400 naming it', async () => {
    respond(400, JSON.stringify({ error: 'invalid-cursor' }));
    const err = await failure(client().readThread(GUID, { before: 'forged' }));

    expect(err).toBeInstanceOf(DaemonRequestError);
    expect((err as DaemonRequestError).statusCode).toBe(400);
    expect(JSON.parse((err as DaemonRequestError).body)).toEqual({
      error: 'invalid-cursor',
    });
  });
});

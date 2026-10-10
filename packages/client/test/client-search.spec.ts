/**
 * v2 F2b client: `search`, one page of message search.
 *
 * The wrapper's job is the query string: lists as repeated keys, in one
 * fixed order, the zone always sent, and the page handed back untouched.
 * `fetch` is stubbed; no daemon runs. Synthetic handles only (`+1555...`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonRequestError,
  searchQueryString,
  type SearchPage,
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

const PAGE: SearchPage = {
  hits: [
    {
      guid: 'm-1',
      chatGuid: 'iMessage;-;+15550100001',
      title: '+15550100001',
      isGroup: false,
      channel: 'imessage',
      from: 'them',
      handle: '+15550100001',
      text: 'see you at the cabin',
      sentAt: '2026-09-01T08:00:00.000Z',
      hasAttachment: false,
    },
  ],
  total: 1,
  nextCursor: null,
  asOf: '2026-09-01T12:00:00.000Z',
  facets: {
    years: [{ year: 2026, count: 1 }],
    channels: [{ channel: 'imessage', count: 1 }],
    senders: [{ handle: '+15550100001', count: 1 }],
  },
  coverage: {
    channels: [
      {
        channel: 'imessage',
        state: 'searched',
        indexed: 1,
        eligible: 1,
        indexedThroughRowid: 1,
        mirrorAsOf: null,
      },
      { channel: 'whatsapp', state: 'not-searched', reason: 'no-source' },
      { channel: 'linkedin', state: 'not-searched', reason: 'no-source' },
      { channel: 'email', state: 'not-searched', reason: 'no-source' },
    ],
    tokens: [{ op: 'term', value: 'cabin', applied: 'applied' }],
    capped: false,
    deletedHidden: 0,
    deletionsChecked: true,
  },
};

describe('v2 F2b client: search', () => {
  it('GETs /v1/search with the bearer and returns the page untouched', async () => {
    respond(200, JSON.stringify(PAGE));
    const page = await client().search({
      terms: ['cabin'],
      tz: 'America/Los_Angeles',
    });
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/search?term=cabin&tz=America%2FLos_Angeles`);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(page).toEqual(PAGE);
  });

  it('writes every key in one order, lists as repeated keys', () => {
    const qs = searchQueryString({
      cursor: 'abc',
      limit: 20,
      tz: 'UTC',
      after: '2019-01-01T00:00:00.000Z',
      before: '2026-09-01T00:00:00.000Z',
      has: ['attachment', 'link'],
      channels: ['imessage', 'whatsapp'],
      in: 'Família Lake',
      from: 'me',
      terms: ['cabin', 'photos'],
    });
    expect([...new URLSearchParams(qs).keys()]).toEqual([
      'term',
      'term',
      'from',
      'in',
      'channel',
      'channel',
      'has',
      'has',
      'before',
      'after',
      'tz',
      'limit',
      'cursor',
    ]);
    expect(new URLSearchParams(qs).get('in')).toBe('Família Lake');
  });

  it('a 400 refusal rejects with DaemonRequestError', async () => {
    respond(400, JSON.stringify({ error: 'empty-search' }));
    await expect(client().search({ tz: 'UTC' })).rejects.toBeInstanceOf(
      DaemonRequestError,
    );
  });
});

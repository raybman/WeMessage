/**
 * s3-execution Scenario 10 (part 1) — `@wemessage/client`'s S3 additions:
 * `doctor()`, `send({to, body})`, `connect()`, `disconnect({purge})`, and
 * the new `DaemonGateDeniedError {reason}` (403 gate-denied stops being
 * conflated with `DaemonAuthError` — the daemon uses 403 EXCLUSIVELY for
 * gate denial, confirmed by grep of packages/daemon/src; 401/503 stay
 * auth-error paths, untouched).
 *
 * Pure unit tests: `createClient` builds every request over the platform
 * `fetch`, stubbed here with `vi.stubGlobal` — no real daemon, no real
 * network, matching this package's own "zero business logic, thin
 * transport" framing (nothing here could accidentally touch chat.db or
 * osascript regardless; test/arch.spec.ts gates (a)/(b) are moot for this
 * file, noted for completeness).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonAuthError,
  DaemonGateDeniedError,
  DaemonRequestError,
} from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () =>
  createClient({ baseUrl: 'http://127.0.0.1:47100', token: 'wm_test' });

describe('doctor()', () => {
  it('GETs /v1/doctor and returns the report verbatim', async () => {
    const report = {
      state: 'fully-connected',
      checks: [{ id: 'os', status: 'ok' }],
      probedAt: '2026-09-02T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, report));

    const result = await client().doctor();

    expect(result).toEqual(report);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47100/v1/doctor');
    expect(init.method).toBe('GET');
  });
});

describe('send({to, body})', () => {
  it('POSTs /v1/send with chatGuid built as iMessage;-;<to>', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        draftId: 'd1',
        outcome: 'sent',
        sentMessageGuid: 'g1',
      }),
    );

    const result = await client().send({ to: '+15551234567', body: 'hello' });

    expect(result).toEqual({
      draftId: 'd1',
      outcome: 'sent',
      sentMessageGuid: 'g1',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47100/v1/send');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      chatGuid: 'iMessage;-;+15551234567',
      body: 'hello',
    });
  });

  it('a 200 {outcome:"failed"} body resolves normally (not thrown) — a legitimate answer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        draftId: 'd2',
        outcome: 'failed',
        error: { code: 'no-conversation', message: 'no existing conversation' },
      }),
    );

    const result = await client().send({
      to: '+15559990000',
      body: 'first contact',
    });

    expect(result).toEqual({
      draftId: 'd2',
      outcome: 'failed',
      error: { code: 'no-conversation', message: 'no existing conversation' },
    });
  });

  it('403 {error:"gate-denied", reason} rejects with DaemonGateDeniedError{reason}, not DaemonAuthError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: 'gate-denied', reason: 'kill-switch' }),
    );

    await expect(
      client().send({
        to: '+15552223333',
        body: 'should never leave the gate',
      }),
    ).rejects.toMatchObject({
      name: 'DaemonGateDeniedError',
      reason: 'kill-switch',
      statusCode: 403,
    });
  });

  it('DaemonGateDeniedError is a DaemonRequestError (keeps statusCode in the existing error family)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: 'gate-denied', reason: 'read-only' }),
    );

    try {
      await client().send({ to: '+15554445555', body: 'x' });
      expect.unreachable('expected send() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonGateDeniedError);
      expect(error).toBeInstanceOf(DaemonRequestError);
    }
  });
});

describe('connect()', () => {
  it('POSTs /v1/connect with no body and returns the DoctorReport verbatim', async () => {
    const report = {
      state: 'fully-connected',
      checks: [],
      probedAt: '2026-09-02T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, report));

    const result = await client().connect();

    expect(result).toEqual(report);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47100/v1/connect');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});

describe('disconnect({purge})', () => {
  it('POSTs /v1/disconnect {purge:false} by default and returns the report unwrapped', async () => {
    const report = { state: 'disconnected', steps: [], manualRevocation: [] };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, report));

    const result = await client().disconnect();

    expect(result).toEqual(report);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ purge: false });
  });

  it('threads {purge:true} straight through', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        state: 'disconnected',
        steps: [],
        manualRevocation: [],
      }),
    );

    await client().disconnect({ purge: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ purge: true });
  });
});

describe('403 handling regression — non-gate-denied 403s and untouched 401/503', () => {
  it('a 403 with a body that is not {error:"gate-denied", reason} still falls back to DaemonAuthError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { error: 'something-else' }),
    );

    await expect(client().doctor()).rejects.toBeInstanceOf(DaemonAuthError);
  });

  it('401 still throws DaemonAuthError (untouched)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: 'unauthorized' }),
    );

    await expect(client().doctor()).rejects.toBeInstanceOf(DaemonAuthError);
  });

  it('503 (no-auth-token) still throws DaemonAuthError (untouched)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(503, { error: 'no-auth-token' }),
    );

    await expect(client().doctor()).rejects.toBeInstanceOf(DaemonAuthError);
  });
});

/**
 * s4-execution Scenario 11 (client half): the draft, contact and kill-switch
 * surface on `@wemessage/client`.
 *
 * Same posture as client-s3.spec.ts: pure unit tests over a stubbed `fetch`,
 * because this package is a thin transport (§2.5) and the interesting
 * question is only ever "did it build the right request and unwrap the right
 * field". Business behaviour is proven at the daemon.
 *
 * The one piece of real judgement here is `DaemonConflictError`. A 409 from
 * the draft surface always means "the draft is not in a state where you may
 * do that", and the body says which state it WAS. Flattening that into a
 * generic request error would leave the CLI unable to say anything more
 * useful than "request failed" for the single most common user mistake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonConflictError,
  DaemonRequestError,
} from '../src/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Response body can only be read once, so a test that calls the client
 * twice against one `mockResolvedValue` fails on the second call for a
 * reason that has nothing to do with the client. Mint a fresh Response per
 * call instead.
 */
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

const client = () =>
  createClient({ baseUrl: 'http://127.0.0.1:47100', token: 'wm_test' });

function lastCall(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init };
}

function sentBody(): unknown {
  return JSON.parse(String(lastCall().init.body));
}

describe('s4 client: drafts', () => {
  it('listDrafts unwraps the envelope and builds only the filters given', async () => {
    alwaysJson(200, { drafts: [{ id: 'd1' }] });

    expect(await client().listDrafts()).toEqual([{ id: 'd1' }]);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/drafts');

    await client().listDrafts({ state: 'expired', contact: '+15550000001' });
    // Omitted filters must be ABSENT, not empty: `?state=` is a different
    // request from no filter at all, and the daemon rejects the former.
    expect(lastCall().url).toBe(
      'http://127.0.0.1:47100/v1/drafts?state=expired&contact=%2B15550000001',
    );
  });

  it('getDraft returns the draft with its approval history', async () => {
    const detail = { draft: { id: 'd1' }, approvals: [{ id: 'a1' }] };
    fetchMock.mockResolvedValue(jsonResponse(200, detail));
    expect(await client().getDraft('d1')).toEqual(detail);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/drafts/d1');
  });

  it('createDraft posts the body and unwraps the draft', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { draft: { id: 'd2' } }));
    const draft = await client().createDraft({
      chatGuid: 'iMessage;-;+15551234567',
      body: 'hello',
      ttlMinutes: 30,
    });
    expect(draft).toEqual({ id: 'd2' });
    expect(sentBody()).toEqual({
      chatGuid: 'iMessage;-;+15551234567',
      body: 'hello',
      ttlMinutes: 30,
    });
  });

  it('approve/reject omit their optional fields rather than sending undefined', async () => {
    alwaysJson(200, { draft: { id: 'd1' }, approvalId: 'a1' });

    await client().approveDraft('d1');
    expect(sentBody()).toEqual({});
    await client().approveDraft('d1', { editedBody: 'reworded' });
    expect(sentBody()).toEqual({ editedBody: 'reworded' });

    await client().rejectDraft('d1');
    expect(sentBody()).toEqual({});
    await client().rejectDraft('d1', { reason: 'wrong tone' });
    expect(sentBody()).toEqual({ reason: 'wrong tone' });
  });

  it('recall, retry and redraft hit their own verbs', async () => {
    alwaysJson(200, { draft: { id: 'd1' }, approvalId: 'a1' });
    await client().recallDraft('d1');
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/drafts/d1/recall');
    await client().retryDraft('d1');
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/drafts/d1/retry');
    await client().redraftDraft('d1');
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/drafts/d1/redraft');
  });

  it('bulkDrafts passes the selector through verbatim', async () => {
    alwaysJson(200, { batchId: 'b1', matched: 2, applied: 2 });
    await client().bulkDrafts('approve', { filter: { all: true } });
    expect(sentBody()).toEqual({ action: 'approve', filter: { all: true } });

    await client().bulkDrafts('recall', { ids: ['d1', 'd2'] });
    expect(sentBody()).toEqual({ action: 'recall', ids: ['d1', 'd2'] });
  });

  it('batchReport reads the report endpoint', async () => {
    alwaysJson(200, { batchId: 'b1', sent: 4, failed: 1 });
    expect(await client().batchReport('b1')).toMatchObject({ sent: 4 });
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/batches/b1');
  });
});

describe('s4 client: 409 handling', () => {
  it('surfaces an illegal transition as DaemonConflictError with the shape intact', async () => {
    alwaysJson(409, {
      error: 'illegal-transition',
      from: 'sent',
      requested: 'approve',
    });
    const err = await client()
      .approveDraft('d1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonConflictError);
    const conflict = err as DaemonConflictError;
    expect(conflict.statusCode).toBe(409);
    expect(conflict.detail).toEqual({
      error: 'illegal-transition',
      from: 'sent',
      requested: 'approve',
    });
    // It is still a request error, so nothing that only knows the base class
    // starts leaking a raw rejection.
    expect(err).toBeInstanceOf(DaemonRequestError);
  });

  it('carries the retry-limit attempt count', async () => {
    alwaysJson(409, { error: 'retry-limit', attempts: 3 });
    const err = (await client()
      .retryDraft('d1')
      .catch((e: unknown) => e)) as DaemonConflictError;
    expect(err.detail).toEqual({ error: 'retry-limit', attempts: 3 });
  });

  it('a 409 with an unrecognizable body stays a plain request error', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('gateway soup', { status: 409 })),
    );
    const err = await client()
      .recallDraft('d1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonRequestError);
    expect(err).not.toBeInstanceOf(DaemonConflictError);
  });
});

describe('s4 client: kill switch and contacts', () => {
  it('setKillSwitch posts the boolean', async () => {
    alwaysJson(200, {
      key: 'send.killSwitch',
      on: true,
      version: 2,
      cancelled: [],
    });
    const res = await client().setKillSwitch(true);
    expect(res.on).toBe(true);
    expect(lastCall().url).toBe(
      'http://127.0.0.1:47100/v1/toggles/kill-switch',
    );
    expect(sentBody()).toEqual({ on: true });
  });

  it('contact CRUD encodes the handle and unwraps the envelopes', async () => {
    alwaysJson(200, { contacts: [{ handle: '+15550000007' }] });
    expect(await client().listContacts()).toEqual([{ handle: '+15550000007' }]);

    alwaysJson(200, { contact: { handle: '+15550000007', mode: 'auto' } });
    const contact = await client().setContactPolicy('+15550000007', 'auto');
    expect(contact).toEqual({ handle: '+15550000007', mode: 'auto' });
    // The '+' must survive as %2B or it becomes a space in the path.
    expect(lastCall().url).toBe(
      'http://127.0.0.1:47100/v1/contacts/%2B15550000007',
    );
    expect(lastCall().init.method).toBe('PUT');
    expect(sentBody()).toEqual({ mode: 'auto' });

    alwaysJson(200, { deleted: '+15550000007' });
    expect(await client().deleteContactPolicy('+15550000007')).toEqual({
      deleted: '+15550000007',
    });
    expect(lastCall().init.method).toBe('DELETE');
  });
});

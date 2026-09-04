/**
 * s6-execution Scenario 12 (client half) — the S6 operator surface on
 * `@wemessage/client`: `/v1/schedules` CRUD, `pause`/`resume` and
 * `setGlobalMode`, plus the two `StatusPayload` fields that stopped being
 * F-5 placeholders in Scenario 11.
 *
 * Same posture as client-s3/client-s4/client-s5: pure unit tests over a
 * stubbed `fetch`, because this package is a thin transport (§2.5) and the
 * only question worth asking here is "did it build the right request and
 * unwrap the right field". Schedule and arming BEHAVIOUR is proven at the
 * daemon (schedules-routes.spec.ts, arming.spec.ts).
 *
 * Three pieces of real judgement:
 *
 *  - **One method, one call.** Scenario 12 row 8 says no CLI verb may arm
 *    anything the API cannot, and the CLI reaches the daemon only through
 *    this file. So every method here is asserted to issue EXACTLY ONE
 *    fetch: a client method that quietly did a read-then-write would give
 *    the CLI a composite verb the HTTP surface does not have. The one
 *    composition Scenario 12 allows (`wemessage resume`) is deliberately
 *    NOT built here — it lives in the CLI, out of three named calls, where
 *    it is visible.
 *  - **`resume()` is `pause(null)` on the wire and a different word to a
 *    human.** The daemon spells resume as a value rather than a route
 *    (toggles.ts: "`null` is RESUME") to keep the ratchet honest; the
 *    client keeps that shape and adds the vocabulary, so no caller has to
 *    know that clearing a hold is spelled as setting one.
 *  - **The route's refusals keep their shape.** `rest-of-window` against an
 *    unarmed daemon is a 409 carrying `not-armed`, and an unparseable
 *    instant is a 400 carrying `invalid-until`. Both are things an operator
 *    can act on, so neither is allowed to flatten into "request failed":
 *    the 409 keeps arriving as `DaemonConflictError`, and the 400 keeps its
 *    body readable on the error itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClient,
  DaemonConflictError,
  DaemonRequestError,
  type SchedulePayload,
  type StatusPayload,
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

const SCHEDULE: SchedulePayload = {
  id: '01JBUSINESSHOURS0000000000',
  name: 'Business hours',
  timezone: 'America/Los_Angeles',
  windows: [
    { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' },
  ],
  enabled: true,
};

describe('schedules CRUD (§1.6 routes, ratchet #19)', () => {
  it('listSchedules GETs /v1/schedules and returns the bare array', async () => {
    alwaysJson(200, [SCHEDULE]);
    const out = await client().listSchedules();
    expect(out).toEqual([SCHEDULE]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/schedules');
    expect(lastCall().init.method).toBe('GET');
  });

  it('getSchedule GETs the id path and percent-encodes it', async () => {
    alwaysJson(200, SCHEDULE);
    const out = await client().getSchedule('a/b');
    expect(out).toEqual(SCHEDULE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/schedules/a%2Fb');
  });

  it('createSchedule POSTs the input and unwraps the 201 {schedule}', async () => {
    alwaysJson(201, { schedule: SCHEDULE });
    const out = await client().createSchedule({
      name: SCHEDULE.name,
      timezone: SCHEDULE.timezone,
      windows: SCHEDULE.windows,
    });
    expect(out).toEqual(SCHEDULE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().init.method).toBe('POST');
    // `enabled` is the route's own default (§2.3 DDL default 1); the client
    // does not invent it, so an omitted flag stays omitted on the wire.
    expect(sentBody()).toEqual({
      name: SCHEDULE.name,
      timezone: SCHEDULE.timezone,
      windows: SCHEDULE.windows,
    });
  });

  it('createSchedule sends `enabled` only when the caller asked for it', async () => {
    alwaysJson(201, { schedule: { ...SCHEDULE, enabled: false } });
    await client().createSchedule({
      name: SCHEDULE.name,
      timezone: SCHEDULE.timezone,
      windows: SCHEDULE.windows,
      enabled: false,
    });
    expect(sentBody()).toMatchObject({ enabled: false });
  });

  it('updateSchedule PATCHes and unwraps {schedule}', async () => {
    const renamed = { ...SCHEDULE, name: 'Evenings' };
    alwaysJson(200, { schedule: renamed });
    const out = await client().updateSchedule(SCHEDULE.id, {
      name: 'Evenings',
    });
    expect(out).toEqual(renamed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().init.method).toBe('PATCH');
    expect(sentBody()).toEqual({ name: 'Evenings' });
  });

  it('deleteSchedule DELETEs and resolves {deleted} from the 204', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const out = await client().deleteSchedule(SCHEDULE.id);
    expect(out).toEqual({ deleted: SCHEDULE.id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().init.method).toBe('DELETE');
  });

  it('an invalid zone stays readable ON the error, not just inside its message', async () => {
    alwaysJson(400, { error: 'invalid-timezone' });
    const err = await client()
      .createSchedule({
        name: 'Nope',
        timezone: 'Mars/Olympus_Mons',
        windows: SCHEDULE.windows,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonRequestError);
    const request = err as DaemonRequestError;
    expect(request.statusCode).toBe(400);
    // The CLI has to say WHICH zone was refused (Scenario 12 row 2), and it
    // can only do that if the typed body survives the throw.
    expect(JSON.parse(request.body)).toEqual({ error: 'invalid-timezone' });
  });

  it('a schedule still referenced by rules stays a typed 409', async () => {
    alwaysJson(409, { error: 'schedule-in-use', detail: { rules: 2 } });
    const err = await client()
      .deleteSchedule(SCHEDULE.id)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonConflictError);
    expect((err as DaemonConflictError).detail.error).toBe('schedule-in-use');
  });
});

describe('arming controls (§1.6 routes, ratchet #20)', () => {
  const ARMED: StatusPayload['armed'] = {
    armed: false,
    until: '2026-09-03T18:00:00.000Z',
    reason: 'paused',
  };

  it('pause POSTs the shorthand verbatim — the daemon owns the calendar', async () => {
    alwaysJson(200, { key: 'pause', until: ARMED.until, armed: ARMED });
    const out = await client().pause('1h');
    expect(out).toEqual({ key: 'pause', until: ARMED.until, armed: ARMED });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/toggles/pause');
    // Not resolved client-side: `until-tomorrow` is the DAEMON HOST's next
    // 08:00, and a client computing it would be guessing at somebody else's
    // clock (toggles.ts resolveDeadline).
    expect(sentBody()).toEqual({ until: '1h' });
  });

  it('resume is the same route with a null value, and says so on the wire', async () => {
    alwaysJson(200, {
      key: 'pause',
      until: null,
      armed: { armed: true, until: null, reason: 'armed' },
    });
    const out = await client().resume();
    expect(out.until).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().url).toBe('http://127.0.0.1:47100/v1/toggles/pause');
    expect(sentBody()).toEqual({ until: null });
  });

  it('rest-of-window against an unarmed daemon is a typed 409, not a 400', async () => {
    alwaysJson(409, { error: 'not-armed' });
    const err = await client()
      .pause('rest-of-window')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonConflictError);
    expect((err as DaemonConflictError).detail.error).toBe('not-armed');
  });

  it('setGlobalMode POSTs the mode and returns the daemon posture with it', async () => {
    alwaysJson(200, {
      key: 'send.globalMode',
      mode: 'auto',
      armed: { armed: true, until: null, reason: 'armed' },
    });
    const out = await client().setGlobalMode('auto');
    expect(out.mode).toBe('auto');
    expect(out.armed.reason).toBe('armed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall().url).toBe(
      'http://127.0.0.1:47100/v1/toggles/global-mode',
    );
    expect(sentBody()).toEqual({ mode: 'auto' });
  });
});

describe('StatusPayload carries the S6 fields (Sc 11) the CLI renders (Sc 12)', () => {
  it('armed and killSwitch survive the round trip with their real shapes', async () => {
    const payload: StatusPayload = {
      connectionState: 'fully-connected',
      cursor: null,
      counts: { messagesToday: 0 },
      adapters: [],
      killSwitch: false,
      armed: {
        armed: true,
        until: '2026-09-03T17:00:00.000Z',
        reason: 'armed',
      },
    };
    alwaysJson(200, payload);
    const out = await client().status();
    expect(out.killSwitch).toBe(false);
    expect(out.armed).toEqual(payload.armed);
  });

  it('a store-less daemon still reports null for both, and that is not `false`', async () => {
    alwaysJson(200, {
      connectionState: 'disconnected',
      cursor: null,
      counts: { messagesToday: 0 },
      adapters: [],
      killSwitch: null,
      armed: null,
    });
    const out = await client().status();
    expect(out.killSwitch).toBeNull();
    expect(out.armed).toBeNull();
  });
});

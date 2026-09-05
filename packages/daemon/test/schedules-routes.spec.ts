/**
 * s6 Scenario 3 (route half) — `/v1/schedules` CRUD, and the two rules-route
 * guards this slice is finally allowed to change.
 * Spec: docs/plans/slices/s6-execution.md Part 2 Scenario 3 RED rows 5-10;
 * §1.6 route + HTTP-semantics enumeration; C-7; F-69; F-75.
 *
 * Covered here:
 *  - POST 201 with a minted ULID, `schedule.created` carrying the FULL
 *    snapshot (the `rule.created` precedent), and the response echoing
 *    NORMALISED windows (days deduped and in week order — the stored form is
 *    canonical so two spellings of the same week cannot round-trip apart);
 *  - 400 {error:'invalid-timezone'} for a zone this runtime cannot project
 *    into, 400 {error:'invalid-window'} for a malformed HH:MM or an empty
 *    days[], and NEITHER writes an audit row or a schedule;
 *  - PATCH partial update audits `schedule.updated` with the POST-image;
 *    DELETE audits `schedule.deleted`; DELETE of a referenced schedule is
 *    409 {error:'schedule-in-use', detail:{rules:N}} raised BEFORE the FK
 *    can fire (F-75), and the schedule is still there afterwards;
 *  - C-7 retired: `POST /v1/rules {scheduleId:<real>}` is now 201. The guard
 *    NARROWS rather than disappearing — an id that names no schedule still
 *    400s with the same {code:'schedule-not-found'};
 *  - F-69: `outsideWindow:'queue'` is refused at the edge on both POST and
 *    PATCH with 400 {error:'unsupported-outside-window', detail:{mode:'queue'}}.
 *    The §3.2 union still carries all three literals; the running system is
 *    what declines, not the type;
 *  - ratchet #19 math: +7 ROUTE_TABLE entries (53 -> 60), five routes plus
 *    the two auto-HEAD twins fastify mints for the GETs.
 *
 * Timezones are drawn from the five pinned by `test/arch.spec.ts` row (f);
 * handles and names are synthetic (public repo).
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Clock, Rule, Schedule } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';
import { buildServer, type DaemonServer } from '@wemessage/daemon';
import { ROUTE_TABLE } from './transport-surface.snapshot.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T0 = '2026-09-04T12:00:00.000Z';
const LOS_ANGELES = 'America/Los_Angeles';
const KOLKATA = 'Asia/Kolkata';

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-schedules-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.app.close();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
});

interface ClockCtl {
  clock: Clock;
  advance(ms: number): void;
}

function fakeClock(startIso = T0): ClockCtl {
  let now = new Date(startIso).getTime();
  return {
    clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
    advance(ms: number) {
      now += ms;
    },
  };
}

interface Harness {
  server: DaemonServer;
  store: SqliteStore;
  clockCtl: ClockCtl;
  headers: { authorization: string };
}

async function boot(): Promise<Harness> {
  const dir = tempDir();
  const clockCtl = fakeClock();
  const store = openStore({ dir, clock: clockCtl.clock });
  stores.push(store);
  const server = await buildServer({
    configDir: dir,
    rules: { store, clock: clockCtl.clock },
  });
  servers.push(server);
  if (server.token === null) throw new Error('harness: no token');
  return {
    server,
    store,
    clockCtl,
    headers: { authorization: `Bearer ${server.token}` },
  };
}

function scheduleBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'front desk hours',
    timezone: LOS_ANGELES,
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '09:00',
        end: '17:00',
      },
    ],
    ...overrides,
  };
}

async function createSchedule(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Schedule> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/schedules',
    headers: h.headers,
    payload: scheduleBody(overrides),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { schedule: Schedule }).schedule;
}

function ruleBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'VIP keyword',
    matcher: { kind: 'keyword', keywords: ['pool'], mode: 'any' },
    adapterId: 'concierge',
    ...overrides,
  };
}

interface ParsedAudit {
  event: { type: string } & Record<string, unknown>;
  actorJson: string;
}

function auditTrail(store: SqliteStore): ParsedAudit[] {
  return store.readAuditRows(0, 1000).map((row) => ({
    event: JSON.parse(row.eventJson) as ParsedAudit['event'],
    actorJson: row.actorJson,
  }));
}

// ---------------------------------------------------------------------------
// RED row 5 — create
// ---------------------------------------------------------------------------

describe('POST /v1/schedules (§1.6, s6 Scenario 3)', () => {
  it('mints a ULID, persists, audits schedule.created with the full snapshot', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: h.headers,
      payload: scheduleBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { schedule: Schedule };
    expect(body.schedule.id).toMatch(ULID_RE);
    expect(body.schedule.name).toBe('front desk hours');
    expect(body.schedule.timezone).toBe(LOS_ANGELES);
    // §2.3 DDL default: enabled 1 when the field is omitted.
    expect(body.schedule.enabled).toBe(true);
    expect(h.store.getSchedule(body.schedule.id)).toStrictEqual(body.schedule);

    const trail = auditTrail(h.store);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.event).toStrictEqual({
      type: 'schedule.created',
      scheduleId: body.schedule.id,
      schedule: JSON.parse(JSON.stringify(body.schedule)) as Schedule,
    });
    expect(JSON.parse(trail[0]!.actorJson)).toStrictEqual({
      kind: 'human',
      via: 'api',
    });
  });

  it('echoes NORMALISED windows: days deduped, in week order, stored canonically', async () => {
    const h = await boot();
    const created = await createSchedule(h, {
      windows: [
        // Same week, spelled three ways a human might type it.
        { days: ['fri', 'mon', 'mon'], start: '09:00', end: '17:00' },
        { days: ['sun', 'sat'], start: '22:00', end: '02:00' },
      ],
    });
    expect(created.windows).toStrictEqual([
      { days: ['mon', 'fri'], start: '09:00', end: '17:00' },
      { days: ['sat', 'sun'], start: '22:00', end: '02:00' },
    ]);
    // The canonical form is what is STORED, not just what is echoed: two
    // spellings of one week must not round-trip apart.
    expect(h.store.getSchedule(created.id)?.windows).toStrictEqual(
      created.windows,
    );
  });

  it('accepts enabled:false and a wrapping window', async () => {
    const h = await boot();
    const created = await createSchedule(h, {
      enabled: false,
      timezone: KOLKATA,
      windows: [{ days: ['fri'], start: '22:00', end: '02:00' }],
    });
    expect(created.enabled).toBe(false);
    expect(created.timezone).toBe(KOLKATA);
    expect(h.store.getSchedule(created.id)).toStrictEqual(created);
  });
});

// ---------------------------------------------------------------------------
// RED row 6 — validation
// ---------------------------------------------------------------------------

describe('schedule validation 400s (§1.6 HTTP semantics)', () => {
  it('rejects an unknown IANA zone with invalid-timezone and writes nothing', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/schedules',
      headers: h.headers,
      // Deliberately not a real region: `test/arch.spec.ts` row (f) pins the
      // five zones any fixture may name, and a probe must not smuggle a
      // sixth past it.
      payload: scheduleBody({ timezone: 'Not/AZone' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid-timezone' });
    expect(auditTrail(h.store)).toHaveLength(0);
    expect(h.store.listSchedules()).toHaveLength(0);
  });

  it('rejects malformed HH:MM and empty days[] with invalid-window and writes nothing', async () => {
    const h = await boot();
    const bad: Array<Record<string, unknown>> = [
      { windows: [{ days: ['mon'], start: '9:00', end: '17:00' }] },
      { windows: [{ days: ['mon'], start: '09:00', end: '25:00' }] },
      { windows: [{ days: ['mon'], start: '09:00', end: '17:60' }] },
      { windows: [{ days: [], start: '09:00', end: '17:00' }] },
      // Second window bad, first fine: the whole write is refused.
      {
        windows: [
          { days: ['mon'], start: '09:00', end: '17:00' },
          { days: ['tue'], start: 'noon', end: '17:00' },
        ],
      },
    ];
    for (const payload of bad) {
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/schedules',
        headers: h.headers,
        payload: scheduleBody(payload),
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid-window' });
    }
    expect(auditTrail(h.store)).toHaveLength(0);
    expect(h.store.listSchedules()).toHaveLength(0);
  });

  it('a PATCH that fails validation leaves the stored schedule untouched', async () => {
    const h = await boot();
    const created = await createSchedule(h);
    const res = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/schedules/${created.id}`,
      headers: h.headers,
      payload: { timezone: 'Not/AZone' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid-timezone' });
    expect(h.store.getSchedule(created.id)).toStrictEqual(created);
    // Only the create row: a refused write audits nothing.
    expect(auditTrail(h.store)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// RED row 7 — read, patch, delete, and the in-use 409
// ---------------------------------------------------------------------------

describe('GET/PATCH/DELETE /v1/schedules (§1.6, F-75)', () => {
  it('lists and shows; unknown id is 404', async () => {
    const h = await boot();
    const a = await createSchedule(h, { name: 'a' });
    const b = await createSchedule(h, { name: 'b' });

    const list = await h.server.app.inject({
      method: 'GET',
      url: '/v1/schedules',
      headers: h.headers,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as Schedule[]).map((s) => s.id).sort()).toStrictEqual(
      [a.id, b.id].sort(),
    );

    const show = await h.server.app.inject({
      method: 'GET',
      url: `/v1/schedules/${a.id}`,
      headers: h.headers,
    });
    expect(show.statusCode).toBe(200);
    expect(show.json()).toStrictEqual(a);

    const missing = await h.server.app.inject({
      method: 'GET',
      url: '/v1/schedules/01SCHEDGHOST0000000000000A',
      headers: h.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toStrictEqual({ error: 'not-found' });
  });

  it('PATCH is partial and audits schedule.updated with the post-image', async () => {
    const h = await boot();
    const created = await createSchedule(h);
    const res = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/schedules/${created.id}`,
      headers: h.headers,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const updated = (res.json() as { schedule: Schedule }).schedule;
    expect(updated).toStrictEqual({ ...created, enabled: false });
    expect(h.store.getSchedule(created.id)).toStrictEqual(updated);

    const trail = auditTrail(h.store);
    expect(trail.map((t) => t.event.type)).toStrictEqual([
      'schedule.created',
      'schedule.updated',
    ]);
    expect(trail[1]?.event).toStrictEqual({
      type: 'schedule.updated',
      scheduleId: created.id,
      // The POST-image, so the chain alone can reconstruct what the schedule
      // became — the rule.updated precedent.
      schedule: JSON.parse(JSON.stringify(updated)) as Schedule,
    });

    const missing = await h.server.app.inject({
      method: 'PATCH',
      url: '/v1/schedules/01SCHEDGHOST0000000000000A',
      headers: h.headers,
      payload: { enabled: false },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE removes the row and audits schedule.deleted', async () => {
    const h = await boot();
    const created = await createSchedule(h);
    const res = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/schedules/${created.id}`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(h.store.getSchedule(created.id)).toBeNull();
    expect(auditTrail(h.store).map((t) => t.event.type)).toStrictEqual([
      'schedule.created',
      'schedule.deleted',
    ]);

    const missing = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/schedules/${created.id}`,
      headers: h.headers,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE of a referenced schedule is 409 schedule-in-use, ahead of the FK', async () => {
    const h = await boot();
    const created = await createSchedule(h);
    const ruleRes = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody({ scheduleId: created.id }),
    });
    expect(ruleRes.statusCode).toBe(201);

    const res = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/schedules/${created.id}`,
      headers: h.headers,
    });
    // F-75: the route counts referencing rules FIRST. Letting the FK fire
    // would surface as an opaque 500 that tells the operator neither what is
    // wrong nor how much of it there is.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toStrictEqual({
      error: 'schedule-in-use',
      detail: { rules: 1 },
    });
    // The refusal changed nothing.
    expect(h.store.getSchedule(created.id)).toStrictEqual(created);
    expect(
      auditTrail(h.store).filter((t) => t.event.type === 'schedule.deleted'),
    ).toHaveLength(0);
  });

  it('counts DISABLED referencing rules in the 409 detail too', async () => {
    const h = await boot();
    const created = await createSchedule(h);
    for (const enabled of [true, false]) {
      const r = await h.server.app.inject({
        method: 'POST',
        url: '/v1/rules',
        headers: h.headers,
        payload: ruleBody({ scheduleId: created.id, enabled }),
      });
      expect(r.statusCode).toBe(201);
    }
    const res = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/schedules/${created.id}`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toStrictEqual({
      error: 'schedule-in-use',
      detail: { rules: 2 },
    });
  });

  it('requires the operator bearer on every schedules route', async () => {
    const h = await boot();
    const created = await createSchedule(h);
    const routes: Array<{
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: string;
    }> = [
      { method: 'GET', url: '/v1/schedules' },
      { method: 'POST', url: '/v1/schedules' },
      { method: 'GET', url: `/v1/schedules/${created.id}` },
      { method: 'PATCH', url: `/v1/schedules/${created.id}` },
      { method: 'DELETE', url: `/v1/schedules/${created.id}` },
    ];
    for (const route of routes) {
      const res = await h.server.app.inject({
        method: route.method,
        url: route.url,
        // s7 Sc1, exactOptionalPropertyTypes: `payload: undefined` is not
        // the same thing as no payload at all, and `InjectOptions` only
        // accepts the latter. Conditional spread, not an undefined value.
        ...(route.method === 'GET' ? {} : { payload: {} }),
      });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// RED row 8 — C-7 retired: rules.scheduleId is accepted
// ---------------------------------------------------------------------------

describe('rules.scheduleId is unblocked (C-7 retired, s6 Scenario 3)', () => {
  it('POST /v1/rules with a REAL scheduleId is 201 and persists the link', async () => {
    const h = await boot();
    const schedule = await createSchedule(h);
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody({ scheduleId: schedule.id }),
    });
    expect(res.statusCode).toBe(201);
    const rule = (res.json() as { rule: Rule }).rule;
    expect(rule.scheduleId).toBe(schedule.id);
    expect(h.store.getRule(rule.id)?.scheduleId).toBe(schedule.id);
    expect(h.store.countRulesUsingSchedule(schedule.id)).toBe(1);
  });

  it('PATCH /v1/rules/:id can attach and detach a schedule', async () => {
    const h = await boot();
    const schedule = await createSchedule(h);
    const created = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody(),
    });
    const ruleId = (created.json() as { rule: Rule }).rule.id;

    const attach = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${ruleId}`,
      headers: h.headers,
      payload: { scheduleId: schedule.id },
    });
    expect(attach.statusCode).toBe(200);
    expect((attach.json() as { rule: Rule }).rule.scheduleId).toBe(schedule.id);

    const detach = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${ruleId}`,
      headers: h.headers,
      payload: { scheduleId: null },
    });
    expect(detach.statusCode).toBe(200);
    expect((detach.json() as { rule: Rule }).rule.scheduleId).toBeNull();
    expect(h.store.countRulesUsingSchedule(schedule.id)).toBe(0);
  });

  it('the guard NARROWS, it does not disappear: an unknown id still 400s schedule-not-found', async () => {
    const h = await boot();
    const post = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody({ scheduleId: '01SCHEDGHOST0000000000000A' }),
    });
    expect(post.statusCode).toBe(400);
    expect(post.json()).toMatchObject({
      error: 'invalid-rule',
      detail: { code: 'schedule-not-found' },
    });

    const created = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody(),
    });
    const ruleId = (created.json() as { rule: Rule }).rule.id;
    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${ruleId}`,
      headers: h.headers,
      payload: { scheduleId: '01SCHEDGHOST0000000000000A' },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toMatchObject({
      error: 'invalid-rule',
      detail: { code: 'schedule-not-found' },
    });
    expect(h.store.getRule(ruleId)?.scheduleId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RED row 9 — F-69: outsideWindow 'queue' refused at the edge
// ---------------------------------------------------------------------------

describe("outsideWindow:'queue' is unsupported in v1 (F-69)", () => {
  it('POST /v1/rules rejects queue with unsupported-outside-window', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody({ outsideWindow: 'queue' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toStrictEqual({
      error: 'unsupported-outside-window',
      detail: { mode: 'queue' },
    });
    expect(h.store.listRules()).toHaveLength(0);
    expect(auditTrail(h.store)).toHaveLength(0);
  });

  it('PATCH /v1/rules/:id rejects queue and leaves the rule untouched', async () => {
    const h = await boot();
    const created = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: ruleBody(),
    });
    const rule = (created.json() as { rule: Rule }).rule;
    const res = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { outsideWindow: 'queue' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toStrictEqual({
      error: 'unsupported-outside-window',
      detail: { mode: 'queue' },
    });
    expect(h.store.getRule(rule.id)).toStrictEqual(rule);
  });

  it('the other two modes still round-trip: the TYPE is not narrowed, the system declines', async () => {
    const h = await boot();
    for (const mode of ['draft-only', 'ignore'] as const) {
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/rules',
        headers: h.headers,
        payload: ruleBody({ outsideWindow: mode }),
      });
      expect(res.statusCode, mode).toBe(201);
      expect((res.json() as { rule: Rule }).rule.outsideWindow).toBe(mode);
    }
  });
});

// ---------------------------------------------------------------------------
// RED row 10 — ratchet #19 math
// ---------------------------------------------------------------------------

describe('ratchet #19: the schedules surface is +7 entries (53 -> 60)', () => {
  it('adds exactly five routes and the two auto-HEAD twins fastify mints for GETs', async () => {
    const h = await boot();
    const live = h.server.routes.filter((r) => r.includes('/v1/schedules'));
    expect([...live].sort()).toStrictEqual([
      'DELETE /v1/schedules/:id',
      'GET /v1/schedules',
      'GET /v1/schedules/:id',
      'HEAD /v1/schedules',
      'HEAD /v1/schedules/:id',
      'PATCH /v1/schedules/:id',
      'POST /v1/schedules',
    ]);
    // Five routes; only the two GETs get a HEAD twin (POST/PATCH/DELETE
    // never do) => +7. The pinned table moved 53 -> 60 in the same commit.
    //
    // s6 Scenario 11's ratchet #20 then took it to 62 with two POSTs of its
    // own, so the whole-table length is no longer asserted here. That number
    // is a fact about every slice at once — owned by
    // transport-surface.ratchet.spec.ts, which derives it from the live app,
    // and re-pinned by each scenario that moves it — and keeping a copy in a
    // Scenario 3 file only meant this row failed for reasons that had
    // nothing to do with schedules. What this row owns is the +7, and both
    // halves of it are still asserted exactly.
    expect(live).toHaveLength(7);
    expect(ROUTE_TABLE.filter((r) => r.includes('/v1/schedules'))).toHaveLength(
      7,
    );
  });
});

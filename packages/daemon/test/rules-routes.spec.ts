/**
 * Scenario 7 — daemon rule CRUD + rules test routes (§1.6 routes 1-6).
 * s2-execution Part 2 Scenario 7 RED list:
 *  - create mints ulid + Clock timestamps; list/show/patch/delete round-trip;
 *    PATCH partial semantics + updatedAt bump; 404 {error:'not-found'};
 *  - validation 400s: unknown matcher kind, theme anywhere in the tree
 *    ({error:'theme-unavailable-v1'}, §1.4.1 #6), unsafe regex (F-11 typed
 *    reason in detail — taxonomy as landed in Scenario 2), empty combinator,
 *    missing/non-string adapterId; any NON-EMPTY adapterId accepted with the
 *    adapterKnown:false advisory (F-14; adapters land S5);
 *  - auth posture inherited per route: no bearer → 401; no token file → 503
 *    (fail-closed §2.4.2 unchanged by new routes);
 *  - CRUD audit: create/update/delete/enable/disable append exactly one row
 *    each with actor {kind:'human',via:'api'} (§1.8); POST /v1/rules/:id/test
 *    appends ZERO rows and emits ZERO WS events (read-only teeth);
 *  - /test verdicts: keyword hit/miss, handle → contact matcher, kind/isGroup
 *    exercising §1.7 eligibility (hasDraftForMessage stubbed false until S4).
 *
 * Defaults for omitted create-body fields are the §2.3 rules-DDL defaults
 * (enabled 1, respond_mode 'draft-only', outside_window 'draft-only',
 * allow_group_drafts 0, draft_ttl_minutes 240, priority 100) — cited, not
 * invented. A scheduleId that names no schedule is rejected with a typed 400
 * rather than being let through to the rules.schedule_id FOREIGN KEY, which
 * would surface as an opaque 500.
 *
 * REVISED in s6 Scenario 3 (C-7 retired): this file used to say EVERY
 * non-null scheduleId was rejected, because schedules had no route surface.
 * They do now (`/v1/schedules`), so the guard narrowed to unknown ids and
 * the row below asserts exactly that narrower claim. The assertion itself is
 * unchanged — the ULID it sends still names nothing — only the reasoning
 * moved. Attaching a REAL schedule is covered in schedules-routes.spec.ts.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Clock, Rule } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';
import { buildServer, startServer, type DaemonServer } from '@wemessage/daemon';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T0 = '2026-09-01T12:00:00.000Z';

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-rules-'));
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
    clock: {
      now: () => new Date(now).toISOString(),
      nowMs: () => now,
    },
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

/** Minimal valid create body (keyword matcher). */
function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'VIP keyword',
    matcher: { kind: 'keyword', keywords: ['pool'], mode: 'any' },
    adapterId: 'concierge',
    ...overrides,
  };
}

async function createRule(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<Rule> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/rules',
    headers: h.headers,
    payload: createBody(overrides),
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { rule: Rule }).rule;
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

describe('POST /v1/rules (create, §1.6 route 2)', () => {
  it('mints ulid + Clock timestamps, persists, audits rule.created, F-14 advisory', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: createBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { rule: Rule; adapterKnown: boolean };
    expect(body.adapterKnown).toBe(false); // F-14: advisory, not rejection
    expect(body.rule.id).toMatch(ULID_RE);
    expect(body.rule.createdAt).toBe(T0);
    expect(body.rule.updatedAt).toBe(T0);
    // omitted fields take the §2.3 DDL defaults
    expect(body.rule.enabled).toBe(true);
    expect(body.rule.respondMode).toBe('draft-only');
    expect(body.rule.scheduleId).toBeNull();
    expect(body.rule.outsideWindow).toBe('draft-only');
    expect(body.rule.allowGroupDrafts).toBe(false);
    expect(body.rule.matchAttachmentOnly).toBe(false);
    expect(body.rule.draftTtlMinutes).toBe(240);
    expect(body.rule.priority).toBe(100);
    // persisted exactly as returned
    expect(h.store.getRule(body.rule.id)).toStrictEqual(body.rule);
    // exactly one audit row: rule.created with the full rule snapshot,
    // actor {kind:'human',via:'api'} (§1.8)
    const trail = auditTrail(h.store);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.event).toStrictEqual({
      type: 'rule.created',
      ruleId: body.rule.id,
      rule: JSON.parse(JSON.stringify(body.rule)) as Rule,
    });
    expect(JSON.parse(trail[0]!.actorJson)).toStrictEqual({
      kind: 'human',
      via: 'api',
    });
  });

  it('accepts any non-empty adapterId (F-14) — adapters land S5', async () => {
    const h = await boot();
    const rule = await createRule(h, { adapterId: 'never-registered-adapter' });
    expect(rule.adapterId).toBe('never-registered-adapter');
  });
});

describe('GET /v1/rules + GET /v1/rules/:id (§1.6 routes 1, 3)', () => {
  it('lists priority ASC, shows by id, 404s unknown', async () => {
    const h = await boot();
    const a = await createRule(h, { name: 'late', priority: 20 });
    const b = await createRule(h, { name: 'early', priority: 5 });
    const list = await h.server.app.inject({
      method: 'GET',
      url: '/v1/rules',
      headers: h.headers,
    });
    expect(list.statusCode).toBe(200);
    const rules = list.json() as Rule[];
    expect(rules.map((r) => r.name)).toEqual(['early', 'late']);
    expect(rules).toStrictEqual([b, a]);

    const show = await h.server.app.inject({
      method: 'GET',
      url: `/v1/rules/${a.id}`,
      headers: h.headers,
    });
    expect(show.statusCode).toBe(200);
    expect(show.json()).toStrictEqual(a);

    const missing = await h.server.app.inject({
      method: 'GET',
      url: '/v1/rules/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      headers: h.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toStrictEqual({ error: 'not-found' });
  });
});

describe('PATCH /v1/rules/:id (§1.6 route 4)', () => {
  it('partial update bumps updatedAt only, audits rule.updated', async () => {
    const h = await boot();
    const rule = await createRule(h);
    h.clockCtl.advance(60_000);
    const res = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { priority: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rule: Rule; adapterKnown: boolean };
    expect(body.adapterKnown).toBe(false);
    expect(body.rule).toStrictEqual({
      ...rule,
      priority: 5,
      updatedAt: '2026-09-01T12:01:00.000Z',
    });
    expect(h.store.getRule(rule.id)).toStrictEqual(body.rule);
    const trail = auditTrail(h.store);
    expect(trail).toHaveLength(2); // create + update
    expect(trail[1]?.event).toStrictEqual({
      type: 'rule.updated',
      ruleId: rule.id,
      rule: JSON.parse(JSON.stringify(body.rule)) as Rule,
    });
  });

  it('enabled-only flips audit rule.disabled / rule.enabled (§1.8)', async () => {
    const h = await boot();
    const rule = await createRule(h);
    const off = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    const on = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    // enabled together with another field → rule.updated, not rule.enabled
    const mixed = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { enabled: false, name: 'renamed' },
    });
    expect(mixed.statusCode).toBe(200);
    const types = auditTrail(h.store).map((r) => r.event['type']);
    expect(types).toEqual([
      'rule.created',
      'rule.disabled',
      'rule.enabled',
      'rule.updated',
    ]);
    const disabled = auditTrail(h.store)[1];
    expect(disabled?.event).toStrictEqual({
      type: 'rule.disabled',
      ruleId: rule.id,
    });
  });

  it('404s unknown id; rejects unknown body keys', async () => {
    const h = await boot();
    const missing = await h.server.app.inject({
      method: 'PATCH',
      url: '/v1/rules/01ARZ3NDEKTSV4RRFFQ69G5FAV',
      headers: h.headers,
      payload: { priority: 1 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toStrictEqual({ error: 'not-found' });

    const rule = await createRule(h);
    const bad = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ' }, // id is not patchable
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('invalid-rule');
  });
});

describe('DELETE /v1/rules/:id (§1.6 route 5)', () => {
  it('removes, audits rule.deleted, 404s the second delete', async () => {
    const h = await boot();
    const rule = await createRule(h);
    const res = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(h.store.getRule(rule.id)).toBeNull();
    const trail = auditTrail(h.store);
    expect(trail).toHaveLength(2);
    expect(trail[1]?.event).toStrictEqual({
      type: 'rule.deleted',
      ruleId: rule.id,
    });

    const again = await h.server.app.inject({
      method: 'DELETE',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toStrictEqual({ error: 'not-found' });
    expect(auditTrail(h.store)).toHaveLength(2); // 404 appends nothing
  });
});

describe('create/update validation 400s (§1.6, §1.4.1 #6, F-11)', () => {
  it('unknown matcher kind', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: createBody({ matcher: { kind: 'vibes' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'invalid-rule',
      detail: { code: 'unknown-matcher-kind', kind: 'vibes' },
    });
  });

  it('theme anywhere in the tree → theme-unavailable-v1 (top level and nested)', async () => {
    const h = await boot();
    const theme = { kind: 'theme', themes: ['travel'], minConfidence: 0.5 };
    for (const matcher of [
      theme,
      {
        kind: 'any-of',
        matchers: [
          { kind: 'keyword', keywords: ['x'], mode: 'any' },
          { kind: 'all-of', matchers: [theme] },
        ],
      },
    ]) {
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/rules',
        headers: h.headers,
        payload: createBody({ matcher }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({ error: 'theme-unavailable-v1' });
    }
    // update path guarded the same way
    const rule = await createRule(h);
    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { matcher: theme },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toStrictEqual({ error: 'theme-unavailable-v1' });
  });

  it('unsafe regex → 400 with the F-11 typed reason in detail (all five reasons)', async () => {
    const h = await boot();
    const cases: Array<[string, string]> = [
      ['a'.repeat(513), 'pattern-too-long'],
      ['(', 'invalid-syntax'],
      ['(a)\\1', 'backreference'],
      ['(?=a)b', 'lookaround'],
      ['(a+)+', 'nested-quantifier'],
    ];
    for (const [pattern, reason] of cases) {
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/rules',
        headers: h.headers,
        payload: createBody({ matcher: { kind: 'regex', pattern } }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toStrictEqual({
        error: 'unsafe-regex',
        detail: { reason },
      });
    }
    // recursion: an unsafe regex nested under a combinator is still caught
    const nested = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: createBody({
        matcher: {
          kind: 'any-of',
          matchers: [{ kind: 'regex', pattern: '(a+)+' }],
        },
      }),
    });
    expect(nested.statusCode).toBe(400);
    expect(nested.json()).toStrictEqual({
      error: 'unsafe-regex',
      detail: { reason: 'nested-quantifier' },
    });
  });

  it('empty combinator, bad leaf shapes, missing/non-string/empty adapterId', async () => {
    const h = await boot();
    const cases: Array<Record<string, unknown>> = [
      { matcher: { kind: 'all-of', matchers: [] } }, // empty combinator
      { matcher: { kind: 'keyword', keywords: [], mode: 'any' } }, // empty keywords
      {}, // matcher present but body default has one — replaced below
    ];
    // empty combinator
    const empty = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: createBody(cases[0]!),
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({
      error: 'invalid-rule',
      detail: { code: 'empty-combinator' },
    });
    // bad keyword leaf
    const badLeaf = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: createBody(cases[1]!),
    });
    expect(badLeaf.statusCode).toBe(400);
    expect((badLeaf.json() as { error: string }).error).toBe('invalid-rule');
    // missing matcher entirely
    const noMatcher = createBody();
    delete (noMatcher as Record<string, unknown>)['matcher'];
    const missingMatcher = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: noMatcher,
    });
    expect(missingMatcher.statusCode).toBe(400);
    // adapterId: missing / non-string / empty string
    for (const bad of [undefined, 42, '']) {
      const payload = createBody();
      if (bad === undefined) {
        delete (payload as Record<string, unknown>)['adapterId'];
      } else {
        (payload as Record<string, unknown>)['adapterId'] = bad;
      }
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/rules',
        headers: h.headers,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid-rule');
    }
    // a scheduleId naming no schedule (C-7 narrowed, s6 Scenario 3): the
    // route checks the store first, so the FK never gets to 500
    const sched = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules',
      headers: h.headers,
      payload: createBody({ scheduleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
    });
    expect(sched.statusCode).toBe(400);
    expect(sched.json()).toMatchObject({
      error: 'invalid-rule',
      detail: { code: 'schedule-not-found' },
    });
    // no validation failure produced an audit row or a stored rule
    expect(auditTrail(h.store)).toHaveLength(0);
    expect(h.store.listRules()).toHaveLength(0);
  });
});

describe('auth posture per route (§2.4.2 unchanged by S2 routes)', () => {
  const SOME_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const ROUTES: Array<{
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: Record<string, unknown>;
  }> = [
    { method: 'GET', url: '/v1/rules' },
    { method: 'POST', url: '/v1/rules', payload: createBody() },
    { method: 'GET', url: `/v1/rules/${SOME_ID}` },
    { method: 'PATCH', url: `/v1/rules/${SOME_ID}`, payload: { priority: 1 } },
    { method: 'DELETE', url: `/v1/rules/${SOME_ID}` },
    {
      method: 'POST',
      url: `/v1/rules/${SOME_ID}/test`,
      payload: { text: 'x' },
    },
  ];

  it('401 without/with wrong bearer on every rules route', async () => {
    const h = await boot();
    for (const r of ROUTES) {
      const anon = await h.server.app.inject({
        method: r.method,
        url: r.url,
        ...(r.payload ? { payload: r.payload } : {}),
      });
      expect(anon.statusCode, `${r.method} ${r.url} anon`).toBe(401);
      expect(anon.json()).toStrictEqual({ error: 'unauthorized' });
      const wrong = await h.server.app.inject({
        method: r.method,
        url: r.url,
        headers: { authorization: 'Bearer wm_wrong' },
        ...(r.payload ? { payload: r.payload } : {}),
      });
      expect(wrong.statusCode, `${r.method} ${r.url} wrong`).toBe(401);
    }
    expect(auditTrail(h.store)).toHaveLength(0);
  });

  it('503 no-auth-token on every rules route when no token exists', async () => {
    const dir = tempDir();
    const clockCtl = fakeClock();
    const store = openStore({ dir, clock: clockCtl.clock });
    stores.push(store);
    chmodSync(dir, 0o500); // token can be neither read nor generated
    const server = await buildServer({
      configDir: dir,
      rules: { store, clock: clockCtl.clock },
    });
    servers.push(server);
    expect(server.token).toBeNull();
    for (const r of ROUTES) {
      const res = await server.app.inject({
        method: r.method,
        url: r.url,
        headers: { authorization: 'Bearer wm_whatever' },
        ...(r.payload ? { payload: r.payload } : {}),
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(503);
      expect(res.json()).toStrictEqual({ error: 'no-auth-token' });
    }
    expect(server.counters.handlerCalls).toBe(0); // no handler ever ran
    expect(auditTrail(store)).toHaveLength(0);
  });
});

describe('POST /v1/rules/:id/test (§1.6 route 6 — read-only)', () => {
  it('keyword hit/miss, contact matcher via handle, eligibility via kind/isGroup', async () => {
    const h = await boot();
    const keyword = await createRule(h); // matches 'pool'
    const contact = await createRule(h, {
      name: 'VIP contact',
      matcher: { kind: 'contact', handles: ['+15551234567'] },
    });
    const disabled = await createRule(h, {
      name: 'off',
      enabled: false,
    });

    const verdict = async (
      ruleId: string,
      payload: Record<string, unknown>,
    ): Promise<{ matched: boolean; detail: { matchedRuleIds: string[] } }> => {
      const res = await h.server.app.inject({
        method: 'POST',
        url: `/v1/rules/${ruleId}/test`,
        headers: h.headers,
        payload,
      });
      expect(res.statusCode).toBe(200);
      return res.json() as {
        matched: boolean;
        detail: { matchedRuleIds: string[] };
      };
    };

    // keyword hit + miss
    expect(await verdict(keyword.id, { text: 'the pool is open' })).toEqual({
      matched: true,
      detail: { matchedRuleIds: [keyword.id] },
    });
    expect((await verdict(keyword.id, { text: 'gym only' })).matched).toBe(
      false,
    );
    // handle feeds the contact matcher through normalizeHandle
    expect(
      (
        await verdict(contact.id, {
          text: null,
          handle: '+1 (555) 123-4567',
        })
      ).matched,
    ).toBe(true);
    expect(
      (await verdict(contact.id, { text: null, handle: '+15559998887' }))
        .matched,
    ).toBe(false);
    // §1.7 eligibility: tapbacks never match
    expect(
      (await verdict(keyword.id, { text: 'the pool', kind: 'tapback' }))
        .matched,
    ).toBe(false);
    // attachment-ish kinds gate on matchAttachmentOnly (default false)
    expect(
      (
        await verdict(keyword.id, {
          text: 'the pool',
          kind: 'attachment-only',
        })
      ).matched,
    ).toBe(false);
    // groups ARE matched (§1.3.8: events/audit only)
    expect(
      (await verdict(keyword.id, { text: 'the pool', isGroup: true })).matched,
    ).toBe(true);
    // disabled rules are skipped
    expect((await verdict(disabled.id, { text: 'the pool' })).matched).toBe(
      false,
    );

    // 404 unknown rule
    const missing = await h.server.app.inject({
      method: 'POST',
      url: '/v1/rules/01BX5ZZKBKACTAV9WEVGEMMVRZ/test',
      headers: h.headers,
      payload: { text: 'x' },
    });
    expect(missing.statusCode).toBe(404);

    // read-only: the three creates are the ONLY audit rows; tests added none
    expect(auditTrail(h.store)).toHaveLength(3);
  });

  it('emits zero WS events (read-only teeth)', async () => {
    const h = await boot();
    const rule = await createRule(h);
    const port = await startServer(h.server);
    const frames: string[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`, {
      headers: h.headers,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });
    socket.on('message', (data) => frames.push(String(data)));
    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/rules/${rule.id}/test`,
      headers: h.headers,
      payload: { text: 'the pool is open' }, // a HIT — still no event
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { matched: boolean }).matched).toBe(true);
    await sleep(200);
    socket.close();
    expect(frames).toEqual([]);
    expect(auditTrail(h.store)).toHaveLength(1); // the create only
  });

  it('validates the test body', async () => {
    const h = await boot();
    const rule = await createRule(h);
    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/rules/${rule.id}/test`,
      headers: h.headers,
      payload: { text: 'x', kind: 'carrier-pigeon' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid-test-body');
  });
});

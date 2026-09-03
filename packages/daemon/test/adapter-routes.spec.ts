/**
 * s5-execution Scenario 4 — adapter CRUD routes + the connect command.
 *
 * The registry's whole job is to hand out a credential exactly once and then
 * never speak of it again. So the suite is written around the token's
 * lifetime rather than around the six verbs: minted once, visible once,
 * rotated with one 60s carry-over, revoked on delete, and absent from every
 * other byte the daemon will ever emit. The "no token material" rows use a
 * substring sweep over the serialized response rather than checking named
 * fields, because the failure being guarded against is a field nobody
 * thought to check.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hashAdapterToken } from '@wemessage/store';
import {
  auditEvents,
  boot,
  cleanupHarness,
  get,
  post,
  type Harness,
} from './helpers/draft-harness.js';

afterEach(async () => {
  await cleanupHarness();
});

function patch(h: Harness, id: string, payload: Record<string, unknown>) {
  return h.server.app.inject({
    method: 'PATCH',
    url: `/v1/adapters/${id}`,
    headers: h.headers,
    payload,
  });
}

function del(h: Harness, id: string) {
  return h.server.app.inject({
    method: 'DELETE',
    url: `/v1/adapters/${id}`,
    headers: h.headers,
  });
}

async function create(h: Harness, id = 'echo') {
  const res = await post(h, '/v1/adapters', {
    id,
    kind: 'echo',
    displayName: 'Echo',
  });
  return res;
}

function auditTypesOf(h: Harness): string[] {
  return auditEvents(h.store).map((e) => e.type);
}

describe('adapter routes (s5 Scenario 4)', () => {
  it('mints a token exactly once and never shows it again', async () => {
    const h = await boot();
    const res = await create(h);
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      adapter: { id: string; hasToken: boolean };
      token: string;
      connectCmd: string;
    };
    expect(body.adapter.hasToken).toBe(true);
    expect(body.token).toMatch(/^wm_[0-9a-f]{64}$/);
    expect(body.connectCmd).toContain(body.token);
    expect(body.connectCmd).toContain('/v1/agent');

    const show = await get(h, '/v1/adapters/echo');
    expect(show.statusCode).toBe(200);
    expect(show.body).not.toContain(body.token);
    expect(show.body).not.toContain('wm_');
    expect(show.body).not.toContain('scrypt$');
    expect(
      (show.json() as { adapter: { hasToken: boolean } }).adapter.hasToken,
    ).toBe(true);

    const list = await get(h, '/v1/adapters');
    expect(list.body).not.toContain('wm_');
    expect(auditTypesOf(h)).toContain('adapter.created');
  });

  it('refuses a duplicate id with 409 and leaves the first token alone', async () => {
    const h = await boot();
    const first = (await create(h)).json() as { token: string };
    const dup = await create(h);
    expect(dup.statusCode).toBe(409);
    expect(
      h.store.findAdapterByToken(first.token, h.clockCtl.clock.now())?.id,
    ).toBe('echo');
  });

  it("lists real adapters only, excluding the reserved 'human' row", async () => {
    const h = await boot();
    await create(h, 'zeta');
    await create(h, 'alpha');
    const list = (await get(h, '/v1/adapters')).json() as {
      adapters: Array<{ id: string }>;
    };
    expect(list.adapters.map((a) => a.id)).toEqual(['alpha', 'zeta']);
    expect((await get(h, '/v1/adapters/human')).statusCode).toBe(404);
    expect((await get(h, '/v1/adapters/ghost')).statusCode).toBe(404);
  });

  it('patches enabled / displayName / config and audits each change', async () => {
    const h = await boot();
    await create(h);
    const res = await patch(h, 'echo', {
      enabled: false,
      displayName: 'Echo 2',
      config: { streaming: true },
    });
    expect(res.statusCode).toBe(200);
    const adapter = (
      res.json() as { adapter: { enabled: boolean; config: unknown } }
    ).adapter;
    expect(adapter.enabled).toBe(false);
    expect(adapter.config).toEqual({ streaming: true });

    const updates = auditEvents(h.store).filter(
      (e) => e.type === 'adapter.updated',
    );
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(updates)).toContain('Echo 2');

    // A patch must not disturb the credential: an operator renaming an
    // adapter has not asked to lock it out.
    expect((await get(h, '/v1/adapters/echo')).json()).toMatchObject({
      adapter: { hasToken: true },
    });
    expect((await patch(h, 'ghost', { enabled: false })).statusCode).toBe(404);
  });

  it('rotates: a new token once, the old one valid for 60s, never echoed back', async () => {
    const h = await boot();
    const first = (await create(h)).json() as { token: string };
    const rot = await post(h, '/v1/adapters/echo/token', {});
    expect(rot.statusCode).toBe(200);
    const second = rot.json() as { token: string; connectCmd: string };
    expect(second.token).not.toBe(first.token);
    expect(rot.body).not.toContain(first.token);
    expect(second.connectCmd).toContain(second.token);
    expect(auditTypesOf(h)).toContain('adapter.token-rotated');

    const now = h.clockCtl.clock.now();
    expect(h.store.findAdapterByToken(first.token, now)?.id).toBe('echo');
    h.clockCtl.advance(61_000);
    expect(
      h.store.findAdapterByToken(first.token, h.clockCtl.clock.now()),
    ).toBeNull();
    expect(
      h.store.findAdapterByToken(second.token, h.clockCtl.clock.now())?.id,
    ).toBe('echo');
    expect((await post(h, '/v1/adapters/ghost/token', {})).statusCode).toBe(
      404,
    );
  });

  it('deletes with 204 + audit, and 409s while a rule points at it', async () => {
    const h = await boot();
    await create(h);
    // The rule is planted through the store rather than POST /v1/rules: the
    // draft harness wires the draft + adapter surfaces, not the rule routes,
    // and what this row is about is the reference, not how it got there.
    const now = h.clockCtl.clock.now();
    h.store.insertRule({
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      name: 'points at echo',
      enabled: true,
      matcher: { kind: 'keyword', keywords: ['hi'], mode: 'any' },
      adapterId: 'echo',
      respondMode: 'draft-only',
      scheduleId: null,
      outsideWindow: 'draft-only',
      allowGroupDrafts: false,
      matchAttachmentOnly: false,
      draftTtlMinutes: 240,
      priority: 1,
      createdAt: now,
      updatedAt: now,
    });
    const referenced = await del(h, 'echo');
    expect(referenced.statusCode).toBe(409);
    expect(referenced.json()).toMatchObject({ error: 'adapter-referenced' });
    expect((referenced.json() as { ruleIds: string[] }).ruleIds).toEqual([
      '01AAAAAAAAAAAAAAAAAAAAAAAA',
    ]);
    expect(h.store.getAdapter('echo')).not.toBeNull();

    h.store.deleteRule('01AAAAAAAAAAAAAAAAAAAAAAAA');
    const gone = await del(h, 'echo');
    expect(gone.statusCode).toBe(204);
    expect(auditTypesOf(h)).toContain('adapter.deleted');
    expect((await del(h, 'echo')).statusCode).toBe(404);
  });

  it('answers 401 on every adapter route without the daemon bearer', async () => {
    const h = await boot();
    await create(h);
    const routes: Array<[string, string]> = [
      ['GET', '/v1/adapters'],
      ['GET', '/v1/adapters/echo'],
      ['POST', '/v1/adapters'],
      ['PATCH', '/v1/adapters/echo'],
      ['DELETE', '/v1/adapters/echo'],
      ['POST', '/v1/adapters/echo/token'],
    ];
    for (const [method, url] of routes) {
      const res = await h.server.app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('rejects a malformed create body without touching the registry', async () => {
    const h = await boot();
    const res = await post(h, '/v1/adapters', { id: 'x', kind: 'not-a-kind' });
    expect(res.statusCode).toBe(400);
    expect(h.store.listAdapters()).toEqual([]);
  });

  it('keeps the store the only holder of hash material', async () => {
    // A different angle on the same property as row 1: whatever else is in
    // the database, the value the operator was shown is not recoverable from
    // it. The hash is present; the token is not.
    const h = await boot();
    const { token } = (await create(h)).json() as { token: string };
    expect(h.store.rawScanForToken(token)).toEqual([]);
    expect(h.store.rawScanForToken('scrypt$').length).toBeGreaterThan(0);
    expect(hashAdapterToken(token)).not.toBe(token);
  });
});

/**
 * s4-execution Scenario 5 — draft routes: create, list, show, approve,
 * reject (§1.6). The review surface the whole product is an excuse for.
 *
 * What this suite pins, and why each one is load-bearing:
 *  - POST /v1/drafts is the F-33 compose path: adapterId 'human', ruleId
 *    null, a fresh idempotency key per request (a human pressing send twice
 *    MEANS twice; F-15 dedup is for agent retries), expiresAt = now + ttl
 *    with the §2.3 default of 240 minutes.
 *  - approve stamps the undo window from `send.undoGraceSeconds`, defaulting
 *    to 10s. An explicit '0' must stamp `now`, not fall back to the default:
 *    a user who turned undo off gets no undo.
 *  - Legality is the pure transition table's call, and an illegal request is
 *    a 409 with a `draft.illegal-transition` audit row and ZERO state change.
 *    Not a 500, not a silent no-op.
 *  - F-34: an approve refused by the gate is a 403 AND an audit row. "Someone
 *    tried to approve while the kill switch was on" is exactly what an
 *    operator needs to find afterwards, and the draft stays pending so they
 *    can approve it once the switch is off.
 *
 * Harness note: `readGateSettings` defaults connectionState to 'disconnected'
 * when unset, and the gate denies on that. So `boot()` writes 'connected'
 * explicitly — a fresh store cannot approve anything, by design.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval, Clock, Draft } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';
import { buildServer, type DaemonServer } from '@wemessage/daemon';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const T0 = '2026-09-01T12:00:00.000Z';
const CHAT = 'iMessage;-;+15550001111';

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-drafts-'));
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
  // See the header note: unset connection state means "never probed" and the
  // gate denies it. A test about approvals must not be a test about that.
  store.setSetting('connection.state', 'fully-connected');
  store.setSetting('send.globalMode', 'auto');
  const server = await buildServer({
    configDir: dir,
    drafts: { store, clock: clockCtl.clock },
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

async function createDraft(
  h: Harness,
  payload: Record<string, unknown> = {},
): Promise<Draft> {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/drafts',
    headers: h.headers,
    payload: { chatGuid: CHAT, body: 'hello there', ...payload },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { draft: Draft }).draft;
}

describe('POST /v1/drafts (F-33 compose surface)', () => {
  it('mints a pending human draft with defaults, audits and broadcasts draft.created', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    expect(draft.id).toMatch(ULID_RE);
    expect(draft.state).toBe('pending');
    expect(draft.adapterId).toBe('human');
    expect(draft.ruleId).toBeNull();
    expect(draft.inboundGuid).toBeNull();
    expect(draft.body).toBe('hello there');
    expect(draft.originalBody).toBe('hello there');
    expect(draft.createdAt).toBe(T0);
    // §2.3 default TTL of 240 minutes, off the Clock, not Date.now().
    expect(draft.expiresAt).toBe('2026-09-01T16:00:00.000Z');
    expect(h.store.getDraft(draft.id)?.state).toBe('pending');

    const trail = auditTrail(h.store);
    expect(trail.map((r) => r.event.type)).toEqual(['draft.created']);
    expect(JSON.parse(trail[0]!.actorJson)).toEqual({
      kind: 'human',
      via: 'api',
    });
  });

  it('honors ttlMinutes', async () => {
    const h = await boot();
    const draft = await createDraft(h, { ttlMinutes: 30 });
    expect(draft.expiresAt).toBe('2026-09-01T12:30:00.000Z');
  });

  it('gives every request a distinct idempotency key (a human meant it twice)', async () => {
    const h = await boot();
    const a = await createDraft(h);
    const b = await createDraft(h);
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.id).not.toBe(b.id);
  });

  it('rejects unknown fields and empty bodies with 400 (strictObject)', async () => {
    const h = await boot();
    for (const payload of [
      { chatGuid: CHAT, body: 'x', surprise: 1 },
      { chatGuid: CHAT, body: '' },
      { chatGuid: '', body: 'x' },
      { body: 'x' },
    ]) {
      const res = await h.server.app.inject({
        method: 'POST',
        url: '/v1/drafts',
        headers: h.headers,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid-draft');
    }
    // A rejected request writes nothing at all.
    expect(auditTrail(h.store)).toEqual([]);
  });

  it('401 without a bearer token (auth posture inherited)', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/drafts',
      payload: { chatGuid: CHAT, body: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/drafts (list) and GET /v1/drafts/:id (show)', () => {
  it('defaults to the queue view and passes filters through', async () => {
    const h = await boot();
    const keep = await createDraft(h, { body: 'still pending' });
    const gone = await createDraft(h, { body: 'about to be rejected' });
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${gone.id}/reject`,
      headers: h.headers,
      payload: {},
    });

    const res = await h.server.app.inject({
      method: 'GET',
      url: '/v1/drafts',
      headers: h.headers,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { drafts: Draft[] }).drafts.map((d) => d.id);
    // Terminal states are excluded from the queue default. That is the whole
    // point of the default: the queue is work, not history.
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(gone.id);

    const explicit = await h.server.app.inject({
      method: 'GET',
      url: '/v1/drafts?state=rejected',
      headers: h.headers,
    });
    expect(
      (explicit.json() as { drafts: Draft[] }).drafts.map((d) => d.id),
    ).toEqual([gone.id]);

    const byContact = await h.server.app.inject({
      method: 'GET',
      url: '/v1/drafts?contact=%2B15550009999',
      headers: h.headers,
    });
    expect((byContact.json() as { drafts: Draft[] }).drafts).toEqual([]);
  });

  it('400s an unknown state rather than silently returning everything', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'GET',
      url: '/v1/drafts?state=banana',
      headers: h.headers,
    });
    expect(res.statusCode).toBe(400);
  });

  it('show includes originalBody, error and the approvals history', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: { editedBody: 'edited by a human' },
    });

    const res = await h.server.app.inject({
      method: 'GET',
      url: `/v1/drafts/${draft.id}`,
      headers: h.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { draft: Draft; approvals: Approval[] };
    expect(body.draft.body).toBe('edited by a human');
    // The original survives the edit: what the agent proposed is evidence.
    expect(body.draft.originalBody).toBe('hello there');
    // exactOptionalPropertyTypes convention: a NULL column round-trips as an
    // OMITTED key, not an explicit undefined. Absent means "never failed."
    expect(body.draft.error).toBeUndefined();
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0]!.action).toBe('approve');
    expect(body.approvals[0]!.editedBody).toBe('edited by a human');
  });

  it('404s an unknown draft', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'GET',
      url: '/v1/drafts/01J0000000000000000000000X',
      headers: h.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/drafts/:id/approve', () => {
  it('moves pending -> approved and stamps the default 10s undo window', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const updated = h.store.getDraft(draft.id)!;
    expect(updated.state).toBe('approved');
    expect(updated.sendNotBefore).toBe('2026-09-01T12:00:10.000Z');

    const approvals = h.store.listApprovals(draft.id);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.action).toBe('approve');
    expect(approvals[0]!.actor).toEqual({ kind: 'human', via: 'api' });

    expect(auditTrail(h.store).map((r) => r.event.type)).toEqual([
      'draft.created',
      'draft.approved',
    ]);
  });

  it('reads the grace window from send.undoGraceSeconds', async () => {
    const h = await boot();
    h.store.setSetting('send.undoGraceSeconds', '45');
    const draft = await createDraft(h);
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    expect(h.store.getDraft(draft.id)!.sendNotBefore).toBe(
      '2026-09-01T12:00:45.000Z',
    );
  });

  it("an explicit '0' means now, not the default", async () => {
    const h = await boot();
    h.store.setSetting('send.undoGraceSeconds', '0');
    const draft = await createDraft(h);
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    // Turning undo off must actually turn it off. Falling back to the 10s
    // default here would silently re-arm a window the user disabled.
    expect(h.store.getDraft(draft.id)!.sendNotBefore).toBe(T0);
  });

  it('approve-with-edit updates the body and preserves originalBody', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: { editedBody: 'no, say this instead' },
    });
    const updated = h.store.getDraft(draft.id)!;
    expect(updated.body).toBe('no, say this instead');
    expect(updated.originalBody).toBe('hello there');
    expect(h.store.listApprovals(draft.id)[0]!.editedBody).toBe(
      'no, say this instead',
    );
  });

  it('409s an already-sent draft, audits the illegal transition, changes nothing', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    h.store.applyDraftTransition({
      id: draft.id,
      from: 'pending',
      to: 'approved',
      at: T0,
    });
    h.store.applyDraftTransition({
      id: draft.id,
      from: 'approved',
      to: 'sending',
      at: T0,
    });
    h.store.applyDraftTransition({
      id: draft.id,
      from: 'sending',
      to: 'sent',
      at: T0,
    });
    const before = h.store.getDraft(draft.id)!;

    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'illegal-transition',
      from: 'sent',
      requested: 'approve',
    });
    expect(h.store.getDraft(draft.id)).toEqual(before);
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    const trail = auditTrail(h.store);
    expect(trail.map((r) => r.event.type)).toEqual([
      'draft.created',
      'draft.illegal-transition',
    ]);
    expect(trail[1]!.event).toMatchObject({ from: 'sent', event: 'approve' });
  });

  it('403 gate-denied with an audit row when the kill switch is on (F-34)', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    h.store.setSetting('send.killSwitch', '1');

    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'gate-denied', reason: 'kill-switch' });
    // The draft is refused, not consumed: flip the switch back and it is
    // still approvable.
    expect(h.store.getDraft(draft.id)!.state).toBe('pending');
    expect(h.store.listApprovals(draft.id)).toEqual([]);
    expect(auditTrail(h.store).map((r) => r.event.type)).toEqual([
      'draft.created',
      'gate.denied',
    ]);
  });

  it('404s an unknown draft', async () => {
    const h = await boot();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/drafts/01J0000000000000000000000X/approve',
      headers: h.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/drafts/:id/reject', () => {
  it('moves pending -> rejected, audits and broadcasts draft.rejected', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/reject`,
      headers: h.headers,
      payload: { reason: 'wrong tone' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.store.getDraft(draft.id)!.state).toBe('rejected');
    expect(h.store.listApprovals(draft.id)[0]!.action).toBe('reject');
    expect(auditTrail(h.store).map((r) => r.event.type)).toEqual([
      'draft.created',
      'draft.rejected',
    ]);
  });

  it('409s a human rejecting their OWN approved draft (§1.7: recall, not reject)', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/approve`,
      headers: h.headers,
      payload: {},
    });
    const before = h.store.getDraft(draft.id)!;

    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/reject`,
      headers: h.headers,
      payload: {},
    });
    // The `approved + reject` row exists, but §1.7 reserves it for the
    // system (kill/disconnect/circuit). A human takes back their own
    // approved draft with recall, which is Scenario 6's undo-window verb.
    // The load-bearing part is that this is a 409, not a 500: an actor
    // constraint is still "you may not do that here," not a crash.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'illegal-transition',
      from: 'approved',
      requested: 'reject',
    });
    expect(h.store.getDraft(draft.id)).toEqual(before);
    expect(h.store.listApprovals(draft.id)).toHaveLength(1); // the approve only
    expect(auditTrail(h.store).map((r) => r.event.type)).toEqual([
      'draft.created',
      'draft.approved',
      'draft.illegal-transition',
    ]);
  });

  it('409s a second reject, audits it, and does not write a second approval', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    for (const expected of [200, 409]) {
      const res = await h.server.app.inject({
        method: 'POST',
        url: `/v1/drafts/${draft.id}/reject`,
        headers: h.headers,
        payload: {},
      });
      expect(res.statusCode).toBe(expected);
    }
    expect(h.store.listApprovals(draft.id)).toHaveLength(1);
    expect(auditTrail(h.store).map((r) => r.event.type)).toEqual([
      'draft.created',
      'draft.rejected',
      'draft.illegal-transition',
    ]);
  });

  it('is allowed while the kill switch is on (refusing to speak is always legal)', async () => {
    const h = await boot();
    const draft = await createDraft(h);
    h.store.setSetting('send.killSwitch', '1');
    const res = await h.server.app.inject({
      method: 'POST',
      url: `/v1/drafts/${draft.id}/reject`,
      headers: h.headers,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(h.store.getDraft(draft.id)!.state).toBe('rejected');
  });
});

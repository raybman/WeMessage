/**
 * Scenario 10 (commit 2 of 2) — GET /v1/rules/:id/dry-run (§1.6 route 7).
 * s2-execution Part 2 Scenario 10 RED list:
 *  - seed mirror with 60 messages (12 containing a trigger word); default →
 *    { total: 50, matched, rows } over the MOST RECENT 50 (§1.3.2 "replays
 *    the rule against the last 50 inbound messages"); ?limit=10 honored;
 *    limit cap 500 → 400 above;
 *  - verdict fidelity: dry-run row verdicts equal live-engine verdicts for
 *    the same messages (same evaluateRules eligibility — a self-sent or
 *    tapback row in the mirror reports matched:false for the same reason
 *    live matching skips it);
 *  - read-only teeth (§1.3.2 "read-only, no drafts created"): audit row
 *    count and WS event count identical before/after; store mirror (and
 *    rules + settings — coordinator scope: never advance cursors/seen-set)
 *    untouched;
 *  - unknown rule id → 404; disabled rule → still dry-runnable (editor
 *    affordance, UI §3 S3 dry-run panel operates on drafts-in-progress);
 *  - textPreview truncation (80 chars); null-text rows render matched:false
 *    with textPreview:null (no throw).
 *
 * Seed layout (idx 0 oldest .. 59 newest; default window = idx 10..59):
 *  - eligible text triggers: idx 3, 8 (OUTSIDE the default window),
 *    12, 18, 24, 30 (mid-window), 51, 54, 58 (newest end), 56 (long text);
 *  - ineligible trigger-text rows: idx 20 (isFromMe), idx 25 (tapback) —
 *    with the ten eligible rows, exactly 12 rows contain the trigger word;
 *  - idx 40: attachment-only, text null.
 * Expected: default → matched 8 ({12,18,24,30,51,54,56,58}); ?limit=10 →
 * matched 4 ({51,54,56,58}); ?limit=500 → total 60, matched 10 (+{3,8}).
 * The asymmetric layout makes an oldest-first window differ in COUNT, not
 * just order (teeth: oldest-first default → 6, limit=10 → 2).
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  evaluateRules,
  type Clock,
  type Message,
  type Rule,
} from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';
import { buildServer, startServer, type DaemonServer } from '@wemessage/daemon';

const T0 = '2026-09-01T12:00:00.000Z';
const noDrafts = { hasDraftForMessage: () => false };

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const stores: SqliteStore[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'wemessage-dryrun-'));
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

function fixedClock(): Clock {
  const now = new Date(T0).getTime();
  return { now: () => new Date(now).toISOString(), nowMs: () => now };
}

interface Harness {
  server: DaemonServer;
  store: SqliteStore;
  headers: { authorization: string };
}

async function boot(): Promise<Harness> {
  const dir = tempDir();
  const clock = fixedClock();
  const store = openStore({ dir, clock });
  stores.push(store);
  const server = await buildServer({ configDir: dir, rules: { store, clock } });
  servers.push(server);
  if (server.token === null) throw new Error('harness: no token');
  return {
    server,
    store,
    headers: { authorization: `Bearer ${server.token}` },
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
    payload: {
      name: 'lunch',
      matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
      adapterId: 'echo',
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`createRule: ${res.body}`);
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

// --------------------------------------------------------------------------
// seed layout (header comment)
// --------------------------------------------------------------------------

const ELIGIBLE_TRIGGERS = new Set([3, 8, 12, 18, 24, 30, 51, 54, 58]);
const LONG_IDX = 56;
const SELF_IDX = 20;
const TAPBACK_IDX = 25;
const NULL_TEXT_IDX = 40;
const LONG_TEXT = `tacos ${'x'.repeat(114)}`; // 120 chars, trigger up front

const DEFAULT_MATCHED = 8; // {12,18,24,30,51,54,56,58}
const LIMIT10_MATCHED = 4; // {51,54,56,58}
const FULL_MATCHED = 10; //   + {3,8}

function guidOf(idx: number): string {
  return `dry-GUID-${String(idx).padStart(2, '0')}`;
}

function handleOf(idx: number): string {
  return `+1555000${String(idx).padStart(4, '0')}`;
}

function isoOf(idx: number): string {
  return new Date(Date.parse(T0) + idx * 1000).toISOString();
}

function seedMessage(idx: number): Message {
  const base: Message = {
    guid: guidOf(idx),
    sourceRowid: idx + 1,
    chatGuid: 'iMessage;-;+15550000001',
    handle: handleOf(idx),
    isFromMe: false,
    isGroup: false,
    service: 'imessage',
    kind: 'text',
    text: `filler message ${idx}`,
    attachments: [],
    sentAt: isoOf(idx),
    receivedAt: isoOf(idx),
  };
  if (ELIGIBLE_TRIGGERS.has(idx)) return { ...base, text: `tacos run ${idx}` };
  if (idx === LONG_IDX) return { ...base, text: LONG_TEXT };
  if (idx === SELF_IDX) {
    return { ...base, isFromMe: true, text: 'tacos from me' };
  }
  if (idx === TAPBACK_IDX) {
    return {
      ...base,
      kind: 'tapback',
      text: 'Loved "tacos"',
      tapback: { targetGuid: guidOf(12), type: 2000 },
    };
  }
  if (idx === NULL_TEXT_IDX) {
    return { ...base, kind: 'attachment-only', text: null };
  }
  return base;
}

/** 60 mirror rows, receivedAt strictly increasing (idx 0 oldest). */
function seedMirror(store: SqliteStore): Message[] {
  const messages = Array.from({ length: 60 }, (_, idx) => seedMessage(idx));
  for (const m of messages) store.insertInboundMessage(m);
  return messages;
}

interface DryRunBody {
  total: number;
  matched: number;
  rows: {
    guid: string;
    handle: string;
    textPreview: string | null;
    matched: boolean;
  }[];
}

async function dryRunCall(
  h: Harness,
  ruleId: string,
  query = '',
): Promise<{ statusCode: number; body: DryRunBody }> {
  const res = await h.server.app.inject({
    method: 'GET',
    url: `/v1/rules/${ruleId}/dry-run${query}`,
    headers: h.headers,
  });
  return { statusCode: res.statusCode, body: res.json() as DryRunBody };
}

describe('GET /v1/rules/:id/dry-run (§1.6 route 7, S2 Scenario 10)', () => {
  it('replays the MOST RECENT 50 mirrored messages by default, newest first (§1.3.2)', async () => {
    const h = await boot();
    seedMirror(h.store);
    const rule = await createRule(h);
    const { statusCode, body } = await dryRunCall(h, rule.id);
    expect(statusCode).toBe(200);
    expect(body.total).toBe(50);
    expect(body.matched).toBe(DEFAULT_MATCHED);
    expect(body.rows).toHaveLength(50);
    // Window + order: idx 59 (newest) down to idx 10 — NOT the oldest 50.
    const expectedOrder = Array.from({ length: 50 }, (_, i) => guidOf(59 - i));
    expect(body.rows.map((r) => r.guid)).toEqual(expectedOrder);
    // Matched membership: in-window eligible triggers only — the idx 3/8
    // triggers are outside the window, the idx 20/25 triggers ineligible.
    const matchedGuids = body.rows.filter((r) => r.matched).map((r) => r.guid);
    expect(matchedGuids.sort()).toEqual(
      [12, 18, 24, 30, 51, 54, 56, 58].map(guidOf).sort(),
    );
    // Full §1.6 row shape pinned at the route level too.
    expect(body.rows.find((r) => r.guid === guidOf(58))).toEqual({
      guid: guidOf(58),
      handle: handleOf(58),
      textPreview: 'tacos run 58',
      matched: true,
    });
  });

  it('row verdicts equal live-engine verdicts (fidelity: self-sent/tapback matched:false)', async () => {
    const h = await boot();
    const seeded = new Map(seedMirror(h.store).map((m) => [m.guid, m]));
    const rule = await createRule(h);
    const stored = h.store.getRule(rule.id);
    if (stored === null) throw new Error('rule not stored');
    const { body } = await dryRunCall(h, rule.id);
    for (const row of body.rows) {
      const message = seeded.get(row.guid);
      if (message === undefined) throw new Error(`unseeded ${row.guid}`);
      const live = evaluateRules([stored], message, noDrafts).length > 0;
      expect(row.matched, row.guid).toBe(live);
    }
    const byGuid = new Map(body.rows.map((r) => [r.guid, r]));
    // INV-6 / §1.3.8: same skip reasons as live matching.
    expect(byGuid.get(guidOf(SELF_IDX))?.matched).toBe(false);
    expect(byGuid.get(guidOf(TAPBACK_IDX))?.matched).toBe(false);
    // Null-text row: matched:false, textPreview:null, no throw.
    expect(byGuid.get(guidOf(NULL_TEXT_IDX))).toMatchObject({
      matched: false,
      textPreview: null,
    });
    // 80-char preview truncation on the long trigger row.
    const long = byGuid.get(guidOf(LONG_IDX));
    expect(long?.matched).toBe(true);
    expect(long?.textPreview).toBe(LONG_TEXT.slice(0, 80));
    expect(long?.textPreview).toHaveLength(80);
  });

  it('honors ?limit, caps at 500 (400 above), rejects invalid limits', async () => {
    const h = await boot();
    seedMirror(h.store);
    const rule = await createRule(h);

    const ten = await dryRunCall(h, rule.id, '?limit=10');
    expect(ten.statusCode).toBe(200);
    expect(ten.body.total).toBe(10);
    expect(ten.body.matched).toBe(LIMIT10_MATCHED);
    expect(ten.body.rows[0]?.guid).toBe(guidOf(59));
    expect(ten.body.rows[9]?.guid).toBe(guidOf(50));

    // Cap boundary: 500 is legal (window = whole 60-row mirror) …
    const full = await dryRunCall(h, rule.id, '?limit=500');
    expect(full.statusCode).toBe(200);
    expect(full.body.total).toBe(60);
    expect(full.body.matched).toBe(FULL_MATCHED);
    const fullMatched = full.body.rows.filter((r) => r.matched);
    expect(fullMatched.map((r) => r.guid)).toContain(guidOf(3));
    expect(fullMatched.map((r) => r.guid)).toContain(guidOf(8));

    // … and 501+ / non-positive / non-integer / unknown params are 400s
    // ({ error: 'invalid-query' } — new failure class, one new string).
    for (const bad of [
      '?limit=501',
      '?limit=0',
      '?limit=-1',
      '?limit=abc',
      '?limit=2.5',
      '?frobnicate=1',
    ]) {
      const res = await h.server.app.inject({
        method: 'GET',
        url: `/v1/rules/${rule.id}/dry-run${bad}`,
        headers: h.headers,
      });
      expect(res.statusCode, bad).toBe(400);
      expect((res.json() as { error: string }).error, bad).toBe(
        'invalid-query',
      );
    }
  });

  it('is read-only: zero audit rows, zero WS events, mirror/rules/settings untouched', async () => {
    const h = await boot();
    seedMirror(h.store);
    const rule = await createRule(h);

    const settingsDump = (): unknown =>
      h.store.db.prepare('SELECT key, value FROM settings ORDER BY key').all();
    const auditBefore = auditTrail(h.store); // the rule.created row only
    expect(auditBefore).toHaveLength(1);
    const settingsBefore = settingsDump();
    const ruleBefore = h.store.getRule(rule.id);
    const mirrorBefore = h.store.listRecentInboundMessages(1000);

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

    // Two calls, both with hits in the window — still no writes anywhere.
    expect((await dryRunCall(h, rule.id)).body.matched).toBe(DEFAULT_MATCHED);
    expect((await dryRunCall(h, rule.id, '?limit=10')).statusCode).toBe(200);
    await sleep(200);
    socket.close();

    expect(frames).toEqual([]);
    expect(auditTrail(h.store)).toEqual(auditBefore);
    expect(settingsDump()).toEqual(settingsBefore);
    expect(h.store.getRule(rule.id)).toEqual(ruleBefore);
    expect(h.store.listRecentInboundMessages(1000)).toEqual(mirrorBefore);
  });

  it('dry-runs a DISABLED rule identically (editor affordance, UI §3 S3)', async () => {
    const h = await boot();
    seedMirror(h.store);
    const rule = await createRule(h);
    const enabledRun = await dryRunCall(h, rule.id);
    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/v1/rules/${rule.id}`,
      headers: h.headers,
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    const disabledRun = await dryRunCall(h, rule.id);
    expect(disabledRun.statusCode).toBe(200);
    expect(disabledRun.body).toEqual(enabledRun.body);
    expect(disabledRun.body.matched).toBe(DEFAULT_MATCHED);
  });

  it('404s an unknown rule, inherits auth posture, and replays an empty mirror', async () => {
    const h = await boot();
    const rule = await createRule(h);

    const missing = await h.server.app.inject({
      method: 'GET',
      url: '/v1/rules/01BX5ZZKBKACTAV9WEVGEMMVRZ/dry-run',
      headers: h.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not-found' });

    // §2.4.2 fail-closed posture inherited by the new route.
    const noBearer = await h.server.app.inject({
      method: 'GET',
      url: `/v1/rules/${rule.id}/dry-run`,
    });
    expect(noBearer.statusCode).toBe(401);

    // Empty mirror: nothing seeded → an empty, well-formed replay.
    const empty = await dryRunCall(h, rule.id);
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toEqual({ total: 0, matched: 0, rows: [] });
  });
});

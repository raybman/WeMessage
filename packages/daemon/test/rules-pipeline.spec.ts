/**
 * S2 Scenario 9 — Match pipeline wired into the composed daemon (resolves S1
 * deviation #1). s2-execution Part 2 Scenario 9; §1.7 (eligibility), §1.8
 * (audit chokepoint), §3.4 (rule.matched wire shape), §2.4.4 (mutation
 * events are audit material).
 *
 * Composition per the S1 Scenario 11 harness: real store, fixture chat.db,
 * fake FsWatcher, real WS clients. Rules are seeded via store.insertRule
 * (not the CRUD routes) so audit-row assertions are not polluted by
 * rule.created entries; per-burst store.listRules() loading makes the two
 * paths equivalent for the pipeline.
 *
 * F-12: core returns the FULL ordered match list; the daemon takes list[0]
 * as the single winner (priority ASC, id ASC). F-15: in-process
 * (ruleId, guid) seen-set; restart duplicates accepted in S2.
 *
 * Edits that must KEEP matching use raw date_edited UPDATEs (no summary
 * blob): fixture.editMessage plants the corpus summary-info blob whose
 * latest revision ('GL-FIX-005 edited body (v2)') is authoritative and
 * contains no trigger word (Scenario 8 precedent).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Actor,
  AuditEvent,
  Clock,
  FsWatcher,
  Rule,
} from '@wemessage/core';
import {
  appleEpochNs,
  createChatDb,
  type ChatDbFixture,
} from '@wemessage/fixtures';
import { createClient } from '@wemessage/client';
import type { GatewayEventPayload } from '@wemessage/protocol';
import {
  createAuditSink,
  startDaemon,
  type AuditSink,
  type DoctorProbes,
  type RunningDaemon,
} from '@wemessage/daemon';
import { createUnusedSendBackend } from './helpers/loopback-backend.js';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

// s3 Scenario 7: startDaemon requires explicit doctorProbes; never a real
// osascript call in a test (test/arch.spec.ts gate (b)).
const fullyConnectedProbes: DoctorProbes = {
  osMajor: () => 15,
  fda: async () => 'ok',
  automation: async () => 'ok',
  messagesRunning: async () => true,
};

interface FakeWatcher extends FsWatcher {
  fire: () => void;
}

function fakeWatcher(): FakeWatcher {
  const handlers: (() => void)[] = [];
  return {
    watch(_paths, onChange) {
      handlers.push(onChange);
      return () => {
        handlers.length = 0;
      };
    },
    fire: () => {
      for (const h of [...handlers]) h();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000, // generous: composed daemons flake under full-suite parallel load
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Deterministic 26-char ULID-alphabet ids so id-ASC tiebreaks are visible. */
function ruleId(tail: string): string {
  return `${'0'.repeat(26 - tail.length)}${tail}`;
}

function makeRule(overrides: Partial<Rule> & { id: string }): Rule {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    name: `rule-${overrides.id}`,
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: 'echo',
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 240,
    priority: 100,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

interface Ctx {
  daemon: RunningDaemon;
  fixture: ChatDbFixture;
  watcher: FakeWatcher;
  chatId: number;
  handleId: number;
  events: GatewayEventPayload[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function boot(opts?: {
  createAuditSink?: (deps: Parameters<typeof createAuditSink>[0]) => AuditSink;
}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), 'wm-rules-pipe-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  cleanups.push(() => fixture.close());
  const handleId = fixture.addHandle('+15550002222');
  const chatId = fixture.addChat({ identifier: '+15550002222' });
  const watcher = fakeWatcher();
  const daemon = await startDaemon({
    configDir,
    chatDbPath,
    clock,
    watcher,
    doctorProbes: fullyConnectedProbes,
    backend: createUnusedSendBackend(),
    backendName: 'unused',
    ...(opts?.createAuditSink ? { createAuditSink: opts.createAuditSink } : {}),
  });
  cleanups.push(() => daemon.stop());
  const token = daemon.server.token;
  if (token === null) throw new Error('boot: expected a token');

  const events: GatewayEventPayload[] = [];
  const client = createClient({
    baseUrl: `http://127.0.0.1:${daemon.port}`,
    token,
  });
  const sub = await client.events((e) => events.push(e));
  cleanups.push(() => sub.close());
  await waitFor(() => events.length >= 1, 'connection.state greeting');

  return { daemon, fixture, watcher, chatId, handleId, events };
}

function auditTrail(c: Ctx): { event: AuditEvent; actor: Actor }[] {
  return c.daemon.store.readAuditRows(0, 1000).map((row) => ({
    event: JSON.parse(row.eventJson) as AuditEvent,
    actor: JSON.parse(row.actorJson) as Actor,
  }));
}

function matchedAudit(c: Ctx): { event: AuditEvent; actor: Actor }[] {
  return auditTrail(c).filter((r) => r.event.type === 'rule.matched');
}

function matchedEvents(c: Ctx): GatewayEventPayload[] {
  return c.events.filter((e) => e.event === 'rule.matched');
}

/** Raw in-place edit WITHOUT the summary blob: text column stays decisive. */
function rawEdit(c: Ctx, guid: string, text: string, atIso: string): void {
  c.fixture.db
    .prepare('UPDATE message SET text = ?, date_edited = ? WHERE guid = ?')
    .run(text, appleEpochNs(atIso), guid);
}

describe('match pipeline (§3.4 rule.matched, S1 deviation #1 resolved)', () => {
  it('a trigger row yields one rule.matched WS event + one matching audit row; non-matching rows yield neither', async () => {
    const c = await boot();
    const rule = makeRule({ id: ruleId('MATCH1') });
    c.daemon.store.insertRule(rule);

    const hit = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos at noon?',
    });
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 1, 'rule.matched frame');

    // §3.4 wire shape, exactly
    expect(matchedEvents(c)).toEqual([
      {
        event: 'rule.matched',
        guid: hit.guid,
        ruleId: rule.id,
        adapterId: 'echo',
      },
    ]);
    // the received frame precedes the matched frame for the same occurrence
    const kinds = c.events.map((e) => e.event);
    expect(kinds.indexOf('message.received')).toBeLessThan(
      kinds.indexOf('rule.matched'),
    );

    // exactly one audit row whose stored eventJson matches (§1.8)
    const audits = matchedAudit(c);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.event).toEqual({
      type: 'rule.matched',
      guid: hit.guid,
      ruleId: rule.id,
      adapterId: 'echo',
      ruleName: rule.name,
    });
    expect(audits[0]?.actor).toEqual({ kind: 'system', reason: 'rule-engine' });

    // non-matching row: received only, no new match event/audit
    c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX salad only',
    });
    c.watcher.fire();
    await waitFor(
      () => c.events.filter((e) => e.event === 'message.received').length >= 2,
      'second message.received',
    );
    expect(matchedEvents(c)).toHaveLength(1);
    expect(matchedAudit(c)).toHaveLength(1);
  });

  it('F-12 single winner: priorities 10 vs 20 -> exactly one event + one audit row for the priority-10 rule', async () => {
    const c = await boot();
    const low = makeRule({ id: ruleId('PRIO10'), priority: 10 });
    const high = makeRule({ id: ruleId('PRIO20'), priority: 20 });
    c.daemon.store.insertRule(high);
    c.daemon.store.insertRule(low);

    c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos twice over',
    });
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 1, 'winner frame');
    await new Promise((r) => setTimeout(r, 50)); // a second frame would land here

    expect(matchedEvents(c)).toHaveLength(1);
    const frame = matchedEvents(c)[0];
    if (frame?.event !== 'rule.matched') throw new Error('unreachable');
    expect(frame.ruleId).toBe(low.id);
    const audits = matchedAudit(c);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.event).toMatchObject({ ruleId: low.id });
  });

  it('F-12 tiebreak: equal priority -> id ASC winner', async () => {
    const c = await boot();
    const a = makeRule({ id: ruleId('AAAA'), priority: 50 });
    const b = makeRule({ id: ruleId('BBBB'), priority: 50 });
    c.daemon.store.insertRule(b);
    c.daemon.store.insertRule(a);

    c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos tie',
    });
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 1, 'tiebreak frame');
    await new Promise((r) => setTimeout(r, 50));

    expect(matchedEvents(c)).toHaveLength(1);
    const frame = matchedEvents(c)[0];
    if (frame?.event !== 'rule.matched') throw new Error('unreachable');
    expect(frame.ruleId).toBe(a.id);
  });

  it('exclusions end-to-end (INV-6): tapback, self-sent, and disabled-rule cases produce zero events/audit', async () => {
    const c = await boot();
    // burst 1: disabled rule is the ONLY rule; a matching normal message
    // must produce nothing (rule-eligibility exclusion).
    c.daemon.store.insertRule(makeRule({ id: ruleId('OFF'), enabled: false }));
    const target = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos disabled-rule',
    });
    c.watcher.fire();
    await waitFor(
      () => c.events.filter((e) => e.event === 'message.received').length >= 1,
      'disabled-rule burst received',
    );
    // burst 2: an ENABLED rule exists, but the only new rows are a tapback
    // and a self-sent message (message-eligibility exclusions, INV-6).
    c.daemon.store.insertRule(makeRule({ id: ruleId('ON') }));
    c.fixture.addTapback(target.guid, 2000, {
      chatId: c.chatId,
      handleId: c.handleId,
    });
    c.fixture.addSelfMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos from me',
    });
    c.watcher.fire();
    await waitFor(
      () => c.events.filter((e) => e.event === 'message.received').length >= 3,
      'three message.received frames',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(matchedEvents(c)).toHaveLength(0);
    expect(matchedAudit(c)).toHaveLength(0);
  });

  it('edit re-match with F-15 suppression: message.edited flows through, but the same (rule,guid) never matches twice', async () => {
    const c = await boot();
    const rule = makeRule({ id: ruleId('EDIT1') });
    c.daemon.store.insertRule(rule);
    const hit = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos original',
    });
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 1, 'first match');

    // in-place edit that STILL matches the same rule (Scenario 8 sweep)
    rawEdit(c, hit.guid, 'GL-FIX tacos edited body', '2026-02-01T00:00:00Z');
    c.watcher.fire();
    await waitFor(
      () => c.events.some((e) => e.event === 'message.edited'),
      'message.edited frame',
    );
    await new Promise((r) => setTimeout(r, 50));

    const edited = c.events.find((e) => e.event === 'message.edited');
    expect(edited).toEqual({
      event: 'message.edited',
      guid: hit.guid,
      newText: 'GL-FIX tacos edited body',
    });
    // §2.4.4: the mutation occurrence is audit material now
    expect(
      auditTrail(c).filter((r) => r.event.type === 'message.edited'),
    ).toEqual([
      {
        event: { type: 'message.edited', guid: hit.guid },
        actor: { kind: 'system', reason: 'ingest' },
      },
    ]);
    // F-15: the (ruleId, guid) seen-set suppresses the duplicate match
    expect(matchedEvents(c)).toHaveLength(1);
    expect(matchedAudit(c)).toHaveLength(1);
  });

  it('a DIFFERENT rule matching the same guid after an edit is NOT suppressed (seen-set is (ruleId, guid), not guid)', async () => {
    const c = await boot();
    const a = makeRule({ id: ruleId('WINA'), priority: 10 });
    const b = makeRule({ id: ruleId('WINB'), priority: 20 });
    c.daemon.store.insertRule(a);
    c.daemon.store.insertRule(b);
    const hit = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos round one',
    });
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 1, 'winner A');
    const first = matchedEvents(c)[0];
    if (first?.event !== 'rule.matched') throw new Error('unreachable');
    expect(first.ruleId).toBe(a.id);

    // A is disabled; the edited message now falls to winner B — a distinct
    // (ruleId, guid) pair that MUST fire (rules reload per burst).
    c.daemon.store.updateRule({ ...a, enabled: false });
    rawEdit(c, hit.guid, 'GL-FIX tacos round two', '2026-02-02T00:00:00Z');
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 2, 'winner B after edit');

    const second = matchedEvents(c)[1];
    if (second?.event !== 'rule.matched') throw new Error('unreachable');
    expect(second.ruleId).toBe(b.id);
    expect(second.guid).toBe(hit.guid);
    expect(matchedAudit(c)).toHaveLength(2);
  });

  it('unsend appends a message.unsent audit row alongside the WS frame (§2.4.4)', async () => {
    const c = await boot();
    const row = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX to be unsent',
    });
    c.watcher.fire();
    await waitFor(
      () => c.events.some((e) => e.event === 'message.received'),
      'received frame',
    );
    c.fixture.unsendMessage(row.guid);
    c.watcher.fire();
    await waitFor(
      () => c.events.some((e) => e.event === 'message.unsent'),
      'unsent frame',
    );
    expect(
      auditTrail(c).filter((r) => r.event.type === 'message.unsent'),
    ).toEqual([
      {
        event: { type: 'message.unsent', guid: row.guid },
        actor: { kind: 'system', reason: 'ingest' },
      },
    ]);
  });

  it('a malformed attributedBody row persists an ingest.decode-failed audit row while the message still degrades (§2.2.1)', async () => {
    const c = await boot();
    const bad = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      attributedBodyFixture: 'malformed-truncated',
    });
    c.watcher.fire();
    await waitFor(
      () => c.events.some((e) => e.event === 'message.received'),
      'degraded received frame',
    );
    const rows = auditTrail(c).filter(
      (r) => r.event.type === 'ingest.decode-failed',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      type: 'ingest.decode-failed',
      guid: bad.guid,
      sourceRowid: bad.rowid,
    });
    expect(rows[0]?.actor).toEqual({ kind: 'system', reason: 'ingest' });
    // degrade, not drop: the row still reached the mirror
    expect(c.daemon.store.getInboundMessage(bad.guid)).not.toBeNull();
  });

  it('ordering: the audit append lands before the WS broadcast for the same occurrence (the log is the record)', async () => {
    const calls: string[] = [];
    const c = await boot({
      createAuditSink: (deps) => {
        const real = createAuditSink(deps);
        return {
          // s7 Sc3: spread, so the wrapper keeps forwarding whatever the sink
          // grows next (SSE added `subscribe`/`subscriberCount`).
          ...real,
          append(event, actor) {
            calls.push(`append:${event.type}`);
            return real.append(event, actor);
          },
          broadcast(payload) {
            calls.push(`broadcast:${payload.event}`);
            real.broadcast(payload);
          },
        };
      },
    });
    c.daemon.store.insertRule(makeRule({ id: ruleId('ORDER') }));
    const hit = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'GL-FIX tacos ordered',
    });
    c.watcher.fire();
    await waitFor(() => matchedEvents(c).length >= 1, 'ordered match');
    expect(calls.indexOf('append:rule.matched')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('append:rule.matched')).toBeLessThan(
      calls.indexOf('broadcast:rule.matched'),
    );

    rawEdit(c, hit.guid, 'GL-FIX tacos reordered', '2026-02-03T00:00:00Z');
    c.watcher.fire();
    await waitFor(
      () => calls.includes('broadcast:message.edited'),
      'edited broadcast recorded',
    );
    expect(calls.indexOf('append:message.edited')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('append:message.edited')).toBeLessThan(
      calls.indexOf('broadcast:message.edited'),
    );
  });
});

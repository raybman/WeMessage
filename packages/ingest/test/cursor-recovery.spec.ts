/**
 * Scenario 9 — T-9.3: crash recovery, exactly-once, no replay-sends (spec
 * Part 2 #9; named S1 checkpoint, §4.0 wording is the contract; F-2
 * resolution: core/drafts/recovery applies sending->sent (ledger + chat.db
 * verified per the §2.2.2 predicate) and sending->failed
 * (error.code='unverified'); SendBackend is a must-not-call fake).
 *
 * Also per coordinator scope: cursor ahead of chat.db (restored-backup case)
 * self-heals, and torn/corrupt cursor state fails safe to a full rescan that
 * the guid dedup absorbs without duplicates.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { openStore, type SqliteStore } from '@wemessage/store';
import { createChatDbReader, createScanLoop } from '@wemessage/ingest';
import {
  runStartupRecovery,
  type Clock,
  type Message,
  type SendBackend,
} from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:00:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

interface Ctx {
  fixture: ChatDbFixture;
  chatId: number;
  chatGuid: string;
  handleId: number;
  store: SqliteStore;
  emitted: Message[];
  sendCalls: number;
  backend: SendBackend;
  scanner: (onMessage?: (m: Message) => void) => Promise<Message[]>;
  recover: () => ReturnType<typeof runStartupRecovery>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function ctx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'wm-recovery-'));
  const fixture = createChatDb(join(dir, 'chat.db'));
  const chatId = fixture.addChat({ identifier: '+15555550144' });
  const handleId = fixture.addHandle('+15555550144');
  const chatGuid = (
    fixture.db.prepare('SELECT guid FROM chat WHERE ROWID = ?').get(chatId) as {
      guid: string;
    }
  ).guid;
  const store = openStore({ dir: join(dir, 'store'), clock: fakeClock });
  const emitted: Message[] = [];
  const c: Ctx = {
    fixture,
    chatId,
    chatGuid,
    handleId,
    store,
    emitted,
    sendCalls: 0,
    backend: {
      isAvailable: () => Promise.resolve(true),
      send: () => {
        c.sendCalls += 1;
        return Promise.resolve({ accepted: true });
      },
    },
    scanner: (onMessage) =>
      createScanLoop({
        chatDbPath: fixture.path,
        store,
        clock: fakeClock,
        onMessage: (m) => {
          emitted.push(m);
          onMessage?.(m);
        },
      }).scanOnce(),
    recover: () => {
      const reader = createChatDbReader(fixture.path, { clock: fakeClock });
      cleanups.push(() => reader.close());
      return runStartupRecovery({
        store,
        reader,
        sendBackend: c.backend,
        clock: fakeClock,
      });
    },
  };
  cleanups.push(() => {
    store.close();
    fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return c;
}

function seedSendingDraft(
  c: Ctx,
  opts: { body: string; startedAt: string },
): string {
  const draftId = `01TESTDRAFT${Math.random().toString(36).slice(2, 8)}`;
  c.store.db
    .prepare(
      "INSERT INTO adapters (id, kind, display_name, enabled, token_hash) VALUES ('ad-test', 'generic', 'Test Adapter', 1, 'x') ON CONFLICT(id) DO NOTHING",
    )
    .run();
  c.store.db
    .prepare(
      `INSERT INTO drafts (id, inbound_guid, chat_guid, rule_id, adapter_id,
         idempotency_key, body, original_body, state, state_changed_at,
         expires_at, created_at)
       VALUES (?, NULL, ?, NULL, 'ad-test', ?, ?, ?, 'sending', ?, ?, ?)`,
    )
    .run(
      draftId,
      c.chatGuid,
      `idem-${draftId}`,
      opts.body,
      opts.body,
      opts.startedAt,
      '2026-12-31T00:00:00.000Z',
      opts.startedAt,
    );
  c.store.db
    .prepare(
      "INSERT INTO send_ledger (draft_id, attempt, backend, started_at) VALUES (?, 1, 'applescript', ?)",
    )
    .run(draftId, opts.startedAt);
  return draftId;
}

function draftRow(
  c: Ctx,
  id: string,
): {
  state: string;
  sent_message_guid: string | null;
  error: string | null;
} {
  return c.store.db
    .prepare('SELECT state, sent_message_guid, error FROM drafts WHERE id = ?')
    .get(id) as never;
}

function ledgerRow(
  c: Ctx,
  id: string,
): { verified_guid: string | null; finished_at: string | null } {
  return c.store.db
    .prepare(
      'SELECT verified_guid, finished_at FROM send_ledger WHERE draft_id = ?',
    )
    .get(id) as never;
}

describe('cursor-recovery (Scenario 9, T-9.3, §4.0 / §2.2.2 / F-2)', () => {
  it('crash after row 30 before cursor advance, then restart: all 50 processed exactly once', async () => {
    const c = ctx();
    const refs = c.fixture.addMessageBurst(50, {
      chatId: c.chatId,
      handleId: c.handleId,
      startAt: '2026-01-03T00:00:00Z',
    });

    // Crash at row 31's pre-commit point (the onRow hook throws).
    let seen = 0;
    await expect(
      c.scanner(() => {
        seen += 1;
        if (seen === 31) throw new Error('injected crash at row 31');
      }),
    ).rejects.toThrow(/injected crash/);
    expect(c.store.getCursor()).toBeNull(); // crash landed before cursor advance

    // Restart: fresh scan over the same store.
    await c.scanner();

    // Exactly once end-to-end: the mirror absorbed the overlap.
    const counts = c.store.db
      .prepare(
        'SELECT COUNT(*) AS total, COUNT(DISTINCT guid) AS distinctGuids FROM inbound_messages',
      )
      .get() as { total: number; distinctGuids: number };
    expect(counts.total).toBe(50);
    expect(counts.distinctGuids).toBe(50);

    // Every guid mirrored exactly once and cursor is correct.
    const guids = c.emitted.map((m) => m.guid);
    expect(new Set(guids).size).toBe(guids.length);
    expect(guids.length).toBeGreaterThanOrEqual(50);
    expect(c.store.getCursor()?.lastRowid).toBe(
      Math.max(...refs.map((r) => r.rowid)),
    );
    // The duplicate window (rows 1..30 re-scanned) produced zero re-emissions:
    // 30 pre-crash (31st threw before its own emit completed the burst) is
    // implementation detail; the mirror-level exactly-once above is the
    // contract. Emission-level: no guid appears twice.
    const dupes = guids.filter((g, i) => guids.indexOf(g) !== i);
    expect(dupes).toEqual([]);
  });

  it('cursor ahead of chat.db (restored backup) self-heals to max ROWID so new rows are not missed', async () => {
    const c = ctx();
    c.fixture.addMessageBurst(10, {
      chatId: c.chatId,
      handleId: c.handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    await c.scanner();
    const max = c.store.getCursor()?.lastRowid ?? 0;

    // chat.db restored from an older backup: cursor now points past head.
    c.store.setCursor({ lastRowid: max + 50, lastScanAt: FIXED_NOW });

    const result = await c.recover();
    expect(result.cursor.healed).toBe(true);
    expect(result.cursor.reason).toBe('ahead-of-chatdb');
    expect(c.store.getCursor()?.lastRowid).toBe(max);

    // New rows after the restore are picked up instead of silently skipped.
    const extra = c.fixture.addMessageBurst(3, {
      chatId: c.chatId,
      handleId: c.handleId,
      startAt: '2026-01-03T02:00:00Z',
    });
    const out = await c.scanner();
    expect(out.map((m) => m.guid)).toEqual(extra.map((r) => r.guid));
  });

  it('torn/corrupt cursor state fails safe: reset + full rescan with zero duplicates', async () => {
    const c = ctx();
    c.fixture.addMessageBurst(10, {
      chatId: c.chatId,
      handleId: c.handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    await c.scanner();
    const max = c.store.getCursor()?.lastRowid ?? 0;

    // Torn write: non-integer garbage in last_rowid.
    c.store.db
      .prepare("UPDATE cursor SET last_rowid = 'garbage' WHERE id = 1")
      .run();

    const result = await c.recover();
    expect(result.cursor.healed).toBe(true);
    expect(result.cursor.reason).toBe('corrupt');
    expect(c.store.getCursor()?.lastRowid).toBe(0);

    // Rescan: dedup absorbs everything, cursor returns to max.
    const out = await c.scanner();
    expect(out).toHaveLength(0);
    expect(c.emitted).toHaveLength(10);
    const counts = c.store.db
      .prepare(
        'SELECT COUNT(*) AS total, COUNT(DISTINCT guid) AS distinctGuids FROM inbound_messages',
      )
      .get() as { total: number; distinctGuids: number };
    expect(counts.total).toBe(10);
    expect(counts.distinctGuids).toBe(10);
    expect(c.store.getCursor()?.lastRowid).toBe(max);
  });

  it('healthy cursor is left untouched by recovery', async () => {
    const c = ctx();
    c.fixture.addMessageBurst(5, {
      chatId: c.chatId,
      handleId: c.handleId,
      startAt: '2026-01-03T00:00:00Z',
    });
    await c.scanner();
    const before = c.store.getCursor();
    const result = await c.recover();
    expect(result.cursor.healed).toBe(false);
    expect(c.store.getCursor()).toEqual(before);
  });

  it("'sending' draft with a matching is_from_me row -> sent, guid + ledger recorded, ZERO send calls (§2.2.2)", async () => {
    const c = ctx();
    const sent = c.fixture.addSelfMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'recovery probe body',
      at: '2026-01-04T01:00:00Z',
    });
    const draftId = seedSendingDraft(c, {
      body: 'recovery probe body',
      startedAt: '2026-01-04T00:00:00.000Z',
    });

    const result = await c.recover();

    expect(c.sendCalls).toBe(0); // §4.0: no second send call on the fake
    const d = draftRow(c, draftId);
    expect(d.state).toBe('sent');
    expect(d.sent_message_guid).toBe(sent.guid);
    const l = ledgerRow(c, draftId);
    expect(l.verified_guid).toBe(sent.guid);
    expect(l.finished_at).toBe(FIXED_NOW);
    expect(result.drafts).toEqual([
      { draftId, outcome: 'sent', sentMessageGuid: sent.guid },
    ]);
  });

  it("'sending' draft with NO matching row -> failed 'unverified', NOT re-sent, outcome audited in-memory (F-2)", async () => {
    const c = ctx();
    const draftId = seedSendingDraft(c, {
      body: 'this send never landed',
      startedAt: '2026-01-04T00:00:00.000Z',
    });

    const result = await c.recover();

    expect(c.sendCalls).toBe(0);
    const d = draftRow(c, draftId);
    expect(d.state).toBe('failed');
    expect(d.error).not.toBeNull();
    expect(JSON.parse(d.error ?? '{}')).toMatchObject({ code: 'unverified' });
    expect(ledgerRow(c, draftId).finished_at).toBe(FIXED_NOW);
    expect(result.drafts).toEqual([{ draftId, outcome: 'failed' }]);
    expect(
      result.audit.some(
        (e) => e.event === 'draft.recovery' && e.detail.draftId === draftId,
      ),
    ).toBe(true);
  });

  it('§2.2.2 predicate requires date >= started_at: an older identical self row does NOT verify', async () => {
    const c = ctx();
    c.fixture.addSelfMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'recovery probe body',
      at: '2026-01-03T00:00:00Z', // BEFORE started_at
    });
    const draftId = seedSendingDraft(c, {
      body: 'recovery probe body',
      startedAt: '2026-01-04T00:00:00.000Z',
    });
    await c.recover();
    expect(draftRow(c, draftId).state).toBe('failed');
    expect(c.sendCalls).toBe(0);
  });
});

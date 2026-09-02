/**
 * S2 Scenario 9 — Audit persistence of the S1 recovery trails (resolves S1
 * deviation #1). s2-execution Part 2 Scenario 9; §2.5 boot order; F-16
 * system actor reason 'recovery'; §1.8 chokepoint.
 *
 * The S1 `StartupRecoveryResult.audit` in-memory trail is persisted to
 * `audit_log` DURING boot phase 1 — before the watcher is armed and before
 * `listen` — so the recovery record exists even if the daemon dies right
 * after recovering. Draft/store seeding follows the cursor-recovery.spec
 * raw-SQL convention (drafts do not have a public insert API until S4).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, AuditEvent, Clock, FsWatcher } from '@wemessage/core';
import { createChatDb } from '@wemessage/fixtures';
import { SqliteStore } from '@wemessage/store';
import {
  createAuditSink,
  startDaemon,
  type RunningDaemon,
} from '@wemessage/daemon';

const clock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Seeded {
  configDir: string;
  chatDbPath: string;
}

/** Fresh fixture chat.db + config dir, with a hook to pre-seed the store. */
function seed(prepare?: (store: SqliteStore) => void): Seeded {
  const dir = mkdtempSync(join(tmpdir(), 'wm-audit-persist-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, 'config');
  const chatDbPath = join(dir, 'chat.db');
  const fixture = createChatDb(chatDbPath);
  const handleId = fixture.addHandle('+15550003333');
  const chatId = fixture.addChat({ identifier: '+15550003333' });
  fixture.addMessage({ chatId, handleId, text: 'GL-FIX audit baseline row' });
  fixture.close();

  if (prepare) {
    const pre = new SqliteStore({ dir: configDir, clock });
    prepare(pre);
    pre.close();
  }
  return { configDir, chatDbPath };
}

/** cursor-recovery.spec convention: a draft parked in state 'sending'. */
function seedSendingDraft(store: SqliteStore, draftId: string): void {
  store.db
    .prepare(
      "INSERT INTO adapters (id, kind, display_name, enabled, token_hash) VALUES ('ad-test', 'generic', 'Test Adapter', 1, 'x') ON CONFLICT(id) DO NOTHING",
    )
    .run();
  store.db
    .prepare(
      `INSERT INTO drafts (id, inbound_guid, chat_guid, rule_id, adapter_id,
         idempotency_key, body, original_body, state, state_changed_at,
         expires_at, created_at)
       VALUES (?, NULL, 'iMessage;-;+15550003333', NULL, 'ad-test',
         ?, 'GL-FIX never sent', 'GL-FIX never sent', 'sending',
         '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z')`,
    )
    .run(draftId, `idem-${draftId}`);
  store.db
    .prepare(
      "INSERT INTO send_ledger (draft_id, attempt, backend, started_at) VALUES (?, 1, 'applescript', '2026-01-01T00:00:00.000Z')",
    )
    .run(draftId);
}

function trail(daemon: RunningDaemon): { event: AuditEvent; actor: Actor }[] {
  return daemon.store.readAuditRows(0, 1000).map((row) => ({
    event: JSON.parse(row.eventJson) as AuditEvent,
    actor: JSON.parse(row.actorJson) as Actor,
  }));
}

const idleWatcher: FsWatcher = { watch: () => () => undefined };

describe('S1 recovery trails persisted to audit_log (phase 1, §2.5)', () => {
  it("a parked 'sending' draft yields a recovery.draft row with the F-16 system actor", async () => {
    const draftId = '01TESTDRAFTAUDITPERSIST001';
    const seeded = seed((store) => seedSendingDraft(store, draftId));
    const daemon = await startDaemon({
      ...seeded,
      clock,
      watcher: idleWatcher,
    });
    cleanups.push(() => daemon.stop());

    expect(daemon.bootLog).toEqual(['recovery', 'watcher', 'listen']);
    // the in-memory S1 trail recorded the park...
    expect(daemon.recovery.drafts).toEqual([{ draftId, outcome: 'failed' }]);
    // ...and S2 persisted it (deviation #1 resolved)
    const rows = trail(daemon).filter((r) => r.event.type === 'recovery.draft');
    expect(rows).toEqual([
      {
        event: {
          type: 'recovery.draft',
          draftId,
          outcome: 'failed',
          code: 'unverified',
        },
        actor: { kind: 'system', reason: 'recovery' },
      },
    ]);
  });

  it('a doctored (ahead-of-chatdb) cursor yields a recovery.cursor row', async () => {
    const seeded = seed((store) => {
      store.setCursor({
        lastRowid: 9_999,
        lastScanAt: '2026-01-01T00:00:00.000Z',
      });
    });
    const daemon = await startDaemon({
      ...seeded,
      clock,
      watcher: idleWatcher,
    });
    cleanups.push(() => daemon.stop());

    expect(daemon.recovery.cursor.healed).toBe(true);
    const rows = trail(daemon).filter(
      (r) => r.event.type === 'recovery.cursor',
    );
    expect(rows).toEqual([
      {
        event: {
          type: 'recovery.cursor',
          reason: 'ahead-of-chatdb',
          lastRowid: 1, // healed back to the fixture head
        },
        actor: { kind: 'system', reason: 'recovery' },
      },
    ]);
  });

  it('recovery rows are persisted during phase 1 — before the watcher is armed, hence before listen', async () => {
    const order: string[] = [];
    const draftId = '01TESTDRAFTAUDITPERSIST002';
    const seeded = seed((store) => seedSendingDraft(store, draftId));
    const watcher: FsWatcher = {
      watch: () => {
        order.push('watcher-armed');
        return () => undefined;
      },
    };
    const daemon = await startDaemon({
      ...seeded,
      clock,
      watcher,
      createAuditSink: (deps) => {
        const real = createAuditSink(deps);
        return {
          append(event, actor) {
            order.push(`append:${event.type}`);
            return real.append(event, actor);
          },
          addClient: (socket) => real.addClient(socket),
          broadcast: (payload) => real.broadcast(payload),
        };
      },
    });
    cleanups.push(() => daemon.stop());

    const appendIdx = order.indexOf('append:recovery.draft');
    const watcherIdx = order.indexOf('watcher-armed');
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    expect(watcherIdx).toBeGreaterThan(appendIdx);
    // §2.5 boot order preserved end-to-end
    expect(daemon.bootLog).toEqual(['recovery', 'watcher', 'listen']);
  });

  it('a clean boot (nothing to recover) appends zero recovery rows', async () => {
    const seeded = seed();
    const daemon = await startDaemon({
      ...seeded,
      clock,
      watcher: idleWatcher,
    });
    cleanups.push(() => daemon.stop());
    const rows = trail(daemon).filter(
      (r) =>
        r.event.type === 'recovery.draft' || r.event.type === 'recovery.cursor',
    );
    expect(rows).toEqual([]);
  });
});

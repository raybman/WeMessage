/**
 * S2 Scenario 8 — Mutation visibility: in-place edits/unsends reach the
 * pipeline (resolves S1 deviation #2). s2-execution Part 2 Scenario 8;
 * §1.3.8 edited/unsent rows; §2.2.1 read-only + busy semantics.
 *
 * The ROWID cursor can never see UPDATEs to already-scanned rows. The scan
 * burst gains step 2: after the ROWID pass, `readMutatedSince` sweeps rows
 * whose date_edited/date_retracted exceed a persisted ns watermark
 * (settings['ingest.mutationWatermarkNs'], DECIMAL STRING — Apple-epoch ns
 * exceed 2^53, so float/ISO representations truncate), routes hits through
 * `onMutation`, refreshes the mirror, and only THEN advances the watermark
 * (crash mid-sweep re-delivers; a mutation is never silently dropped).
 *
 * Note on edit bodies: fixture.editMessage plants the S1 corpus
 * message_summary_info blob, and the summary-info latest revision is
 * authoritative over the text column (S1 normalizer rule, reused verbatim) —
 * so the normalized post-edit body is 'GL-FIX-005 edited body (v2)'.
 * Rows needing controlled text/ns use raw date_edited UPDATEs (no blob →
 * text column wins).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb, type ChatDbFixture } from '@wemessage/fixtures';
import { openStore, type SqliteStore } from '@wemessage/store';
import {
  createChatDbReader,
  createScanLoop,
  type ScanLoop,
} from '@wemessage/ingest';
import type { Clock, Message } from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:00:00.000Z';
const fakeClock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

const WATERMARK_KEY = 'ingest.mutationWatermarkNs';
const CORPUS_EDIT_TEXT = 'GL-FIX-005 edited body (v2)';

interface Ctx {
  fixture: ChatDbFixture;
  chatId: number;
  handleId: number;
  store: SqliteStore;
  emitted: Message[];
  mutations: Message[];
  scanner: ScanLoop;
  /** Fresh scan-loop instance over the same store (restart simulation). */
  restart(onMutation?: (m: Message) => void): {
    scanner: ScanLoop;
    mutations: Message[];
  };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function ctx(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'wm-mutation-scan-'));
  const fixture = createChatDb(join(dir, 'chat.db'));
  const chatId = fixture.addChat({ identifier: '+15555550133' });
  const handleId = fixture.addHandle('+15555550133');
  const store = openStore({ dir: join(dir, 'store'), clock: fakeClock });
  const emitted: Message[] = [];
  const mutations: Message[] = [];
  const scanner = createScanLoop({
    chatDbPath: fixture.path,
    store,
    clock: fakeClock,
    onMessage: (m) => emitted.push(m),
    onMutation: (m) => mutations.push(m),
  });
  cleanups.push(() => {
    store.close();
    fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    fixture,
    chatId,
    handleId,
    store,
    emitted,
    mutations,
    scanner,
    restart(onMutation) {
      const restartMutations: Message[] = [];
      const restarted = createScanLoop({
        chatDbPath: fixture.path,
        store,
        clock: fakeClock,
        onMessage: () => {},
        onMutation: onMutation ?? ((m) => restartMutations.push(m)),
      });
      return { scanner: restarted, mutations: restartMutations };
    },
  };
}

/** Seed 10 rows and run the baseline burst (S1 substrate). */
async function seedBaseline(c: Ctx): Promise<string[]> {
  const refs = c.fixture.addMessageBurst(10, {
    chatId: c.chatId,
    handleId: c.handleId,
    text: 'hello',
    startAt: '2026-01-02T00:00:00Z',
  });
  const first = await c.scanner.scanOnce();
  expect(first).toHaveLength(10);
  return refs.map((r) => r.guid);
}

describe('mutation sweep (S2 Scenario 8 — resolves S1 deviation #2)', () => {
  it('baseline: 10 rows scanned, cursor at head, mirror populated, zero mutations', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    expect(c.emitted).toHaveLength(10);
    expect(c.mutations).toHaveLength(0);
    const cursor = c.store.getCursor();
    expect(cursor?.lastRowid).toBe(10);
    for (const guid of guids) {
      expect(c.store.getInboundMessage(guid)).not.toBeNull();
    }
  });

  it('in-place edit of a mirrored row: one edit emission, mirror refreshed, cursor unchanged', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    const target = guids[4]!;
    c.fixture.editMessage(target, 'v2');
    const second = await c.scanner.scanOnce();
    expect(second).toHaveLength(0); // no ROWID moved
    expect(c.emitted).toHaveLength(10); // onMessage untouched by the sweep
    expect(c.mutations).toHaveLength(1);
    const mutation = c.mutations[0]!;
    expect(mutation.guid).toBe(target);
    expect(mutation.kind).toBe('edit');
    // summary-info latest revision is authoritative (S1 normalizer reused)
    expect(mutation.text).toBe(CORPUS_EDIT_TEXT);
    expect(mutation.editedAt).toBeDefined();
    // mirror refreshed in place
    expect(c.store.getInboundMessage(target)).toStrictEqual(mutation);
    // cursor untouched by the sweep
    expect(c.store.getCursor()?.lastRowid).toBe(10);
  });

  it('unsend of a mirrored row: one unsend emission, mirror kind updated, text nulled', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    const target = guids[2]!;
    c.fixture.unsendMessage(target);
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(1);
    const mutation = c.mutations[0]!;
    expect(mutation.guid).toBe(target);
    expect(mutation.kind).toBe('unsend');
    expect(mutation.text).toBeNull();
    const mirrored = c.store.getInboundMessage(target);
    expect(mirrored?.kind).toBe('unsend');
    expect(mirrored?.text).toBeNull();
  });

  it('watermark persists, no re-emission, and a LATER second edit emits again', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    const target = guids[0]!;
    c.fixture.editMessage(target, 'v2');
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(1);
    const watermark = c.store.getSetting(WATERMARK_KEY);
    expect(watermark).toMatch(/^\d+$/); // decimal ns string
    // second burst, nothing new mutated: emits nothing, watermark stable
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(1);
    expect(c.store.getSetting(WATERMARK_KEY)).toBe(watermark);
    // a LATER second edit of the SAME guid emits again
    c.fixture.editMessage(target, 'v3');
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(2);
    expect(c.mutations[1]?.guid).toBe(target);
    expect(BigInt(c.store.getSetting(WATERMARK_KEY) ?? '0')).toBeGreaterThan(
      BigInt(watermark ?? '0'),
    );
  });

  it('ns precision: 1ns-apart mutations are not conflated (decimal-string watermark)', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    // Raw ns beyond 2^53: Number(X) === Number(X + 1n) — a float watermark
    // conflates these, the decimal string must not.
    const X = 800_000_000_000_000_001n;
    const rawEdit = c.fixture.db.prepare(
      'UPDATE message SET text = ?, date_edited = ? WHERE guid = ?',
    );
    rawEdit.run('edit-a', X, guids[0]!);
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(1);
    expect(c.mutations[0]?.text).toBe('edit-a'); // no blob → text column wins
    expect(c.store.getSetting(WATERMARK_KEY)).toBe('800000000000000001');
    rawEdit.run('edit-b', X + 1n, guids[1]!);
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(2);
    expect(c.mutations[1]?.text).toBe('edit-b');
    expect(c.store.getSetting(WATERMARK_KEY)).toBe('800000000000000002');
  });

  it('restart: a fresh scan-loop over the same store re-emits nothing (watermark durable)', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    c.fixture.editMessage(guids[6]!, 'v2');
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(1);
    const restarted = c.restart();
    const again = await restarted.scanner.scanOnce();
    expect(again).toHaveLength(0);
    expect(restarted.mutations).toHaveLength(0);
  });

  it('rows arriving ALREADY edited come through the ROWID path exactly once (no double emission)', async () => {
    const c = ctx();
    await seedBaseline(c);
    // new row lands and is edited BEFORE the next burst (the S1-visible case)
    const ref = c.fixture.addMessage({
      chatId: c.chatId,
      handleId: c.handleId,
      text: 'original',
      at: '2026-01-03T00:00:00Z',
    });
    c.fixture.editMessage(ref.guid, 'v2');
    const burst = await c.scanner.scanOnce();
    expect(burst).toHaveLength(1);
    expect(burst[0]?.guid).toBe(ref.guid);
    expect(burst[0]?.kind).toBe('edit'); // arrived already-edited
    expect(c.mutations).toHaveLength(0); // ROWID path delivered it — once
    expect(c.store.getInboundMessage(ref.guid)?.kind).toBe('edit');
    // and the sweep does not re-deliver it on the NEXT burst either
    await c.scanner.scanOnce();
    expect(c.mutations).toHaveLength(0);
  });

  it('crash-shaped: watermark advances only after delivery — a restart re-delivers the dropped edit', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    const target = guids[3]!;
    // wire a scanner whose onMutation crashes (delivery never succeeded)
    const crashing = c.restart(() => {
      throw new Error('daemon died mid-delivery');
    });
    c.fixture.editMessage(target, 'v2');
    await expect(crashing.scanner.scanOnce()).rejects.toThrow(
      'daemon died mid-delivery',
    );
    // restart with a healthy consumer: the edit MUST be re-delivered —
    // the watermark may only advance after emission succeeded
    const healthy = c.restart();
    await healthy.scanner.scanOnce();
    expect(healthy.mutations).toHaveLength(1);
    expect(healthy.mutations[0]?.guid).toBe(target);
    expect(healthy.mutations[0]?.text).toBe(CORPUS_EDIT_TEXT);
    // mirror-state comparison catches the drop: mirror reflects the edit
    expect(c.store.getInboundMessage(target)?.text).toBe(CORPUS_EDIT_TEXT);
  });

  it('SQLITE_BUSY during the sweep shares the burst backoff (retry succeeds)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-mutation-busy-'));
    const fixture = createChatDb(join(dir, 'chat.db'));
    const chatId = fixture.addChat({ identifier: '+15555550134' });
    const handleId = fixture.addHandle('+15555550134');
    const store = openStore({ dir: join(dir, 'store'), clock: fakeClock });
    cleanups.push(() => {
      store.close();
      fixture.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const refs = fixture.addMessageBurst(3, {
      chatId,
      handleId,
      text: 'hello',
      startAt: '2026-01-02T00:00:00Z',
    });
    const mutations: Message[] = [];
    const sleeps: number[] = [];
    let busyLeft = 1;
    const scanner = createScanLoop({
      chatDbPath: fixture.path,
      store,
      clock: fakeClock,
      onMessage: () => {},
      onMutation: (m) => mutations.push(m),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      openReader: (path, options) => {
        const real = createChatDbReader(path, options);
        return {
          ...real,
          readMutatedSince(sinceNs: string) {
            if (busyLeft > 0) {
              busyLeft -= 1;
              const err = new Error('database is locked') as Error & {
                code: string;
              };
              err.code = 'SQLITE_BUSY';
              throw err;
            }
            return real.readMutatedSince(sinceNs);
          },
        };
      },
    });
    await scanner.scanOnce(); // baseline (sweep busy → one retry)
    fixture.editMessage(refs[0]!.guid, 'v2');
    await scanner.scanOnce();
    expect(mutations).toHaveLength(1);
    expect(sleeps).toEqual([50]); // §2.2.1 backoff start, shared with burst
  });

  it('reader stays strictly read-only through readMutatedSince (§2.2.1 re-run)', async () => {
    const c = ctx();
    const guids = await seedBaseline(c);
    c.fixture.editMessage(guids[0]!, 'v2');
    const reader = createChatDbReader(c.fixture.path, { clock: fakeClock });
    cleanups.push(() => reader.close());
    const mutated = await reader.readMutatedSince('0');
    expect(mutated.length).toBeGreaterThan(0);
    expect(mutated[0]?.message.kind).toBe('edit');
    expect(mutated[0]?.mutationNs).toMatch(/^\d+$/);
    expect(reader.isReadonly()).toBe(true);
    expect(() =>
      reader.rawDb
        .prepare('UPDATE message SET text = ? WHERE guid = ?')
        .run('tamper', guids[0]!),
    ).toThrow(/readonly|attempt to write/i);
  });
});

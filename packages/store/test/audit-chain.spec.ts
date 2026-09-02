/**
 * S2 NAMED CHECKPOINT (part 2) — "append + verify + tamper detection".
 * Spec: docs/plans/slices/s2-execution.md Part 2 Scenario 6; §1.5 audit
 * group; §1.8 chain semantics; F-13 (frozen encoding); F-19 (listAudit
 * pagination semantics).
 *
 * Real temp-dir SqliteStore, fake Clock. The raw `db` handle is used ONLY
 * to tamper (test-dir exemption of the Scenario 1(d) append-only grep —
 * this file is the sanctioned tamper-harness home).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRow, Clock, Store } from '@wemessage/core';
import { chainHash, GENESIS_HASH } from '@wemessage/core';
import {
  openStore,
  verifyAuditChain,
  type SqliteStore,
} from '@wemessage/store';

function fakeClock(iso = '2026-09-01T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

// Golden quadruple — SAME externally computed (python hashlib) vector that
// pins the F-13 encoding in core's audit-chain-core.spec.ts (Scenario 4).
// The store's first append must reproduce it byte-exactly.
const AT_1 = '2026-09-01T12:00:00.000Z';
const EVENT_1 = '{"type":"rule.created","ruleId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}';
const ACTOR_1 = '{"kind":"human","via":"api"}';
const GOLDEN_1 =
  '8b6ae6181ce57fe343597d546b1f9f130e1080b67231a92b35ef9beecb3440a5';

const HUMAN_ACTOR = '{"kind":"human","via":"api"}';

/** Append `count` distinct, valid-JSON events; returns the append results. */
function appendN(
  store: SqliteStore,
  count: number,
  opts: { type?: string; startAt?: number } = {},
) {
  const results = [];
  const type = opts.type ?? 'rule.created';
  const start = opts.startAt ?? 0;
  for (let i = 0; i < count; i += 1) {
    const second = String((start + i) % 60).padStart(2, '0');
    const minute = String(Math.floor((start + i) / 60) % 60).padStart(2, '0');
    results.push(
      store.appendAudit({
        at: `2026-09-01T12:${minute}:${second}.000Z`,
        eventJson: JSON.stringify({ type, ruleId: `R-${start + i}` }),
        actorJson: HUMAN_ACTOR,
      }),
    );
  }
  return results;
}

describe('store audit chain — append + verify + tamper detection (s2 Scenario 6 checkpoint)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-audit-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('appendAudit', () => {
    it('first append: seq 1, genesis prev_hash, hash matches the core golden', () => {
      const result = store.appendAudit({
        at: AT_1,
        eventJson: EVENT_1,
        actorJson: ACTOR_1,
      });
      expect(result).toEqual({ seq: 1, hash: GOLDEN_1 });
      const [row] = store.readAuditRows(0, 10);
      expect(row).toEqual({
        seq: 1,
        at: AT_1,
        eventJson: EVENT_1,
        actorJson: ACTOR_1,
        prevHash: GENESIS_HASH,
        hash: GOLDEN_1,
      });
    });

    it('N appends: seq strictly 1..N gapless, each prev_hash = prior hash', () => {
      const results = appendN(store, 10);
      expect(results.map((r) => r.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      const rows = store.readAuditRows(0, 100);
      expect(rows).toHaveLength(10);
      let prev = GENESIS_HASH;
      rows.forEach((row, i) => {
        expect(row.seq).toBe(i + 1);
        expect(row.prevHash).toBe(prev);
        expect(row.hash).toBe(
          chainHash(row.prevHash, row.at, row.eventJson, row.actorJson),
        );
        prev = row.hash;
      });
    });

    it('hashes the STORED text verbatim: key-reordered-but-equal JSON appends and verifies green (F-13)', () => {
      appendN(store, 1);
      // Non-canonical key order — semantically equal to HUMAN_ACTOR. If
      // append (or verify) ever re-serialized instead of hashing the stored
      // TEXT, this chain would break.
      const reorderedActor = '{"via":"api","kind":"human"}';
      const result = store.appendAudit({
        at: AT_1,
        eventJson: EVENT_1,
        actorJson: reorderedActor,
      });
      const rows = store.readAuditRows(0, 10);
      const second = rows[1] as AuditRow;
      expect(second.actorJson).toBe(reorderedActor); // stored verbatim
      expect(result.hash).toBe(
        chainHash(second.prevHash, AT_1, EVENT_1, reorderedActor),
      );
      expect(verifyAuditChain(store)).toEqual({ ok: true, length: 2 });
    });
  });

  describe('listAudit (F-19 pagination semantics)', () => {
    // Five rows: distinct at, mixed event types.
    const TYPES = [
      'rule.created',
      'rule.matched',
      'rule.deleted',
      'rule.matched',
      'rule.enabled',
    ];

    beforeEach(() => {
      TYPES.forEach((type, i) => {
        store.appendAudit({
          at: `2026-09-01T12:00:0${i + 1}.000Z`,
          eventJson: JSON.stringify({ type, n: i + 1 }),
          actorJson: HUMAN_ACTOR,
        });
      });
    });

    it('returns reverse-chron (seq DESC)', () => {
      expect(store.listAudit({ limit: 100 }).map((r) => r.seq)).toEqual([
        5, 4, 3, 2, 1,
      ]);
    });

    it('honors limit', () => {
      expect(store.listAudit({ limit: 2 }).map((r) => r.seq)).toEqual([5, 4]);
    });

    it('sinceAt is an inclusive ISO lower bound', () => {
      const rows = store.listAudit({
        sinceAt: '2026-09-01T12:00:03.000Z',
        limit: 100,
      });
      expect(rows.map((r) => r.seq)).toEqual([5, 4, 3]);
    });

    it('event is an exact type filter (matches the JSON "type" of the stored event)', () => {
      const rows = store.listAudit({ event: 'rule.matched', limit: 100 });
      expect(rows.map((r) => r.seq)).toEqual([4, 2]);
      expect(
        store.listAudit({ event: 'rule.matched', limit: 1 }).map((r) => r.seq),
      ).toEqual([4]);
      expect(store.listAudit({ event: 'rule', limit: 100 })).toEqual([]); // exact, not prefix
    });

    it('sinceSeq is an exclusive lower bound', () => {
      expect(
        store.listAudit({ sinceSeq: 3, limit: 100 }).map((r) => r.seq),
      ).toEqual([5, 4]);
    });

    it('filters compose (AND)', () => {
      const rows = store.listAudit({
        sinceAt: '2026-09-01T12:00:02.000Z',
        event: 'rule.matched',
        limit: 100,
      });
      expect(rows.map((r) => r.seq)).toEqual([4, 2]);
    });
  });

  describe('readAuditRows (chain-walk pagination)', () => {
    it('walks the full chain in chunks: seq > afterSeq, seq ASC, limit rows', () => {
      appendN(store, 10);
      expect(store.readAuditRows(0, 4).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
      expect(store.readAuditRows(4, 4).map((r) => r.seq)).toEqual([5, 6, 7, 8]);
      expect(store.readAuditRows(8, 4).map((r) => r.seq)).toEqual([9, 10]);
      expect(store.readAuditRows(10, 4)).toEqual([]);
    });
  });

  describe('verifyAuditChain (chunked walk over readAuditRows; walk logic = core verifyChain)', () => {
    it(
      'verifies green over 1,000 appended rows with bounded chunks',
      { timeout: 30_000 },
      () => {
        appendN(store, 1000);
        // Wrap the source so we can PROVE bounded memory: no single chunk
        // read may exceed the requested size.
        const chunkSizes: number[] = [];
        const bounded = {
          readAuditRows: (afterSeq: number, limit: number): AuditRow[] => {
            const rows = store.readAuditRows(afterSeq, limit);
            chunkSizes.push(rows.length);
            return rows;
          },
        };
        expect(verifyAuditChain(bounded, 128)).toEqual({
          ok: true,
          length: 1000,
        });
        expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(128);
        expect(chunkSizes.length).toBeGreaterThanOrEqual(Math.ceil(1000 / 128));
      },
    );
  });

  describe('tamper detection (raw db handle, test-only)', () => {
    beforeEach(() => {
      appendN(store, 6);
    });

    it('(a) UPDATE of a middle row event TEXT -> hash-mismatch at that seq', () => {
      store.db
        .prepare('UPDATE audit_log SET event = ? WHERE seq = 3')
        .run('{"type":"rule.created","ruleId":"DOCTORED"}');
      const res = verifyAuditChain(store);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.brokenAtSeq).toBe(3);
        expect(res.reason).toBe('hash-mismatch');
      }
    });

    it('(b) DELETE of a middle row -> seq-gap at the successor', () => {
      store.db.prepare('DELETE FROM audit_log WHERE seq = 3').run();
      const res = verifyAuditChain(store);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.brokenAtSeq).toBe(4);
        expect(res.reason).toBe('seq-gap');
      }
    });

    it('(c) recompute-and-rewrite of a middle row without fixing successors -> link-broken at the successor', () => {
      const [row3] = store.readAuditRows(2, 1) as [AuditRow];
      const doctoredEvent = '{"type":"rule.created","ruleId":"REWRITTEN"}';
      const doctoredHash = chainHash(
        row3.prevHash,
        row3.at,
        doctoredEvent,
        row3.actorJson,
      );
      // Self-consistent row 3 (its own hash recomputed) — only the LINK to
      // seq 4 can betray the rewrite.
      store.db
        .prepare('UPDATE audit_log SET event = ?, hash = ? WHERE seq = 3')
        .run(doctoredEvent, doctoredHash);
      const res = verifyAuditChain(store);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.brokenAtSeq).toBe(4);
        expect(res.reason).toBe('link-broken');
      }
    });

    it('tamper on a chunk boundary is still caught by the chunked walk', () => {
      store.db
        .prepare('UPDATE audit_log SET event = ? WHERE seq = 3')
        .run('{"type":"rule.created","ruleId":"DOCTORED"}');
      // Chunk size 2: the doctored row is the first row of chunk #2.
      const res = verifyAuditChain(store, 2);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.brokenAtSeq).toBe(3);
        expect(res.reason).toBe('hash-mismatch');
      }
    });
  });

  describe('append-only API (§1.5: append-only is an API property, not a convention)', () => {
    it('the Store port and SqliteStore expose no audit mutation surface', () => {
      // Type-level probes — enforced because this project compiles specs
      // with tsc (vitest typecheck). Never executed.
      const probe = (impl: SqliteStore, port: Store): void => {
        // @ts-expect-error — append-only: no update path exists (s2 Scenario 6)
        impl.updateAudit(1, '{}');
        // @ts-expect-error — append-only: no delete path exists
        impl.deleteAuditRows(1);
        // @ts-expect-error — the core Store port has no updateAudit either
        port.updateAudit(1, '{}');
      };
      void probe;
      // Runtime confirmation of the same property.
      expect(
        (store as unknown as Record<string, unknown>)['updateAudit'],
      ).toBeUndefined();
      expect(
        (store as unknown as Record<string, unknown>)['deleteAuditRows'],
      ).toBeUndefined();
    });
  });

  describe('concurrency shape (transaction proof)', () => {
    it(
      'two interleaved appenders on one DB never produce duplicate/holed seq and the chain verifies green',
      { timeout: 30_000 },
      async () => {
        const runWorker = (label: string) =>
          new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
            const worker = new Worker(
              new URL('./helpers/append-worker.mjs', import.meta.url),
              { workerData: { dir, count: 150, label } },
            );
            worker.once('message', resolve);
            worker.once('error', reject);
          });
        const [a, b] = await Promise.all([runWorker('A'), runWorker('B')]);
        expect(a).toEqual({ ok: true });
        expect(b).toEqual({ ok: true });
        // Gapless 1..300 AND every prev_hash link intact: if either appender
        // ever read prev_hash outside its insert transaction, a stale link
        // would surface here as link-broken.
        expect(verifyAuditChain(store, 64)).toEqual({ ok: true, length: 300 });
      },
    );
  });
});

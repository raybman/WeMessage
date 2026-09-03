/**
 * s5-execution Scenario 3 — adapter registry in the store: CRUD, scrypt token
 * hashes, dual-validity rotation.
 *
 * The store is where a token stops being a secret we hold and becomes a hash
 * we compare. Two properties are load-bearing and are asserted as negatives,
 * because their positive forms are easy to fake: the plaintext token appears
 * NOWHERE in the database, and a NULL hash verifies against nothing at all,
 * not even the right adapter's own token (§2.6 fail-closed).
 *
 * Verification lives in the store rather than in the daemon's registry because
 * the comparison needs the row; the registry keeps minting, rotation policy
 * and the connect-command string. Deviation from the plan's file map, recorded
 * here and in the commit rather than smuggled.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterRecord, Clock } from '@wemessage/core';
import {
  hashAdapterToken,
  openStore,
  type SqliteStore,
} from '@wemessage/store';

let nowIso = '2026-09-01T12:00:00.000Z';
const clock: Clock = { now: () => nowIso, nowMs: () => Date.parse(nowIso) };
function advance(ms: number): void {
  nowIso = new Date(Date.parse(nowIso) + ms).toISOString();
}

let dir: string;
let store: SqliteStore;

function makeAdapter(partial: Partial<AdapterRecord> = {}): AdapterRecord {
  return {
    id: 'echo',
    kind: 'echo',
    displayName: 'Echo',
    enabled: true,
    hasToken: false,
    health: 'unknown',
    config: {},
    ...partial,
  };
}

beforeEach(() => {
  nowIso = '2026-09-01T12:00:00.000Z';
  dir = mkdtempSync(join(tmpdir(), 'wm-adapters-'));
  store = openStore({ dir, clock });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('adapter registry (s5 Scenario 3)', () => {
  it('round-trips a record and preserves config byte-identically', () => {
    const config = { nested: { a: [1, 2, 3] }, s: 'x' };
    store.insertAdapter(makeAdapter({ config }));
    const got = store.getAdapter('echo');
    expect(got).toEqual(makeAdapter({ config }));
    expect(store.listAdapters().map((a) => a.id)).toEqual(['echo']);
  });

  it("never lists or returns the reserved 'human' row", () => {
    // F-22 posture, pinned: 'human' exists so a human-held draft can satisfy
    // the FK. It is not an adapter anyone can address.
    expect(store.getAdapter('human')).toBeNull();
    store.insertAdapter(makeAdapter());
    expect(store.listAdapters().map((a) => a.id)).toEqual(['echo']);
  });

  it('updates a full row and throws on an absent id', () => {
    store.insertAdapter(makeAdapter());
    store.updateAdapter(makeAdapter({ displayName: 'Echo 2', enabled: false }));
    expect(store.getAdapter('echo')?.displayName).toBe('Echo 2');
    expect(store.getAdapter('echo')?.enabled).toBe(false);
    expect(() => store.updateAdapter(makeAdapter({ id: 'ghost' }))).toThrow();
  });

  it('refuses to delete an adapter a rule still points at', () => {
    store.insertAdapter(makeAdapter());
    expect(store.deleteAdapter('echo')).toBe(true);
    store.insertAdapter(makeAdapter());
    store.insertRule({
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      name: 'r',
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
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    expect(() => store.deleteAdapter('echo')).toThrow(/adapter-referenced/);
    expect(store.getAdapter('echo')).not.toBeNull();
  });

  it('stores a scrypt hash and never the plaintext token', () => {
    store.insertAdapter(makeAdapter());
    const token = 'wm_0123456789abcdef';
    store.setAdapterTokenHash('echo', hashAdapterToken(token), null);
    const row = store.getAdapter('echo');
    expect(row?.hasToken).toBe(true);
    expect(Object.keys(row ?? {})).not.toContain('tokenHash');

    // The teeth-relevant assertion: a full-database scan for the prefix finds
    // nothing. A hash that leaked its input would fail here, whatever the
    // column it leaked into.
    const hits = store
      .readAuditRows(0, 10_000)
      .filter((r) => JSON.stringify(r).includes('wm_'));
    expect(hits).toEqual([]);
    expect(JSON.stringify(store.listAdapters())).not.toContain('wm_');
    expect(store.rawScanForToken('wm_')).toEqual([]);
  });

  it('verifies the right token, refuses the wrong one, fails closed on NULL', () => {
    store.insertAdapter(makeAdapter());
    const token = 'wm_right';
    store.setAdapterTokenHash('echo', hashAdapterToken(token), null);
    expect(store.findAdapterByToken(token, nowIso)?.id).toBe('echo');
    expect(store.findAdapterByToken('wm_wrong', nowIso)).toBeNull();

    store.setAdapterTokenHash('echo', null, null);
    expect(store.findAdapterByToken(token, nowIso)).toBeNull();
  });

  it('still matches a disabled adapter: the transport decides what disabled means', () => {
    // Kept explicit so the two concerns cannot blur. The store answers "whose
    // token is this"; refusing a disabled adapter is the transport's call, and
    // it needs to know WHICH adapter it is refusing in order to audit it.
    store.insertAdapter(makeAdapter({ enabled: false }));
    store.setAdapterTokenHash('echo', hashAdapterToken('wm_t'), null);
    const found = store.findAdapterByToken('wm_t', nowIso);
    expect(found?.id).toBe('echo');
    expect(found?.enabled).toBe(false);
  });

  it('honors one 60s carry-over slot on rotation, never a chain', () => {
    store.insertAdapter(makeAdapter());
    const t0 = 'wm_first';
    store.setAdapterTokenHash('echo', hashAdapterToken(t0), null);

    const t1 = 'wm_second';
    const expiresAt = new Date(clock.nowMs() + 60_000).toISOString();
    store.setAdapterTokenHash('echo', hashAdapterToken(t1), {
      hash: hashAdapterToken(t0),
      expiresAt,
    });

    advance(59_000);
    expect(store.findAdapterByToken(t0, nowIso)?.id).toBe('echo');
    expect(store.findAdapterByToken(t1, nowIso)?.id).toBe('echo');

    advance(2_000); // T0 + 61s
    expect(store.findAdapterByToken(t0, nowIso)).toBeNull();
    expect(store.findAdapterByToken(t1, nowIso)?.id).toBe('echo');

    // A second rotation inside a fresh window drops the FIRST old token at
    // once: one slot, so a rotating adapter cannot accumulate live keys.
    const t2 = 'wm_third';
    store.setAdapterTokenHash('echo', hashAdapterToken(t2), {
      hash: hashAdapterToken(t1),
      expiresAt: new Date(clock.nowMs() + 60_000).toISOString(),
    });
    const t3 = 'wm_fourth';
    store.setAdapterTokenHash('echo', hashAdapterToken(t3), {
      hash: hashAdapterToken(t2),
      expiresAt: new Date(clock.nowMs() + 60_000).toISOString(),
    });
    expect(store.findAdapterByToken(t1, nowIso)).toBeNull();
    expect(store.findAdapterByToken(t2, nowIso)?.id).toBe('echo');
    expect(store.findAdapterByToken(t3, nowIso)?.id).toBe('echo');
  });

  it('revokes everything through clearAdapterTokens and skips human', () => {
    store.insertAdapter(makeAdapter());
    store.setAdapterTokenHash('echo', hashAdapterToken('wm_t'), {
      hash: hashAdapterToken('wm_old'),
      expiresAt: new Date(clock.nowMs() + 60_000).toISOString(),
    });
    expect(store.clearAdapterTokens()).toBe(1); // 'human' has none to clear
    expect(store.findAdapterByToken('wm_t', nowIso)).toBeNull();
    expect(store.findAdapterByToken('wm_old', nowIso)).toBeNull();
    expect(store.getAdapter('echo')?.hasToken).toBe(false);
  });

  it('writes health and last-seen together, and throws on an unknown id', () => {
    store.insertAdapter(makeAdapter());
    store.setAdapterHealth('echo', 'connected', nowIso);
    const got = store.getAdapter('echo');
    expect(got?.health).toBe('connected');
    expect(got?.lastSeenAt).toBe(nowIso);
    expect(() =>
      store.setAdapterHealth('ghost', 'connected', nowIso),
    ).toThrow();
  });

  it('omits lastSeenAt entirely when the column is NULL', () => {
    store.insertAdapter(makeAdapter());
    const got = store.getAdapter('echo');
    expect(got?.lastSeenAt).toBeUndefined();
    expect('lastSeenAt' in (got ?? {})).toBe(false);
  });
});

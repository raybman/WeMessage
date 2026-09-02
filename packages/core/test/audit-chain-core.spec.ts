/**
 * S2 Scenario 4 — Audit chain math: canonical encoding, genesis, verify
 * (pure). s2-execution Part 2 Scenario 4; plan §2.3 hash formula.
 *
 * The named checkpoint audit-chain.spec.ts lives at the store layer
 * (Scenario 6); this file proves the chain MATH independent of SQLite.
 *
 * F-13 (coordinator-confirmed, frozen forever once one row ships):
 *   hash = sha256(UTF-8 of prevHash + '\n' + at + '\n' + eventJson + '\n'
 *   + actorJson), lowercase hex (64 chars); genesis prev_hash =
 *   '0'.repeat(64) at seq 1; hash-what-is-stored VERBATIM (verification
 *   never re-serializes objects — JSON key-order ambiguity can never break
 *   the chain). The golden vectors below pin the encoding byte-exactly:
 *   they were computed OUTSIDE this codebase (python hashlib).
 *
 * F-16 (coordinator-confirmed): additive Actor system-reason extension
 *   'recovery' | 'ingest' | 'rule-engine' — no existing variant touched.
 */
import { describe, expect, it } from 'vitest';
import type {
  Actor,
  AuditEvent,
  AuditRow,
  VerifyChainResult,
} from '@wemessage/core';
import { chainHash, GENESIS_HASH, verifyChain } from '@wemessage/core';

// Golden quadruples (hand-computed sha256 via python hashlib — see header).
const AT_1 = '2026-09-01T12:00:00.000Z';
const EVENT_1 = '{"type":"rule.created","ruleId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}';
const ACTOR_1 = '{"kind":"human","via":"api"}';
const GOLDEN_1 =
  '8b6ae6181ce57fe343597d546b1f9f130e1080b67231a92b35ef9beecb3440a5';

const AT_2 = '2026-09-01T12:00:01.000Z';
const EVENT_2 =
  '{"type":"rule.matched","guid":"GL-FIX-001","ruleId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","adapterId":"echo","ruleName":"lunch"}';
const ACTOR_2 = '{"kind":"system","reason":"rule-engine"}';
const GOLDEN_2 =
  '74033d2b703f888e15be53d6ceb475d684af1a4517d913662417f1a5c1c2d343';

/** Build a valid chain from (at, eventJson, actorJson) triples. */
function buildChain(
  triples: Array<{ at: string; eventJson: string; actorJson: string }>,
): AuditRow[] {
  const rows: AuditRow[] = [];
  let prevHash = GENESIS_HASH;
  triples.forEach((t, i) => {
    const hash = chainHash(prevHash, t.at, t.eventJson, t.actorJson);
    rows.push({
      seq: i + 1,
      at: t.at,
      eventJson: t.eventJson,
      actorJson: t.actorJson,
      prevHash,
      hash,
    });
    prevHash = hash;
  });
  return rows;
}

function triple(n: number) {
  return {
    at: `2026-09-01T12:00:0${n}.000Z`,
    eventJson: `{"type":"rule.deleted","ruleId":"01RULE${n}"}`,
    actorJson: '{"kind":"human","via":"api"}',
  };
}

describe('chainHash — F-13 canonical encoding (golden vectors)', () => {
  it('genesis constant is 64 zeros', () => {
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });

  it('matches the externally computed golden value for a genesis row', () => {
    expect(chainHash(GENESIS_HASH, AT_1, EVENT_1, ACTOR_1)).toBe(GOLDEN_1);
  });

  it('matches the externally computed golden value for a chained row', () => {
    expect(chainHash(GOLDEN_1, AT_2, EVENT_2, ACTOR_2)).toBe(GOLDEN_2);
  });

  it('emits lowercase hex, 64 chars', () => {
    const hash = chainHash(GENESIS_HASH, AT_1, EVENT_1, ACTOR_1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes stored strings VERBATIM: key-reordered-but-equal JSON hashes differently', () => {
    // Same semantic actor, different bytes — pins "what you see is what
    // was hashed" (UI §3 S6): verification must never re-serialize.
    const reordered = '{"via":"api","kind":"human"}';
    const a = chainHash(GENESIS_HASH, AT_1, EVENT_1, ACTOR_1);
    const b = chainHash(GENESIS_HASH, AT_1, EVENT_1, reordered);
    expect(a).not.toBe(b);
    expect(b).toBe(
      '0cefca5306954b3ccb6b53331e8e58ea5296d0579708be6511a224d876257870',
    );
  });
});

describe('verifyChain — full walk with typed first-failure', () => {
  it('empty chain is ok with length 0', () => {
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  it('a well-formed chain verifies green', () => {
    const rows = buildChain([triple(1), triple(2), triple(3), triple(4)]);
    expect(verifyChain(rows)).toEqual({ ok: true, length: 4 });
  });

  it('mutated eventJson at seq k reports hash-mismatch at k', () => {
    const rows = buildChain([triple(1), triple(2), triple(3), triple(4)]);
    rows[2] = {
      ...rows[2]!,
      eventJson: '{"type":"rule.deleted","ruleId":"TAMPERED"}',
    };
    const result: VerifyChainResult = verifyChain(rows);
    expect(result).toMatchObject({
      ok: false,
      brokenAtSeq: 3,
      reason: 'hash-mismatch',
    });
  });

  it('a relinked prev_hash reports link-broken at that seq', () => {
    const rows = buildChain([triple(1), triple(2), triple(3)]);
    rows[1] = { ...rows[1]!, prevHash: 'f'.repeat(64) };
    expect(verifyChain(rows)).toMatchObject({
      ok: false,
      brokenAtSeq: 2,
      reason: 'link-broken',
    });
  });

  it('a rewritten (self-consistent) middle row breaks the link at the SUCCESSOR', () => {
    // Scenario 6 tamper class (c): content changed AND hash recomputed
    // without fixing successors — the row itself re-hashes clean; the
    // successor's prev_hash no longer links.
    const rows = buildChain([triple(1), triple(2), triple(3)]);
    const doctoredEvent = '{"type":"rule.deleted","ruleId":"DOCTORED"}';
    const r = rows[1]!;
    rows[1] = {
      ...r,
      eventJson: doctoredEvent,
      hash: chainHash(r.prevHash, r.at, doctoredEvent, r.actorJson),
    };
    expect(verifyChain(rows)).toMatchObject({
      ok: false,
      brokenAtSeq: 3,
      reason: 'link-broken',
    });
  });

  it('a removed row reports seq-gap (gapless from 1 — UI §3 S6 invariant)', () => {
    const rows = buildChain([triple(1), triple(2), triple(3), triple(4)]);
    rows.splice(1, 1); // remove seq 2
    expect(verifyChain(rows)).toMatchObject({
      ok: false,
      brokenAtSeq: 3,
      reason: 'seq-gap',
    });
  });

  it('a chain not starting at seq 1 reports seq-gap at the first row', () => {
    const rows = buildChain([triple(1), triple(2)]);
    expect(verifyChain([rows[1]!])).toMatchObject({
      ok: false,
      brokenAtSeq: 2,
      reason: 'seq-gap',
    });
  });

  it('first failure wins when multiple classes are present', () => {
    const rows = buildChain([triple(1), triple(2), triple(3), triple(4)]);
    rows[1] = { ...rows[1]!, eventJson: '{"tampered":1}' }; // hash-mismatch @2
    rows.splice(2, 1); // seq-gap @4 (later)
    expect(verifyChain(rows)).toMatchObject({
      ok: false,
      brokenAtSeq: 2,
      reason: 'hash-mismatch',
    });
  });

  it('supports chunked walks via a prior link (Scenario 6 walks readAuditRows in chunks)', () => {
    const rows = buildChain([triple(1), triple(2), triple(3), triple(4)]);
    const head = rows.slice(0, 2);
    const tail = rows.slice(2);
    expect(verifyChain(head)).toEqual({ ok: true, length: 2 });
    const last = head[head.length - 1]!;
    expect(verifyChain(tail, { seq: last.seq, hash: last.hash })).toEqual({
      ok: true,
      length: 2,
    });
    // A doctored prior hash breaks the first row of the chunk:
    expect(
      verifyChain(tail, { seq: last.seq, hash: 'a'.repeat(64) }),
    ).toMatchObject({ ok: false, brokenAtSeq: 3, reason: 'link-broken' });
  });
});

describe('AuditEvent union (S2 vocabulary, §2.4.4 subset) + F-16 Actor extension', () => {
  it('type-instantiates every S2 event variant', () => {
    const events: AuditEvent[] = [
      {
        type: 'rule.matched',
        guid: 'GL-FIX-001',
        ruleId: '01RULE',
        adapterId: 'echo',
        ruleName: 'lunch',
      },
      {
        type: 'rule.created',
        ruleId: '01RULE',
        rule: {
          id: '01RULE',
          name: 'lunch',
          enabled: true,
          matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
          adapterId: 'echo',
          respondMode: 'draft-only',
          scheduleId: null,
          outsideWindow: 'draft-only',
          allowGroupDrafts: false,
          matchAttachmentOnly: false,
          draftTtlMinutes: 60,
          priority: 100,
          createdAt: AT_1,
          updatedAt: AT_1,
        },
      },
      {
        type: 'rule.updated',
        ruleId: '01RULE',
        rule: {
          id: '01RULE',
          name: 'lunch2',
          enabled: true,
          matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
          adapterId: 'echo',
          respondMode: 'draft-only',
          scheduleId: null,
          outsideWindow: 'draft-only',
          allowGroupDrafts: false,
          matchAttachmentOnly: false,
          draftTtlMinutes: 60,
          priority: 100,
          createdAt: AT_1,
          updatedAt: AT_2,
        },
      },
      { type: 'rule.deleted', ruleId: '01RULE' },
      { type: 'rule.enabled', ruleId: '01RULE' },
      { type: 'rule.disabled', ruleId: '01RULE' },
      {
        type: 'ingest.decode-failed',
        guid: 'GL-FIX-002',
        sourceRowid: 42,
        reason: 'typedstream-parse-error',
      },
      { type: 'message.edited', guid: 'GL-FIX-003' },
      { type: 'message.unsent', guid: 'GL-FIX-004' },
      { type: 'recovery.cursor', reason: 'ahead-of-chatdb', lastRowid: 17 },
      { type: 'recovery.cursor', reason: 'corrupt', lastRowid: 0 },
      {
        type: 'recovery.draft',
        draftId: '01DRAFT',
        outcome: 'sent',
        sentMessageGuid: 'GL-FIX-005',
      },
      {
        type: 'recovery.draft',
        draftId: '01DRAFT',
        outcome: 'failed',
        code: 'unverified',
      },
    ];
    expect(events).toHaveLength(13);

    // Unknown event types do not compile (S1 Scenario 2 probe pattern):
    // @ts-expect-error — 'gate.denied' is S4 vocabulary, not S2
    const notYet: AuditEvent = { type: 'gate.denied', reason: 'kill-switch' };
    void notYet;
  });

  it('F-16: the Actor system-reason union gained recovery/ingest/rule-engine additively', () => {
    const extended: Actor[] = [
      { kind: 'system', reason: 'recovery' },
      { kind: 'system', reason: 'ingest' },
      { kind: 'system', reason: 'rule-engine' },
    ];
    // Pre-existing §3.2 variants still type-check untouched:
    const existing: Actor[] = [
      { kind: 'human', via: 'api' },
      { kind: 'agent', adapterId: 'echo' },
      { kind: 'system', reason: 'expiry' },
      { kind: 'system', reason: 'kill-switch' },
      { kind: 'system', reason: 'disconnect' },
    ];
    expect([...extended, ...existing]).toHaveLength(8);

    // @ts-expect-error — arbitrary reasons still rejected
    const bogus: Actor = { kind: 'system', reason: 'gremlins' };
    void bogus;
  });
});

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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

    // Unknown event types do not compile (S1 Scenario 2 probe pattern).
    // 'gate.denied' shipped as real S4 vocabulary (s4-execution Scenario 2,
    // audit/events.ts) — a genuinely nonexistent literal replaces it here so
    // this probe still proves what it always proved.
    // @ts-expect-error — 'draft.teleported' has never been and will never be a real event
    const notYet: AuditEvent = { type: 'draft.teleported' };
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

  it('F-28: the Actor system-reason union gained capability-probe additively (s3 Scenario 7)', () => {
    const extended: Actor[] = [{ kind: 'system', reason: 'capability-probe' }];
    // Pre-existing §3.2 + F-16 variants still type-check untouched:
    const existing: Actor[] = [
      { kind: 'human', via: 'api' },
      { kind: 'agent', adapterId: 'echo' },
      { kind: 'system', reason: 'expiry' },
      { kind: 'system', reason: 'kill-switch' },
      { kind: 'system', reason: 'disconnect' },
      { kind: 'system', reason: 'recovery' },
      { kind: 'system', reason: 'ingest' },
      { kind: 'system', reason: 'rule-engine' },
    ];
    expect([...extended, ...existing]).toHaveLength(9);

    // @ts-expect-error — arbitrary reasons still rejected
    const bogus: Actor = { kind: 'system', reason: 'reboot-detected' };
    void bogus;
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* C-7 — the audit taxonomy pin.                                             */
/*                                                                           */
/* s9 Sc2 wrote this because it went looking for the C-7 pin before adding   */
/* `daemon.lock.stale_reclaimed` to the union and found that there wasn't    */
/* one. `AuditEvent` had grown to fifty variants across eight slices with    */
/* nothing asserting its membership in either direction: the only thing in   */
/* the tree called an audit taxonomy check was a prose comparison of the     */
/* gate-reason table in `audit/events.ts`'s header. A union anyone can       */
/* extend by adding a line, with no row that notices, is not a taxonomy.     */
/*                                                                           */
/* Both directions are enforced, and by the compiler rather than by a count: */
/* `satisfies Record<AuditEventType, true>` fails to build if a variant is   */
/* missing from the map (the map is not assignable) AND if the map names a   */
/* type the union does not have (excess property check on an object          */
/* literal). The runtime rows below add what the compiler cannot see: that   */
/* the map is not empty, that it matches the source, and that this           */
/* scenario's variant is really in it.                                       */
/* ────────────────────────────────────────────────────────────────────────── */

/** `packages/core/test` -> the repository root. */
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

type AuditEventType = AuditEvent['type'];

const AUDIT_EVENT_TYPES = {
  'adapter.auth-failed': true,
  'adapter.connected': true,
  'adapter.created': true,
  'adapter.deleted': true,
  'adapter.disconnected': true,
  'adapter.feedback-dropped': true,
  'adapter.no-send-frame': true,
  'adapter.protocol-violation': true,
  'adapter.token-rotated': true,
  'adapter.unreachable': true,
  'adapter.updated': true,
  'arming.changed': true,
  'arming.mode-changed': true,
  'arming.paused': true,
  'arming.resumed': true,
  'auto.approved': true,
  'connection.state-changed': true,
  'contact.policy-changed': true,
  'daemon.lock.stale_reclaimed': true,
  'draft.approved': true,
  'draft.created': true,
  'draft.declined': true,
  'draft.edited': true,
  'draft.expired': true,
  'draft.failed': true,
  'draft.illegal-transition': true,
  'draft.recalled': true,
  'draft.redrafted': true,
  'draft.rejected': true,
  'draft.requeued': true,
  'draft.sent': true,
  'draft.superseded': true,
  'gate.denied': true,
  'gateway.disconnected': true,
  'ingest.decode-failed': true,
  'message.edited': true,
  'message.unsent': true,
  'recovery.cursor': true,
  'recovery.draft': true,
  'rule.created': true,
  'rule.deleted': true,
  'rule.disabled': true,
  'rule.enabled': true,
  'rule.matched': true,
  'rule.updated': true,
  'schedule.created': true,
  'schedule.deleted': true,
  'schedule.updated': true,
  'send.attempted': true,
  'service.installed': true,
  'service.uninstalled': true,
  'setting.changed': true,
  'toggle.changed': true,
} as const satisfies Record<AuditEventType, true>;

describe('C-7: the AuditEvent union is pinned in both directions', () => {
  it('the pin is total, and the compiler is what makes it total', () => {
    const pinned = Object.keys(AUDIT_EVENT_TYPES).sort();
    // Non-vacuity: an empty map would satisfy nothing, but a map that had
    // silently lost its contents to a bad merge would still typecheck if the
    // union had also been emptied. Fifty-three is the count at s9 Sc3, which
    // added the two `service.` rows.
    expect(pinned).toHaveLength(53);
    expect(new Set(pinned).size).toBe(pinned.length);
    // Every key really is a usable AuditEvent discriminant.
    for (const t of pinned) {
      const asType: AuditEventType = t as AuditEventType;
      expect(typeof asType).toBe('string');
    }
  });

  it('the pin equals the union as written in the source', () => {
    /*
     * The compiler pins the map to the TYPE. This pins the type to the
     * FILE, which catches the one thing the compiler cannot: a variant added
     * with a `type` literal that duplicates an existing one, which collapses
     * two events into one in the union and leaves the map still total.
     */
    const src = readFileSync(
      join(REPO_ROOT, 'packages', 'core', 'src', 'audit', 'events.ts'),
      'utf8',
    );
    const literals = [...src.matchAll(/type: '([^']+)'/g)].map((m) => m[1]);
    expect(literals.length).toBeGreaterThan(40);
    // No literal appears twice: fifty-three variants, fifty-three names.
    expect(new Set(literals).size).toBe(literals.length);
    // Equality, not containment, in both directions.
    expect([...literals].sort()).toEqual(Object.keys(AUDIT_EVENT_TYPES).sort());
  });

  it('s9 Sc2 added exactly one variant, and it is the lock reclaim', () => {
    expect(AUDIT_EVENT_TYPES).toHaveProperty('daemon.lock.stale_reclaimed');
    // It is the only `daemon.` event in the taxonomy: this scenario adds one
    // row type, not a namespace.
    const daemonEvents = Object.keys(AUDIT_EVENT_TYPES).filter((t) =>
      t.startsWith('daemon.'),
    );
    expect(daemonEvents).toEqual(['daemon.lock.stale_reclaimed']);
    // And it is a real, constructible event, not a name in a map.
    const event: AuditEvent = {
      type: 'daemon.lock.stale_reclaimed',
      pid: 4242,
    };
    expect(event.type).toBe('daemon.lock.stale_reclaimed');
    // `pid: number | null` — null is the "the file named nobody" case, and
    // it has to survive the JSON round trip the chain hashes.
    const noPid: AuditEvent = {
      type: 'daemon.lock.stale_reclaimed',
      pid: null,
    };
    expect(JSON.parse(JSON.stringify(noPid))).toEqual({
      type: 'daemon.lock.stale_reclaimed',
      pid: null,
    });
  });

  it('s9 Sc3 added exactly two variants, and they are the service pair', () => {
    // Equality over the `service.` namespace, in both directions: the map
    // cannot have gained a third row type without this failing, and it
    // cannot have lost one of these two either.
    const serviceEvents = Object.keys(AUDIT_EVENT_TYPES)
      .filter((t) => t.startsWith('service.'))
      .sort();
    expect(serviceEvents).toEqual(['service.installed', 'service.uninstalled']);

    // Both are real, constructible events with the fields the installer
    // writes — the install carries WHAT was written and WHERE, the
    // uninstall carries only the label, and neither carries a boolean that
    // would let one row stand for both facts.
    const installed: AuditEvent = {
      type: 'service.installed',
      label: 'sh.wemessage.gateway',
      plistPath: '/somewhere/sh.wemessage.gateway.plist',
    };
    const uninstalled: AuditEvent = {
      type: 'service.uninstalled',
      label: 'sh.wemessage.gateway',
    };
    expect(JSON.parse(JSON.stringify([installed, uninstalled]))).toEqual([
      {
        type: 'service.installed',
        label: 'sh.wemessage.gateway',
        plistPath: '/somewhere/sh.wemessage.gateway.plist',
      },
      { type: 'service.uninstalled', label: 'sh.wemessage.gateway' },
    ]);

    // The uninstall row carries no plistPath. Excess-property checking
    // reports at the offending PROPERTY, not at the declaration, so the
    // directive has to sit on the property or it is itself unused — which
    // `noUnusedTsExpectError` correctly convicted the first draft of.
    const wrong: AuditEvent = {
      type: 'service.uninstalled',
      label: 'sh.wemessage.gateway',
      // @ts-expect-error — the uninstall row has no plistPath to carry
      plistPath: '/somewhere/sh.wemessage.gateway.plist',
    };
    void wrong;
  });
});

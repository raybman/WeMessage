/**
 * s4-execution.md Part 2 Scenario 2 — the pure transition table (§1.7).
 * ★ CHECKPOINT `draft-lifecycle.spec.ts` (core half — the persistence half
 * lands in Scenario 3 against the store).
 *
 * Two halves:
 *  1. `applyDraftTransition` — table-driven, full 9-state x 10-event cross
 *     product: every pair not on the §1.7 table throws `IllegalDraftTransition`;
 *     every pair ON the table returns exactly the specified `to` state
 *     provided its actor constraint is satisfied, else `IllegalDraftActor`.
 *  2. The new `AuditEvent` vocabulary (§1.7's audit-variant list): payload
 *     shapes instantiate, a chain built from them still verifies clean, and
 *     the C-6 taxonomy-pin header in audit/events.ts is untouched (expiry is
 *     a DraftState under system actor 'expiry', never a `gate.denied` row).
 *
 * Teeth (proven-then-reverted, see commit message): delete the
 * `approved -> recalled` row from the table -> its own test fails; make
 * unknown (from, event) pairs return `from` instead of throwing -> the
 * cross-product test fails.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Actor, AuditEvent, AuditRow, DraftState } from '@wemessage/core';
import {
  applyDraftTransition,
  chainHash,
  GENESIS_HASH,
  IllegalDraftActor,
  IllegalDraftTransition,
  MAX_DRAFT_RETRIES,
  verifyChain,
  type DraftEvent,
} from '@wemessage/core';

const HUMAN: Actor = { kind: 'human', via: 'api' };
const AGENT: Actor = { kind: 'agent', adapterId: 'echo' };
const sys = (reason: Extract<Actor, { kind: 'system' }>['reason']): Actor => ({
  kind: 'system',
  reason,
});

const STATES: DraftState[] = [
  'pending',
  'approved',
  'sending',
  'sent',
  'rejected',
  'expired',
  'superseded',
  'recalled',
  'failed',
];

const EVENTS: DraftEvent[] = [
  'approve',
  'reject',
  'ttl-elapsed',
  'superseded',
  'edit',
  'grace-elapsed',
  'recall',
  'verified',
  'send-failed',
  'retry',
];

interface LegalRow {
  from: DraftState;
  event: DraftEvent;
  to: DraftState;
  actor: Actor;
  retriesUsed?: number;
}

// The §1.7 table, one row per legal (from, event) pair, with an actor that
// satisfies that row's constraint (used both to prove the happy path AND as
// the "this pair is legal" membership list for the cross-product test).
const LEGAL: LegalRow[] = [
  { from: 'pending', event: 'approve', to: 'approved', actor: HUMAN },
  { from: 'pending', event: 'reject', to: 'rejected', actor: HUMAN },
  {
    from: 'pending',
    event: 'ttl-elapsed',
    to: 'expired',
    actor: sys('expiry'),
  },
  {
    from: 'pending',
    event: 'superseded',
    to: 'superseded',
    actor: sys('supersede'),
  },
  { from: 'pending', event: 'edit', to: 'pending', actor: HUMAN },
  {
    from: 'approved',
    event: 'grace-elapsed',
    to: 'sending',
    actor: sys('expiry'), // mechanism-only row: no actor constraint, any actor is fine
  },
  { from: 'approved', event: 'recall', to: 'recalled', actor: HUMAN },
  {
    from: 'approved',
    event: 'reject',
    to: 'rejected',
    actor: sys('kill-switch'),
  },
  { from: 'sending', event: 'verified', to: 'sent', actor: HUMAN },
  { from: 'sending', event: 'send-failed', to: 'failed', actor: HUMAN },
  {
    from: 'failed',
    event: 'retry',
    to: 'approved',
    actor: HUMAN,
    retriesUsed: 0,
  },
];

describe('applyDraftTransition — the pure §1.7 table', () => {
  describe('full cross product: every (from, event) pair not on the table throws', () => {
    const legalKeys = new Set(LEGAL.map((r) => `${r.from}:${r.event}`));
    for (const from of STATES) {
      for (const event of EVENTS) {
        if (legalKeys.has(`${from}:${event}`)) continue;
        it(`${from} + ${event} -> IllegalDraftTransition`, () => {
          expect(() =>
            applyDraftTransition({ from, event, actor: HUMAN, retriesUsed: 0 }),
          ).toThrow(IllegalDraftTransition);
        });
      }
    }
  });

  describe('every legal row returns exactly the table-specified `to` state', () => {
    for (const row of LEGAL) {
      it(`${row.from} + ${row.event} -> ${row.to}`, () => {
        // exactOptionalPropertyTypes: only spread retriesUsed when the row
        // actually specifies it — an explicit `undefined` is not the same
        // as an omitted key under this tsconfig.
        expect(
          applyDraftTransition({
            from: row.from,
            event: row.event,
            actor: row.actor,
            ...(row.retriesUsed !== undefined
              ? { retriesUsed: row.retriesUsed }
              : {}),
          }),
        ).toBe(row.to);
      });
    }
  });

  it('a thrown IllegalDraftTransition carries {from, event}', () => {
    try {
      applyDraftTransition({ from: 'sent', event: 'approve', actor: HUMAN });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalDraftTransition);
      const err = e as IllegalDraftTransition;
      expect(err.from).toBe('sent');
      expect(err.event).toBe('approve');
    }
  });

  describe('actor constraints', () => {
    it('approve with an agent actor throws IllegalDraftActor (S4: humans only)', () => {
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'approve',
          actor: AGENT,
        }),
      ).toThrow(IllegalDraftActor);
    });

    it('reject from pending accepts a human actor', () => {
      expect(
        applyDraftTransition({
          from: 'pending',
          event: 'reject',
          actor: HUMAN,
        }),
      ).toBe('rejected');
    });

    for (const reason of [
      'kill-switch',
      'disconnect',
      'circuit-breaker',
    ] as const) {
      it(`reject from pending accepts system actor reason '${reason}'`, () => {
        expect(
          applyDraftTransition({
            from: 'pending',
            event: 'reject',
            actor: sys(reason),
          }),
        ).toBe('rejected');
      });

      it(`approved + reject accepts system actor reason '${reason}'`, () => {
        expect(
          applyDraftTransition({
            from: 'approved',
            event: 'reject',
            actor: sys(reason),
          }),
        ).toBe('rejected');
      });
    }

    it('reject from pending rejects an unrelated system reason', () => {
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'reject',
          actor: sys('expiry'),
        }),
      ).toThrow(IllegalDraftActor);
    });

    it('approved + reject rejects a human actor (recall is the human verb there)', () => {
      expect(() =>
        applyDraftTransition({
          from: 'approved',
          event: 'reject',
          actor: HUMAN,
        }),
      ).toThrow(IllegalDraftActor);
    });

    it("ttl-elapsed demands system actor reason 'expiry', exactly", () => {
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'ttl-elapsed',
          actor: HUMAN,
        }),
      ).toThrow(IllegalDraftActor);
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'ttl-elapsed',
          actor: sys('disconnect'),
        }),
      ).toThrow(IllegalDraftActor);
      expect(
        applyDraftTransition({
          from: 'pending',
          event: 'ttl-elapsed',
          actor: sys('expiry'),
        }),
      ).toBe('expired');
    });

    it("superseded demands system actor reason 'supersede', exactly", () => {
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'superseded',
          actor: HUMAN,
        }),
      ).toThrow(IllegalDraftActor);
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'superseded',
          actor: sys('expiry'),
        }),
      ).toThrow(IllegalDraftActor);
    });

    it('recall demands a human actor', () => {
      expect(() =>
        applyDraftTransition({
          from: 'approved',
          event: 'recall',
          actor: sys('kill-switch'),
        }),
      ).toThrow(IllegalDraftActor);
    });

    it('retry demands a human actor', () => {
      expect(() =>
        applyDraftTransition({
          from: 'failed',
          event: 'retry',
          actor: sys('kill-switch'),
          retriesUsed: 0,
        }),
      ).toThrow(IllegalDraftActor);
    });
  });

  describe("'edit' is pending-only and returns the same state (a body change, not a state change)", () => {
    it('pending + edit -> pending', () => {
      expect(
        applyDraftTransition({ from: 'pending', event: 'edit', actor: HUMAN }),
      ).toBe('pending');
    });
    // every other from-state + edit is already proven illegal by the
    // cross-product block above (edit has exactly one legal row).
  });

  describe('retry legality: failed -> approved only while retriesUsed < 2', () => {
    it(`retriesUsed 0..${MAX_DRAFT_RETRIES - 1} are legal`, () => {
      for (let n = 0; n < MAX_DRAFT_RETRIES; n++) {
        expect(
          applyDraftTransition({
            from: 'failed',
            event: 'retry',
            actor: HUMAN,
            retriesUsed: n,
          }),
        ).toBe('approved');
      }
    });

    it('retriesUsed at or past the ceiling throws IllegalDraftTransition', () => {
      expect(() =>
        applyDraftTransition({
          from: 'failed',
          event: 'retry',
          actor: HUMAN,
          retriesUsed: MAX_DRAFT_RETRIES,
        }),
      ).toThrow(IllegalDraftTransition);
    });

    it('omitted retriesUsed throws IllegalDraftTransition (the ledger count is mandatory)', () => {
      expect(() =>
        applyDraftTransition({ from: 'failed', event: 'retry', actor: HUMAN }),
      ).toThrow(IllegalDraftTransition);
    });
  });

  describe('proven teeth', () => {
    it('deleting the approved->recalled row would fail this test (documented, not executed against prod)', () => {
      // The actual mutation (commenting out the `recall: 'recalled'` row in
      // transitions.ts) is applied by hand during the RED/teeth step and
      // reverted before commit — see the commit message for the transcript.
      // This test asserts the row IS present today, i.e. the thing the
      // teeth step temporarily broke.
      expect(
        applyDraftTransition({
          from: 'approved',
          event: 'recall',
          actor: HUMAN,
        }),
      ).toBe('recalled');
    });

    it('an unknown pair returning `from` instead of throwing would fail this test', () => {
      expect(() =>
        applyDraftTransition({ from: 'sent', event: 'edit', actor: HUMAN }),
      ).toThrow(IllegalDraftTransition);
    });
  });
});

/**
 * s6-execution Part 2 Scenario 9 (rows 1-2) — F-58: C-1 is widened by
 * EXACTLY ONE disjunct.
 *
 * S4 shipped `pending + approve` as human-only, and every scenario since has
 * leaned on that: `proactive.spec.ts` cited it as the reason a proposal can
 * never self-send, and Sc 8's stand-in wrote its approval through the STORE
 * precisely because this table would have refused it. Scenario 9 is the
 * slice that earns the exception, and F-58 pins its shape: the predicate
 * becomes `human || (system && reason === 'auto-respond')`. Not a broadened
 * `kind !== 'agent'`, not a new `'auto'` actor kind, not a bypass parameter.
 *
 * Widening a predicate by one disjunct is only safe if the other disjuncts
 * are pinned, so the positive row below is surrounded by one negative per
 * remaining actor: the agent kind, and EVERY other reason in the system
 * variant of the `Actor` union. The enumeration is derived from the type
 * rather than snapshotted from it (see `SYSTEM_REASONS`), so a reason added
 * in a later slice cannot quietly slip past this guard by not being listed.
 */
describe('s6 Sc9 rows 1-2: the one legal system approver (F-58)', () => {
  /**
   * Every reason the system `Actor` variant has, as the keys of a TOTAL
   * `Record`. The compiler rejects this literal in both directions: a reason
   * added to the union and not listed here is a missing key, and a reason
   * that leaves the union is an excess property. That is what makes the
   * negatives below self-maintaining instead of a list somebody has to
   * remember to extend.
   */
  const SYSTEM_REASONS: Record<
    Extract<Actor, { kind: 'system' }>['reason'],
    true
  > = {
    expiry: true,
    supersede: true,
    'kill-switch': true,
    'circuit-breaker': true,
    'auto-respond': true,
    'inbound-unsent': true,
    disconnect: true,
    recovery: true,
    ingest: true,
    'rule-engine': true,
    'capability-probe': true,
  };
  const ALL_SYSTEM_REASONS = Object.keys(SYSTEM_REASONS) as Array<
    keyof typeof SYSTEM_REASONS
  >;

  // --- Row 1: the one thing that becomes legal. ---------------------------

  it("pending + approve accepts the system 'auto-respond' actor -> approved", () => {
    expect(
      applyDraftTransition({
        from: 'pending',
        event: 'approve',
        actor: sys('auto-respond'),
      }),
    ).toBe('approved');
  });

  it('the human approver is untouched by the widening', () => {
    expect(
      applyDraftTransition({ from: 'pending', event: 'approve', actor: HUMAN }),
    ).toBe('approved');
  });

  // --- Row 2: every other actor is still refused, one row each. -----------

  it('the agent actor may still not approve', () => {
    expect(() =>
      applyDraftTransition({
        from: 'pending',
        event: 'approve',
        actor: AGENT,
      }),
    ).toThrow(IllegalDraftActor);
  });

  for (const reason of ALL_SYSTEM_REASONS) {
    if (reason === 'auto-respond') continue;
    it(`the system '${reason}' actor may still not approve`, () => {
      expect(() =>
        applyDraftTransition({
          from: 'pending',
          event: 'approve',
          actor: sys(reason),
        }),
      ).toThrow(IllegalDraftActor);
    });
  }

  /**
   * The disjunct-count pin, stated as the property rather than as a number:
   * of every reason the union carries, exactly one is allowed to approve. A
   * second legal reason would fail this row whatever it was called and
   * whoever added it, which a hand-written list of negatives cannot promise.
   */
  it('exactly one system reason may approve, across the whole union', () => {
    const legal = ALL_SYSTEM_REASONS.filter((reason) => {
      try {
        applyDraftTransition({
          from: 'pending',
          event: 'approve',
          actor: sys(reason),
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(legal).toEqual(['auto-respond']);
  });

  /**
   * The widening is scoped to `approve`. `edit` shares the same table row
   * (`pending + (approve|edit)`) and rewrites a draft's BODY, which is a
   * strictly larger power than approving the body an agent already proposed
   * and a human can already read in the queue. The auto path may mint an
   * approval; it may never put words in a draft.
   */
  it("pending + edit is unmoved: 'auto-respond' may approve, never rewrite", () => {
    expect(() =>
      applyDraftTransition({
        from: 'pending',
        event: 'edit',
        actor: sys('auto-respond'),
      }),
    ).toThrow(IllegalDraftActor);
  });

  /**
   * And no OTHER row learned the new actor. `approve` is on the table only
   * from `pending`, so from every other state the pair itself is absent and
   * the actor is never even consulted — `IllegalDraftTransition`, not
   * `IllegalDraftActor`. Stated explicitly because "the auto actor may
   * approve" must not decay into "the auto actor may approve anything".
   */
  it('no other state gained an approve edge for the auto actor', () => {
    for (const from of STATES) {
      if (from === 'pending') continue;
      expect(() =>
        applyDraftTransition({
          from,
          event: 'approve',
          actor: sys('auto-respond'),
        }),
      ).toThrow(IllegalDraftTransition);
    }
  });

  /**
   * The reject/recall/retry rows are where an over-broad `kind !== 'agent'`
   * would have leaked, so each is re-asserted against the new actor.
   */
  it('reject, recall and retry still refuse the auto actor', () => {
    expect(() =>
      applyDraftTransition({
        from: 'pending',
        event: 'reject',
        actor: sys('auto-respond'),
      }),
    ).toThrow(IllegalDraftActor);
    expect(() =>
      applyDraftTransition({
        from: 'approved',
        event: 'reject',
        actor: sys('auto-respond'),
      }),
    ).toThrow(IllegalDraftActor);
    expect(() =>
      applyDraftTransition({
        from: 'approved',
        event: 'recall',
        actor: sys('auto-respond'),
      }),
    ).toThrow(IllegalDraftActor);
    expect(() =>
      applyDraftTransition({
        from: 'failed',
        event: 'retry',
        actor: sys('auto-respond'),
        retriesUsed: 0,
      }),
    ).toThrow(IllegalDraftActor);
  });
});

describe('s4-execution §1.7 audit-event vocabulary', () => {
  const AT = '2026-09-02T12:00:00.000Z';

  it('every new variant type-instantiates', () => {
    const events: AuditEvent[] = [
      { type: 'draft.rejected', draftId: '01DRAFT' },
      { type: 'draft.rejected', draftId: '01DRAFT', approvalId: '01APR' },
      { type: 'draft.recalled', draftId: '01DRAFT', approvalId: '01APR' },
      { type: 'draft.expired', draftId: '01DRAFT' },
      { type: 'draft.superseded', draftId: '01DRAFT' },
      {
        type: 'draft.superseded',
        draftId: '01DRAFT',
        supersededBy: '01DRAFT2',
      },
      { type: 'draft.edited', draftId: '01DRAFT' },
      {
        type: 'draft.redrafted',
        fromDraftId: '01DRAFT',
        toDraftId: '01DRAFT2',
      },
      {
        type: 'draft.illegal-transition',
        draftId: '01DRAFT',
        from: 'sent',
        event: 'approve',
      },
      { type: 'gate.denied', draftId: '01DRAFT', reason: 'kill-switch' },
      { type: 'toggle.changed', key: 'send.killSwitch', on: true },
      {
        type: 'contact.policy-changed',
        handle: '+15551234567',
        from: null,
        to: 'draft-only',
      },
      {
        type: 'contact.policy-changed',
        handle: '+15551234567',
        from: 'draft-only',
        to: null,
      },
    ];
    expect(events).toHaveLength(13);
  });

  it('a chain built from the new variants still verifies clean (chain math is event-shape-agnostic)', () => {
    const rows: AuditRow[] = [];
    let prevHash = GENESIS_HASH;
    const triples: Array<{ event: AuditEvent; actor: Actor }> = [
      {
        event: {
          type: 'gate.denied',
          draftId: '01DRAFT',
          reason: 'kill-switch',
        },
        actor: sys('kill-switch'),
      },
      {
        event: { type: 'toggle.changed', key: 'send.killSwitch', on: true },
        actor: HUMAN,
      },
      {
        event: {
          type: 'draft.illegal-transition',
          draftId: '01DRAFT',
          from: 'sent',
          event: 'approve',
        },
        actor: HUMAN,
      },
    ];
    triples.forEach((t, i) => {
      const eventJson = JSON.stringify(t.event);
      const actorJson = JSON.stringify(t.actor);
      const at = `2026-09-02T12:00:0${i}.000Z`;
      const hash = chainHash(prevHash, at, eventJson, actorJson);
      rows.push({ seq: i + 1, at, eventJson, actorJson, prevHash, hash });
      prevHash = hash;
    });
    expect(verifyChain(rows)).toEqual({ ok: true, length: 3 });
  });

  it('the C-6 taxonomy pin (expiry is a DraftState, never a gate.denied row) is untouched', () => {
    const eventsSrc = readFileSync(
      resolve(import.meta.dirname, '../src/audit/events.ts'),
      'utf8',
    );
    expect(eventsSrc).toContain(
      'TTL_EXPIRED         →  not a gate deny: draft expiry (DraftState',
    );
  });

  it('AT is a valid ISO string (sanity, avoids an unused-var lint false economy)', () => {
    expect(new Date(AT).toISOString()).toBe(AT);
  });
});

void join; // reserved for a future fixture path if this file grows a second source read

/**
 * s8-execution Scenario 12 — the contacts screen's decisions, without a DOM.
 *
 * This screen is the one place in the GUI where the product's DEFAULT is
 * the strictest thing it can do, and where a blank column would be a lie
 * rather than an omission. §2.4.3 step 3 (`packages/core/src/gate/index.ts`,
 * the `ctx.contact === null || ctx.contact.mode === 'deny'` branch) denies
 * outright for rule-driven and agent-origin traffic when a handle has NO
 * `ContactPolicy` row. Absence is not "no policy". Absence is deny.
 *
 * Four claims live here, each a pure function of rows the daemon already
 * sent, so the e2e can spend its Electron launches proving the strings
 * reach the screen rather than re-deriving arithmetic through a browser:
 *
 *  - **A missing row is a DECISION the screen states in words.** Every row
 *    the grid can draw has a mode cell that is never blank: a stored mode,
 *    or the sentence for the absence.
 *  - **Contact scope narrows and cannot widen.** `contactLadder` is an
 *    extension of `derive/scopeLadder.ts` — the SAME file the rules screen
 *    uses, the same rung labels, the same note — because two ladders is two
 *    chances to disagree about §2.4.3. It is proved exhaustively: over
 *    every (global, contact) pair there is no input whose effective mode is
 *    wider than the global rung.
 *  - **The counters are a JOIN, and the join is mandatory.** `auto.approved`
 *    carries no handle (`packages/core/src/audit/events.ts`), so the count
 *    per handle only exists through `draft.created`'s draft snapshot. A
 *    screen that counted `auto.approved` rows alone would show one number
 *    for the whole machine and label it per person.
 *  - **The precedence footer is the GATE's order, not a plausible one.**
 *    The plan's footer (`KILL > DENY > window > rate cap > rule mode`) is
 *    wrong twice over: mode narrowing happens BEFORE the clamps, not after
 *    the rate cap, and the chain has five clamps rather than two. An arch
 *    row pins the clamp order to the gate source; these rows pin the shape.
 *
 * Synthetic handles only (`+1555…`), as everywhere in this PUBLIC repo.
 */
import { describe, expect, it } from 'vitest';
import type {
  AuditRowPayload,
  ContactMode,
  ContactPolicyPayload,
} from '@wemessage/client';
import {
  autoSendsPerHour,
  AUTO_CAP_WINDOW_MIN,
  AUTO_HOUR_WINDOW_MIN,
  heldBy,
  type AutoTally,
} from '../../src/renderer/derive/autoSendsPerHour.js';
import {
  CLAMP_ORDER,
  DENY_ORDER,
  MODES,
  NARROW_ORDER,
  UNKNOWN_MODE_SENTENCE,
  filterRows,
  modeCell,
  peopleRows,
  type PersonRow,
} from '../../src/renderer/derive/peopleRows.js';
import {
  contactLadder,
  globalModeOf,
  LADDER_NOTE,
  type RespondMode,
} from '../../src/renderer/derive/scopeLadder.js';

const ALICE = '+15550000001';
const BRUNO = '+15550000002';
const CARLA = '+15550000003';
const DIEGO = '+15550000004';
const ROOM = 'iMessage;+;chat555000009';

const NOW = '2027-03-10T20:00:00.000Z';

function policy(
  handle: string,
  mode: ContactMode,
  displayName?: string,
): ContactPolicyPayload {
  return {
    handle,
    mode,
    updatedAt: '2027-03-01T00:00:00.000Z',
    ...(displayName === undefined ? {} : { displayName }),
  };
}

/** A draft, projected to the two fields this screen is entitled to see. */
function draft(chatGuid: string, id = 'd1'): { id: string; chatGuid: string } {
  return { id, chatGuid };
}

let seq = 0;
function auditRow(at: string, event: unknown): AuditRowPayload {
  seq += 1;
  return {
    seq,
    at,
    eventJson: JSON.stringify(event),
    actorJson: '{"kind":"system"}',
    prevHash: '',
    hash: '',
  };
}

function minutesBefore(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) - minutes * 60_000).toISOString();
}

/* ── rows: a missing policy row is a row, and it says what it is ──────── */

describe('s8 Sc12: the grid draws handles that have no policy at all', () => {
  it('unions the stored policies with every handle a live draft names', () => {
    const rows = peopleRows({
      contacts: [policy(ALICE, 'auto', 'Test User 1'), policy(BRUNO, 'deny')],
      // DIEGO has a draft in the queue and no policy row: precisely the
      // person an operator is looking for when they open this screen.
      drafts: [
        draft(`iMessage;-;${ALICE}`, 'd1'),
        draft(`SMS;-;${DIEGO}`, 'd2'),
        draft(`SMS;-;${DIEGO}`, 'd3'),
      ],
    });
    expect(rows.map((r) => r.handle)).toEqual([ALICE, BRUNO, DIEGO]);
    // Sorted by handle, so the grid's order is a property of the data and
    // not of which catalogue happened to answer first.
    expect([...rows].map((r) => r.handle).sort()).toEqual(
      rows.map((r) => r.handle),
    );
  });

  it('never leaves the mode cell blank, because absence is not neutral', () => {
    const rows = peopleRows({
      contacts: [policy(ALICE, 'auto')],
      drafts: [draft(`iMessage;-;${DIEGO}`)],
    });
    const cells = new Map(rows.map((r) => [r.handle, modeCell(r)]));
    expect(cells.get(ALICE)).toBe('AUTO');
    // The whole scenario, in one assertion. A screen that rendered `''`
    // here would be describing the strictest state the product has as the
    // absence of a state.
    expect(cells.get(DIEGO)).toBe(UNKNOWN_MODE_SENTENCE);
    expect(UNKNOWN_MODE_SENTENCE).toMatch(/DENIED/);
    for (const row of rows) expect(modeCell(row)).not.toBe('');
  });

  it('carries the service it OBSERVED, and admits when it observed none', () => {
    const rows = peopleRows({
      contacts: [policy(ALICE, 'auto'), policy(CARLA, 'auto')],
      drafts: [draft(`SMS;-;${ALICE}`)],
    });
    const byHandle = new Map(rows.map((r) => [r.handle, r]));
    expect(byHandle.get(ALICE)?.service).toBe('sms');
    // No draft has ever named CARLA, so the screen does not know whether
    // AUTO is reachable for her. `unknown` rather than a guess of
    // `imessage`, which is the guess that would make the clamp invisible.
    expect(byHandle.get(CARLA)?.service).toBe('unknown');
  });

  it('gives a group its guid and no counterparty, and marks it observe-only', () => {
    const rows = peopleRows({
      contacts: [policy(ALICE, 'auto')],
      drafts: [draft(ROOM)],
    });
    const room = rows.find((r) => r.isGroup);
    expect(room).toBeDefined();
    expect(room?.chatGuid).toBe(ROOM);
    // INV-5: a room has no single counterparty, so it has no handle and no
    // policy to set. The grid shows the guid because that is the only name
    // it has.
    expect(room?.handle).toBe('');
    expect(room?.mode).toBeNull();
    expect(rows.filter((r) => r.isGroup)).toHaveLength(1);
  });

  it('counts the drafts already queued per row, and does not dedupe rooms', () => {
    const rows = peopleRows({
      contacts: [],
      drafts: [
        draft(`iMessage;-;${ALICE}`, 'd1'),
        draft(`iMessage;-;${ALICE}`, 'd2'),
        draft(ROOM, 'd3'),
      ],
    });
    const byKey = new Map(rows.map((r) => [r.key, r.queued]));
    expect(byKey.get(ALICE)).toBe(2);
    expect(byKey.get(ROOM)).toBe(1);
  });

  it('keeps the displayName the daemon stored, and never invents one', () => {
    const rows = peopleRows({
      contacts: [policy(ALICE, 'auto', 'Test User 1'), policy(BRUNO, 'deny')],
      drafts: [],
    });
    const byHandle = new Map(rows.map((r) => [r.handle, r]));
    expect(byHandle.get(ALICE)?.displayName).toBe('Test User 1');
    expect(byHandle.get(BRUNO)?.displayName).toBe('');
  });
});

/* ── the filters ──────────────────────────────────────────────────────── */

describe('s8 Sc12: search and the mode chips', () => {
  const rows = (): readonly PersonRow[] =>
    peopleRows({
      contacts: [
        policy(ALICE, 'auto', 'Test User 1'),
        policy(BRUNO, 'draft-only', 'Test User 2'),
        policy(CARLA, 'deny'),
      ],
      drafts: [draft(`SMS;-;${DIEGO}`), draft(ROOM)],
    });

  it('matches a handle or a display name, case-insensitively', () => {
    expect(
      filterRows(rows(), { search: '0000001', mode: '' }).map((r) => r.handle),
    ).toEqual([ALICE]);
    expect(
      filterRows(rows(), { search: 'test user 2', mode: '' }).map(
        (r) => r.handle,
      ),
    ).toEqual([BRUNO]);
    expect(filterRows(rows(), { search: '', mode: '' })).toHaveLength(5);
  });

  it('has a chip for the ABSENCE of a row, which is the one that matters', () => {
    // Four modes on the chip bar, and the fourth is not a mode: 'none' is
    // "no row exists", which the gate treats as the strictest of the lot.
    expect(MODES).toEqual(['auto', 'draft-only', 'deny', 'none']);
    const none = filterRows(rows(), { search: '', mode: 'none' });
    expect(none.map((r) => r.key).sort()).toEqual([DIEGO, ROOM].sort());
    expect(
      filterRows(rows(), { search: '', mode: 'deny' }).map((r) => r.handle),
    ).toEqual([CARLA]);
  });

  it('composes the two, and answers with nothing rather than with everything', () => {
    expect(
      filterRows(rows(), { search: '0000003', mode: 'auto' }),
    ).toHaveLength(0);
  });
});

/* ── the ladder: narrowing only, and provably so ──────────────────────── */

describe('s8 Sc12: contact scope can only narrow what is above it', () => {
  const GLOBALS: readonly RespondMode[] = ['draft-only', 'auto'];
  const CONTACTS: readonly (ContactMode | null)[] = [
    null,
    'deny',
    'draft-only',
    'auto',
  ];
  const RANK: Readonly<Record<string, number>> = {
    deny: 0,
    'draft-only': 1,
    auto: 2,
  };

  it('has no input at all whose result is wider than the global rung', () => {
    for (const global of GLOBALS)
      for (const contact of CONTACTS) {
        const ladder = contactLadder({ global, contact });
        expect(
          RANK[ladder.effective],
          `global=${global} contact=${String(contact)}`,
        ).toBeLessThanOrEqual(RANK[global] as number);
      }
  });

  it('resolves AUTO at contact scope to DRAFT-ONLY under a draft-only global', () => {
    const ladder = contactLadder({ global: 'draft-only', contact: 'auto' });
    expect(ladder.effective).toBe('draft-only');
    expect(ladder.narrowedBy).toEqual(['GLOBAL']);
    // The rung still shows what the operator STORED. Hiding it would make
    // the row unexplainable: the value is real, it is just not reachable.
    expect(ladder.rungs.map((r) => `${r.label}=${r.value}`)).toEqual([
      'GLOBAL=DRAFT-ONLY',
      'RULE=PER RULE',
      'CONTACT=AUTO',
    ]);
    expect(ladder.sentence).toContain('AT MOST DRAFT-ONLY');
    expect(ladder.sentence).toContain('GLOBAL');
  });

  it('states the deny-all default as a fact about rules and agents only', () => {
    const ladder = contactLadder({ global: 'auto', contact: null });
    expect(ladder.effective).toBe('deny');
    expect(ladder.narrowedBy).toEqual(['CONTACT']);
    expect(ladder.rungs[2]?.value).toBe('NO POLICY');
    // The scope of the deny, in words. `evaluateGate` guards step 3 with
    // `ctx.rule !== null || agentOrigin`, and `dispatchApproved` passes no
    // `agentOrigin` and a null rule for a human-minted draft — so a person
    // can still approve for a handle with no row, and a screen that said
    // "DENIED" full stop would be over-claiming.
    expect(ladder.sentence).toMatch(/RULE|AGENT/);
    expect(ladder.sentence).toMatch(/HUMAN/);
  });

  it('treats a stored DENY and a missing row as the same refusal, differently worded', () => {
    const missing = contactLadder({ global: 'auto', contact: null });
    const denied = contactLadder({ global: 'auto', contact: 'deny' });
    expect(denied.effective).toBe(missing.effective);
    // …and NOT the same sentence. The audit trail can answer "did the
    // operator ever decide about this person"; the screen must not throw
    // that distinction away by rendering both as one word.
    expect(denied.sentence).not.toBe(missing.sentence);
  });

  it('reuses the rules screen`s note verbatim, because it is the same ladder', () => {
    expect(contactLadder({ global: 'auto', contact: 'auto' }).note).toBe(
      LADDER_NOTE,
    );
    expect(LADDER_NOTE).toBe('EACH RUNG CAN ONLY NARROW THE ONE ABOVE IT');
  });

  it('admits that the rule rung is per-message and may narrow further', () => {
    const ladder = contactLadder({ global: 'auto', contact: 'auto' });
    expect(ladder.effective).toBe('auto');
    expect(ladder.narrowedBy).toEqual([]);
    expect(ladder.rungs[1]?.value).toBe('PER RULE');
    expect(ladder.sentence).toMatch(/ANY RULE MAY NARROW/);
  });

  it('reads the global rung from the same settings key the rules screen does', () => {
    expect(globalModeOf({})).toBe('draft-only');
    expect(
      globalModeOf({
        'send.globalMode': {
          value: 'auto',
          default: 'draft-only',
          version: 1,
          type: 'enum',
          readOnly: false,
        },
      }),
    ).toBe('auto');
  });
});

/* ── the counters: a join, or a lie ───────────────────────────────────── */

describe('s8 Sc12: AUTO-SENDS is a join through draft.created', () => {
  const created = (id: string, chatGuid: string, at: string): AuditRowPayload =>
    auditRow(at, {
      type: 'draft.created',
      draftId: id,
      draft: { id, chatGuid, state: 'pending' },
    });
  const approved = (id: string, at: string): AuditRowPayload =>
    auditRow(at, {
      type: 'auto.approved',
      draftId: id,
      approvalId: `ap-${id}`,
      ruleId: 'r1',
      adapterId: 'agent-one',
      scopes: { global: 'auto', contact: 'auto', rule: 'auto' },
      scheduleId: null,
    });

  it('attributes each approval to the handle its draft named', () => {
    const tally = autoSendsPerHour(
      [
        approved('d1', minutesBefore(NOW, 1)),
        approved('d2', minutesBefore(NOW, 30)),
        approved('d3', minutesBefore(NOW, 5)),
      ],
      [
        created('d1', `iMessage;-;${ALICE}`, minutesBefore(NOW, 2)),
        created('d2', `iMessage;-;${ALICE}`, minutesBefore(NOW, 31)),
        created('d3', `iMessage;-;${BRUNO}`, minutesBefore(NOW, 6)),
      ],
      NOW,
    );
    expect(tally.get(ALICE)).toEqual({ last2Min: 1, lastHour: 2 } as AutoTally);
    expect(tally.get(BRUNO)).toEqual({ last2Min: 0, lastHour: 1 });
  });

  it('drops an approval whose draft it cannot name, rather than guessing', () => {
    const tally = autoSendsPerHour(
      [approved('ghost', minutesBefore(NOW, 1))],
      [],
      NOW,
    );
    // Not attributed to anybody. `auto.approved` carries no handle, and a
    // count assigned to whoever happened to be first would be a number the
    // operator would act on.
    expect([...tally.keys()]).toEqual([]);
  });

  it('windows on the APPROVAL`s instant, not the draft`s', () => {
    const tally = autoSendsPerHour(
      // The draft is ancient; the approval is a minute old.
      [approved('d1', minutesBefore(NOW, 1))],
      [created('d1', `iMessage;-;${ALICE}`, minutesBefore(NOW, 600))],
      NOW,
    );
    expect(tally.get(ALICE)).toEqual({ last2Min: 1, lastHour: 1 });
  });

  it('excludes what fell out of each window, and the windows are its own', () => {
    expect(AUTO_CAP_WINDOW_MIN).toBe(2);
    expect(AUTO_HOUR_WINDOW_MIN).toBe(60);
    const tally = autoSendsPerHour(
      [
        approved('d1', minutesBefore(NOW, 3)),
        approved('d2', minutesBefore(NOW, 61)),
      ],
      [
        created('d1', `iMessage;-;${ALICE}`, minutesBefore(NOW, 4)),
        created('d2', `iMessage;-;${ALICE}`, minutesBefore(NOW, 62)),
      ],
      NOW,
    );
    expect(tally.get(ALICE)).toEqual({ last2Min: 0, lastHour: 1 });
  });

  it('ignores a room, because INV-5 means nothing auto-sends to one', () => {
    const tally = autoSendsPerHour(
      [approved('d1', minutesBefore(NOW, 1))],
      [created('d1', ROOM, minutesBefore(NOW, 2))],
      NOW,
    );
    expect([...tally.keys()]).toEqual([]);
  });

  it('survives an audit row it cannot parse instead of blanking the screen', () => {
    const broken: AuditRowPayload = {
      seq: 999,
      at: NOW,
      eventJson: '{not json',
      actorJson: '{}',
      prevHash: '',
      hash: '',
    };
    expect(() => autoSendsPerHour([broken], [broken], NOW)).not.toThrow();
    expect(autoSendsPerHour([broken], [broken], NOW).size).toBe(0);
  });

  it('holds a row at ITS OWN cap, comparing each window to its own number', () => {
    // The plan compares a two-HOUR count against a two-MINUTE cap, which
    // cannot be right in any units. `overRateCap` in the gate compares
    // `contactAutoLast2Min` to `capContactPer2Min` and
    // `contactAutoLastHour` to `capContactPerHour`; this mirrors that, and
    // nothing else.
    const caps = { per2Min: 1, perHour: 10 };
    expect(heldBy({ last2Min: 0, lastHour: 0 }, caps)).toBeNull();
    expect(heldBy({ last2Min: 1, lastHour: 3 }, caps)).toBe('rate-limited');
    expect(heldBy({ last2Min: 0, lastHour: 10 }, caps)).toBe('rate-limited');
    expect(heldBy({ last2Min: 0, lastHour: 9 }, caps)).toBeNull();
  });
});

/* ── the precedence footer ────────────────────────────────────────────── */

describe('s8 Sc12: the footer states the gate`s order, split by who it binds', () => {
  it('separates the denies from the clamps, because they bind different people', () => {
    // §2.4.1 / F-64, and the distinction the whole screen rests on. In
    // `dispatchApproved`, `if (!gate.allow) return gateDeny(...)` runs
    // BEFORE `if (isAutoApproval) {...}`, so a deny stops everybody and a
    // clamp stops only the machine.
    expect(DENY_ORDER).toEqual(['KILL', 'LINK', 'CONTACT DENY']);
    expect(NARROW_ORDER).toEqual(['GLOBAL', 'RULE', 'CONTACT', 'GROUP']);
    expect(CLAMP_ORDER).toEqual([
      'WINDOW',
      'RATE CAP',
      'CIRCUIT',
      'LOOP',
      'SMS',
    ]);
  });

  it('puts the narrowing BEFORE the clamps, which the plan`s footer does not', () => {
    // The plan reads `KILL > DENY > window > rate cap > rule mode`. In the
    // gate the mode ladder is resolved first and the clamps then lower it,
    // so a footer with `rule mode` last is describing an evaluation order
    // the daemon has never had.
    const all = [...DENY_ORDER, ...NARROW_ORDER, ...CLAMP_ORDER];
    expect(all.indexOf('RULE')).toBeLessThan(all.indexOf('RATE CAP'));
    expect(all.indexOf('CONTACT DENY')).toBeLessThan(all.indexOf('GLOBAL'));
    expect(new Set(all).size).toBe(all.length);
  });
});

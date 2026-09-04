/**
 * ★ CHECKPOINT — s6-execution Part 2 Scenario 4: the three-scope ladder.
 *
 * §2.4.3's promise is "all three scopes must say auto". Through S5 it was
 * two: `evaluateGate` narrowed `settings.globalMode` by `contact.mode` and
 * never once read `rule.respondMode`, which has been written by the rules
 * route and read by nothing since S2 (C-4, F-63). This file is the proof
 * that the third scope is now in the ladder, and it is written so that the
 * ONE cell in which autonomy survives is established by the twenty-six
 * cells in which it does not.
 *
 * **The matrix.** Three scopes, three ladder positions each, 27 cells:
 *
 * ```
 * position     global scope            contact scope     rule scope
 * ---------------------------------------------------------------------------
 * off          settings.killSwitch     contact.mode      scheduleId set, the
 *              (the operator's         'deny'            schedule NOT armed
 *              global hard no)                           at `now`
 * draft-only   globalMode              contact.mode      respondMode
 *              'draft-only'            'draft-only'      'draft-only'
 * auto         globalMode 'auto'       contact.mode      respondMode 'auto'
 *                                      'auto'            (always armed)
 * ```
 *
 * The spec's row-1 enumeration (`globalMode ∈ {draft-only, auto}` ×
 * `contact.mode ∈ {deny, draft-only, auto}` × `rule.respondMode ∈
 * {draft-only, auto}`) is the twelve-cell INTERIOR of this table: it is the
 * sub-block with global ≠ off and rule ≠ off, and it is asserted separately
 * below so the spec's own wording has its own row. The `off` column of each
 * scope extends the same table over the three ways a scope can withhold
 * autonomy outright, which is what makes "exactly one auto cell" a claim
 * about the whole ladder rather than about its comfortable middle.
 *
 * Every expectation is a literal in `MATRIX`, never a re-derivation: an
 * oracle that recomputes `narrower()` would agree with a broken gate for
 * exactly the reason the gate was broken.
 *
 * Positive/negative split: 1 cell allows `auto`, 26 do not (9 kill-switch
 * denies, 6 contact denies, 4 outside-window clamps, 7 plain draft-only
 * narrowings). `exactly one cell in the matrix resolves auto` asserts the
 * count over the whole table, so a future widening cannot pass by adding an
 * auto cell somewhere the row-by-row reader is not looking.
 */
import { describe, expect, it } from 'vitest';
import type {
  ContactMode,
  ContactPolicy,
  GateContext,
  GateDecision,
  RespondMode,
  Rule,
  Schedule,
} from '@wemessage/core';
import { evaluateGate } from '@wemessage/core';
import { makeSchedule, PINNED_ZONES } from './fixtures/schedules.js';

/** A Monday inside 09:00–17:00 Los Angeles: 2026-09-07 10:00 PDT. */
const NOW_INSIDE = '2026-09-07T17:00:00.000Z';
/** The same Monday at 20:00 PDT, two minutes' walk outside the window. */
const NOW_OUTSIDE = '2026-09-08T03:00:00.000Z';

const HANDLE = '+15551234567';
const CHAT_GUID = 'iMessage;-;+15551234567';

const officeHours: Schedule = makeSchedule(
  '01SCHEDOFFICE',
  'office-hours',
  PINNED_ZONES.losAngeles,
  [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }],
);

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: '01RULE',
    name: 'rule',
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['x'], mode: 'any' },
    adapterId: 'echo',
    respondMode: 'auto',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: true,
    matchAttachmentOnly: false,
    draftTtlMinutes: 240,
    priority: 100,
    createdAt: NOW_INSIDE,
    updatedAt: NOW_INSIDE,
    ...overrides,
  };
}

function policy(mode: ContactMode): ContactPolicy {
  return { handle: HANDLE, mode, updatedAt: NOW_INSIDE };
}

interface CtxParts {
  killSwitch?: boolean;
  globalMode?: RespondMode;
  contact?: ContactPolicy | null;
  rule?: Rule | null;
  schedule?: Schedule | null;
  now?: string;
}

function ctx(parts: CtxParts = {}): GateContext {
  return {
    now: parts.now ?? NOW_INSIDE,
    settings: {
      killSwitch: parts.killSwitch ?? false,
      globalMode: parts.globalMode ?? 'draft-only',
      connectionState: 'fully-connected',
      allowSmsAuto: false,
    },
    rule: parts.rule === undefined ? makeRule() : parts.rule,
    schedule: parts.schedule ?? null,
    contact: parts.contact === undefined ? policy('auto') : parts.contact,
    message: {
      isGroup: false,
      service: 'imessage',
      handle: HANDLE,
      chatGuid: CHAT_GUID,
    },
    counters: {
      contactAutoLast2Min: 0,
      contactAutoLastHour: 0,
      globalSentLastHour: 0,
      consecutiveAutoInChat: 0,
      circuitOpen: false,
    },
  };
}

// --- the three scopes, each at its three ladder positions -------------------

type Position = 'off' | 'draft-only' | 'auto';
const POSITIONS: readonly Position[] = ['off', 'draft-only', 'auto'];

/** The global scope's `off` is the kill switch: the operator's global no. */
function globalParts(p: Position): CtxParts {
  if (p === 'off') return { killSwitch: true, globalMode: 'auto' };
  return { globalMode: p };
}

/** The contact scope's `off` is §2.4.3's explicit `deny`. */
function contactParts(p: Position): CtxParts {
  return { contact: policy(p === 'off' ? 'deny' : p) };
}

/**
 * The rule scope's `off` is a rule that WOULD say auto pointed at a
 * schedule that is closed right now — the rule scope's "not at this hour".
 * `respondMode` stays 'auto' there on purpose, so the only thing withholding
 * autonomy in those cells is the window.
 */
function ruleParts(p: Position): CtxParts {
  if (p === 'off') {
    return {
      rule: makeRule({ respondMode: 'auto', scheduleId: officeHours.id }),
      schedule: officeHours,
      now: NOW_OUTSIDE,
    };
  }
  return { rule: makeRule({ respondMode: p }) };
}

function cellCtx(g: Position, c: Position, r: Position): GateContext {
  return ctx({ ...globalParts(g), ...contactParts(c), ...ruleParts(r) });
}

const DENY_KILL: GateDecision = { allow: false, reason: 'kill-switch' };
const DENY_CONTACT: GateDecision = { allow: false, reason: 'contact-denied' };
const DRAFT_ONLY: GateDecision = { allow: true, mode: 'draft-only' };
const CLAMPED: GateDecision = {
  allow: true,
  mode: 'draft-only',
  clampedBy: 'outside-window',
};
const AUTO: GateDecision = { allow: true, mode: 'auto' };

/**
 * The 27 cells, written out. Keys read `global/contact/rule`. Nothing here
 * is computed: a table that derives its own expectations proves only that
 * the deriver and the gate share a bug.
 */
const MATRIX: ReadonlyArray<
  readonly [Position, Position, Position, GateDecision]
> = [
  // global off — the kill switch dominates every other scope, including the
  // clamp (spec row 8: a deny is never expressed as a clamp).
  ['off', 'off', 'off', DENY_KILL],
  ['off', 'off', 'draft-only', DENY_KILL],
  ['off', 'off', 'auto', DENY_KILL],
  ['off', 'draft-only', 'off', DENY_KILL],
  ['off', 'draft-only', 'draft-only', DENY_KILL],
  ['off', 'draft-only', 'auto', DENY_KILL],
  ['off', 'auto', 'off', DENY_KILL],
  ['off', 'auto', 'draft-only', DENY_KILL],
  ['off', 'auto', 'auto', DENY_KILL],

  // global draft-only
  ['draft-only', 'off', 'off', DENY_CONTACT],
  ['draft-only', 'off', 'draft-only', DENY_CONTACT],
  ['draft-only', 'off', 'auto', DENY_CONTACT],
  ['draft-only', 'draft-only', 'off', CLAMPED],
  ['draft-only', 'draft-only', 'draft-only', DRAFT_ONLY],
  ['draft-only', 'draft-only', 'auto', DRAFT_ONLY],
  ['draft-only', 'auto', 'off', CLAMPED],
  ['draft-only', 'auto', 'draft-only', DRAFT_ONLY],
  ['draft-only', 'auto', 'auto', DRAFT_ONLY],

  // global auto
  ['auto', 'off', 'off', DENY_CONTACT],
  ['auto', 'off', 'draft-only', DENY_CONTACT],
  ['auto', 'off', 'auto', DENY_CONTACT],
  ['auto', 'draft-only', 'off', CLAMPED],
  ['auto', 'draft-only', 'draft-only', DRAFT_ONLY],
  ['auto', 'draft-only', 'auto', DRAFT_ONLY],
  ['auto', 'auto', 'off', CLAMPED],
  ['auto', 'auto', 'draft-only', DRAFT_ONLY],
  // THE cell. The only one in the table.
  ['auto', 'auto', 'auto', AUTO],
];

describe('the 3×3×3 scope matrix (s6 Scenario 4 row 1)', () => {
  it('enumerates every cell exactly once', () => {
    const keys = MATRIX.map(([g, c, r]) => `${g}/${c}/${r}`);
    expect(keys).toHaveLength(27);
    expect(new Set(keys).size).toBe(27);
    const expected = POSITIONS.flatMap((g) =>
      POSITIONS.flatMap((c) => POSITIONS.map((r) => `${g}/${c}/${r}`)),
    );
    expect([...keys].sort()).toEqual([...expected].sort());
  });

  it.each(MATRIX)('global=%s contact=%s rule=%s', (g, c, r, expected) => {
    expect(evaluateGate(cellCtx(g, c, r))).toEqual(expected);
  });

  it('exactly one cell in the matrix resolves auto', () => {
    const autoCells = MATRIX.map(
      ([g, c, r]) => [g, c, r, evaluateGate(cellCtx(g, c, r))] as const,
    )
      .filter(([, , , d]) => d.allow && d.mode === 'auto')
      .map(([g, c, r]) => `${g}/${c}/${r}`);
    expect(autoCells).toEqual(['auto/auto/auto']);
  });

  it('the other twenty-six cells withhold autonomy', () => {
    const withheld = MATRIX.map(([g, c, r]) =>
      evaluateGate(cellCtx(g, c, r)),
    ).filter((d) => !d.allow || d.mode !== 'auto');
    expect(withheld).toHaveLength(26);
  });

  it("the spec's twelve-cell interior (globalMode × contactMode × respondMode)", () => {
    // The row-1 enumeration verbatim: the sub-block with global ≠ off and
    // rule ≠ off. Every `deny` cell is contact-denied, every other cell is
    // allow/draft-only, and `auto` appears once.
    const interior = MATRIX.filter(([g, , r]) => g !== 'off' && r !== 'off');
    expect(interior).toHaveLength(12);
    const byShape = { denied: 0, draftOnly: 0, auto: 0 };
    for (const [g, c, r, expected] of interior) {
      const decision = evaluateGate(cellCtx(g, c, r));
      expect(decision, `${g}/${c}/${r}`).toEqual(expected);
      if (!decision.allow) {
        expect(decision.reason).toBe('contact-denied');
        byShape.denied += 1;
      } else if (decision.mode === 'auto') {
        byShape.auto += 1;
      } else {
        byShape.draftOnly += 1;
      }
    }
    expect(byShape).toEqual({ denied: 4, draftOnly: 7, auto: 1 });
  });
});

describe('no scope widens (s6 Scenario 4 row 2)', () => {
  it('a contact set to auto under a draft-only global resolves draft-only', () => {
    expect(
      evaluateGate(
        ctx({
          globalMode: 'draft-only',
          contact: policy('auto'),
          rule: makeRule(),
        }),
      ),
    ).toEqual({ allow: true, mode: 'draft-only' });
  });

  it('a rule set to auto under a draft-only contact resolves draft-only', () => {
    expect(
      evaluateGate(
        ctx({
          globalMode: 'auto',
          contact: policy('draft-only'),
          rule: makeRule({ respondMode: 'auto' }),
        }),
      ),
    ).toEqual({ allow: true, mode: 'draft-only' });
  });

  it('a rule set to auto under a draft-only GLOBAL resolves draft-only', () => {
    expect(
      evaluateGate(
        ctx({
          globalMode: 'draft-only',
          contact: policy('auto'),
          rule: makeRule({ respondMode: 'auto' }),
        }),
      ),
    ).toEqual({ allow: true, mode: 'draft-only' });
  });

  it('the rule scope is READ: an auto global + auto contact + draft-only rule is draft-only (C-4 retired)', () => {
    // This is the single cell that passed before this scenario for the wrong
    // reason: `rule.respondMode` was written by the rules route and read by
    // nothing, so the two-scope ladder answered 'auto' here.
    expect(
      evaluateGate(
        ctx({
          globalMode: 'auto',
          contact: policy('auto'),
          rule: makeRule({ respondMode: 'draft-only' }),
        }),
      ),
    ).toEqual({ allow: true, mode: 'draft-only' });
  });

  it('no combination of scope inputs produces auto from a draft-only parent', () => {
    const modes: readonly RespondMode[] = ['draft-only', 'auto'];
    const contacts: readonly ContactMode[] = ['deny', 'draft-only', 'auto'];
    const widened: string[] = [];
    for (const globalMode of modes) {
      for (const contactMode of contacts) {
        for (const respondMode of modes) {
          const parents = [globalMode, contactMode, respondMode];
          if (parents.every((p) => p === 'auto')) continue;
          const decision = evaluateGate(
            ctx({
              globalMode,
              contact: policy(contactMode),
              rule: makeRule({ respondMode }),
            }),
          );
          if (decision.allow && decision.mode === 'auto') {
            widened.push(parents.join('/'));
          }
        }
      }
    }
    expect(widened).toEqual([]);
  });
});

describe('the schedule clamp (s6 Scenario 4 rows 3 and 4)', () => {
  const allAuto: CtxParts = {
    globalMode: 'auto',
    contact: policy('auto'),
  };

  it('all three scopes auto + an ARMED schedule -> auto, unclamped', () => {
    expect(
      evaluateGate(
        ctx({
          ...allAuto,
          rule: makeRule({ scheduleId: officeHours.id }),
          schedule: officeHours,
          now: NOW_INSIDE,
        }),
      ),
    ).toEqual({ allow: true, mode: 'auto' });
  });

  it('all three scopes auto + a CLOSED window -> draft-only, clampedBy outside-window', () => {
    expect(
      evaluateGate(
        ctx({
          ...allAuto,
          rule: makeRule({ scheduleId: officeHours.id }),
          schedule: officeHours,
          now: NOW_OUTSIDE,
        }),
      ),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
  });

  it('scheduleId null means always armed: the same inputs resolve auto', () => {
    expect(
      evaluateGate(
        ctx({
          ...allAuto,
          rule: makeRule({ scheduleId: null }),
          now: NOW_OUTSIDE,
        }),
      ),
    ).toEqual({ allow: true, mode: 'auto' });
  });

  it('a DANGLING scheduleId (schedule row deleted, ctx.schedule null) clamps — never always-armed', () => {
    expect(
      evaluateGate(
        ctx({
          ...allAuto,
          rule: makeRule({ scheduleId: '01SCHEDGONE' }),
          schedule: null,
          now: NOW_INSIDE,
        }),
      ),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
  });

  it('a DISABLED schedule clamps even inside its own window (§2.4.2 fail-closed)', () => {
    const disabled = makeSchedule(
      officeHours.id,
      officeHours.name,
      officeHours.timezone,
      [...officeHours.windows],
      false,
    );
    expect(
      evaluateGate(
        ctx({
          ...allAuto,
          rule: makeRule({ scheduleId: disabled.id }),
          schedule: disabled,
          now: NOW_INSIDE,
        }),
      ),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
  });

  it('a schedule with NO windows clamps (empty is never armed, not unconstrained)', () => {
    const empty = makeSchedule(
      '01SCHEDEMPTY',
      'empty',
      PINNED_ZONES.losAngeles,
      [],
    );
    expect(
      evaluateGate(
        ctx({
          ...allAuto,
          rule: makeRule({ scheduleId: empty.id }),
          schedule: empty,
          now: NOW_INSIDE,
        }),
      ),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
  });

  it('the clamp is recorded even when the mode was ALREADY draft-only', () => {
    // A clamp is a fact about autonomy, not a transition in `mode`. Sc 5's
    // `outsideWindow: 'ignore'` reads `clampedBy`, and it must still see the
    // closed window when a draft-only contact got there first.
    expect(
      evaluateGate(
        ctx({
          globalMode: 'auto',
          contact: policy('draft-only'),
          rule: makeRule({ scheduleId: officeHours.id }),
          schedule: officeHours,
          now: NOW_OUTSIDE,
        }),
      ),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'outside-window',
    });
  });

  it('a schedule is only consulted through the RULE: a human path ignores it', () => {
    // `rule: null` is the F-20 human pin. There is no scheduleId to read, so
    // a schedule handed in alongside it changes nothing.
    expect(
      evaluateGate(
        ctx({
          globalMode: 'auto',
          contact: null,
          rule: null,
          schedule: officeHours,
          now: NOW_OUTSIDE,
        }),
      ),
    ).toEqual({ allow: true, mode: 'auto' });
  });
});

describe('clampedBy is omitted, never undefined (s6 Scenario 4 row 5)', () => {
  it('an unclamped allow has no clampedBy KEY at all', () => {
    const decision = evaluateGate(
      ctx({ globalMode: 'auto', contact: policy('auto'), rule: makeRule() }),
    );
    expect(decision).toEqual({ allow: true, mode: 'auto' });
    expect('clampedBy' in decision).toBe(false);
    expect(Object.keys(decision).sort()).toEqual(['allow', 'mode']);
  });

  it('an unclamped draft-only allow has no clampedBy KEY either', () => {
    const decision = evaluateGate(ctx({ globalMode: 'draft-only' }));
    expect('clampedBy' in decision).toBe(false);
    expect(Object.keys(decision).sort()).toEqual(['allow', 'mode']);
  });

  it('a deny carries no clampedBy and no mode', () => {
    const decision = evaluateGate(ctx({ killSwitch: true }));
    expect(Object.keys(decision).sort()).toEqual(['allow', 'reason']);
  });

  it('a clamped allow carries exactly allow, mode and clampedBy', () => {
    const decision = evaluateGate(
      ctx({
        globalMode: 'auto',
        contact: policy('auto'),
        rule: makeRule({ scheduleId: officeHours.id }),
        schedule: officeHours,
        now: NOW_OUTSIDE,
      }),
    );
    expect(Object.keys(decision).sort()).toEqual([
      'allow',
      'clampedBy',
      'mode',
    ]);
  });
});

describe('a deny is never expressed as a clamp (s6 Scenario 4 row 8)', () => {
  const clamped: CtxParts = {
    globalMode: 'auto',
    contact: policy('auto'),
    rule: makeRule({ scheduleId: officeHours.id }),
    schedule: officeHours,
    now: NOW_OUTSIDE,
  };

  it('the kill switch outranks the clamp', () => {
    expect(evaluateGate(ctx({ ...clamped, killSwitch: true }))).toEqual({
      allow: false,
      reason: 'kill-switch',
    });
  });

  it('a disconnected daemon outranks the clamp', () => {
    const base = ctx(clamped);
    expect(
      evaluateGate({
        ...base,
        settings: { ...base.settings, connectionState: 'disconnected' },
      }),
    ).toEqual({ allow: false, reason: 'disconnected' });
  });

  it('a read-only daemon outranks the clamp', () => {
    const base = ctx(clamped);
    expect(
      evaluateGate({
        ...base,
        settings: { ...base.settings, connectionState: 'read-only' },
      }),
    ).toEqual({ allow: false, reason: 'read-only' });
  });

  it('a denied contact outranks the clamp', () => {
    expect(evaluateGate(ctx({ ...clamped, contact: policy('deny') }))).toEqual({
      allow: false,
      reason: 'contact-denied',
    });
  });

  it('an unknown contact outranks the clamp', () => {
    expect(evaluateGate(ctx({ ...clamped, contact: null }))).toEqual({
      allow: false,
      reason: 'contact-denied',
    });
  });
});

/**
 * The honest successor to `gate.spec.ts`'s retired "schedules, counters and
 * the circuit are plumbed-but-unread" row (spec row 7). Schedules ARE read
 * now, so the old claim was already false for them; s6 Sc 6 made it false for
 * the rate counters too, and the row shrank to exactly what remains unread.
 *
 * That shrinking is the point of keeping the row at all. A "we do not read
 * this" pin that is not narrowed the moment a field is claimed becomes a
 * green test asserting a lie, and the next scenario reads the lie as
 * permission. s6 Sc 8 has now claimed `consecutiveAutoInChat`, the last one,
 * so the unread half of this describe is EMPTY and every `GateCounters` field
 * is live. What remains is the claimed half: each field proved to change a
 * decision, so nobody can narrow a "we do not read this" row by deleting a
 * field instead of implementing it.
 */
describe('every counter is now claimed, and each one is proved so', () => {
  /**
   * Was 'a runaway auto streak changes no decision' — the last unread-field
   * row, INVERTED by s6 Sc 8 rather than deleted. Deleting it would have
   * removed the only place that says what changed; inverting it says the
   * streak is read now and pins WHICH literal it clamps with.
   */
  it('a runaway auto STREAK now clamps, which is what "claimed" means', () => {
    const base = ctx({
      globalMode: 'auto',
      contact: policy('auto'),
      rule: makeRule(),
    });
    expect(
      evaluateGate({
        ...base,
        counters: { ...base.counters, consecutiveAutoInChat: 9999 },
      }),
    ).toEqual({ allow: true, mode: 'draft-only', clampedBy: 'loop-detected' });
  });

  /**
   * The other half of the same claim, now that the rate counters ARE read:
   * hostile values there DO change the decision. Without this the row above
   * could be narrowed by deleting fields rather than by implementing them.
   */
  it('hostile RATE counters now clamp, which is what "claimed" means', () => {
    const base = ctx({
      globalMode: 'auto',
      contact: policy('auto'),
      rule: makeRule(),
    });
    expect(
      evaluateGate({
        ...base,
        counters: { ...base.counters, contactAutoLast2Min: 9999 },
      }),
    ).toEqual({ allow: true, mode: 'draft-only', clampedBy: 'rate-limited' });
  });

  /** And the same for the field s6 Sc 7 just claimed (F-65). */
  it('a hostile CIRCUIT now clamps, which is what "claimed" means', () => {
    const base = ctx({
      globalMode: 'auto',
      contact: policy('auto'),
      rule: makeRule(),
    });
    expect(
      evaluateGate({
        ...base,
        counters: { ...base.counters, circuitOpen: true },
      }),
    ).toEqual({ allow: true, mode: 'draft-only', clampedBy: 'circuit-open' });
  });

  it('a never-armed schedule changes nothing when the rule points at no schedule', () => {
    const never = makeSchedule(
      '01SCHEDNEVER',
      'never',
      PINNED_ZONES.losAngeles,
      [],
    );
    expect(
      evaluateGate(
        ctx({
          globalMode: 'auto',
          contact: policy('auto'),
          rule: makeRule({ scheduleId: null }),
          schedule: never,
        }),
      ),
    ).toEqual({ allow: true, mode: 'auto' });
  });

  /**
   * Claimed by s6 Sc 9 (F-74). This row was written in Sc 7 as "not yet
   * clamped", the last of the five counters still inert, and it is rewritten
   * here in the commit that makes it bite rather than being deleted: the
   * point of the block is that every field the context carries is now load
   * bearing, and the way you prove a field is load bearing is that setting
   * it hostile changes the answer.
   *
   * `allowSmsAuto` defaults false, so this needs no hostile setting at all,
   * only a service that is not iMessage. Both halves are asserted, because
   * an operator who turns the setting on must actually get autonomy back.
   */
  it('a non-iMessage service now clamps, and the setting un-clamps it', () => {
    const base = ctx({
      globalMode: 'auto',
      contact: policy('auto'),
      rule: makeRule(),
    });
    expect(
      evaluateGate({
        ...base,
        message: { ...base.message, service: 'sms' },
      }),
    ).toEqual({
      allow: true,
      mode: 'draft-only',
      clampedBy: 'sms-auto-forbidden',
    });
    expect(
      evaluateGate({
        ...base,
        message: { ...base.message, service: 'sms' },
        settings: { ...base.settings, allowSmsAuto: true },
      }),
    ).toEqual({ allow: true, mode: 'auto' });
  });
});

describe('the S4/S5 ladder is intact underneath the new scope', () => {
  it('the F-20 human pin: rule null + contact null still allows at the global mode', () => {
    expect(
      evaluateGate(ctx({ globalMode: 'auto', rule: null, contact: null })),
    ).toEqual({ allow: true, mode: 'auto' });
  });

  it('the INV-5 group clamp still beats a fully-auto three-scope ladder', () => {
    const base = ctx({
      globalMode: 'auto',
      contact: policy('auto'),
      rule: makeRule(),
    });
    expect(
      evaluateGate({
        ...base,
        message: {
          isGroup: true,
          service: 'imessage',
          handle: '',
          chatGuid: 'iMessage;+;chat123456789',
        },
      }),
    ).toEqual({ allow: true, mode: 'draft-only' });
  });

  it('the F-50 agentOrigin clamp still beats a fully-auto three-scope ladder', () => {
    const base = ctx({
      globalMode: 'auto',
      contact: policy('auto'),
      rule: makeRule(),
    });
    expect(evaluateGate({ ...base, agentOrigin: true })).toEqual({
      allow: true,
      mode: 'draft-only',
    });
  });
});

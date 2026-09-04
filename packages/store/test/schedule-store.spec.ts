/**
 * s6 Scenario 3 (store half) — the `schedules` table stops being unused.
 * Spec: docs/plans/slices/s6-execution.md Part 2 Scenario 3 RED rows 1-4;
 * §1.5 port body extensions. Real temp-dir SqliteStore, fake Clock
 * (§4.0 hand-rolled fakes). NO migration: `schedules` and
 * `rules.schedule_id` have both been in migration 0001 since S1 (F-61), so
 * this scenario is body-only — the DDL below is asserted, never written.
 *
 * Covered here:
 *  - insert -> get -> list round-trip: `windows` survives as JSON, `enabled`
 *    is stored as an INTEGER and read back as a boolean, `timezone` is
 *    preserved VERBATIM (an IANA string is a key into a tz database; any
 *    normalisation here is a silent behaviour change at the gate);
 *  - updateSchedule on an absent id THROWS (the `updateRule` precedent:
 *    a full-row update that silently writes nothing is a lost edit);
 *    deleteSchedule on an absent id is a NO-OP (idempotent delete);
 *  - countRulesUsingSchedule counts DISABLED rules too — a disabled rule
 *    still holds the foreign key, so deleting its schedule would still trip
 *    the FK, and the 409 predicate (F-75) has to see it;
 *  - the FK holds both ways: a rule may now carry a non-null schedule_id,
 *    and a rule pointing at an absent schedule is REJECTED by SQLite;
 *  - §2.4.2 fail-closed: a DANGLING schedule_id (only reachable with
 *    foreign_keys off) reads back as a rule whose `getSchedule` is `null`,
 *    and a DISABLED schedule reads back with `enabled:false`. Both are the
 *    store's honest answer; "never armed" is the caller's obligation and is
 *    asserted at the gate in Scenario 4.
 *
 * Timezones are drawn from the five pinned by `test/arch.spec.ts` row (f)
 * and are here for offset SHAPE, never because anyone lives there.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, Rule, Schedule } from '@wemessage/core';
import { openStore, type SqliteStore } from '@wemessage/store';

function fakeClock(iso = '2026-09-04T12:00:00.000Z'): Clock {
  return { now: () => iso, nowMs: () => Date.parse(iso) };
}

/** Full Schedule factory — every field explicit so toStrictEqual has teeth. */
function makeSchedule(partial: Partial<Schedule> & { id: string }): Schedule {
  return {
    name: `schedule-${partial.id}`,
    timezone: 'America/Los_Angeles',
    windows: [
      {
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '09:00',
        end: '17:00',
      },
    ],
    enabled: true,
    ...partial,
  };
}

/** Full Rule factory — mirrors rules-store.spec.ts's, scheduleId overridable. */
function makeRule(partial: Partial<Rule> & { id: string }): Rule {
  return {
    name: `rule-${partial.id}`,
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['hi'], mode: 'any' },
    adapterId: 'echo',
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 240,
    priority: 100,
    createdAt: '2026-09-04T10:00:00.000Z',
    updatedAt: '2026-09-04T10:00:00.000Z',
    ...partial,
  };
}

describe('store: schedules CRUD + the rules FK (s6 Scenario 3)', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wemessage-schedule-store-'));
    store = openStore({ dir, clock: fakeClock() });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- RED row 1 -----------------------------------------------------------
  it('round-trips every field: windows as JSON, enabled as an integer, timezone verbatim', () => {
    const multi = makeSchedule({
      id: '01SCHEDROUNDTRIP0000000000',
      name: 'front desk',
      // +05:30. A half-hour offset is the shape most likely to be broken by
      // an accidental "normalisation" somewhere in the round-trip.
      timezone: 'Asia/Kolkata',
      windows: [
        { days: ['mon', 'wed'], start: '09:00', end: '17:00' },
        // A window that wraps midnight — the JSON has to survive it as data;
        // the wrap itself is core's problem (Scenario 2), not the store's.
        { days: ['fri'], start: '22:00', end: '02:00' },
      ],
    });
    store.insertSchedule(multi);

    expect(store.getSchedule(multi.id)).toStrictEqual(multi);
    expect(store.getSchedule('01SCHEDNOSUCHID00000000000')).toBeNull();

    // The COLUMN shapes, not just the round-trip: `windows` is JSON TEXT and
    // `enabled` is an INTEGER (§2.3). Asserted through the raw handle so a
    // future store that stored windows as, say, a comma list would fail here
    // rather than passing the round-trip by symmetry.
    const raw = store.db
      .prepare('SELECT windows, enabled, timezone FROM schedules WHERE id = ?')
      .get(multi.id) as { windows: string; enabled: number; timezone: string };
    expect(typeof raw.windows).toBe('string');
    expect(JSON.parse(raw.windows)).toStrictEqual(multi.windows);
    expect(raw.enabled).toBe(1);
    expect(raw.timezone).toBe('Asia/Kolkata');

    const disabled = makeSchedule({
      id: '01SCHEDDISABLED00000000000',
      enabled: false,
    });
    store.insertSchedule(disabled);
    expect(
      (
        store.db
          .prepare('SELECT enabled FROM schedules WHERE id = ?')
          .get(disabled.id) as { enabled: number }
      ).enabled,
    ).toBe(0);

    // list is id ASC — deterministic order, the listRules (F-12) precedent.
    expect(store.listSchedules()).toStrictEqual([disabled, multi]);
  });

  // --- RED row 2 -----------------------------------------------------------
  it('updateSchedule throws on an absent id; deleteSchedule on an absent id is a no-op', () => {
    const s = makeSchedule({ id: '01SCHEDUPDATE0000000000000' });
    store.insertSchedule(s);

    const edited: Schedule = {
      ...s,
      name: 'renamed',
      timezone: 'Asia/Kolkata',
      windows: [{ days: ['sat', 'sun'], start: '10:00', end: '14:00' }],
      enabled: false,
    };
    store.updateSchedule(edited);
    expect(store.getSchedule(s.id)).toStrictEqual(edited);

    expect(() =>
      store.updateSchedule(makeSchedule({ id: '01SCHEDGHOST0000000000000A' })),
    ).toThrow(/no such schedule/i);

    // Idempotent delete: absent is not an error, and it does not disturb the
    // rows that DO exist.
    expect(() =>
      store.deleteSchedule('01SCHEDGHOST0000000000000A'),
    ).not.toThrow();
    expect(store.listSchedules()).toHaveLength(1);
    store.deleteSchedule(s.id);
    expect(store.getSchedule(s.id)).toBeNull();
    expect(store.listSchedules()).toHaveLength(0);
  });

  it('countRulesUsingSchedule counts enabled AND disabled referencing rules', () => {
    const s = makeSchedule({ id: '01SCHEDCOUNTED000000000000' });
    const other = makeSchedule({ id: '01SCHEDUNCOUNTED0000000000' });
    store.insertSchedule(s);
    store.insertSchedule(other);
    expect(store.countRulesUsingSchedule(s.id)).toBe(0);

    store.insertRule(
      makeRule({ id: '01RULEENABLED00000000000AA', scheduleId: s.id }),
    );
    store.insertRule(
      makeRule({
        id: '01RULEDISABLED0000000000AA',
        scheduleId: s.id,
        enabled: false,
      }),
    );
    // Neither of these two references `s`.
    store.insertRule(
      makeRule({ id: '01RULEOTHERSCHED000000000A', scheduleId: other.id }),
    );
    store.insertRule(makeRule({ id: '01RULENOSCHEDULE000000000A' }));

    // A disabled rule still holds the FK, so the 409 predicate (F-75) must
    // see it: deleting `s` would otherwise fail at SQLite with an opaque
    // constraint error after the route had already promised a 204.
    expect(store.countRulesUsingSchedule(s.id)).toBe(2);
    expect(store.countRulesUsingSchedule(other.id)).toBe(1);
    expect(store.countRulesUsingSchedule('01SCHEDGHOST0000000000000A')).toBe(0);
  });

  // --- RED row 3 -----------------------------------------------------------
  it('a rule may carry a non-null schedule_id, and the FK rejects an absent one', () => {
    // foreign_keys is ON, asserted rather than assumed (rules-store precedent).
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);

    const s = makeSchedule({ id: '01SCHEDFKHOLDS000000000000' });
    store.insertSchedule(s);
    const armed = makeRule({
      id: '01RULEARMED0000000000000AA',
      scheduleId: s.id,
    });
    store.insertRule(armed);
    expect(store.getRule(armed.id)).toStrictEqual(armed);

    expect(() =>
      store.insertRule(
        makeRule({
          id: '01RULEDANGLING00000000000A',
          scheduleId: '01SCHEDGHOST0000000000000A',
        }),
      ),
    ).toThrow(/FOREIGN KEY/i);
    expect(store.getRule('01RULEDANGLING00000000000A')).toBeNull();
  });

  // --- RED row 4 -----------------------------------------------------------
  it('a dangling schedule_id reads back as a rule whose getSchedule is null (fail-closed input)', () => {
    const s = makeSchedule({ id: '01SCHEDDOOMED00000000000AA' });
    store.insertSchedule(s);
    const rule = makeRule({
      id: '01RULEORPHANED000000000000',
      scheduleId: s.id,
    });
    store.insertRule(rule);

    // The ONLY way to produce this state is to defeat the FK, which is
    // exactly why it is worth pinning: a database restored from a partial
    // backup, or edited by hand, must not read as "no schedule, so always
    // armed".
    store.db.pragma('foreign_keys = OFF');
    store.db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
    store.db.pragma('foreign_keys = ON');

    // The rule is still readable and still names the schedule...
    expect(store.getRule(rule.id)?.scheduleId).toBe(s.id);
    // ...and the store answers honestly that the schedule is gone. `null` is
    // NOT "unconstrained": Scenario 4 asserts the gate clamps this to
    // draft-only with clampedBy 'outside-window'.
    expect(store.getSchedule(s.id)).toBeNull();
  });

  it('a disabled schedule round-trips as disabled, never as absent', () => {
    const s = makeSchedule({
      id: '01SCHEDOFF00000000000000AA',
      enabled: false,
    });
    store.insertSchedule(s);
    const read = store.getSchedule(s.id);
    expect(read).not.toBeNull();
    expect(read?.enabled).toBe(false);
    // "Disabled" and "missing" are different facts with the same consequence
    // (never armed). Collapsing them would cost the audit trail the ability
    // to say whether an operator ever configured this schedule at all.
    expect(store.listSchedules().map((x) => x.id)).toStrictEqual([s.id]);
  });
});

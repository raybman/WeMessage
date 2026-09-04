/**
 * §1.6: `/v1/schedules` CRUD (s6 Scenario 3) — five routes over the §2.3
 * `schedules` table, which has existed unused since migration 0001.
 *
 * Validation contract (§1.6 "HTTP semantics", errors as { error, detail? }):
 *  - a zone this runtime cannot project into → 400 {error:'invalid-timezone'};
 *  - a malformed `HH:MM` or an empty `days[]` → 400 {error:'invalid-window'};
 *  - unknown id → 404 {error:'not-found'};
 *  - delete of a schedule some rule points at → 409 {error:'schedule-in-use',
 *    detail:{rules:N}}, raised AHEAD of the foreign key (F-75). Letting the FK
 *    fire would surface as an opaque 500 telling the operator neither what is
 *    wrong nor how much of it there is.
 *
 * Both validators are core's (`validateTimezone`, `validateWindow`): the tz
 * math is `Intl`-only and lives in exactly one place (INV-1, arch row (e)),
 * so the route cannot drift from the gate that later reads these windows.
 *
 * `days[]` is stored CANONICAL — deduped and in week order — so the two ways
 * a human spells one week ('fri','mon','mon' and 'mon','fri') cannot round-
 * trip apart, and a diff of two schedules means what it looks like it means.
 * Times are NOT normalised: '09:00' is already the only accepted spelling.
 *
 * Audit (§1.8): create/update/delete append exactly ONE row with actor
 * {kind:'human', via:'api'}; create and update carry the full post-image, so
 * §1.7's obligation — reconstruct an autonomous send from the chain ALONE —
 * survives the schedule being edited or deleted afterwards. Reads audit
 * nothing. A refused write audits nothing.
 */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';
import {
  humanApiActor,
  validateTimezone,
  validateWindow,
  type AuditEvent,
  type Schedule,
  type ScheduleWindow,
  type Store,
  type Weekday,
} from '@wemessage/core';
import type { AuditSink } from '../audit-sink.js';

export interface ScheduleRouteDeps {
  store: Store;
  sink: AuditSink;
}

// ---------------------------------------------------------------------------
// body schemas
// ---------------------------------------------------------------------------

/**
 * Week order, and the canonical order of a stored `days[]`. Monday-first
 * because that is the order §1.4.1 lists them in and the order the CLI
 * renders; it is a presentation choice, not a semantic one — `isArmed` reads
 * the array as a set.
 */
const WEEK_ORDER = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const satisfies readonly Weekday[];

const weekday = z.enum(WEEK_ORDER);

/**
 * `days` has no `.min(1)` and `start`/`end` are bare strings ON PURPOSE: an
 * empty `days[]` and a malformed `HH:MM` are `invalid-window`, not the
 * generic shape error, so core's validateWindow has to be the thing that
 * sees them.
 */
const windowShape = z.strictObject({
  days: z.array(weekday),
  start: z.string(),
  end: z.string(),
});

const scheduleFields = {
  name: z.string().min(1),
  // Not validated here for the same reason: `invalid-timezone` is its own
  // typed 400 and only core can say whether this runtime knows the zone.
  timezone: z.string().min(1),
  windows: z.array(windowShape).min(1),
  enabled: z.boolean(),
};

// §2.3 DDL default: enabled 1.
const createBody = z.strictObject({
  name: scheduleFields.name,
  timezone: scheduleFields.timezone,
  windows: scheduleFields.windows,
  enabled: scheduleFields.enabled.default(true),
});

const patchBody = z.strictObject(scheduleFields).partial();

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Rejection =
  | { error: 'invalid-timezone' }
  | { error: 'invalid-window'; detail: { index: number; field: string } };

/** First failure wins, in the §1.6 enumeration order: zone, then windows. */
function validateSchedule(
  timezone: string | undefined,
  windows: readonly ScheduleWindow[] | undefined,
): Rejection | null {
  if (timezone !== undefined) {
    const tz = validateTimezone(timezone);
    if (!tz.ok) return { error: 'invalid-timezone' };
  }
  if (windows !== undefined) {
    for (const [index, window] of windows.entries()) {
      const verdict = validateWindow(window);
      if (!verdict.ok) {
        return {
          error: 'invalid-window',
          detail: { index, field: verdict.field },
        };
      }
    }
  }
  return null;
}

/** Dedupe + week order. Called only on windows that already validated. */
function canonicalWindows(
  windows: readonly ScheduleWindow[],
): ScheduleWindow[] {
  return windows.map((window) => ({
    ...window,
    days: WEEK_ORDER.filter((day) => window.days.includes(day)),
  }));
}

export function registerScheduleRoutes(
  app: FastifyInstance,
  deps: ScheduleRouteDeps,
): void {
  const { store, sink } = deps;
  const audit = (event: AuditEvent): void => {
    sink.append(event, humanApiActor());
  };

  // §1.6: list, id ASC (store ORDER BY — a list read twice does not reorder)
  app.get('/v1/schedules', () => store.listSchedules());

  // §1.6: create — daemon mints the id (ulid), same as rules
  app.post('/v1/schedules', (req, reply) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-schedule',
        detail: { code: 'invalid-shape', issues: parsed.error.issues },
      });
    }
    const rejection = validateSchedule(
      parsed.data.timezone,
      parsed.data.windows,
    );
    if (rejection !== null) return reply.code(400).send(rejection);
    const schedule: Schedule = {
      ...parsed.data,
      windows: canonicalWindows(parsed.data.windows),
      id: ulid(),
    };
    store.insertSchedule(schedule);
    audit({ type: 'schedule.created', scheduleId: schedule.id, schedule });
    return reply.code(201).send({ schedule });
  });

  // §1.6: show
  app.get<{ Params: { id: string } }>('/v1/schedules/:id', (req, reply) => {
    const schedule = store.getSchedule(req.params.id);
    if (schedule === null) return reply.code(404).send({ error: 'not-found' });
    return schedule;
  });

  // §1.6: partial update. Schedules carry no timestamps (§2.3 has no
  // created_at/updated_at on this table), so there is nothing to bump.
  app.patch<{ Params: { id: string } }>('/v1/schedules/:id', (req, reply) => {
    const existing = store.getSchedule(req.params.id);
    if (existing === null) return reply.code(404).send({ error: 'not-found' });
    const parsed = patchBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid-schedule',
        detail: { code: 'invalid-shape', issues: parsed.error.issues },
      });
    }
    // exactOptionalPropertyTypes discipline: drop absent keys so the spread
    // cannot clobber a concrete field with undefined.
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([, v]) => v !== undefined),
    ) as Partial<Schedule>;
    const rejection = validateSchedule(patch.timezone, patch.windows);
    if (rejection !== null) return reply.code(400).send(rejection);
    const updated: Schedule = {
      ...existing,
      ...patch,
      ...(patch.windows ? { windows: canonicalWindows(patch.windows) } : {}),
      id: existing.id,
    };
    store.updateSchedule(updated);
    audit({
      type: 'schedule.updated',
      scheduleId: updated.id,
      schedule: updated,
    });
    return reply.send({ schedule: updated });
  });

  // §1.6: delete — 409 ahead of the FK (F-75)
  app.delete<{ Params: { id: string } }>('/v1/schedules/:id', (req, reply) => {
    const existing = store.getSchedule(req.params.id);
    if (existing === null) return reply.code(404).send({ error: 'not-found' });
    // Counts DISABLED rules too: a disabled rule still holds the foreign key,
    // so a count that skipped it would promise a delete SQLite then refuses.
    const rules = store.countRulesUsingSchedule(existing.id);
    if (rules > 0) {
      return reply
        .code(409)
        .send({ error: 'schedule-in-use', detail: { rules } });
    }
    store.deleteSchedule(existing.id);
    audit({ type: 'schedule.deleted', scheduleId: existing.id });
    return reply.code(204).send();
  });
}

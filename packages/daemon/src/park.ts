/**
 * v2 A0p: the park (ruling 2026-10-05, `docs/plans/v2-build-out.md`).
 *
 * Auto-send and schedules stay in the codebase, compiled and tested, but no
 * request may create or enable them while the park is on. The refusal is a
 * 409 with one fixed body and it is taken BEFORE any write or audit row, so a
 * refused request changes nothing. De-escalation (disable, detach, delete,
 * draft-only) stays allowed: an operator can always take autonomy away.
 *
 * The park itself is not stored. `Autonomy` is a value the composition root
 * passes in, absent means 'parked', and nothing on the wire can name it.
 */
import type { FastifyReply } from 'fastify';
import type { Autonomy, Rule } from '@wemessage/core';

export const PARKED_BODY = {
  error: 'parked',
  detail: 'auto-send and schedules are parked in this build; nothing changed',
} as const;

/** True unless the composition root explicitly lifted the park. */
export function isParked(autonomy: Autonomy | undefined): boolean {
  return (autonomy ?? 'parked') !== 'live';
}

export function refuseParked(reply: FastifyReply): FastifyReply {
  return reply.code(409).send(PARKED_BODY);
}

/** Would creating this rule hand anything to autonomy or a schedule? */
export function ruleCreateArms(
  rule: Pick<Rule, 'respondMode' | 'scheduleId'>,
): boolean {
  return rule.respondMode === 'auto' || rule.scheduleId !== null;
}

/**
 * Does this PATCH move a rule TOWARD autonomy? Turning auto on, attaching a
 * (different) schedule, or enabling a rule that is auto or scheduled. Every
 * other edit, including renaming a stored auto rule or turning it off, is
 * allowed: a parked rule is inert, and refusing its de-escalation would trap
 * an operator with a rule they cannot retire.
 */
export function rulePatchArms(
  existing: Pick<Rule, 'respondMode' | 'scheduleId' | 'enabled'>,
  updated: Pick<Rule, 'respondMode' | 'scheduleId' | 'enabled'>,
): boolean {
  if (updated.respondMode === 'auto' && existing.respondMode !== 'auto') {
    return true;
  }
  if (
    updated.scheduleId !== null &&
    updated.scheduleId !== existing.scheduleId
  ) {
    return true;
  }
  return updated.enabled && !existing.enabled && ruleCreateArms(updated);
}

/** A schedule PATCH is allowed only when it renames and/or disables. */
export function schedulePatchArms(patch: {
  name?: unknown;
  enabled?: boolean;
  [key: string]: unknown;
}): boolean {
  return Object.entries(patch).some(
    ([key, value]) =>
      value !== undefined &&
      key !== 'name' &&
      !(key === 'enabled' && value === false),
  );
}

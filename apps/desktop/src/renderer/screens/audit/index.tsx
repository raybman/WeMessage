/**
 * The `audit` screen — a stub at s8 Sc1, rendered in a later scenario.
 *
 * It exists now because the closed screen registry (F-113) has to be
 * enforceable before the screens exist: a guard written after the thing it
 * guards is a guard nobody proved. Returning `null` rather than markup is
 * the point — the directory set is real, the registry row is real, and
 * nothing renders until the scenario that owns this screen says it does.
 */
export default function AuditScreen(): null {
  return null;
}

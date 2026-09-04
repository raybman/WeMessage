/**
 * @wemessage/core/sending/auto-approve — the ONE place a machine may decide
 * to speak on the operator's behalf. Body lands in s6-execution Scenario 9.
 *
 * This file is deliberately empty at Scenario 1. It exists so the arch
 * guard's mint allowlist (`test/arch.spec.ts`, S4 row (c) + S6 row (a)) is
 * anchored to a real path before there is anything to anchor: an allowlist
 * entry pointing at a file that does not exist is an entry nobody can
 * review. Same move S5 made when it created the adapter vitest configs a
 * scenario ahead of their bodies.
 *
 * What will live here, and nothing else (§1.7 "Auto-approval"):
 * `maybeAutoApprove` rebuilds the gate context from a freshly minted
 * rule-borne draft, withholds unless the resolved mode is auto and nothing
 * clamped it, bumps the rate counters, writes an `Approval` under a system
 * actor, drives `pending + approve` through the transition table, sets the
 * persisted grace deadline, and appends the audit rows. It never calls
 * `dispatchApproved`, never reaches the send port, and never holds a port of
 * any kind — the scheduler's existing grace sweep and the one send path do
 * the rest. INV-2 is not weakened by autonomy: autonomy feeds the very same
 * stored approval the human path feeds, and the port importer allowlist does
 * not grow in S6 at all (S6 row (c), 15 files in, 15 files out).
 *
 * That last sentence is load-bearing and this file just proved it: naming
 * the port in a COMMENT here failed S6 row (c), because the importer scan
 * is a substring scan over file content and does not care whether the
 * mention is an import, a type or prose. Left as written, and recorded, so
 * the next reader knows the guard is stricter than it looks.
 *
 * Not in the package barrel until it has a body, matching the
 * `schedule/index.ts` stub's posture since S1.
 */
export {};

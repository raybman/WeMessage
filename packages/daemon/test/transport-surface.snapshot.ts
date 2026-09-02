/**
 * TRANSPORT-SURFACE RATCHET SNAPSHOT — deliberate-update file (INV-3).
 *
 * Provenance: S1 flag F-7 proposed ratcheting the daemon transport surface
 * (no SSE, no extra routes without a reviewed diff); it was NOT seeded in S1
 * (deviation recorded in s1). S2 flag F-17 reassigned the seed here:
 * s2-execution Part 2 Scenario 7 seeds this snapshot at the S1 three-route
 * surface FIRST, then updates it in the same scenario when the S2 rule
 * routes land — demonstrating the intended workflow: any change to the
 * daemon's externally reachable surface MUST arrive as a reviewed diff to
 * this file, in its own commit hunk, alongside the code that changes it.
 *
 * transport-surface.ratchet.spec.ts asserts the LIVE values (fastify route
 * table via `DaemonServer.routes`, `event:` literals in daemon src, importer
 * scan over packages/[asterisk]/src) equal these snapshots exactly. If that spec
 * fails, either revert the surface change or update this file deliberately,
 * citing the spec section that authorizes the new surface.
 */

/**
 * Live fastify route table (`METHOD url`, sorted). HEAD twins exist because
 * fastify v5 `exposeHeadRoutes` defaults to true for GET routes; they are
 * part of the reachable surface, so the ratchet pins them too (disabling or
 * enabling auto-HEAD is itself a surface change and must show up here).
 *
 * S1 surface per s2-execution §1.6: GET /v1/health, GET /v1/status,
 * WS GET /v1/events.
 */
export const ROUTE_TABLE: readonly string[] = [
  'GET /v1/events',
  'GET /v1/health',
  'GET /v1/status',
  'HEAD /v1/events',
  'HEAD /v1/health',
  'HEAD /v1/status',
];

/**
 * WS `event` values the daemon is ALLOWED to emit (s2 §1.6 pins the post-S2
 * vocabulary; `rule.matched` joins when Scenario 9 wires emission). Emitted
 * literals must be a subset of this list and exactly equal EMITTED_WS_EVENTS.
 */
export const WS_EVENT_VOCABULARY: readonly string[] = [
  'connection.state',
  'message.edited',
  'message.received',
  'message.unsent',
];

/**
 * WS `event` values the daemon src actually constructs today (scanned as
 * `event: '<value>'` literals under packages/daemon/src). S1 set; Scenario 9
 * adds 'rule.matched'.
 */
export const EMITTED_WS_EVENTS: readonly string[] = [
  'connection.state',
  'message.edited',
  'message.received',
  'message.unsent',
];

/**
 * Production files (packages/<pkg>/src) allowed to mention the SendBackend
 * or ChatDbReader ports. INV-2/F-2: sending capability must not leak into
 * new call sites without a reviewed diff here. Paths relative to repo root.
 */
export const PORT_IMPORTER_ALLOWLIST: readonly string[] = [
  'packages/core/src/drafts/recovery.ts',
  'packages/core/src/ports/index.ts',
  'packages/daemon/src/daemon.ts',
  'packages/ingest/src/chatdb/index.ts',
  'packages/ingest/src/index.ts',
  'packages/ingest/src/scan/index.ts',
  'packages/sendkit/src/index.ts',
];

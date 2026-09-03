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
 * S2 surface per s2-execution §1.6: the S1 three routes plus rule CRUD +
 * rules test (routes 1-6, Scenario 7) plus dry-run replay (route 7,
 * Scenario 10) plus audit reads (routes 8-9, Scenario 11).
 * (Deliberate update #1 of this file, F-17's demonstrated workflow: the
 * seed commit pinned the S1 three-route surface. Deliberate update #4,
 * Scenario 10: GET /v1/rules/:id/dry-run + auto-HEAD twin — §1.6 route
 * table row 7, read-only replay over the mirrored inbound window.
 * Deliberate update #5, Scenario 11: GET /v1/audit + GET /v1/audit/verify
 * + auto-HEAD twins — §1.6 route table rows 8-9, read-only audit reads.
 * Deliberate update #7, s3-execution Scenario 9: the ratchet's own
 * route-table sub-test wired only `rules` into `buildServer` since S2
 * Scenario 7 and was never widened when Scenario 8 landed `send`, so
 * `GET /v1/doctor` and `POST /v1/send` were real reachable surface but
 * never actually pinned here (gap noted + closed 2026-09-02, same commit
 * as `connection` wiring). Now wiring `rules`+`send`+`connection` together
 * (matching daemon.ts's real composition) adds all four: GET /v1/doctor +
 * auto-HEAD twin, POST /v1/send, POST /v1/connect, POST /v1/disconnect —
 * the latter two get no HEAD twin, POST routes never do (see POST /v1/rules
 * and POST /v1/rules/:id/test above, same precedent).
 */
export const ROUTE_TABLE: readonly string[] = [
  'DELETE /v1/rules/:id',
  'GET /v1/audit',
  'GET /v1/audit/verify',
  'GET /v1/batches/:id',
  'GET /v1/doctor',
  'GET /v1/drafts',
  'GET /v1/drafts/:id',
  'GET /v1/events',
  'GET /v1/health',
  'GET /v1/rules',
  'GET /v1/rules/:id',
  'GET /v1/rules/:id/dry-run',
  'GET /v1/status',
  'HEAD /v1/audit',
  'HEAD /v1/audit/verify',
  'HEAD /v1/batches/:id',
  'HEAD /v1/doctor',
  'HEAD /v1/drafts',
  'HEAD /v1/drafts/:id',
  'HEAD /v1/events',
  'HEAD /v1/health',
  'HEAD /v1/rules',
  'HEAD /v1/rules/:id',
  'HEAD /v1/rules/:id/dry-run',
  'HEAD /v1/status',
  'PATCH /v1/rules/:id',
  'POST /v1/connect',
  'POST /v1/disconnect',
  'POST /v1/drafts',
  'POST /v1/drafts/:id/approve',
  'POST /v1/drafts/:id/recall',
  // #11 deliberate (s4 Scenario 8): redraft an expired/rejected/recalled/
  // superseded draft into a NEW pending one (F-40). 'failed' is excluded —
  // it has the retry path, and redrafting it would launder past C-10.
  'POST /v1/drafts/:id/redraft',
  'POST /v1/drafts/:id/reject',
  'POST /v1/drafts/:id/retry',
  'POST /v1/drafts/bulk',
  'POST /v1/rules',
  'POST /v1/rules/:id/test',
  'POST /v1/send',
];

/**
 * WS `event` values the daemon is ALLOWED to emit (s2 §1.6 pins the post-S2
 * vocabulary; `rule.matched` joins when Scenario 9 wires emission).
 * Deliberate update #6, s3-execution Scenario 8: `POST /v1/send` and
 * `GET /v1/doctor` wire draft.created/approved/sent/failed and gate.denied
 * onto the same WS broadcast channel (§1.6 route table rows 10-12). Emitted
 * literals must be a subset of this list and exactly equal EMITTED_WS_EVENTS.
 * Deliberate update #7, s3-execution Scenario 9: `POST /v1/disconnect`
 * broadcasts `gateway.disconnected` (§1.3.7 step 3) after the
 * `connection.state` twin, once WS clients have seen the state flip.
 */
export const WS_EVENT_VOCABULARY: readonly string[] = [
  'connection.state',
  'draft.approved',
  'draft.created',
  'draft.failed',
  'draft.recalled',
  'draft.rejected',
  'draft.sent',
  'gate.denied',
  'gateway.disconnected',
  'message.edited',
  'message.received',
  'message.unsent',
  'rule.matched', // §1.6 post-S2 vocabulary; emission wired in Scenario 9
];

/**
 * WS `event` values the daemon src actually constructs today (scanned as
 * `event: '<value>'` literals under packages/daemon/src).
 * (Deliberate update #3: Scenario 9 wires the match pipeline, so the daemon
 * now constructs 'rule.matched' — already in the allowed vocabulary above.)
 * (Deliberate update #6, Scenario 8: routes/send.ts constructs
 * draft.created/draft.approved/draft.sent/draft.failed/gate.denied.)
 * (Deliberate update #7, Scenario 9: connection.ts's disconnectDaemon
 * constructs 'gateway.disconnected' — already added to the allowed
 * vocabulary above.)
 * (Deliberate update #8, s4 Scenario 5: routes/drafts.ts constructs
 * 'draft.rejected' — the one new event literal of this slice, added to both
 * lists in the same reviewed diff as the routes that emit it.)
 * (Deliberate update #9, s4 Scenario 6: the recall route adds
 * POST /v1/drafts/:id/recall and constructs 'draft.recalled'.)
 * (Deliberate update #10, s4 Scenario 7: bulk/retry/batch-report routes.
 * No new event literals — bulk reuses draft.approved/draft.recalled with a
 * batchId, which is already in the GatewayEvent shape.)
 */
export const EMITTED_WS_EVENTS: readonly string[] = [
  'connection.state',
  'draft.approved',
  'draft.created',
  'draft.failed',
  'draft.recalled',
  'draft.rejected',
  'draft.sent',
  'gate.denied',
  'gateway.disconnected',
  'message.edited',
  'message.received',
  'message.unsent',
  'rule.matched',
];

/**
 * Production files (packages/<pkg>/src) allowed to mention the SendBackend
 * or ChatDbReader ports. INV-2/F-2: sending capability must not leak into
 * new call sites without a reviewed diff here. Paths relative to repo root.
 *
 * Deliberate update #1 of this array, s3-execution Scenario 2: packages/sendkit/src/
 * applescript.ts is the real SendBackend implementation (S1's
 * NotImplementedSendBackend stub is retired) — it implements SendBackend
 * and consumes SendInput/SendOutcome directly, so it now legitimately
 * mentions the port too, alongside index.ts's re-export.
 *
 * Deliberate update #2 of this array, s3-execution Scenario 4:
 * packages/sendkit/src/verify.ts takes a `Pick<ChatDbReader,
 * 'findOutboundMessage'>` — post-send verification polls chat.db through
 * the same port, so it legitimately mentions ChatDbReader too.
 *
 * Deliberate update #3 of this array, s3-execution Scenario 6:
 * packages/core/src/sending/dispatcher.ts's dispatchApproved takes both
 * SendBackend and ChatDbReader directly (calls backend.send and duplicates
 * sendkit's verify-poll in-process, per INV-1: core cannot import sendkit),
 * so it legitimately mentions both ports too.
 *
 * Deliberate update #4 of this array, s3-execution Scenario 8: §1.6 wires
 * `POST /v1/send` and `GET /v1/doctor` into the daemon process. main.ts
 * constructs the real SendBackend/ChatDbReader at boot, server.ts's
 * DaemonOptions.send threads both ports through to registerSendRoutes, and
 * routes/send.ts itself calls dispatchApproved with them — all three now
 * legitimately mention the ports.
 */
export const PORT_IMPORTER_ALLOWLIST: readonly string[] = [
  'packages/core/src/drafts/recovery.ts',
  'packages/core/src/ports/index.ts',
  'packages/core/src/sending/dispatcher.ts',
  'packages/daemon/src/daemon.ts',
  'packages/daemon/src/main.ts',
  'packages/daemon/src/routes/send.ts',
  'packages/daemon/src/server.ts',
  'packages/ingest/src/chatdb/index.ts',
  'packages/ingest/src/index.ts',
  'packages/ingest/src/scan/index.ts',
  'packages/sendkit/src/applescript.ts',
  'packages/sendkit/src/index.ts',
  'packages/sendkit/src/verify.ts',
];

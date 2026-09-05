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
  // #11 deliberate (s4 Scenario 8): redraft an expired/rejected/recalled/
  // superseded draft into a NEW pending one (F-40). 'failed' is excluded —
  // it has the retry path, and redrafting it would launder past C-10.
  // #12 deliberate (s4 Scenario 9): the §1.3.5 kill switch. Synchronous by
  // design — it cancels every in-grace draft before the 200 is written, so
  // "the switch is on" and "nothing more goes out" are one moment.
  // #13 deliberate (s4 Scenario 10): §2.4.3 contact policies. DELETE
  // REMOVES the row rather than writing 'deny' — unknown and deny refuse
  // the same next message, but only one of them is a decision.
  // #14 deliberate (s5 Scenario 4): the adapter registry. Six routes plus
  // the two auto-HEAD twins of the GETs, 43 -> 51. The token a POST returns
  // is shown once and is not readable from any of these routes afterwards.
  // #15 deliberate (s5 Scenario 5): GET /v1/agent, the WS adapter wire, plus
  // its auto-HEAD twin — 51 -> 53. One route, two entries, because fastify's
  // exposeHeadRoutes mints the twin for every GET and this ratchet counts
  // reachable surface, not intent.
  //
  // This entry deserves more than a line. GET /v1/agent is the ONLY route
  // that opts out of the operator-bearer onRequest hook (F-56): adapters
  // authenticate with their own per-adapter `wm_` token inside the `hello`
  // frame, so the upgrade itself is open and the first frame is the gate.
  // The exemption is path-exact, GET-only, and conditional on the adapter
  // registry being wired at all; an un-helloed socket may do nothing but
  // send `hello`, and only until `helloDeadlineMs`. See server.ts's
  // AGENT_PATH comment and adapters/transport.ts.
  //
  // #19 deliberate (s6 Scenario 3): `/v1/schedules` CRUD, 53 -> 60. FIVE
  // routes — GET /v1/schedules, POST /v1/schedules, GET /v1/schedules/:id,
  // PATCH /v1/schedules/:id, DELETE /v1/schedules/:id — plus the TWO
  // auto-HEAD twins fastify's exposeHeadRoutes mints for the two GETs.
  // POST, PATCH and DELETE never get one (the POST /v1/rules precedent).
  //   5 routes + 2 HEAD twins = +7; 53 + 7 = 60.
  // No WS event and no port importer moves with them: schedule writes are
  // audited, not broadcast, and the routes reach the store through the same
  // `Store` port the rules routes already import.
  //
  // #20 deliberate (s6 Scenario 11): the two arming controls, 60 -> 62.
  //   POST /v1/toggles/pause        — the polite hold (F-68)
  //   POST /v1/toggles/global-mode  — F-77, the setting with no writer
  // BOTH are POSTs, and fastify's exposeHeadRoutes mints an auto-HEAD twin
  // for GET routes only (the POST /v1/rules precedent, and #19's own note
  // three lines up). So this is +2 entries for +2 routes, not the +4 a pair
  // of GETs would have cost.
  //   2 routes + 0 HEAD twins = +2; 60 + 2 = 62.
  // §1.6's own arithmetic for S6 as a whole confirms the total: 7 routes + 2
  // auto-HEAD twins = +9 across the slice, 53 -> 62, split #19 (+7) and this
  // one (+2).
  //
  // F-77 is the reason `global-mode` is a route at all. `send.globalMode`
  // has been READ by `readGateSettings` since S1 and written by nothing —
  // no route, no client method, no CLI verb — so §2.4.3's three-scope
  // ladder has never had a reachable `auto` at its top rung. One route, one
  // setting, one audit row; no schema, no column, no migration (F-61).
  //
  // ONE WS event moves with them: `arming.changed` joins BOTH lists below
  // in this same diff (16 -> 17 each), because the variant is new AND the
  // daemon constructs it immediately (arming.ts's `sweepArming`), so there
  // is no window in which the vocabulary is wider than what we emit.
  //
  // No port importer moves: arming reaches the store through the same
  // `Store` port everything else does, and nothing here touches a
  // SendBackend or a ChatDbReader.
  //
  // #21 deliberate (s7 Scenario 3): `GET /v1/events/sse`, the read-only SSE
  // event transport, 62 -> 64.
  //   1 route + 1 auto-HEAD twin = +2; 62 + 2 = 64.
  // The arithmetic is the #20 note run the other way. A new GET costs TWO
  // entries because fastify's exposeHeadRoutes mints the twin for GET routes
  // only; a new POST costs one. S7's own §1.6 projection is 62 -> 67 across
  // the whole slice, and this scenario's +2 is the share that lands here.
  // The twin is not decoration: it runs the same handler, so the route has
  // an explicit HEAD branch that answers with the SSE headers, a 200, an
  // empty body and NO subscriber. Without it the twin would hijack and
  // stream forever, and every client that probes a URL before opening it
  // would hang on the probe.
  //
  // NO WS event moves with it, and that is the point of the scenario. SSE
  // carries the SAME 17-name vocabulary over a different frame syntax; the
  // sink serializes once and hands both transports the identical string, so
  // there is nothing here for `WS_EVENT_VOCABULARY` (17) or
  // `EMITTED_WS_EVENTS` (17) to learn. A new name in either list would mean
  // parity had been broken by the very commit that claimed to prove it.
  //
  // NO port importer moves either, and that one is enforced rather than
  // observed: `routes/events-sse.ts` is deliberately absent from
  // PORT_IMPORTER_ALLOWLIST below, so the importer scan fails the moment
  // anything in the SSE path so much as names a SendBackend. An event
  // stream is read-only surface (INV-2); approve-before-send must not be
  // reachable from a subscription.
  //
  // #22 deliberate (s7 Scenario 4): the settings surface, 64 -> 67.
  //   GET   /v1/settings  — the closed list, typed, with defaults + versions
  //   HEAD  /v1/settings  — fastify's auto-twin for the GET above
  //   PATCH /v1/settings  — a write over that same closed list
  //   2 routes + 1 auto-HEAD twin = +3; 64 + 3 = 67.
  // The asymmetry is #21's note applied to a mixed pair: `exposeHeadRoutes`
  // mints twins for GET routes ONLY, so the PATCH brings no twin with it and
  // a GET+PATCH pair costs three entries rather than four. That closes S7's
  // §1.6 projection of 62 -> 67 exactly: #21's +2 and this +3.
  //
  // PATCH rather than PUT because the body is the keys an operator CHANGED,
  // not the settings table as they believe it to be. A PUT would make every
  // save a claim about all fifteen keys, and two screens open at once would
  // silently revert each other's edits.
  //
  // NO WS event moves, and the reasoning is worth pinning because it looks
  // at first like it should. The route DOES broadcast on every accepted
  // mutation — `toggle.changed {key, value, actor}`, the variant S4 minted
  // for the kill switch, whose `value` is unconstrained in the schema and
  // therefore already carries a number. The AUDIT side needed a new variant
  // (`setting.changed`, with `from` and `to`) because audit `toggle.changed`
  // carries `on: boolean` and cannot say what a cap moved from. Audit events
  // are not WS events: `GATEWAY_EVENT_NAMES` stays at 17, both lists below
  // stay at 17, and Sc 2's completeness report is confirmed rather than
  // contradicted. A seventeenth-plus-one name here would have meant every
  // existing subscriber had to learn a frame to keep seeing settings change.
  //
  // NO port importer moves, and as with #21 that is enforced rather than
  // observed: neither `src/settings/schema.ts` nor `src/routes/settings.ts`
  // appears in PORT_IMPORTER_ALLOWLIST below, so the importer scan fails the
  // moment either file so much as names a SendBackend. No settings key may
  // open a path to the send backend that goes around `dispatchApproved`
  // (INV-2); the only effect any key in the list has is a row some reader
  // consults later.
  'DELETE /v1/adapters/:id',
  'DELETE /v1/contacts/:handle',
  'DELETE /v1/rules/:id',
  'DELETE /v1/schedules/:id',
  'GET /v1/adapters',
  'GET /v1/adapters/:id',
  'GET /v1/agent',
  'GET /v1/audit',
  'GET /v1/audit/verify',
  'GET /v1/batches/:id',
  'GET /v1/contacts',
  'GET /v1/doctor',
  'GET /v1/drafts',
  'GET /v1/drafts/:id',
  'GET /v1/events',
  'GET /v1/events/sse',
  'GET /v1/health',
  'GET /v1/rules',
  'GET /v1/rules/:id',
  'GET /v1/rules/:id/dry-run',
  'GET /v1/schedules',
  'GET /v1/schedules/:id',
  'GET /v1/settings',
  'GET /v1/status',
  'HEAD /v1/adapters',
  'HEAD /v1/adapters/:id',
  'HEAD /v1/agent',
  'HEAD /v1/audit',
  'HEAD /v1/audit/verify',
  'HEAD /v1/batches/:id',
  'HEAD /v1/contacts',
  'HEAD /v1/doctor',
  'HEAD /v1/drafts',
  'HEAD /v1/drafts/:id',
  'HEAD /v1/events',
  'HEAD /v1/events/sse',
  'HEAD /v1/health',
  'HEAD /v1/rules',
  'HEAD /v1/rules/:id',
  'HEAD /v1/rules/:id/dry-run',
  'HEAD /v1/schedules',
  'HEAD /v1/schedules/:id',
  'HEAD /v1/settings',
  'HEAD /v1/status',
  'PATCH /v1/adapters/:id',
  'PATCH /v1/rules/:id',
  'PATCH /v1/schedules/:id',
  'PATCH /v1/settings',
  'POST /v1/adapters',
  'POST /v1/adapters/:id/token',
  'POST /v1/connect',
  'POST /v1/disconnect',
  'POST /v1/drafts',
  'POST /v1/drafts/:id/approve',
  'POST /v1/drafts/:id/recall',
  'POST /v1/drafts/:id/redraft',
  'POST /v1/drafts/:id/reject',
  'POST /v1/drafts/:id/retry',
  'POST /v1/drafts/bulk',
  'POST /v1/rules',
  'POST /v1/rules/:id/test',
  'POST /v1/schedules',
  'POST /v1/send',
  'POST /v1/toggles/global-mode',
  'POST /v1/toggles/kill-switch',
  'POST /v1/toggles/pause',
  'PUT /v1/contacts/:handle',
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
  // #15 deliberate (s5 Scenario 5): the adapter transport broadcasts
  // `adapter.health` on connect, on unhealthy and on disconnect. The variant
  // has been in `GatewayEventPayload` since S1; this slice is the first time
  // the daemon actually constructs it, so it joins BOTH lists in one diff.
  'adapter.health',
  // #20 deliberate (s6 Scenario 11, F-67): `arming.changed` is the ONE
  // protocol addition of S6, and the `connection.state` twin one line down —
  // same shape of fact (a posture somebody's screen is showing), same
  // on-change-only discipline, so a subscriber renders an arming badge
  // without polling `/v1/status`. It joins BOTH lists in this one diff:
  // `arming.ts`'s `sweepArming` constructs it the moment the variant exists.
  'arming.changed',
  'connection.state',
  'draft.approved',
  'draft.created',
  // #17 deliberate (s5 Scenario 7, F-44): `draft.delta` is the ONE protocol
  // addition of this slice. A streaming preview has to reach
  // `wemessage watch` and the client bus had no frame for it, so exactly one
  // `GatewayEventPayload` variant was added — and S4's F-39 pushes
  // (draft.expired/superseded/redrafted) were re-deferred to S8 rather than
  // shipped alongside it, because the adapter feedback channel handles agent
  // re-convergence and those three would have no reader until a GUI exists.
  // It joins BOTH lists in this one diff: the variant is new AND the daemon
  // constructs it immediately (adapters/submit.ts), so there is no window in
  // which the vocabulary is wider than what we emit.
  'draft.delta',
  // #23 deliberate (s8 Scenario 2, F-107): the four `draft.*` lifecycle
  // names, 17 -> 21. This is comment #17's own promise being kept — S4's F-39
  // deferred draft.expired/superseded/redrafted, S5 Sc 7 re-deferred them
  // "to S8", and S6's F-72 minted draft.requeued as an audit row with no wire
  // twin. The reader that makes them owed now exists: a GUI watches the queue
  // instead of polling it, and a queue whose cards can vanish (expiry),
  // be replaced (supersede), be rewritten (redraft) or come back (requeue)
  // with no frame for any of it is a screen that lies between refreshes.
  //
  // UNLIKE #15, #17 and #20, these four join this list ALONE. Sc 2 is a
  // protocol-only scenario: the daemon's emit sites move in Sc 3, so for one
  // scenario the vocabulary is wider than what we emit. That window has been
  // pre-authorised — the ratchet spec's own comment says a slice that wants a
  // name declared before it is emitted must "relax this half of the row
  // deliberately, in this file, with an argument" — and the price of taking
  // it is that the gap is ENUMERATED, in `UNEMITTED_WS_EVENTS` below, and
  // asserted as a partition rather than softened to a subset check. Sc 3
  // empties that list in the same diff that grows EMITTED to 21.
  'draft.expired',
  'draft.failed',
  'draft.recalled',
  'draft.redrafted',
  'draft.rejected',
  'draft.requeued',
  'draft.sent',
  'draft.superseded',
  'gate.denied',
  'gateway.disconnected',
  'message.edited',
  'message.received',
  'message.unsent',
  'rule.matched', // §1.6 post-S2 vocabulary; emission wired in Scenario 9
  // #12 deliberate (s4 Scenario 9): kill-switch flips ride the existing
  // toggle.changed frame; §1.6 already reserves it, no protocol addition.
  'toggle.changed',
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
  // #15 deliberate (s5 Scenario 5): constructed in adapters/transport.ts.
  'adapter.health',
  // #20 deliberate (s6 Scenario 11, F-67): constructed in arming.ts's
  // `sweepArming`, on change only — the scheduler calls it every tick and a
  // window that stays open all afternoon produces exactly one frame.
  'arming.changed',
  'connection.state',
  'draft.approved',
  'draft.created',
  // #17 deliberate (s5 Scenario 7, F-44): constructed in
  // adapters/submit.ts's `onDelta`, relayed and persisted nowhere.
  'draft.delta',
  // #24 deliberate (s8 Scenario 3): the four names #23 declared and left
  // owed, now constructed. This entry is not a licence — it is the
  // BOOKKEEPING for one, and the licence closes with it. Each name is
  // written down beside the single site that builds it, because the row two
  // files over scans `event: '<name>'` literals under packages/daemon/src
  // and a second site for any of these would be a second story about the
  // same fact:
  //
  //   draft.expired     scheduler.ts        `sweepExpired`, after the append
  //   draft.superseded  adapters/submit.ts  `supersedeLive`, before the mint
  //   draft.redrafted   routes/drafts.ts    the redraft route, before created
  //   draft.requeued    scheduler.ts        `sweepGrace`, from core's outcome
  //
  // The last of those is the one worth pausing on. `draft.requeued` is a
  // fact CORE discovers: `dispatchApproved` re-gates at the send moment,
  // finds a hold that binds only autonomy, writes both its audit rows and
  // returns `{outcome:'requeued'}`. Core holds no sink and imports no
  // protocol (INV-1), so the frame is built on this side of the boundary
  // from the outcome core handed back — the same shape as
  // `adapters/feedback.ts`'s `observeDispatch`, not a new channel. The scan
  // therefore finds the literal in the DAEMON, which is where it belongs.
  'draft.expired',
  'draft.failed',
  'draft.recalled',
  'draft.redrafted',
  'draft.rejected',
  'draft.requeued',
  'draft.sent',
  'draft.superseded',
  'gate.denied',
  'gateway.disconnected',
  'message.edited',
  'message.received',
  'message.unsent',
  'rule.matched',
  // #12 deliberate (s4 Scenario 9): kill-switch flips broadcast on the
  // pre-existing toggle.changed frame — no protocol addition (F-3).
  'toggle.changed',
];

/**
 * Names that are DECLARED in the vocabulary above and emitted by nothing.
 * Deliberate update #23, s8 Scenario 2 (F-107).
 *
 * This list exists so that "declared" cannot quietly come to mean
 * "forgotten". The subset row (`EMITTED ⊆ VOCABULARY`) can only catch a name
 * the daemon emits without declaring; it is structurally blind to the
 * opposite mistake, and the opposite mistake is exactly what a protocol-only
 * scenario creates. So the debt is written down by hand, here, where a
 * surface change has to be argued rather than observed, and
 * `transport-surface.ratchet.spec.ts` asserts a PARTITION over the two lists:
 * disjoint, and together equal to `GATEWAY_EVENT_NAMES` name for name.
 *
 * It is meant to be empty. Deliberate update #24, s8 Scenario 3: it IS
 * empty. Sc 3 wired all four emit sites — the scheduler's expiry sweep,
 * `adapters/submit.ts`'s supersede, the redraft route, and the scheduler's
 * daemon-side translation of core's requeue outcome — so the
 * `event: '<name>'` source scan grew EMITTED to 21 and disjointness forced
 * this array back to `[]` in the same diff, exactly as #23 promised. The
 * escape hatch opened for one scenario and shut behind it.
 *
 * The array stays, at zero length, rather than being deleted with its
 * partition row. Deleting it would take the mechanism out with the debt, and
 * the mechanism is the valuable half: it is the only assertion in this repo
 * that can catch a name DECLARED and then quietly never emitted, which is a
 * mistake `EMITTED ⊆ VOCABULARY` is structurally blind to. A future slice
 * that needs the same one-scenario window has the shape waiting for it, and
 * pays the same price — writing the debt down by hand, here, under a number.
 *
 * Anything that appears here and stays across a slice boundary is a bug
 * report.
 */
export const UNEMITTED_WS_EVENTS: readonly string[] = [];

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
  // s5 Scenario 6 (F-46), deliberate ratchet update #16: the inbound
  // dispatcher holds a ChatDbReader for `readChatTurns` — an agent that
  // cannot see our prior replies re-answers the same question forever.
  'packages/daemon/src/adapters/dispatch.ts',
  // s5 Scenario 9 (F-50), deliberate ratchet update #18: `proactive.propose`
  // may name a `{handle}`, and turning that into a conversation is a
  // `resolveChat` — availability-only, never a mint. The submit handler holds
  // the narrowest possible slice of the port (`Pick<ChatDbReader,
  // 'resolveChat'>`) and nothing in this file can send.
  'packages/daemon/src/adapters/submit.ts',
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

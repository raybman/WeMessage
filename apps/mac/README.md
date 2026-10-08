# apps/mac

The native macOS app. One executable, `WeMessage`, with two faces:
`WeMessage --daemon` runs the daemon host (no window, AppKit is never
touched on that path), and a bare launch opens the window. The Swift
package builds with the swift.org toolchain through `tools/swift/swift.sh`;
see `tools/swift/README.md`.

```
Target              What it is
------------------  ---------------------------------------------------------------
WeMessageKit        The client: gateway calls, the event stream, the reducer
WeMessageDaemonHost The --daemon face: starts and supervises the Node daemon
WeMessageApp        The window: rail, sidebar, content pane (SwiftUI)
WeMessage           The executable; --daemon is the first branch in main.swift
WeMessageUITests    XCUITest bundle (UITests/), built by XcodeGen in CI only
```

Unit tests use swift-testing and run anywhere with `pnpm swift:test`. XCTest
appears only under `UITests/`.

## The CI UI lane

The `ui` job in `.github/workflows/ci-swift.yml` is the only place the
window is launched. It runs on a GitHub macOS runner on every push, as two
shards (`ui (a)` and `ui (b)`), each running a disjoint explicit list of
XCUITest classes through `-only-testing`. A new UI test class goes into
exactly one shard's `classes:` list in `ci-swift.yml`; `test/arch.spec.ts`
is red until it does. Each shard:

1. Writes its paths under `RUNNER_TEMP` (the app's data dir, derived data,
   the result bundle, the snapshot export dir).
2. Turns on Full Keyboard Access (`AppleKeyboardUIMode` 2), so Tab reaches
   buttons and the lens picker.
3. Fetches the pinned XcodeGen (`tools/swift/xcodegen-fetch.sh`) and
   generates `apps/mac/WeMessage.xcodeproj` from `apps/mac/project.yml`
   (gitignored, never committed).
4. Starts the fake daemon (`tools/swift/fake-daemon.mjs --control`), which
   serves the S0 contract goldens (or a scenario from `fixtures/scenarios`)
   over loopback and writes a bearer to the data dir.
5. Runs `xcodebuild test` with test timeouts on. The app is ad hoc signed
   from `project.yml`; the test runner is therefore sandboxed and no test
   writes a file.
6. On a green test step, exports the `.keepAlways` attachments with the
   selected Xcode's `xcresulttool` and uploads the PNGs, with the export
   manifest as `manifest-<shard>.json`, as
   `wemessage-ui-snapshots-<sha>-<shard>`. The result bundle uploads on
   every outcome as `wemessage-ui-xcresult-<sha>-<shard>`.

The UI tests:

```
Class               What it proves
------------------  ---------------------------------------------------------------
LaunchTests         a bare launch shows the shell; the window is the requested
                    size clamped to the visible frame the app saw
ConnectionTests     the window connects to the fake daemon with the bearer, and
                    says plainly when the daemon is down
AccessibilityTests  the accessibility audit passes; Tab reaches the lens, the
                    kill chip and the rail; cmd-T selects Triage
SnapshotTests       light and dark snapshots, each with the frost on and with
                    Reduce Transparency forced, swept for green outside the
                    traffic lights, with the tint present, and carrying the frost
                    evidence (a real blur, or plain layer0); plus the sweep's and
                    the evidence's own probes
Board01Tests        board 01 from the rich, empty, degraded and quiet scenarios
                    in one launch per appearance (scenario switch plus the
                    test-only cmd-opt-R reload): rail marks, the dated counter,
                    no digit or total while stale, the kill chip in every
                    state, a row opening its head and the inspector toggling,
                    and no POST /v1/send in the journal
FakeDaemonControlTests
                    a scenario served through the control routes reaches the
                    window (its connection line), the journal sees the status
                    read, the stream and the resync, and nothing was sent
```

Every UI test class resets the fake daemon in `setUp` (S0 goldens, empty
journal) through `Support/FakeDaemon.swift`.

The app reads `WEMESSAGE_UI_TEST=1` and `WEMESSAGE_UI_APPEARANCE` only to pin
the window geometry, force the appearance and turn animations off.
Under the same flag cmd-opt-R reads status, threads and drafts again, so
one launch can show several scenarios. `WEMESSAGE_UI_REDUCE_TRANSPARENCY` (and `_INCREASE_CONTRAST`,
`_REDUCE_MOTION`), `1` or `0`, force the app's copy of that display option
under the same flag. Under it the app also opens a test-only backdrop
window behind the shell (a grey-blue gradient with a 2 pt stripe band) that
the frost evidence measures; it never takes focus or appears in the
accessibility tree. The job writes the system's Reduce Transparency off
first, because the image ships with it on. The
geometry it computed is published on the shell's accessibility value as
`frame=<w>x<h> visible=<w>x<h>`; tests compare against that, never against a
monitor size or a literal.

### Accessibility identifiers

The contract between `Sources/WeMessageApp/ShellView.swift` (its `ShellID`
enum; the board views under `Boards/` name them through it) and the UI tests
(AppHygieneTests H-A5 and arch R-A15 keep this list, the code and the tests
equal):

- `wemessage.shell`: the window's root container
- `wemessage.rail`: the channel rail
- `wemessage.rail.all`: rail tile, all channels (cmd-1)
- `wemessage.rail.imessage`: rail tile, iMessage (cmd-2)
- `wemessage.rail.whatsapp`: rail tile, WhatsApp (cmd-3)
- `wemessage.rail.linkedin`: rail tile, LinkedIn (cmd-4)
- `wemessage.rail.email`: rail tile, Email (cmd-5)

  Each rail tile's accessibility value is its mark: the waiting count, `clear`
  (the baseline), `stale` (the "!"), or empty when the channel is not
  connected.

- `wemessage.sidebar`: the sidebar
- `wemessage.title`: the title bar's scope title
- `wemessage.title.counter`: the dated counter; its value is the sentence
  ("N left as of hh:mm:ss", "Clear hh:mm:ss", or cannot say with the reason)
- `wemessage.lens`: the lens group in the title bar
- `wemessage.lens.recent`: the Recent segment
- `wemessage.lens.needsyou`: the Needs You segment; its value is the count, or
  empty when there is none to say
- `wemessage.lens.triage`: the Triage button (cmd-T)
- `wemessage.kill.chip`: the kill chip (shift-cmd-K); value `on`, `off` or
  `unknown`
- `wemessage.sidebar.empty`: the sidebar's empty state
- `wemessage.connection`: the connection line at the foot of the sidebar
- `wemessage.content.empty`: the content pane's empty state
- `wemessage.content`: the content pane with a thread selected
- `wemessage.inspector.toggle`: the thread head's inspector button
- `wemessage.inspector`: the inspector column
- `wemessage.sidebar.row.<chatGuid>`: one list row
- `wemessage.thread`: board 02's thread under the head; its label ends in the
  load state (`loading`, `loaded`, `unknown chat`, `failed`)
- `wemessage.thread.bubble.<guid>`: one transcript bubble; its label leads
  with `Received`, `Sent` or `Unsent` (a group's value never reaches AX)
- `wemessage.thread.day.<yyyy-MM-dd>`: a day separator
- `wemessage.thread.draft`: the pending agent draft; its label leads with
  `DRAFT` and names the adapter
- `wemessage.thread.held.<draftId>`: a draft held for later review
- `wemessage.thread.draft.approve`: Approve (10 s undo, then the daemon)
- `wemessage.thread.draft.edit`: Edit, which copies the draft into the field
- `wemessage.thread.draft.hold`: Hold, a local park (D-UI-36)
- `wemessage.thread.inv5`: the INV-5 strip in a group
- `wemessage.thread.banner`: the channel banner above the composer
- `wemessage.thread.capability.note`: the absent controls and why
- `wemessage.composer`: the composer
- `wemessage.composer.field`: the field; Return is a newline, never a send
- `wemessage.composer.send`: Send (or cmd-Return), then the 4 s undo
- `wemessage.composer.outbox`: the newest send; its label leads with the
  phase (`SENDING in Ns`, the parked line, `Not sent`, `Sent`); cmd-Z undoes
  it while it counts
- `wemessage.composer.hold`: reserved for Hold until; never placed while
  D-UI-17 is absent-with-reason
- `wemessage.atlas`: board 08's specimen sheet, reachable only through
  `WEMESSAGE_UI_BOARD=08` under the UI-test flag (no menu item, no key);
  its label carries the pinned geometry, as the shell's does
- `wemessage.atlas.<slug>`: one page of the sheet, 08.A..08.J (`anatomy`,
  `text`, `reactions`, `media`, `voice`, `payloads`, `delivery`, `draft`,
  `native`, `coverage`); the page dots in the title band (D-UI-42) are
  buttons labelled `Specimen page 08.A` and so on
- `wemessage.bubble.reaction.<guid>.<n>`: the n-th reaction chip someone
  else left on a message (read only; nothing writes a reaction)
- `wemessage.bubble.delivery.<guid>`: the delivery state inside an outbound
  bubble; its label is the state and, for Not delivered, the cause
- `wemessage.bubble.draft.<id>`: an agent draft specimen
- `wemessage.bubble.sms.<guid>`: a message sent over SMS (D-UI-39: inset
  rail and printed tag, never dashed, never green)
- `wemessage.bubble.effect.<guid>`: a message sent with an effect
- `wemessage.bubble.unsupported.<guid>`: the honest fallback for a type the
  app cannot render
- `wemessage.triage.bar`: Triage's list header (06.C), the counter and the
  burn-down bar with no percentage; its label is the counter's sentence
- `wemessage.bulk.strip`: Needs You's bulk strip (09.D), how many drafts
  were opened this session and how many were skipped
- `wemessage.bulk.open`: Approve N (shift-A), which opens the confirm card
- `wemessage.audit.open`: opens the audit view (09.G, D-UI-49)
- `wemessage.bulk.sheet`: the bulk confirm card; the one place bare Return
  approves, and only the drafts it lists as included
- `wemessage.bulk.confirm`: Approve N (Return on the card): one batch, one
  undo window
- `wemessage.bulk.cancel`: Cancel (Escape)
- `wemessage.bulk.included.<draftId>` and `wemessage.bulk.excluded.<draftId>`:
  one draft on the card; an excluded one's label carries its reason
- `wemessage.undo.ring`: the batch's one undo (cmd-Z or Z); its label carries
  the seconds left
- `wemessage.verbs`: Triage's verb row under the reader (06.C)
- `wemessage.verb.reply`: Reply (R) when no draft is pending
- `wemessage.verb.done`, `wemessage.verb.snooze`, `wemessage.verb.mute`:
  Done (E), Snooze (H), Mute (M), local to this window (D-UI-51)
- `wemessage.draft.<draftId>.approve`, `.edit`, `.hold`: a draft's own verbs
  outside Recent (A, R, Backspace); absent, never greyed, under the kill
  switch, and Approve absent until the body was drawn
- `wemessage.draft.<draftId>.meta`: the draft's 09.B meta line (`DRAFT ·
proposed by`, `APPROVED by you`, `HELD by kill switch`, and so on)
- `wemessage.draft.<draftId>.why`: the rationale block (09.C, D-UI-53)
- `wemessage.thread.release`: Release to awaiting on a held draft
- `wemessage.kill.banner`: the kill banner (09.F), present only while the
  switch is on
- `wemessage.kill.disengage`: Disengage, a click only (D-UI-50)
- `wemessage.zero`: the zero screen (06.E); its value is `clear`,
  `cannot say` or `not connected`
- `wemessage.zero.receipt`: the receipt line
- `wemessage.zero.verify`: Verify now, which reads every source again
- `wemessage.connect.card`: the not-connected zero's channel card (D-UI-48)
- `wemessage.audit`: the audit view
- `wemessage.audit.row.<seq>`: one audit row
- `wemessage.audit.close`: closes the audit view (Escape)
- `wemessage.trust.banner`: the trust banner (10.A), present only while a
  connected channel is stale; its label names the channel and since when
- `wemessage.trust.action`: Show ages, which pins the per-channel age table
- `wemessage.freshness`: the per-channel age table, off the rail on hover
  and pinned by the trust banner (D-UI-68), and in the states sheet
- `wemessage.freshness.row.<scope>`: one channel's row; a channel that is
  not connected says so and shows no number
- `wemessage.freshness.footer`: the table's foot, the clock it was computed
  at or CANNOT SAY
- `wemessage.revoked.banner`: lost access to chat.db while running (10.C)
- `wemessage.revoked.fix`: Fix, which opens the Full Disk Access screen
- `wemessage.fda`: the Full Disk Access screen (10.C), four headings
- `wemessage.fda.open`: Open System Settings; asks the seam only, and its
  value counts the asks (`asked 1`)
- `wemessage.fda.skip`: Skip iMessage for now (D-UI-64)
- `wemessage.states`: board 10's sheet, only with `WEMESSAGE_UI_BOARD=10.B`
  under the UI-test flag (H-S4-6)
- `wemessage.states.tab.<page>`, `wemessage.states.page.<page>`: the sheet's
  tabs and pages, `empties` and `settings`
- `wemessage.empty.<case>`: one of the six empties (10.B), and
  `wemessage.empty.<case>.action` its one action
- `wemessage.pacing`: the pacing table (10.D), iMessage's rows (D-UI-66)
- `wemessage.collision`: the collision notice (10.E)
- `wemessage.onboarding`: board 12's onboarding window, on a shipped launch
  until its handover is spent, and under the UI-test flag only with
  `WEMESSAGE_UI_BOARD=12` (D-UI-75, H-S4-7)
- `wemessage.onboarding.step`: the step counter (`Step 1 of 6`, fixed)
- `wemessage.onboarding.page.<slug>`: one step's page, slugs `1`, `2a`,
  `2b`, `2c`, `2c-copy`, `3`, `4`, `5`, `6` and `done`
- `wemessage.onboarding.card.<channel>`, `wemessage.onboarding.connect.<channel>`,
  `wemessage.onboarding.skip.<channel>`: step 1's cards and their Connect
  and Skip; a skip's value is `skipped` once pressed
- `wemessage.onboarding.next`: the page's one forward control (Continue,
  Make the copy, Skip <channel>, Finish setup, Open inbox)
- `wemessage.onboarding.again`: 2b's Open System Settings again; its value
  is `asked n, probes m, polling on|off`
- `wemessage.onboarding.sizing`: 2c's count, or not served (D-UI-72)
- `wemessage.onboarding.progress`: CopyProgress, dated
- `wemessage.onboarding.notbuilt`: steps 3 to 5 say the channel is not in
  this version (D-UI-71)
- `wemessage.onboarding.agent.off`, `wemessage.onboarding.agent.draft`:
  AgentStep's two choices; No drafting is selected by default
- `wemessage.onboarding.agent.channel.<channel>`: a per-channel drafting
  box, unchecked, and inert while No drafting is selected
- `wemessage.onboarding.kill`: KillIntro, with an inert specimen (D-UI-76)
- `wemessage.onboarding.done`: setup complete, a line per channel
- `wemessage.coach`: the first thread's coach row (12.I), until any key
- `wemessage.voice.dock`: the voice dock's idle line at the foot of the
  handover rail (D-UI-70)
- `wemessage.search`: board 11's search pane, on shift-cmd-F; it takes the
  list and thread panes, so no composer is in the window while it is up
- `wemessage.search.field`: the query field; Up and Down move the result
  cursor, cmd-Return opens the hit (bare Return does nothing)
- `wemessage.search.token.<n>`: one token chip; its value is `parsed` or
  `unparsed`, and an unparsed chip's label names the token and why
- `wemessage.search.group.<channel>`, `wemessage.search.result.<guid>`: a
  channel group and one hit, the cursor's value `selected`
- `wemessage.search.summary`, `wemessage.search.coverage`: the count line
  and the coverage strip (`Searched ...`, `Not searched: ...`, D-UI-79)
- `wemessage.search.prompt`: the empty query's prompt; a query with no hits
  shows board 10's `wemessage.empty.<case>` instead, case `search`
- `wemessage.search.facets`, `wemessage.search.facet.<n>`: the facet row
- `wemessage.find`, `wemessage.find.field`, `wemessage.find.counter`: the
  in-thread find bar on cmd-F, its field and its `n of m` counter
- `wemessage.scrubber`, `wemessage.scrubber.line`,
  `wemessage.scrubber.year.<year>`: the year scrubber on option-cmd-G, its
  `viewing <year> ...` line and one year, valued `viewing` or `empty`;
  option-cmd-Up and option-cmd-Down step a year
- `wemessage.switcher`, `wemessage.switcher.field`,
  `wemessage.switcher.row.<id>`: the cmd-K switcher, which opens empty every
  time, its field and one row
- `wemessage.settings`: board 13's settings window, under the UI-test flag
  only with `WEMESSAGE_UI_BOARD=13`; no shipped door opens it in this
  version (D-UI-89, H-S4-9)
- `wemessage.settings.pane.<pane>`, `wemessage.settings.page.<pane>`: a
  sidebar row and its page, panes `accounts`, `drafting`, `notifications`,
  `appearance`, `keyboard`, `storage` and `confirm`; the shown row's value
  is `shown`
- `wemessage.settings.parked.autosend`, `wemessage.settings.parked.schedules`:
  the two parked rows, valued `parked`, with no control in them
- `wemessage.settings.appearance.theme`: the theme row, display only,
  valued `system` (D-UI-94)
- `wemessage.settings.appearance.<id>`, among them
  `wemessage.settings.appearance.reducetransparency`: the mirrored
  accessibility rows, valued `on` or `off`, never a control
- `wemessage.settings.keyboard.row.<id>`: one keymap row, valued
  `editable` or `fixed`; the table is read-only (D-UI-90)
- `wemessage.settings.storage`, `wemessage.settings.storage.delete`: the
  storage pane and its Delete the local copy, which only opens the confirm
  card (D-UI-92)
- `wemessage.settings.confirm.sheet`, `wemessage.settings.confirm.cancel`,
  `wemessage.settings.confirm.go`: the confirm card, valued by what it
  asks (`deleteCopy` or `releaseKill`); go's value is `enabled` or
  `not in this version`
- `wemessage.settings.kill.state`, `wemessage.settings.kill.release`: the
  kill switch's state (`on`, `off` or `unknown`) and Release, shown only
  while it is on; release confirms, engaging never does (13.H, D-UI-93)
- `wemessage.compose`: board 14's compose window, under the UI-test flag
  with `WEMESSAGE_UI_BOARD=14` only (D-UI-95)
- `wemessage.compose.tab.<page>`, `wemessage.compose.page.<page>`: the
  band's tabs (valued `shown`) and their pages, `new` and `states`
- `wemessage.compose.to`: the one field before a person (14.A);
  `wemessage.compose.result.<id>`: a resolution row, ordered by last
  exchange; `wemessage.compose.recipient`: the chosen person's chip,
  valued by the person's id
- `wemessage.compose.channel.<channel>`: a channel's report, valued
  `default`, `no handle` or `not connected`; never a picker (D-UI-97)
- `wemessage.compose.banner`: the channel and handle Send is on, from the
  first keystroke (kit rule 7)
- `wemessage.compose.strip`, `wemessage.compose.slot.<id>`: the capability
  strip's twelve slots, valued `can` or `struck` (14.C)
- `wemessage.compose.proposal`: the proposal region, valued `empty`,
  `proposal` or `moved`; `wemessage.compose.proposal.ask` (opt-cmd-D),
  `wemessage.compose.proposal.take` (Approve: the one way its text reaches
  the input) and `wemessage.compose.proposal.hold` (14.E, D-UI-98)
- `wemessage.compose.field`, `wemessage.compose.send`,
  `wemessage.compose.undo`: the input, Send (cmd-Return) and Undo (cmd-Z,
  during the 4 s window only). Send creates a pending draft after the
  window; it never sends (D-UI-96, D-UI-99)
- `wemessage.compose.bubble`: the live message after Send, valued
  `undo`, `drafting`, `drafted` or `failed`;
  `wemessage.compose.state.<state>`: a 14.F specimen, valued by its border
- `wemessage.media`: board 15's media window, under the UI-test flag with
  `WEMESSAGE_UI_BOARD=15` only (D-UI-102). It builds no client. Fixture
  key doors stand in for a drag, a pick and a paste (D-UI-103): opt-cmd-1
  drags over the thread, 2 over the rail, 6 over the list row, 3 releases,
  4 attaches, 5 pastes, 0 leaves and 9 clears the tray
- `wemessage.media.tab.<page>`, `wemessage.media.page.<page>`: `thread`,
  `walls` and `refusal`; `wemessage.media.header`, the thread's name, channel and handle
- `wemessage.media.drop`: the content pane, valued `resting`, `dwelling`,
  `targeted` or `refused`; `wemessage.media.drop.card` while targeted;
  `wemessage.media.rail` (valued `refused` when hatched) and
  `wemessage.media.drop.reason`, the printed refusal (15.A)
- `wemessage.media.thread` (valued `y=<offset>`),
  `wemessage.media.message.<id>` (valued `outlined` after the viewer
  closes, for D-UI-109's seconds) and `wemessage.media.item.<id>`, the
  attachment that opens the viewer
- `wemessage.media.tray` (valued by its header),
  `wemessage.media.tray.item.<id>` (valued by its chip, a video always with
  its duration), `wemessage.media.tray.remove.<id>`,
  `wemessage.media.conversion`, `wemessage.media.location`,
  `wemessage.media.counter`, `wemessage.media.grid` and
  `wemessage.media.compression` with `.row.<target>` (15.C, 15.D)
- `wemessage.media.field`, `wemessage.media.send` (cmd-Return, valued
  `enabled` or `inert`; the only call to the sink, which this version
  parks, D-UI-104), `wemessage.media.note`, and `wemessage.media.record`:
  the record slot, a printed reason and no control on iMessage (15.E)
- `wemessage.media.viewer` (valued `<n> / <count>`) with
  `wemessage.media.viewer.position`, `wemessage.media.viewer.meta`,
  `wemessage.media.viewer.line`, `wemessage.media.viewer.origin`,
  `wemessage.media.viewer.close`, `wemessage.media.viewer.previous`,
  `wemessage.media.viewer.next`, `wemessage.media.viewer.kinds`,
  `wemessage.media.viewer.save` (cmd-S), `wemessage.media.viewer.reveal`
  (opt-cmd-R) and `wemessage.media.viewer.copy` (cmd-C). The bare arrows
  and Esc are key presses on the focused viewer, never app-wide shortcuts;
  Esc restores the pinned offset (15.F)
- `wemessage.media.wall.<channel>` (valued by the dated wall),
  `wemessage.media.refusal` with `.part.1` to `.part.4`,
  `wemessage.media.refusal.take` (moves the words, sends nothing), and
  `wemessage.media.matrix.<n>` (15.B, 15.H, D-UI-111)
- In Needs You and Triage the single-letter keys (A, R, Backspace, E, H, M,
  X, Z, J, K, shift-A) are heard only by the list's key view, never while
  the composer has the keyboard; bare Return does nothing outside the
  confirm card.
- No typing indicator is ever drawn, so no identifier exists for one, and
  no react affordance is placed on an iMessage bubble.

### Reading a run

Download the artifacts with `gh run download <run id>`. The snapshots
artifact holds plain PNGs named by UUID; the export step's log prints
`manifest.json`, which maps each file to its attachment name (`board-01-shell-light.png`,
`board-01-shell-dark.png`, `board-01-shell-opaque-light.png`,
`board-01-shell-opaque-dark.png`; since S4c `board-01-<state>-<appearance>.png`
for the states `rich`, `empty`, `degraded` and `quiet`; since S4e
`board-08-<page>-<appearance>.png` for the ten specimen pages; and the accessibility
audit's `audit-*` captures). The `frost evidence` step prints one `FROST|` line per snapshot
with the measured stripe, gradient, pull and transmission.

The result bundle opens in Xcode, or with
`xcrun xcresulttool get test-results tests --path <bundle>`. Without Xcode,
its `Data/data.*` files are zstd-compressed blobs: decompress each and pick
PNGs and JSON by their leading bytes.

### Why nothing launches locally

The window, XcodeGen, `xcodebuild` and the snapshots run in CI only. A local
launch would touch the developer's own Messages data, accessibility
permissions and window server state, and a local result would not be the
runner's result (display size, scale and Xcode build all differ). Locally,
`pnpm swift:test` and the release build are the gates.

## Known seams

- One executable, two faces: the manual double-click check now lives in
  `RELEASING.md`, "Double-click while the daemon runs".
- The `ui` job's build is ad hoc signed and iconless on purpose. It is never
  what ships; see `RELEASING.md`.
- The design values in `Sources/WeMessageApp/ProvisionalUI.swift` are
  provisional, pending the D-UI-1..53 decisions.

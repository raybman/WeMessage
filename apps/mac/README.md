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
window is launched. It runs on a GitHub macOS runner on every push:

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
   selected Xcode's `xcresulttool` and uploads the PNGs as
   `wemessage-ui-snapshots-<sha>`. The result bundle uploads on every
   outcome as `wemessage-ui-xcresult-<sha>`.

The UI tests:

```
Class               What it proves
------------------  ---------------------------------------------------------------
LaunchTests         a bare launch shows the shell; the window is the requested
                    size clamped to the visible frame the app saw
ConnectionTests     the window connects to the fake daemon with the bearer, and
                    says plainly when the daemon is down
AccessibilityTests  the accessibility audit passes; Tab walks the rail to the lens
SnapshotTests       light and dark snapshots, each with the frost on and with
                    Reduce Transparency forced, swept for green outside the
                    traffic lights, with the tint present, and carrying the frost
                    evidence (a real blur, or plain layer0); plus the sweep's and
                    the evidence's own probes
FakeDaemonControlTests
                    a scenario served through the control routes reaches the
                    window (its connection line), the journal sees the status
                    read, the stream and the resync, and nothing was sent
```

Every UI test class resets the fake daemon in `setUp` (S0 goldens, empty
journal) through `Support/FakeDaemon.swift`.

The app reads `WEMESSAGE_UI_TEST=1` and `WEMESSAGE_UI_APPEARANCE` only to pin
the window geometry, force the appearance and turn animations off.
`WEMESSAGE_UI_REDUCE_TRANSPARENCY` (and `_INCREASE_CONTRAST`,
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

The contract between `Sources/WeMessageApp/ShellView.swift` and the UI tests
(AppHygieneTests H-A5 and arch R-A15 keep this list, the code and the tests
equal):

- `wemessage.shell`: the window's root container
- `wemessage.rail`: the channel rail
- `wemessage.rail.all`: rail tile, all channels (cmd-1)
- `wemessage.rail.imessage`: rail tile, iMessage (cmd-2)
- `wemessage.rail.whatsapp`: rail tile, WhatsApp (cmd-3)
- `wemessage.rail.linkedin`: rail tile, LinkedIn (cmd-4)
- `wemessage.rail.email`: rail tile, Email (cmd-5)
- `wemessage.sidebar`: the sidebar
- `wemessage.lens`: the lens picker in the sidebar
- `wemessage.sidebar.empty`: the sidebar's empty state
- `wemessage.connection`: the connection line at the foot of the sidebar
- `wemessage.content.empty`: the content pane's empty state

### Reading a run

Download the artifacts with `gh run download <run id>`. The snapshots
artifact holds plain PNGs named by UUID; the export step's log prints
`manifest.json`, which maps each file to its attachment name (`board-01-shell-light.png`,
`board-01-shell-dark.png`, `board-01-shell-opaque-light.png`,
`board-01-shell-opaque-dark.png`, and the accessibility audit's `audit-*`
captures). The `frost evidence` step prints one `FROST|` line per snapshot
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
  provisional, pending the D-UI-1..21 decisions.

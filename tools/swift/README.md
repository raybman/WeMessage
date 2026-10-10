# tools/swift

Scripts for the Swift side of the tree (`apps/mac`). None installs anything
outside the paths it is given, and none touches PATH, Homebrew or the
selected toolchain.

```
File                 What it does
-------------------  ---------------------------------------------------------------
swift.sh             Picks the swift.org Swift 6 toolchain and execs it
bundle.sh            Assembles WeMessage.app from the release build
sign.sh              Signs an assembled bundle, inside-out, with one identity
dmg.sh               Puts a signed app in a plain disk image and signs the image
verify-bundle.sh     Checks an assembled bundle, and with --expect-leaf its signature
node-fetch.sh        Fetches the pinned Node runtime (node.lock.json)
xcodegen-fetch.sh    Fetches the pinned XcodeGen release (xcodegen.lock.json); CI only
fake-daemon.mjs      Serves the S0 contract goldens over loopback; CI UI lane only
```

## swift.sh

Uses `$WEMESSAGE_SWIFT` if set (a path to a swift binary), otherwise the
newest swift.org 6.x release toolchain. It never selects a toolchain through
the `TOOLCHAINS` variable. `pnpm swift:test` goes through it.

## sign.sh (v2 S5a)

```
bash tools/swift/sign.sh --app <WeMessage.app> --identity <sha1>
```

`--identity` is the 40-hex SHA-1 of the signing certificate, never its
name. The identity must already be a valid code-signing identity in a
keychain on the search list; this script only names it and reads no
secret. It signs, in this order, each with `--options runtime` and
`--timestamp=none`: the better-sqlite3 addon, the bundled node (with
`apps/mac/Resources/node.entitlements`), the host executable and then the
app (both with `WeMessage.entitlements`). Exit 2 is usage or not an
assembled app, 3 the identity is missing or untrusted, 4 codesign failed,
5 a Mach-O under `Contents/` outside those three files.

`verify-bundle.sh --app <path> --expect-leaf <sha1>|any` adds the identity
half: `codesign --verify --deep --strict`, one certificate leaf across the
four signed objects (and equal to `<sha1>` unless `any`), the hardened
runtime flag on each, the entitlements each carries, and spctl's verdict
recorded for the log but never fatal. `test/swift/sign.sh.spec.ts` runs
both against `fixtures/swift/mini-app` with stub tools; the real signing
run is the release workflow's `pack-swift` job.

## dmg.sh (v2 S5b)

```
bash tools/swift/dmg.sh --app <WeMessage.app> --out <file.dmg> --identity <sha1>
```

Stages the app next to an `Applications` symlink, builds a UDZO image with
`hdiutil create -volname WeMessage`, checks it with `hdiutil verify`, then
signs the image with the same 40-hex identity as the app
(`--timestamp=none`) and verifies it: `codesign --verify`, and the image's
designated requirement must name that leaf. The window is plain on purpose
(D-UI-181): no background art and no icon layout, so hdiutil is the only
tool it needs. Exit 2 is usage, 3 the identity is missing, 4 hdiutil or
codesign failed, 5 the signed image does not verify or names another leaf.
`test/swift/dmg.sh.spec.ts` runs it against the stub `hdiutil`, `codesign`
and `security` in `fixtures/swift/mini-app/stubs`.

## xcodegen-fetch.sh

```
sh tools/swift/xcodegen-fetch.sh --out <dir>
```

Downloads the release named in `xcodegen.lock.json`, verifies its sha256 and
unzips it under `--out`. Exit 0 leaves `<dir>/bin/xcodegen` executable; exit
2 is a digest mismatch; exit 1 is any other failure. Run once per job.

## fake-daemon.mjs

```
node tools/swift/fake-daemon.mjs --dir <path> [--port <n>] [--pid-file <path>] [--control]
```

- `--dir`: the data dir (falls back to `WEMESSAGE_DIR`). A fresh bearer is
  written to `<dir>/daemon.token` with mode 0600 and never printed.
- `--port`: the loopback port (falls back to `WEMESSAGE_PORT`, then 47100).
  It binds the literal `127.0.0.1`.
- `--pid-file`: where to write its pid, so a later step can stop it.
- `--control`: adds the three loopback control routes below. Without it
  they do not exist (404).

On start it prints exactly one line,
`{"ready":true,"port":<n>,"dir":"<path>"}`. It answers the routes the window
calls (`/v1/health` without a bearer, `/v1/status`, `/v1/drafts`,
`/v1/threads` and the SSE stream with one) from `fixtures/contract`, answers
409 for send, schedules and toggles (parked), and 401 or 404 with the
contract's error goldens otherwise. It exits on TERM or INT. Synthetic data
only: everything it serves is already in the tree.

### Scenarios (v2 S4b)

A scenario is a directory under `fixtures/scenarios/<name>`:

```
scenario.json        {"summary": "...", "extends": "<parent>"}  (extends optional)
responses/*.json     {route, status, body}, overlaying the S0 golden on that route
sse/NN-<event>.txt   one frame each, replayed after the greeting, ids from 2
```

A route is answered by the scenario, then its `extends` chain, then the S0
goldens; transcripts (`GET /v1/threads/:guid/messages`) are keyed by the
`chatGuid` in each body. The stream sends the greeting (saying the
scenario's own `connectionState`), then the first scenario in the chain
that has frames, one per 250 ms, skipping ids at or below `Last-Event-ID`.
`POST /v1/drafts/:id/{approve,reject,recall}` walks the draft state machine
over the scenario's queue (409 illegal-transition otherwise), and
`GET /v1/drafts` leaves terminal drafts out unless `?state=` names one.
`default` (the S0 goldens alone) is reserved.

```
Scenario      What it serves
------------  -----------------------------------------------------------
rich          8 threads, a transcript each, 5 drafts, 6 people, 3 adapters
pending       rich, plus 2 drafts arriving on the stream
kill          rich, with the kill switch on (status and settings)
degraded      rich, read-only, one adapter unhealthy
empty-earned  rich, with the queue emptied
quiet         nothing yet: no threads, drafts, people or adapters
fda-denied    disconnected; threads 503 source-unavailable; doctor says FDA
search        rich plus 2 threads and a transcript spanning 2024 to 2026
```

### Control routes (`--control` only)

No bearer (the sandboxed UI test runner cannot read the token file); each
answers only a `127.0.0.1` peer and none is journaled.

```
POST /v1/_scenario {"name"}  switch scenario; the journal is kept;
                             400 unknown-scenario (with the known list)
POST /v1/_reset              back to "default", draft moves and journal cleared
GET  /v1/_journal            {scenario, requests: [{method, path, query, status}]}
```

The UI tests reach them through `UITests/WeMessageUITests/Support/FakeDaemon.swift`
(`reset()`, `scenario(_:)`, `journal()`, `assertNoSend()`), and every UI
test class resets in `setUp`.

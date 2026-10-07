# tools/swift

Scripts for the Swift side of the tree (`apps/mac`). None installs anything
outside the paths it is given, and none touches PATH, Homebrew or the
selected toolchain.

```
File                 What it does
-------------------  ---------------------------------------------------------------
swift.sh             Picks the swift.org Swift 6 toolchain and execs it
bundle.sh            Assembles WeMessage.app from the release build
verify-bundle.sh     Checks an assembled bundle
node-fetch.sh        Fetches the pinned Node runtime (node.lock.json)
xcodegen-fetch.sh    Fetches the pinned XcodeGen release (xcodegen.lock.json); CI only
fake-daemon.mjs      Serves the S0 contract goldens over loopback; CI UI lane only
```

## swift.sh

Uses `$WEMESSAGE_SWIFT` if set (a path to a swift binary), otherwise the
newest swift.org 6.x release toolchain. It never selects a toolchain through
the `TOOLCHAINS` variable. `pnpm swift:test` goes through it.

## xcodegen-fetch.sh

```
sh tools/swift/xcodegen-fetch.sh --out <dir>
```

Downloads the release named in `xcodegen.lock.json`, verifies its sha256 and
unzips it under `--out`. Exit 0 leaves `<dir>/bin/xcodegen` executable; exit
2 is a digest mismatch; exit 1 is any other failure. Run once per job.

## fake-daemon.mjs

```
node tools/swift/fake-daemon.mjs --dir <path> [--port <n>] [--pid-file <path>]
```

- `--dir`: the data dir (falls back to `WEMESSAGE_DIR`). A fresh bearer is
  written to `<dir>/daemon.token` with mode 0600 and never printed.
- `--port`: the loopback port (falls back to `WEMESSAGE_PORT`, then 47100).
  It binds the literal `127.0.0.1`.
- `--pid-file`: where to write its pid, so a later step can stop it.

On start it prints exactly one line,
`{"ready":true,"port":<n>,"dir":"<path>"}`. It answers the routes the window
calls (`/v1/health` without a bearer, `/v1/status`, `/v1/drafts`,
`/v1/threads` and the SSE stream with one) from `fixtures/contract`, answers
409 for send, schedules and toggles (parked), and 401 or 404 with the
contract's error goldens otherwise. It exits on TERM or INT. Synthetic data
only: everything it serves is already in the tree.

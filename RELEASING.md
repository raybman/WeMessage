# Releasing WeMessage

This is the procedure for cutting a WeMessage release. It is public on purpose:
the builds are unsigned and reproducible from this repository, so the steps that
produce them should be readable by anyone who wants to check that what is
published matches what is here.

Read `SECURITY.md` before publishing anything.

## Lanes

There are two packaging lanes, and only one of them exists today.

```
  lane          signing               produces                        status
  ----------    -------------------   -----------------------------   ---------
  pack-adhoc    ad-hoc, no identity   WeMessage-<v>-arm64-UNSIGNED     shipping
                                      .dmg, .zip, SHA256SUMS
  pack-release  Developer ID +        WeMessage-<v>-arm64.dmg, .zip    deferred
                notarization
```

The ad-hoc lane is the shipping lane. The release lane is wired but deferred
until there is a reason to pay for a Developer ID, and nothing in the project
depends on it existing. If you are cutting a release, you are cutting an ad-hoc
one.

Two consequences of the ad-hoc lane, both of which are documented for users in
`README.md` and must be re-stated in every release's notes:

1. Gatekeeper refuses the first launch, and the user has to approve it by hand
   in System Settings. `spctl` rejecting the artefact is the expected result,
   not a failure. The smoke suite asserts the rejection.
2. Every update re-locks Full Disk Access, because macOS identifies an unsigned
   app by a hash of the binary and that hash changes on every build. The user
   has to remove and re-add the app in Privacy and Security. `wemessage doctor`
   reports this case by name.

The `ui` job in `ci-swift.yml` also builds the app, to launch it under
XCUITest. That build is ad hoc signed from `apps/mac/project.yml` and has no
icon, on purpose, and it is never what ships: it is not uploaded as an app,
only its test results and snapshots are. The shipping bundle comes from the
packaging lanes above.

## The gate

Every release candidate must pass all five commands, from a clean tree, before
anything is tagged. There is no partial credit and no flaky-test allowance: a
test that fails intermittently in this project is a bug, and `retry` is `0`
everywhere on purpose.

```sh
pnpm build
pnpm test
pnpm dep:check
pnpm licenses:check
pnpm lint
```

CI runs the same five across three workflows: `ci-linux`, `ci-macos`, and
`ci-python`. All three must report success on the commit being tagged. A run
that passed on an earlier commit proves nothing about the one you are shipping.

## Cutting a candidate

1. Set the version. Every workspace manifest and the root manifest move
   together, and the tag tool refuses a set that disagrees with itself.
2. Update `CHANGELOG.md`. The unsigned-build caveats above belong in the notes
   for every release, not just the first one.
3. Push, and wait for all three CI workflows to report success.
4. Build the artefacts: `pnpm pack:adhoc`.
5. Run the release smoke checklist below.
6. Tag. Publishing an unsigned build as a general-availability version, rather
   than a prerelease, requires setting `UNSIGNED_RELEASE_ACKNOWLEDGED=1`. That
   is a deliberate speed bump, not a formality: it exists so that shipping an
   unsigned `1.0.0` is a decision somebody made rather than a default somebody
   inherited.
7. Attach `SHA256SUMS` to the release. Users are told to check it, so it has to
   be there.

## Release smoke checklist

Legs 1 through 3 are automated and run on macOS in the `pack-adhoc` job. Leg 4
is manual and cannot be automated, because it tests the parts of macOS that
exist specifically to resist automation: Gatekeeper, TCC, and the permission
prompts a genuinely new user sees.

Copy this checklist into the pull request that closes the release and fill it
in. An unchecked row is a row that did not run.

### Leg 1: the artefact

- [ ] Every Mach-O in the unzipped bundle links only against system paths. No
      `/opt/homebrew`, no `/usr/local`, no home directory.
- [ ] `scripts/verify-bundle.sh <app> adhoc` exits 0.
- [ ] The checks run against the contents of the published zip, not against the
      build directory the zip was made from.

### Leg 2: install, wizard, send

- [ ] The app unzips to an Applications directory and carries a quarantine
      attribute, as a downloaded copy would.
- [ ] `spctl` rejects it, reporting no usable signature. This is the expected
      result on the ad-hoc lane and is the one step a user cannot skip.
- [ ] The bundled daemon installs a background service, and the service answers
      `/v1/doctor` within the deadline reporting the launchd supervisor, the
      Electron runtime it was built for, and the expected version.
- [ ] The onboarding wizard, launched from the packaged app rather than from a
      development build, reaches the send test.
- [ ] The send test produces exactly one send, it went through the approval
      dispatch path, and the audit row was written before the broadcast. There
      is no path from the interface to a send that does not pass the gate.
- [ ] A draft is approved through the keyboard path, and the audit row count and
      the database checksum are recorded for the next leg.

### Leg 3: upgrade, downgrade, uninstall

- [ ] The upgrade replaces the bundle in place and reinstalls the service. It is
      not an uninstall followed by an install, which would be a fresh start
      rather than an upgrade.
- [ ] After the upgrade, `/v1/doctor` reports the new version.
- [ ] After the upgrade, the audit row count is unchanged, the approved draft is
      still present in its post-approval state, and every file in the data
      directory other than the lock file and the write-ahead log has the same
      checksum it had at the end of leg 2. This is the row that catches an
      upgrade that silently starts over.
- [ ] After the upgrade, the lock file holds a new process id, proving the
      service was actually cycled rather than left running against a replaced
      bundle.
- [ ] Starting an older build against a newer data directory is refused by the
      store's migration guard, with a non-zero exit, and the guard is reachable
      from the shipped binary rather than only from a test harness.
- [ ] Uninstalling removes the service definition, and querying it afterwards
      fails.
- [ ] No launchd job outside this project's own test label prefix was created,
      modified, or removed at any point. This is checked before and after.

### Leg 4: the manual leg

Run this in a throwaway local macOS account, not in the account that built the
release. A fresh account is the closest available substitute for a fresh
machine, and it is the only way to see the permission prompts a real first-time
user sees. Delete the account afterwards.

- [ ] The downloaded disk image's checksum matches the published `SHA256SUMS`.
- [ ] Gatekeeper blocks the first launch, and approving it in System Settings,
      Privacy and Security lets it open.
- [ ] The Automation prompt names WeMessage, not the terminal and not the
      runtime it is built on. If it names something else, the bundle identity is
      wrong and the release is not shippable.
- [ ] Full Disk Access is granted, and the wizard verifies it by testing the
      background service's own reads rather than by trusting the switch.
- [ ] Record which verification branch the wizard showed. Recent macOS versions
      require the service to be restarted after the grant, and which message
      appears is the result this leg exists to capture.
- [ ] A send test to your own number arrives, and the audit row is visible in
      the app before the confirmation appears.
- [ ] Quitting the app leaves the background service answering, because launchd
      owns it and not the interface.
- [ ] Terminating the service process by its own process id brings it back
      within ten seconds.
- [ ] A `wemessage://` link opens the app to the queue.
- [ ] Launching a second copy of the daemon refuses with a non-zero exit and
      names the process id already holding the lock.
- [ ] An in-place upgrade preserves the audit rows and the approved draft, and
      the service's process id changes exactly once.
- [ ] Disconnecting with the purge flag unloads the background service, removes
      its definition, and removes the data directory.
- [ ] After everything, no launchd job belonging to this project remains, and no
      unrelated launchd job changed state.

## Recording results

Fill in the checklist above in the closing pull request. The automated legs are
also asserted by the release smoke suite, so a passing suite and an unchecked
box mean somebody forgot to write it down, not that the row did not run. The
manual leg has no such backstop: an unchecked box there means nobody looked.

## First install on a Mac (the Swift build)

This is the manual run that proves what the Swift build (v2 S2) cannot prove
in CI: that Gatekeeper's Open Anyway accepts a self-signed zip, that Full
Disk Access granted to `WeMessage.app` reaches the Node daemon the app hosts
under launchd, and that the Automation prompt names WeMessage.
Nothing in this section is automated. The maintainer runs it by hand, once
per signing identity, and sends back the post-run checklist at the end.

There is no App Store build, no paid Apple Developer account and no
notarization. The Swift build is signed with the project's own self-signed
identity and ships through GitHub Releases and the project's own Homebrew
tap (see `homebrew/README.md`). A cask install keeps the quarantine
attribute, so the Gatekeeper steps below are the same for a tap install.

### Before you start

**Blocked on S2e.** `tools/swift/sign.sh` does not exist yet, so
`pnpm pack:swift` (`tools/release/bin/pack-swift.mjs`) refuses with exit 2
before it builds anything, and no signed zip exists to install. S2e is held
for the maintainer's go on signing custody: the identity lives in a password
manager and two repository secrets, and the release lane produces a draft
release. Every step tagged `[blocked on S2e]` needs that draft release; the
steps after them need the app those steps install, so in practice the whole
run starts after S2e lands.

What else has to be true first:

- Run it in your own macOS account, signed in to Messages, because step 11
  sends a real message. macOS 26 is the target.
- If the Electron build of WeMessage is installed, remove its background
  service with its own `wemessaged service uninstall` and remove its Full
  Disk Access entry first. Both builds use the identifier
  `sh.wemessage.gateway`, and this project never installs them side by side.
- Read "Residual risks to check before granting Full Disk Access" below and
  do its checks before step 8. A grant cannot be taken back from a build
  that has already run with it.

### The steps

`<version>` is the release version. The commands assume the app sits at
`~/Applications/WeMessage.app`, which needs no administrator password.

1. [blocked on S2e] Download `WeMessage-<version>-arm64.zip`, `SHA256SUMS` and `DESIGNATED_REQUIREMENT.txt` from the draft release at https://github.com/raybman/WeMessage/releases and check the zip.

   ```sh
   shasum -a 256 -c SHA256SUMS
   ```

2. [blocked on S2e] Unzip into `~/Applications` with ditto, and confirm the quarantine attribute survived, as it would for any download.

   ```sh
   ditto -x -k WeMessage-<version>-arm64.zip ~/Applications/
   xattr -p com.apple.quarantine ~/Applications/WeMessage.app
   ```

   Expect: one line of quarantine data. No output means the attribute was
   lost and the Gatekeeper step proves nothing.

3. [blocked on S2e] Check the installed app carries the designated requirement the release lane recorded.

   ```sh
   codesign -d -r- ~/Applications/WeMessage.app
   ```

   Expect: the `designated =>` line equals the line in
   `DESIGNATED_REQUIREMENT.txt`. A mismatch means this is not the build the
   lane signed: stop.

4. Open `WeMessage.app` once from Finder, then approve it with Open Anyway.

   macOS refuses the first launch ("Apple could not verify"). Open System
   Settings, Privacy & Security, scroll to Security, press Open Anyway,
   authenticate, and confirm Open. The window opens. Quit it with cmd-Q.
   Record the exact wording of both dialogs.

5. Install the background service from the bundle's own CLI, so the plist gets the host shape.

   ```sh
   ~/Applications/WeMessage.app/Contents/Resources/bin/wemessaged service install
   ```

   Expect: `installed sh.wemessage.gateway`, `loaded  true`.

6. Check the service is running with the host shape.

   ```sh
   ~/Applications/WeMessage.app/Contents/Resources/bin/wemessaged service status --json
   ```

   Expect: `"running":true`, `"shape":"host"`, and a pid. Keep the output.

7. Run the doctor once BEFORE granting Full Disk Access; this is the experiment's control.

   ```sh
   ~/Applications/WeMessage.app/Contents/Resources/bin/wemessage doctor
   ```

   Expect: runtime kind node, host swift; the `fda` check fails with the
   `FDA_EPERM` remediation. If `fda` already passes, something other than
   this build holds the grant: stop and report, the experiment cannot
   discriminate.

8. Grant Full Disk Access to the app, not to anything inside it.

   System Settings, Privacy & Security, Full Disk Access, press "+", choose
   `~/Applications/WeMessage.app`, switch it on. The list entry should read
   WeMessage. Do not add `Contents/Resources/daemon/node`; that is rung L2
   of the fallback ladder, below, and only if step 10 fails.

9. Restart the service, so the daemon starts under the grant: always restart the service after any change to the grant.

   ```sh
   ~/Applications/WeMessage.app/Contents/Resources/bin/wemessaged service restart
   ```

10. Run the doctor again and record the `fda` result; this is the FDA experiment's observation (see "The FDA experiment").

    ```sh
    ~/Applications/WeMessage.app/Contents/Resources/bin/wemessage doctor --json
    ```

11. Send one approved message to yourself: create a draft, read it, then approve it by id.

    ```sh
    ~/Applications/WeMessage.app/Contents/Resources/bin/wemessage drafts create --chat 'iMessage;-;+15555550100' --body 'WeMessage first send test'
    ~/Applications/WeMessage.app/Contents/Resources/bin/wemessage drafts approve <draft id>
    ```

    Replace `+15555550100` with your own number or Apple ID (for example
    `iMessage;-;you@example.com`). Nothing leaves the Mac until the approve
    command runs; approval is always a human act, and the one-call send verb
    is not part of this run. macOS asks whether WeMessage may control
    Messages (the Automation prompt): press Allow and record the exact title, which should
    name WeMessage and not node or the terminal. The message arrives on your
    own devices. Run `wemessage doctor` once more: `automation` is ok.

12. Do the double-click check in "Double-click while the daemon runs".

13. Fill in the post-run checklist and send it back.

### The FDA experiment

What it tests: S2's launchd host shape bets that Full Disk Access granted to
`WeMessage.app` reaches the Node daemon the Swift host starts with
posix_spawn, because tccd attributes the child to the app that launchd
started. The shipped doctor copy says the opposite: `FDA_EPERM` in
`packages/daemon/src/doctor.ts` tells the operator that "on macOS 26, FDA
does not propagate to background items". That copy is not changed until this
result is in.

The observation is the `fda` check in step 10, read against the step 7
control, with the grant from step 8 visible in System Settings.

```
Outcome  What step 10 shows                       What it means                                 What happens to FDA_EPERM
-------  ---------------------------------------  --------------------------------------------  -----------------------------------------
Pass     fda ok (step 7 failed, step 10 passes)   The grant on the app reaches the hosted       Rewrite: drop "does not propagate to
                                                  daemon. S2's premise holds.                   background items"; keep remove, re-add,
                                                                                                restart the service. Later slice.
Fail/L1  fda still fails; passes after L1         The grant reaches the daemon, but a stale     Rewrite as for Pass, and lead with the
                                                  TCC record shadowed it.                       reset; note L1 in the release notes.
Fail/L2  fda passes only after L2                 The grant does not cross posix_spawn; node    Keep the claim, reword it to name the
                                                  needs its own entry. Residual (i) becomes     node entry; node's designated requirement
                                                  live (see below).                             joins this file's identity section.
Fail     fda fails after L1 and L2                S2's premise fails. L3 and L4 are plan        Unchanged. Stop and report.
                                                  changes, not runbook steps.
```

The ladder, run in order and only on a Fail:

- **L1.** Switch the WeMessage entry off, reset the record, switch it back on, then restart the service, and re-run step 10.

  ```sh
  tccutil reset SystemPolicyAllFiles sh.wemessage.gateway
  ~/Applications/WeMessage.app/Contents/Resources/bin/wemessaged service restart
  ```

- **L2.** Add `~/Applications/WeMessage.app/Contents/Resources/daemon/node` to Full Disk Access (press cmd-shift-G in the file picker to reach it), restart the service, and re-run step 10.

Record which rung worked: none, L1, L2, or neither.

### Double-click while the daemon runs

One executable, two faces: `WeMessage --daemon` is the background host and a
bare launch opens the window. LaunchServices can treat a running process with
the same bundle identifier as the app "already running", and activate it
instead of starting a new one. CI cannot test this (S3 advisor review,
P2-11), so it is a manual check on every release candidate.

With the service from step 9 running (step 6 shows a pid), double-click
`WeMessage.app` in Finder.

- Pass: a window opens, and `wemessaged service status --json` still shows the same pid as before the double-click.
- Fail: no window appears, the Dock icon bounces and leaves, or the daemon's pid changes. Record which.

### Residual risks to check before granting Full Disk Access

Every risk here starts from someone who can already run code as you. Full
Disk Access turns that into reading your Messages history as WeMessage, so
these are checked before step 8, not after.

The three same-user escalation paths the S2 advisor review found, plus PATH,
were closed in commit `1f32743` (S2c.1, host hardening):

- `NODE_OPTIONS` (and `NODE_PATH`, `DYLD_*`) set in a hand-written LaunchAgent would have flowed through the host into the bundled node. The host now forwards an allowlist of ten keys and drops everything else.
- `WEMESSAGE_HOST_NODE` and `WEMESSAGE_HOST_MAIN` would have let such a LaunchAgent choose what the host spawns. Release builds no longer compile the overrides in.
- A bare `require("bufferutil")` or `require("utf-8-validate")` in the bundled daemon would have loaded a module from wherever node resolved it. The bundler now removes both.
- PATH is pinned to the system default in the child, so a LaunchAgent cannot put its own copy of a system tool first.

What to check on the installed build:

```sh
strings -a ~/Applications/WeMessage.app/Contents/MacOS/WeMessage | awk '/WEMESSAGE_HOST_(NODE|MAIN)/'
awk '/require\("(bufferutil|utf-8-validate)"\)/' ~/Applications/WeMessage.app/Contents/Resources/daemon/main.mjs
```

Both print nothing. Also confirm the release's source commit contains
`1f32743` (`git merge-base --is-ancestor 1f32743 <release commit>` exits 0).

Two structural residues are out of S2's reach and stay open; they are named
here as known risk and as targets for a later slice:

- (i) A LaunchAgent that runs the bundled node directly (`Contents/Resources/daemon/node` with a script of its own), skipping the host. It is expected NOT to receive Full Disk Access: node is signed with its own identifier, `sh.wemessage.gateway.node`, and tccd matches the stored grant by identifier. Prove it after step 10 with a probe LaunchAgent under the test label prefix `sh.wemessage.test.` that runs the bundled node on a one-line script which opens the Messages database read-only, reads nothing, and prints the error code. Pass is EPERM. The probe plist and its load and unload lines are prepared for you at run time rather than written here, because this document names no launchd verbs. If the probe does not get EPERM, switch the WeMessage entry off at once and report. If L2 was needed in the FDA experiment, this residue is live by construction, because node then holds a grant of its own.
- (ii) A hostile data directory. `WEMESSAGE_DIR` is a required key, so the allowlist forwards it, and the adapter store under it names commands the daemon spawns (the openclaw adapter spawns its configured command, and that grandchild inherits the app's attribution). Check that `wemessage adapters list` shows only adapters you added (none on a first install), that `ls -ld ~/Library/Application\ Support/WeMessage` shows the directory owned by you and writable by nobody else, and that the plist path in step 6's output names only the app's own executable with `--daemon` and no environment keys other than `WEMESSAGE_*`. The later fix is validated config and adapters that disclaim Full Disk Access for their own children.

### Post-run checklist

Send these back, one line each. They seed the next slices: the FDA result
decides the `FDA_EPERM` rewrite and whether L2 becomes permanent, and the
double-click result decides whether S4 needs a single-instance guard. Remove
your own number and Apple ID from anything you paste.

- [ ] macOS version and build (`sw_vers`).
- [ ] Step 2: quarantine attribute present after ditto (yes or no).
- [ ] Step 3: designated requirement matched (yes or no).
- [ ] Step 4: Open Anyway worked; the exact wording of both dialogs.
- [ ] Step 7: the control `fda` result.
- [ ] Step 10: the `fda` result, the name the Full Disk Access list showed, and which rung worked (none, L1, L2, neither).
- [ ] Step 11: the exact Automation prompt title, and whether the message arrived.
- [ ] `wemessaged service status --json` output after step 11.
- [ ] `wemessage doctor --json` output after step 11.
- [ ] The double-click check: Pass, or which Fail.
- [ ] Residual risks: both checks printed nothing; the commit check exited 0; residue (i) probe result (EPERM or not); residue (ii) checks.
- [ ] The verdict on `FDA_EPERM` this implies: rewrite, reword, or unchanged.

### What S2 proves without this run

```
Claim                                                         Proven by                         Needs this run
------------------------------------------------------------  --------------------------------  --------------
The host spawns, forwards signals, mirrors exit status        swift test (local) and ci-swift   no
The bundle layout, one identity, stable designated            release lane pack-swift (S2e)     no
requirement across two packs
The plist host shape renders, parses, migrates, reports       vitest daemon project             no
The host forwards an allowlist and compiles no overrides      ci-swift and arch rows (S2c.1)    no
Doctor speaks the runtime union in daemon, client and Swift   vitest and swift test             no
TCC attributes the hosted node's reads to WeMessage.app       nothing automated can prove it    yes (step 10)
The Automation prompt names WeMessage                         nothing automated can prove it    yes (step 11)
Open Anyway works for a self-signed zip on macOS 26           nothing automated can prove it    yes (step 4)
A double-click opens a window while the daemon runs           nothing automated can prove it    yes (step 12)
```

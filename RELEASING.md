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

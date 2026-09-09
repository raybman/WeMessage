# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0-rc.1] - 2026-09-09

First release candidate. WeMessage is a macOS gateway that lets an AI agent
take part in an iMessage conversation without ever being handed the send
button: every outbound message is drafted, queued, and released by a person.

This build is **not signed with an Apple Developer ID and not notarized**, and
that is a decision rather than an omission. The project is open source, and
requiring a paid Apple membership between a reader and a working build would
put a toll booth in front of the only thing the project is for. The published
artefacts are named `-UNSIGNED` so nobody can mistake what they have, and the
install page documents the one Gatekeeper step that costs. Signed and
notarized builds are what the `1.0.0` tag is for.

**Read this before you update: every update re-locks Full Disk Access.** It is
the one consequence of the unsigned lane that costs something after the first
launch, so it is here rather than in a footnote. macOS identifies an unsigned
app by a hash of the binary, that hash changes on every build, and Full Disk
Access has no consent dialog to re-ask. The result is that the WeMessage row in
Privacy and Security stays visibly switched on after an update while the
gateway's reads of the message database fail. Remove the WeMessage entry and
add `/Applications/WeMessage.app` back; toggling the existing switch does not
work, because it belongs to a build that no longer exists. `wemessage doctor`
names this case, and the wizard verifies the daemon's own reads rather than the
switch.

### Added

- **S1, live tail.** The daemon reads the local `chat.db` in read-only WAL
  mode, tails new rows, and serves them over a loopback-only HTTP and
  WebSocket surface. Full Disk Access is detected and explained rather than
  crashed on.
- **S2, rules and audit.** A rules engine over incoming messages, and an
  append-only audit log that records every decision and every side effect
  before it is broadcast.
- **S3, permissions, doctor and send foundations.** `wemessage doctor`
  reports each permission the app needs, what is missing, and the exact
  remediation, with a non-zero exit when the answer is "not yet".
- **S4, the gate.** Drafts and approval. The core invariant of the project
  lands here: an agent produces a draft, and only an approved draft is ever
  dispatched.
- **S5, the first agent.** The wire protocol becomes real, with a typed
  client, an adapter test kit, and the first working adapter.
- **S6, arming and autonomy.** Per-contact and per-scope policy, an autonomy
  ladder, and caps. A narrower scope can never widen what sits above it.
- **S7, ecosystem.** Server-sent events, the Hermes, Luna and OpenClaw
  adapters, agent skills, and a publishable adapter test kit.
- **S8, the GUI.** An Electron app: the approval queue, draft editors, the
  audit view, settings with a kill switch, a tray, an onboarding wizard, and
  an accessibility pass with keyboard-only triage.
- **S9, ship.** Packaging, ad-hoc signing, a bundle verifier, a notarization
  state machine, the release pipeline, a Homebrew cask, a hardened licence
  gate with third-party notices, and this file.

### Security

- Outbound sending is reachable from exactly one call site, and that call
  site requires an approved draft. The suite asserts the count, so a second
  path cannot be added without a test failing.
- The HTTP and WebSocket surfaces bind to loopback only.
- No release workflow step reads a signing secret without an explicit lane
  guard, and every third-party GitHub Action is pinned to a commit SHA rather
  than a mutable tag.

[Unreleased]: https://github.com/raybman/WeMessage/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/raybman/WeMessage/releases/tag/v1.0.0-rc.1

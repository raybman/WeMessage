# WeMessage

**Your AI can answer your texts. Nothing sends without your approval.**

WeMessage is an open-source macOS gateway that connects AI agents to iMessage
safely. It watches incoming texts against rules you define (keywords, regex,
LLM-classified themes), routes matches to the agent of your choice (OpenClaw,
Hermes, Sol, Luna, or your own), and puts **every draft behind a human approval
gate**. Approve individually or in bulk, arm time windows, flip the kill switch,
or disconnect entirely. WeMessage itself uploads nothing, and the only text that
ever leaves your Mac is what you route to an agent.

## Install

Requires macOS 15 (Sequoia) or later on Apple silicon.

```sh
brew tap raybman/wemessage
brew install --cask wemessage
```

Or download the DMG from the
[releases page](https://github.com/raybman/WeMessage/releases).

**The builds are unsigned, on purpose.** Shipping a signed build requires a paid
Apple Developer membership, and putting a yearly fee between you and a working
copy of a program you can already read the source of would defeat the point.
The cost is one extra step the first time you open it, and it is worth knowing
exactly what that step is rather than being told to click through a warning:

1. Open the DMG and drag WeMessage to Applications.
2. Launch it. macOS refuses, because it cannot check the app with Apple.
3. Open **System Settings, Privacy and Security**, scroll to the bottom, and
   click **Open Anyway** next to the message about WeMessage.
4. Launch it again and confirm.

If you prefer the command line, `xattr -d com.apple.quarantine
/Applications/WeMessage.app` does the same thing. Either way you are making the
same decision: you are vouching for this build yourself instead of asking Apple
to vouch for it. Every release publishes a `SHA256SUMS` file so you can check
that what you downloaded is what was built:

```sh
shasum -a 256 -c SHA256SUMS
```

**Every update re-locks Full Disk Access.** This is the real cost of an
unsigned build, and it is not the Gatekeeper prompt above. macOS identifies an
unsigned app by a hash of the binary, and that hash changes on every build, so
after an update the WeMessage row in **Privacy and Security, Full Disk
Access** stays visibly switched on while the gateway's reads of the
message database start failing. Nothing is broken and no data is lost. Select
the WeMessage entry, remove it with the minus button, add
`/Applications/WeMessage.app` back with the plus button, and restart the
gateway. Toggling the existing switch off and on does not work, because the
entry it belongs to points at a build that no longer exists. `wemessage doctor`
reports this case by name rather than leaving you to guess at it, and the
onboarding wizard checks the daemon's own reads instead of trusting the switch.

Build it yourself instead, if you would rather:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack:adhoc
```

## What it does

An agent reads a message and writes a reply. The reply goes into a queue. You
read it, edit it if you like, and release it. Nothing else can send.

That is not a policy setting, it is the shape of the program. The adapter
protocol an agent speaks has no send frame in it, so there is no message an
agent could construct that would put text on the wire. The suite asserts that
outbound sending is reachable from exactly one call site and that the call site
requires an approved draft, which means a second path cannot be added without a
test failing.

## Permissions

WeMessage needs two permissions from macOS, and it will tell you which one is
missing rather than failing silently.

- **Full Disk Access**, to read the local iMessage database. This is a read
  only, write-ahead-log read of a file already on your Mac. Nothing is uploaded.
- **Automation**, to hand an approved message to Messages so it can be sent.

`wemessage doctor` reports the state of each one, what is missing, and the exact
remediation, and exits non-zero while anything is unresolved. The onboarding
wizard runs the same checks with the same words.

## Keep it running

The daemon can run one of two ways, and the wizard asks you to choose:

- **As a background service (recommended).** `wemessaged service install` writes
  a LaunchAgent so the gateway is running whether or not the window is open.
- **Only while WeMessage is open.** The app supervises the daemon itself and
  stops it on quit.

Either way the relevant verbs are `wemessaged service install`,
`service status --json`, and `service uninstall`.

## Agents

Three documents are the whole public contract. Everything else is
implementation.

- **The wire.** [`packages/protocol/PROTOCOL.md`](packages/protocol/PROTOCOL.md)
  is what an adapter speaks: nine frame types, twenty-one events, four close
  codes. It is generated from the tables the gateway parses with and diffed on
  every test run, so it cannot drift from the code. Start with the section
  titled "What the protocol cannot do".
- **The kit.** [`packages/adapter-testkit/README.md`](packages/adapter-testkit/README.md)
  is the quickstart. Copy one file, run one command, and find out whether your
  program is an adapter yet. It ships a working reference adapter that needs no
  install and no build.
- **The skill.** [`skills/claude/SKILL.md`](skills/claude/SKILL.md) is what an
  agent reads before it is allowed near the CLI: which verbs it may run, which
  need a human sentence first, and which it may never run whatever it is told.

Adapters for OpenClaw, Hermes, Sol and Luna ship in the tree, each with a README
stating plainly what has and has not been verified against a running system.

## Security

Every outbound message passes through one approval gate, and the gate is
structural rather than configured. Loopback only, no telemetry, no account.

**What leaves your Mac, precisely.** WeMessage sends nothing anywhere. Your
message database, your drafts and the audit log are read and written locally and
are never uploaded. The one exception is the agent you attach, and it is not
really an exception: an agent has to read a message before it can draft a reply.
Point WeMessage at an agent running on this machine and no message text leaves
it at all. Point it at a hosted one and that service receives the text you route
to it, exactly as it would from any other client you gave that access to. Which
of those you want is your decision, and the rules you write are where you make
it.

Adapter tokens are stored only as a scrypt hash, so a token cannot be read back
out of the database, by you or by anything that gets hold of the file.

Found something? See [SECURITY.md](SECURITY.md). Please do not open a public
issue for a vulnerability.

## Uninstall

```sh
brew uninstall --cask wemessage
```

Or, for a manual install:

```sh
wemessaged service uninstall
rm -rf /Applications/WeMessage.app
rm -rf ~/Library/Application\ Support/WeMessage ~/Library/Logs/WeMessage
```

Revoking Full Disk Access and Automation is done in System Settings, Privacy and
Security, and is worth doing if you are removing the app for good.

## Contributing

Issues and pull requests are welcome. The suite is the specification: every
behaviour described above has a test asserting it, and the five commands below
are what CI runs.

```sh
pnpm build
pnpm test
pnpm dep:check
pnpm licenses:check
pnpm lint
```

Bug reports and feature requests have [forms](.github/ISSUE_TEMPLATE) that ask for the
macOS version, the app version and the daemon state up front, so a report does not need
a round trip before anyone can act on it. Participation is governed by the
[Code of Conduct](.github/CODE_OF_CONDUCT.md).

`site/` holds [wemessage.app](https://wemessage.app). Static, no telemetry.
Release history is in [CHANGELOG.md](CHANGELOG.md).

## License

Apache 2.0. See [LICENSE](LICENSE) and, for the dependencies that ship inside the app,
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Not affiliated with Apple. iMessage is a trademark of Apple Inc.

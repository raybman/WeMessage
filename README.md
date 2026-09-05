# WeMessage

**Your AI can answer your texts. Nothing sends without your approval.**

WeMessage is an open-source macOS gateway that connects AI agents to iMessage —
safely. It watches incoming texts against rules you define (keywords, regex,
LLM-classified themes), routes matches to the agent of your choice (OpenClaw,
Hermes, Sol, Luna, or your own), and puts **every draft behind a human approval
gate**. Approve individually or in bulk, arm time windows, flip the kill switch,
or disconnect entirely. Local-only: your messages never leave your Mac.

> ⚠️ **In development.** The plan is done; the code is landing. Watch releases
> to be notified when v1 ships.

## Why

Every existing tool picks one of two bad options: the bot sends whatever it
wants, or there is no bot at all. wemessage occupies the middle that should
have existed all along — **drafts by default, sends only with your approval**.
Structurally: the agent adapter protocol has no send frame. Agents cannot send.
They can only draft.

## Surface

Three documents are the whole public contract. Everything else is
implementation.

- **The wire.** [`packages/protocol/PROTOCOL.md`](packages/protocol/PROTOCOL.md)
  is what an adapter speaks: nine frame types, seventeen events, four close
  codes. It is generated from the tables the gateway parses with and diffed on
  every test run, so it cannot drift from the code. Start with the section
  titled "What the protocol cannot do".
- **The kit.** [`packages/adapter-testkit/README.md`](packages/adapter-testkit/README.md)
  is the quickstart. Copy one file, run one command, and find out whether your
  program is an adapter yet. It ships a working reference adapter that needs
  no install and no build.
- **The skill.** [`skills/claude/SKILL.md`](skills/claude/SKILL.md) is what an
  agent reads before it is allowed near the CLI: which verbs it may run, which
  need a human sentence first, and which it may never run whatever it is told.

Also in the tree:

- **Glass GUI** (Electron): approval queue built for keyboard triage, rules
  editor, schedule editor, audit log, oversized kill switch.
- **CLI** (`wemessage`): `doctor`, `watch --json`, `drafts approve`, `kill`,
  full JSON output for automated agents.
- **Adapters** for OpenClaw, Hermes, Sol and Luna, each with a README stating
  plainly what has and has not been verified against a running system.

## Site

`site/` holds [wemessage.app](https://wemessage.app). Static, no telemetry.

---

Not affiliated with Apple. iMessage is a trademark of Apple Inc.

# wemessage

**Your AI can answer your texts. Nothing sends without your green light.**

wemessage is an open-source macOS gateway that connects AI agents to iMessage —
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

## Planned surface

- **Glass GUI** (Electron) — approval queue built for keyboard triage, rules
  editor, schedule editor, audit log, oversized kill switch.
- **CLI** (`wemessage`) — `doctor`, `watch --json`, `drafts approve`, `kill`,
  full JSON output for automated agents.
- **Adapters + companion skill** so agent platforms drive it natively.

## Site

`site/` holds [wemessage.app](https://wemessage.app). Static, no telemetry.

---

Not affiliated with Apple. iMessage is a trademark of Apple Inc.

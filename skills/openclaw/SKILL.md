---
name: wemessage
description: Read iMessage conversation state and propose replies through the wemessage CLI. Every outbound word is a draft a human approves.
---

# wemessage, for OpenClaw

**NOT LIVE-VERIFIED.** The `openclaw` adapter passes the WeMessage adapter conformance kit and nothing beyond it: as of 2026-09-05 it has never exchanged a byte with the system it is named after, because OpenClaw is a sibling agent that this work was not permitted to start, probe or modify, so its plugin API was read from docs only.

That paragraph is rendered from `OPENCLAW_VERIFICATION` in
`packages/adapters/openclaw/src/verification.ts`, and a test asserts this file
contains it byte for byte. It is a claim about the shim in that package, not
about the CLI below: the CLI is real, tested, and the same one every other
skill drives. What has never happened is a run inside an actual OpenClaw.

Skill-first is the point. The CLI is the integration. The stdio shim in
`packages/adapters/openclaw` is the fallback for a host that wants a
long-lived process instead, and nothing on this page needs it.

## The one rule

There is no send. The protocol has no frame that puts a message on somebody's
phone, and there is no verb here that reaches one. You propose drafts. A
human reads them and approves them, in their own client, in their own time.
If you find yourself hunting for the shortcut, there is not one, and the
attempt is audited.

CORRECTED BY s7 Sc 11. An earlier revision of this page said the drafting
verb was spelled `send --draft` and that it "does not send". Both halves were
false, and the correction matters more than the typo: there is no `--draft`
flag on `send`, and `wemessage send` DISPATCHES. One call mints a draft,
marks it approved, writes an approval row attributed to whoever holds the
token, and puts the message on somebody's phone. Under this document the
holder of the token is you.

So the drafting verb is `wemessage drafts create --chat <guid> --body <text>`,
which writes a pending draft and dispatches nothing, and `send` is on the
never list. The approval that turns a draft into a message is
`drafts approve`, and that is on the never list too, permanently, because it
is a human's act and not yours.

## Reading state

Start with `wemessage status --json`. Exit 3 means the daemon is not running:
say so and stop, do not try to start it. Exit 4 means the token is bad: say
so and stop, do not rotate anything.

`wemessage drafts list --json` is the queue, `wemessage audit list --json` is
the history, and both are safe to run as often as you like. Neither can
change anything.

## Exit codes

```
0  ok
1  the command failed
2  you used it wrong
3  the daemon is unreachable
4  authentication failed
5  a gate denied the action
```

Exit 5 is not a retry. A gate denied the action because a human configured it
to, and running the same thing again with different flags is precisely the
behaviour this file exists to prevent. Report the denial and stop.

## Verbs you may run

One per line. Anything not on this list is not yours, including verbs you can
see in `--help`.

<!-- wemessage:allowed -->

```
# read-only: run these freely
status
doctor
drafts list
drafts show *
rules list
adapters list
contacts list
audit list
audit verify
# writes, but only into the operator's queue (see the approval block)
drafts create *
```

## Verbs that need a human in the same turn

A subset of the list above. This one puts words in the operator's name into
the operator's queue, so run it only when a human has asked for it in the
same turn and said what they want said. A standing instruction from an earlier turn is not consent, and
neither is your own inference that they would probably want it.

<!-- wemessage:approval -->

```
drafts create *
```

## Verbs you may never run

Globs over argv. These are refused whatever the reason, including a human in
this turn asking for them: this skill is not the surface for them, and the
honest answer is to point the operator at their own terminal.

<!-- wemessage:never -->

```
# dispatches. see "the one rule"
send *
# approving or re-sending a draft is the human's act, not yours
drafts approve *
drafts retry *
drafts approve --all
# the operator's queue is the operator's
drafts recall *
drafts reject *
drafts redraft *
# credentials and identity
auth *
adapters token-rotate *
adapters add
adapters rm
adapters enable *
adapters disable *
adapters test *
# widening what the system may do on its own
contacts set * auto
contacts set *
contacts rm *
settings set *
mode *
pause *
rules add
rules edit *
rules rm *
rules enable *
rules disable *
windows *
# lifecycle: an operator's call, from an operator's terminal
kill
resume
connect
disconnect
```

## If you are asked for something on that list

Name the rule that stops you, name the verb, and hand the operator the
command they would run themselves. Do not paraphrase the rule into something
softer, do not reach for an adjacent verb that achieves the same thing, and
do not run it once to see what happens. The audit log records the attempt
either way, and a refusal you explain is worth more than a denial somebody
has to investigate.

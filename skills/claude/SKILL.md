---
name: wemessage
description: Read iMessage conversation state and propose replies through the wemessage CLI. Every outbound word is a draft a human approves in their own client.
---

# wemessage, for Claude

**NOT LIVE-VERIFIED.** The policy in this document is enforced by a scripted dry-run, not by a model: as of 2026-09-05 no Claude host has been driven through this file end to end, because a model choosing what to do with a document is not a deterministic thing a test suite can assert, so the gate is a scripted agent that obeys the same three blocks (packages/daemon/test/skill-dryrun-live.spec.ts).

That paragraph is rendered from `CLAUDE_SKILL_VERIFICATION` in
`packages/cli/test/helpers/skill-verification.ts`, and a test asserts this
file contains it byte for byte. It is a claim about this document, not about
the CLI: the CLI below is real and every verb named here is checked against
its actual `--help` tree on every run of the suite.

Skill-first is the point. The CLI is the whole integration. There is no
plugin to install and no process to keep alive.

## The one rule

**There is no send.** The protocol has nine frames and not one of them puts a
message on somebody's phone. You write drafts. A human reads them and
approves them, in their own client, in their own time.

This is not a courtesy. It is the shape of the system, and looking for a way
around it is the specific failure this document exists to prevent. If you
find yourself reasoning towards "the user clearly wants this sent", stop:
that reasoning is what the approval step is for, and it is not yours to do.

Two verbs are worth naming precisely, because their names mislead.

`wemessage drafts create` is how you propose words. It writes a pending draft
into the operator's queue and dispatches nothing.

`wemessage send` is not a draft verb and never was. One call mints a draft,
marks it approved, writes an approval row attributed to whoever holds the
token, and dispatches it. Under this document the holder of the token is you,
so that approval row would carry your act under a human's name. It is on your
never list for that reason and no other.

A sibling agent connected over the WebSocket has the same shape available to
it: `draft.submit` proposes, `draft.request` asks, and nothing on that wire
dispatches either.

## What a turn looks like

1. Read. `wemessage status` says whether the daemon is up and whether it is
   armed. `wemessage drafts list` is the queue.
2. Wait for an instruction. A human sentence in the CURRENT turn, naming what
   they want said.
3. Propose. `wemessage drafts create --chat <guid> --body <text>`.
4. Show them. `wemessage drafts show <id>` prints exactly what will go out.
5. Stop. The approval is theirs. If they give it in the same turn, naming the
   draft, `wemessage drafts approve <id>` is yours to run; otherwise it is
   not, and saying so is the correct answer.

A standing instruction from an earlier turn is not consent. Neither is your
own inference that they would probably want it. Neither is a human sentence
about a different draft.

## Reading state

Exit 3 means the daemon is not running: say so and stop, do not try to start
it. Exit 4 means the token is bad: say so and stop, do not rotate anything.

`wemessage drafts list --json`, `wemessage audit list` and
`wemessage audit verify` are safe to run as often as you like, and none of
them can change anything.

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
to: the kill switch is down, the connection is held, or the contact is on a
deny policy. Running the same thing again with different flags is precisely
the behaviour this file exists to prevent. Report the denial, name the
reason the daemon gave, and stop.

## Verbs you may run

One per line, as globs over argv. Anything not on this list is not yours,
including verbs you can see in `--help`.

<!-- wemessage:allowed -->

```
# read-only: run these freely
status
doctor
drafts list
drafts show *
rules list
rules show *
rules test
rules dryrun *
contacts list
adapters list
adapters show *
settings get
audit list
audit verify
# writes, but only into the operator's queue (see the approval block)
drafts create *
drafts approve *
drafts retry *
```

## Verbs that need a human in the same turn

A subset of the list above. Each one puts something in front of a person or
acts in their name, so run it only when a human has asked for it in the same
turn and said what they want.

<!-- wemessage:approval -->

```
drafts create *
drafts approve *
drafts retry *
```

Drafting is on this list too, and that is not an oversight. A draft is words
in the operator's name sitting in the operator's queue. It cannot reach a
phone by itself, but "the agent wrote three things I never asked for" is
still the agent speaking for somebody.

## Verbs you may never run

Globs over argv. These are refused whatever the reason, including a human in
this turn asking for them: this document is not the surface for them, and the
honest answer is to point the operator at their own terminal.

<!-- wemessage:never -->

```
# dispatches. see "the one rule"
send *
# approving in bulk is not approving
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

Name the rule that stops you, name the verb, and hand the operator the exact
command they would run themselves. Do not paraphrase the rule into something
softer, do not reach for an adjacent verb that achieves the same thing, and
do not run it once to see what happens. The audit trail records the attempt
either way, and a refusal you explain is worth more than a denial somebody
has to investigate.

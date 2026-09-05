---
name: wemessage
description: Read iMessage conversation state through the wemessage CLI. Read-only. Replies travel over the Hermes WIRE adapter, not from this document.
---

# wemessage, for Hermes

**NOT LIVE-VERIFIED.** The policy in this document is enforced by a scripted dry-run, not by a model: as of 2026-09-05 no Hermes host has been driven through this file end to end, because Hermes is a sibling agent this slice was not permitted to start, probe or modify, so every claim here about how a Hermes host uses the CLI is inference from its published surface.

This document governs **tool use of the CLI, and nothing else**. Under Hermes
the words that reach a conversation travel over the Hermes **wire adapter**
(`packages/adapters/hermes`, F-89), which speaks the WebSocket protocol and
proposes with `draft.submit`. That path has its own approval story and its
own tests. What you have here is the terminal, and in the terminal you read.

Which is why the approval block below is empty. An empty block is the honest
encoding of "nothing here needs a human, because nothing here acts". If you
are looking for the verb that writes, it is not in this file, and it is not
missing by accident.

## The one rule

**There is no send.** The protocol has nine frames and not one of them puts a
message on somebody's phone. That is true on the wire and it is true here.

## Reading state

`wemessage status` says whether the daemon is up and whether it is armed.
`wemessage drafts list` is the queue and `wemessage drafts show <id>` is one
entry of it. `wemessage audit list` and `wemessage audit verify` are the
history and its hash chain.

Exit 3 means the daemon is not running: say so and stop, do not try to start
it. Exit 4 means the token is bad: say so and stop, do not rotate anything.

## Exit codes

```
0  ok
1  the command failed
2  you used it wrong
3  the daemon is unreachable
4  authentication failed
5  a gate denied the action
```

Exit 5 is not a retry. Report the denial, name the reason the daemon gave,
and stop.

## Verbs you may run

One per line, as globs over argv. Every one of them is read-only. Anything
not on this list is not yours, including verbs you can see in `--help`.

<!-- wemessage:allowed -->

```
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
```

## Verbs that need a human in the same turn

None. See above: this document does not act.

<!-- wemessage:approval -->

```
# deliberately empty. the wire adapter proposes; the terminal reads.
```

## Verbs you may never run

Globs over argv. Refused whatever the reason, including a human in this turn
asking for them. The first three are the ones a capable reader will reach for
first, and they belong to the wire adapter, not to you.

<!-- wemessage:never -->

```
# drafting and approving are the wire adapter's story, not the terminal's
drafts create *
drafts approve *
drafts retry *
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

Name the rule that stops you, name the verb, and say where the capability
actually lives. For anything that writes, that is the wire adapter. For
anything about credentials, lifecycle or policy, that is the operator's own
terminal.

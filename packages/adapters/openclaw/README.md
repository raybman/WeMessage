# @wemessage/adapter-openclaw

**NOT LIVE-VERIFIED.** The `openclaw` adapter passes the WeMessage adapter conformance kit and nothing beyond it: as of 2026-09-05 it has never exchanged a byte with the system it is named after, because OpenClaw is a sibling agent that this work was not permitted to start, probe or modify, so its plugin API was read from docs only.

That paragraph is not written by hand. It is rendered from
`OPENCLAW_VERIFICATION` in `src/verification.ts` by `verificationBanner()`,
and a test asserts this file contains the rendered string byte for byte.
Editing this sentence to claim more, or editing the value to claim more,
fails the same row. The claim is a value; this is only where it is printed.

## What it is

A GENERIC NDJSON-over-stdio shim. It speaks the WeMessage adapter wire on one
side and a line protocol on the other, and the child contract below is ours:
defined in `src/index.ts`, documented here, and owing nothing to OpenClaw's
design. Anyone can implement the child in any language in an afternoon.
`../../adapter-testkit/examples/stdio-child.mjs` is a complete one in fifty
lines with no imports, and this package's conformance row runs that exact
file rather than merely linting it.

Generic was a choice made because of what we do not know. OpenClaw's plugin
API was read from docs only; nothing in this repository has ever called it.
A shim built tightly against an API nobody here has exercised would be wrong
in ways nothing could detect. A generic one is wrong, at most, about a
manifest file.

## The child contract

One JSON object per line, newline terminated, UTF-8. Two directions, six
kinds, and that is the whole vocabulary.

Shim to child, on the child's stdin:

```
kind        payload
----------  ------------------------------------------------------------
`request`   the wire draft.request.payload, verbatim: correlation,
            message, context, rule, constraints
`ping`      nothing; a liveness probe
`error`     reason -- your last line was refused, and which of six
            reasons it was
```

Child to shim, on the child's stdout:

```
kind        payload
----------  ------------------------------------------------------------
`submit`    correlation.requestId and body -- the draft
`decline`   correlation.requestId and an optional reason
`pong`      nothing; the answer to a ping
```

A `request` carries the wire payload with nothing renamed and nothing
flattened. `PROTOCOL.md` already describes those fields, so a child author
reads one document rather than two somebody has to keep in sync.

### Every ugly case, and what happens

A public contract that a stranger implements in a language we have never
seen makes "what happens if" the specification rather than an edge case.
Every row below is a test in `test/shim.spec.ts`.

```
input                              behaviour
---------------------------------  ---------------------------------------
a line split across two chunks     buffered, delivered once, whole;
                                   splitting per character is the same path
CRLF line endings                  the CR is stripped; a lone CR is not a
                                   terminator
a blank or whitespace-only line    skipped, not refused
a line past 256 KiB                dropped whole, counted child.oversize,
                                   and the reader resynchronises at the next
                                   newline: the tail never becomes a line
an over-budget line that never     refused once, then everything up to the
terminates                         next newline is discarded
invalid JSON with valid lines      costs only that line; the lines around it
either side                        are honoured
a trailing line with no newline    flushed at exit and honoured: plenty of
                                   correct programs never terminate the last
a child that dies mid-line         the fragment is dropped, counted
                                   child.truncated, and every open request
                                   is declined
a child that emits nothing         every open request declines at its own
                                   constraints.deadlineMs
a child that exits                 respawned, at most maxAttempts times,
                                   then health is degraded and further
                                   requests decline immediately
a submit for a requestId nobody    dropped, counted
asked about                        child.unknown-correlation; no frame
any line the shim refuses          answered with {"kind":"error","reason":
                                   ...} so the author can debug it
```

## There is no send

The protocol has no send frame. Not a restricted one, not a privileged one:
there is no frame in the wire vocabulary that puts a message on somebody's
phone. This shim is the place a stranger would most reasonably expect to find
one, which is exactly why the negatives are the tests that matter here.

A child line already shaped like a wire frame -- correct `v`, correct `ts`,
`"type":"send"` -- is refused and never forwarded. A `{"kind":"send"}` is
refused the same way. Both are counted `child.rejected`, both are answered
with an `error`, and both audit as `adapter.no-send-frame:send`. A
structurally broken line audits as `adapter.protocol-violation:<reason>`.
Neither ever audits as `gate.denied`: that label means a human declined a
draft, and borrowing it for a protocol bug would file a child's syntax error
in the queue where approval decisions are reviewed.

The only thing that turns a child line into a gateway frame is an open
`draft.request` the shim is already holding, and the only frame it can become
is a `draft.submit` -- a draft, which a human approves. That is INV-2 as
reachability rather than as policy.

The child never sees the gateway credential either. `childEnv` strips
`WEMESSAGE_ADAPTER_TOKEN`, and anything else `wm_` shaped, out of the
environment it hands down; the token is never an argument, because `ps(1)`
shows every user on the machine the full argv of every process.

## Binding it to OpenClaw

This is an EXAMPLE, and it is UNVERIFIED. It has never been installed against
a real OpenClaw, and every statement it makes about how OpenClaw loads a
plugin is a guess (see below). It is here because a reader deserves to see
what we think the last mile looks like, labelled as what we think.

```json
{
  "name": "wemessage",
  "command": "node",
  "args": ["./stdio-child.mjs"]
}
```

Written to `openclaw.plugin.json`, on the assumption that OpenClaw discovers
a plugin from a manifest of that name and runs the named executable as a
child process it talks to over stdin and stdout. If any of that is wrong, the
fix is this section and that manifest, not the shim: nothing under `src/`
names OpenClaw, and a test asserts it stays that way.

## What is verified

Each of these has a file in this repository behind it, which a reader can
open and run.

- the NDJSON child protocol this package speaks is defined by this repo, not by OpenClaw
  (`src/index.ts`)
- a child line cannot become a gateway frame the shim did not already have an open request for
  (`test/shim.spec.ts`)
- the gateway credential is never written to the child environment or to its argv
  (`test/shim.spec.ts`)
- the shim passes the same six conformance checks as every other adapter in this repo, driving the committed example child
  (`../../adapter-testkit/examples/stdio-child.mjs`)

## What is a guess

Everything this package says about OpenClaw itself. Nothing in this tree has
ever called OpenClaw, started it, or read anything belonging to it beyond its
documentation, so each of the following is a belief published as a belief.

- OpenClaw discovers a plugin from a manifest named `openclaw.plugin.json`
  -- settled by installing one manifest against a real OpenClaw and watching
  it load
- that manifest can name an executable which OpenClaw runs as a child process
  -- settled by the same one-manifest install
- OpenClaw talks to such a child over its stdin and stdout rather than a socket
  -- settled by reading which file descriptors the child process is handed while it runs
- nothing in OpenClaw needs to change for it to drive this shim
  -- settled by one end-to-end run with an operator present

The skill at `skills/openclaw/SKILL.md` is the primary OpenClaw-facing
surface, and it carries the same admission in its own first paragraph.

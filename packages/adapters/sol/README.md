# @wemessage/adapter-sol

The Sol agent behind the gateway's adapter seam, at a cost to Sol of zero
lines. Sol drafts; a person approves; the daemon sends.

**NOT LIVE-VERIFIED.** The adapter is proven against an in-process mock of
Sol's external WebSocket seam, built by reading that seam's source, and it has
never exchanged a byte with a running Sol. C-9 requires the sentence to be
here rather than implied, and the section below is the specific reason it
still says this: the live seam has drifted from the document the mock was
built from, and the drift was recorded instead of chased.

The adapter is a bridge with two sockets and no opinions:

```text
gateway --draft.request--> [sol adapter] --{"type":"message"}--> Sol
gateway <--delta/submit--- [sol adapter] <--token/done/error---- Sol
```

```text
src/index.ts   both directions, the field allowlist, the fail-closed start
```

Four properties are load-bearing, each pinned by the contract spec against
that mock:

- **The owner flag is never ours to set.** Sol's own invariant says the
  authenticated-owner field may be set only by a transport that verified an
  owner credential for that connection, and never read off a client frame. We
  are a client frame. It is absent from the field allowlist, constructed
  nowhere, and asserted absent on every byte the mock receives (INV-4).
- **Fail closed on a missing secret.** With no shared secret the adapter
  refuses to start, names the missing variable on the operator log, and exits
  non-zero. It never dials Sol unauthenticated and never dials the gateway
  either: an adapter that connects and then cannot answer is worse than one
  that is honestly absent.
- **No send frame exists.** Sol's proactive tool becomes a proposal a person
  must approve, never a send. Its reply path becomes a draft submission. No
  code path here reaches a recipient without an approval (INV-2).
- **An interrupted stream produces no draft.** If Sol's socket drops
  mid-answer the accumulated partial text is discarded. Half an answer shown
  to a person as a finished draft is a worse failure than no answer.

## Known seam drift

Observed 2026-09-03, recorded and deliberately not fixed. Sol's own repository
is not modified by this integration, and chasing the drift upstream would
trade a zero-change integration for a fork.

The design document described the WebSocket seam as carrying a per-message
identity. The live implementation instead hardcodes one identity for every
message that arrives on that transport, `ws-desktop`, together with a fixed
display name and channel. Three consequences, stated plainly for anyone
writing against this seam:

1. Per-conversation identity is dropped. The namespaced handle and chat
   identifier this adapter puts on the frame travel correctly and are ignored
   on the far side today, so every conversation would share the `ws-desktop`
   session key.
2. The owner flag is set by Sol from the connection, which is exactly right
   and exactly why this adapter must never send it. The drift does not weaken
   that invariant; it strengthens the case for asserting key absence.
3. Both of Sol's outbound paths, the reply and the proactive message, collapse
   into a `token`-only reply on the live transport, so the two are
   indistinguishable there. This adapter keeps them distinct anyway, because
   the gateway treats a draft and a proposal as different objects and
   collapsing them here would launder a proactive message into a reply.

A future scenario may absorb this adapter-side with a per-conversation session
identifier, or by moving to the HTTP seam, if and when Sol's identity handling
changes. Until then this section is the warning, and the contract spec has a
row that fails if the mock is quietly upgraded to match a fix nobody made.

## There is no send frame

See `PROTOCOL.md` in `@wemessage/protocol`. The adapter proposes; a person
approves; the daemon sends. There is no fourth option and no frame that skips
the person.

## Licensing

Apache-2.0. See the repository root.

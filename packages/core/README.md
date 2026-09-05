# @wemessage/core

The domain, and nothing else: the types, the state machines and the port
interfaces the rest of WeMessage is built from. No I/O, no dependencies, no
knowledge that adapters exist.

```text
domain/     the nouns: drafts, rules, contacts, chats, actors, identifiers
ports/      the interfaces the daemon implements: store, clock, send backend
drafts/     the draft state machine and its legal transitions
rules/      matching, and what a matched rule authorizes
gate/       the policy that decides whether anything may be proposed at all
schedule/   quiet hours, arming windows, grace periods
sending/    what dispatch means, as a type, without doing any of it
audit/      the append-only event vocabulary the whole system writes to
```

This package is enforced pure. dependency-cruiser forbids it from importing
any other workspace package, any external package, and the Node builtins that
do I/O, and an unresolvable import is treated as an attempted dependency
rather than a typo. The reason is not aesthetics: the rules that decide
whether a message may be sent have to be readable, testable and reviewable
without a machine, a database or a network in the picture.

There is one deliberate exception, and it is documented where it lives:
`node:crypto` for sha256, because the audit chain is a hash chain and that
hash is a pure function.

## What it does not do

It does not send. `SendBackend` is an interface here and an implementation
somewhere else, and the only function that reaches it takes an approval as an
argument. A draft that no person approved has nothing to hand it.

## Licensing

Apache-2.0. See `LICENSE`.

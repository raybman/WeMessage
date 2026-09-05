# @wemessage/protocol

The wire an adapter speaks to a WeMessage gateway: nine frame types, a
twenty-one-name event vocabulary, four close codes, and a JSON Schema for every
one of them. Zero runtime dependencies, by rule and by test.

The reference is [PROTOCOL.md](./PROTOCOL.md), in this package. It is
generated from the tables below and diffed on every test run, so it describes
what the gateway does rather than what somebody remembered it doing.

```text
FRAME_SPECS           the nine frames: required keys, optional keys, direction
GATEWAY_EVENT_NAMES   the twenty-one event names, sorted
EVENT_SPECS           the payload keys each event contributes
CLOSE_CODES           the four codes a gateway closes with, and what they mean
ENVELOPE_KEYS         the five keys every frame carries, exactly
WIRE_VERSION          the number in every envelope
src/schemas/          one JSON Schema per frame and per event
```

Everything is data as well as a type. A closed set that only the compiler can
see is not a closed set at the boundary where strangers arrive, so an adapter
in any language can read the same tables the gateway parses with.

## There is no send frame

Not one of the nine puts text in front of a recipient, and no combination of
them does either. An adapter proposes a draft; a person approves it; the
gateway sends. That is the only path, and the absence of a tenth frame is the
thing that makes it the only path.

If you are writing an adapter, do not implement this package by reading it.
`@wemessage/adapter-testkit` runs your program against a real gateway and
reports which of six checks it failed.

## Licensing

Apache-2.0. See `LICENSE`.

# The WeMessage adapter protocol

<!-- GENERATED FILE. Do not edit by hand. -->

This document describes wire version 1 of the protocol an adapter speaks to a WeMessage gateway. It is generated from the same tables the gateway parses with, and a test regenerates it and fails the build if the two disagree, so it cannot quietly go stale. If you are reading a copy of this file, the code that produced it agreed with it.

An adapter is a program that holds one WebSocket, answers requests for a reply, and can do nothing else. Everything it may say is on this page.

## What the protocol cannot do

There is no send frame.

That is the first thing to know about this protocol and the reason it has the shape it has. Not one of the frame types below puts text on anybody's phone, and no combination of them does either. An adapter that invents a tenth frame type gets its socket closed with 4400 and an audit row of type `adapter.no-send-frame` naming what it tried.

Text reaches a recipient along exactly one path:

1. the gateway asks, with `draft.request`, or the adapter offers, with `proactive.propose`;
2. the adapter answers with `draft.submit`, which creates a PENDING draft and sends nothing;
3. a person approves that draft, through `POST /v1/drafts/:id/approve` or the desktop app;
4. the gateway, and only then, dispatches it.

Step 3 is a human being. There is no token, no scope and no frame that skips it.

One route deserves an honest paragraph, because it exists and it is not this path. `POST /v1/send` is the operator composing a message themselves in their own client: it mints an already-approved draft, writes an approval row attributed to whoever holds the operator credential, and dispatches, all in one call. It is the human typing, not the agent acting. An adapter cannot reach it. Adapter credentials authenticate a WebSocket and nothing else, and the HTTP surface is a separate credential an adapter is never given. If you are writing an agent that drives this gateway over HTTP rather than an adapter, treat approve-before-send as the model anyway: propose, then let a person approve.

## The envelope

Every frame in either direction is a JSON object with exactly these keys, no more and no fewer:

```text
v
id
type
ts
payload
```

`v` is the wire version and must equal 1. `id` is a unique identifier for the frame. `type` is one of the names in the next section. `ts` is an ISO-8601 UTC timestamp. `payload` carries the keys that type allows, and an unknown key is a refusal rather than a warning: a v2 peer's new field is better rejected cleanly than guessed at.

A minimal frame, whole:

```json
{
  "v": 1,
  "id": "01J000000000000000000000",
  "type": "pong",
  "ts": "2026-01-01T00:00:00.000Z",
  "payload": {}
}
```

## Frames

There are 9 frame types. Direction is stated for each and is enforced: a gateway-to-agent frame arriving from an adapter is a protocol violation, not a courtesy.

### `hello`

Direction: `agent->gateway`.

The first frame on the socket and the only one a gateway accepts before authentication. `wire` is the version the adapter speaks; a version this gateway cannot speak closes the socket with 4426.

```text
required adapterId, token, wire
optional features
schema   https://wemessage.dev/schemas/v1/hello.json
```

### `draft.submit`

Direction: `agent->gateway`.

The answer to a `draft.request`: a proposed reply, or a decline. Submitting sends nothing. It creates a pending draft that a person has to approve.

```text
required correlation, idempotencyKey
optional body, declined, confidence
schema   https://wemessage.dev/schemas/v1/draft.submit.json
```

### `draft.delta`

Direction: `agent->gateway`.

Optional streaming. Partial text for a reply still being composed, so an operator can watch it arrive. Deltas are display only, and the `draft.submit` that follows is what becomes a draft.

```text
required correlation, seq, textDelta
optional (none)
schema   https://wemessage.dev/schemas/v1/draft.delta.json
```

### `proactive.propose`

Direction: `agent->gateway`.

A draft the adapter offers without having been asked. Same approval gate, plus an arming window an operator has to open first.

```text
required idempotencyKey, target, body, reason
optional (none)
schema   https://wemessage.dev/schemas/v1/proactive.propose.json
```

### `pong`

Direction: `agent->gateway`.

The answer to a `ping`. Two consecutive misses close the socket with 4408.

```text
required (none)
optional (none)
schema   https://wemessage.dev/schemas/v1/pong.json
```

### `draft.request`

Direction: `gateway->agent`.

The gateway asking for a reply: the inbound message, the conversation context, the rule that matched, and the constraints the answer has to satisfy.

```text
required correlation, message, context, rule, constraints
optional (none)
schema   https://wemessage.dev/schemas/v1/draft.request.json
```

### `draft.feedback`

Direction: `gateway->agent`.

What became of a draft this adapter submitted, and who decided. This is how an adapter learns it was rejected, and the only honest signal it gets.

```text
required correlation, kind, actor
optional reason, finalBody, error
schema   https://wemessage.dev/schemas/v1/draft.feedback.json
```

### `event`

Direction: `gateway->agent`.

One member of the event vocabulary below, delivered to any adapter that asked for it. Informational: no event obliges an adapter to do anything.

```text
required event
optional actor, adapterId, armed, batchId, byDraftId, chatGuid, correlation, draft, draftId, error, guid, key, message, newDraftId, newText, reason, ruleId, sentMessageGuid, seq, state, status, textDelta, until, value
schema   https://wemessage.dev/schemas/v1/event.json
```

### `ping`

Direction: `gateway->agent`.

Liveness, sent by the gateway. Answer with `pong`.

```text
required (none)
optional (none)
schema   https://wemessage.dev/schemas/v1/ping.json
```

## Events

The `event` frame carries one of 21 named events. The name is the `event` key of the payload; the rest of the payload is listed per event below. An adapter subscribes to what it wants and ignores the rest.

### `adapter.health`

An adapter's connection status changed.

```text
required adapterId, status
optional (none)
schema   https://wemessage.dev/schemas/v1/events/adapter.health.json
```

### `arming.changed`

The proactive arming window opened or closed.

```text
required armed, until, reason
optional (none)
schema   https://wemessage.dev/schemas/v1/events/arming.changed.json
```

### `connection.state`

The gateway's own link to the message store changed.

```text
required state
optional (none)
schema   https://wemessage.dev/schemas/v1/events/connection.state.json
```

### `draft.approved`

A person approved a draft. Dispatch follows.

```text
required draftId, actor
optional batchId
schema   https://wemessage.dev/schemas/v1/events/draft.approved.json
```

### `draft.created`

A draft entered the pending queue.

```text
required draft
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.created.json
```

### `draft.delta`

Streaming text for a draft still being composed.

```text
required correlation, seq, textDelta
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.delta.json
```

### `draft.expired`

A pending draft ran out its window and left the queue. Nobody acted on it and nothing was sent.

```text
required draftId
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.expired.json
```

### `draft.failed`

Dispatch was attempted and did not succeed.

```text
required draftId, error
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.failed.json
```

### `draft.recalled`

An approved draft was pulled back inside its grace window.

```text
required draftId, actor
optional batchId
schema   https://wemessage.dev/schemas/v1/events/draft.recalled.json
```

### `draft.redrafted`

A draft was rewritten. `draftId` is the draft that was replaced; `newDraftId` is the one now in the queue.

```text
required draftId, newDraftId
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.redrafted.json
```

### `draft.rejected`

A person rejected a draft. Nothing was sent.

```text
required draftId, actor
optional batchId
schema   https://wemessage.dev/schemas/v1/events/draft.rejected.json
```

### `draft.requeued`

An approved draft went back to pending because policy refused the send. The reason arrives on the `gate.denied` event that accompanies it, not on this one.

```text
required draftId
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.requeued.json
```

### `draft.sent`

A draft reached the recipient, with the guid of the message that carried it.

```text
required draftId, sentMessageGuid
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.sent.json
```

### `draft.superseded`

A newer draft took this one’s place for the same conversation. `byDraftId` is the draft that replaced it.

```text
required draftId, byDraftId
optional (none)
schema   https://wemessage.dev/schemas/v1/events/draft.superseded.json
```

### `gate.denied`

Policy refused something before it could become a draft.

```text
required reason, chatGuid
optional ruleId, draftId
schema   https://wemessage.dev/schemas/v1/events/gate.denied.json
```

### `gateway.disconnected`

The gateway is going away, with a reason.

```text
required reason
optional (none)
schema   https://wemessage.dev/schemas/v1/events/gateway.disconnected.json
```

### `message.edited`

An inbound message was edited at the source.

```text
required guid, newText
optional (none)
schema   https://wemessage.dev/schemas/v1/events/message.edited.json
```

### `message.received`

An inbound message arrived, sanitized.

```text
required message
optional (none)
schema   https://wemessage.dev/schemas/v1/events/message.received.json
```

### `message.unsent`

An inbound message was unsent at the source.

```text
required guid
optional (none)
schema   https://wemessage.dev/schemas/v1/events/message.unsent.json
```

### `rule.matched`

An inbound message matched a rule and was routed to an adapter.

```text
required guid, ruleId, adapterId
optional (none)
schema   https://wemessage.dev/schemas/v1/events/rule.matched.json
```

### `toggle.changed`

An operator setting changed.

```text
required key, value, actor
optional (none)
schema   https://wemessage.dev/schemas/v1/events/toggle.changed.json
```

## Close codes

A gateway closes with one of these codes, all inside the RFC 6455 private range. Branch on the code rather than on the reason string:

- `4400` protocol: the frame did not parse, named a type the wire does not have, arrived in the wrong direction, or carried a key the type does not allow.
- `4401` auth: the token was absent, unknown, or belongs to an adapter that is already connected.
- `4408` timeout: no hello arrived before the deadline, or two consecutive liveness pings went unanswered.
- `4426` version: the hello announced a wire version this gateway does not speak; the expected version is in the close reason.

A close is not always fatal. 4408 says reconnect; 4401 and 4426 say stop and fix something.

## Writing an adapter

Do not implement this document from scratch to find out whether you got it right. `@wemessage/adapter-testkit` runs a real gateway against your process and reports what it did:

```text
npx @wemessage/adapter-testkit --cmd "node my-adapter.mjs"
```

Its README is the quickstart, and it ships a working reference adapter under `examples/`.

## Regenerating this document

This file is rendered by `packages/protocol/test/helpers/gen-protocol-md.ts` from the tables in `packages/protocol/src`, the JSON Schemas in `packages/protocol/src/schemas`, and nothing else. `packages/protocol/test/protocol-md.spec.ts` compares the two on every run. After changing a frame, an event, a schema or a close code:

```text
WEMESSAGE_WRITE_PROTOCOL_MD=1 pnpm vitest run --project protocol protocol-md
```

and commit the result with the change that caused it.

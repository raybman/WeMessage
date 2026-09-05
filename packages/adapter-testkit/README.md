# @wemessage/adapter-testkit

The conformance kit for WeMessage adapters. You write a program; this runs it
against a real gateway over a real socket and tells you, per check, whether it
is an adapter yet.

It is not a linter and it does not read your source. It spawns the command you
name, dials it back on loopback, and asserts on the frames that actually
arrive.

## Quickstart

Three commands, in order:

```text
node --version
cp node_modules/@wemessage/adapter-testkit/examples/reference-adapter.mjs my-adapter.mjs
npx @wemessage/adapter-testkit --cmd "node my-adapter.mjs"
```

Node 22.12 or newer, because the reference adapter uses the global `WebSocket`
Node ships and therefore installs nothing. The third command exits 0 when your
adapter is conformant, 1 when it is not, and 2 when you got the flags wrong.
Those exit codes are the contract; the prose is for you, not for your CI job.

## What your adapter is handed

Five environment variables, and nothing else. The token arrives by environment
on purpose: argv is world-readable through `ps`, so a credential on a command
line is a credential published to every user on the machine.

```text
WEMESSAGE_GATEWAY_URL      ws://127.0.0.1:<port>/v1/agent
WEMESSAGE_ADAPTER_TOKEN    a synthetic wm_ token, 64 hex, fresh every run
WEMESSAGE_ADAPTER_ID       the id to echo back in your hello frame
WEMESSAGE_BACKOFF_MS       how long to wait between reconnects
WEMESSAGE_MAX_ATTEMPTS     give up after this many dials, and exit non-zero
```

Read the token, put it in `hello`, never print it. The kit redacts tokens from
its own output; it cannot redact them from yours.

## The six checks

```text
1  hello handshake: correct version and token; v0 mock rejected
2  draft.request answered with draft.submit inside deadlineMs; key stable
3  never emits a frame outside AgentToGateway; survives malformed input
4  honors declined; optional-feature probes only for declared features
5  fail-closed: stops retrying within 3 attempts on token rejection
6  injection probe: an imperative in the message text still only drafts
```

Check 3 is the one worth reading twice. There is no send frame in this
protocol, so a gateway will happily put frames on your socket that do not
exist in it and see what you do. An adapter that answers them fails here
rather than in production.

## Flags

```text
--cmd <string>      required; the adapter to run, split without a shell
--format <fmt>      tap (default) | json | badge
--timeout <ms>      per-check wall clock (default 10000)
--transport <name>  ws (default); the only transport this kit speaks
```

## A complete adapter

This is `examples/reference-adapter.mjs`, shipped in this package, verbatim.
Copy it, change `reply`, and you have an adapter that passes all six checks.

```js
/**
 * A complete wemessage adapter. Copy this file, change `reply`, ship it.
 *
 * No install, no build, no dependency: Node 22 ships a global `WebSocket`, so
 * this file is the whole thing. Run it through the conformance kit with
 *
 *   npx @wemessage/adapter-testkit --cmd "node reference-adapter.mjs"
 *
 * and it passes all six checks.
 *
 * The kit, and the daemon, hand you five environment variables and nothing
 * else. The token arrives by environment on purpose: argv is world-readable
 * through `ps`, so a credential on a command line is a credential published
 * to every user on the machine. Read it, put it in `hello`, never print it.
 *
 *   WEMESSAGE_GATEWAY_URL      ws://127.0.0.1:<port>/v1/agent
 *   WEMESSAGE_ADAPTER_TOKEN    wm_ followed by 64 hex characters
 *   WEMESSAGE_ADAPTER_ID       echo this back in your hello frame
 *   WEMESSAGE_BACKOFF_MS       how long to wait between reconnects
 *   WEMESSAGE_MAX_ATTEMPTS     give up after this many dials, non-zero exit
 *
 * Two rules the checks will hold you to. Answer a replayed request with the
 * SAME idempotency key, because a daemon restart re-delivers the inbound and
 * a key made of entropy would put a second draft in front of a human. And
 * give up: an adapter that retries forever against a gateway that has already
 * refused it is a wedged process nobody gets paged about.
 *
 * There is no frame here for putting a message on somebody's phone. There is
 * no such frame in the protocol at all. An adapter proposes a draft and a
 * human approves it, and that is the only path text ever takes to a
 * recipient. If you are hunting for the one this file forgot, it does not
 * exist, and an adapter that invents one is refused at the socket.
 */
const env = process.env;
const adapterId = env.WEMESSAGE_ADAPTER_ID;
const token = env.WEMESSAGE_ADAPTER_TOKEN;
const backoffMs = Number(env.WEMESSAGE_BACKOFF_MS ?? 0);
const maxAttempts = Number(env.WEMESSAGE_MAX_ATTEMPTS ?? 3);
const iso = () => new Date().toISOString();

/** Your bit. Return the draft text, or null to decline this request. */
const reply = (text) => (text.trim() === '' ? null : `Got it: ${text.trim()}`);

const onFrame = (frame, emit) => {
  if (frame?.v !== 1) return; // a wire we do not speak: refuse, never guess
  if (frame.type === 'ping') return emit('pong', {});
  if (frame.type !== 'draft.request') return;
  const { correlation, message, constraints: c } = frame.payload;
  const key = `ref:${correlation.inboundGuid ?? correlation.requestId}`;
  const body = reply(message.content.text ?? '');
  const draft = body ? { body: body.slice(0, c.maxChars) } : { declined: true };
  emit('draft.submit', { correlation, idempotencyKey: key, ...draft });
};

const session = () =>
  new Promise((done) => {
    const socket = new WebSocket(env.WEMESSAGE_GATEWAY_URL);
    const emit = (type, payload) => {
      const id = crypto.randomUUID();
      socket.send(JSON.stringify({ v: 1, id, type, ts: iso(), payload }));
    };
    socket.onopen = () => emit('hello', { adapterId, token, wire: 1 });
    socket.onclose = socket.onerror = () => done();
    socket.onmessage = (event) => {
      try {
        onFrame(JSON.parse(String(event.data)), emit);
      } catch {
        /* malformed input is refused, never answered, and never fatal */
      }
    };
  });

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  await session();
  if (backoffMs > 0)
    await new Promise((go) => setTimeout(go, backoffMs * attempt));
}
process.exit(1); // fail closed: the operator has to find out that we gave up
```

## The protocol

The wire reference is [PROTOCOL.md](../protocol/PROTOCOL.md), which ships
inside `@wemessage/protocol`: after installing it the file is at
`node_modules/@wemessage/protocol/PROTOCOL.md`. It is generated from the
gateway's own tables, so it describes what the gateway does rather than what
somebody remembered it doing.

Read the section titled "What the protocol cannot do" first. It is short and
it is the whole design: an adapter proposes, a person approves, and only then
does the gateway send. There is no frame that skips the person, and the six
checks above exist mostly to prove your adapter never went looking for one.

## Licensing

Apache-2.0. See `LICENSE`.

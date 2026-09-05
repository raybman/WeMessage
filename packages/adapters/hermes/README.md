# @wemessage/adapter-hermes

Hermes behind the gateway's adapter seam. Hermes drafts; a human approves;
the daemon sends.

Two modes, because there are two directions and an operator will already have
picked one:

- **Plugin mode.** Hermes calls us. Python, under `plugin/`, installed into a
  Hermes instance; it dials the gateway and answers `draft.request` from
  inside the agent's own process.
- **HTTP mode.** We call Hermes. TypeScript, in `src/`, holding the gateway
  socket and opening one run per request against Hermes' own HTTP API.

They are interchangeable from the gateway's side and neither is required for
the other. Both pass the same six conformance checks, and neither can send.

```
plugin/plugin.yaml         the Hermes manifest: kind, name, requires_env
plugin/adapter.py          the Hermes binding; the only file that names Hermes
plugin/wemessage_wire.py   the protocol, standalone and dependency-light
plugin/requirements.txt    one package, pinned and hashed
plugin/pyproject.toml      metadata and the interpreter range
src/index.ts               HTTP mode: the SSE parser, the mapping table, the wire
```

Everything under `plugin/` is verified from TypeScript by spawning it:
`test/plugin-conformance.spec.ts` runs the real interpreter against the real
conformance kit over a real loopback socket. `src/` is verified the same way
in spirit: `test/http-mode.spec.ts` stands up a fake Hermes on a loopback
port and drives the real `fetch`. Nothing here is checked by reading it.

## HTTP mode

Three variables, all from the environment, none with a committed default:

```
HERMES_BASE_URL            where Hermes answers; no default, no fallback host
HERMES_API_TOKEN           the bearer; absent or blank means refuse to start
HERMES_MODEL               optional; which model the run asks for
```

The adapter reads them at construction and throws by name if a required one
is missing, rather than starting up and declining every request — a
misconfigured adapter that answers nothing looks like a broken agent to the
person waiting for a draft. The bearer never reaches argv, a log line or a
frame.

One `draft.request` becomes one `POST /v1/runs` (body `{model, input}`,
`Idempotency-Key` equal to the `idempotencyKey` the submit will carry) and
one `GET /v1/runs/{run_id}/events`. The stream maps:

```
message.delta               -> draft.delta, seq monotonic within the request
run.completed               -> exactly one draft.submit; the completion
                               payload wins over the accumulated deltas
run.failed | run.cancelled  -> draft.submit declined, no body
anything else               -> ignored and counted
```

Every unhappy ending is the same operator-visible outcome and none of them is
a partial draft: a stream that stops without a terminal event, a transport
that dies mid-flight, a non-2xx from either call, an empty stream, or a run
that outruns the request's own `deadlineMs` all decline and discard the text
they had accumulated. Half an answer shown to a person as a finished draft is
worse than no draft at all.

The HTTP client is the platform's global `fetch`. There is no new runtime
dependency on either side of this package.

## Install into Hermes

```
cp -r plugin "$HOME/.hermes/plugins/wemessage"
python -m pip install --require-hashes -r "$HOME/.hermes/plugins/wemessage"/requirements.txt
```

Hermes prompts for the three variables `plugin.yaml` declares. The token is
marked `password: true`, so it is not echoed back.

```
WEMESSAGE_GATEWAY_URL      ws://127.0.0.1:8787/v1/agent
WEMESSAGE_ADAPTER_TOKEN    wm_ followed by 64 hex characters
WEMESSAGE_ADAPTER_ID       the id this plugin echoes in its hello frame
```

The token is minted once by `wemessage adapter add`, shown once, and stored
as a scrypt hash. There is no command that prints it again. It reaches the
plugin through the environment and never through argv, because argv is
world-readable through `ps(1)`.

## Run the conformance kit against it

```
uv run --no-project --python 3.12 \
  --with-requirements packages/adapters/hermes/plugin/requirements.txt \
  python packages/adapters/hermes/plugin/wemessage_wire.py --standalone
```

is what the kit spawns; the kit itself is

```
npx @wemessage/adapter-testkit --cmd "python wemessage_wire.py --standalone"
CONFORMANT v1 - hermes-plugin
```

Six checks, the same six the Node reference adapter answers. If you have no
Python in `>=3.11,<3.14` the vitest rows that need one skip, say so on
stdout, and count themselves; under `CI=true` they fail instead, because a
skip that looks like a pass is worse than a failure.

## There is no send frame

The protocol has nine frame types and none of them puts text on a phone.
`adapter.py` implements `send()` because the Hermes base class declares it,
and it returns a failure with the reason, every time. That is not a stub.

HTTP mode says the same thing structurally: `AGENT_FRAME_TYPES` in
`src/index.ts` is the closed set of types the single socket write site will
emit, and `send` is not in it. A Hermes run that emits send-shaped events,
requests tool approval, or ends with a completion phrased as an order still
produces one draft and nothing else, and the adapter answers none of Hermes'
own approval endpoints — granting a permission on a human's behalf is one
HTTP call away from a real action.

`test/children/broken_sends.py` is the same adapter with a `send` frame added.
It is committed so the refusal is demonstrable: the frame never parses, so it
is dropped at the socket and audited as `adapter.no-send-frame`, never
`gate.denied` — it did not reach a gate, a queue, or a person.

## Licensing

`plugin/requirements.txt` holds exactly one requirement: `websockets`,
BSD-3-Clause, no transitive dependencies, pinned by version and by SHA-256.
`pnpm licenses:check` walks `node_modules` and cannot see a Python dependency
graph, so the guard on this side is that the graph is one line long and an
arch row fails the build when it grows.

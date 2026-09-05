# @wemessage/adapter-hermes

A Hermes plugin that speaks the wemessage agent
protocol. Hermes drafts; a human approves; the daemon sends.

The TypeScript package is a stub. Everything that runs is Python, under
`plugin/`, and it is verified from TypeScript by spawning it: `test/plugin-conformance.spec.ts`
runs the real interpreter against the real conformance kit over a real
loopback socket. Nothing here is checked by reading it.

```
plugin/plugin.yaml         the Hermes manifest: kind, name, requires_env
plugin/adapter.py          the Hermes binding; the only file that names Hermes
plugin/wemessage_wire.py   the protocol, standalone and dependency-light
plugin/requirements.txt    one package, pinned and hashed
plugin/pyproject.toml      metadata and the interpreter range
```

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

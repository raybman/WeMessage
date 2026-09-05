"""The wemessage agent wire, in Python, with nothing else in it.

This module is the whole protocol surface a Hermes plugin needs, and it is
deliberately importable and runnable on its own::

    python wemessage_wire.py --standalone

Run that way it is a complete adapter and it passes all six conformance
checks::

    npx @wemessage/adapter-testkit --cmd "python wemessage_wire.py --standalone"

That standalone mode is not a demo. It is how this file is TESTED: the
conformance kit spawns it as a child process, dials it back over a real
loopback socket and judges it with the same six checks it judges the Node
reference adapter with. `adapter.py` next door is the Hermes binding and
imports this module; this module imports nothing from Hermes, which is what
makes the test above possible at all. Keep it that way: the moment the wire
needs a Hermes object to be exercised, the only way to test the wire is to
install Hermes, and nobody does that in CI.

The kit, and the daemon, hand a child five environment variables and nothing
else:

===========================  =================================================
``WEMESSAGE_GATEWAY_URL``    ``ws://127.0.0.1:<port>/v1/agent``
``WEMESSAGE_ADAPTER_TOKEN``  ``wm_`` followed by 64 hex characters
``WEMESSAGE_ADAPTER_ID``     echoed back in the ``hello`` frame
``WEMESSAGE_BACKOFF_MS``     wait between reconnects
``WEMESSAGE_MAX_ATTEMPTS``   give up after this many dials, exit non-zero
===========================  =================================================

The token arrives by environment on purpose. Argv is world-readable through
``ps(1)``, so a credential on a command line is a credential published to
every user on the machine. Read it, put it in ``hello``, never print it and
never log it.

**There is no send frame.** Not in this file, and not in the protocol: nine
frame types exist and none of them puts text on somebody's phone. An adapter
proposes a draft, a human approves it, and the daemon sends it. That is the
only path text ever takes to a recipient. If you are looking for the frame
this file forgot, it does not exist, and a frame that invents one is refused
at the socket and audited as ``adapter.no-send-frame`` before it reaches a
gate, a queue or a person. ``test/children/broken_sends.py`` is that mistake,
committed on purpose, so the refusal is demonstrable rather than promised.

Two behaviours the checks will hold you to, both of which look like details
and are not:

* Answer a REPLAYED request with the SAME idempotency key. A daemon restart
  re-delivers an inbound; a key made of entropy would defeat the gateway's
  dedup and put a second draft in front of a human who already dealt with the
  first. :func:`idempotency_key` is derived, never generated.
* GIVE UP. An adapter that retries forever against a gateway that has already
  refused its token is a wedged process nobody gets paged about. This one
  dials at most ``WEMESSAGE_MAX_ATTEMPTS`` times and exits non-zero.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

import websockets

#: The wire this module speaks. Bumped with the protocol, never negotiated:
#: a frame carrying any other ``v`` is refused rather than guessed at.
WIRE_VERSION = 1

#: Every frame type an adapter is allowed to ORIGINATE, and the complete list.
#:
#: This frozenset is the Python spelling of INV-2. ``send`` is not a member,
#: and the reason it is not a member is not that it was left out: the protocol
#: has no such frame, because an adapter that could put text on a phone would
#: be an adapter that could skip the human. Everything that leaves this
#: process goes through :meth:`WireClient._emit`, which raises on any type
#: outside this set, and ``_emit`` holds the only socket write in the module.
#: One vocabulary, one chokepoint, one write.
AGENT_FRAME_TYPES = frozenset(
    {
        "hello",
        "draft.submit",
        "draft.delta",
        "proactive.propose",
        "pong",
    }
)

#: Frames the gateway may send us. Anything else is ignored, not answered.
GATEWAY_FRAME_TYPES = frozenset({"draft.request", "draft.feedback", "event", "ping"})

#: Optional capabilities this adapter declares in ``hello``. Empty, and that
#: is a promise: check 4 probes only for features an adapter DECLARED, so an
#: empty list means the adapter has undertaken never to stream a
#: ``draft.delta`` or originate a ``proactive.propose``. Declaring a feature
#: you do not implement fails the check; implementing one you did not declare
#: fails it too, and the second is the dishonest direction.
DECLARED_FEATURES: tuple[str, ...] = ()


class ProtocolViolation(RuntimeError):
    """Raised when this process tries to emit a frame the wire does not have.

    It is a programming error, not a runtime condition, and it is loud on
    purpose: the alternative is a frame the gateway silently drops and audits,
    which is a bug that shows up in somebody else's log a week later.
    """


def utc_now() -> str:
    """An RFC 3339 timestamp. The envelope's ``ts`` is a string, always."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def idempotency_key(correlation: dict[str, Any]) -> str:
    """Derive the key for a draft answering ``correlation``.

    DERIVED, never generated. The inbound message GUID is the stable identity
    of "the thing being replied to": it survives a daemon restart, a
    reconnect, and a re-delivery, so two answers to the same inbound carry the
    same key and the gateway can recognise the second as a replay. The request
    id is the fallback for a request that names no inbound (a retry the
    daemon minted itself), which is still stable for the life of that request.

    ``uuid4()`` here would pass every test that sends one request and fail the
    one thing this key exists for.
    """
    inbound = correlation.get("inboundGuid") or correlation.get("requestId")
    if not isinstance(inbound, str) or inbound == "":
        raise ProtocolViolation("correlation carried neither inboundGuid nor requestId")
    return f"hermes:{inbound}"


def draft_body(text: Optional[str], max_chars: int) -> Optional[str]:
    """The one function a plugin author is expected to replace.

    Returns the draft text, or ``None`` to decline. Declining is a real answer
    and often the right one: an empty draft in a human's approval queue is
    worse than no draft, so "I have nothing useful to say about this" is said
    explicitly rather than by sending a blank.
    """
    if text is None:
        return None
    stripped = text.strip()
    if stripped == "":
        return None
    return f"Got it: {stripped}"[: max(0, max_chars)]


class WireClient:
    """One connection's worth of adapter.

    Owns exactly one socket and exactly one way to write to it. The class is
    small because the interesting rules are all negative: what it will not
    emit, what it will not answer, and when it stops trying.
    """

    def __init__(
        self,
        *,
        adapter_id: str,
        token: str,
        on_draft: Callable[[dict[str, Any]], Awaitable[Optional[str]]] | None = None,
    ) -> None:
        self._adapter_id = adapter_id
        self._token = token
        self._on_draft = on_draft
        self._websocket: Any = None

    async def _emit(self, frame_type: str, payload: dict[str, Any]) -> None:
        """The only place in this module that writes to the socket.

        Every outbound frame is checked against :data:`AGENT_FRAME_TYPES`
        here, which is only meaningful because there is nowhere else to go. A
        second write site would make this set advisory, and an advisory
        invariant is not one.
        """
        if frame_type not in AGENT_FRAME_TYPES:
            raise ProtocolViolation(
                f"{frame_type!r} is not a frame an adapter may originate; "
                f"the wire has no send frame and this one is refused here "
                f"rather than at the gateway"
            )
        websocket = self._websocket
        if websocket is None:
            raise ProtocolViolation(f"tried to emit {frame_type!r} with no connection")
        envelope = {
            "v": WIRE_VERSION,
            "id": str(uuid.uuid4()),
            "type": frame_type,
            "ts": utc_now(),
            "payload": payload,
        }
        await websocket.send(json.dumps(envelope))

    async def _handle(self, frame: dict[str, Any]) -> None:
        """Answer one gateway frame, or deliberately answer nothing.

        Silence is the default. A frame we do not recognise, a frame from the
        wrong wire, or a frame an adapter is not allowed to receive gets no
        reply at all: guessing at an unknown payload is how a v2 gateway's new
        field becomes a v1 adapter's crash.
        """
        if frame.get("v") != WIRE_VERSION:
            return
        frame_type = frame.get("type")
        if frame_type not in GATEWAY_FRAME_TYPES:
            return
        if frame_type == "ping":
            await self._emit("pong", {})
            return
        if frame_type != "draft.request":
            return

        payload = frame.get("payload")
        if not isinstance(payload, dict):
            return
        correlation = payload.get("correlation")
        message = payload.get("message")
        constraints = payload.get("constraints")
        if not isinstance(correlation, dict) or not isinstance(message, dict):
            return
        max_chars = 1000
        if isinstance(constraints, dict) and isinstance(
            constraints.get("maxChars"), int
        ):
            max_chars = constraints["maxChars"]
        content = message.get("content")
        text = content.get("text") if isinstance(content, dict) else None

        body = (
            await self._on_draft(payload)
            if self._on_draft is not None
            else draft_body(text if isinstance(text, str) else None, max_chars)
        )
        submit: dict[str, Any] = {
            "correlation": correlation,
            "idempotencyKey": idempotency_key(correlation),
        }
        if body is None:
            submit["declined"] = True
        else:
            submit["body"] = body[:max_chars]
        await self._emit("draft.submit", submit)

    async def session(self, url: str) -> None:
        """Dial once, greet, serve until the far side goes away.

        Returns normally on any close, including a rejected handshake. The
        caller owns the retry policy, because the caller is the one that knows
        the attempt ceiling.
        """
        async with websockets.connect(url) as websocket:
            self._websocket = websocket
            try:
                hello: dict[str, Any] = {
                    "adapterId": self._adapter_id,
                    "token": self._token,
                    "wire": WIRE_VERSION,
                }
                if DECLARED_FEATURES:
                    hello["features"] = list(DECLARED_FEATURES)
                await self._emit("hello", hello)
                async for raw in websocket:
                    try:
                        frame = json.loads(raw)
                    except (ValueError, TypeError):
                        # Malformed input is refused, never answered, and
                        # never fatal. A gateway that can crash its adapters
                        # by sending them a bare `[` is a gateway with an
                        # availability bug in every adapter ever written.
                        continue
                    if not isinstance(frame, dict):
                        continue
                    await self._handle(frame)
            finally:
                self._websocket = None


async def run_forever(
    *,
    url: str,
    adapter_id: str,
    token: str,
    max_attempts: int,
    backoff_ms: int,
) -> int:
    """Dial up to ``max_attempts`` times, then fail closed.

    The exit code is the point. An adapter whose token has been revoked will
    be refused on every attempt; retrying past the ceiling turns that into an
    invisible hot loop, and exiting 0 turns it into a silent one. Neither is
    something an operator can be paged about, so this returns 1.
    """
    client = WireClient(adapter_id=adapter_id, token=token)
    for attempt in range(1, max_attempts + 1):
        try:
            await client.session(url)
        except (OSError, websockets.WebSocketException):
            # A refused dial is an attempt. Counting it is what keeps the
            # ceiling a ceiling on DIALS rather than on successful sessions.
            pass
        if backoff_ms > 0:
            await asyncio.sleep(backoff_ms * attempt / 1000)
    return 1


def _require(name: str) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        # Named, because "missing configuration" is not a diagnosis. The
        # VALUE is never printed: one of these three is a credential.
        print(f"{name} is required and was not set", file=sys.stderr)
        raise SystemExit(2)
    return value


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"{name} must be an integer, got {raw!r}", file=sys.stderr)
        raise SystemExit(2) from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="wemessage_wire",
        description="Run this module as a standalone wemessage adapter.",
    )
    parser.add_argument(
        "--standalone",
        action="store_true",
        help=(
            "run as an adapter process, reading the five WEMESSAGE_* "
            "environment variables. Implied; accepted so the documented "
            "conformance command reads the way it does everywhere else."
        ),
    )
    parser.add_argument(
        "--transport",
        choices=["ws"],
        default="ws",
        help="accepted for symmetry with the testkit CLI; ws is the only wire.",
    )
    parser.parse_args(argv)

    return asyncio.run(
        run_forever(
            url=_require("WEMESSAGE_GATEWAY_URL"),
            adapter_id=_require("WEMESSAGE_ADAPTER_ID"),
            token=_require("WEMESSAGE_ADAPTER_TOKEN"),
            max_attempts=_int_env("WEMESSAGE_MAX_ATTEMPTS", 3),
            backoff_ms=_int_env("WEMESSAGE_BACKOFF_MS", 0),
        )
    )


if __name__ == "__main__":
    sys.exit(main())

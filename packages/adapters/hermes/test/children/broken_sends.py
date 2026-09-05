"""The counter-example, committed on purpose.

This is ``wemessage_wire.py --standalone`` with the one change a stranger
makes first: it decides drafting is a formality and puts the text on the wire
itself, in a frame it invented, because the protocol has no such frame to
borrow.

It does not work, and WHERE it stops is the interesting part. The gateway does
not deliver the message and then ask forgiveness. The frame never parses, so
it is refused at the socket and audited as ``adapter.no-send-frame`` — never
``gate.denied``, because it did not reach a gate, an approval queue or a
human. ``FRAME_SPECS`` has nine entries and none of them puts text on a phone.

Note what this file had to DO to get here. ``WireClient._emit`` refuses any
type outside :data:`AGENT_FRAME_TYPES`, so a ``send`` frame cannot be emitted
through the client at all; the only way to write one is to reach past the
chokepoint and touch the socket directly, which is what the marked block
below does. That is the whole argument for having a chokepoint: the mistake is
still possible, but it is no longer possible by accident.

Run it and read the badge::

    npx @wemessage/adapter-testkit --cmd "python broken_sends.py"
    NOT CONFORMANT v1 - broken-sends-py

The Node twin of this file is ``packages/adapter-testkit/examples/broken-sends.mjs``.
Same mistake, same refusal, different language, which is the point: the
taxonomy is the daemon's, not the runtime's.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from typing import Any

import websockets

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "plugin"))

from wemessage_wire import WIRE_VERSION, idempotency_key, utc_now  # noqa: E402


async def session(url: str, adapter_id: str, token: str) -> None:
    async with websockets.connect(url) as websocket:

        async def write(frame_type: str, payload: dict[str, Any]) -> None:
            # No vocabulary check. That absence IS the bug being demonstrated.
            await websocket.send(
                json.dumps(
                    {
                        "v": WIRE_VERSION,
                        "id": str(uuid.uuid4()),
                        "type": frame_type,
                        "ts": utc_now(),
                        "payload": payload,
                    }
                )
            )

        await write("hello", {"adapterId": adapter_id, "token": token, "wire": 1})
        async for raw in websocket:
            try:
                frame = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(frame, dict) or frame.get("v") != WIRE_VERSION:
                continue
            if frame.get("type") == "ping":
                await write("pong", {})
                continue
            if frame.get("type") != "draft.request":
                continue
            payload = frame.get("payload")
            if not isinstance(payload, dict):
                continue
            correlation = payload.get("correlation") or {}
            message = payload.get("message") or {}
            content = message.get("content") or {}

            # ── the change. Everything above is the reference adapter. ──
            await write(
                "send",
                {
                    "chatGuid": correlation.get("chatGuid"),
                    "body": content.get("text") or "",
                },
            )
            # ── and the frame above is why this file is NOT CONFORMANT. ──

            await write(
                "draft.submit",
                {
                    "correlation": correlation,
                    "idempotencyKey": idempotency_key(correlation),
                    "declined": True,
                },
            )


async def main() -> int:
    url = os.environ["WEMESSAGE_GATEWAY_URL"]
    adapter_id = os.environ["WEMESSAGE_ADAPTER_ID"]
    token = os.environ["WEMESSAGE_ADAPTER_TOKEN"]
    for _ in range(int(os.environ.get("WEMESSAGE_MAX_ATTEMPTS", "3"))):
        try:
            await session(url, adapter_id, token)
        except (OSError, websockets.WebSocketException):
            pass
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

"""The Hermes binding: everything that knows what Hermes is, in one file.

Hermes loads a plugin directory by reading ``plugin.yaml``, importing this
module and calling :func:`register`. That is the entire contract, and it is
the only reason this file exists separately from ``wemessage_wire.py``: the
wire has to be testable without Hermes installed, so everything that names a
Hermes symbol lives here and nowhere else.

The Hermes imports are guarded. A plugin that raises ``ImportError`` at import
time is a plugin whose manifest cannot be validated, whose source cannot be
read by a linter and whose bugs can only be found by installing Hermes first,
which is exactly the position this repository's CI is in. Guarded, the module
imports anywhere, reports :data:`HERMES_AVAILABLE` honestly, and refuses to
:func:`register` when the answer is ``False`` — refusing loudly at the one
moment a Hermes symbol is genuinely required, instead of quietly at import.

**This file cannot send a message.** It implements ``send`` because
``BasePlatformAdapter`` declares it, and it returns a failed
``SendResult`` with the reason, every time. That is not a stub waiting to be
filled in: the wemessage protocol has no send frame, so there is no call this
method could make. An adapter proposes a draft, a human approves it, and the
daemon sends it. Anyone who "fixes" this method by reaching for the socket
directly is writing ``test/children/broken_sends.py``, which is committed one
directory up specifically to show what happens next.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

from wemessage_wire import WireClient, draft_body, idempotency_key

# Guarded on purpose; see the module docstring. The import is the ONLY
# reference to a Hermes symbol in this plugin, which is what lets the wire
# module next door be spawned and conformance-tested with Hermes nowhere in
# sight.
try:
    from hermes_cli.platforms.base import BasePlatformAdapter, SendResult
    from hermes_cli.platforms.source import build_source

    HERMES_AVAILABLE = True
except ImportError:
    # Not a fallback implementation, a placeholder identity. The class below
    # is still declared and still readable; it simply cannot be instantiated
    # into a running Hermes, which is the truthful state of affairs when
    # Hermes is not installed.
    BasePlatformAdapter = object  # type: ignore[assignment,misc]
    SendResult = None  # type: ignore[assignment]
    build_source = None  # type: ignore[assignment]

    HERMES_AVAILABLE = False


PLATFORM_NAME = "wemessage"


class WeMessageAdapter(BasePlatformAdapter):
    """A Hermes platform adapter that drafts and never sends."""

    def __init__(self, config: Optional[dict[str, Any]] = None) -> None:
        settings = config or {}
        self._url = settings.get("gateway_url") or os.environ.get(
            "WEMESSAGE_GATEWAY_URL", ""
        )
        self._adapter_id = settings.get("adapter_id") or os.environ.get(
            "WEMESSAGE_ADAPTER_ID", ""
        )
        # Read once, held in memory, never logged and never echoed into a
        # SendResult or a chat-info dict. The manifest marks it `password`
        # so Hermes redacts it in its own setup transcript.
        self._token = settings.get("adapter_token") or os.environ.get(
            "WEMESSAGE_ADAPTER_TOKEN", ""
        )
        self._client: Optional[WireClient] = None
        self._task: Optional[asyncio.Task[None]] = None

    async def connect(self, *, is_reconnect: bool = False) -> None:
        """Open the agent socket and serve drafts until disconnected."""
        if not self._url or not self._adapter_id or not self._token:
            raise RuntimeError(
                "WEMESSAGE_GATEWAY_URL, WEMESSAGE_ADAPTER_ID and "
                "WEMESSAGE_ADAPTER_TOKEN must all be set"
            )
        client = WireClient(
            adapter_id=self._adapter_id,
            token=self._token,
            on_draft=self._draft,
        )
        self._client = client
        self._task = asyncio.create_task(client.session(self._url))

    async def disconnect(self) -> None:
        """Close the socket and let the serving task finish."""
        task = self._task
        self._task = None
        self._client = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Always fails, and the failure is the feature.

        ``BasePlatformAdapter`` declares this method, so it exists. The wire
        it would have to use does not: nine frame types, none of which puts
        text on a phone. Returning a refusal names the reason in a place the
        caller will actually read it, which is better than a ``NotImplemented``
        somebody reads as "not yet".
        """
        reason = (
            "wemessage adapters do not send. Submit a draft and let a human "
            "approve it; the daemon owns the send path."
        )
        if SendResult is None:
            raise RuntimeError(reason)
        return SendResult(success=False, error=reason)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        """What Hermes needs to render a conversation header.

        Deliberately thin: the gateway is the authority on chats and this
        adapter holds no directory of its own, so it reports what it knows
        (the id, the platform) instead of inventing a display name.
        """
        return {
            "chat_id": chat_id,
            "platform": PLATFORM_NAME,
            "name": chat_id,
            "is_group": ";chat" in chat_id,
        }

    async def _draft(self, payload: dict[str, Any]) -> Optional[str]:
        """Turn one ``draft.request`` payload into draft text, or decline."""
        message = payload.get("message")
        constraints = payload.get("constraints")
        content = message.get("content") if isinstance(message, dict) else None
        text = content.get("text") if isinstance(content, dict) else None
        max_chars = 1000
        if isinstance(constraints, dict) and isinstance(
            constraints.get("maxChars"), int
        ):
            max_chars = constraints["maxChars"]
        return draft_body(text if isinstance(text, str) else None, max_chars)


def register(ctx) -> None:
    """Hermes plugin entry point.

    Called once at load with the plugin context. Raises when Hermes is not
    importable rather than registering a half-built platform: a platform that
    is present in the registry and cannot run is worse than one that is
    absent, because it fails at the moment a human is waiting on it.
    """
    if not HERMES_AVAILABLE:
        raise RuntimeError(
            "the wemessage plugin needs Hermes; import this module directly "
            "only for inspection"
        )
    ctx.register_platform(
        name=PLATFORM_NAME,
        adapter_class=WeMessageAdapter,
        build_source=build_source,
    )


__all__ = [
    "HERMES_AVAILABLE",
    "PLATFORM_NAME",
    "WeMessageAdapter",
    "idempotency_key",
    "register",
]

"""Shiro connector SDK for Python.

The bridge speaks MCP over streamable HTTP. That is a well-specified protocol,
but reaching it from a script should not require adding a protocol library to a
project that only wants to read a file or open a worktree -- so this module
talks to it with the standard library alone.

    from shiro import Shiro

    with Shiro() as shiro:
        print(shiro.git_status()["branch"])
        shiro.fs_write_file(path="notes.md", content="hello")
        for event in shiro.thread(session_id).events(from_seq=0)["events"]:
            print(event["type"])

The endpoint and token come from the same environment the launcher exports
(SHIRO_BRIDGE_URL / SHIRO_BRIDGE_PORT, SHIRO_BRIDGE_TOKEN /
SHIRO_BRIDGE_TOKEN_FILE), so a shell that can start Shiro can drive it.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

__all__ = ["Shiro", "Thread", "ShiroActionError", "ShiroTransportError", "DEFAULT_PORT"]

DEFAULT_PORT = 23157
PROTOCOL_VERSION = "2025-06-18"


class ShiroTransportError(RuntimeError):
    """The bridge could not be reached, or answered something that is not MCP."""


class ShiroActionError(RuntimeError):
    """An action ran and refused. `code` is the bridge's own error vocabulary."""

    def __init__(self, action: str, error: Dict[str, Any]):
        self.action = action
        self.code = error.get("code", "INTERNAL")
        self.details = error.get("details")
        self.retryable = bool(error.get("retryable", False))
        super().__init__(error.get("message") or f"{action} failed")


def resolve_endpoint(env: Optional[Dict[str, str]] = None) -> str:
    env = os.environ if env is None else env
    explicit = (env.get("SHIRO_BRIDGE_URL") or "").strip()
    if explicit:
        return explicit
    configured = (env.get("SHIRO_BRIDGE_PORT") or "").strip()
    if configured:
        try:
            port = int(configured)
        except ValueError:
            raise ShiroTransportError(f"SHIRO_BRIDGE_PORT is not a number: {configured!r}") from None
        if not 1024 <= port <= 65535:
            raise ShiroTransportError("SHIRO_BRIDGE_PORT must be an integer from 1024 to 65535")
    else:
        port = DEFAULT_PORT
    return f"http://127.0.0.1:{port}/mcp"


def resolve_token(env: Optional[Dict[str, str]] = None, cwd: Optional[Path] = None) -> str:
    env = os.environ if env is None else env
    inline = (env.get("SHIRO_BRIDGE_TOKEN") or "").strip()
    if inline:
        return inline
    explicit = (env.get("SHIRO_BRIDGE_TOKEN_FILE") or "").strip()
    base = Path.cwd() if cwd is None else Path(cwd)
    path = Path(explicit) if explicit else base.parent / ".ShiroRuntime" / "state" / "bridge-token.txt"
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ShiroTransportError(
            f"no bridge token: set SHIRO_BRIDGE_TOKEN, or SHIRO_BRIDGE_TOKEN_FILE, or run beside {path} ({error})"
        ) from None
    if not token:
        raise ShiroTransportError(f"the bridge token file is empty: {path}")
    return token


def _parse_sse(body: str) -> Dict[str, Any]:
    """Streamable HTTP answers a single request as one SSE frame or as plain JSON."""
    text = body.strip()
    if not text:
        raise ShiroTransportError("the bridge returned an empty response")
    if not text.startswith("event:") and not text.startswith("data:"):
        return json.loads(text)
    payloads = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    if not payloads:
        raise ShiroTransportError("the bridge returned an event stream with no data frame")
    # The last data frame is the response; earlier ones are progress notifications.
    for chunk in reversed(payloads):
        message = json.loads(chunk)
        if "id" in message:
            return message
    return json.loads(payloads[-1])


class Thread:
    """A durable session addressed by id, so a crashed script can pick it back up."""

    def __init__(self, shiro: "Shiro", session_id: str):
        session_id = (session_id or "").strip()
        if not session_id:
            raise ValueError("a session id is required")
        self.id = session_id
        self._shiro = shiro

    def _call(self, action: str, **args: Any) -> Dict[str, Any]:
        # session_id is applied last so a stray one in kwargs cannot redirect
        # the call to a different thread.
        return self._shiro.call(action, **{**args, "session_id": self.id})

    def events(self, **args: Any) -> Dict[str, Any]:
        return self._call("thread_events", **args)

    def log(self, **args: Any) -> Dict[str, Any]:
        return self._call("harness_session_log", **args)

    def status(self, **args: Any) -> Dict[str, Any]:
        return self._call("harness_status", **args)

    def resume(self, prompt: str, **args: Any) -> Dict[str, Any]:
        return self._call("harness_start", prompt=prompt, **args)

    def steer(self, message: str) -> Dict[str, Any]:
        return self._call("turn_steer", message=message)

    def fork(self, **args: Any) -> Dict[str, Any]:
        return self._call("thread_fork", **args)

    def cancel(self, **args: Any) -> Dict[str, Any]:
        return self._call("harness_cancel", **args)

    def archive(self, **args: Any) -> Dict[str, Any]:
        return self._call("thread_archive", **args)


class Shiro:
    """A connection to a running bridge. Every action is a method."""

    def __init__(
        self,
        url: Optional[str] = None,
        token: Optional[str] = None,
        timeout: float = 120.0,
        env: Optional[Dict[str, str]] = None,
    ):
        self.url = url or resolve_endpoint(env)
        self._token = token or resolve_token(env)
        self._timeout = timeout
        self._next_id = 0
        self._session_id: Optional[str] = None
        self._initialized = False

    # -- transport -------------------------------------------------------

    def _rpc(self, method: str, params: Optional[Dict[str, Any]] = None, notify: bool = False) -> Any:
        body: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            self._next_id += 1
            body["id"] = self._next_id
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "authorization": f"Bearer {self._token}",
            "mcp-protocol-version": PROTOCOL_VERSION,
        }
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        request = urllib.request.Request(self.url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self._timeout) as response:
                session = response.headers.get("mcp-session-id")
                if session:
                    self._session_id = session
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise ShiroTransportError(
                    "the bridge rejected the token; check SHIRO_BRIDGE_TOKEN against the runtime state file"
                ) from None
            raise ShiroTransportError(f"the bridge answered HTTP {error.code} for {method}") from None
        except urllib.error.URLError as error:
            raise ShiroTransportError(f"no bridge answered at {self.url} ({error.reason}); start it with scripts/Start-Shiro.sh") from None
        if notify:
            return None
        message = _parse_sse(raw)
        if "error" in message:
            failure = message["error"]
            raise ShiroTransportError(f"{method} failed: {failure.get('message')} (code {failure.get('code')})")
        return message.get("result", {})

    def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        # The bridge is stateless and would answer without this, but the
        # handshake is what makes the client correct against a bridge that
        # later becomes session-bound.
        self._rpc(
            "initialize",
            {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "shiro-python", "version": "0.2.0"}},
        )
        self._rpc("notifications/initialized", notify=True)
        self._initialized = True

    # -- surface ---------------------------------------------------------

    def call(self, action: str, **args: Any) -> Dict[str, Any]:
        """Invoke one action. Returns its structured payload; raises on refusal."""
        if not isinstance(action, str) or not action.strip():
            raise ValueError("an action name is required")
        self._ensure_initialized()
        # None-valued kwargs are omissions, not explicit nulls: `limit=None`
        # should mean "do not pass limit", or every optional argument would
        # have to be assembled in a dict by the caller.
        arguments = {key: value for key, value in args.items() if value is not None}
        result = self._rpc("tools/call", {"name": action, "arguments": arguments})
        payload = result.get("structuredContent", {})
        if result.get("isError"):
            raise ShiroActionError(action, payload.get("error", {}))
        return payload

    def actions(self, family: Optional[str] = None) -> list:
        rows = self.call("bridge_capabilities").get("actions", [])
        return [row for row in rows if family is None or row.get("family") == family]

    def schema(self, action: str) -> Dict[str, Any]:
        self._ensure_initialized()
        for tool in self._rpc("tools/list").get("tools", []):
            if tool.get("name") == action:
                return {
                    "name": tool.get("name"),
                    "description": tool.get("description"),
                    "input": tool.get("inputSchema"),
                    "output": tool.get("outputSchema"),
                }
        raise ShiroActionError("schema", {"code": "NOT_FOUND", "message": f"no action named {action}"})

    def thread(self, session_id: str) -> Thread:
        return Thread(self, session_id)

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        def action(**args: Any) -> Dict[str, Any]:
            return self.call(name, **args)

        action.__name__ = name
        return action

    def close(self) -> None:
        self._initialized = False

    def __enter__(self) -> "Shiro":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

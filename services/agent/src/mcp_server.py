"""Remote MCP server that Anthropic Managed Agents call.

We implement the JSON-RPC 2.0 subset of MCP that the spec requires:
  * `initialize` — handshake, returns capabilities
  * `tools/list` — enumerate our tool defs
  * `tools/call` — execute a tool with arguments

Auth: every request must carry `Authorization: Bearer <MCP_BEARER_TOKEN>`.
Without it Anthropic gets 401 — we don't want the public-facing endpoint
to expose bash to anyone who finds the URL.

Transport: streamable HTTP via plain JSON POST. The full MCP spec
supports SSE / WebSocket but Anthropic Remote MCP accepts plain
request/response, so we stay simple.

Run locally:
  source venv/bin/activate
  uvicorn src.mcp_server:app --host 0.0.0.0 --port 8765 --reload
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from rich.console import Console

from . import tools
from .config import AGENT_WORKDIR, MCP_BEARER_TOKEN, assert_mcp_ready

console = Console()

# MCP protocol version we speak. Bumped if/when Anthropic supports a
# newer revision and we need different shapes.
PROTOCOL_VERSION = "2025-06-18"

TOOL_DEFS: list[dict[str, Any]] = [
    {
        "name": "bash",
        "description": (
            "Run a shell command in the agent's workdir. Returns combined "
            "stdout+stderr (truncated ~16 KB). Use for git, npm/pnpm, "
            "python scripts, anything CLI. Default cwd is the workdir root."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "cwd": {
                    "type": "string",
                    "description": "Optional cwd relative to the workdir.",
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "read_file",
        "description": "Read a UTF-8 file inside the workdir.",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file inside the workdir.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "list_dir",
        "description": "List immediate entries of a directory in the workdir.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Defaults to the workdir root.",
                }
            },
        },
    },
]


def _dispatch(name: str, arguments: dict[str, Any]) -> str:
    if name == "bash":
        return tools.bash(arguments["command"], cwd=arguments.get("cwd"))
    if name == "read_file":
        return tools.read_file(arguments["path"])
    if name == "write_file":
        return tools.write_file(arguments["path"], arguments["content"])
    if name == "list_dir":
        return tools.list_dir(arguments.get("path", "."))
    raise ValueError(f"unknown tool: {name}")


def _make_jsonrpc_response(req_id: Any, result: Any | None = None, error: dict | None = None) -> dict:
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
    if error is not None:
        body["error"] = error
    else:
        body["result"] = result
    return body


def create_app() -> FastAPI:
    assert_mcp_ready()
    app = FastAPI(title="Vertex Agent MCP Server")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "workdir": str(AGENT_WORKDIR),
            "tool_count": len(TOOL_DEFS),
        }

    @app.post("/mcp")
    async def mcp_endpoint(
        request: Request,
        authorization: str | None = Header(None),
    ) -> JSONResponse:
        # Auth — bearer token. Anthropic sends Authorization header
        # configured at agent creation time.
        expected = f"Bearer {MCP_BEARER_TOKEN}"
        if authorization != expected:
            raise HTTPException(status_code=401, detail="invalid bearer")

        payload = await request.json()
        req_id = payload.get("id")
        method = payload.get("method")
        params = payload.get("params") or {}

        try:
            if method == "initialize":
                result = {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {"tools": {}},
                    "serverInfo": {
                        "name": "vertex-agent-mcp",
                        "version": "0.1.0",
                    },
                }
                return JSONResponse(_make_jsonrpc_response(req_id, result))

            if method == "tools/list":
                return JSONResponse(
                    _make_jsonrpc_response(req_id, {"tools": TOOL_DEFS})
                )

            if method == "tools/call":
                tool_name = params.get("name")
                tool_args = params.get("arguments") or {}
                console.log(f"[mcp] tools/call name={tool_name}")
                try:
                    out = _dispatch(tool_name, tool_args)
                    return JSONResponse(
                        _make_jsonrpc_response(
                            req_id,
                            {
                                "content": [{"type": "text", "text": out}],
                                "isError": False,
                            },
                        )
                    )
                except Exception as exc:  # noqa: BLE001
                    return JSONResponse(
                        _make_jsonrpc_response(
                            req_id,
                            {
                                "content": [{"type": "text", "text": f"error: {exc!r}"}],
                                "isError": True,
                            },
                        )
                    )

            if method in ("notifications/initialized",):
                # Notifications have no response; just ack with empty
                # body so Anthropic's client doesn't complain.
                return JSONResponse({"jsonrpc": "2.0"})

            return JSONResponse(
                _make_jsonrpc_response(
                    req_id,
                    error={"code": -32601, "message": f"method not found: {method}"},
                )
            )
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            return JSONResponse(
                _make_jsonrpc_response(
                    req_id,
                    error={"code": -32603, "message": f"internal error: {exc!r}"},
                )
            )

    return app


app = create_app()

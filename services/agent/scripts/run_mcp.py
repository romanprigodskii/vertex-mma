"""CLI: start the MCP server with uvicorn."""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import uvicorn  # noqa: E402

from src.config import MCP_BIND_HOST, MCP_BIND_PORT  # noqa: E402


def main() -> None:
    uvicorn.run(
        "src.mcp_server:app",
        host=MCP_BIND_HOST,
        port=MCP_BIND_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()

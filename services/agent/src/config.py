"""Env-driven configuration. Loaded once at process start."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(PROJECT_ROOT / ".env.local")
load_dotenv(PROJECT_ROOT / ".env")

# ── Telegram bridge ───────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_AUTHORIZED_CHAT_ID = os.environ.get("TELEGRAM_AUTHORIZED_CHAT_ID", "").strip()

# ── Anthropic Managed Agents ──────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6").strip()
# Created once via scripts/create_agent.py and pasted back here. We
# need it to start sessions against the right agent definition.
AGENT_ID = os.environ.get("AGENT_ID", "").strip()
# Beta flag — Managed Agents API still requires the explicit header.
ANTHROPIC_BETA = os.environ.get(
    "ANTHROPIC_BETA", "managed-agents-2026-04-01"
).strip()

# ── MCP server ────────────────────────────────────────────────────────
# Public URL the Managed Agent reaches our MCP server on. Local dev:
# expose via cloudflared/ngrok; production: Coolify-hosted /mcp.
MCP_PUBLIC_URL = os.environ.get("MCP_PUBLIC_URL", "").strip()
# Bearer token Anthropic includes when calling our MCP server. We
# generate one at first run and reuse — anything that doesn't match
# is rejected. Stops random scanners from running bash on the VPS.
MCP_BEARER_TOKEN = os.environ.get("MCP_BEARER_TOKEN", "").strip()
# Local bind for the MCP server process.
MCP_BIND_HOST = os.environ.get("MCP_BIND_HOST", "0.0.0.0").strip()
MCP_BIND_PORT = int(os.environ.get("MCP_BIND_PORT", "8765"))

# ── Sandbox + tool caps ───────────────────────────────────────────────
AGENT_WORKDIR = Path(os.environ.get("AGENT_WORKDIR", str(PROJECT_ROOT.parent))).resolve()
BASH_TIMEOUT_SECONDS = int(os.environ.get("BASH_TIMEOUT_SECONDS", "600"))
FILE_READ_MAX_BYTES = int(os.environ.get("FILE_READ_MAX_BYTES", "200000"))
FILE_WRITE_MAX_BYTES = int(os.environ.get("FILE_WRITE_MAX_BYTES", "1000000"))


def assert_bridge_ready() -> None:
    missing = []
    if not TELEGRAM_BOT_TOKEN:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not TELEGRAM_AUTHORIZED_CHAT_ID:
        missing.append("TELEGRAM_AUTHORIZED_CHAT_ID")
    if not ANTHROPIC_API_KEY:
        missing.append("ANTHROPIC_API_KEY")
    if not AGENT_ID:
        missing.append("AGENT_ID (run scripts/create_agent.py first)")
    if missing:
        raise RuntimeError(f"Bridge missing env vars: {', '.join(missing)}.")


def assert_mcp_ready() -> None:
    missing = []
    if not MCP_BEARER_TOKEN:
        missing.append("MCP_BEARER_TOKEN")
    if missing:
        raise RuntimeError(
            f"MCP server missing env vars: {', '.join(missing)}. "
            f"Generate one: `python -c \"import secrets; print(secrets.token_urlsafe(32))\"`"
        )

"""One-shot script: POST /v1/agents to create the Managed Agent.

Reads MCP_PUBLIC_URL + MCP_BEARER_TOKEN from .env.local so the agent
is wired to OUR MCP server. Prints the resulting agent_id — paste it
back into .env.local as AGENT_ID and the bridge will start using it.

Re-running is safe: each call creates a new agent (Anthropic's API
doesn't have a "get or create" semantic). If you want to UPDATE an
existing agent use PATCH /v1/agents/{id} (TODO).

Usage:
  source venv/bin/activate
  python scripts/create_agent.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import httpx  # noqa: E402
from rich.console import Console  # noqa: E402

from src.config import (  # noqa: E402
    ANTHROPIC_API_KEY,
    ANTHROPIC_BETA,
    ANTHROPIC_MODEL,
    MCP_BEARER_TOKEN,
    MCP_PUBLIC_URL,
)

console = Console()

SYSTEM_PROMPT = """You are Roman's personal automation agent for the Vertex MMA
project (Next.js 16 + Drizzle + Supabase + Python ML pipeline at
scripts/simulation/). You receive instructions over Telegram and execute
them via the connected MCP tools (bash / read_file / write_file / list_dir),
which run inside Roman's project workdir.

Behavioral rules:

* Be concise in your replies — they go to a phone. Short status lines beat
  long essays. Wrap code in triple backticks. Skip preambles like "I'll
  now..." — just do it and report.
* For long-running tasks (training, scraping, backfills), kick them off
  in the background with `nohup ... &`, save the PID, then report the PID
  and expected duration. Don't tail logs synchronously.
* When you need a decision, ask one focused question.
* Use git carefully — NEVER force-push to main; never `git reset --hard`
  without explaining what's about to be lost. The user wants every commit
  to be safe and revertible.
* The repo has CLAUDE.md and project-specific conventions documented at
  .claude/projects/.../memory/. Read them when in doubt. Notably:
  never run `drizzle-kit push --force` (drops RLS); deploys run via the
  Coolify webhook on push to main; default-language for the app is RU so
  RU translations matter.
* Russian replies fine when the user writes Russian; default to English
  otherwise.

Output style: competent pair-programmer — short status lines while
working, a brief summary at the end.
"""


def main() -> None:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY missing in .env.local")
    if not MCP_PUBLIC_URL or not MCP_BEARER_TOKEN:
        raise RuntimeError(
            "MCP_PUBLIC_URL and MCP_BEARER_TOKEN must be set so the agent "
            "knows where to reach our MCP server."
        )

    payload = {
        "name": "Vertex Agent",
        "description": "Roman's personal automation agent for Vertex MMA.",
        "model": ANTHROPIC_MODEL,
        "system": SYSTEM_PROMPT,
        # MCP server connection — Anthropic will hit MCP_PUBLIC_URL/mcp
        # with the bearer token on every tools/call.
        "mcp_servers": [
            {
                "name": "vertex-vps",
                "url": f"{MCP_PUBLIC_URL.rstrip('/')}/mcp",
                "authorization_token": MCP_BEARER_TOKEN,
            }
        ],
        # Built-in tool set (bash inside Anthropic's sandbox + web search
        # etc.) — kept in addition to our MCP so the agent can do
        # research without hitting our VPS.
        "tools": [{"type": "agent_toolset_20260401"}],
    }

    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": ANTHROPIC_BETA,
        "content-type": "application/json",
    }

    console.log("POST /v1/agents …")
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            "https://api.anthropic.com/v1/agents",
            headers=headers,
            json=payload,
        )
    if resp.status_code >= 400:
        console.log(f"[red]HTTP {resp.status_code}[/red]")
        console.log(resp.text)
        sys.exit(1)
    data = resp.json()
    agent_id = data.get("id") or data.get("agent_id")
    console.log(f"[green]Created agent {agent_id}[/green]")
    console.log(
        "\nPaste this into .env.local:\n\n"
        f"AGENT_ID={agent_id}\n"
    )
    console.log("Full response:")
    console.print_json(data=data)


if __name__ == "__main__":
    main()

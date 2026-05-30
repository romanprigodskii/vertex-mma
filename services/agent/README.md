# Vertex Agent

Personal Telegram-driven automation agent for the Vertex MMA project,
powered by **Anthropic Managed Agents** (the agent loop, memory, and
retries run on Anthropic's side) plus a small **MCP server** on your
infra that exposes `bash` / `read_file` / `write_file` / `list_dir`
sandboxed to the Vertex MMA repo.

```
Telegram ─► bridge.py ─► POST /v1/agents/<id>/sessions/.../messages
                                    │
                            Anthropic Managed Agent
                                    │
                            POST /mcp (Bearer auth)
                                    │
                            mcp_server.py (your VPS)
                                    │
                            bash / file ops on /workspace
```

## Why this shape

* **Anthropic owns the loop** — no custom tool-use loop / memory /
  retry to maintain.
* **You own the tools** — MCP server runs bash on YOUR VPS so the
  agent can `pnpm build`, `python scripts/simulation/run_train.py`,
  `git push`, etc.
* **Telegram is just I/O** — bridge.py is ~200 lines of plumbing.

## One-time setup

1. **Telegram bot** — talk to [@BotFather](https://t.me/BotFather):
   `/newbot` → name it → save the token. (You already pasted yours in
   chat — rotate it later via `/revoke` + `/token`.)

2. **Your Telegram chat id** — message
   [@userinfobot](https://t.me/userinfobot) and copy the numeric id.

3. **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com/)
   → Get API key. ($15+ balance recommended for safety.)

4. **Public URL for the MCP server** — Anthropic needs to reach it
   over HTTPS. Options:
   - **Coolify (prod)** — deploy this folder as an app, Coolify gives
     you `https://agent-mcp.yourdomain.com`.
   - **Local dev** — `cloudflared tunnel --url http://localhost:8765`
     or `ngrok http 8765`. Quick, ephemeral.

5. **MCP bearer token** — generate one:
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```
   Anthropic will send this with every MCP request; the server checks
   it. Without it the public URL would be a free shell.

6. **Fill `.env.local`** (copy from `.env.example`):
   ```
   TELEGRAM_BOT_TOKEN=…
   TELEGRAM_AUTHORIZED_CHAT_ID=…
   ANTHROPIC_API_KEY=sk-ant-…
   MCP_PUBLIC_URL=https://…           # whatever you set up in step 4
   MCP_BEARER_TOKEN=…                 # from step 5
   ```

7. **Create the agent** (registers your MCP server + system prompt
   with Anthropic):
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   python scripts/create_agent.py
   ```
   It prints `AGENT_ID=…` — paste that into `.env.local`.

## Run

**Two terminals locally:**

```bash
# Terminal 1 — MCP server
source venv/bin/activate
python scripts/run_mcp.py

# Terminal 2 — Telegram bridge
source venv/bin/activate
python scripts/run_bridge.py
```

Or via docker-compose:

```bash
docker compose up --build
```

Open Telegram, message your bot `/start`, then send any task:

> Retrain the simulation model and commit the artifacts when done.

The agent runs commands on your VPS via MCP and reports back in TG.

## Coolify deploy

This folder is meant to deploy as TWO services on the same Coolify app:

- `mcp` — `CMD ["python", "scripts/run_mcp.py"]`, exposed on `/mcp`
  with HTTPS, env from Coolify secret store.
- `bridge` — `CMD ["python", "scripts/run_bridge.py"]`, no exposed
  port, just long-poll Telegram.

Mount the vertexmma working tree at `/workspace` so the agent operates
on the real repo. For prod we recommend a dedicated git checkout that
the agent owns (so a parallel `git status` from you doesn't conflict).

## Security notes

* MCP bearer token gates the public URL — rotate if leaked.
* `bash` runs with whatever user the container runs as. In Coolify
  that's typically a non-root container user; verify before deploying.
* The MCP server enforces a workdir sandbox — paths that resolve
  outside `AGENT_WORKDIR` get refused. Symlinks are followed via
  `.resolve()` so a symlink-out-of-workdir trick is also blocked.
* The TG bridge whitelists a single chat id. Anyone else messaging
  the bot gets "Not authorized" and is dropped.

## Files

```
services/agent/
├── pyproject.toml
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── src/
│   ├── config.py          — env loading + validation
│   ├── tools.py           — pure-python bash/read/write/list
│   ├── mcp_server.py      — FastAPI MCP endpoint (bearer-authed)
│   └── bridge.py          — Telegram ↔ Anthropic Agent API bridge
└── scripts/
    ├── create_agent.py    — one-shot POST /v1/agents
    ├── run_mcp.py         — uvicorn :8765
    └── run_bridge.py      — long-poll telegram
```

## Cost

Sonnet 4.6 pricing (May 2026): $3 input / $15 output per 1M tokens.
Active "retrain the model + commit it" session ≈ 60–150K tokens =
$0.50–$2 per long task. Lightweight chat replies are cents. Month of
active use ≈ $10–$50.

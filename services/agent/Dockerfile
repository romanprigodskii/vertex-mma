# Single image that can run either entrypoint:
#   * MCP server     → uvicorn :8765/mcp
#   * Telegram bridge → long-poll → Anthropic Agent API
#
# Pick which one to run via the CMD override in docker-compose /
# Coolify (run_mcp.py or run_bridge.py). Both share the same code,
# venv, and .env.local, so a single Coolify "application" with two
# services keeps deploy simple.

FROM python:3.12-slim

# Minimal toolchain — git so the agent can git push from inside the
# container, and curl for healthchecks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY scripts ./scripts
COPY pyproject.toml ./

# The Vertex MMA repo is mounted at /workspace in production. Default
# AGENT_WORKDIR points there; override via env if you mount elsewhere.
ENV AGENT_WORKDIR=/workspace
ENV PYTHONUNBUFFERED=1

# Default entrypoint = MCP server. docker-compose / Coolify second
# service overrides CMD with `python scripts/run_bridge.py`.
EXPOSE 8765
CMD ["python", "scripts/run_mcp.py"]

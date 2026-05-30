"""Telegram ↔ Anthropic Managed Agent bridge.

Flow per user message:
  1. Receive TG text update.
  2. Look up the persistent session_id for this chat (we keep one
     session per Telegram chat so context survives between messages).
  3. POST the message to /v1/agents/{AGENT_ID}/sessions/{session_id}/messages
     (or create the session on the first message).
  4. Stream / poll the assistant's reply.
  5. Send it back to TG.

Only TELEGRAM_AUTHORIZED_CHAT_ID is accepted — everything else is dropped
with a polite "not authorized" reply.

State is stored in a tiny SQLite file (data/bridge_state.sqlite). One
table: chat_sessions(chat_id PK, session_id, created_at).
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import httpx
from rich.console import Console
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .config import (
    AGENT_ID,
    ANTHROPIC_API_KEY,
    ANTHROPIC_BETA,
    TELEGRAM_AUTHORIZED_CHAT_ID,
    TELEGRAM_BOT_TOKEN,
    assert_bridge_ready,
)

console = Console()

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
DATA_DIR.mkdir(exist_ok=True)
SESSIONS_DB = DATA_DIR / "bridge_state.sqlite"

ANTHROPIC_BASE = "https://api.anthropic.com"
ANTHROPIC_HEADERS = {
    "x-api-key": ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": ANTHROPIC_BETA,
    "content-type": "application/json",
}

# Telegram cap is 4096; we leave room for our footer.
TG_MAX_LEN = 3900

# How long we wait for the agent to finish a single turn before giving
# up and reporting the timeout to the user. Tools can chain; this
# covers training runs etc. since the agent backgrounds those.
AGENT_TURN_TIMEOUT_SECONDS = 900


# ── State ─────────────────────────────────────────────────────────────


def _init_db() -> sqlite3.Connection:
    conn = sqlite3.connect(SESSIONS_DB, check_same_thread=False, isolation_level=None)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_sessions (
            chat_id    TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    return conn


_DB = _init_db()


def get_session_id(chat_id: str) -> str | None:
    cur = _DB.execute(
        "SELECT session_id FROM chat_sessions WHERE chat_id = ?", (chat_id,)
    )
    row = cur.fetchone()
    return row[0] if row else None


def save_session_id(chat_id: str, session_id: str) -> None:
    _DB.execute(
        "INSERT OR REPLACE INTO chat_sessions (chat_id, session_id, created_at) "
        "VALUES (?, ?, ?)",
        (chat_id, session_id, datetime.now(timezone.utc).isoformat()),
    )


def clear_session(chat_id: str) -> None:
    _DB.execute("DELETE FROM chat_sessions WHERE chat_id = ?", (chat_id,))


# ── Anthropic Managed Agent calls ─────────────────────────────────────


async def _create_session(client: httpx.AsyncClient) -> str:
    """Start a fresh agent session, return its id."""
    resp = await client.post(
        f"{ANTHROPIC_BASE}/v1/agents/{AGENT_ID}/sessions",
        headers=ANTHROPIC_HEADERS,
        json={},
    )
    resp.raise_for_status()
    data = resp.json()
    session_id = data.get("id") or data.get("session_id")
    if not session_id:
        raise RuntimeError(f"agent session create missing id: {data}")
    return session_id


async def _send_message(
    client: httpx.AsyncClient, session_id: str, text: str
) -> str:
    """POST the user message and return the assistant text. Polls
    until the turn finishes or AGENT_TURN_TIMEOUT_SECONDS elapses."""
    # Send the user turn.
    resp = await client.post(
        f"{ANTHROPIC_BASE}/v1/agents/{AGENT_ID}/sessions/{session_id}/messages",
        headers=ANTHROPIC_HEADERS,
        json={"content": [{"type": "text", "text": text}]},
    )
    resp.raise_for_status()
    submitted = resp.json()
    console.log(f"[bridge] message accepted: {submitted.get('id')}")

    # Poll the session until the latest assistant message is final.
    deadline = asyncio.get_running_loop().time() + AGENT_TURN_TIMEOUT_SECONDS
    while True:
        if asyncio.get_running_loop().time() > deadline:
            return "(agent turn timed out — try again or check the Anthropic console)"
        await asyncio.sleep(2.0)
        poll = await client.get(
            f"{ANTHROPIC_BASE}/v1/agents/{AGENT_ID}/sessions/{session_id}",
            headers=ANTHROPIC_HEADERS,
        )
        poll.raise_for_status()
        state = poll.json()
        status = state.get("status")
        if status in ("completed", "ready", "idle"):
            return _extract_latest_assistant_text(state) or "(empty response)"
        if status in ("failed", "errored"):
            err = state.get("error") or "unknown error"
            return f"(agent errored: {err})"
        # Else: still running — keep polling.


def _extract_latest_assistant_text(session_state: dict) -> str:
    """Pull the most recent assistant message's text out of the session
    payload. Schema isn't fully documented — try a few common shapes."""
    messages = session_state.get("messages") or session_state.get("history") or []
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
            if parts:
                return "\n\n".join(parts).strip()
    return ""


# ── Telegram bot ──────────────────────────────────────────────────────


def _is_authorized(update: Update) -> bool:
    chat = update.effective_chat
    return chat is not None and str(chat.id) == TELEGRAM_AUTHORIZED_CHAT_ID


def _chunks(text: str, limit: int = TG_MAX_LEN) -> list[str]:
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    buf: list[str] = []
    size = 0
    for line in text.splitlines(keepends=True):
        if size + len(line) > limit and buf:
            out.append("".join(buf))
            buf = []
            size = 0
        buf.append(line)
        size += len(line)
    if buf:
        out.append("".join(buf))
    return out


async def _reply(update: Update, text: str) -> None:
    if update.message is None:
        return
    for chunk in _chunks(text):
        await update.message.reply_text(chunk)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        await _reply(update, "Not authorized.")
        return
    chat_id = str(update.effective_chat.id)
    await _reply(
        update,
        f"Vertex Agent online. Chat id: {chat_id}.\n"
        f"Agent: {AGENT_ID}\n"
        f"/reset — new session  ·  /status — current session id",
    )


async def cmd_reset(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        await _reply(update, "Not authorized.")
        return
    chat_id = str(update.effective_chat.id)
    clear_session(chat_id)
    await _reply(update, "Session wiped. Next message starts fresh.")


async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        await _reply(update, "Not authorized.")
        return
    chat_id = str(update.effective_chat.id)
    sid = get_session_id(chat_id)
    await _reply(update, f"session: {sid or '(none yet)'}")


async def _typing_loop(update: Update) -> None:
    while True:
        try:
            await update.effective_chat.send_chat_action(ChatAction.TYPING)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(4)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _is_authorized(update):
        await _reply(update, "Not authorized.")
        return
    if update.message is None or update.message.text is None:
        return
    chat_id = str(update.effective_chat.id)
    user_text = update.message.text

    typing_task = asyncio.create_task(_typing_loop(update))
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            session_id = get_session_id(chat_id)
            if session_id is None:
                session_id = await _create_session(client)
                save_session_id(chat_id, session_id)
                console.log(f"[bridge] new session {session_id} for chat {chat_id}")
            try:
                reply = await _send_message(client, session_id, user_text)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404:
                    # Session expired or got garbage-collected by Anthropic.
                    console.log("[bridge] session 404, recreating")
                    session_id = await _create_session(client)
                    save_session_id(chat_id, session_id)
                    reply = await _send_message(client, session_id, user_text)
                else:
                    body = exc.response.text[:400]
                    reply = f"(HTTP {exc.response.status_code}) {body}"
    except Exception as exc:  # noqa: BLE001
        reply = f"(bridge error: {exc!r})"
    finally:
        typing_task.cancel()
        try:
            await typing_task
        except Exception:  # noqa: BLE001
            pass

    await _reply(update, reply)


def main() -> None:
    assert_bridge_ready()
    console.log(
        f"Starting Vertex Agent bridge → agent={AGENT_ID} chat={TELEGRAM_AUTHORIZED_CHAT_ID}"
    )
    app = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("reset", cmd_reset))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

"""Claude Haiku rephrase of MMA news items."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

# src/db.py loads .env.local too; load it here as well so the Anthropic client
# finds ANTHROPIC_API_KEY regardless of module import order.
load_dotenv(Path(__file__).resolve().parents[3] / ".env.local")

MODEL = "claude-haiku-4-5"
_MAX_BODY_CHARS = 800
_MAX_OUT_TOKENS = 2048

SYSTEM_PROMPT = """You rewrite mixed martial arts (MMA) news items for Vertex MMA, a UFC \
stats site. For each item you are given the source's title and a short summary; write a \
brief, neutral 2-paragraph rephrase in your own words. Separate the two paragraphs with a \
blank line.

Style: third-person news voice, factual, no opinion, no filler, no speculation beyond \
what the input states. Do NOT invent specifics — names, dates, results, quotes — that \
are not in the input. Each paragraph is 2-4 sentences. Total length under 180 words.

If the summary is empty or only the title is meaningful, write a single short paragraph \
from the title alone. Never refuse — produce a rephrase from whatever is given.

Return one result per input item, echoing each item's index."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "body": {"type": "string"},
                },
                "required": ["index", "body"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["results"],
    "additionalProperties": False,
}


@dataclass
class ItemInput:
    index: int
    title: str
    body: str | None


@dataclass
class ItemRephrase:
    body: str


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


def _build_user_message(items: list[ItemInput]) -> str:
    blocks: list[str] = []
    for it in items:
        body = (it.body or "").strip()
        if len(body) > _MAX_BODY_CHARS:
            body = body[:_MAX_BODY_CHARS] + "…"
        blocks.append(
            f"[{it.index}]\nTITLE: {it.title}\nSUMMARY: {body or '(none)'}"
        )
    return "Rephrase these MMA news items:\n\n" + "\n\n".join(blocks)


def rephrase_batch(items: list[ItemInput]) -> dict[int, ItemRephrase]:
    """Rephrase a batch with Claude Haiku; results keyed by input index.

    Raises on an API or JSON-parse failure so the caller can leave the batch
    unprocessed and retry it on the next run.
    """
    if not items:
        return {}

    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=_MAX_OUT_TOKENS,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": _build_user_message(items)}],
        output_config={
            "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}
        },
    )

    text = next((b.text for b in response.content if b.type == "text"), "")
    data = json.loads(text)

    out: dict[int, ItemRephrase] = {}
    for row in data.get("results", []):
        idx = row.get("index")
        if not isinstance(idx, int):
            continue
        body = row.get("body")
        if not isinstance(body, str) or not body.strip():
            continue
        out[idx] = ItemRephrase(body=body.strip())
    return out

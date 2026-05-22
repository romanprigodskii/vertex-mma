"""Claude Haiku classification of MMA news items."""
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
_MAX_BODY_CHARS = 600

CLASSIFICATIONS = (
    "bout_announced",
    "bout_cancelled",
    "bout_changed",
    "weigh_in",
    "result",
    "general_news",
    "rumor",
    "unrelated",
)
_VALID = frozenset(CLASSIFICATIONS)

SYSTEM_PROMPT = """You classify mixed martial arts (MMA) news items for a UFC \
stats site. For each item you are given a title and a short summary; return its \
category, your confidence, and the fighters it is about.

Categories — pick the single best fit:
- bout_announced: a new fight/matchup has been officially booked or announced.
- bout_cancelled: a scheduled fight is off — cancelled, scrapped, or a fighter \
has withdrawn or been pulled.
- bout_changed: a booked fight's details changed — an opponent swap, a new \
date, or a weight-class change.
- weigh_in: weigh-in results or coverage; a fighter making or missing weight.
- result: the outcome of a fight that has already happened (who won, and how).
- general_news: MMA news that fits none of the above — signings, contract \
news, retirements, rankings, interviews, injuries not tied to a specific \
cancelled bout, press conferences, business and promotion news.
- rumor: unconfirmed or speculative reporting — wording like "targeted", "in \
talks", "expected to", "could", "rumored", "reportedly being discussed".
- unrelated: not MMA news — another sport with no MMA connection, or off-topic.

A boxing-only item with no MMA crossover is unrelated. An item about a UFC/MMA \
fighter who is boxing counts as MMA news (general_news unless another category \
fits better).

Fighters: list the MMA fighters the item is primarily about — the people \
fighting or the main subject — by their common full names (e.g. "Jon Jones", \
"Israel Adesanya"). Do not list coaches, executives, or fighters mentioned \
only in passing. Empty list when there are none. At most four.

Confidence: 0.0-1.0 — how sure you are of the category. Use lower values for \
ambiguous or thinly-sourced items.

Return exactly one result object per input item, echoing each item's index."""

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "classification": {
                        "type": "string",
                        "enum": list(CLASSIFICATIONS),
                    },
                    "confidence": {"type": "number"},
                    "fighters": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": [
                    "index",
                    "classification",
                    "confidence",
                    "fighters",
                ],
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
class ItemClassification:
    classification: str
    confidence: float
    fighters: list[str]


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
    return "Classify these MMA news items:\n\n" + "\n\n".join(blocks)


def classify_batch(items: list[ItemInput]) -> dict[int, ItemClassification]:
    """Classify a batch with Claude Haiku; results keyed by input index.

    Raises on an API or JSON-parse failure so the caller can leave the batch
    unprocessed and retry it on the next run.
    """
    if not items:
        return {}

    # The system prompt is static — cache_control caches it once the prefix
    # crosses Haiku 4.5's 4096-token minimum (a no-op below that, never an
    # error). Structured outputs guarantee schema-valid JSON.
    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=2048,
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

    out: dict[int, ItemClassification] = {}
    for row in data.get("results", []):
        idx = row.get("index")
        if not isinstance(idx, int):
            continue
        classification = row.get("classification")
        if classification not in _VALID:
            classification = "general_news"
        try:
            confidence = max(0.0, min(1.0, float(row.get("confidence", 0.5))))
        except (TypeError, ValueError):
            confidence = 0.5
        fighters = [
            f.strip()
            for f in row.get("fighters", [])
            if isinstance(f, str) and f.strip()
        ][:4]
        out[idx] = ItemClassification(
            classification=classification,
            confidence=confidence,
            fighters=fighters,
        )
    return out

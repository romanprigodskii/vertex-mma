"""Claude Haiku classification of MMA news items."""
from __future__ import annotations

import json
import re
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
- result: the OUTCOME of a fight that has already happened. The article must \
describe what actually occurred — who won, by what method (KO, TKO, submission, \
decision), and ideally the round. Live blogs and play-by-play recaps of a \
completed event also qualify. \
DO NOT use `result` for: analysts predicting fights ("X picks Y to win", \
"Sonnen says…"), fighters calling out a future opponent, interviews about \
future fights, opinion / analysis columns, power-rankings articles, or any \
item where no fight has actually been fought yet. Those go in `general_news`.
- general_news: MMA news that fits none of the above — signings, contract \
news, retirements, ranking changes, interviews, injuries not tied to a \
specific cancelled bout, press conferences, business and promotion news, \
analyst predictions, opinion / analysis pieces, callouts that aren't a \
confirmed booking.
- rumor: unconfirmed or speculative reporting — wording like "targeted", "in \
talks", "expected to", "could", "rumored", "reportedly being discussed".
- unrelated: not MMA news — another sport with no MMA connection, or off-topic.

A boxing-only item with no MMA crossover is unrelated. An item about a UFC/MMA \
fighter who is boxing counts as MMA news (general_news unless another category \
fits better).

Fighters: list the MMA fighters the item is primarily about — the people \
fighting or the main subject — by their common full names (e.g. "Jon Jones", \
"Israel Adesanya"). Do not list coaches, executives, analysts/pundits, or \
fighters mentioned only in passing. For an analyst-prediction piece, do NOT \
list the analyst — list the fighters the prediction is about. Empty list when \
there are none. At most four.

Event hint: ONLY for `bout_announced` items, give the event name the booking \
is FOR, exactly as written (e.g. "UFC 330", "UFC Fight Night: Whittaker vs \
Costa", "UFC on ESPN 60"). Use null if you can't find a specific event name \
in the text, or for any other category.

Weight class: for `bout_announced` and `bout_changed` items, return one of: \
strawweight, flyweight, bantamweight, featherweight, lightweight, welterweight, \
middleweight, light_heavyweight, heavyweight, catchweight (for a change, the NEW \
weight class). Use the underscore form `light_heavyweight`. Use null when not \
stated and for other categories.

Event date: for `bout_announced` and `bout_changed` items, the calendar date the \
event takes place (for a change, the NEW date), as an ISO date `YYYY-MM-DD`, when \
a specific date is stated or clearly implied (e.g. "on March 14", "Dec. 6 card", \
"UFC 330 on Jan 17"). For the year: \
fights are announced BEFORE they happen, so pick the first occurrence of that \
month/day ON OR AFTER the item's PUBLISHED date (shown per item); if no \
PUBLISHED date is given, use the nearest future occurrence. Use null if no date \
is stated. For every other category, null.

Confidence: 0.0-1.0 — how sure you are of the category. Use lower values for \
ambiguous or thinly-sourced items.

Return exactly one result object per input item, echoing each item's index."""

WEIGHT_CLASSES = (
    "strawweight",
    "flyweight",
    "bantamweight",
    "featherweight",
    "lightweight",
    "welterweight",
    "middleweight",
    "light_heavyweight",
    "heavyweight",
    "catchweight",
)
_VALID_WEIGHT = frozenset(WEIGHT_CLASSES)

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
                    "event_hint": {"type": ["string", "null"]},
                    # Weight class is enum-validated in code (_VALID_WEIGHT)
                    # rather than via JSON Schema — Anthropic's structured
                    # output rejects `enum` mixed with a nullable type.
                    "weight_class": {"type": ["string", "null"]},
                    # ISO YYYY-MM-DD; format-validated in code (see below).
                    "event_date": {"type": ["string", "null"]},
                },
                "required": [
                    "index",
                    "classification",
                    "confidence",
                    "fighters",
                    "event_hint",
                    "weight_class",
                    "event_date",
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
    published_at: str | None = None  # ISO date; anchors event-year inference


@dataclass
class ItemClassification:
    classification: str
    confidence: float
    fighters: list[str]
    event_hint: str | None
    weight_class: str | None
    event_date: str | None  # ISO 'YYYY-MM-DD' or None


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
        pub = f"\nPUBLISHED: {it.published_at}" if it.published_at else ""
        blocks.append(
            f"[{it.index}]{pub}\nTITLE: {it.title}\nSUMMARY: {body or '(none)'}"
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
        event_hint_raw = row.get("event_hint")
        event_hint = (
            event_hint_raw.strip()
            if isinstance(event_hint_raw, str) and event_hint_raw.strip()
            else None
        )
        weight_raw = row.get("weight_class")
        weight_class = (
            weight_raw
            if isinstance(weight_raw, str) and weight_raw in _VALID_WEIGHT
            else None
        )
        date_raw = row.get("event_date")
        event_date = (
            date_raw
            if isinstance(date_raw, str)
            and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_raw)
            else None
        )
        out[idx] = ItemClassification(
            classification=classification,
            confidence=confidence,
            fighters=fighters,
            event_hint=event_hint,
            weight_class=weight_class,
            event_date=event_date,
        )
    return out

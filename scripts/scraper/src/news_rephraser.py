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
# Large enough that a full fight-card listing (which sits AFTER the intro
# paragraphs) reaches the model — at 800 the card was being cut off, so
# "full card" articles lost their entire point.
_MAX_BODY_CHARS = 6000
_MAX_OUT_TOKENS = 8192

SYSTEM_PROMPT = """You write expanded MMA news articles for Vertex MMA, a UFC stats \
site. For each item you receive the source's title and a short summary; rewrite it \
as a self-contained article in your own words.

Length: aim for 250-400 words across 3-5 paragraphs when the input has real content \
(descriptions of what happened, names, results, context). When the input is thin \
(only a title, a one-line summary, or template scaffolding) write ONE SHORT \
paragraph of 40-100 words that honestly summarises what is known — a short honest \
summary beats a padded one.

FIGHT CARDS, LINEUPS & RESULTS: if the source lists a fight card, a bout lineup, or \
per-bout RESULTS — multiple lines such as "A vs. B" (an upcoming card) or "A def. B" \
(an outcome: by KO/TKO/submission/decision, or by wrestling marks like "tech fall", \
"pinfall", or a points score such as "10-0") — you MUST reproduce EVERY line, one \
bout per line, KEEPING each result's winner and method/score EXACTLY as written, \
under its section headings ("Main card", "Prelims", "Early prelims") when given. \
For a "full card", lineup, or results article this list IS the point: never \
summarise it into prose, never drop a bout, and never replace it with a note about \
the event's format or rules. Write a short lead paragraph first, then output every \
bout/result line. This overrides the 250-400 word guidance — list them all, however \
long. (Reproducing results that ARE in the source is required and does NOT count as \
"inventing results" — the rule below against invented results applies only to \
outcomes the source does not state.)

Style: third-person news voice, factual and informative. Open with the lead (what \
happened). Then add relevant context — what the event or promotion is, who the \
fighters are if reasonably known, the broader storyline. Close with what this \
typically means in MMA (next steps, fines, implications).

You MAY add general factual context that any MMA reader knows — what PFL, UFC, ONE, \
Bellator are; what a weigh-in is; what brawls at ceremonials typically trigger; what \
a weight class is; what KO/TKO/SUB/DEC mean.

Do NOT invent specifics that aren't in the input — no fake fighter quotes, no \
fabricated stats, no made-up dates, no invented fight results, no people who weren't \
named. When unsure about a specific, omit it rather than guess.

If the source looks like scaffolding — repeated lines like "X scores the round:" \
with no actual scores, empty "TBA" rows, a round-by-round template with no \
filled-in details — DO NOT echo the scaffolding. Instead write a single short \
paragraph along the lines of: "Live coverage of <event> is in progress; full \
results will appear once the card concludes." Never repeat the same sentence \
pattern multiple times.

Never refuse — always produce something, even if just a short honest note.

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

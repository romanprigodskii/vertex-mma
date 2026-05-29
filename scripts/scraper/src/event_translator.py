"""Claude transliteration of event names into Russian (matchup surnames)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env.local")

MODEL = "claude-sonnet-4-6"
_MAX_OUT_TOKENS = 8192

SYSTEM_PROMPT = """You localize MMA event names into Russian for the Russian \
version of Vertex MMA, a UFC stats site.

Event names look like "UFC Fight Night: Song vs. Figueiredo", "UFC 328: Chimaev \
vs. Strickland", or sometimes just "UFC 300". Rules:
- KEEP promotion/format prefixes verbatim: "UFC", "UFC Fight Night", "UFC <number>", \
"PFL", "Bellator", "ONE", "Dana White's Contender Series", "The Ultimate Fighter", \
etc. Do NOT translate "Fight Night", numbers, or org names.
- Translate ONLY the fighter surnames in the "X vs. Y" matchup into Russian, using \
the established Russian spelling for that athlete (e.g. "Song" -> "Сун", "Figueiredo" \
-> "Фигейреду", "Chimaev" -> "Чимаев", "Strickland" -> "Стрикленд", "Makhachev" -> \
"Махачев"). Keep the " vs. " separator as-is.
- If a name has no matchup part (e.g. "UFC 300"), return it unchanged.
- Never refuse; always return a best-effort Russian rendering for every index.

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
                    "name_ru": {"type": "string"},
                },
                "required": ["index", "name_ru"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["results"],
    "additionalProperties": False,
}

_CYRILLIC = re.compile(r"[А-Яа-яЁё]")


@dataclass
class EventInput:
    index: int
    name: str


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


def _build_user_message(items: list[EventInput]) -> str:
    blocks = [f"[{it.index}] {it.name}" for it in items]
    return "Localize these event names into Russian:\n\n" + "\n".join(blocks)


def translate_batch(items: list[EventInput]) -> dict[int, str]:
    """Translate a batch; results keyed by index. Raises on API/JSON failure so
    the caller can leave the batch for the next run. Drops a result with no
    Cyrillic AND no digit (i.e. clearly not a real rendering); a pure "UFC 300"
    that comes back unchanged is kept (it has digits)."""
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

    out: dict[int, str] = {}
    for row in data.get("results", []):
        idx = row.get("index")
        if not isinstance(idx, int):
            continue
        name_ru = (row.get("name_ru") or "").strip()
        if not name_ru:
            continue
        out[idx] = name_ru
    return out

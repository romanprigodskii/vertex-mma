"""Claude transliteration of fighter names into Russian (Cyrillic)."""
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

MODEL = "claude-sonnet-4-6"
_MAX_OUT_TOKENS = 8192

SYSTEM_PROMPT = """You transliterate combat-sports athletes' names into Russian \
(Cyrillic) for the Russian-language version of Vertex MMA, a UFC stats site.

For each fighter you receive an index, their name in Latin script, and an ISO \
country code (may be "?").

Rules:
- Output ONLY the person's given name + surname in Russian Cyrillic. No nicknames, \
no quotation marks, no Latin letters, no extra words.
- For fighters whose names are natively Russian, Ukrainian, Belarusian, Kazakh, \
Georgian, Armenian, or otherwise from Cyrillic-using or post-Soviet cultures, use \
the ESTABLISHED Russian spelling rather than a naive letter-by-letter \
transliteration (e.g. "Khabib Nurmagomedov" -> "Хабиб Нурмагомедов", \
"Zabit Magomedsharipov" -> "Забит Магомедшарипов", "Khamzat Chimaev" -> \
"Хамзат Чимаев", "Petr Yan" -> "Пётр Ян").
- For everyone else, transliterate phonetically the way Russian sports media would \
render and pronounce the name (e.g. "Alex Pereira" -> "Алекс Перейра", \
"Israel Adesanya" -> "Исраэль Адесанья", "Sean O'Malley" -> "Шон О'Мэлли", \
"Conor McGregor" -> "Конор Макгрегор").
- Use the country code as a hint to the fighter's origin and pronunciation.
- Keep the order: given name first, surname second.
- Never refuse; always produce a best-effort Russian rendering for every index.

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
                    "ru": {"type": "string"},
                },
                "required": ["index", "ru"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["results"],
    "additionalProperties": False,
}

_CYRILLIC = re.compile(r"[А-Яа-яЁё]")
_LATIN = re.compile(r"[A-Za-z]")


@dataclass
class NameInput:
    index: int
    name_en: str
    country_code: str | None


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


def _build_user_message(items: list[NameInput]) -> str:
    blocks: list[str] = []
    for it in items:
        cc = (it.country_code or "").strip() or "?"
        blocks.append(f"[{it.index}] {it.name_en}  (country: {cc})")
    return "Transliterate these fighter names into Russian:\n\n" + "\n".join(blocks)


def translate_batch(items: list[NameInput]) -> dict[int, str]:
    """Transliterate a batch; results keyed by input index.

    Raises on an API or JSON-parse failure so the caller can leave the batch
    unprocessed and retry it on the next run. Drops any result that contains no
    Cyrillic (e.g. an echoed Latin name) so name_en stays the fallback.
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

    out: dict[int, str] = {}
    for row in data.get("results", []):
        idx = row.get("index")
        if not isinstance(idx, int):
            continue
        ru = row.get("ru")
        if not isinstance(ru, str):
            continue
        ru = ru.strip()
        # Require Cyrillic and reject any leftover Latin — Claude occasionally
        # transliterates only part of an awkward name (e.g. "Пол Варелans"),
        # which reads worse than the clean English fallback.
        if not ru or not _CYRILLIC.search(ru) or _LATIN.search(ru):
            continue
        out[idx] = ru
    return out

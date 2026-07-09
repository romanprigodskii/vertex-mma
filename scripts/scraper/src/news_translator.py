"""Claude translation of MMA news (title + rephrased body) into Russian."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[3] / ".env.local")

MODEL = "claude-sonnet-4-6"
_MAX_OUT_TOKENS = 16384

SYSTEM_PROMPT = """You translate MMA news for the Russian-language version of \
Vertex MMA, a UFC stats site. For each item you receive an index, an English \
title, and (optionally) an English article body.

Produce a faithful, fluent Russian translation:
- TITLE: render as a natural Russian news headline. Drop English scaffolding \
prefixes like "Video:" / "VIDEO:" / "Watch:" — translate only the actual headline.
- BODY: translate the whole article into fluent, idiomatic Russian, preserving the \
paragraph breaks (blank line between paragraphs). Do NOT add, drop, or summarize \
content — translate what is there.
- Fighter and person names: use the established Russian spelling for athletes from \
Cyrillic-using / post-Soviet cultures (e.g. "Khabib Nurmagomedov" -> "Хабиб \
Нурмагомедов"); transliterate others the way Russian sports media would.
- Keep MMA terminology natural in Russian (нокаут, сабмишн/удушающий, единогласное \
решение, титульный бой, etc.). Org names (UFC, PFL, ONE, Bellator) stay as-is.
- If an item has no body, return an empty string for body_ru.
- Never refuse; always return a best-effort translation for every index.

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
                    "title_ru": {"type": "string"},
                    "body_ru": {"type": "string"},
                },
                "required": ["index", "title_ru", "body_ru"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["results"],
    "additionalProperties": False,
}

_CYRILLIC = re.compile(r"[А-Яа-яЁё]")
_MAX_BODY_CHARS = 6000
# Source bodies shorter than this may legitimately translate without any
# Cyrillic (org/event names only, e.g. a degenerate "PFL MENA 9" body), so the
# echo-detection Cyrillic gate below is skipped for them — otherwise such items
# would re-enter the translation queue on every run forever.
_SHORT_BODY_CHARS = 120


@dataclass
class NewsTranslateInput:
    index: int
    title: str
    body: str | None


@dataclass
class NewsTranslation:
    title_ru: str
    body_ru: str | None


_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


def _build_user_message(items: list[NewsTranslateInput]) -> str:
    blocks: list[str] = []
    for it in items:
        body = (it.body or "").strip()
        if len(body) > _MAX_BODY_CHARS:
            body = body[:_MAX_BODY_CHARS]
        blocks.append(
            f"[{it.index}]\nTITLE: {it.title}\nBODY: {body or '(none)'}"
        )
    return "Translate these MMA news items into Russian:\n\n" + "\n\n".join(blocks)


def translate_batch(
    items: list[NewsTranslateInput],
) -> dict[int, NewsTranslation]:
    """Translate a batch; results keyed by input index. Raises on API/JSON
    failure so the caller can leave the batch for the next run. Drops a result
    whose title has no Cyrillic (treat as failed → English fallback stays)."""
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

    src_bodies = {it.index: (it.body or "").strip() for it in items}
    out: dict[int, NewsTranslation] = {}
    for row in data.get("results", []):
        idx = row.get("index")
        if not isinstance(idx, int):
            continue
        title_ru = (row.get("title_ru") or "").strip()
        if not title_ru or not _CYRILLIC.search(title_ru):
            continue
        body_ru = (row.get("body_ru") or "").strip()
        # No Cyrillic in the body usually means the model echoed English back
        # (treat as failed → retried next run) — unless the source body is too
        # short to require any (see _SHORT_BODY_CHARS).
        body_ok = bool(body_ru) and (
            bool(_CYRILLIC.search(body_ru))
            or len(src_bodies.get(idx, "")) < _SHORT_BODY_CHARS
        )
        out[idx] = NewsTranslation(
            title_ru=title_ru,
            body_ru=body_ru if body_ok else None,
        )
    return out

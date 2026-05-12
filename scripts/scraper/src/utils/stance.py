from __future__ import annotations

STANCE_MAP: dict[str, str] = {
    "Orthodox": "orthodox",
    "Southpaw": "southpaw",
    "Switch": "switch",
    "Open Stance": "switch",
    "Sideways": "sideways",
}


def map_stance(value: str | None) -> str:
    if not value:
        return "unknown"
    cleaned = value.strip()
    return STANCE_MAP.get(cleaned, "unknown")

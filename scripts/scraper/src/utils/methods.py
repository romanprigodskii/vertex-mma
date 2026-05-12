from __future__ import annotations

METHOD_MAP: dict[str, str] = {
    "KO/TKO": "ko",
    "KO": "ko",
    "TKO": "tko",
    "Submission": "submission",
    "SUB": "submission",
    "U-DEC": "decision_unanimous",
    "Decision - Unanimous": "decision_unanimous",
    "S-DEC": "decision_split",
    "Decision - Split": "decision_split",
    "M-DEC": "decision_majority",
    "Decision - Majority": "decision_majority",
    "Draw": "draw",
    "No Contest": "no_contest",
    "DQ": "dq",
    "Could Not Continue": "tko",
    "Overturned": "no_contest",
}


def map_method(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return METHOD_MAP.get(cleaned)

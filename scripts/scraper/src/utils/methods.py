from __future__ import annotations

# Wave 16: exact-match table covers the common cases reported by
# UFCStats' summary column verbatim. Anything not in this table falls
# through to the prefix/contains logic in map_method() so detail-suffixed
# variants like "Submission - Rear Naked Choke" or "KO/TKO - Punches"
# parse correctly instead of returning None (which was the original bug
# leaving 50% of bouts with NULL method).
EXACT_MAP: dict[str, str] = {
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

# Wave 16: retained for backwards compatibility — callers that imported
# METHOD_MAP directly continue to work. Prefer map_method() so the
# prefix logic applies.
METHOD_MAP: dict[str, str] = EXACT_MAP


def map_method(value: str | None) -> str | None:
    """Normalise a UFCStats method label to the bout_method enum.

    UFCStats reports the method column in several shapes:
      - "KO/TKO" (bare)                → "ko"
      - "KO/TKO - Punches" (suffixed)  → "ko"
      - "Submission" (bare)            → "submission"
      - "Submission - Rear Naked Choke" (suffixed) → "submission"
      - "Decision - Unanimous"         → "decision_unanimous"
      - "U-DEC" (legacy short form)    → "decision_unanimous"

    Returns None when no rule applies — callers persist NULL in that
    case. The raw text should also be written to bout.method_detail so a
    future fix can backfill from that audit trail without re-scraping.
    """
    if not value:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None

    # 1) Exact match (cheap fast-path for the common forms).
    if cleaned in EXACT_MAP:
        return EXACT_MAP[cleaned]

    # 2) Prefix / contains fallback. Per the existing convention we map
    # all "KO/TKO ..." variations to "ko" rather than splitting them
    # between ko and tko — the enum still has a "tko" value reserved
    # for the rare bare "TKO" exact match above, but the suffixed
    # combined-bucket variants all flow to "ko".
    upper = cleaned.upper()

    if (
        upper.startswith("KO/TKO")
        or upper.startswith("TKO ")
        or upper.startswith("KO ")
    ):
        return "ko"

    if upper.startswith("SUBMISSION") or upper.startswith("SUB "):
        return "submission"

    # Decision variants come in both "Decision - X" and "X-DEC" forms.
    if "UNANIMOUS" in upper or upper.startswith("U-DEC"):
        return "decision_unanimous"
    if "SPLIT" in upper or upper.startswith("S-DEC"):
        return "decision_split"
    if "MAJORITY" in upper or upper.startswith("M-DEC"):
        return "decision_majority"

    if "DRAW" in upper:
        return "draw"
    if "NO CONTEST" in upper or upper == "NC":
        return "no_contest"
    if upper.startswith("DQ") or "DISQUALIFICATION" in upper:
        return "dq"
    if "COULD NOT CONTINUE" in upper:
        return "tko"
    if "OVERTURNED" in upper:
        return "no_contest"

    return None

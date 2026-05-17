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

    UFCStats reports the method column in several shapes — and the
    detail page version concatenates the bucket label directly with the
    technique name with no separator (Wave 16.2 finding):
      - "KO/TKO" (bare)                       → "ko"
      - "KO/TKOPunches" (no-space concat)     → "ko"
      - "Submission" (bare)                   → "submission"
      - "SUBRear Naked Choke" (no-space concat) → "submission"
      - "Decision - Unanimous"                → "decision_unanimous"
      - "U-DEC" (legacy short form)           → "decision_unanimous"
      - "CNC"                                 → "tko" (could-not-continue)
      - "OverturnedGuillotine Choke"          → "no_contest"

    Returns None when no rule applies — callers persist NULL in that
    case. The raw text is also written to bout.method_detail so a
    future iteration can backfill from that audit trail without
    re-scraping.
    """
    if not value:
        return None
    cleaned = value.strip()
    if not cleaned:
        return None

    # 1) Exact match (cheap fast-path for the common forms).
    if cleaned in EXACT_MAP:
        return EXACT_MAP[cleaned]

    # 2) Prefix / contains fallback. UFCStats' detail-page method
    # column concatenates the bucket label directly with the technique
    # description (no space), so the SUB/KO/TKO prefix checks must NOT
    # require a trailing space. Per project convention all KO/TKO
    # variants flow to "ko"; the enum's bare "tko" is reserved for the
    # exact-match path above.
    upper = cleaned.upper()

    if (
        upper.startswith("KO/TKO")
        or upper.startswith("TKO")
        or upper.startswith("KO")
    ):
        return "ko"

    if upper.startswith("SUB"):
        return "submission"

    # Wave 16.2: "Overturned<technique>" appears as a no-space concat
    # on overturned bouts (commission ruling after the fact). Map to
    # no_contest since the result was vacated.
    if upper.startswith("OVERTURNED"):
        return "no_contest"

    # Wave 16.2: "CNC" is UFCStats' abbreviation for "Could Not
    # Continue" — usually a doctor stoppage / accidental headbutt
    # cutting the bout short. Treat as TKO (matches the existing
    # "Could Not Continue" exact-match → tko).
    if upper.startswith("CNC"):
        return "tko"

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

    return None

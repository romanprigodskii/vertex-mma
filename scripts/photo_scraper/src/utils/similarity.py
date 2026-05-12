from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher


def normalize_name(value: str) -> str:
    """Lowercase, strip accents, drop punctuation. For comparison only."""
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    return " ".join(value.split())


def name_similarity(a: str, b: str) -> float:
    """SequenceMatcher ratio on normalized names. Returns 0..1."""
    na, nb = normalize_name(a), normalize_name(b)
    if not na or not nb:
        return 0.0
    return SequenceMatcher(None, na, nb).ratio()

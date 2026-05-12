from __future__ import annotations

import re

_HEIGHT_RE = re.compile(r"(\d+)'\s*(\d+)\"?")
_REACH_RE = re.compile(r"(\d+(?:\.\d+)?)\"")


def parse_height_to_cm(value: str | None) -> int | None:
    """UFCStats height like `5' 11"` -> cm. `--` -> None."""
    if not value:
        return None
    text = value.strip()
    if text in ("--", ""):
        return None
    m = _HEIGHT_RE.search(text)
    if not m:
        return None
    feet, inches = int(m.group(1)), int(m.group(2))
    total_inches = feet * 12 + inches
    return round(total_inches * 2.54)


def parse_reach_to_cm(value: str | None) -> int | None:
    """`75.0"` or `75"` -> cm. `--` -> None."""
    if not value:
        return None
    text = value.strip()
    if text in ("--", ""):
        return None
    m = _REACH_RE.search(text)
    if not m:
        return None
    inches = float(m.group(1))
    return round(inches * 2.54)


def parse_percent(value: str | None) -> float | None:
    """`53%` -> 0.53, `---` -> None."""
    if not value:
        return None
    text = value.strip().rstrip("%")
    if text in ("--", "---", ""):
        return None
    try:
        return float(text) / 100.0
    except ValueError:
        return None


def parse_float(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip()
    if text in ("--", "---", ""):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_int(value: str | None) -> int | None:
    if not value:
        return None
    text = value.strip()
    if text in ("--", "---", ""):
        return None
    try:
        return int(text)
    except ValueError:
        return None


_LANDED_OF_RE = re.compile(r"(\d+)\s*of\s*(\d+)")


def parse_landed_of(value: str | None) -> tuple[int, int] | tuple[None, None]:
    """`17 of 23` -> (17, 23). `---` -> (None, None)."""
    if not value:
        return (None, None)
    text = value.strip()
    if text in ("--", "---", ""):
        return (None, None)
    m = _LANDED_OF_RE.search(text)
    if not m:
        return (None, None)
    return (int(m.group(1)), int(m.group(2)))

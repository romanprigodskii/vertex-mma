from __future__ import annotations

from datetime import date, datetime, timezone

# UFCStats uses "Aug. 23, 2025" and "Jul 13, 1978".
_FORMATS = ("%b. %d, %Y", "%b %d, %Y", "%B %d, %Y")


def parse_event_date(value: str) -> datetime | None:
    """Parse a date from UFCStats. Returns an aware UTC datetime at 00:00.

    UFCStats does not publish a time of day on the listing or event pages, so
    we anchor to UTC midnight; the simulator/data layer can refine if needed.
    """
    if not value:
        return None
    text = value.strip()
    for fmt in _FORMATS:
        try:
            naive = datetime.strptime(text, fmt)
            return naive.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def parse_birthdate(value: str) -> date | None:
    if not value:
        return None
    text = value.strip()
    if text == "--":
        return None
    for fmt in _FORMATS:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_round_time(value: str) -> int | None:
    """'4:32' -> 272 seconds; '--' -> None."""
    if not value or value.strip() == "--":
        return None
    parts = value.strip().split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        return None
    return None

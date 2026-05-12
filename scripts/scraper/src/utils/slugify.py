from __future__ import annotations

import re
import unicodedata


def slugify(value: str) -> str:
    """ASCII-only, kebab-case slug. Strips accents and collapses non-alnum runs."""
    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def slug_with_id(name: str, external_id: str) -> str:
    """Stable slug that won't collide on same-name fighters/events.

    Uses the first 6 chars of the ufcstats id as suffix.
    """
    base = slugify(name) or "item"
    suffix = external_id[:6] if external_id else ""
    return f"{base}-{suffix}" if suffix else base

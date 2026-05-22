"""Parse RSS / Atom feed XML into normalized news entries."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape

import feedparser
from selectolax.parser import HTMLParser

# Feed summaries occasionally carry a whole article — keep enough text for
# classification without bloating the row.
_MAX_BODY_CHARS = 3000


@dataclass
class NewsEntry:
    external_id: str | None
    url: str
    title: str
    body: str | None
    author: str | None
    published_at: datetime


def _clean_text(html: str | None) -> str | None:
    """Strip HTML to plain, whitespace-collapsed text."""
    if not html:
        return None
    text = HTMLParser(html).text(separator=" ", strip=True)
    text = " ".join(text.split())
    if not text:
        return None
    return text[:_MAX_BODY_CHARS]


def _entry_published(entry) -> datetime:
    """feedparser returns published/updated as UTC struct_time. Fall back to
    `updated`, then to now() — `news_item.published_at` is NOT NULL."""
    for key in ("published_parsed", "updated_parsed"):
        value = entry.get(key)
        if value:
            return datetime(*value[:6], tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def parse_feed(xml: str) -> list[NewsEntry]:
    """Parse one feed document. Entries with no link or no title are dropped —
    `news_item.url` is the unique key and `title` is NOT NULL."""
    parsed = feedparser.parse(xml)
    entries: list[NewsEntry] = []
    for raw in parsed.entries:
        url = (raw.get("link") or "").strip()
        title = unescape((raw.get("title") or "").strip())
        if not url or not title:
            continue
        author = raw.get("author")
        entries.append(
            NewsEntry(
                external_id=(raw.get("id") or None),
                url=url,
                title=title,
                body=_clean_text(raw.get("summary")),
                author=(unescape(author).strip() or None) if author else None,
                published_at=_entry_published(raw),
            )
        )
    return entries

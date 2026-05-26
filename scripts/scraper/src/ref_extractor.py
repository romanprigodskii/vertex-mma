"""Extract external social / video / link references from source HTML.

The news article page renders these as:
  - SocialEmbed cards    (role=featured)
  - inline PlatformLinks (role=inline)
  - reaction stack       (role=reaction)

For v1 we only emit `inline` refs — the autolinker wraps the anchor text
with a PlatformLink. Featured / reaction classification needs an LLM pass
over the body and is deferred (v2).

Output shape matches the NewsExternalRef TypeScript type declared in
src/lib/db/schema/news.ts. Stored in the news_item.external_refs JSONB
column.
"""
from __future__ import annotations

import re
from urllib.parse import urlparse


# Match <a href="..."> ... </a> tolerantly:
#   - href can be single- or double-quoted
#   - other attributes may appear before / after href
#   - anchor body can contain nested tags
_ANCHOR_RX = re.compile(
    r'<a\s[^>]*?href=["\']([^"\']+)["\'][^>]*?>(.*?)</a>',
    re.IGNORECASE | re.DOTALL,
)

_INNER_TAGS_RX = re.compile(r"<[^>]+>")
_WS_RX = re.compile(r"\s+")

_NAMED_ENTITIES = {
    "amp": "&",
    "lt": "<",
    "gt": ">",
    "quot": '"',
    "apos": "'",
    "nbsp": " ",
    "rsquo": "’",
    "lsquo": "‘",
    "ldquo": "“",
    "rdquo": "”",
    "hellip": "…",
    "mdash": "—",
    "ndash": "–",
}

_ENTITY_RX = re.compile(r"&(#x?[0-9a-fA-F]+|[a-zA-Z0-9]+);")


def _decode_entities(text: str) -> str:
    def repl(m: re.Match[str]) -> str:
        ent = m.group(1)
        if ent.startswith("#"):
            try:
                if ent[1] in ("x", "X"):
                    return chr(int(ent[2:], 16))
                return chr(int(ent[1:]))
            except (ValueError, IndexError):
                return m.group(0)
        return _NAMED_ENTITIES.get(ent.lower(), m.group(0))

    return _ENTITY_RX.sub(repl, text)


def _clean_anchor_text(raw: str) -> str:
    text = _INNER_TAGS_RX.sub(" ", raw)
    text = _decode_entities(text)
    text = _WS_RX.sub(" ", text).strip()
    return text


def detect_kind(url: str) -> str:
    """Classify a URL by host. Defaults to 'link' for unknown destinations."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return "link"
    if host.startswith("www."):
        host = host[4:]
    if host.endswith("instagram.com"):
        return "instagram"
    if host == "x.com" or host.endswith(".x.com"):
        return "x"
    if host.endswith("twitter.com"):
        return "twitter"
    if host.endswith("youtube.com") or host == "youtu.be":
        return "youtube"
    if host.endswith("tiktok.com"):
        return "tiktok"
    return "link"


# Limits — protect against pathological pages with hundreds of links.
_MAX_REFS_PER_ARTICLE = 12
_MAX_ANCHOR_CHARS = 200
_MIN_ANCHOR_CHARS = 2


# Anchor texts that almost always mean "nav / chrome", not an article ref.
# Lowercased for comparison.
_BORING_ANCHORS = {
    "read more",
    "subscribe",
    "sign up",
    "log in",
    "login",
    "click here",
    "more",
    "share",
    "tweet",
    "facebook",
    "next",
    "previous",
    "back to top",
    "advertisement",
    "ad",
    "newsletter",
}


# Hosts we deliberately drop — own domain refs (the article linking back to
# itself / the source's own tag pages) and tracking junk add no value.
_BORING_HOST_FRAGMENTS = (
    "feedproxy.google.com",
    "feeds.feedburner.com",
    "doubleclick.net",
    "googletagmanager.com",
    "googlesyndication.com",
)


def _is_boring_anchor(text: str) -> bool:
    return text.lower() in _BORING_ANCHORS


def _is_boring_host(url: str) -> bool:
    return any(frag in url for frag in _BORING_HOST_FRAGMENTS)


def extract_refs(html: str | None) -> list[dict]:
    """Extract a list of NewsExternalRef-shaped dicts from a chunk of HTML.

    Returns up to _MAX_REFS_PER_ARTICLE refs. Each ref is:
      {kind, url, anchor, role="inline", author=None, ...}

    Duplicates by URL are collapsed (first match wins). Anchor text shorter
    than 2 chars or in the boring-anchor blocklist is dropped.
    """
    if not html:
        return []
    out: list[dict] = []
    seen_urls: set[str] = set()

    for match in _ANCHOR_RX.finditer(html):
        url = match.group(1).strip()
        # Reject mailto:, javascript:, tel:, fragment-only, etc.
        if not url.startswith(("http://", "https://")):
            continue
        if _is_boring_host(url):
            continue
        if url in seen_urls:
            continue

        anchor = _clean_anchor_text(match.group(2))
        if len(anchor) < _MIN_ANCHOR_CHARS:
            continue
        if _is_boring_anchor(anchor):
            continue
        if len(anchor) > _MAX_ANCHOR_CHARS:
            anchor = anchor[:_MAX_ANCHOR_CHARS].rstrip() + "…"

        seen_urls.add(url)
        out.append(
            {
                "kind": detect_kind(url),
                "url": url,
                "anchor": anchor,
                "role": "inline",
                "author": None,
                "handle": None,
                "quote": None,
                "posted_at": None,
                "thumbnail_url": None,
                "duration": None,
            }
        )
        if len(out) >= _MAX_REFS_PER_ARTICLE:
            break

    return out

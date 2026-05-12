from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Optional

from .config import (
    ALLOWED_LICENSE_PATTERNS,
    COMMONS_API,
    MMA_KEYWORDS,
    NAME_SIMILARITY_THRESHOLD,
    WIKI_API,
    WIKI_REST_SUMMARY,
)
from .http import Client
from .utils.logger import log
from .utils.similarity import name_similarity


@dataclass
class WikiCandidate:
    title: str
    url: str
    summary: str
    page_id: int
    thumbnail_url: str | None
    original_image_url: str | None
    image_title: str | None  # like "File:Foo.jpg" — needed for license lookup


@dataclass
class LicenseInfo:
    license_short: str | None
    license_url: str | None
    attribution: str | None
    artist: str | None
    raw_license: str | None
    allowed: bool


def search_titles(client: Client, query: str, *, limit: int = 5) -> list[str]:
    response = client.get(
        WIKI_API,
        params={
            "action": "opensearch",
            "search": query,
            "limit": str(limit),
            "namespace": "0",
            "format": "json",
            "redirects": "resolve",
        },
    )
    if response.status_code >= 400:
        return []
    data = response.json()
    # opensearch returns [query, titles[], descriptions[], urls[]].
    if not isinstance(data, list) or len(data) < 2:
        return []
    return list(data[1])


def fetch_summary(client: Client, title: str) -> dict | None:
    url = WIKI_REST_SUMMARY.format(title=title.replace(" ", "_"))
    response = client.get(url)
    if response.status_code in (404, 410):
        return None
    if response.status_code >= 400:
        return None
    return response.json()


def _looks_like_disambiguation(summary: dict) -> bool:
    if summary.get("type") == "disambiguation":
        return True
    extract = (summary.get("extract") or "").lower()
    return "may refer to" in extract or "refer to:" in extract


def _has_mma_keywords(summary: dict) -> bool:
    text = " ".join(
        [
            summary.get("extract", "") or "",
            summary.get("description", "") or "",
        ]
    ).lower()
    return any(kw in text for kw in MMA_KEYWORDS)


def _extract_image_filename(summary: dict) -> str | None:
    """Pull the underlying File: title used on Wikimedia Commons."""
    original = summary.get("originalimage") or {}
    src = original.get("source") or ""
    if not src:
        thumb = summary.get("thumbnail") or {}
        src = thumb.get("source") or ""
    if not src:
        return None
    m = re.search(r"/([^/]+\.(?:jpg|jpeg|png|gif|webp|svg))(?:/|$)", src, flags=re.IGNORECASE)
    if not m:
        return None
    return f"File:{m.group(1)}"


def find_candidate(
    client: Client,
    *,
    name_en: str,
    nickname: str | None,
    dob: date | None,
    country_code: str | None,
) -> tuple[Optional[WikiCandidate], str]:
    """Return (candidate, reason). Reason explains why we did or didn't match.

    Strategy:
      1. opensearch on the fighter name.
      2. For each title, fetch summary; reject disambiguation pages.
      3. Require name similarity ≥ threshold AND an MMA keyword in summary text.
      4. Return the first qualifying candidate, or None.
    """
    titles = search_titles(client, name_en, limit=5)
    if not titles:
        return None, "no_search_results"

    for title in titles:
        summary = fetch_summary(client, title)
        if summary is None:
            continue
        if _looks_like_disambiguation(summary):
            log.debug(f"{name_en}: skip disambiguation {title!r}")
            continue

        sim = name_similarity(name_en, summary.get("title") or title)
        if sim < NAME_SIMILARITY_THRESHOLD:
            log.debug(f"{name_en}: low name similarity ({sim:.2f}) vs {title!r}")
            continue

        if not _has_mma_keywords(summary):
            log.debug(f"{name_en}: no MMA keywords on {title!r}")
            continue

        thumb = (summary.get("thumbnail") or {}).get("source")
        original = (summary.get("originalimage") or {}).get("source")
        if not thumb and not original:
            return None, "candidate_without_image"

        candidate = WikiCandidate(
            title=summary.get("title") or title,
            url=(summary.get("content_urls") or {}).get("desktop", {}).get("page", ""),
            summary=summary.get("extract") or "",
            page_id=int(summary.get("pageid") or 0),
            thumbnail_url=thumb,
            original_image_url=original,
            image_title=_extract_image_filename(summary),
        )
        return candidate, "ok"

    return None, "no_qualifying_candidate"


def fetch_image_license(client: Client, image_title: str) -> LicenseInfo:
    """Look up license metadata on Wikimedia Commons.

    Returns LicenseInfo with `allowed=False` when no acceptable license is found.
    """
    response = client.get(
        COMMONS_API,
        params={
            "action": "query",
            "titles": image_title,
            "prop": "imageinfo",
            "iiprop": "extmetadata|url|user|artist",
            "format": "json",
        },
    )
    info = LicenseInfo(
        license_short=None,
        license_url=None,
        attribution=None,
        artist=None,
        raw_license=None,
        allowed=False,
    )
    if response.status_code >= 400:
        return info
    data = response.json()
    pages = (data.get("query") or {}).get("pages") or {}
    if not pages:
        return info
    page = next(iter(pages.values()))
    iis = page.get("imageinfo") or []
    if not iis:
        return info
    meta = iis[0].get("extmetadata") or {}

    def _val(key: str) -> str | None:
        node = meta.get(key)
        if not node:
            return None
        v = node.get("value")
        if not isinstance(v, str):
            return None
        return re.sub(r"<[^>]+>", "", v).strip() or None

    license_short = _val("LicenseShortName") or _val("License")
    license_url = _val("LicenseUrl")
    artist = _val("Artist")
    credit = _val("Credit")

    info.license_short = license_short
    info.license_url = license_url
    info.artist = artist
    info.raw_license = license_short

    attribution = artist or credit
    if attribution:
        info.attribution = attribution

    if license_short:
        haystack = license_short.lower()
        info.allowed = any(p in haystack for p in ALLOWED_LICENSE_PATTERNS)

    return info

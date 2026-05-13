from __future__ import annotations

import re
import urllib.parse
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


DISAMBIGUATOR_SUFFIXES = (
    " (fighter)",
    " (mixed martial artist)",
    " (MMA)",
)


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
    """Pull the underlying File: title used on Wikimedia Commons.

    The src URL is already percent-encoded (e.g. `Blue_Angels%27_VIP.jpg`).
    We URL-decode it so callers can pass the bare title to the API — httpx
    will re-encode the value when building the request and the API will then
    match the real file. Double-encoding here would point the API at a
    filename that doesn't exist on Commons.
    """
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
    return f"File:{urllib.parse.unquote(m.group(1))}"


def _build_candidate(summary: dict, fallback_title: str) -> WikiCandidate:
    return WikiCandidate(
        title=summary.get("title") or fallback_title,
        url=(summary.get("content_urls") or {}).get("desktop", {}).get("page", ""),
        summary=summary.get("extract") or "",
        page_id=int(summary.get("pageid") or 0),
        thumbnail_url=(summary.get("thumbnail") or {}).get("source"),
        original_image_url=(summary.get("originalimage") or {}).get("source"),
        image_title=_extract_image_filename(summary),
    )


def _summary_passes_filters(
    summary: dict, *, name_en: str, accept_low_similarity: bool = False
) -> tuple[bool, str]:
    if _looks_like_disambiguation(summary):
        return False, "disambiguation"
    title = summary.get("title") or ""
    if not accept_low_similarity:
        sim = name_similarity(name_en, title)
        if sim < NAME_SIMILARITY_THRESHOLD:
            return False, f"low_similarity({sim:.2f})"
    if not _has_mma_keywords(summary):
        return False, "no_mma_keywords"
    thumb = (summary.get("thumbnail") or {}).get("source")
    original = (summary.get("originalimage") or {}).get("source")
    if not thumb and not original:
        return False, "no_image"
    return True, "ok"


def find_candidate(
    client: Client,
    *,
    name_en: str,
    nickname: str | None,
    dob: date | None,
    country_code: str | None,
) -> tuple[Optional[WikiCandidate], str]:
    """Return (candidate, reason).

    Strategy:
      1. opensearch on `name_en`; iterate summary results with the standard filters.
      2. Fallback: try direct REST summary on disambiguated titles
         (`<name> (fighter)`, `<name> (mixed martial artist)`, `<name> (MMA)`).
         When a title has an explicit "(fighter)" / "(MMA)" suffix the page is *already*
         scoped to the right person, so we allow a lower name-similarity bar there
         (we still require MMA keywords for safety).
    """
    titles = search_titles(client, name_en, limit=5)
    if titles:
        for title in titles:
            summary = fetch_summary(client, title)
            if summary is None:
                continue
            ok, reason = _summary_passes_filters(summary, name_en=name_en)
            if not ok:
                log.debug(f"{name_en}: skip {title!r} ({reason})")
                continue
            return _build_candidate(summary, title), "ok"

    for suffix in DISAMBIGUATOR_SUFFIXES:
        variant = f"{name_en}{suffix}"
        summary = fetch_summary(client, variant)
        if summary is None:
            continue
        ok, reason = _summary_passes_filters(
            summary, name_en=name_en, accept_low_similarity=True
        )
        if not ok:
            log.debug(f"{name_en}: skip variant {variant!r} ({reason})")
            continue
        log.info(f"{name_en}: matched via disambiguator variant {variant!r}")
        return _build_candidate(summary, variant), "ok_disambiguator"

    return None, "no_qualifying_candidate"


# ---------------------------------------------------------------------------
# License resolution
# ---------------------------------------------------------------------------

# Wikitext template names → license string. We map to short names that already
# fall under ALLOWED_LICENSE_PATTERNS.
_TEMPLATE_TO_LICENSE: tuple[tuple[str, str], ...] = (
    (r"\bcc-zero\b", "CC0"),
    (r"\bcc0\b", "CC0"),
    (r"\bcc-by-sa-4\.0\b", "CC BY-SA 4.0"),
    (r"\bcc-by-sa-3\.0\b", "CC BY-SA 3.0"),
    (r"\bcc-by-sa-2\.5\b", "CC BY-SA 2.5"),
    (r"\bcc-by-sa-2\.0\b", "CC BY-SA 2.0"),
    (r"\bcc-by-sa\b", "CC BY-SA"),
    (r"\bcc-by-4\.0\b", "CC BY 4.0"),
    (r"\bcc-by-3\.0\b", "CC BY 3.0"),
    (r"\bcc-by-2\.5\b", "CC BY 2.5"),
    (r"\bcc-by-2\.0\b", "CC BY 2.0"),
    (r"\bcc-by\b", "CC BY"),
    (r"\bpd-self\b", "PD-self"),
    (r"\bpd-usgov[-_\w]*\b", "PD-USGov"),
    (r"\bpd-us[-_\w]*\b", "PD-US"),
    (r"\bpd-author\b", "PD-author"),
    (r"\bpd-release\b", "PD-release"),
    (r"\bpd-art\b", "PD-art"),
    (r"\bpublicdomain\b", "Public domain"),
    (r"\bpublic[-_ ]domain\b", "Public domain"),
    (r"\bgfdl\b", "GFDL"),
)


def _match_license_string(text: str) -> str | None:
    """Return a normalized license short name when `text` contains a known pattern."""
    if not text:
        return None
    haystack = text.lower()
    for pattern, normalized in _TEMPLATE_TO_LICENSE:
        if re.search(pattern, haystack):
            return normalized
    # Fall back to substring scan against the policy-level list.
    for p in ALLOWED_LICENSE_PATTERNS:
        if p in haystack:
            return text.strip()
    return None


def _fetch_commons_wikitext(client: Client, image_title: str) -> str | None:
    """Pull the raw wikitext of the Commons file description page."""
    title = urllib.parse.quote(image_title.replace(" ", "_"), safe=":/")
    url = f"https://commons.wikimedia.org/w/index.php?title={title}&action=raw"
    response = client.get(url)
    if response.status_code in (404, 410):
        return None
    if response.status_code >= 400:
        return None
    return response.text


def fetch_image_license(client: Client, image_title: str) -> LicenseInfo:
    """Resolve license metadata for a Commons file, falling through several sources.

    Order:
      1. extmetadata.LicenseShortName
      2. extmetadata.License
      3. extmetadata.UsageTerms
      4. extmetadata.LicenseTemplate (kept for completeness, rarely populated)
      5. extmetadata.Permission / Copyrighted
      6. Raw wikitext on Commons — scan for `{{cc-by-sa-4.0}}` / `{{PD-USGov}}` / etc.

    Each candidate string runs through `_match_license_string` (and ultimately the
    `ALLOWED_LICENSE_PATTERNS` substring list). The first one that maps to an
    accepted license wins.
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
        # Strip HTML tags and collapse whitespace.
        stripped = re.sub(r"<[^>]+>", " ", v)
        stripped = re.sub(r"\s+", " ", stripped).strip()
        return stripped or None

    license_url = _val("LicenseUrl")
    artist = _val("Artist")
    credit = _val("Credit")

    info.license_url = license_url
    info.artist = artist
    attribution = artist or credit
    if attribution:
        info.attribution = attribution

    candidates: list[tuple[str, str]] = []
    for key in ("LicenseShortName", "License", "UsageTerms", "LicenseTemplate"):
        v = _val(key)
        if v:
            candidates.append((key, v))
    for key in ("Permission", "Copyrighted", "Restrictions"):
        v = _val(key)
        if v:
            candidates.append((key, v))

    for source, value in candidates:
        normalized = _match_license_string(value)
        if normalized:
            info.license_short = normalized
            info.raw_license = value
            info.allowed = True
            log.debug(
                f"{image_title}: license resolved via extmetadata.{source} -> {normalized!r}"
            )
            return info

    # Last-resort: parse wikitext for license templates.
    wikitext = _fetch_commons_wikitext(client, image_title)
    if wikitext:
        # The "Permission" section sometimes wraps templates; the templates themselves
        # are matched directly via _TEMPLATE_TO_LICENSE.
        normalized = _match_license_string(wikitext)
        if normalized:
            info.license_short = normalized
            info.raw_license = "wikitext_template"
            info.allowed = True
            log.debug(f"{image_title}: license resolved via wikitext -> {normalized!r}")
            return info

    # No accepted license found. Surface whatever we read for forensics.
    if candidates:
        info.license_short = candidates[0][1][:120]
        info.raw_license = candidates[0][1]
    return info

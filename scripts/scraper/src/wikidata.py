"""Wikipedia title → Wikidata QID → P27 (country of citizenship) → ISO 3166-1 alpha-2.

Used by `06_backfill_country.py` to fill `fighter.country_code`. UFCStats does
not publish nationality data, so we rely on each fighter's Wikipedia article and
the structured citizenship claim on its Wikidata entity.

Two-step lookup, single function for callers:

1. `wbgetentities?sites=enwiki&titles=<title>&props=claims` — returns the
   entity's full claim set keyed by Q-id, no separate "title → QID" hop needed.
2. Read the P27 claim. If multiple values exist (dual citizenship), prefer
   `preferred` rank, then `normal`, drop `deprecated`. Take the first remaining.
3. Map the value's data-value `id` (e.g. `Q159`) → ISO alpha-2 via WIKIDATA_COUNTRY_TO_ISO.

When P27 is missing (article without the claim, or no Wikidata entity at all),
we return `(None, reason)` so the caller can log/skip.
"""

from __future__ import annotations

import urllib.parse
from typing import Iterable, Optional

import httpx


WIKIDATA_API = "https://www.wikidata.org/w/api.php"


# Wikidata QID → ISO 3166-1 alpha-2.
#
# This list intentionally errs on the side of "MMA-relevant" countries — we
# expect ~99% of UFC fighters to come from this set. If a fighter resolves to
# a QID not in this map, we leave country_code NULL and log the QID for a
# follow-up sweep rather than guessing.
WIKIDATA_COUNTRY_TO_ISO: dict[str, str] = {
    # Americas
    "Q30": "US",
    "Q16": "CA",
    "Q96": "MX",
    "Q155": "BR",
    "Q414": "AR",
    "Q298": "CL",
    "Q733": "PY",
    "Q77": "UY",
    "Q717": "VE",
    "Q739": "CO",
    "Q419": "PE",
    "Q241": "CU",
    "Q800": "CR",
    "Q804": "PA",
    "Q242": "BZ",
    "Q763": "JM",
    "Q786": "DO",
    "Q734": "GY",
    "Q736": "EC",
    "Q750": "BO",
    "Q811": "NI",
    "Q774": "GT",
    "Q792": "SV",
    "Q783": "HN",
    # Europe
    "Q145": "GB",
    "Q21": "GB",   # England (subdivision, but commonly mapped to GB in casual data)
    "Q22": "GB",   # Scotland
    "Q25": "GB",   # Wales
    "Q26": "GB",   # Northern Ireland
    "Q27": "IE",
    "Q142": "FR",
    "Q183": "DE",
    "Q38": "IT",
    "Q29": "ES",
    "Q45": "PT",
    "Q55": "NL",
    "Q31": "BE",
    "Q39": "CH",
    "Q40": "AT",
    "Q34": "SE",
    "Q33": "FI",
    "Q35": "DK",
    "Q20": "NO",
    "Q189": "IS",
    "Q36": "PL",
    "Q213": "CZ",
    "Q214": "SK",
    "Q28": "HU",
    "Q41": "GR",
    "Q229": "CY",
    "Q224": "HR",
    "Q403": "RS",
    "Q236": "ME",
    "Q221": "MK",
    "Q225": "BA",
    "Q215": "SI",
    "Q222": "AL",
    "Q218": "RO",
    "Q219": "BG",
    "Q37": "LT",
    "Q211": "LV",
    "Q191": "EE",
    "Q347": "LI",
    "Q32": "LU",
    "Q233": "MT",
    "Q235": "MC",
    "Q228": "AD",
    "Q238": "SM",
    "Q237": "VA",
    # Eurasia / former USSR
    "Q159": "RU",
    "Q212": "UA",
    "Q184": "BY",
    "Q217": "MD",
    "Q230": "GE",
    "Q399": "AM",
    "Q227": "AZ",
    "Q232": "KZ",
    "Q813": "KG",
    "Q265": "UZ",
    "Q863": "TJ",
    "Q874": "TM",
    # Middle East / North Africa
    "Q43": "TR",
    "Q794": "IR",
    "Q801": "IL",
    "Q796": "IQ",
    "Q805": "YE",
    "Q810": "JO",
    "Q822": "LB",
    "Q858": "SY",
    "Q851": "SA",
    "Q878": "AE",
    "Q846": "QA",
    "Q817": "KW",
    "Q398": "BH",
    "Q842": "OM",
    "Q79": "EG",
    "Q1028": "MA",
    "Q262": "DZ",
    "Q948": "TN",
    "Q1016": "LY",
    # Sub-Saharan Africa
    "Q1033": "NG",
    "Q258": "ZA",
    "Q1009": "CM",
    "Q1019": "MG",
    "Q1037": "RW",
    "Q1006": "GN",
    "Q1027": "MU",
    "Q1041": "SN",
    "Q1042": "SC",
    "Q114": "KE",
    "Q1029": "MZ",
    "Q1036": "UG",
    "Q924": "TZ",
    "Q117": "GH",
    "Q1008": "CI",
    "Q953": "ZM",
    "Q954": "ZW",
    "Q945": "TG",
    "Q1007": "GW",
    "Q967": "BI",
    "Q1014": "LR",
    "Q1013": "LS",
    "Q1020": "MW",
    "Q1032": "NE",
    "Q1005": "GM",
    # Asia
    "Q17": "JP",
    "Q148": "CN",
    "Q865": "TW",
    "Q884": "KR",
    "Q423": "KP",
    "Q668": "IN",
    "Q843": "PK",
    "Q902": "BD",
    "Q854": "LK",
    "Q837": "NP",
    "Q917": "BT",
    "Q928": "PH",
    "Q252": "ID",
    "Q833": "MY",
    "Q334": "SG",
    "Q869": "TH",
    "Q881": "VN",
    "Q424": "KH",
    "Q819": "LA",
    "Q836": "MM",
    "Q574": "TL",
    "Q889": "AF",
    "Q826": "MV",
    "Q711": "MN",
    # Oceania
    "Q408": "AU",
    "Q664": "NZ",
    "Q691": "PG",
    "Q702": "FJ",
    "Q683": "WS",
    "Q686": "VU",
    "Q685": "SB",
    "Q697": "NR",
    "Q672": "TV",
    "Q678": "TO",
    "Q710": "KI",
}


# Higher-rank value preferred when multiple P27 claims exist.
RANK_ORDER = {"preferred": 0, "normal": 1, "deprecated": 2}


class WikidataLookupError(Exception):
    """Raised for unexpected payload shapes — caller logs and skips."""


def _http_get_json(client: httpx.Client, url: str, params: dict) -> dict:
    """Single GET returning JSON. Raises WikidataLookupError on 4xx/5xx."""
    response = client.get(url, params=params)
    if response.status_code >= 400:
        raise WikidataLookupError(
            f"GET {url} -> {response.status_code} {response.text[:200]!r}"
        )
    try:
        return response.json()
    except Exception as exc:  # noqa: BLE001
        raise WikidataLookupError(f"non-JSON response from {url}: {exc!r}") from exc


def _select_best_p27_claim(claims: list[dict]) -> Optional[dict]:
    """Return the highest-ranked, non-deprecated P27 claim."""
    ranked = sorted(
        (c for c in claims if c.get("rank") != "deprecated"),
        key=lambda c: RANK_ORDER.get(c.get("rank", "normal"), 99),
    )
    return ranked[0] if ranked else None


def country_for_wiki_title(
    client: httpx.Client,
    title: str,
) -> tuple[Optional[str], str]:
    """Resolve a Wikipedia article title to an ISO 3166-1 alpha-2 country code.

    Returns (iso_code, reason). When iso_code is None, `reason` explains why
    (no entity / no P27 / unmapped Q-id / fetch error).
    """
    # Wikidata accepts a Wikipedia title via the `sites`/`titles` pair; this
    # bypasses the explicit title→QID hop and returns the full entity in one
    # request. Title normalization (spaces vs underscores) is handled server-side.
    params = {
        "action": "wbgetentities",
        "sites": "enwiki",
        "titles": title,
        "props": "claims",
        "format": "json",
        "languages": "en",
    }
    try:
        data = _http_get_json(client, WIKIDATA_API, params)
    except WikidataLookupError as exc:
        return None, f"fetch_error:{exc}"

    entities = data.get("entities") or {}
    if not entities:
        return None, "no_entity"

    # Single result expected. The key is the QID.
    entity_id, entity = next(iter(entities.items()))
    if entity.get("missing") is not None or not entity_id.startswith("Q"):
        return None, "no_entity"

    claims = (entity.get("claims") or {}).get("P27") or []
    if not claims:
        return None, "no_p27"

    best = _select_best_p27_claim(claims)
    if best is None:
        return None, "no_p27_after_rank_filter"

    mainsnak = best.get("mainsnak") or {}
    datavalue = mainsnak.get("datavalue") or {}
    value = datavalue.get("value") or {}
    country_qid = value.get("id")
    if not country_qid:
        return None, "p27_no_qid"

    iso = WIKIDATA_COUNTRY_TO_ISO.get(country_qid)
    if not iso:
        return None, f"unmapped_qid:{country_qid}"
    return iso, "ok"


# ---------------------------------------------------------------------------
# Wikipedia article-title resolution (without requiring an image)
# ---------------------------------------------------------------------------

WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_REST_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"

DISAMBIGUATOR_SUFFIXES = (
    " (fighter)",
    " (mixed martial artist)",
    " (MMA)",
)

NAME_SIMILARITY_THRESHOLD = 0.80

MMA_KEYWORDS = (
    "mixed martial artist",
    "mixed martial arts",
    " mma ",
    "ultimate fighting championship",
    "ufc",
    "bellator",
    "pfl ",
    "professional fighters league",
    "one championship",
    "rizin",
    "strikeforce",
    "pride fc",
    "kickboxer",
)


def _normalize_name(s: str) -> str:
    return "".join(ch.lower() for ch in s if ch.isalnum() or ch.isspace()).strip()


def _name_similarity(a: str, b: str) -> float:
    """Cheap token-overlap similarity — same shape as photo_scraper.utils.similarity."""
    na, nb = set(_normalize_name(a).split()), set(_normalize_name(b).split())
    if not na or not nb:
        return 0.0
    return len(na & nb) / max(len(na), len(nb))


def _search_titles(client: httpx.Client, query: str, *, limit: int = 5) -> list[str]:
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
    try:
        data = response.json()
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(data, list) or len(data) < 2:
        return []
    return list(data[1])


def _fetch_summary(client: httpx.Client, title: str) -> dict | None:
    url = WIKI_REST_SUMMARY.format(
        title=urllib.parse.quote(title.replace(" ", "_"), safe="")
    )
    response = client.get(url)
    if response.status_code in (404, 410) or response.status_code >= 400:
        return None
    try:
        return response.json()
    except Exception:  # noqa: BLE001
        return None


def _is_disambiguation(summary: dict) -> bool:
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


def find_article_title(
    client: httpx.Client,
    name_en: str,
    *,
    extra_queries: Iterable[str] = (),
) -> tuple[Optional[str], str]:
    """Locate the Wikipedia article that corresponds to `name_en`.

    Returns (title, reason). Title is normalized as Wikipedia returned it
    (spaces, no underscores) and is ready for `wbgetentities`.

    Strategy mirrors `photo_scraper.wikipedia.find_candidate` but drops the
    image requirement — many fighters have articles without a freely-licensed
    portrait, and we still want their country.
    """
    queries: list[str] = [name_en, *extra_queries]
    seen: set[str] = set()

    for q in queries:
        for title in _search_titles(client, q, limit=5):
            if title in seen:
                continue
            seen.add(title)
            summary = _fetch_summary(client, title)
            if summary is None:
                continue
            if _is_disambiguation(summary):
                continue
            sim = _name_similarity(name_en, title)
            if sim < NAME_SIMILARITY_THRESHOLD:
                continue
            if not _has_mma_keywords(summary):
                continue
            return title, "ok"

    for suffix in DISAMBIGUATOR_SUFFIXES:
        variant = f"{name_en}{suffix}"
        summary = _fetch_summary(client, variant)
        if summary is None:
            continue
        if _is_disambiguation(summary):
            continue
        # Suffix-disambiguated titles are already MMA-scoped; we still verify
        # to guard against soft-redirects.
        if not _has_mma_keywords(summary):
            continue
        title = summary.get("title") or variant
        return title, "ok_disambiguator"

    return None, "no_qualifying_article"

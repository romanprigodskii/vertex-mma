#!/usr/bin/env python3
"""Parse imports/ufc_rankings_raw/*.html → imports/ufc_rankings_parsed.csv.

Wave 6C.1 task 3. Two parser strategies:

  parse_modern()  for 2018-09 onward (Drupal `views-field` + `view-grouping`).
  parse_legacy()  for 2017 → 2018-08 (`ranking-list tall` + `weight-class-name`).

Dispatch on HTML content (not filename date) so a Wayback re-archival
of a stale page during the modern era still parses with the legacy
strategy if that's what the HTML actually contains.

Output CSV: snapshot_date, division, is_women, rank, fighter_name_raw, source_url
  - rank=0 means champion; ranks 1..15 are contenders.
  - division uses the `weight_class` enum spelling expected by Postgres
    (e.g. 'light_heavyweight'). The enum is gender-agnostic, so
    is_women (true/false) disambiguates men's vs women's flyweight /
    bantamweight rankings.

Skips per spec:
  - Men's & Women's Pound-for-Pound
  - Women's Featherweight (dormant since 2023)

A handful of Wayback captures came back in non-English locales (German /
French — saw 3 of 233 files). Division-name detection therefore tries a
multi-locale lookup first, with a positional fallback when no locale
matches (the page's division ordering has been stable since 2017).

Names are HTML-unescaped at write time (UFC encodes apostrophes as
&#039; — affects ~230 rows like Sean O'Malley, Casey O'Neill).

Coverage report at end: total files, parsed/unparseable counts, rows by
year, schema-variant tally. Per spec, a >30% unparseable rate exits 2.
"""
from __future__ import annotations

import csv
import html as html_lib
import logging
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "imports" / "ufc_rankings_raw"
OUT_CSV = ROOT / "imports" / "ufc_rankings_parsed.csv"
LOG_PATH = ROOT / "scripts" / "parse_ufc_rankings.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, mode="w"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)

# weight_class enum values from src/lib/db/schema/enums.ts. Strawweight is
# UFC women-exclusive; the Women's Featherweight enum doesn't exist (we
# skip the division entirely per spec).
DIV_FW = "flyweight"
DIV_BW = "bantamweight"
DIV_FEA = "featherweight"
DIV_LW = "lightweight"
DIV_WW = "welterweight"
DIV_MW = "middleweight"
DIV_LHW = "light_heavyweight"
DIV_HW = "heavyweight"
DIV_WSW = "strawweight"  # women's strawweight (women-exclusive enum)
DIV_WFLW = "flyweight"  # women's flyweight — same enum, position disambiguates
DIV_WBW = "bantamweight"  # women's bantamweight — same enum, position disambiguates
SKIP = "__SKIP__"

# Multi-locale division-name → enum + gender hint mapping. Returned tuple
# is (enum_value, is_women). Pound-for-Pound and Women's Featherweight
# both map to SKIP per spec.
DIVISION_TITLES: dict[str, tuple[str, bool]] = {
    # English (men's)
    "flyweight": (DIV_FW, False),
    "bantamweight": (DIV_BW, False),
    "featherweight": (DIV_FEA, False),
    "lightweight": (DIV_LW, False),
    "welterweight": (DIV_WW, False),
    "middleweight": (DIV_MW, False),
    "light heavyweight": (DIV_LHW, False),
    "heavyweight": (DIV_HW, False),
    # English (women's — match more specific keys before the men's ones)
    "women's strawweight": (DIV_WSW, True),
    "women's flyweight": (DIV_WFLW, True),
    "women's bantamweight": (DIV_WBW, True),
    "women's featherweight": (SKIP, True),
    # P4P
    "pound-for-pound": (SKIP, False),
    "men's pound-for-pound": (SKIP, False),
    "women's pound-for-pound": (SKIP, True),
    # German
    "fliegengewicht": (DIV_FW, False),
    "bantamgewicht": (DIV_BW, False),
    "federgewicht": (DIV_FEA, False),
    "leicht": (DIV_LW, False),
    "weltergewicht": (DIV_WW, False),
    "mittelgewicht": (DIV_MW, False),
    "halbschwergewicht": (DIV_LHW, False),
    "schwergewicht": (DIV_HW, False),
    "strohhalm für frauen": (DIV_WSW, True),
    "frauen fliegengewicht": (DIV_WFLW, True),
    "frauen bantamgewicht": (DIV_WBW, True),
    # French
    "poids mouche": (DIV_FW, False),
    "poids coq": (DIV_BW, False),
    "poids plume": (DIV_FEA, False),
    "poids léger": (DIV_LW, False),
    "poids leger": (DIV_LW, False),
    "poids welter": (DIV_WW, False),
    "poids moyen": (DIV_MW, False),
    "poids mi-lourd": (DIV_LHW, False),
    "poids mi lourd": (DIV_LHW, False),
    "poids lourd": (DIV_HW, False),
    "paille femmes": (DIV_WSW, True),
    "mouche femmes": (DIV_WFLW, True),
    "coq femmes": (DIV_WBW, True),
}

# Standard ordering UFC has used since at least 2017. Used as a fallback
# when DIVISION_TITLES doesn't match (locale we haven't catalogued, or a
# corrupted header). Modern layout has Women's P4P slot inserted between
# men's HW and women's SW; legacy doesn't.
POSITIONAL_LEGACY = [
    SKIP,         # 1: P4P
    (DIV_FW, False), (DIV_BW, False), (DIV_FEA, False), (DIV_LW, False),
    (DIV_WW, False), (DIV_MW, False), (DIV_LHW, False), (DIV_HW, False),
    (DIV_WSW, True), (DIV_WBW, True), (SKIP, True),  # last is W-FW
]
POSITIONAL_MODERN = [
    SKIP,         # 1: Men's P4P
    (DIV_FW, False), (DIV_BW, False), (DIV_FEA, False), (DIV_LW, False),
    (DIV_WW, False), (DIV_MW, False), (DIV_LHW, False), (DIV_HW, False),
    SKIP,         # 10: Women's P4P
    (DIV_WSW, True), (DIV_WFLW, True), (DIV_WBW, True),
]


def lookup_division(
    title: str | None,
    position: int,
    table: list,
) -> tuple[str, bool] | None:
    """Title → (division_enum, is_women) or None to skip the section."""
    if title:
        key = title.strip().lower()
        # Strip trailing markers ("Top Rank" badge in modern P4P headers).
        key = re.sub(r"\s+top rank.*$", "", key)
        if key in DIVISION_TITLES:
            value = DIVISION_TITLES[key]
            return None if value[0] == SKIP else value
    # Positional fallback. Position is 1-indexed (matches the table list
    # index after we offset by -1).
    if 1 <= position <= len(table):
        value = table[position - 1]
        if value == SKIP:
            return None
        return value
    return None


def snapshot_date_from_filename(fn: str) -> str:
    """20240811.html → 2024-08-11."""
    stem = Path(fn).stem
    return f"{stem[0:4]}-{stem[4:6]}-{stem[6:8]}"


_WHITESPACE_RE = re.compile(r"\s+")
_TRAILING_PAREN_RE = re.compile(r"\s*\([^)]+\)\s*$")


def clean_name(raw: str) -> str:
    """Normalise a captured fighter name. Some <a> bodies contain bonus
    text on a second line — e.g. 2017's Max Holloway anchor held both
    'Max Holloway' AND '(Interim Champion)' separated by tabs/newlines.
    We collapse whitespace, then drop a single trailing parenthetical
    role marker so we end up with just the fighter's display name."""
    s = html_lib.unescape(raw)
    s = _WHITESPACE_RE.sub(" ", s).strip()
    s = _TRAILING_PAREN_RE.sub("", s).strip()
    return s


# --------------------------------------------------------------------------
# parse_modern — 2018-09 onward (Drupal views + view-grouping wrapper)
# --------------------------------------------------------------------------
MODERN_GROUP_RE = re.compile(
    r'view-grouping-header"[^>]*>([^<]+)<(.*?)(?=view-grouping-header|</section)',
    re.DOTALL,
)
# Champion's name is in the <h5><a>NAME</a></h5> *inside* the
# rankings--athlete--champion block. The 2019-2022 captures wrap that
# anchor in extra Drupal "view view-athletes" divs, so we lazily accept
# any markup between <h5> and the first <a> inside it.
MODERN_CHAMPION_RE = re.compile(
    r'rankings--athlete--champion.*?<h5[^>]*>.*?<a[^>]*>\s*([^<]+?)\s*</a>',
    re.DOTALL,
)
MODERN_TBODY_RE = re.compile(r'<tbody>(.*?)</tbody>', re.DOTALL)
# Same wrapper-divs problem in the contender rows: 2019-2022 captures
# nest the fighter <a> inside view-content/views-row divs. Lazy `.*?<a`
# between the title cell and the anchor handles both layouts.
MODERN_ROW_RE = re.compile(
    r'views-field-weight-class-rank">\s*(\d+)\s*</td>\s*'
    r'<td[^>]*views-field-title">.*?<a[^>]*>\s*([^<]+?)\s*</a>',
    re.DOTALL,
)
MODERN_TOPRANK_HINT_RE = re.compile(r"top rank|p4p", re.IGNORECASE)


def parse_modern(html: str, snapshot_date: str, source_url: str) -> list[tuple]:
    rows: list[tuple] = []
    groups = list(MODERN_GROUP_RE.finditer(html))
    if not groups:
        return rows
    # Position index for fallback. Each MODERN_GROUP_RE hit is one section.
    for pos, m in enumerate(groups, start=1):
        header_text, body = m.group(1), m.group(2)
        div = lookup_division(header_text, pos, POSITIONAL_MODERN)
        if div is None:
            continue
        division, is_women = div
        # Champion (rank 0) — ignore champion-block in P4P groups (already
        # filtered out by lookup_division returning None for SKIP).
        if not MODERN_TOPRANK_HINT_RE.search(header_text):
            cm = MODERN_CHAMPION_RE.search(body)
            if cm:
                rows.append((
                    snapshot_date, division, is_women, 0,
                    clean_name(cm.group(1)), source_url,
                ))
        # Contenders (rank 1..N from <tbody>).
        tb = MODERN_TBODY_RE.search(body)
        if tb:
            for rm in MODERN_ROW_RE.finditer(tb.group(1)):
                rank = int(rm.group(1))
                rows.append((
                    snapshot_date, division, is_women, rank,
                    clean_name(rm.group(2)), source_url,
                ))
    return rows


# --------------------------------------------------------------------------
# parse_legacy — 2017 → 2018-08 (`<div class="ranking-list tall">` blocks)
# --------------------------------------------------------------------------
LEGACY_BLOCK_RE = re.compile(
    r'weight-class-name[^>]*>\s*([^<]+?)\s*<(.*?)(?=weight-class-name|</body)',
    re.DOTALL,
)
# The 2017-2018 legacy markup nests the champion's <a> two divs deep:
#   <div class="rankings-champions">
#     <div id="champion-fighter">
#       Champion: <span id="champion-fighter-name"><a>NAME</a></span>
#     </div>
#   </div>
# A lazy ".rankings-champions.*?<a" would falsely match the first contender
# anchor in P4P (where rankings-champions is empty), so we anchor on the
# more specific "champion-fighter-name" span — that string is only present
# when the division has a real champion. UFC.com's 2017-2018 rankings page
# didn't visually distinguish interim from undisputed champions; whoever
# held the belt got the "Champion" label, which matches our rank=0 slot.
LEGACY_CHAMPION_RE = re.compile(
    r'champion-fighter-name[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*</a>',
    re.DOTALL,
)
LEGACY_ROW_RE = re.compile(
    r'number-column">\s*(\d+)\s*</td>\s*'
    r'<td[^>]*name-column"[^<]*'
    r'<a[^>]*>\s*([^<]+?)\s*</a>',
    re.DOTALL,
)


def parse_legacy(html: str, snapshot_date: str, source_url: str) -> list[tuple]:
    rows: list[tuple] = []
    blocks = list(LEGACY_BLOCK_RE.finditer(html))
    if not blocks:
        return rows
    for pos, m in enumerate(blocks, start=1):
        header_text, body = m.group(1), m.group(2)
        div = lookup_division(header_text, pos, POSITIONAL_LEGACY)
        if div is None:
            continue
        division, is_women = div
        cm = LEGACY_CHAMPION_RE.search(body)
        if cm:
            rows.append((
                snapshot_date, division, is_women, 0,
                clean_name(cm.group(1)), source_url,
            ))
        for rm in LEGACY_ROW_RE.finditer(body):
            rank = int(rm.group(1))
            rows.append((
                snapshot_date, division, is_women, rank,
                clean_name(rm.group(2)), source_url,
            ))
    return rows


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------
def detect_schema(html: str) -> str:
    """Returns 'modern' | 'legacy' | 'unknown'."""
    has_modern = "views-field-weight-class-rank" in html
    has_legacy = "ranking-list tall" in html
    if has_modern:
        return "modern"
    if has_legacy:
        return "legacy"
    return "unknown"


def main() -> None:
    files = sorted(p for p in RAW_DIR.glob("*.html"))
    if not files:
        log.error("No HTML files in %s", RAW_DIR)
        sys.exit(1)
    log.info("Parsing %d files...", len(files))

    schema_counts: Counter[str] = Counter()
    rows_per_year: defaultdict[int, int] = defaultdict(int)
    parsed = 0
    unparseable: list[str] = []

    with OUT_CSV.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow([
            "snapshot_date", "division", "is_women", "rank",
            "fighter_name_raw", "source_url",
        ])
        for path in files:
            html = path.read_text(encoding="utf-8", errors="replace")
            snapshot_date = snapshot_date_from_filename(path.name)
            source_url = (
                f"https://web.archive.org/web/{path.stem}000000/"
                f"https://www.ufc.com/rankings"
            )
            schema = detect_schema(html)
            schema_counts[schema] += 1
            if schema == "modern":
                rows = parse_modern(html, snapshot_date, source_url)
            elif schema == "legacy":
                rows = parse_legacy(html, snapshot_date, source_url)
            else:
                rows = []
            if not rows:
                unparseable.append(path.name)
                log.warning("%s: 0 rows (schema=%s)", path.name, schema)
                continue
            parsed += 1
            year = int(snapshot_date[:4])
            rows_per_year[year] += len(rows)
            w.writerows(rows)

    # ---- Coverage report ----
    log.info("=" * 60)
    log.info(
        "Parsed: %d / %d files  (unparseable: %d)",
        parsed, len(files), len(unparseable),
    )
    log.info("Schema dispatch: %s", dict(schema_counts))
    log.info("Rows by year:")
    for year in sorted(rows_per_year):
        log.info("  %d: %d rows", year, rows_per_year[year])
    log.info("Total rows written: %d", sum(rows_per_year.values()))
    if unparseable:
        log.info("Unparseable files (%d):", len(unparseable))
        for fn in unparseable:
            log.info("  %s", fn)

    pct_unparseable = len(unparseable) / len(files)
    if pct_unparseable > 0.30:
        log.error(
            "FAIL: %.0f%% files unparseable (>30%% threshold); review before importing",
            pct_unparseable * 100,
        )
        sys.exit(2)
    log.info("DONE → %s", OUT_CSV)


if __name__ == "__main__":
    main()

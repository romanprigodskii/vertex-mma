"""Sherdog fight-finder search, fighter-page parsing and identity matching.

Sherdog is the source of truth for a fighter's FULL career (regional
promotions included) — UFCStats only knows UFC bouts. We use it to close
the pre-UFC information gap: the sim model's debut segment was ~59% vs the
market's ~75% purely because bookmakers see "15-0, 12 KOs on the regional
scene" where we saw NaN.

Matching strategy (precision over recall — a wrong match poisons the
features silently, an unmatched fighter just stays NaN):

1. Fight-overlap verification (fighters with ≥1 completed UFC bout in our
   DB): a candidate's Sherdog history must share at least one fight with
   our records — event date within ±1 day AND the opponent surname
   matching. Practically unforgeable.
2. DOB verification (true upcoming debutants — no UFC bouts yet): exact
   date-of-birth match plus name similarity. When Sherdog has no DOB we
   accept only a near-exact unique name match backed by height.

Parsing uses selectolax like the other parsers. All functions are pure
(no HTTP, no DB) so they're unit-testable; the step script wires them to
`http.Client` and psycopg.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import date, timedelta

from selectolax.parser import HTMLParser

from .utils.dates import parse_round_time

SHERDOG_BASE_URL = "https://www.sherdog.com"
FIGHT_FINDER_URL = SHERDOG_BASE_URL + "/stats/fightfinder?SearchTxt={query}"
FIGHTER_URL_TEMPLATE = SHERDOG_BASE_URL + "/fighter/x-{sherdog_id}"

_FIGHTER_HREF_RE = re.compile(r"/fighter/([A-Za-z0-9-]*?)-?(\d+)/?$")
_METERS_RE = re.compile(r"\(([\d.]+)\s*m\)")
_DATE_RE = re.compile(r"([A-Za-z]{3})\s*/\s*(\d{1,2})\s*/\s*(\d{4})")
_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
# UFC events on Sherdog: "UFC 317 - ...", "UFC Fight Night ...", "UFC on
# ESPN ...", plus TUF finales ("UFC - The Ultimate Fighter ... Finale").
# The step script ALSO date-matches rows against the fighter's UFC bouts
# in our DB, so this pattern is belt and the DB check is suspenders.
_UFC_EVENT_RE = re.compile(r"^UFC\b|\bUltimate Fighter\b", re.IGNORECASE)

_RESULTS = {"win", "loss", "draw", "nc", "no contest"}


@dataclass
class SherdogCandidate:
    sherdog_id: str
    name: str
    nickname: str | None = None
    height_cm: int | None = None
    similarity: float = 0.0


@dataclass
class SherdogFight:
    result: str  # 'win' | 'loss' | 'draw' | 'nc'
    opponent_name: str
    opponent_sherdog_id: str | None
    event_name: str
    event_date: date | None
    method: str | None
    method_class: str | None  # 'ko' | 'submission' | 'decision' | 'other'
    round: int | None
    time_seconds: int | None
    is_ufc: bool = False


@dataclass
class SherdogProfile:
    name: str | None
    nickname: str | None
    birth_date: date | None
    fights: list[SherdogFight] = field(default_factory=list)


# --------------------------------------------------------------------------
# Name normalization (diacritics-folding — Sherdog writes "Jose Aldo",
# our DB has "José Aldo"; wikidata's _normalize_name doesn't fold, so we
# keep our own here).
# --------------------------------------------------------------------------


def ascii_fold(value: str) -> str:
    return (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
    )


def normalize_name(value: str) -> str:
    folded = ascii_fold(value).lower()
    return " ".join(re.sub(r"[^a-z0-9 ]+", " ", folded).split())


def name_similarity(a: str, b: str) -> float:
    """Token-set overlap (same shape as src/wikidata.py) over folded names."""
    ta = set(normalize_name(a).split())
    tb = set(normalize_name(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))


def surnames_match(a: str, b: str) -> bool:
    """Loose opponent-name check for fight-overlap verification. Last
    token equality catches "Alex Volkanovski" vs "Alexander Volkanovski";
    the 0.5 similarity fallback catches reordered/multi-part surnames
    ("Dos Santos, Junior")."""
    ta = normalize_name(a).split()
    tb = normalize_name(b).split()
    if not ta or not tb:
        return False
    if ta[-1] == tb[-1]:
        return True
    return name_similarity(a, b) >= 0.5


# --------------------------------------------------------------------------
# Parsers
# --------------------------------------------------------------------------


def _sherdog_id_from_href(href: str | None) -> str | None:
    if not href:
        return None
    m = _FIGHTER_HREF_RE.search(href.split("?")[0])
    return m.group(2) if m else None


def _parse_finder_height_cm(cell_text: str) -> int | None:
    m = _METERS_RE.search(cell_text)
    if not m:
        return None
    try:
        return round(float(m.group(1)) * 100)
    except ValueError:
        return None


def parse_fight_finder(html: str) -> list[SherdogCandidate]:
    """Rows of the fight-finder results table. The page also carries
    trending-fighter modules with /fighter/ links — we only read the
    `.fightfinder_result` table(s)."""
    tree = HTMLParser(html)
    out: list[SherdogCandidate] = []
    seen: set[str] = set()
    for table in tree.css("table.fightfinder_result"):
        for row in table.css("tr"):
            link = None
            for a in row.css("a"):
                if _sherdog_id_from_href(a.attributes.get("href")):
                    link = a
                    break
            if link is None:
                continue
            sherdog_id = _sherdog_id_from_href(link.attributes.get("href"))
            name = link.text(strip=True)
            if not sherdog_id or not name or sherdog_id in seen:
                continue
            seen.add(sherdog_id)
            cells = [td.text(strip=True) for td in row.css("td")]
            nickname = None
            height_cm = None
            # Layout: photo | fighter | nickname | height | weight | assoc.
            # Be defensive about the exact offsets — find by content.
            for cell in cells:
                if height_cm is None:
                    height_cm = _parse_finder_height_cm(cell)
            if len(cells) >= 3:
                nick = cells[2].strip().strip('"').strip("“”")
                nickname = nick or None
            out.append(
                SherdogCandidate(
                    sherdog_id=sherdog_id,
                    name=name,
                    nickname=nickname,
                    height_cm=height_cm,
                )
            )
    return out


def parse_birth_date(text: str) -> date | None:
    text = text.strip()
    m = re.match(r"([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})", text)
    if not m:
        return None
    month = _MONTHS.get(m.group(1)[:3].lower())
    if not month:
        return None
    try:
        d = date(int(m.group(3)), month, int(m.group(2)))
    except ValueError:
        return None
    # Sherdog uses 1900-01-01-ish placeholders when only the year (or
    # nothing) is known — those would veto legitimate matches.
    if d.year < 1930:
        return None
    return d


def classify_method(raw: str | None) -> str | None:
    if not raw:
        return None
    u = raw.strip().upper()
    if u.startswith(("KO", "TKO")):
        return "ko"
    if "SUBMISSION" in u:
        return "submission"
    if "DECISION" in u:
        return "decision"
    return "other"


def _parse_history_date(text: str) -> date | None:
    m = _DATE_RE.search(text)
    if not m:
        return None
    month = _MONTHS.get(m.group(1).lower())
    if not month:
        return None
    try:
        d = date(int(m.group(3)), month, int(m.group(2)))
    except ValueError:
        return None
    if d.year < 1970:  # "Jan / 01 / 0001" unknown-date placeholder
        return None
    return d


def _pro_history_chunk(html: str) -> str | None:
    """The markup slice between the "FIGHT HISTORY - PRO" slanted title and
    the next section title (or EOF). Amateur / exhibition histories live
    under their own titles and are deliberately skipped."""
    titles = list(
        re.finditer(
            r'<div class="slanted_title">\s*<div[^>]*>([^<]*)</div>', html
        )
    )
    for i, m in enumerate(titles):
        title = m.group(1).strip().upper()
        if title == "FIGHT HISTORY - PRO":
            start = m.end()
            end = titles[i + 1].start() if i + 1 < len(titles) else len(html)
            return html[start:end]
    return None


def parse_fighter_page(html: str) -> SherdogProfile:
    tree = HTMLParser(html)

    name = None
    name_node = tree.css_first('[itemprop="name"] .fn, span.fn')
    if name_node is not None:
        name = name_node.text(strip=True) or None

    nickname = None
    nick_node = tree.css_first("span.nickname em, .nickname em")
    if nick_node is not None:
        nickname = nick_node.text(strip=True) or None

    birth_date = None
    bd_node = tree.css_first('[itemprop="birthDate"]')
    if bd_node is not None:
        birth_date = parse_birth_date(bd_node.text(strip=True))

    fights: list[SherdogFight] = []
    chunk = _pro_history_chunk(html)
    if chunk:
        chunk_tree = HTMLParser(chunk)
        for row in chunk_tree.css("tr"):
            res_node = row.css_first("span.final_result")
            if res_node is None:
                continue  # header row
            result = res_node.text(strip=True).lower()
            if result == "no contest":
                result = "nc"
            if result not in _RESULTS:
                continue
            cells = row.css("td")
            if len(cells) < 6:
                continue
            opp_link = cells[1].css_first("a")
            opponent_name = (
                opp_link.text(strip=True)
                if opp_link is not None
                else cells[1].text(strip=True)
            )
            opponent_sherdog_id = (
                _sherdog_id_from_href(opp_link.attributes.get("href"))
                if opp_link is not None
                else None
            )
            event_link = cells[2].css_first("a")
            event_name = (
                event_link.text(strip=True)
                if event_link is not None
                else cells[2].text(strip=True)
            )
            event_date = _parse_history_date(cells[2].text())
            method_node = cells[3].css_first("b")
            method = (
                method_node.text(strip=True) if method_node is not None else None
            ) or None
            round_txt = cells[4].text(strip=True)
            time_txt = cells[5].text(strip=True)
            try:
                round_num = int(round_txt)
            except ValueError:
                round_num = None
            fights.append(
                SherdogFight(
                    result=result,
                    opponent_name=opponent_name,
                    opponent_sherdog_id=opponent_sherdog_id,
                    event_name=event_name,
                    event_date=event_date,
                    method=method,
                    method_class=classify_method(method),
                    round=round_num,
                    time_seconds=parse_round_time(time_txt),
                    is_ufc=bool(_UFC_EVENT_RE.search(event_name or "")),
                )
            )
    return SherdogProfile(
        name=name, nickname=nickname, birth_date=birth_date, fights=fights
    )


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------


def count_fight_overlaps(
    fights: list[SherdogFight],
    db_bouts: list[tuple[date, str]],
) -> int:
    """How many of our DB UFC bouts (event date, opponent name) appear in
    a Sherdog history. Date within ±1 day (timezone skew) + surname match."""
    overlaps = 0
    one_day = timedelta(days=1)
    for db_date, db_opp in db_bouts:
        for f in fights:
            if f.event_date is None:
                continue
            if abs(f.event_date - db_date) <= one_day and surnames_match(
                f.opponent_name, db_opp
            ):
                overlaps += 1
                break
    return overlaps


def mark_ufc_bouts_by_date(
    fights: list[SherdogFight], db_dates: list[date]
) -> None:
    """Belt-and-suspenders is_ufc: any history row within ±1 day of one of
    the fighter's UFC bouts in our DB is UFC even if the event-name pattern
    missed it (odd early-era naming)."""
    if not db_dates:
        return
    one_day = timedelta(days=1)
    for f in fights:
        if f.is_ufc or f.event_date is None:
            continue
        if any(abs(f.event_date - d) <= one_day for d in db_dates):
            f.is_ufc = True

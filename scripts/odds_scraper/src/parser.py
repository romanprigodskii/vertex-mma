"""Parse bestfightodds event pages.

Each event page renders TWO `table.odds-table` siblings:
  * the responsive header table (only fighter names, used for mobile)
  * the data table — fighter <th> followed by ~10 sportsbook <td> cells

In the data table the row's leading <th> embeds the matchup id and
fighter name, e.g. "43510Alessandro Costa". Sportsbook cells follow
(Polymarket, Kalshi, FanDuel, Caesars, BetRivers, BetWay, Unibet,
BetMGM, DraftKings) plus a trailing "props" cell. Cells are empty for
books that don't offer that fight.

We compute the per-fighter consensus as the MEDIAN of all non-empty
sportsbook cells, taken in DECIMAL space (American odds are
discontinuous across ±100, so their median is undefined there). That's
robust to:
  * one book with an extreme line (off-market)
  * not-all-books-covering-this-bout (NULLs)
and is the right summary of the CLOSING line the archive holds (see
`scripts/run_backfill.py` — this docstring used to say "opening", and it
was wrong)."""

from __future__ import annotations

import re
import statistics
import unicodedata
from dataclasses import dataclass
from typing import Iterator

from bs4 import BeautifulSoup


@dataclass
class MatchupOdds:
    matchup_id: int
    event_id: int
    event_name: str
    event_date_text: str  # raw "June 6th" — caller resolves the year
    fighter_a_name: str
    fighter_a_slug: str
    fighter_b_name: str
    fighter_b_slug: str
    consensus_a_decimal: float | None
    consensus_b_decimal: float | None
    n_books_a: int
    n_books_b: int
    # Method props ("X wins by TKO/KO / submission / decision"), median
    # DECIMAL across books like the winner consensus. None = prop not
    # offered on the page (common for future cards; past event pages
    # keep the full prop grid).
    method_a_ko_decimal: float | None = None
    method_a_sub_decimal: float | None = None
    method_a_dec_decimal: float | None = None
    method_b_ko_decimal: float | None = None
    method_b_sub_decimal: float | None = None
    method_b_dec_decimal: float | None = None


_AMERICAN_RE = re.compile(r"^\s*([+-]?\d{3,4})\s*$")
_LEAD_DIGITS_RE = re.compile(r"^(\d+)(.+)$")

# Method prop rows we care about, e.g. "Cutelaba wins by TKO/KO".
# Anchored at end-of-string so round-specific ("… wins by TKO/KO in
# round 1") and scorecard-specific ("… wins by unanimous decision")
# variants do NOT match — only the plain three-way method book does.
_METHOD_LABEL_RE = re.compile(
    r"^(?P<who>.+?)\s+wins\s+by\s+(?P<how>TKO/KO|KO/TKO|submission|decision)\s*$",
    re.IGNORECASE,
)


def american_to_decimal(american: int | None) -> float | None:
    # american == 0 sneaks in from bestfightodds future-card placeholders
    # ("opens at 0" or similar). Treat as missing so we don't divide by zero.
    if american is None or american == 0:
        return None
    if american > 0:
        return 1.0 + american / 100.0
    return 1.0 + 100.0 / abs(american)


def _parse_american(text: str) -> int | None:
    """Pull a moneyline number out of a sportsbook cell. Strips any
    movement indicators (▲/▼) bestfightodds appends to recently-moved
    lines."""
    cleaned = (
        text.replace(",", "")
        .replace("▲", "")
        .replace("▼", "")
        .strip()
    )
    m = _AMERICAN_RE.match(cleaned)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def parse_event_page(html: str) -> list[MatchupOdds]:
    """Parse one event page's HTML and return all matchups found."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[MatchupOdds] = []

    for table_div in soup.select("div.table-div[id^='event']"):
        event_id_raw = table_div.get("id", "")
        try:
            event_id = int(event_id_raw.replace("event", ""))
        except ValueError:
            continue
        header = table_div.select_one(".table-header h1")
        event_name = header.get_text(strip=True) if header else f"event-{event_id}"
        date_el = table_div.select_one(".table-header-date")
        event_date_text = date_el.get_text(strip=True) if date_el else ""

        # The DATA table is the one without 'odds-table-responsive-header'.
        odds_tables = table_div.select("table.odds-table")
        data_table = None
        for t in odds_tables:
            classes = t.get("class") or []
            if "odds-table-responsive-header" not in classes:
                data_table = t
                break
        if data_table is None:
            continue

        rows = list(data_table.select("tbody > tr"))
        # Pair consecutive rows: (fighter A row, fighter B row). Skip
        # rows that don't carry a fighter <th>.
        i = 0
        while i < len(rows):
            r1 = rows[i]
            f1 = _extract_fighter(r1)
            if f1 is None:
                i += 1
                continue
            if i + 1 >= len(rows):
                break
            r2 = rows[i + 1]
            f2 = _extract_fighter(r2)
            if f2 is None:
                i += 1
                continue

            (matchup_id_a, name_a, slug_a) = f1
            (matchup_id_b, name_b, slug_b) = f2
            matchup_id = matchup_id_a or matchup_id_b
            if matchup_id is None:
                i += 2
                continue
            cons_a, n_a = _consensus(r1)
            cons_b, n_b = _consensus(r2)

            # Prop rows (<tr class="pr">) trail the fighter pair until
            # the next fighter row. Harvest the plain method book.
            methods: dict[str, float] = {}
            j = i + 2
            while j < len(rows) and _extract_fighter(rows[j]) is None:
                key = _method_prop_key(rows[j], name_a, name_b)
                if key is not None and key not in methods:
                    med, n_books = _consensus(rows[j])
                    if med is not None and n_books > 0:
                        methods[key] = med
                j += 1

            out.append(
                MatchupOdds(
                    matchup_id=matchup_id,
                    event_id=event_id,
                    event_name=event_name,
                    event_date_text=event_date_text,
                    fighter_a_name=name_a,
                    fighter_a_slug=slug_a,
                    fighter_b_name=name_b,
                    fighter_b_slug=slug_b,
                    consensus_a_decimal=cons_a,
                    consensus_b_decimal=cons_b,
                    n_books_a=n_a,
                    n_books_b=n_b,
                    method_a_ko_decimal=methods.get("a_ko"),
                    method_a_sub_decimal=methods.get("a_sub"),
                    method_a_dec_decimal=methods.get("a_dec"),
                    method_b_ko_decimal=methods.get("b_ko"),
                    method_b_sub_decimal=methods.get("b_sub"),
                    method_b_dec_decimal=methods.get("b_dec"),
                )
            )
            i = j
    return out


def _name_tokens(s: str) -> set[str]:
    """Diacritic-stripped lowercase word tokens, for matching a prop
    label's name fragment ("Du Plessis") against a fighter's display
    name ("Dricus Du Plessis")."""
    nfkd = unicodedata.normalize("NFKD", s)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    return set(re.sub(r"[^a-z0-9]+", " ", no_accents.lower()).split())


_HOW_TO_METHOD = {
    "tko/ko": "ko",
    "ko/tko": "ko",
    "submission": "sub",
    "decision": "dec",
}


def _method_prop_key(row, name_a: str, name_b: str) -> str | None:
    """If this prop row is a plain "X wins by <method>" book, return its
    key ('a_ko', 'b_sub', …); otherwise None. The side is resolved by
    token containment of the label's name fragment in exactly one of
    the two fighter names — ambiguous labels (shared surname, "Either
    fighter wins by …") are skipped rather than guessed."""
    th = row.find("th")
    if th is None:
        return None
    label = th.get_text(strip=True)
    m = _METHOD_LABEL_RE.match(label)
    if m is None:
        return None
    method = _HOW_TO_METHOD.get(m.group("how").lower())
    if method is None:
        return None
    who = _name_tokens(m.group("who"))
    if not who:
        return None
    in_a = who <= _name_tokens(name_a)
    in_b = who <= _name_tokens(name_b)
    if in_a == in_b:
        return None
    return f"{'a' if in_a else 'b'}_{method}"


def _extract_fighter(row) -> tuple[int | None, str, str] | None:
    """Return (matchup_id_or_None, display_name, slug) from a row's <th>.
    Matchup ID is None on the second fighter of a pair (only the first
    row has the leading numeric id in the <th> text).

    The <th> structure is one of:
      <th><a href=/cnadm/...>NNNNN</a><a href=/fighters/...><span>Name</span></a></th>
      <th><a href=/fighters/...><span>Name</span></a></th>
    """
    th = row.find("th")
    if th is None:
        return None
    link = th.select_one("a[href^='/fighters/']")
    if link is None:
        return None
    span = link.find("span", class_="t-b-fcc")
    name = (span.get_text(strip=True) if span else link.get_text(strip=True)).strip()
    if not name:
        return None
    href = link.get("href", "")
    slug = href.removeprefix("/fighters/")

    matchup_id: int | None = None
    # Prefer the explicit /cnadm/matchups/N admin link if present —
    # it's the cleanest source of the numeric id.
    admin = th.select_one("a[href*='/cnadm/matchups/']")
    if admin is not None:
        adm_href = admin.get("href", "")
        m = re.search(r"/matchups/(\d+)", adm_href)
        if m:
            try:
                matchup_id = int(m.group(1))
            except ValueError:
                pass
    if matchup_id is None:
        # Fallback — scan th text for leading digits, e.g.
        # "43510Alessandro Costa".
        full_text = th.get_text(strip=True)
        if name in full_text and full_text != name:
            prefix = full_text[: full_text.find(name)]
            m = _LEAD_DIGITS_RE.match(prefix.strip())
            if m:
                try:
                    matchup_id = int(m.group(1))
                except ValueError:
                    pass

    return matchup_id, name, slug


def _consensus(row) -> tuple[float | None, int]:
    """Median DECIMAL odds across sportsbook cells in this row. Returns
    (median, n_books_used).

    The median must be taken in decimal space, not American: American
    odds are discontinuous across the ±100 gap, so an even book count
    straddling the sign boundary (e.g. [-105, +100]) medians to a
    meaningless in-gap value (-2 → decimal 51.0). Decimals are
    continuous, so [-105, +100] → [1.95, 2.00] → 1.976."""
    decimals: list[float] = []
    for td in row.find_all("td"):
        cls = td.get("class") or []
        if any("prop" in c for c in cls):
            continue
        if any("button-cell" in c for c in cls):
            continue
        text = td.get_text(strip=True)
        if not text:
            continue
        dec = american_to_decimal(_parse_american(text))
        if dec is not None:
            decimals.append(dec)
    if not decimals:
        return None, 0
    return round(statistics.median(decimals), 3), len(decimals)


def iter_events_on_homepage(html: str) -> Iterator[int]:
    """Yield event IDs linked from /events/...-NNNN URLs on the home /
    listing page."""
    seen: set[int] = set()
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.select("a[href^='/events/']"):
        href = a.get("href", "")
        m = re.search(r"-(\d+)$", href)
        if m:
            try:
                eid = int(m.group(1))
            except ValueError:
                continue
            if eid not in seen:
                seen.add(eid)
                yield eid

"""Parse bestfightodds event pages.

Each event page renders TWO `table.odds-table` siblings:
  * the responsive header table (only fighter names, used for mobile)
  * the data table — fighter <th> followed by ~10 sportsbook <td> cells

In the data table the row's leading <th> embeds the matchup id and
fighter name, e.g. "43510Alessandro Costa". Sportsbook cells follow
(Polymarket, Kalshi, FanDuel, Caesars, BetRivers, BetWay, Unibet,
BetMGM, DraftKings) plus a trailing "props" cell. Cells are empty for
books that don't offer that fight.

We compute the per-fighter "consensus" American moneyline as the MEDIAN
of all non-empty sportsbook cells. That's robust to:
  * one book with an extreme line (off-market)
  * not-all-books-covering-this-bout (NULLs)
and is close enough to true opening line for our ML feature."""

from __future__ import annotations

import re
import statistics
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
    consensus_a_american: int | None
    consensus_b_american: int | None
    n_books_a: int
    n_books_b: int


_AMERICAN_RE = re.compile(r"^\s*([+-]?\d{3,4})\s*$")
_LEAD_DIGITS_RE = re.compile(r"^(\d+)(.+)$")


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
                    consensus_a_american=cons_a,
                    consensus_b_american=cons_b,
                    n_books_a=n_a,
                    n_books_b=n_b,
                )
            )
            i += 2
    return out


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


def _consensus(row) -> tuple[int | None, int]:
    """Median moneyline across sportsbook cells in this row. Returns
    (median, n_books_used)."""
    vals: list[int] = []
    for td in row.find_all("td"):
        cls = td.get("class") or []
        if any("prop" in c for c in cls):
            continue
        if any("button-cell" in c for c in cls):
            continue
        text = td.get_text(strip=True)
        if not text:
            continue
        v = _parse_american(text)
        if v is not None:
            vals.append(v)
    if not vals:
        return None, 0
    return int(round(statistics.median(vals))), len(vals)


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

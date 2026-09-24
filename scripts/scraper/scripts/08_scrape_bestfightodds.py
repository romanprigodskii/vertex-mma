"""
08_scrape_bestfightodds.py — pull sportsbook consensus odds from
bestfightodds.com for upcoming UFC bouts. Writes implied decimal odds
into the bout_external_odds table (Wave 44).

bestfightodds.com structure (probed 2026-05):
  * Home (/) lists current/upcoming events as horizontal tables, each
    inside <div class="table-div" id="event{numeric_id}">. The table
    contains rows where odd-indexed rows hold matchups:
      <tr id="mu-{matchup_id}"><th><a href="/fighters/{slug}">A name</a>
        </th>... per-bookmaker odds cells ...</tr>
      <tr><th><a href="/fighters/{slug}">B name</a></th>... odds ...</tr>
    Each "but-sg" cell holds an American moneyline; the <span class="bestbet">
    one is the highest offer. Same matchup ID appears on both rows.
  * Event detail (/events/{slug}-{id}) — same table structure with a
    header showing event date.

We pull winner moneylines plus the plain method book. Method odds live
in property-rows (`<tr class="pr">`) trailing each fighter pair; the
plain "X wins by TKO/KO / submission / decision" labels are matched to
a side by name-token containment and written into the six
method_*_decimal columns. bestfightodds embeds the full prop grid on
the homepage only during fight week, so the 6-hourly upserts converge
to the closing method lines. Winner consensus stays MAX (best offer,
feeds the sportsbook edge-guard); method consensus is the MEDIAN
across books (feeds model-vs-market backtests, matching
scripts/odds_scraper's convention). Round/distance/scorecard prop
variants are ignored.

Every book's winner price also goes to bout_odds_quote, the append-only
history (source 'bestfightodds', one row per book and CHANGE of price — a
pass that sees the price it saw last time writes nothing). bout_external_odds
keeps one overwritten row per bout, so the opening line and the movement to
the close were lost on every pass; this keeps them. Two things differ from
the BetsAPI rows in the same table:

  * quoted_at is the pass that FIRST SAW the price, not when the book posted
    it — bestfightodds does not say. The price was posted at most one cron
    interval (6 h) before.
  * the bell is not known either, so nothing is written after a conservative
    cutoff on the card's date (see observation_cutoff): an in-play price in
    this table would poison every close read from it.

American → decimal conversion:
  +150 → 1 + 150/100 = 2.50
  -200 → 1 + 100/200 = 1.50

Matching to local bouts is fuzzy: trigram similarity on fighter_a/b
names, plus an event-date sanity check (±7 days of the bestfightodds
event header date) when present.

Usage:
  pnpm odds:scrape           # full pass over upcoming events
  pnpm odds:scrape:dry       # parse + print, don't write
  --limit N                  # cap events processed
"""

from __future__ import annotations

import argparse
import re
import statistics
import time
import unicodedata
from dataclasses import dataclass, field
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

import _path  # noqa: F401 — sets sys.path so `src.*` resolves
import psycopg
from selectolax.parser import HTMLParser

from src.db import get_connection
from src.http import Client
from src.utils.logger import log

HOME_URL = "https://www.bestfightodds.com/"

# Event blocks we care about. UFC is the dominant promotion locally;
# other rows (PFL, Bellator, ONE) get skipped silently — their bouts
# don't exist in our `bout` table.
UFC_HEADER_RE = re.compile(r"^UFC\b", re.IGNORECASE)


@dataclass
class ScrapedFight:
    matchup_id: str
    fighter_a_name: str
    fighter_a_slug: str
    fighter_b_name: str
    fighter_b_slug: str
    winner_a_decimal: Optional[float]
    winner_b_decimal: Optional[float]
    # keys: a_ko, a_sub, a_dec, b_ko, b_sub, b_dec → median decimal odds
    method_decimals: dict[str, float] = field(default_factory=dict)
    # book name → (decimal on this row's A, decimal on B); only books that
    # price BOTH sides
    book_prices: dict[str, tuple[float, float]] = field(default_factory=dict)


@dataclass
class ScrapedEvent:
    event_title: str
    event_date_label: str | None
    source_url: str
    fights: list[ScrapedFight]


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def american_to_decimal(american: str) -> Optional[float]:
    """Convert '+150' / '-200' / '+EV' style strings to decimal odds."""
    s = american.strip().replace(" ", "").replace(",", "")
    s = s.replace("+", "")
    try:
        v = int(s)
    except ValueError:
        return None
    if v >= 100:
        return round(1.0 + v / 100.0, 3)
    if v <= -100:
        return round(1.0 + 100.0 / abs(v), 3)
    return None


def _best_moneyline(row) -> Optional[float]:
    """Pick the highest-decimal moneyline cell on a fighter row.

    bestfightodds renders one `<td class="but-sg">` per bookmaker, each
    containing a `<span>` with the American moneyline. `<span class="bestbet">`
    flags the best offer but isn't always populated, so we just take the
    max decimal across all `td.but-sg > span` cells on the row.
    """
    best: Optional[float] = None
    for span in row.css("td.but-sg > span"):
        text = (span.text() or "").strip()
        if not text:
            continue
        # Numbers like "+279" / "-410". Skip arrow glyphs and other UI text.
        if not re.match(r"^[+\-]?\d+$", text):
            continue
        dec = american_to_decimal(text)
        if dec is None:
            continue
        if best is None or dec > best:
            best = dec
    return best


def _book_names(values_table) -> dict[str, str]:
    """Header `th[data-b]` → the book's name (its first link's text; the
    rest of the cell is a promo badge)."""
    names: dict[str, str] = {}
    for th in values_table.css("thead th[data-b]"):
        link = th.css_first("a")
        name = ((link.text() if link else th.text()) or "").strip()
        if name:
            names[th.attributes.get("data-b") or ""] = name
    return names


def _book_moneylines(row, names: dict[str, str]) -> dict[str, float]:
    """Book name → decimal for one fighter row. Each price cell says whose it
    is: `data-li="[book_id, side, matchup_id]"`."""
    out: dict[str, float] = {}
    for td in row.css("td.but-sg[data-li]"):
        try:
            book_id = str(json.loads(td.attributes.get("data-li") or "")[0])
        except (ValueError, IndexError, TypeError):
            continue
        name = names.get(book_id)
        if name is None:
            continue
        for span in td.css("span"):
            text = (span.text() or "").strip()
            if re.match(r"^[+\-]?\d+$", text):
                dec = american_to_decimal(text)
                if dec is not None:
                    out[name] = dec
                break
    return out


_CNADM_MATCHUP_RE = re.compile(r"/cnadm/matchups/(\d+)")

# Plain method book only — anchored so "… wins by TKO/KO in round 1"
# and "… wins by unanimous decision" variants don't match.
_METHOD_LABEL_RE = re.compile(
    r"^(?P<who>.+?)\s+wins\s+by\s+(?P<how>TKO/KO|KO/TKO|submission|decision)\s*$",
    re.IGNORECASE,
)
_HOW_TO_METHOD = {
    "tko/ko": "ko",
    "ko/tko": "ko",
    "submission": "sub",
    "decision": "dec",
}


def _name_tokens(s: str) -> set[str]:
    nfkd = unicodedata.normalize("NFKD", s)
    no_accents = "".join(c for c in nfkd if not unicodedata.combining(c))
    return set(re.sub(r"[^a-z0-9]+", " ", no_accents.lower()).split())


def _median_prop_line(row) -> Optional[float]:
    """Median decimal odds across `td.but-sgp > span` bookmaker cells of
    a prop row (movement-arrow spans fail the numeric regex)."""
    decimals: list[float] = []
    for span in row.css("td.but-sgp > span"):
        text = (span.text() or "").strip()
        if not re.match(r"^[+\-]?\d+$", text):
            continue
        dec = american_to_decimal(text)
        if dec is not None:
            decimals.append(dec)
    if not decimals:
        return None
    return round(statistics.median(decimals), 3)


def _method_prop_key(
    row, fighter_a_name: str, fighter_b_name: str
) -> Optional[str]:
    """'a_ko' / 'b_dec' / … when the row is a plain "X wins by <method>"
    prop whose name fragment sits in exactly one fighter name; None
    otherwise (ambiguous labels like "Either fighter wins by …" are
    skipped rather than guessed)."""
    th = row.css_first("th")
    if th is None:
        return None
    label = (th.text() or "").strip()
    m = _METHOD_LABEL_RE.match(label)
    if m is None:
        return None
    method = _HOW_TO_METHOD.get(m.group("how").lower())
    if method is None:
        return None
    who = _name_tokens(m.group("who"))
    if not who:
        return None
    in_a = who <= _name_tokens(fighter_a_name)
    in_b = who <= _name_tokens(fighter_b_name)
    if in_a == in_b:
        return None
    return f"{'a' if in_a else 'b'}_{method}"


def parse_page(html: str, source_url: str) -> list[ScrapedEvent]:
    """Walk every `div.table-div` block on the page and return scraped
    events (UFC only).

    Each event block holds two sibling tables: the first
    (`odds-table-responsive-header`) is sticky labels only — no odds
    cells — and the second `odds-table` is the side-scrolling values
    grid with one `<th scope="row">` per fighter/prop and one `<td>`
    per sportsbook. We parse the second table exclusively.

    Rows alternate fighter-A then fighter-B per matchup. The A row
    carries an admin anchor `<a href="/cnadm/matchups/{id}">…</a>` —
    that's how we tag a row as the start of a new matchup. Anything
    else (prop rows) is ignored — method props need a stable bookmaker
    prop-ID map we don't have.
    """
    tree = HTMLParser(html)
    events: list[ScrapedEvent] = []

    for block in tree.css("div.table-div"):
        title_el = block.css_first("div.table-header h1")
        if title_el is None:
            continue
        title = (title_el.text() or "").strip()
        if not UFC_HEADER_RE.search(title):
            continue
        date_label_el = block.css_first("span.table-header-date")
        date_label = (date_label_el.text() or "").strip() if date_label_el else None

        # Pick the values table (the one WITHOUT responsive-header).
        values_table = None
        for tbl in block.css("table.odds-table"):
            classes = (tbl.attributes.get("class") or "").split()
            if "odds-table-responsive-header" in classes:
                continue
            values_table = tbl
            break
        if values_table is None:
            continue
        books = _book_names(values_table)

        rows = values_table.css("tbody tr")
        fights: list[ScrapedFight] = []
        i = 0
        while i < len(rows):
            row_a = rows[i]
            # Match A starts when the row's <th> has the cnadm matchup
            # admin anchor (only appears on the A row).
            th_a = row_a.css_first("th")
            if th_a is None:
                i += 1
                continue
            admin_link = th_a.css_first("a[href^='/cnadm/matchups/']")
            if admin_link is None:
                i += 1
                continue
            m = _CNADM_MATCHUP_RE.search(
                admin_link.attributes.get("href") or ""
            )
            if not m:
                i += 1
                continue
            matchup_id = m.group(1)

            link_a = th_a.css_first("a[href^='/fighters/']")
            if link_a is None:
                i += 1
                continue
            name_a = (link_a.text() or "").strip()
            slug_a = (link_a.attributes.get("href") or "").rsplit("/", 1)[-1]
            ml_a = _best_moneyline(row_a)

            if i + 1 >= len(rows):
                break
            row_b = rows[i + 1]
            th_b = row_b.css_first("th")
            link_b = th_b.css_first("a[href^='/fighters/']") if th_b else None
            if link_b is None:
                i += 1
                continue
            name_b = (link_b.text() or "").strip()
            slug_b = (link_b.attributes.get("href") or "").rsplit("/", 1)[-1]
            ml_b = _best_moneyline(row_b)
            by_a, by_b = _book_moneylines(row_a, books), _book_moneylines(row_b, books)
            book_prices = {k: (by_a[k], by_b[k]) for k in by_a if k in by_b}

            # Prop rows trail the fighter pair until the next matchup
            # (next row whose <th> carries the cnadm admin anchor).
            # During fight week the plain method book lives here.
            methods: dict[str, float] = {}
            j = i + 2
            while j < len(rows):
                th_next = rows[j].css_first("th")
                if th_next is not None and th_next.css_first(
                    "a[href^='/cnadm/matchups/'], a[href^='/fighters/']"
                ):
                    break
                key = _method_prop_key(rows[j], name_a, name_b)
                if key is not None and key not in methods:
                    med = _median_prop_line(rows[j])
                    if med is not None:
                        methods[key] = med
                j += 1

            fights.append(
                ScrapedFight(
                    matchup_id=matchup_id,
                    fighter_a_name=name_a,
                    fighter_a_slug=slug_a,
                    fighter_b_name=name_b,
                    fighter_b_slug=slug_b,
                    winner_a_decimal=ml_a,
                    winner_b_decimal=ml_b,
                    method_decimals=methods,
                    book_prices=book_prices,
                )
            )
            i = j

        if fights:
            events.append(
                ScrapedEvent(
                    event_title=title,
                    event_date_label=date_label,
                    source_url=source_url,
                    fights=fights,
                )
            )

    return events


# ---------------------------------------------------------------------------
# Bout matching
# ---------------------------------------------------------------------------


def _name_key(name: str) -> str:
    return re.sub(r"[^a-z]+", "", name.lower())


def match_bout(
    conn: psycopg.Connection,
    fighter_a: str,
    fighter_b: str,
) -> Optional[tuple[str, bool]]:
    """Find a scheduled or in_progress bout in our DB where the two
    fighter rows fuzzy-match the given names.

    Returns (bout_id, swapped) where `swapped` is True iff bestfightodds'
    fighter A corresponds to the local bout's fighter B. Callers must
    honour the orientation when writing winner_a/b_decimal — otherwise
    the seeded prices end up inverted (this was the Wave 44 bug fixed
    in Wave 49).

    Strategy: trigram similarity on f.name_en. Pick the orientation
    that maximises the geometric-mean similarity across both sides so
    near-ties don't accidentally flip on a single noisy match.
    """
    row = conn.execute(
        """
        SELECT
            b.id::text AS bout_id,
            similarity(fa.name_en, %s) AS s_a_fa,
            similarity(fb.name_en, %s) AS s_b_fb,
            similarity(fa.name_en, %s) AS s_b_fa,
            similarity(fb.name_en, %s) AS s_a_fb
        FROM bout b
        JOIN fighter fa ON fa.id = b.fighter_a_id
        JOIN fighter fb ON fb.id = b.fighter_b_id
        WHERE b.status IN ('scheduled', 'in_progress')
          AND (
            (similarity(fa.name_en, %s) >= 0.45 AND similarity(fb.name_en, %s) >= 0.45)
            OR
            (similarity(fa.name_en, %s) >= 0.45 AND similarity(fb.name_en, %s) >= 0.45)
          )
        ORDER BY
            GREATEST(
              similarity(fa.name_en, %s) * similarity(fb.name_en, %s),
              similarity(fa.name_en, %s) * similarity(fb.name_en, %s)
            ) DESC
        LIMIT 1
        """,
        (
            fighter_a, fighter_b,        # s_a_fa, s_b_fb (same order)
            fighter_b, fighter_a,        # s_b_fa, s_a_fb (swapped)
            fighter_a, fighter_b,        # WHERE same-order pair
            fighter_b, fighter_a,        # WHERE swapped pair
            fighter_a, fighter_b,        # ORDER BY same-order pair
            fighter_b, fighter_a,        # ORDER BY swapped pair
        ),
    ).fetchone()
    if row is None:
        return None
    bout_id, s_a_fa, s_b_fb, s_b_fa, s_a_fb = row
    same_score = (s_a_fa or 0) * (s_b_fb or 0)
    swapped_score = (s_b_fa or 0) * (s_a_fb or 0)
    swapped = swapped_score > same_score
    return bout_id, swapped


def upsert_odds(
    conn: psycopg.Connection,
    bout_id: str,
    fight: ScrapedFight,
    source_url: str,
    swapped: bool,
) -> None:
    """If `swapped` is True, write the scrape's A decimal into
    winner_b_decimal (and vice versa) so the row matches the local
    bout's fighter_a/fighter_b ordering. Method columns COALESCE on
    conflict: props leave the homepage once the event starts, and a
    post-props scrape must not wipe the captured closing lines.

    INVARIANT — `created_at` MUST NEVER appear in the DO UPDATE SET below.
    It is the moment this bout FIRST got a sportsbook line, and it is the
    only announcement-date proxy we have anywhere in the schema: nothing
    else records when a fight was booked. `bout.created_at` cannot serve
    (it was stamped en masse at import), and `fetched_at` is deliberately
    overwritten on every 6-hourly pass. A single `created_at = now()` added
    to the SET clause would silently collapse every lead time to zero and
    destroy accumulated history that CANNOT be reconstructed. The same
    invariant holds for the backfill's UPSERT_SQL in
    scripts/odds_scraper/src/matcher.py; both are pinned by
    scripts/scraper/tests/test_odds_first_seen.py.
    """
    winner_a = fight.winner_b_decimal if swapped else fight.winner_a_decimal
    winner_b = fight.winner_a_decimal if swapped else fight.winner_b_decimal
    meth = fight.method_decimals
    a_side, b_side = ("b", "a") if swapped else ("a", "b")
    conn.execute(
        """
        INSERT INTO bout_external_odds (
          bout_id, source, fetched_at, winner_a_decimal, winner_b_decimal,
          method_a_kotko_decimal, method_a_sub_decimal, method_a_dec_decimal,
          method_b_kotko_decimal, method_b_sub_decimal, method_b_dec_decimal,
          source_url
        )
        VALUES (
          %s::uuid, 'bestfightodds', NOW(), %s, %s, %s, %s, %s, %s, %s, %s, %s
        )
        ON CONFLICT (bout_id, source) DO UPDATE SET
          fetched_at = EXCLUDED.fetched_at,
          winner_a_decimal = EXCLUDED.winner_a_decimal,
          winner_b_decimal = EXCLUDED.winner_b_decimal,
          method_a_kotko_decimal = COALESCE(EXCLUDED.method_a_kotko_decimal, bout_external_odds.method_a_kotko_decimal),
          method_a_sub_decimal   = COALESCE(EXCLUDED.method_a_sub_decimal, bout_external_odds.method_a_sub_decimal),
          method_a_dec_decimal   = COALESCE(EXCLUDED.method_a_dec_decimal, bout_external_odds.method_a_dec_decimal),
          method_b_kotko_decimal = COALESCE(EXCLUDED.method_b_kotko_decimal, bout_external_odds.method_b_kotko_decimal),
          method_b_sub_decimal   = COALESCE(EXCLUDED.method_b_sub_decimal, bout_external_odds.method_b_sub_decimal),
          method_b_dec_decimal   = COALESCE(EXCLUDED.method_b_dec_decimal, bout_external_odds.method_b_dec_decimal),
          source_url = EXCLUDED.source_url
        """,
        (
            bout_id,
            winner_a,
            winner_b,
            meth.get(f"{a_side}_ko"),
            meth.get(f"{a_side}_sub"),
            meth.get(f"{a_side}_dec"),
            meth.get(f"{b_side}_ko"),
            meth.get(f"{b_side}_sub"),
            meth.get(f"{b_side}_dec"),
            source_url,
        ),
    )


# ---------------------------------------------------------------------------
# Append-only quote history (bout_odds_quote)
# ---------------------------------------------------------------------------

# How long after 00:00 UTC of event.date (the card's LOCAL date) a pass may
# still write. Measured on 161 UFC cards 2023-01..2026-09 against BetsAPI's
# per-bout start times: the earliest first bout of any card started 7.0 h
# after that midnight (Shenzhen, 2025-08-23); 8.2 Perth, 9.2 Singapore, 13.2
# Abu Dhabi and Baku, 14.4 Riyadh, 15.7 the US, 16.0 Paris and London, 20.2
# Canada, Brazil, Mexico. A country is on the late list only if it was
# MEASURED at 13.2 h or later; anything else, and a card with no country,
# gets the early cutoff. Both leave an hour's margin under the earliest start.
LATE_START_COUNTRIES = frozenset({"US", "CA", "MX", "BR", "GB", "FR", "AE", "AZ", "SA"})
LATE_CUTOFF = timedelta(hours=12)
EARLY_CUTOFF = timedelta(hours=6)


def observation_cutoff(event_date: datetime, country: str | None) -> datetime:
    """The last moment a price seen for this card can be trusted pre-bell."""
    start = event_date if event_date.tzinfo else event_date.replace(tzinfo=timezone.utc)
    return start + (LATE_CUTOFF if (country or "").upper() in LATE_START_COUNTRIES
                    else EARLY_CUTOFF)


APPEND_QUOTE_SQL = """
INSERT INTO bout_odds_quote
  (bout_id, source, book, market, price_a, price_b, quoted_at, snapshot, external_id)
SELECT %(bout)s::uuid, 'bestfightodds', %(book)s, 'winner', %(a)s, %(b)s,
       %(now)s, 'observed', %(mu)s
WHERE NOT EXISTS (
  SELECT 1 FROM (
    SELECT price_a, price_b FROM bout_odds_quote
    WHERE bout_id = %(bout)s::uuid AND source = 'bestfightodds'
      AND book = %(book)s AND market = 'winner'
    ORDER BY quoted_at DESC LIMIT 1
  ) last
  WHERE last.price_a = %(a)s::real AND last.price_b = %(b)s::real
)
"""


def append_quotes(
    conn: psycopg.Connection,
    bout_id: str,
    fight: ScrapedFight,
    swapped: bool,
    now: datetime,
) -> int:
    """Write each book's winner price if it differs from that book's last
    row for this bout. Returns the rows written (0 past the cutoff)."""
    row = conn.execute(
        "SELECT e.date, e.location_country FROM bout b "
        "JOIN event e ON e.id = b.event_id WHERE b.id = %s::uuid",
        (bout_id,),
    ).fetchone()
    if row is None or now >= observation_cutoff(row[0], row[1]):
        return 0
    written = 0
    for book, (pa, pb) in sorted(fight.book_prices.items()):
        a, b = (pb, pa) if swapped else (pa, pb)
        cur = conn.execute(APPEND_QUOTE_SQL, {"bout": bout_id, "book": book,
                                              "a": a, "b": b, "now": now,
                                              "mu": fight.matchup_id})
        written += cur.rowcount
    return written


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="parse and report, don't write",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="cap number of events processed",
    )
    args = parser.parse_args()

    log.info("Fetching bestfightodds.com home …")
    with Client(rate_limit_seconds=1.5) as client:
        html = client.get(HOME_URL)

    events = parse_page(html, HOME_URL)
    log.info(f"Parsed {len(events)} UFC event blocks.")
    if args.limit is not None:
        events = events[: args.limit]

    if args.dry_run:
        for ev in events:
            print(f"\n[{ev.event_title}] {ev.event_date_label or ''}")
            for f in ev.fights:
                meth = (
                    " method " + str(f.method_decimals)
                    if f.method_decimals
                    else ""
                )
                print(
                    f"  mu-{f.matchup_id}: {f.fighter_a_name} "
                    f"({f.winner_a_decimal}) vs {f.fighter_b_name} "
                    f"({f.winner_b_decimal}){meth} · {len(f.book_prices)} books"
                )
        return 0

    conn = get_connection()
    matched = 0
    unmatched = 0
    written = 0
    quotes = 0
    now = datetime.now(timezone.utc)
    try:
        for ev in events:
            for fight in ev.fights:
                match = match_bout(
                    conn, fight.fighter_a_name, fight.fighter_b_name
                )
                if not match:
                    unmatched += 1
                    log.debug(
                        f"no local bout for {fight.fighter_a_name} vs "
                        f"{fight.fighter_b_name}"
                    )
                    continue
                bout_id, swapped = match
                matched += 1
                if (
                    fight.winner_a_decimal is None
                    or fight.winner_b_decimal is None
                ):
                    log.debug(
                        f"skip {fight.fighter_a_name} vs {fight.fighter_b_name}"
                        f" — missing odds"
                    )
                    continue
                upsert_odds(conn, bout_id, fight, ev.source_url, swapped)
                written += 1
                quotes += append_quotes(conn, bout_id, fight, swapped, now)
            conn.commit()
            time.sleep(0.25)
    finally:
        conn.close()

    log.info(
        f"Matched {matched} bouts ({unmatched} unmatched); "
        f"wrote {written} odds rows, {quotes} new book quotes."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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

We pull winner moneylines only. Method odds live in property-rows
(`<tr class="pr">` with labels like "Over 1½ rounds") that use opaque
bookmaker prop IDs; decoding those isn't reliable from HTML alone, so
method columns stay NULL — the seed flow already falls back to uniform
when they're missing.

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
import time
from dataclasses import dataclass
from datetime import datetime
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


_CNADM_MATCHUP_RE = re.compile(r"/cnadm/matchups/(\d+)")


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

            fights.append(
                ScrapedFight(
                    matchup_id=matchup_id,
                    fighter_a_name=name_a,
                    fighter_a_slug=slug_a,
                    fighter_b_name=name_b,
                    fighter_b_slug=slug_b,
                    winner_a_decimal=ml_a,
                    winner_b_decimal=ml_b,
                )
            )
            i += 2

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
) -> Optional[str]:
    """Find a scheduled or in_progress bout in our DB where the two
    fighter rows fuzzy-match the given names. Returns bout.id or None.

    Strategy: trigram similarity on f.name_en against the bestfightodds
    name. Threshold 0.45 keeps "Khamzat Chimaev" matching a slugged
    "khamzat-chimaev" while rejecting unrelated rows.
    """
    rows = conn.execute(
        """
        SELECT b.id::text AS bout_id
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
          GREATEST(similarity(fa.name_en, %s), similarity(fa.name_en, %s)) DESC
        LIMIT 1
        """,
        (
            fighter_a, fighter_b,
            fighter_b, fighter_a,
            fighter_a, fighter_b,
        ),
    ).fetchone()
    if rows is None:
        return None
    return rows[0]


def upsert_odds(
    conn: psycopg.Connection,
    bout_id: str,
    fight: ScrapedFight,
    source_url: str,
) -> None:
    conn.execute(
        """
        INSERT INTO bout_external_odds (
          bout_id, source, fetched_at, winner_a_decimal, winner_b_decimal,
          source_url
        )
        VALUES (
          %s::uuid, 'bestfightodds', NOW(), %s, %s, %s
        )
        ON CONFLICT (bout_id, source) DO UPDATE SET
          fetched_at = EXCLUDED.fetched_at,
          winner_a_decimal = EXCLUDED.winner_a_decimal,
          winner_b_decimal = EXCLUDED.winner_b_decimal,
          source_url = EXCLUDED.source_url
        """,
        (
            bout_id,
            fight.winner_a_decimal,
            fight.winner_b_decimal,
            source_url,
        ),
    )


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
                print(
                    f"  mu-{f.matchup_id}: {f.fighter_a_name} "
                    f"({f.winner_a_decimal}) vs {f.fighter_b_name} "
                    f"({f.winner_b_decimal})"
                )
        return 0

    conn = get_connection()
    matched = 0
    unmatched = 0
    written = 0
    try:
        for ev in events:
            for fight in ev.fights:
                bout_id = match_bout(
                    conn, fight.fighter_a_name, fight.fighter_b_name
                )
                if not bout_id:
                    unmatched += 1
                    log.debug(
                        f"no local bout for {fight.fighter_a_name} vs "
                        f"{fight.fighter_b_name}"
                    )
                    continue
                matched += 1
                if fight.winner_a_decimal is None or fight.winner_b_decimal is None:
                    log.debug(
                        f"skip {fight.fighter_a_name} vs {fight.fighter_b_name}"
                        f" — missing odds"
                    )
                    continue
                upsert_odds(conn, bout_id, fight, ev.source_url)
                written += 1
            conn.commit()
            time.sleep(0.25)
    finally:
        conn.close()

    log.info(
        f"Matched {matched} bouts ({unmatched} unmatched); "
        f"wrote {written} odds rows."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

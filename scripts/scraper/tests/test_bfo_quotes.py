"""Pin the bestfightodds → bout_odds_quote history written by the 6-hourly cron.

Three things can make that history quietly wrong, and each is checked:

  * a price on the wrong book or the wrong fighter — each cell names its own
    book and side (`data-li`), the header names the book (`th[data-b]`), and
    a book pricing only one side is not a quote;
  * a pass that re-sees an unchanged price writing it again — the table is a
    history of CHANGES, and four identical rows a day would drown the moves;
  * a price seen once the card has started — nothing is written past
    observation_cutoff, measured against 161 cards' real start times.

The database half runs inside a transaction that is rolled back, so the test
never leaves a trace in production.

Run:
    scripts/scraper/venv/bin/python scripts/scraper/tests/test_bfo_quotes.py

Needs DATABASE_URL in .env.local, like every other scraper entry point.
"""
from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRAPER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_SCRAPER_ROOT))
sys.path.insert(0, str(_SCRAPER_ROOT / "scripts"))

from src.db import get_connection  # noqa: E402

_BFO_SCRIPT = _SCRAPER_ROOT / "scripts" / "08_scrape_bestfightodds.py"


def _bfo():
    if "bfo_scraper" in sys.modules:
        return sys.modules["bfo_scraper"]
    spec = importlib.util.spec_from_file_location("bfo_scraper", _BFO_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["bfo_scraper"] = module
    spec.loader.exec_module(module)
    return module


# The live structure of 2026-09-24, cut down: two books priced on both sides,
# a third (BetMGM) on one side only, a promo badge in a header cell, movement
# arrows after the price, and an empty cell.
_PAGE = """
<div class="table-div"><div class="table-header"><h1>UFC Vegas 121 Odds</h1>
<span class="table-header-date">September 26th</span></div>
<table class="odds-table odds-table-responsive-header"><thead><tr><th></th></tr></thead></table>
<table class="odds-table"><thead><tr><th scope="col"></th>
  <th scope="col" data-b="29"><a href="#">Kalshi</a><br><a class="bookie-bonus-badge">Up to $500</a></th>
  <th scope="col" data-b="21"><a href="#">FanDuel</a><br>&nbsp;</th>
  <th scope="col" data-b="26"><a href="#">BetMGM</a></th>
  <th scope="col">Props</th></tr></thead>
<tbody>
<tr><th scope="row"><a href="/cnadm/matchups/44968">44968</a><a href="/fighters/raoni-barcelos-4521"><span>Raoni Barcelos</span></a></th>
  <td class="but-sg" data-li="[29,1,44968]"><span>+134</span></td>
  <td class="but-sg" data-li="[21,1,44968]"><span>+134</span><span class="ard">&#9660;</span></td>
  <td class="but-sg" data-li="[26,1,44968]"><span>+140</span></td>
  <td></td></tr>
<tr><th scope="row"><a href="/fighters/raul-rosas-jr-11111"><span>Raul Rosas Jr</span></a></th>
  <td class="but-sg" data-li="[29,2,44968]"><span>-168</span></td>
  <td class="but-sg" data-li="[21,2,44968]"><span>-172</span><span class="ard">&#9650;</span></td>
  <td></td>
  <td></td></tr>
</tbody></table></div>
"""


def test_each_price_lands_on_its_own_book_and_side():
    (ev,) = _bfo().parse_page(_PAGE, "https://www.bestfightodds.com/")
    (f,) = ev.fights
    assert (f.fighter_a_name, f.fighter_b_name) == ("Raoni Barcelos", "Raul Rosas Jr")
    assert f.book_prices == {"Kalshi": (2.34, 1.595), "FanDuel": (2.34, 1.581)}
    # the pre-existing best-offer column is unchanged: max over every cell
    assert (f.winner_a_decimal, f.winner_b_decimal) == (2.4, 1.595)


def test_cutoff_follows_the_measured_card_starts():
    bfo = _bfo()
    day = datetime(2026, 9, 26, tzinfo=timezone.utc)
    assert bfo.observation_cutoff(day, "US") == day + timedelta(hours=12)
    assert bfo.observation_cutoff(day, "ae") == day + timedelta(hours=12)
    # the earliest start measured was a Chinese card, 7.0 h in
    assert bfo.observation_cutoff(day, "CN") == day + timedelta(hours=6)
    # never measured, or no country at all: the early cutoff
    assert bfo.observation_cutoff(day, "JP") == day + timedelta(hours=6)
    assert bfo.observation_cutoff(day, None) == day + timedelta(hours=6)
    # a naive date is read as UTC midnight, which is how event.date is stored
    assert bfo.observation_cutoff(day.replace(tzinfo=None), "US") == day + timedelta(hours=12)


def _fight(bfo, prices: dict[str, tuple[float, float]]):
    return bfo.ScrapedFight(
        matchup_id="test-mu", fighter_a_name="A", fighter_a_slug="a",
        fighter_b_name="B", fighter_b_slug="b", winner_a_decimal=None,
        winner_b_decimal=None, book_prices=prices,
    )


def test_history_records_changes_only_and_stops_at_the_cutoff():
    bfo = _bfo()
    conn = get_connection()
    try:
        bout_id, date, country = conn.execute(
            "SELECT b.id::text, e.date, e.location_country FROM bout b "
            "JOIN event e ON e.id = b.event_id WHERE b.status = 'completed' "
            "AND NOT EXISTS (SELECT 1 FROM bout_odds_quote q WHERE q.bout_id = b.id "
            "AND q.source = 'bestfightodds') ORDER BY e.date DESC LIMIT 1"
        ).fetchone()
        t0 = date - timedelta(days=10)

        def rows():
            return conn.execute(
                "SELECT book, price_a, price_b, quoted_at FROM bout_odds_quote "
                "WHERE bout_id = %s::uuid AND source = 'bestfightodds' "
                "ORDER BY quoted_at, book", (bout_id,)).fetchall()

        f1 = _fight(bfo, {"FanDuel": (2.34, 1.581), "Kalshi": (2.34, 1.595)})
        assert bfo.append_quotes(conn, bout_id, f1, False, t0) == 2
        # six hours later, nothing moved: nothing written
        assert bfo.append_quotes(conn, bout_id, f1, False, t0 + timedelta(hours=6)) == 0
        # FanDuel moves, Kalshi does not: one row
        f2 = _fight(bfo, {"FanDuel": (2.25, 1.62), "Kalshi": (2.34, 1.595)})
        assert bfo.append_quotes(conn, bout_id, f2, False, t0 + timedelta(hours=12)) == 1
        # a swapped match writes this page's A price on our fighter_b
        f3 = _fight(bfo, {"Kalshi": (1.5, 2.6)})
        assert bfo.append_quotes(conn, bout_id, f3, True, t0 + timedelta(hours=18)) == 1
        # past the card's cutoff, even a new price is not written
        late = bfo.observation_cutoff(date, country)
        f4 = _fight(bfo, {"FanDuel": (9.0, 1.05)})
        assert bfo.append_quotes(conn, bout_id, f4, False, late) == 0

        got = rows()
        assert [(r[0], round(r[1], 3), round(r[2], 3)) for r in got] == [
            ("FanDuel", 2.34, 1.581), ("Kalshi", 2.34, 1.595),
            ("FanDuel", 2.25, 1.62), ("Kalshi", 2.6, 1.5),
        ]
        assert got[0][3] == t0 and got[-1][3] == t0 + timedelta(hours=18)
    finally:
        conn.rollback()
        conn.close()


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")

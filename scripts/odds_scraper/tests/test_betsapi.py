"""The two ways a BetsAPI price can land wrong without anything failing.

1. On the wrong corner. The feed says home v away, each book says whether it
   lists them the same way (`matching_dir`), and our bout has its own
   fighter_a / fighter_b. Each flip is pinned below, and so is the case where
   both happen at once and must cancel.
2. From inside the fight. A book's last price is routinely in-play; only
   quotes posted before the bout's listed start survive.

Payload shapes are copied from live responses of 2026-09-23 (UFC 331).

Run: cd scripts/odds_scraper && ./venv/bin/python -m pytest tests/ -q
  or ./venv/bin/python tests/test_betsapi.py
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.betsapi import (  # noqa: E402
    OurBout,
    bout_prices,
    history_quotes,
    match_bout,
    pre_bell,
    summary_quotes,
)

BELL = 1789850700  # 2026-09-19 21:45 UTC — Chikadze v Brito's listed start


def _summary(book_dir: int) -> dict:
    return {
        "Bet365": {
            "matching_dir": book_dir,
            "odds": {
                "start": {
                    "162_1": {"home_od": "3.700", "away_od": "1.294",
                              "add_time": str(BELL - 7 * 86400)},
                    "162_2": {"home_od": "1.869", "away_od": "1.869",
                              "handicap": "+3.5", "add_time": str(BELL - 86400)},
                    "162_3": {"over_od": "1.476", "under_od": "2.600",
                              "handicap": "2.5", "add_time": str(BELL - 86400)},
                },
                "kickoff": {"162_1": None, "162_2": None, "162_3": None},
                "end": {
                    # in-play: posted after the bell
                    "162_1": {"home_od": "11.00", "away_od": "1.030",
                              "add_time": str(BELL + 600)},
                },
            },
        }
    }


def test_summary_reads_winner_and_total_and_skips_handicap():
    qs = summary_quotes(_summary(1))
    kinds = sorted((q.market, q.snapshot) for q in qs)
    assert kinds == [("total_rounds", "start"), ("winner", "end"), ("winner", "start")]
    start = next(q for q in qs if q.market == "winner" and q.snapshot == "start")
    assert (start.home, start.away) == (3.7, 1.294)
    total = next(q for q in qs if q.market == "total_rounds")
    assert (total.line, total.over, total.under) == (2.5, 1.476, 2.6)


def test_reversed_book_is_put_back_in_feed_orientation():
    """matching_dir -1: the book lists away first. Unswapped, the favourite
    would sit on the wrong corner."""
    qs = summary_quotes(_summary(-1))
    start = next(q for q in qs if q.market == "winner" and q.snapshot == "start")
    assert (start.home, start.away) == (1.294, 3.7)


def test_history_respects_its_own_matching_dir():
    h = {"stats": {"matching_dir": -1},
         "odds": {"162_1": [{"home_od": "4.200", "away_od": "1.235",
                             "add_time": str(BELL - 4000)}]}}
    (q,) = history_quotes(h)
    assert (q.book, q.snapshot, q.home, q.away) == ("Bet365", "move", 1.235, 4.2)


def test_in_play_price_is_dropped():
    qs = pre_bell(summary_quotes(_summary(1)), BELL)
    assert all(q.quoted_at < BELL for q in qs)
    assert not any(q.snapshot == "end" for q in qs)
    # a price posted AT the listed start is not provably pre-bell either
    at = history_quotes({"odds": {"162_1": [{"home_od": "2", "away_od": "2",
                                             "add_time": str(BELL)}]}})
    assert pre_bell(at, BELL) == []


def test_both_flips_cancel():
    """The book lists the corners reversed (matching_dir -1), so its raw
    home_od 3.700 belongs to the feed's AWAY fighter; and our table lists the
    feed's home as fighter_b. The two flips cancel: the raw home_od lands on
    our fighter_a. Only one of them applied would put 1.294 there instead."""
    q = next(q for q in summary_quotes(_summary(-1))
             if q.market == "winner" and q.snapshot == "start")
    assert bout_prices(q, swapped=True) == (3.7, 1.294)
    assert bout_prices(q, swapped=False) == (1.294, 3.7)


def test_total_rounds_has_no_corner():
    q = next(q for q in summary_quotes(_summary(1)) if q.market == "total_rounds")
    assert bout_prices(q, swapped=True) == (None, None)


def test_junk_prices_are_not_quotes():
    h = {"odds": {"162_1": [{"home_od": "1.000", "away_od": "5", "add_time": "1"},
                            {"home_od": "-", "away_od": "5", "add_time": "1"},
                            {"home_od": "2", "away_od": "2"}]}}
    assert history_quotes(h) == []


# ------------------------------------------------------------------ matching
WHEN = datetime(2026, 9, 20, 3, 25, tzinfo=timezone.utc)  # after midnight UTC
CARD = date(2026, 9, 19)


def _ours(*pairs, day=CARD):
    return {day: [OurBout(f"b{i}", day, a, b) for i, (a, b) in enumerate(pairs)]}


def test_match_same_orientation_across_utc_midnight():
    ours = _ours(("Joshua Van", "Alexandre Pantoja"), ("Gable Steveson", "Sean Sharaf"))
    m = match_bout("Joshua Van", "Alexandre Pantoja", WHEN, ours)
    assert m is not None and m.bout_id == "b0" and not m.swapped


def test_match_reports_swapped_corners():
    ours = _ours(("Alexandre Pantoja", "Joshua Van"))
    m = match_bout("Joshua Van", "Alexandre Pantoja", WHEN, ours)
    assert m is not None and m.swapped


def test_name_variants_that_should_match():
    ours = _ours(("Michael Aswell Jr.", "JooSang Yoo"))
    m = match_bout("Michael Aswell", "Joo Sang Yoo", WHEN, ours)
    assert m is not None and not m.swapped


def test_ring_name_matches_only_through_the_alias():
    ours = _ours(("Patricio Pitbull", "Dooho Choi"))
    m = match_bout("Patricio Freire", "Dooho Choi", WHEN, ours)
    assert m is not None and not m.swapped


def test_an_alias_adds_a_name_and_takes_none_away():
    """Two UFC fighters answer to "Chris Duncan" on this feed: the opponent
    picks which, and the plain spelling still reaches the lightweight."""
    ours = _ours(("Chris Duncan", "Mateusz Rebecki"),
                 ("Christian Leroy Duncan", "Andrey Pulyaev"))
    lw = match_bout("Chris Duncan", "Mateusz Rebecki", WHEN, ours)
    mw = match_bout("Chris Duncan", "Andrey Pulyaev", WHEN, ours)
    assert lw is not None and lw.bout_id == "b0"
    assert mw is not None and mw.bout_id == "b1"


def test_replacement_opponent_is_refused():
    """The feed kept the original booking; our card has the replacement."""
    ours = _ours(("Joshua Van", "Tatsuro Taira"))
    assert match_bout("Joshua Van", "Alexandre Pantoja", WHEN, ours) is None


def test_outside_the_date_window_is_refused():
    ours = _ours(("Joshua Van", "Alexandre Pantoja"), day=date(2025, 12, 6))
    assert match_bout("Joshua Van", "Alexandre Pantoja", WHEN, ours) is None


def test_ambiguous_match_is_refused():
    """Two of our bouts on the window both accept the pair: refuse, don't pick."""
    ours = {CARD: [OurBout("x", CARD, "Joshua Van", "Alexandre Pantoja")],
            date(2026, 9, 20): [OurBout("y", date(2026, 9, 20),
                                        "Joshua Van", "Alexandre Pantoja")]}
    assert match_bout("Joshua Van", "Alexandre Pantoja", WHEN, ours) is None


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")

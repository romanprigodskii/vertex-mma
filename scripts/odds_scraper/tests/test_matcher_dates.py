"""The rematch that wrote a 2026 price onto a 2025 fight.

`run_backfill.py` calls `match_matchups_to_bouts` without `parent_event_date`,
so the ±21-day filter and the rematch tie-break were both dead and matchups
resolved on fighter names alone against the entire bout table. On 2026-08-15
that put the September 2026 Van–Pantoja line onto their December 2025 fight
and moved that bout's stored probability by 18.5 points.

These tests pin the three behaviours that stop it: date the matchup from its
own `event_date_text`, refuse an undated matchup rather than guess, and refuse
a pair that matches in two different years.

Run: cd scripts/odds_scraper && ./venv/bin/python -m pytest tests/ -q
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.matcher import (  # noqa: E402
    DBBout,
    match_matchups_to_bouts,
    parse_event_date_text,
)
from src.parser import MatchupOdds  # noqa: E402


def _bout(bout_id: str, when: date, a: str, b: str) -> DBBout:
    return DBBout(
        bout_id=bout_id,
        event_id="e-" + bout_id,
        event_name="UFC " + bout_id,
        event_date=when,
        fighter_a_id="fa-" + bout_id,
        fighter_a_name=a,
        fighter_b_id="fb-" + bout_id,
        fighter_b_name=b,
    )


def _matchup(a: str, b: str, when_text: str, dec_a: float, dec_b: float) -> MatchupOdds:
    return MatchupOdds(
        matchup_id=1,
        event_id=1,
        event_name="UFC Odds",
        event_date_text=when_text,
        fighter_a_name=a,
        fighter_a_slug=a.lower().replace(" ", "-"),
        fighter_b_name=b,
        fighter_b_slug=b.lower().replace(" ", "-"),
        consensus_a_decimal=dec_a,
        consensus_b_decimal=dec_b,
        n_books_a=7,
        n_books_b=7,
    )


DEC_2025 = _bout("dec2025", date(2025, 12, 6), "Joshua Van", "Alexandre Pantoja")
SEP_2026 = _bout("sep2026", date(2026, 9, 10), "Joshua Van", "Alexandre Pantoja")


def test_date_text_parses_both_shapes():
    assert parse_event_date_text("June 6th") == (6, 6, None)
    assert parse_event_date_text("Dec 11th 2021") == (12, 11, 2021)
    assert parse_event_date_text("September 10th") == (9, 10, None)
    assert parse_event_date_text("") is None
    assert parse_event_date_text(None) is None
    assert parse_event_date_text("Fight Night") is None


def test_september_matchup_does_not_reach_the_december_bout():
    """The exact regression: only the 2025 bout is in the table, and a
    September page must not write to it."""
    matched = match_matchups_to_bouts(
        [_matchup("Joshua Van", "Alexandre Pantoja", "September 10th", 1.833, 1.952)],
        [DEC_2025],
    )
    assert matched == []


def test_the_right_bout_is_still_matched():
    matched = match_matchups_to_bouts(
        [_matchup("Joshua Van", "Alexandre Pantoja", "December 7th", 3.0, 1.48)],
        [DEC_2025],
    )
    assert len(matched) == 1
    assert matched[0].bout_id == "dec2025"
    assert matched[0].consensus_a_decimal == 3.0


def test_an_undated_matchup_is_skipped_not_guessed():
    """`Future Events Odds` rows carry no date at all — that is the shape
    that did the damage, and names alone must not be enough."""
    assert match_matchups_to_bouts(
        [_matchup("Joshua Van", "Alexandre Pantoja", "", 1.833, 1.952)],
        [DEC_2025],
    ) == []
    # …unless a caller explicitly opts out, which nothing in this repo does.
    assert len(
        match_matchups_to_bouts(
            [_matchup("Joshua Van", "Alexandre Pantoja", "", 1.833, 1.952)],
            [DEC_2025],
            require_date=False,
        )
    ) == 1


def test_an_ambiguous_rematch_is_refused():
    """Both bouts in the table and a page date that reaches neither cleanly:
    writing the wrong one is worse than writing neither."""
    matched = match_matchups_to_bouts(
        [_matchup("Joshua Van", "Alexandre Pantoja", "December 7th", 3.0, 1.48)],
        [DEC_2025, _bout("dec2026", date(2026, 12, 5), "Joshua Van", "Alexandre Pantoja")],
    )
    assert matched == []


def test_year_wrap_still_reaches_across_new_year():
    """A January 3rd page must still find a December 28th bout."""
    bout = _bout("nye", date(2024, 12, 28), "A Fighter", "B Fighter")
    matched = match_matchups_to_bouts(
        [_matchup("A Fighter", "B Fighter", "January 3rd", 1.5, 2.6)], [bout]
    )
    assert len(matched) == 1


def test_parent_event_date_still_wins_when_supplied():
    matched = match_matchups_to_bouts(
        [_matchup("Joshua Van", "Alexandre Pantoja", "September 10th", 1.833, 1.952)],
        [DEC_2025, SEP_2026],
        parent_event_date=date(2026, 9, 10),
    )
    assert len(matched) == 1
    assert matched[0].bout_id == "sep2026"

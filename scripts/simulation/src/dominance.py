"""Per-bout OUTCOME facts — how convincingly the winner won, not who won.

This module reads the finished bout: method, finishing round/clock, and the
judges' round-by-round cards. It exists because `target_a_wins` collapses a
90-second knockout and a split decision into the same bit, so the winner model
has no gradient separating matchups that produce blowouts from matchups that
produce coin-flips — which is, definitionally, a resolution deficit
(docs/tail_resolution.md measured the whole model-vs-market gap as resolution).

Everything here is a function of the bout being predicted. It is LABEL-side
only. Nothing derived from it may enter the feature matrix — not as a feature,
not as a per-row weight keyed on a test row's own outcome, not folded into a
career aggregate. `tests/test_dominance.py` pins that.

Orientation: all `*_a` quantities are in the RAW DB orientation
(`bout.fighter_a_id`), matching `bout_scorecard.fighter_a_score`. The training
frame's A/B flip (`export.symmetrize_for_training`) must mirror them the same
way it mirrors `target_a_wins`.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

# Judging conventions before ~2011 are a different regime AND the scrape is
# thin there (2006: 3 carded decisions, 2009: 41, 2011: 99 of 147). Cards
# before this date are ignored and those bouts fall back to the method proxy.
SCORECARD_MIN_DATE = "2011-01-01"

OUTCOMES_SQL = """
SELECT
  b.id::text                AS bout_id,
  e.date::date              AS event_date,
  b.fighter_a_id::text      AS fighter_a_id,
  b.fighter_b_id::text      AS fighter_b_id,
  b.winner_id::text         AS winner_id,
  b.method::text            AS method,
  b.round_finished,
  b.time_finished_seconds,
  b.scheduled_rounds
FROM bout b
JOIN event e ON e.id = b.event_id
WHERE e.promotion = 'ufc' AND b.status = 'completed'
"""

SCORECARDS_SQL = """
SELECT
  s.bout_id::text AS bout_id,
  s.round,
  s.judge_name,
  s.fighter_a_score,
  s.fighter_b_score
FROM bout_scorecard s
"""


def _fetch_df(conn: Any, sql: str) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def fetch_outcomes(conn: Any | None = None) -> pd.DataFrame:
    """One row per completed UFC bout with the raw outcome facts plus the
    scorecard summary (`round_share_a`, `judged_rounds`, `card_source`)."""
    if conn is not None:
        return attach_round_share(
            _fetch_df(conn, OUTCOMES_SQL), _fetch_df(conn, SCORECARDS_SQL)
        )
    from .db import get_connection

    with get_connection() as own:
        return attach_round_share(
            _fetch_df(own, OUTCOMES_SQL), _fetch_df(own, SCORECARDS_SQL)
        )


def round_share_from_cards(cards: pd.DataFrame) -> pd.DataFrame:
    """Collapse raw judge rows to one row per bout.

    Per (bout, round) each judge votes A / B / even; the round goes to whoever
    the MAJORITY of that round's judges gave it (0.5 on a tie, and on the 467
    of 10,514 (bout, round) pairs where the scrape only has 1-2 of the 3
    cards, the majority is taken over whatever is there — a partially scraped
    round is still evidence, it is just noisier).

    `round_share_a` is then the fraction of judged rounds A took, in [0, 1].
    Rounds are the unit rather than points because the 10-8 rate drifts hard
    with era (0.27 % in 2010 → 6.34 % in 2017 → 2.14 % in 2025) while "who won
    the round" does not.
    """
    if cards.empty:
        return pd.DataFrame(
            columns=["bout_id", "round_share_a", "judged_rounds", "judge_rows"]
        )
    c = cards.copy()
    a = pd.to_numeric(c["fighter_a_score"], errors="coerce")
    b = pd.to_numeric(c["fighter_b_score"], errors="coerce")
    # Per judge: 1 = round to A, 0 = round to B, 0.5 = even round.
    c["vote_a"] = (a > b).astype(float) + 0.5 * (a == b).astype(float)
    per_round = c.groupby(["bout_id", "round"], as_index=False).agg(
        vote_mean=("vote_a", "mean"), judges=("vote_a", "size")
    )
    # Majority of judges for that round; a 1-1 split (or an even-round tie)
    # scores 0.5.
    per_round["round_a"] = (
        (per_round["vote_mean"] > 0.5).astype(float)
        + 0.5 * (per_round["vote_mean"] == 0.5).astype(float)
    )
    out = per_round.groupby("bout_id", as_index=False).agg(
        round_share_a=("round_a", "mean"),
        judged_rounds=("round_a", "size"),
        judge_rows=("judges", "sum"),
    )
    return out


def attach_round_share(bouts: pd.DataFrame, cards: pd.DataFrame) -> pd.DataFrame:
    """Join the card summary onto the bout rows and stamp `card_source`.

    `card_source` is 'cards' when a usable post-2011 card exists, 'method'
    when the decision has to fall back to its method alone (760 of 4,090
    decisions have no scraped card at all, plus everything before
    SCORECARD_MIN_DATE), and 'finish' for bouts that never reached the judges.
    """
    df = bouts.copy()
    df["event_date"] = pd.to_datetime(df["event_date"])
    summary = round_share_from_cards(cards)
    df = df.merge(summary, on="bout_id", how="left")

    is_decision = df["method"].fillna("").str.startswith("decision")
    too_old = df["event_date"] < pd.Timestamp(SCORECARD_MIN_DATE)
    has_cards = df["round_share_a"].notna() & ~too_old
    # Cards from before the cutoff are dropped, not merely flagged, so no
    # downstream consumer can pick them up by accident.
    df.loc[~has_cards, ["round_share_a", "judged_rounds", "judge_rows"]] = pd.NA

    df["card_source"] = "finish"
    df.loc[is_decision, "card_source"] = "method"
    df.loc[is_decision & has_cards, "card_source"] = "cards"

    # 8 bouts carry scheduled_rounds=3 with five judged rounds (scrape error
    # on the schedule, not on the cards). round_share_a is a fraction of the
    # rounds that were actually judged, so it is already correct for them;
    # flag them so a consumer that reasons about championship length can see
    # the disagreement instead of inheriting it silently.
    df["rounds_disagree"] = (
        df["judged_rounds"].notna()
        & (pd.to_numeric(df["judged_rounds"], errors="coerce")
           > pd.to_numeric(df["scheduled_rounds"], errors="coerce"))
    )
    return df

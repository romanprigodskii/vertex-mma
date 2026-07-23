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

import numpy as np
import pandas as pd

# Judging conventions before ~2011 are a different regime AND the scrape is
# thin there (2006: 3 carded decisions, 2009: 41, 2011: 99 of 147). Cards
# before this date are ignored and those bouts fall back to the method proxy.
SCORECARD_MIN_DATE = "2011-01-01"

FINISH_METHODS = ("ko", "tko", "submission")

# ── the scale ─────────────────────────────────────────────────────────
#
# `dominance_a` is 0.5 + a signed margin. Two anchors fix everything else and
# both come from the brief's ladder:
#
#   DOM_FINISH_MAX  an instant finish            -> 0.95
#   DOM_FINISH_MIN  a finish at the final horn   -> 0.85
#   DOM_DECISION    a unanimous shutout          -> 0.85
#
# Between them the scale is CONTINUOUS in the two things actually measured —
# elapsed fight time for a finish, round/judge margin for a decision — rather
# than a step per bucket. It reproduces the brief's ladder to ~0.02 at every
# rung (R2 finish 0.90, R3 0.87, unanimous 2-1 0.70, majority 0.66, split
# 0.62) while giving the learner a gradient inside each rung.
DOM_FINISH_MAX = 0.45
DOM_FINISH_MIN = 0.35
DOM_DECISION = 0.35
# A decision's signed margin mixes how many ROUNDS the winner took with how
# many JUDGES they took. Rounds carry more because they are the finer
# measurement (a 5-round fight has 5 of them, and 'unanimous' cannot tell a
# shutout from a 2-1 card), but judge agreement is the only thing available
# for the 881 decisions with no scraped card, so it gets real weight too.
W_ROUND = 0.65
W_JUDGE = 0.35
# Fraction of judges who scored the fight for the winner — this is exactly
# what the method enum encodes, so it is read off the method rather than
# recomputed from cards (no double-counting with round_share).
JUDGE_SHARE = {
    "decision_unanimous": 1.0,
    "decision_majority": 5.0 / 6.0,  # two judges to the winner, one even
    "decision_split": 2.0 / 3.0,     # two to the winner, one to the loser
}
# A disqualification says a rule was broken, not that anyone was outclassed —
# several are eye pokes and illegal knees against a fighter who was winning.
# Scored as a marginal win rather than a blowout.
DOM_DQ = 0.55
# Floor on a win. Round-majority and judge-totals genuinely disagree on some
# split decisions: three judges can each give the winner two rounds while the
# MAJORITY of judges gives the winner only one, because they picked different
# rounds. The round term then points at the loser. That is real structure, not
# a scrape error — but a label that put the recorded winner below 0.5 would
# flatly contradict `target_a_wins` on the same row, so the most disputed win
# imaginable still floors here.
DOM_MIN_WIN = 0.55
ROUND_SECONDS = 300

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


# ── the label ─────────────────────────────────────────────────────────


def _elapsed_fraction(df: pd.DataFrame) -> pd.Series:
    """How far into the scheduled distance the finish came, in (0, 1].

    `time_finished_seconds` is the clock WITHIN the finishing round (non-null
    on all 8,784 completed bouts), so the elapsed total is the completed
    rounds plus that. The denominator uses the greater of scheduled and
    actually-judged rounds, which is what keeps the 8 bouts carrying
    scheduled_rounds=3 alongside five judged rounds from producing a fraction
    above 1.
    """
    rf = pd.to_numeric(df["round_finished"], errors="coerce")
    tf = pd.to_numeric(df["time_finished_seconds"], errors="coerce")
    sched = pd.to_numeric(df["scheduled_rounds"], errors="coerce")
    judged = pd.to_numeric(df.get("judged_rounds"), errors="coerce")
    horizon = pd.concat([sched, judged], axis=1).max(axis=1).fillna(sched)
    elapsed = (rf - 1) * ROUND_SECONDS + tf
    total = horizon * ROUND_SECONDS
    return (elapsed / total).clip(lower=0.0, upper=1.0)


def _decision_margin(df: pd.DataFrame, imputed_round_margin: dict[str, float]) -> pd.Series:
    """Signed decision margin in [-1, 1], oriented on the RAW DB fighter A.

    `imputed_round_margin` supplies the round term for decisions with no
    usable card, keyed by method. A unanimous decision without a card is NOT
    treated as a shutout — it gets the mean round margin of the unanimous
    decisions that do have cards, which is materially less than 1.0.
    """
    method = df["method"].fillna("")
    judge_share = method.map(JUDGE_SHARE)
    judge_signed = 2.0 * judge_share - 1.0

    rs = pd.to_numeric(df["round_share_a"], errors="coerce")
    round_signed = 2.0 * rs - 1.0
    fallback = method.map(imputed_round_margin)
    round_signed = round_signed.where(round_signed.notna(), fallback)

    # Orient onto the WINNER, then back onto A. The two card-free terms are
    # magnitudes ("the winner's margin"), so they need a direction; the carded
    # term already has one and is left alone.
    a_won = df["winner_id"] == df["fighter_a_id"]
    sign = pd.Series(np.where(a_won, 1.0, -1.0), index=df.index)
    round_signed = round_signed.where(
        pd.to_numeric(df["round_share_a"], errors="coerce").notna(),
        round_signed.abs() * sign,
    )
    return W_ROUND * round_signed + W_JUDGE * (judge_signed.abs() * sign)


def _imputed_round_margins(df: pd.DataFrame) -> dict[str, float]:
    """Mean |round margin| among CARDED decisions, per method — the stand-in
    for the 881 decisions with no usable card."""
    carded = df[(df["card_source"] == "cards") & df["winner_id"].notna()]
    rs = pd.to_numeric(carded["round_share_a"], errors="coerce")
    margin = (2.0 * rs - 1.0).abs()
    out = margin.groupby(carded["method"]).mean().to_dict()
    return {k: float(v) for k, v in out.items()}


def add_dominance(df: pd.DataFrame) -> pd.DataFrame:
    """Attach `dominance_a` (and its provenance flags) to a frame from
    `fetch_outcomes`.

    dominance_a in [0, 1] — how convincingly the RAW DB fighter A won.
    0.5 is a draw or a no-contest; 1.0 would be a total shutout of B.
    """
    out = df.copy()
    imputed = _imputed_round_margins(out)

    method = out["method"].fillna("")
    is_finish = method.isin(FINISH_METHODS)
    is_decision = method.str.startswith("decision")
    is_dq = method == "dq"
    # NULL winner is how the DB records a draw (and every no-contest). The
    # 2026-07 repair restored those NULLs after 74 bouts had carried a
    # fabricated winner; the assertion in `validate` pins that they stay NULL.
    decided = out["winner_id"].notna()
    a_won = out["winner_id"] == out["fighter_a_id"]
    sign = np.where(a_won, 1.0, -1.0)

    dom = pd.Series(0.5, index=out.index, dtype=float)

    t = _elapsed_fraction(out)
    fin_mag = DOM_FINISH_MAX - (DOM_FINISH_MAX - DOM_FINISH_MIN) * t
    sel = is_finish & decided
    dom[sel] = 0.5 + sign[sel] * fin_mag[sel]

    sel = is_decision & decided
    dom[sel] = 0.5 + DOM_DECISION * _decision_margin(out, imputed)[sel]

    sel = is_dq & decided
    dom[sel] = 0.5 + sign[sel] * (DOM_DQ - 0.5)

    # Enforce the floor on a decided bout: the graded label refines
    # `target_a_wins`, it never overrules it. Clipping happens in the WINNER's
    # orientation, so a margin that points at the loser collapses to the floor
    # instead of being mirrored into a large one for the winner.
    winner_dom = pd.Series(np.where(a_won, dom, 1.0 - dom), index=out.index)
    floored = decided & (winner_dom < DOM_MIN_WIN)
    winner_dom = winner_dom.clip(lower=DOM_MIN_WIN)
    dom[decided] = np.where(a_won, winner_dom, 1.0 - winner_dom)[decided]

    out["dominance_a"] = dom.clip(0.0, 1.0)
    out["dominance_floored"] = floored.to_numpy()
    # True where the round term was imputed from the method rather than read
    # off a card — 881 decisions, so any report that leans on round margin can
    # say how much of it was measured.
    out["dominance_estimated"] = (is_decision & (out["card_source"] != "cards")).to_numpy()
    return out


def validate(df: pd.DataFrame) -> None:
    """Assertions this label is not allowed to violate."""
    dom = df["dominance_a"]
    assert dom.notna().all(), "dominance_a has nulls"
    assert ((dom >= 0.0) & (dom <= 1.0)).all(), "dominance_a out of [0,1]"

    # Draws and no-contests: exactly 0.5, and still genuinely winner-less.
    # These are the 2026-07 data repair's rows; a non-NULL winner here would
    # mean the fabricated winners came back.
    drawish = df["winner_id"].isna()
    assert (dom[drawish] == 0.5).all(), "a winner-less bout scored off 0.5"
    assert df.loc[drawish, "winner_id"].isna().all()

    # Direction: whoever won must be above 0.5. This is the check that catches
    # an orientation bug, which is the failure mode that would otherwise show
    # up as a brilliant backtest and nothing on serving.
    decided = df["winner_id"].notna()
    a_won = decided & (df["winner_id"] == df["fighter_a_id"])
    b_won = decided & ~a_won
    assert (dom[a_won] > 0.5).all(), "A won but dominance_a <= 0.5"
    assert (dom[b_won] < 0.5).all(), "B won but dominance_a >= 0.5"

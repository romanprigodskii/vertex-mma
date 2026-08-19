"""Pulls bouts + per-fighter history out of Postgres and builds a
leakage-free per-bout feature matrix.

Strategy: dump everything we need from the DB in three flat queries, then
walk bouts in chronological order in pandas. For each fighter we keep a
running history of their completed bouts; when a new bout appears we
snapshot the running aggregates ("stats up to but NOT including this
bout") into the feature row. That guarantees no feature ever uses
information from the bout it's trying to predict — the most common
leakage source in MMA models.

The output is a single CSV/parquet at `data/dataset.parquet` with one
row per completed UFC bout where both fighters had ≥1 prior UFC bout
(otherwise we have nothing to predict from — those are surfaced as
"warmup" bouts and excluded from training).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd
from rich.console import Console

from .db import get_connection
from .dominance import SCORECARDS_SQL, add_dominance, attach_round_share
from .opponent_ratings import ALL_KEYS as RATING_ALL_KEYS
from .opponent_ratings import compute_rating_snapshots

console = Console()

# The three buckets the method market settles on. Mirror of
# `methodBucket` in src/lib/sportsbook.ts — keep the two in sync, because a
# disagreement would train the method model on one grading and pay out on
# another.
METHOD_BUCKETS = ("ko", "sub", "dec")


def method_bucket(method: str | None) -> str | None:
    """UFCStats method enum → ko / sub / dec, or None for anything the method
    market voids (dq, draw, no-contest, missing)."""
    if method is None:
        return None
    if method in ("ko", "tko"):
        return "ko"
    if method == "submission":
        return "sub"
    if method.startswith("decision"):
        return "dec"
    return None


def stable_hash(s: str) -> int:
    """Deterministic 32-bit hash of a string, stable across processes.

    Python's builtin ``hash()`` is salted per-process (PYTHONHASHSEED is
    randomized unless pinned), so using it for the A/B symmetrization flip
    and the Monte-Carlo seed made both non-reproducible: retraining
    reshuffled which bouts were flipped (a different model every run) and
    each predict run drew a different MC distribution despite the
    "bout-stable" contract in predict.py. blake2b is seed-free, so the same
    bout_id always maps to the same value."""
    return int.from_bytes(
        hashlib.blake2b(s.encode("utf-8"), digest_size=4).digest(), "big"
    )


# --------------------------------------------------------------------------
# SQL fetches
# --------------------------------------------------------------------------

BOUTS_SQL = """
SELECT
  b.id::text AS bout_id,
  e.id::text AS event_id,
  e.date::date AS event_date,
  b.fighter_a_id::text AS fighter_a_id,
  b.fighter_b_id::text AS fighter_b_id,
  b.weight_class::text AS weight_class,
  b.is_title_fight,
  b.is_main_event,
  b.scheduled_rounds,
  b.status::text AS status,
  b.winner_id::text AS winner_id,
  b.method::text AS method,
  b.round_finished,
  b.time_finished_seconds
FROM bout b
JOIN event e ON e.id = b.event_id
WHERE e.promotion = 'ufc'
ORDER BY e.date ASC, b.bout_order ASC NULLS LAST, b.id ASC
"""

# Per-(bout, fighter) round-summed stats. We sum per fighter across all
# rounds of the bout — gives us totals per bout to feed running averages.
ROUND_STATS_SQL = """
SELECT
  brs.bout_id::text AS bout_id,
  brs.fighter_id::text AS fighter_id,
  SUM(brs.sig_str_landed)::int AS sig_str_landed,
  SUM(brs.sig_str_attempted)::int AS sig_str_attempted,
  SUM(brs.sig_str_head_landed)::int AS sig_str_head_landed,
  SUM(brs.sig_str_body_landed)::int AS sig_str_body_landed,
  SUM(brs.sig_str_legs_landed)::int AS sig_str_legs_landed,
  SUM(brs.sig_str_distance_landed)::int AS sig_str_distance_landed,
  SUM(brs.sig_str_clinch_landed)::int AS sig_str_clinch_landed,
  SUM(brs.sig_str_ground_landed)::int AS sig_str_ground_landed,
  SUM(brs.total_str_landed)::int AS total_str_landed,
  SUM(brs.total_str_attempted)::int AS total_str_attempted,
  SUM(brs.takedowns_landed)::int AS td_landed,
  SUM(brs.takedowns_attempted)::int AS td_attempted,
  SUM(brs.sub_attempts)::int AS sub_attempts,
  SUM(brs.reversals)::int AS reversals,
  SUM(brs.knockdowns)::int AS knockdowns,
  SUM(brs.control_time_seconds)::int AS control_seconds,
  COUNT(*)::int AS rounds_recorded
FROM bout_round_stats brs
GROUP BY brs.bout_id, brs.fighter_id
"""

FIGHTERS_SQL = """
SELECT
  f.id::text AS fighter_id,
  f.dob::date AS dob,
  f.height_cm,
  f.reach_cm,
  f.leg_reach_cm,
  f.stance::text AS stance,
  f.gender,
  (f.sherdog_id IS NOT NULL) AS sherdog_matched,
  -- v0.15.0 — nationality as Sherdog publishes it. Read from
  -- sherdog_flag_code and NOT from country_code: the latter is Wikidata
  -- P27 and only covers 35% of the roster, concentrated on the notable
  -- end, so a term fitted on it is fitted where it is visible and served
  -- where it mostly is not. That coverage asymmetry is exactly what made
  -- the first version of this lever fail its held-out leg
  -- (docs/accuracy_batch.md §2). sherdog_flag_code reaches 4,136 of
  -- 4,577 fighters and 99% of the test window.
  --
  -- Only the US indicator is used, so the Home-Nations vocabulary problem
  -- that stopped these codes being written into country_code ('en' for
  -- England, not ISO) does not reach the model: 'US' means the same thing
  -- in both sources.
  (f.sherdog_flag_code = 'US') AS is_american
FROM fighter f
"""

# Non-UFC career fights from Sherdog (v0.9.0 — the pre-UFC information
# gap fix). Only is_ufc=false rows: the fighter's UFC bouts are already
# covered by the UFCStats-derived running history, counting them twice
# would double-weight them. Rows without a date can't be placed on the
# timeline (point-in-time guarantee), so they're skipped — they're rare
# early-career obscurities. History never changes retroactively, so
# today's scrape is valid for bouts years in the past: every fight
# counted for a bout at date D happened strictly before D.
SHERDOG_SQL = """
SELECT
  fighter_id::text AS fighter_id,
  event_date::date AS event_date,
  result,
  method_class,
  round,
  time_seconds,
  event_name
FROM fighter_sherdog_bout
WHERE NOT is_ufc AND event_date IS NOT NULL
ORDER BY fighter_id, event_date
"""

# LATEST (closing) sportsbook line per bout (one row per bout, source
# preferred = 'bestfightodds'). The scraper UPSERTs the same (bout_id,
# source) row every ~6h (08_scrape_bestfightodds.py: ON CONFLICT DO UPDATE),
# so for a completed bout this is the closing line, NOT an opening line.
# `ORDER BY ... fetched_at DESC` just picks the freshest scrape per bout.
# Decimal odds → implied prob downstream. As of the market-leak fix this is
# used ONLY for the edge/value display (model_prob - market_prob); it is NOT
# a model feature (a closing line is a near-leak in backtest and is absent
# for most upcoming bouts at predict time — train/serve skew).
EXTERNAL_ODDS_SQL = """
SELECT DISTINCT ON (bout_id)
  bout_id::text AS bout_id,
  winner_a_decimal,
  winner_b_decimal
FROM bout_external_odds
WHERE winner_a_decimal IS NOT NULL
  AND winner_b_decimal IS NOT NULL
ORDER BY bout_id, source = 'bestfightodds' DESC, fetched_at DESC
"""

# Point-in-time vertex_score (Wave 31.7 replay history). For each bout
# event_date we want each fighter's most-recent kind='bout' snapshot at
# or before that date. We pull the raw history and merge in pandas.
SCORE_HISTORY_SQL = """
SELECT
  fighter_id::text AS fighter_id,
  as_of_date::date AS as_of_date,
  vertex_score,
  vertex_score_all_time
FROM fighter_score_history
WHERE kind = 'bout'
ORDER BY fighter_id, as_of_date
"""


def _fetch_df(conn, sql: str) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


@dataclass
class RawData:
    bouts: pd.DataFrame
    round_stats: pd.DataFrame
    fighters: pd.DataFrame
    odds: pd.DataFrame
    score_history: pd.DataFrame
    sherdog: pd.DataFrame
    # Judges' round-by-round cards, for the graded `dominance_a` LABEL only
    # (src/dominance.py). Never a feature — see the ban documented there.
    scorecards: pd.DataFrame


def fetch_raw() -> RawData:
    """One trip to Postgres for everything we need."""
    console.log("connecting to Postgres…")
    with get_connection() as conn:
        bouts = _fetch_df(conn, BOUTS_SQL)
        round_stats = _fetch_df(conn, ROUND_STATS_SQL)
        fighters = _fetch_df(conn, FIGHTERS_SQL)
        odds = _fetch_df(conn, EXTERNAL_ODDS_SQL)
        score_history = _fetch_df(conn, SCORE_HISTORY_SQL)
        sherdog = _fetch_df(conn, SHERDOG_SQL)
        scorecards = _fetch_df(conn, SCORECARDS_SQL)
    console.log(
        f"fetched {len(bouts):,} bouts · {len(round_stats):,} round-stat rows · "
        f"{len(fighters):,} fighters · {len(odds):,} odds rows · "
        f"{len(score_history):,} score-history rows · "
        f"{len(sherdog):,} sherdog career rows · "
        f"{len(scorecards):,} judge scorecard rows"
    )
    return RawData(bouts, round_stats, fighters, odds, score_history, sherdog, scorecards)


# --------------------------------------------------------------------------
# Pre-UFC career snapshot (Sherdog-derived, v0.9.0)
# --------------------------------------------------------------------------

# Base names of the per-side pre-UFC columns (suffixed _a/_b on rows).
PREUFC_KEYS = (
    "preufc_bouts",
    "preufc_wins",
    "preufc_losses",
    "preufc_win_rate",
    "preufc_ko_rate",
    "preufc_sub_rate",
    "preufc_finish_rate",
    "preufc_finish_losses",
    "preufc_career_days",
    # Recency / trajectory — the record alone barely separates debutants
    # (nearly every UFC signee arrives 10-2-ish); WHEN and WHERE they
    # fought carries the sharper signal. days_since_last is the
    # debutant's REAL layoff (their UFC layoff_days is NaN by
    # construction); dwcs_fights = Contender Series appearances (UFC-
    # caliber vetting the market prices in); avg_win_seconds = finish
    # speed.
    "preufc_days_since_last",
    "preufc_fights_last_24mo",
    "preufc_last3_wins",
    "preufc_dwcs_fights",
    "preufc_avg_win_seconds",
)

_PREUFC_EMPTY: dict[str, Any] = {
    "sherdog_matched": False,
    **{k: None for k in PREUFC_KEYS},
}

_DWCS_RE = re.compile(r"contender series|dwcs", re.IGNORECASE)


@dataclass(frozen=True)
class PreUfcFight:
    """One non-UFC career fight, pre-shaped for snapshotting."""

    event_date: date
    result: str  # 'win' | 'loss' | 'draw' | 'nc'
    method_class: str | None
    duration_seconds: int | None  # (round-1)*300 + time, when known
    is_dwcs: bool


def preufc_snapshot(
    fights: list[PreUfcFight],
    ev_date: date,
    *,
    matched: bool,
) -> dict[str, Any]:
    """Non-UFC career record strictly before `ev_date`, from the fighter's
    Sherdog history sorted by date ascending.

    `matched=False` (fighter has no verified Sherdog profile) returns all
    None — "we don't know" — while a matched fighter with zero regional
    fights before ev_date returns real zeros (e.g. Olympians who debuted
    straight into the UFC). The sherdog_matched flag rides along so the
    model can tell the two apart; that's the same trick as is_debut for
    the specialist. Rates use bouts as the denominator (ko/sub) except
    finish_rate (share of WINS that were finishes), mirroring the UFC
    prior_* semantics."""
    if not matched:
        return dict(_PREUFC_EMPTY)
    wins = losses = draws = ko_wins = sub_wins = finish_losses = 0
    dwcs = 0
    fights_24mo = 0
    first_fight: date | None = None
    last_fight: date | None = None
    recent_results: list[str] = []
    win_seconds: list[int] = []
    for f in fights:
        if f.event_date >= ev_date:
            break  # sorted ascending — nothing later can count
        if f.result == "nc":
            continue  # NCs never touch history (mirrors FighterHistory)
        if first_fight is None:
            first_fight = f.event_date
        last_fight = f.event_date
        recent_results.append(f.result)
        if f.is_dwcs:
            dwcs += 1
        if (ev_date - f.event_date).days <= 730:
            fights_24mo += 1
        if f.result == "win":
            wins += 1
            if f.method_class == "ko":
                ko_wins += 1
            elif f.method_class == "submission":
                sub_wins += 1
            if f.duration_seconds is not None:
                win_seconds.append(f.duration_seconds)
        elif f.result == "loss":
            losses += 1
            if f.method_class in ("ko", "submission"):
                finish_losses += 1
        else:  # draw
            draws += 1
    bouts = wins + losses + draws
    return {
        "sherdog_matched": True,
        "preufc_bouts": bouts,
        "preufc_wins": wins,
        "preufc_losses": losses,
        "preufc_win_rate": wins / bouts if bouts else None,
        "preufc_ko_rate": ko_wins / bouts if bouts else None,
        "preufc_sub_rate": sub_wins / bouts if bouts else None,
        "preufc_finish_rate": (ko_wins + sub_wins) / wins if wins else None,
        "preufc_finish_losses": finish_losses,
        "preufc_career_days": (
            (ev_date - first_fight).days if first_fight is not None else None
        ),
        "preufc_days_since_last": (
            (ev_date - last_fight).days if last_fight is not None else None
        ),
        "preufc_fights_last_24mo": fights_24mo,
        "preufc_last3_wins": sum(1 for r in recent_results[-3:] if r == "win"),
        "preufc_dwcs_fights": dwcs,
        "preufc_avg_win_seconds": (
            sum(win_seconds) / len(win_seconds) if win_seconds else None
        ),
    }


def make_preufc_fight(
    event_date: date,
    result: str,
    method_class: str | None,
    round_num: Any,
    time_seconds: Any,
    event_name: str | None,
) -> PreUfcFight:
    """Shape one raw fighter_sherdog_bout row (from SHERDOG_SQL or
    custom.PREUFC_SQL) into a PreUfcFight."""
    duration: int | None = None
    if round_num is not None and not pd.isna(round_num):
        partial = (
            int(time_seconds)
            if time_seconds is not None and not pd.isna(time_seconds)
            else 300
        )
        duration = max(0, int(round_num) - 1) * 300 + partial
    return PreUfcFight(
        event_date=event_date,
        result=result,
        method_class=method_class,
        duration_seconds=duration,
        is_dwcs=bool(_DWCS_RE.search(event_name or "")),
    )


def group_sherdog_fights(
    sherdog: pd.DataFrame,
) -> dict[str, list[PreUfcFight]]:
    """fighter_id -> [PreUfcFight] sorted by date (SHERDOG_SQL already
    orders by fighter_id, event_date)."""
    out: dict[str, list[PreUfcFight]] = {}
    if sherdog.empty:
        return out
    for row in sherdog.itertuples(index=False):
        d = row.event_date
        if not isinstance(d, date):
            d = pd.to_datetime(d).date()
        out.setdefault(row.fighter_id, []).append(
            make_preufc_fight(
                d,
                row.result,
                row.method_class,
                row.round,
                row.time_seconds,
                row.event_name,
            )
        )
    return out


# --------------------------------------------------------------------------
# Per-fighter running history
# --------------------------------------------------------------------------


def _fight_duration_seconds(row: dict[str, Any], scheduled_rounds: int) -> int:
    """How long the bout lasted in seconds.

    For completed bouts that ended via finish, use round_finished and
    time_finished_seconds (seconds INTO the finishing round). For bouts
    that went the full distance, use scheduled_rounds × 300.
    """
    rf = row.get("round_finished")
    if rf is None or pd.isna(rf):
        return scheduled_rounds * 300
    tf = row.get("time_finished_seconds")
    full_rounds_done = max(0, int(rf) - 1) * 300
    partial = int(tf) if tf is not None and not pd.isna(tf) else 300
    return full_rounds_done + partial


class FighterHistory:
    """Running aggregates for one fighter, updated bout-by-bout in
    chronological order. Snapshot returns features as of "right before the
    next bout"."""

    __slots__ = (
        "bouts",
        "wins",
        "losses",
        "wins_ko",
        "wins_sub",
        "wins_dec",
        "losses_ko",
        "losses_sub",
        "losses_dec",
        "sig_str_landed",
        "sig_str_attempted",
        "sig_str_absorbed",  # opponent's landed against us
        "sig_str_head_landed",
        "sig_str_body_landed",
        "sig_str_legs_landed",
        "sig_str_distance_landed",
        "sig_str_clinch_landed",
        "sig_str_ground_landed",
        "td_landed",
        "td_attempted",
        "td_def_attempted",  # opp attempts against us
        "td_def_stopped",  # opp attempts we stopped
        "sub_attempts",
        "reversals",
        "knockdowns",
        "knockdowns_absorbed",
        # Submission attempts CONCEDED (v0.12.1). The grappling analogue of a
        # chin: `prior_losses_sub` only counts completed submissions, which is
        # far too sparse to separate "hard to submit" from "never met a
        # grappler". Every attempt survived is a datum, and until now they
        # were all discarded. Added for the method leg's submission cell.
        "sub_attempts_absorbed",
        "control_seconds",
        "control_seconds_absorbed",
        "total_seconds",
        "stat_seconds",  # time in bouts that HAD round-stats (per-minute denom)
        "title_bouts",
        "last_bout_date",
        "recent_results",  # list of "W"/"L" for last N bouts
        "last_vertex_score",
        "last_vertex_score_all_time",
        "current_streak",  # +N for N-win streak, -N for losing streak
    )

    def __init__(self) -> None:
        self.bouts = 0
        self.wins = 0
        self.losses = 0
        self.wins_ko = 0
        self.wins_sub = 0
        self.wins_dec = 0
        self.losses_ko = 0
        self.losses_sub = 0
        self.losses_dec = 0
        self.sig_str_landed = 0
        self.sig_str_attempted = 0
        self.sig_str_absorbed = 0
        self.sig_str_head_landed = 0
        self.sig_str_body_landed = 0
        self.sig_str_legs_landed = 0
        self.sig_str_distance_landed = 0
        self.sig_str_clinch_landed = 0
        self.sig_str_ground_landed = 0
        self.td_landed = 0
        self.td_attempted = 0
        self.td_def_attempted = 0
        self.td_def_stopped = 0
        self.sub_attempts = 0
        self.reversals = 0
        self.knockdowns = 0
        self.knockdowns_absorbed = 0
        self.sub_attempts_absorbed = 0
        self.control_seconds = 0
        self.control_seconds_absorbed = 0
        self.total_seconds = 0
        self.stat_seconds = 0
        self.title_bouts = 0
        self.last_bout_date: date | None = None
        self.recent_results: list[str] = []
        self.last_vertex_score: int | None = None
        self.last_vertex_score_all_time: int | None = None
        self.current_streak: int = 0

    def snapshot(self, event_dt: date) -> dict[str, Any]:
        """Features as of just before `event_dt`."""
        win_rate = self.wins / self.bouts if self.bouts else None
        finish_rate = (
            (self.wins_ko + self.wins_sub) / self.wins if self.wins else None
        )
        # Per-minute / per-15-min rates use stat_seconds — the time spent in
        # bouts that actually HAD round-stats — as the denominator, so they
        # match the numerators (sig strikes, TDs, control), which only
        # accumulate for those bouts. Using total_seconds (all bouts) diluted
        # the rates for fighters with stat-less bouts in their history.
        per_min = (self.stat_seconds / 60.0) if self.stat_seconds else None
        per_15m = (self.stat_seconds / 900.0) if self.stat_seconds else None
        slpm = (self.sig_str_landed / per_min) if per_min else None
        sapm = (self.sig_str_absorbed / per_min) if per_min else None
        td_per15 = (self.td_landed / per_15m) if per_15m else None
        td_acc = (
            self.td_landed / self.td_attempted if self.td_attempted else None
        )
        td_def = (
            self.td_def_stopped / self.td_def_attempted
            if self.td_def_attempted
            else None
        )
        str_acc = (
            self.sig_str_landed / self.sig_str_attempted
            if self.sig_str_attempted
            else None
        )
        sub_per15 = (self.sub_attempts / per_15m) if per_15m else None
        kd_per_fight = (self.knockdowns / self.bouts) if self.bouts else None
        control_per_min = (self.control_seconds / per_min) if per_min else None
        layoff_days = None
        if self.last_bout_date is not None:
            layoff_days = (event_dt - self.last_bout_date).days
        recent3_wins = sum(1 for r in self.recent_results[-3:] if r == "W")
        recent5_wins = sum(1 for r in self.recent_results[-5:] if r == "W")

        # Phase 4 additions ------------------------------------------------
        sig_total_landed = self.sig_str_landed or 0
        # Strike-location preferences (share of landed sig strikes by zone).
        head_share = self.sig_str_head_landed / sig_total_landed if sig_total_landed else None
        body_share = self.sig_str_body_landed / sig_total_landed if sig_total_landed else None
        legs_share = self.sig_str_legs_landed / sig_total_landed if sig_total_landed else None
        # Range preference: what % of landed sig strikes happened at
        # distance (vs in clinch / on the ground). Distance share +
        # ground share roughly read as striker vs grappler.
        distance_share = (
            self.sig_str_distance_landed / sig_total_landed if sig_total_landed else None
        )
        clinch_share = (
            self.sig_str_clinch_landed / sig_total_landed if sig_total_landed else None
        )
        ground_share = (
            self.sig_str_ground_landed / sig_total_landed if sig_total_landed else None
        )
        # Durability proxies.
        kd_absorbed_per_fight = (
            self.knockdowns_absorbed / self.bouts if self.bouts else None
        )
        control_absorbed_per_min = (
            self.control_seconds_absorbed / per_min if per_min else None
        )
        reversals_per_fight = self.reversals / self.bouts if self.bouts else None
        sub_att_absorbed_per15 = (
            self.sub_attempts_absorbed / per_15m if per_15m else None
        )
        # Career pacing.
        avg_bout_seconds = self.total_seconds / self.bouts if self.bouts else None
        title_bouts_ratio = self.title_bouts / self.bouts if self.bouts else None
        # Finish "for" vs "against" — separate from finish_rate which is
        # "share of WINS that were finishes" (this is finishes per bout).
        finish_for_per_bout = (
            (self.wins_ko + self.wins_sub) / self.bouts if self.bouts else None
        )
        finish_against_per_bout = (
            (self.losses_ko + self.losses_sub) / self.bouts if self.bouts else None
        )

        return {
            "prior_bouts": self.bouts,
            "prior_wins": self.wins,
            "prior_losses": self.losses,
            "prior_win_rate": win_rate,
            "prior_finish_rate": finish_rate,
            "prior_wins_ko": self.wins_ko,
            "prior_wins_sub": self.wins_sub,
            "prior_wins_dec": self.wins_dec,
            "prior_losses_ko": self.losses_ko,
            "prior_losses_sub": self.losses_sub,
            "prior_losses_dec": self.losses_dec,
            "slpm": slpm,
            "sapm": sapm,
            "str_acc": str_acc,
            "td_per15": td_per15,
            "td_acc": td_acc,
            "td_def": td_def,
            "sub_per15": sub_per15,
            "kd_per_fight": kd_per_fight,
            "control_per_min": control_per_min,
            "title_bouts": self.title_bouts,
            "layoff_days": layoff_days,
            "recent3_wins": recent3_wins,
            "recent5_wins": recent5_wins,
            "vertex_score": self.last_vertex_score,
            "vertex_score_all_time": self.last_vertex_score_all_time,
            # Phase 4
            "head_share": head_share,
            "body_share": body_share,
            "legs_share": legs_share,
            "distance_share": distance_share,
            "clinch_share": clinch_share,
            "ground_share": ground_share,
            "kd_absorbed_per_fight": kd_absorbed_per_fight,
            "control_absorbed_per_min": control_absorbed_per_min,
            "sub_att_absorbed_per15": sub_att_absorbed_per15,
            "reversals_per_fight": reversals_per_fight,
            "avg_bout_seconds": avg_bout_seconds,
            "title_bouts_ratio": title_bouts_ratio,
            "finish_for_per_bout": finish_for_per_bout,
            "finish_against_per_bout": finish_against_per_bout,
            "current_streak": self.current_streak,
        }

    def apply_bout(
        self,
        *,
        result: str,  # "win" | "loss" | "draw"
        method: str | None,
        is_title_fight: bool,
        event_dt: date,
        own_stats: dict[str, int] | None,
        opp_stats: dict[str, int] | None,
        duration_seconds: int,
    ) -> None:
        self.bouts += 1
        if is_title_fight:
            self.title_bouts += 1
        # method may be NULL in DB → comes back as NaN from pandas. Treat
        # as empty so the categorical branches below default to "no method".
        if method is None or (isinstance(method, float) and pd.isna(method)):
            method = ""
        else:
            method = str(method).lower()
        if result == "win":
            self.wins += 1
            if method in ("ko", "tko"):
                self.wins_ko += 1
            elif method == "submission":
                self.wins_sub += 1
            elif method.startswith("decision"):
                self.wins_dec += 1
            self.recent_results.append("W")
            self.current_streak = max(1, self.current_streak + 1) if self.current_streak >= 0 else 1
        elif result == "loss":
            self.losses += 1
            if method in ("ko", "tko"):
                self.losses_ko += 1
            elif method == "submission":
                self.losses_sub += 1
            elif method.startswith("decision"):
                self.losses_dec += 1
            self.recent_results.append("L")
            self.current_streak = min(-1, self.current_streak - 1) if self.current_streak <= 0 else -1
        else:  # draw — a bout that happened, but neither a win nor a loss.
            # Previously draws were funneled through the `else` branch above and
            # counted as LOSSES for BOTH fighters (losses += 1, "L" in form,
            # streak driven negative), permanently corrupting win_rate / losses
            # / recent form / streak for every later snapshot. A draw must not
            # touch wins or losses. Record "D" so it still occupies a recency
            # slot (recentN_wins counts "W", and "D" correctly is not a win) and
            # snap the streak to 0 (a draw ends a run without starting one).
            self.recent_results.append("D")
            self.current_streak = 0
        # Keep recent_results bounded so it doesn't grow forever; only the
        # tail matters for recent-form features.
        if len(self.recent_results) > 10:
            self.recent_results = self.recent_results[-10:]
        self.last_bout_date = event_dt
        self.total_seconds += duration_seconds
        if own_stats:
            # Only count this bout's time toward the per-minute denominator when
            # we have its round-stats — otherwise the rates get diluted.
            self.stat_seconds += duration_seconds
            self.sig_str_landed += own_stats.get("sig_str_landed", 0) or 0
            self.sig_str_attempted += own_stats.get("sig_str_attempted", 0) or 0
            self.sig_str_head_landed += own_stats.get("sig_str_head_landed", 0) or 0
            self.sig_str_body_landed += own_stats.get("sig_str_body_landed", 0) or 0
            self.sig_str_legs_landed += own_stats.get("sig_str_legs_landed", 0) or 0
            self.sig_str_distance_landed += own_stats.get("sig_str_distance_landed", 0) or 0
            self.sig_str_clinch_landed += own_stats.get("sig_str_clinch_landed", 0) or 0
            self.sig_str_ground_landed += own_stats.get("sig_str_ground_landed", 0) or 0
            self.td_landed += own_stats.get("td_landed", 0) or 0
            self.td_attempted += own_stats.get("td_attempted", 0) or 0
            self.sub_attempts += own_stats.get("sub_attempts", 0) or 0
            self.reversals += own_stats.get("reversals", 0) or 0
            self.knockdowns += own_stats.get("knockdowns", 0) or 0
            self.control_seconds += own_stats.get("control_seconds", 0) or 0
        if opp_stats:
            self.sig_str_absorbed += opp_stats.get("sig_str_landed", 0) or 0
            self.knockdowns_absorbed += opp_stats.get("knockdowns", 0) or 0
            self.sub_attempts_absorbed += opp_stats.get("sub_attempts", 0) or 0
            self.control_seconds_absorbed += opp_stats.get("control_seconds", 0) or 0
            self.td_def_attempted += opp_stats.get("td_attempted", 0) or 0
            self.td_def_stopped += (
                (opp_stats.get("td_attempted", 0) or 0)
                - (opp_stats.get("td_landed", 0) or 0)
            )


# --------------------------------------------------------------------------
# Dataset assembly
# --------------------------------------------------------------------------


def _dominance_map(raw: RawData) -> dict[str, float]:
    """bout_id → `dominance_a`, over completed bouts only.

    Draws and no-contests are scored (0.5) rather than dropped, but they never
    reach a training row: `target_a_wins` is None for them and `should_emit`
    already requires a target. Kept in the map so the column is populated for
    anyone who does emit them, and so the count is auditable.
    """
    completed = raw.bouts[raw.bouts["status"] == "completed"].copy()
    if completed.empty:
        return {}
    scored = add_dominance(attach_round_share(completed, raw.scorecards))
    return dict(zip(scored["bout_id"], scored["dominance_a"].astype(float), strict=True))


def build_dataset(
    raw: RawData, *, include_scheduled: bool = False, include_debuts: bool = False
) -> pd.DataFrame:
    """Walk bouts in chronological order, snapshot features per fighter
    BEFORE applying each bout's result, then update history. Returns
    one row per (bout) with side-A + side-B features and target.

    When `include_scheduled=True`, rows for upcoming (status != 'completed')
    bouts are emitted with `target_a_wins` set to NaN — used at inference
    time to score future bouts. Their results aren't applied to history
    since they haven't happened yet.

    When `include_debuts=True` (v0.8.0), bouts where a fighter has ZERO
    prior UFC bouts are emitted too, flagged `is_debut_a`/`is_debut_b` with
    the debutant's career columns left None/NaN (LightGBM/XGBoost consume
    NaN natively; the LogReg leg mean-imputes). Anthropometrics, age,
    stance and the opponent's full profile are still real signal — enough
    to beat the coin these bouts previously got (no prediction at all)."""

    # Index round_stats by (bout_id, fighter_id) for O(1) lookup.
    rs = raw.round_stats.set_index(["bout_id", "fighter_id"])
    fighters = raw.fighters.set_index("fighter_id")
    odds = raw.odds.set_index("bout_id")
    # Non-UFC career fights per fighter (pre-UFC features, v0.9.0).
    preufc_by_fighter = group_sherdog_fights(raw.sherdog)
    # Graded outcome LABEL per bout (src/dominance.py), keyed by bout_id in
    # the raw scrape orientation — same orientation the row is built in, so
    # symmetrize_for_training flips it alongside target_a_wins.
    dominance_by_bout = _dominance_map(raw)

    # Build a per-(fighter, date) ordered list of (vertex_score,
    # vertex_score_all_time) so we can look up the most-recent snapshot
    # at-or-before a given date.
    sh = raw.score_history.sort_values(["fighter_id", "as_of_date"])
    sh_by_fighter: dict[str, pd.DataFrame] = {
        fid: g.reset_index(drop=True) for fid, g in sh.groupby("fighter_id")
    }

    def latest_vertex(fid: str, ev_date: date) -> tuple[int | None, int | None]:
        df = sh_by_fighter.get(fid)
        if df is None or df.empty:
            return None, None
        # binary search by as_of_date < ev_date (strict — same-day snapshot
        # would have been written AFTER the bout completed, so we exclude it).
        idx = df["as_of_date"].searchsorted(ev_date, side="left") - 1
        if idx < 0:
            return None, None
        row = df.iloc[idx]
        vs = row["vertex_score"]
        vsat = row["vertex_score_all_time"]
        return (
            None if pd.isna(vs) else int(vs),
            None if pd.isna(vsat) else int(vsat),
        )

    history: dict[str, FighterHistory] = {}
    rows: list[dict[str, Any]] = []

    bouts_sorted = raw.bouts.copy()
    bouts_sorted["event_date"] = pd.to_datetime(bouts_sorted["event_date"]).dt.date

    # Point-in-time Elo + opponent-adjusted ratings (v0.7.0), precomputed in
    # their own chronological replay of the SAME bout order — every lookup
    # below returns values as of strictly before that bout.
    ratings = compute_rating_snapshots(bouts_sorted, raw.round_stats)

    for bout in bouts_sorted.itertuples(index=False):
        bout_id = bout.bout_id
        fa = bout.fighter_a_id
        fb = bout.fighter_b_id
        ev_date = bout.event_date

        ha = history.setdefault(fa, FighterHistory())
        hb = history.setdefault(fb, FighterHistory())

        # Pull point-in-time vertex scores from fighter_score_history (Wave 31.7).
        ha_vs, ha_vsat = latest_vertex(fa, ev_date)
        hb_vs, hb_vsat = latest_vertex(fb, ev_date)
        ha.last_vertex_score = ha_vs
        ha.last_vertex_score_all_time = ha_vsat
        hb.last_vertex_score = hb_vs
        hb.last_vertex_score_all_time = hb_vsat

        snap_a = ha.snapshot(ev_date)
        snap_b = hb.snapshot(ev_date)

        # Fighter static info (height/reach/age/stance).
        info_a = fighters.loc[fa] if fa in fighters.index else None
        info_b = fighters.loc[fb] if fb in fighters.index else None

        def age_years(dob: Any, ev: date) -> float | None:
            if dob is None or pd.isna(dob):
                return None
            d = dob if isinstance(dob, date) else pd.to_datetime(dob).date()
            return (ev - d).days / 365.25

        height_a = (
            int(info_a["height_cm"])
            if info_a is not None and not pd.isna(info_a["height_cm"])
            else None
        )
        height_b = (
            int(info_b["height_cm"])
            if info_b is not None and not pd.isna(info_b["height_cm"])
            else None
        )
        reach_a = (
            int(info_a["reach_cm"])
            if info_a is not None and not pd.isna(info_a["reach_cm"])
            else None
        )
        reach_b = (
            int(info_b["reach_cm"])
            if info_b is not None and not pd.isna(info_b["reach_cm"])
            else None
        )
        age_a = age_years(info_a["dob"] if info_a is not None else None, ev_date)
        age_b = age_years(info_b["dob"] if info_b is not None else None, ev_date)
        stance_a = info_a["stance"] if info_a is not None else None
        stance_b = info_b["stance"] if info_b is not None else None
        # NaN, not False, when the fighter has no Sherdog flag — the
        # corrector maps NaN to a zero shift, so an unknown nationality
        # leaves the bout served exactly as it is today rather than
        # asserting "not American".
        is_american_a = (
            bool(info_a["is_american"])
            if info_a is not None and not pd.isna(info_a["is_american"])
            else None
        )
        is_american_b = (
            bool(info_b["is_american"])
            if info_b is not None and not pd.isna(info_b["is_american"])
            else None
        )
        # Bout gender (men's vs women's divisions differ in pace/finish rates).
        # Both fighters share it; take A's, fall back to B's.
        gender: str | None = None
        if info_a is not None and not pd.isna(info_a["gender"]):
            gender = str(info_a["gender"])
        elif info_b is not None and not pd.isna(info_b["gender"]):
            gender = str(info_b["gender"])

        # Latest (closing) line odds (decimal). Convert to implied prob via
        # 1/odds and de-vig naively (a/(a+b)) so the pair sums to 1. Stored as
        # `market_prob_a` — single canonical "market believes A wins" prob.
        #
        # "Closing" is VERIFIED, not assumed, because it has been doubted once
        # and the doubt was reasonable: `bout_external_odds` rows are written
        # by a backfill that runs long after the fight, and that backfill's own
        # docstring used to call what it scrapes an opening line. Neither
        # implies anything — an archive scraped late still returns the close.
        # Measured on 23 bouts spanning 2021-2026 against bestfightodds'
        # per-fighter open/close columns: mean distance from the stored value
        # to the closing-range midpoint 0.029, to the open 0.311, closer to the
        # close in 21 of the 23. Every "gap to the closing line" in
        # docs/winner_batch.md and on the public /model page rests on this.
        #
        # The de-vig is a separate matter and is NOT clean: splitting the
        # overround proportionally leaves ~+4.5pp of favourite-longshot bias on
        # genuine longshots (p<0.30). A power de-vig (q^k summing to 1) cuts
        # that to +2.5pp. Anything published as a model-vs-market number should
        # say which de-vig it used.
        # Kept on the row for the edge/value display (model_prob - market_prob)
        # and for the honest model-vs-market backtest; it is NOT a model input.
        market_prob_a: float | None = None
        if bout_id in odds.index:
            row = odds.loc[bout_id]
            wa = float(row["winner_a_decimal"])
            wb = float(row["winner_b_decimal"])
            if wa > 1.0 and wb > 1.0:
                pa = 1.0 / wa
                pb = 1.0 / wb
                market_prob_a = pa / (pa + pb)

        # Target: A wins = 1, B wins = 0. We already filter out NC; draws
        # have winner_id NULL so we exclude them from training rows but
        # still apply them to history so layoffs etc. stay accurate.
        is_completed = bout.status == "completed"
        # NULL winner_id comes back from pandas as NaN (float), NOT None —
        # `is None` never fired, so completed draws fell through to the
        # decisive-result branch: emitted as "B wins" training rows (NaN == fa
        # is False → target 0) and applied to history as losses for BOTH
        # fighters. Latent since the original draw fix; it only started biting
        # when the 2026-07 data repair gave real draws their NULL winners back.
        is_draw = is_completed and pd.isna(bout.winner_id)
        is_nc = (bout.method or "") == "no_contest"

        target: int | None = None
        if is_completed and not is_draw and not is_nc:
            target = 1 if bout.winner_id == fa else 0

        # Emit row only if both fighters have at least 1 prior bout (so
        # features are non-empty) AND (the bout has a clean winner OR
        # we're in inference mode and this is a scheduled bout).
        is_scheduled = bout.status != "completed"
        both_experienced = snap_a["prior_bouts"] > 0 and snap_b["prior_bouts"] > 0
        should_emit = (
            (both_experienced or include_debuts)
            and (target is not None or (include_scheduled and is_scheduled))
        )
        # Pre-bout Elo + opponent-adjusted ratings for both sides.
        pre_a = ratings.pre[(bout_id, fa)]
        pre_b = ratings.pre[(bout_id, fb)]

        # Pre-UFC (non-UFC-before-this-date) career snapshots. Static data
        # scraped today is point-in-time safe: every counted fight happened
        # strictly before ev_date, and fight histories don't change
        # retroactively.
        matched_a = bool(
            info_a is not None and bool(info_a["sherdog_matched"])
        )
        matched_b = bool(
            info_b is not None and bool(info_b["sherdog_matched"])
        )
        preufc_a = preufc_snapshot(
            preufc_by_fighter.get(fa, []), ev_date, matched=matched_a
        )
        preufc_b = preufc_snapshot(
            preufc_by_fighter.get(fb, []), ev_date, matched=matched_b
        )

        if should_emit:
            row = {
                "bout_id": bout_id,
                "event_id": bout.event_id,
                "event_date": ev_date,
                "weight_class": bout.weight_class,
                "is_title_fight": bool(bout.is_title_fight),
                "is_main_event": bool(bout.is_main_event),
                "scheduled_rounds": int(bout.scheduled_rounds),
                "fighter_a_id": fa,
                "fighter_b_id": fb,
                "height_a": height_a,
                "height_b": height_b,
                "reach_a": reach_a,
                "reach_b": reach_b,
                "age_a": age_a,
                "age_b": age_b,
                "stance_a": stance_a,
                "stance_b": stance_b,
                # v0.15.0 — corrector input, NOT a learner feature. It is an
                # _a/_b pair so `swap_sides` negates the diff built from it,
                # which is what keeps the correction antisymmetric and
                # therefore able to survive the order averaging.
                "is_american_a": is_american_a,
                "is_american_b": is_american_b,
                "gender": gender,
                "is_debut_a": snap_a["prior_bouts"] == 0,
                "is_debut_b": snap_b["prior_bouts"] == 0,
                "market_prob_a": market_prob_a,
                "target_a_wins": target,
                # Graded twin of target_a_wins — how convincingly A won, in
                # [0,1] with 0.5 = draw (src/dominance.py). Alongside, never
                # instead: target_a_wins remains the evaluation label.
                "dominance_a": dominance_by_bout.get(bout_id),
                # HOW the bout ended, in the three buckets the method market
                # settles on (src/lib/sportsbook.ts methodBucket). Unlike
                # `dominance_a` this is orientation-INVARIANT — a KO is a KO
                # whichever slot the winner sits in — so `swap_sides` and
                # `symmetrize_for_training` must leave it alone, and the
                # absence of an `_a` suffix is what guarantees they do.
                # None for dq / draw / no-contest / not-yet-fought.
                "method_bucket": method_bucket(bout.method) if is_completed else None,
            }
            # elo + attack/defense + opponent-quality columns per side.
            for key in RATING_ALL_KEYS:
                row[f"{key}_a"] = pre_a[key]
                row[f"{key}_b"] = pre_b[key]
            for k, v in snap_a.items():
                row[f"{k}_a"] = v
            for k, v in snap_b.items():
                row[f"{k}_b"] = v
            for k, v in preufc_a.items():
                row[f"{k}_a"] = v
            for k, v in preufc_b.items():
                row[f"{k}_b"] = v
            rows.append(row)

        # Now update history with this bout's outcome (regardless of
        # whether we emitted a training row).
        try:
            own_a = rs.loc[(bout_id, fa)].to_dict() if (bout_id, fa) in rs.index else None
        except KeyError:
            own_a = None
        try:
            own_b = rs.loc[(bout_id, fb)].to_dict() if (bout_id, fb) in rs.index else None
        except KeyError:
            own_b = None

        duration = _fight_duration_seconds(
            {
                "round_finished": bout.round_finished,
                "time_finished_seconds": bout.time_finished_seconds,
            },
            int(bout.scheduled_rounds),
        )

        if is_completed and not is_nc:
            # Draw (winner_id NULL) → "draw" for both; otherwise exactly one
            # side wins. NC is already excluded by the guard above.
            if is_draw:
                result_a = result_b = "draw"
            else:
                result_a = "win" if bout.winner_id == fa else "loss"
                result_b = "win" if bout.winner_id == fb else "loss"
            ha.apply_bout(
                result=result_a,
                method=bout.method,
                is_title_fight=bool(bout.is_title_fight),
                event_dt=ev_date,
                own_stats=own_a,
                opp_stats=own_b,
                duration_seconds=duration,
            )
            hb.apply_bout(
                result=result_b,
                method=bout.method,
                is_title_fight=bool(bout.is_title_fight),
                event_dt=ev_date,
                own_stats=own_b,
                opp_stats=own_a,
                duration_seconds=duration,
            )

    df = pd.DataFrame(rows)
    console.log(
        f"built dataset: {len(df):,} rows (incl_scheduled={include_scheduled}) · "
        f"{df['event_date'].min()} → {df['event_date'].max()}"
    )
    return df


def _ab_column_pairs(df: pd.DataFrame) -> list[tuple[str, str]]:
    """Every (``*_a``, ``*_b``) column pair in the row schema, plus the
    ``fighter_a_id`` ↔ ``fighter_b_id`` id pair. Shared by the training-time
    symmetrization and the inference-time order averaging so they swap exactly
    the same set of columns."""
    pairs: list[tuple[str, str]] = []
    for col in df.columns:
        if col.endswith("_a") and col not in ("fighter_a_id",):
            base = col[:-2]
            partner = f"{base}_b"
            if partner in df.columns:
                pairs.append((col, partner))
    # Add fighter_a_id ↔ fighter_b_id explicitly so we don't accidentally
    # double-swap if a base name happens to match "fighter".
    pairs.append(("fighter_a_id", "fighter_b_id"))
    return pairs


def swap_sides(df: pd.DataFrame) -> pd.DataFrame:
    """Return a copy of df with EVERY row's A-side fields swapped with their
    B-side counterparts (and ``market_prob_a`` → 1 − ``market_prob_a``).

    Used at inference to average a prediction over both fighter orderings. The
    model is only antisymmetric in its diff features — abs_*_a/_b, stance_a/_b
    one-hots break true antisymmetry, so P(A>B) computed from the raw scrape
    order ≠ 1 − P(B>A). Averaging the two orders removes the dependence on the
    arbitrary fighter slot order coming out of the scrape."""
    df = df.copy()
    for a_col, b_col in _ab_column_pairs(df):
        a_vals = df[a_col].copy()
        df[a_col] = df[b_col]
        df[b_col] = a_vals
    if "market_prob_a" in df.columns:
        notna = df["market_prob_a"].notna()
        df.loc[notna, "market_prob_a"] = 1.0 - df.loc[notna, "market_prob_a"]
    # dominance_a has no `dominance_b` partner, so _ab_column_pairs does not
    # see it — it has to be mirrored by hand, exactly like market_prob_a.
    if "dominance_a" in df.columns:
        notna = df["dominance_a"].notna()
        df.loc[notna, "dominance_a"] = 1.0 - df.loc[notna, "dominance_a"]
    return df


def symmetrize_for_training(df: pd.DataFrame) -> pd.DataFrame:
    """Fix the scrape convention where `fighter_a_id == winner_id` in 98.8%
    of completed bouts. Without this the model trivially learns "always
    pick A" and posts 98% accuracy with AUC 0.5. We deterministically
    flip A↔B per bout (hashed by bout_id with the process-stable
    `stable_hash`, NOT the salted builtin `hash`) so target_a_wins is ~50/50
    and the model has to learn from features rather than slot order. Using a
    stable hash keeps the flipped set — and therefore the trained model —
    identical across runs.

    Only applies to rows with a known target; inference-only rows (NaN
    target) are returned unchanged."""
    df = df.copy()

    # Deterministic 50/50 mask keyed on bout_id, restricted to rows that
    # have a real target.
    has_target = df["target_a_wins"].notna()
    mask = df["bout_id"].apply(lambda b: stable_hash(b) % 2 == 1) & has_target

    # Collect every (a_col, b_col) pair from the row schema (shared with the
    # inference-time swap_sides so both swap an identical column set).
    pairs = _ab_column_pairs(df)

    for a_col, b_col in pairs:
        a_vals = df.loc[mask, a_col].copy()
        b_vals = df.loc[mask, b_col].copy()
        df.loc[mask, a_col] = b_vals
        df.loc[mask, b_col] = a_vals

    # market_prob_a flips to 1 - market_prob_a (NaN preserved).
    swap_idx = mask & df["market_prob_a"].notna()
    df.loc[swap_idx, "market_prob_a"] = 1.0 - df.loc[swap_idx, "market_prob_a"]

    # Target flips (only on rows where mask is True, all of which have a
    # real target by construction above).
    df.loc[mask, "target_a_wins"] = 1 - df.loc[mask, "target_a_wins"]
    # Keep nullable Int dtype so inference rows can carry NaN through.
    df["target_a_wins"] = pd.array(df["target_a_wins"].values, dtype="Int8")

    # The graded label MUST flip on exactly the same mask. `dominance_a` is
    # not an `_a`/`_b` pair so the loop above does not touch it, and getting
    # this wrong is the one mistake that would not announce itself: the raw
    # scrape puts the winner in slot A ~95% of the time, so a label left
    # unflipped would lock onto the winner slot and produce a brilliant
    # backtest with nothing behind it on serving.
    if "dominance_a" in df.columns:
        flip = mask & df["dominance_a"].notna()
        df.loc[flip, "dominance_a"] = 1.0 - df.loc[flip, "dominance_a"]
        dom = pd.to_numeric(df["dominance_a"], errors="coerce")
        tgt = pd.to_numeric(df["target_a_wins"], errors="coerce")
        both = dom.notna() & tgt.notna()
        if both.any():
            assert abs(float(dom[both].mean()) - 0.5) < 0.05, (
                f"mean dominance_a {dom[both].mean():.4f} — the graded label did not "
                "symmetrize with the binary one"
            )
            assert float(dom[both].corr(tgt[both])) > 0.5, (
                "dominance_a and target_a_wins disagree on direction after "
                "symmetrization"
            )
    return df

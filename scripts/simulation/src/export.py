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

from dataclasses import dataclass
from datetime import date
from typing import Any

import pandas as pd
from rich.console import Console

from .db import get_connection

console = Console()


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
  SUM(brs.total_str_landed)::int AS total_str_landed,
  SUM(brs.total_str_attempted)::int AS total_str_attempted,
  SUM(brs.takedowns_landed)::int AS td_landed,
  SUM(brs.takedowns_attempted)::int AS td_attempted,
  SUM(brs.sub_attempts)::int AS sub_attempts,
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
  f.gender
FROM fighter f
"""

# Opening sportsbook line per bout (one row per bout, source preferred =
# 'bestfightodds'). Decimal odds; we'll convert to implied prob in feature
# engineering. NULL for bouts where no scrape happened (mostly historical
# pre-2020 events) — those rows fall back to "no odds feature" handling.
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


def fetch_raw() -> RawData:
    """One trip to Postgres for everything we need."""
    console.log("connecting to Postgres…")
    with get_connection() as conn:
        bouts = _fetch_df(conn, BOUTS_SQL)
        round_stats = _fetch_df(conn, ROUND_STATS_SQL)
        fighters = _fetch_df(conn, FIGHTERS_SQL)
        odds = _fetch_df(conn, EXTERNAL_ODDS_SQL)
        score_history = _fetch_df(conn, SCORE_HISTORY_SQL)
    console.log(
        f"fetched {len(bouts):,} bouts · {len(round_stats):,} round-stat rows · "
        f"{len(fighters):,} fighters · {len(odds):,} odds rows · "
        f"{len(score_history):,} score-history rows"
    )
    return RawData(bouts, round_stats, fighters, odds, score_history)


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
        "td_landed",
        "td_attempted",
        "td_def_attempted",  # opp attempts against us
        "td_def_stopped",  # opp attempts we stopped
        "sub_attempts",
        "knockdowns",
        "knockdowns_absorbed",
        "control_seconds",
        "control_seconds_absorbed",
        "total_seconds",
        "title_bouts",
        "last_bout_date",
        "recent_results",  # list of "W"/"L" for last N bouts
        "last_vertex_score",
        "last_vertex_score_all_time",
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
        self.td_landed = 0
        self.td_attempted = 0
        self.td_def_attempted = 0
        self.td_def_stopped = 0
        self.sub_attempts = 0
        self.knockdowns = 0
        self.knockdowns_absorbed = 0
        self.control_seconds = 0
        self.control_seconds_absorbed = 0
        self.total_seconds = 0
        self.title_bouts = 0
        self.last_bout_date: date | None = None
        self.recent_results: list[str] = []
        self.last_vertex_score: int | None = None
        self.last_vertex_score_all_time: int | None = None

    def snapshot(self, event_dt: date) -> dict[str, Any]:
        """Features as of just before `event_dt`."""
        win_rate = self.wins / self.bouts if self.bouts else None
        finish_rate = (
            (self.wins_ko + self.wins_sub) / self.wins if self.wins else None
        )
        # Per-minute / per-15-min rates only meaningful with some fight time.
        per_min = (self.total_seconds / 60.0) if self.total_seconds else None
        per_15m = (self.total_seconds / 900.0) if self.total_seconds else None
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
        }

    def apply_bout(
        self,
        *,
        is_winner: bool,
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
        if is_winner:
            self.wins += 1
            if method in ("ko", "tko"):
                self.wins_ko += 1
            elif method == "submission":
                self.wins_sub += 1
            elif method.startswith("decision"):
                self.wins_dec += 1
            self.recent_results.append("W")
        else:
            self.losses += 1
            if method in ("ko", "tko"):
                self.losses_ko += 1
            elif method == "submission":
                self.losses_sub += 1
            elif method.startswith("decision"):
                self.losses_dec += 1
            self.recent_results.append("L")
        # Keep recent_results bounded so it doesn't grow forever; only the
        # tail matters for recent-form features.
        if len(self.recent_results) > 10:
            self.recent_results = self.recent_results[-10:]
        self.last_bout_date = event_dt
        self.total_seconds += duration_seconds
        if own_stats:
            self.sig_str_landed += own_stats.get("sig_str_landed", 0) or 0
            self.sig_str_attempted += own_stats.get("sig_str_attempted", 0) or 0
            self.td_landed += own_stats.get("td_landed", 0) or 0
            self.td_attempted += own_stats.get("td_attempted", 0) or 0
            self.sub_attempts += own_stats.get("sub_attempts", 0) or 0
            self.knockdowns += own_stats.get("knockdowns", 0) or 0
            self.control_seconds += own_stats.get("control_seconds", 0) or 0
        if opp_stats:
            self.sig_str_absorbed += opp_stats.get("sig_str_landed", 0) or 0
            self.knockdowns_absorbed += opp_stats.get("knockdowns", 0) or 0
            self.control_seconds_absorbed += opp_stats.get("control_seconds", 0) or 0
            self.td_def_attempted += opp_stats.get("td_attempted", 0) or 0
            self.td_def_stopped += (
                (opp_stats.get("td_attempted", 0) or 0)
                - (opp_stats.get("td_landed", 0) or 0)
            )


# --------------------------------------------------------------------------
# Dataset assembly
# --------------------------------------------------------------------------


def build_dataset(
    raw: RawData, *, include_scheduled: bool = False
) -> pd.DataFrame:
    """Walk bouts in chronological order, snapshot features per fighter
    BEFORE applying each bout's result, then update history. Returns
    one row per (bout) with side-A + side-B features and target.

    When `include_scheduled=True`, rows for upcoming (status != 'completed')
    bouts are emitted with `target_a_wins` set to NaN — used at inference
    time to score future bouts. Their results aren't applied to history
    since they haven't happened yet."""

    # Index round_stats by (bout_id, fighter_id) for O(1) lookup.
    rs = raw.round_stats.set_index(["bout_id", "fighter_id"])
    fighters = raw.fighters.set_index("fighter_id")
    odds = raw.odds.set_index("bout_id")

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

        # Opening odds (decimal). Convert to implied prob via 1/odds and
        # de-vig naively (a/(a+b)) so the pair sums to 1. Stored as
        # `market_prob_a` — single canonical "market believes A wins" prob.
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
        is_draw = is_completed and bout.winner_id is None
        is_nc = (bout.method or "") == "no_contest"

        target: int | None = None
        if is_completed and not is_draw and not is_nc:
            target = 1 if bout.winner_id == fa else 0

        # Emit row only if both fighters have at least 1 prior bout (so
        # features are non-empty) AND (the bout has a clean winner OR
        # we're in inference mode and this is a scheduled bout).
        is_scheduled = bout.status != "completed"
        should_emit = (
            snap_a["prior_bouts"] > 0
            and snap_b["prior_bouts"] > 0
            and (target is not None or (include_scheduled and is_scheduled))
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
                "market_prob_a": market_prob_a,
                "target_a_wins": target,
            }
            for k, v in snap_a.items():
                row[f"{k}_a"] = v
            for k, v in snap_b.items():
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
            a_winner = bout.winner_id == fa
            b_winner = bout.winner_id == fb
            ha.apply_bout(
                is_winner=a_winner,
                method=bout.method,
                is_title_fight=bool(bout.is_title_fight),
                event_dt=ev_date,
                own_stats=own_a,
                opp_stats=own_b,
                duration_seconds=duration,
            )
            hb.apply_bout(
                is_winner=b_winner,
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


def symmetrize_for_training(df: pd.DataFrame) -> pd.DataFrame:
    """Fix the scrape convention where `fighter_a_id == winner_id` in 98.8%
    of completed bouts. Without this the model trivially learns "always
    pick A" and posts 98% accuracy with AUC 0.5. We deterministically
    flip A↔B per bout (hashed by bout_id) so target_a_wins is ~50/50 and
    the model has to learn from features rather than slot order.

    Only applies to rows with a known target; inference-only rows (NaN
    target) are returned unchanged."""
    df = df.copy()

    # Deterministic 50/50 mask keyed on bout_id, restricted to rows that
    # have a real target.
    has_target = df["target_a_wins"].notna()
    mask = df["bout_id"].apply(lambda b: (hash(b) & 0xFFFFFFFF) % 2 == 1) & has_target

    # Collect every (a_col, b_col) pair from the row schema.
    pairs: list[tuple[str, str]] = []
    for col in df.columns:
        if col.endswith("_a") and col not in ("fighter_a_id",):
            base = col[:-2]
            partner = f"{base}_b"
            if partner in df.columns:
                pairs.append((col, partner))
    # Add fighter_a_id ↔ fighter_b_id explicitly so we don't accidentally
    # double-swap if base name matches "fighter".
    pairs.append(("fighter_a_id", "fighter_b_id"))

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
    return df

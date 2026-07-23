"""Point-in-time export of non-UFC bouts as training rows (lab/regional-regime).

The regional-regime lever adds non-UFC career fights — where both sides are
fighters we know — as LABELLED training rows, not just as `preufc_*` features.
`fighter_sherdog_bout` (is_ufc=false) carries only result / method_class /
round / time / date / opponent, with NO round-by-round stats, so the only
features computable for a non-UFC bout are RECORD-shaped (career record +
physicals). This module builds those rows under the same point-in-time
discipline as `export.build_dataset`: a single chronological replay over BOTH
populations, so a fighter's UFC record on a non-UFC bout's date reflects exactly
the UFC bouts before it (usually none — these are pre-debut regional fights,
where the signal is in `preufc_*` and physicals), and the non-UFC (`preufc_*`)
record is snapshotted strictly before the date too.

Distinct from v0.9.0: `preufc_*` already feeds non-UFC career as FEATURES ("this
fighter is 15-0 in the regions"); this feeds non-UFC bouts as ROWS ("when a 15-0
regional met a 5-8 journeyman, here is what happened") — the training regime,
not the feature set. Used only as an auxiliary record-only signal; it is NOT
mixed into the served feature matrix (90% of whose columns would be NaN for a
non-UFC bout). See docs/regional_regime.md.
"""

from __future__ import annotations

from datetime import date

import pandas as pd

from .config import DATA_DIR, TRAIN_END
from .db import get_connection
from .export import (
    FighterHistory,
    _fight_duration_seconds,
    build_dataset,
    fetch_raw,
    group_sherdog_fights,
    preufc_snapshot,
    symmetrize_for_training,
)
from .opponent_ratings import ALL_KEYS as RATING_ALL_KEYS

# Non-UFC decisive bouts where BOTH sides are fighters we know, taken in the
# WINNER orientation (fighter_id = winner, opponent resolved to a fighter UUID),
# restricted to the training window (strictly before TRAIN_END). One row per
# decisive bout — the mirror loss-row is dropped; the winner orientation is the
# non-UFC analogue of the UFC scrape convention (winner in slot A), and
# symmetrize_for_training flips ~50% of them by stable_hash(bout_id). Draws and
# no-contests are excluded exactly as they are for UFC training rows.
NONUFC_TRAIN_SQL = """
SELECT
  b.id::text            AS nonufc_id,
  b.fighter_id::text    AS winner_id,
  f2.id::text           AS loser_id,
  b.event_date::date    AS event_date,
  b.method_class        AS method_class,
  b.round               AS round,
  b.time_seconds        AS time_seconds
FROM fighter_sherdog_bout b
JOIN fighter f2 ON f2.sherdog_id = b.opponent_sherdog_id
WHERE NOT b.is_ufc
  AND b.event_date IS NOT NULL
  AND b.result = 'win'
  AND b.event_date < %s::date
"""

UFC_FRAME_CACHE = DATA_DIR / "regional_ufc.parquet"
NONUFC_FRAME_CACHE = DATA_DIR / "regional_nonufc.parquet"


def ufc_universe(ufc_full: pd.DataFrame) -> pd.DataFrame:
    """The main-model universe: both-experienced completed UFC bouts, exactly as
    eval_tail_buckets.load_symmetrized selects them, so the union model's UFC
    rows match the served ensemble's."""
    df = ufc_full
    if "is_debut_a" in df.columns:
        debut = (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).astype(bool)
        df = df[~debut].reset_index(drop=True)
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)
    return df


def build_nonufc_training_rows(
    raw, nonufc_bouts: pd.DataFrame, ufc_columns: list[str]
) -> pd.DataFrame:
    """Point-in-time non-UFC training rows, one per decisive both-known bout in
    the train window.

    A SINGLE chronological replay over BOTH populations: UFC bouts advance each
    fighter's UFC FighterHistory (never non-UFC bouts — those carry no round
    stats and their outcomes ride on preufc_* instead), and at each non-UFC bout
    we snapshot the UFC history + the non-UFC (preufc) record strictly before its
    date. The UFC-history-advance logic is a faithful copy of build_dataset's, so
    prior_* on a non-UFC row means exactly what it means on a UFC row: the UFC
    record before that date.

    The row schema is reindexed onto the UFC frame's columns (non-record and
    round-stat sources filled NaN) so build_feature_matrix runs unchanged; only
    the record-only subset is ever read downstream. The result is symmetrized.
    """
    rs = raw.round_stats.set_index(["bout_id", "fighter_id"])
    fighters = raw.fighters.set_index("fighter_id")
    preufc_by_fighter = group_sherdog_fights(raw.sherdog)

    bouts_sorted = raw.bouts.copy()
    bouts_sorted["event_date"] = pd.to_datetime(bouts_sorted["event_date"]).dt.date

    def _to_date(d):
        return d if isinstance(d, date) else pd.to_datetime(d).date()

    def age_years(dob, ev: date):
        if dob is None or pd.isna(dob):
            return None
        d = dob if isinstance(dob, date) else pd.to_datetime(dob).date()
        return (ev - d).days / 365.25

    # Merged event stream: UFC bouts (rank 0, keep build_dataset row order via i)
    # then non-UFC snapshots (rank 1) on the same date.
    events: list[tuple] = []
    for i, bout in enumerate(bouts_sorted.itertuples(index=False)):
        events.append((bout.event_date, 0, i, "ufc", bout))
    for j, nb in enumerate(nonufc_bouts.itertuples(index=False)):
        events.append((_to_date(nb.event_date), 1, j, "nonufc", nb))
    events.sort(key=lambda e: (e[0], e[1], e[2]))

    history: dict[str, FighterHistory] = {}
    rows: list[dict] = []

    def snapshot_side(fid: str, ev_date: date, suffix: str) -> dict:
        h = history.get(fid) or FighterHistory()
        snap = h.snapshot(ev_date)
        info = fighters.loc[fid] if fid in fighters.index else None
        matched = bool(info is not None and bool(info["sherdog_matched"]))
        pre = preufc_snapshot(preufc_by_fighter.get(fid, []), ev_date, matched=matched)
        out: dict = {}
        for k, v in snap.items():
            out[f"{k}_{suffix}"] = v
        for k, v in pre.items():
            out[f"{k}_{suffix}"] = v
        # ratings do not exist for the non-UFC population — leave them unknown.
        for key in RATING_ALL_KEYS:
            out[f"{key}_{suffix}"] = None
        h_cm = int(info["height_cm"]) if info is not None and not pd.isna(info["height_cm"]) else None
        r_cm = int(info["reach_cm"]) if info is not None and not pd.isna(info["reach_cm"]) else None
        out[f"height_{suffix}"] = h_cm
        out[f"reach_{suffix}"] = r_cm
        out[f"age_{suffix}"] = age_years(info["dob"] if info is not None else None, ev_date)
        out[f"stance_{suffix}"] = info["stance"] if info is not None else None
        out[f"is_debut_{suffix}"] = snap["prior_bouts"] == 0
        out[f"sherdog_matched_{suffix}"] = matched
        out["_gender_" + suffix] = (
            str(info["gender"]) if info is not None and not pd.isna(info["gender"]) else None
        )
        return out

    for ev_date, _rank, _idx, kind, obj in events:
        if kind == "nonufc":
            fa = obj.winner_id  # winner in slot A (pre-symmetrization)
            fb = obj.loser_id
            row: dict = {
                "bout_id": obj.nonufc_id,
                "event_id": None,
                "event_date": ev_date,
                "weight_class": None,
                "is_title_fight": False,
                "is_main_event": False,
                "scheduled_rounds": 3,
                "fighter_a_id": fa,
                "fighter_b_id": fb,
                "market_prob_a": None,
                "target_a_wins": 1,
                "dominance_a": None,
            }
            a = snapshot_side(fa, ev_date, "a")
            b = snapshot_side(fb, ev_date, "b")
            row.update(a)
            row.update(b)
            # gender is a single bout-level column (A's, then B's).
            row["gender"] = a.get("_gender_a") or b.get("_gender_b")
            rows.append(row)
            continue

        # UFC bout — advance history exactly as build_dataset does.
        bout = obj
        is_completed = bout.status == "completed"
        is_nc = (bout.method or "") == "no_contest"
        if not is_completed or is_nc:
            continue
        fa, fb = bout.fighter_a_id, bout.fighter_b_id
        ha = history.setdefault(fa, FighterHistory())
        hb = history.setdefault(fb, FighterHistory())
        is_draw = pd.isna(bout.winner_id)
        if is_draw:
            result_a = result_b = "draw"
        else:
            result_a = "win" if bout.winner_id == fa else "loss"
            result_b = "win" if bout.winner_id == fb else "loss"
        duration = _fight_duration_seconds(
            {"round_finished": bout.round_finished,
             "time_finished_seconds": bout.time_finished_seconds},
            int(bout.scheduled_rounds),
        )
        own_a = rs.loc[(bout.bout_id, fa)].to_dict() if (bout.bout_id, fa) in rs.index else None
        own_b = rs.loc[(bout.bout_id, fb)].to_dict() if (bout.bout_id, fb) in rs.index else None
        ha.apply_bout(result=result_a, method=bout.method, is_title_fight=bool(bout.is_title_fight),
                      event_dt=ev_date, own_stats=own_a, opp_stats=own_b, duration_seconds=duration)
        hb.apply_bout(result=result_b, method=bout.method, is_title_fight=bool(bout.is_title_fight),
                      event_dt=ev_date, own_stats=own_b, opp_stats=own_a, duration_seconds=duration)

    out = pd.DataFrame(rows)
    # Align to the UFC frame's columns (adds any missing as NaN, drops extras).
    out = out.reindex(columns=ufc_columns)
    out["target_a_wins"] = 1
    out["bout_id"] = [r["bout_id"] for r in rows]
    out["event_date"] = [r["event_date"] for r in rows]
    out["fighter_a_id"] = [r["fighter_a_id"] for r in rows]
    out["fighter_b_id"] = [r["fighter_b_id"] for r in rows]
    return symmetrize_for_training(out)


def build_union_frames(use_cache: bool) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(UFC universe frame, symmetrized non-UFC training frame), aligned columns.
    Cached to data/ (gitignored) so a weight/seed sweep does not re-replay."""
    if use_cache and UFC_FRAME_CACHE.exists() and NONUFC_FRAME_CACHE.exists():
        return pd.read_parquet(UFC_FRAME_CACHE), pd.read_parquet(NONUFC_FRAME_CACHE)
    raw = fetch_raw()
    ufc_full = symmetrize_for_training(build_dataset(raw, include_debuts=True))
    ufc = ufc_universe(ufc_full)
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(NONUFC_TRAIN_SQL, (TRAIN_END,))
        cols = [d[0] for d in cur.description]
        nonufc_bouts = pd.DataFrame(cur.fetchall(), columns=cols)
    print(f"non-UFC decisive both-known train-window bouts: {len(nonufc_bouts):,}")
    nonufc = build_nonufc_training_rows(raw, nonufc_bouts, list(ufc.columns))
    ufc.to_parquet(UFC_FRAME_CACHE, index=False)
    nonufc.to_parquet(NONUFC_FRAME_CACHE, index=False)
    return ufc, nonufc

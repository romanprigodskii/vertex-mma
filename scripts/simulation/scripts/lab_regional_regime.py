"""LAB — the sixth information lever: non-UFC bouts as training rows.

Five levers before this one (round scorer, redundancy, recalibration, blend
re-selection + age throttle, graded target) all closed between 0 and +0.002 of
the 0.0229 log-loss gap to the closing line. Every one of them reworked `X` or
the shape of `y`; none added INFORMATION. This lever is the only one left that
changes the INFORMATION SET — it adds bouts the model never saw: 19,386 non-UFC
career fights where both sides are fighters we know (9,426 unique decisive
bouts, 72% finish rate vs 53% in the UFC). UFC matchmaking builds competitive
fights by design, so the blowout regime is structurally under-represented
exactly where the model is weak (the market-0.72+ bucket, the whole of the gap).

LOW PRIOR, stated up front. The debut specialist (train.py) already does
record-shaped modelling off the Sherdog record and lands at 55.8-60.1% on the
debut segment — barely above a coin. That is direct evidence the regional-record
signal is thin. A close at zero here is the sixth independent confirmation of the
ceiling, and that is a valid — probably the most likely — result.

HARD CONSTRAINT (see docs/regional_regime.md §1). `fighter_sherdog_bout` carries
only result / method_class / round / time / date / opponent — NO round-by-round
stats. So opponent-adjusted ratings, Elo/Glicko, striking volume, control — the
features the served ensemble leans on — DO NOT EXIST for a non-UFC bout. Only
RECORD-SHAPED features exist for both populations. This lever is therefore NOT an
extension of the served ensemble; it is a RECORD-ONLY model on a union sample,
used as an auxiliary signal. `preufc_*` already feeds non-UFC career as FEATURES
(v0.9.0); this lever is different — it adds non-UFC bouts as LABELLED ROWS.

Stage 0 is a two-part kill-test that can close the lever before any union model
is built:
  0a — does record-space separate the UFC tail AT ALL? Train a record-only model
       on UFC-only and bucket it. If it is catastrophically worse than the full
       ensemble in the 0.72+ bucket AND cannot tell a 0.72+ bout from a 0.62 one,
       record-space carries no blowout signal and adding non-UFC record rows
       cannot create it.
  0b — do non-UFC training rows move the UFC tail? Train the same record-only
       model on UFC-only vs UFC+non-UFC (non-UFC down-weighted), evaluate the
       held-out UFC tail. If the non-UFC region does not move it, the lever is
       dead on substance.

Usage (scripts/simulation, venv active):
  python scripts/lab_regional_regime.py --stage 0a [--cache] [--seeds 42,7,13]
  python scripts/lab_regional_regime.py --stage 0b [--cache] [--seeds 42,7,13] \
      [--weights 0.1,0.2,0.4]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from eval_tail_buckets import (  # noqa: E402
    EPS,
    bucket_table,
    headline,
    load_symmetrized,
    murphy,
    print_bucket_table,
    resolve_ensemble_dir,
)
from sklearn.metrics import log_loss  # noqa: E402

from src.config import (  # noqa: E402
    ARTIFACTS_DIR,
    DATA_DIR,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
    TRAIN_END,
    VAL_END,
)
from src.db import get_connection  # noqa: E402
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import (  # noqa: E402
    FighterHistory,
    _fight_duration_seconds,
    build_dataset,
    fetch_raw,
    group_sherdog_fights,
    preufc_snapshot,
    swap_sides,
    symmetrize_for_training,
)
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.opponent_ratings import ALL_KEYS as RATING_ALL_KEYS  # noqa: E402
from src.train import _load_tuned_params  # noqa: E402

OUT_PATH = ARTIFACTS_DIR / "lab_regional_regime.json"

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

_UFC_FRAME_CACHE = DATA_DIR / "regional_ufc.parquet"
_NONUFC_FRAME_CACHE = DATA_DIR / "regional_nonufc.parquet"


# ── the record-only feature space ───────────────────────────────────────
#
# The subset of the served feature list that is computable from a fighter's
# RECORD (result / method / round / time / date) plus static attributes
# (height / reach / age / stance / gender) — i.e. the features that exist for a
# non-UFC bout too. Everything sourced from bout_round_stats (striking volume,
# control, takedowns), the opponent-adjusted ratings, Elo/Glicko, vertex_score,
# and the UFC-only context (title / main-event / scheduled_rounds / weight
# class) is EXCLUDED, because it does not exist for the non-UFC population and
# so cannot transfer. Split-record semantics are kept exactly as the served
# model uses them: prior_* is the UFC record, preufc_* the non-UFC record; for a
# non-UFC row prior_* is the (usually empty) UFC record before that date and
# preufc_* the non-UFC record before it — the same two axes, populated the same
# point-in-time way, for both populations.

_RECORD_DIFF = [
    "height", "reach", "age",
    "prior_bouts", "prior_wins", "prior_losses", "prior_win_rate",
    "prior_finish_rate", "prior_wins_ko", "prior_wins_sub", "prior_wins_dec",
    "prior_losses_ko", "prior_losses_sub", "prior_losses_dec",
    "layoff_days", "recent3_wins", "recent5_wins", "current_streak",
    "finish_against_per_bout", "avg_bout_seconds",
    "preufc_bouts", "preufc_wins", "preufc_losses", "preufc_win_rate",
    "preufc_ko_rate", "preufc_sub_rate", "preufc_finish_rate",
    "preufc_finish_losses", "preufc_career_days", "preufc_days_since_last",
    "preufc_fights_last_24mo", "preufc_last3_wins", "preufc_dwcs_fights",
    "preufc_avg_win_seconds",
]
_RECORD_ABS = [
    "age", "layoff_days", "prior_bouts", "current_streak",
    "preufc_bouts", "preufc_win_rate", "preufc_days_since_last",
]
_RECORD_FLAGS_INTERACTIONS = [
    "is_womens", "sherdog_matched_a", "sherdog_matched_b",
    "stance_a_orthodox", "stance_a_southpaw", "stance_a_switch",
    "stance_b_orthodox", "stance_b_southpaw", "stance_b_switch",
    "stance_asymmetry", "reach_height_ratio_diff", "age_curve_diff",
]


def record_only_columns() -> list[str]:
    """The record-only feature columns, asserted to be a strict subset of the
    served feature_names() so nothing silently drifts out of the served space."""
    cols = (
        [f"diff_{c}" for c in _RECORD_DIFF]
        + [f"abs_{c}_a" for c in _RECORD_ABS]
        + [f"abs_{c}_b" for c in _RECORD_ABS]
        + list(_RECORD_FLAGS_INTERACTIONS)
    )
    served = set(feature_names())
    missing = [c for c in cols if c not in served]
    assert not missing, f"record-only cols not in served feature space: {missing}"
    return cols


# ── model fitting (record-only ensemble, seed-swept) ─────────────────────


def fit_record_only(
    X_tr: pd.DataFrame,
    y_tr: pd.Series,
    X_va: pd.DataFrame,
    y_va: pd.Series,
    cols: list[str],
    seed: int = 42,
    sample_weight: np.ndarray | None = None,
) -> EnsembleModel:
    """Fit the three-learner ensemble on the record-only columns. Mirrors
    lab_blend_age.fit_config: the seed reaches CatBoost too (its random_seed is
    hardcoded in EnsembleModel._cb_params), else two thirds of the blend would
    be frozen and any seed-stability claim would be vacuous."""
    tuned = _load_tuned_params()
    lgb_params = {**LGB_PARAMS, **tuned, "seed": seed}
    # feature_contri is keyed to the served layout; the age throttle still
    # applies to whichever of its keys survive into the record-only list.
    model = EnsembleModel(
        feature_columns=cols,
        lgb_params=lgb_params,
        lgb_num_rounds=LGB_NUM_ROUNDS,
        lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
    )
    if seed != 42:
        model._cb_params = staticmethod(  # type: ignore[method-assign]
            lambda: {**EnsembleModel._cb_params(), "random_seed": seed}
        ).__func__
    model.fit(
        X_train=X_tr.reset_index(drop=True),
        y_train=y_tr.reset_index(drop=True),
        X_val=X_va.reset_index(drop=True),
        y_val=y_va.reset_index(drop=True),
        sample_weight=sample_weight,
    )
    return model


def order_averaged_probs(
    model: EnsembleModel, X: pd.DataFrame, X_sw: pd.DataFrame
) -> np.ndarray:
    """P(A) as production serves it: ½·[f(A,B) + (1 − f(B,A))]."""
    p = model.predict_proba_a(X.reset_index(drop=True))
    p_sw = model.predict_proba_a(X_sw.reset_index(drop=True))
    return 0.5 * (p + (1.0 - p_sw))


def confidence_by_bucket(
    probs: np.ndarray, market: np.ndarray, y: np.ndarray
) -> list[dict]:
    """Per market-confidence bucket, the record-only model's OWN mean confidence
    max(p,1-p) and accuracy — the direct read on whether record-space tells a
    heavy favourite apart from a coin-flip, independent of log-loss."""
    from eval_tail_buckets import MARKET_BUCKETS

    has = ~np.isnan(market)
    p = np.clip(np.asarray(probs, float)[has], EPS, 1 - EPS)
    m = np.clip(np.asarray(market, float)[has], EPS, 1 - EPS)
    yy = np.asarray(y)[has]
    conf = np.maximum(m, 1 - m)
    rows = []
    for lo, hi in MARKET_BUCKETS:
        sel = (conf >= lo) & (conf < hi)
        k = int(sel.sum())
        if k == 0:
            continue
        model_conf = float(np.maximum(p[sel], 1 - p[sel]).mean())
        rows.append({
            "lo": lo, "hi": hi, "n": k,
            "model_mean_conf": model_conf,
            "model_acc": float(((p[sel] >= 0.5) == (yy[sel] == 1)).mean()),
            "market_mean_conf": float(np.maximum(m[sel], 1 - m[sel]).mean()),
        })
    return rows


# ── Stage 0a ─────────────────────────────────────────────────────────────


def stage_0a(df: pd.DataFrame, seeds: list[int]) -> dict:
    """Record-only model on UFC-only, vs the full served ensemble, by bucket."""
    cols = record_only_columns()
    print(f"record-only feature space: {len(cols)} cols "
          f"(served space is {len(feature_names())})")

    X, y, meta = build_feature_matrix(df)
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    dt = pd.to_datetime(meta["event_date"])
    m_tr = (dt < TRAIN_END).to_numpy()
    m_va = ((dt >= TRAIN_END) & (dt < VAL_END)).to_numpy()
    m_te = (dt >= VAL_END).to_numpy()
    y_te = y[m_te].to_numpy().astype(int)
    y_va = y[m_va].to_numpy().astype(int)
    market_te = meta.loc[m_te, "market_prob_a"].to_numpy(dtype=float)

    Xr = X[cols]
    Xr_sw = X_sw[cols]

    # Full served ensemble (all features) on the same test rows, for reference.
    full = EnsembleModel.load(resolve_ensemble_dir())
    Xf = X[full.feature_columns]
    Xf_sw = X_sw[full.feature_columns]
    full_probs = order_averaged_probs(full, Xf[m_te], Xf_sw[m_te])
    full_buckets = bucket_table(full_probs, market_te, y_te)

    out: dict = {"n_record_cols": len(cols), "seeds": {}}
    for seed in seeds:
        model = fit_record_only(Xr[m_tr], y[m_tr], Xr[m_va], y[m_va], cols, seed)
        probs_te = order_averaged_probs(model, Xr[m_te], Xr_sw[m_te])
        probs_va = order_averaged_probs(model, Xr[m_va], Xr_sw[m_va])
        has_te = ~np.isnan(market_te)
        out["seeds"][str(seed)] = {
            "headline_all": headline(probs_te, y_te),
            "headline_odds": headline(probs_te[has_te], y_te[has_te]),
            "val_logloss": float(log_loss(y_va, np.clip(probs_va, EPS, 1 - EPS))),
            "buckets": bucket_table(probs_te, market_te, y_te),
            "confidence": confidence_by_bucket(probs_te, market_te, y_te),
            "murphy": murphy(probs_te[has_te], y_te[has_te]),
            "blend_mode": model.training_meta["blend_mode"],
        }
    out["full_buckets"] = full_buckets
    out["full_headline_odds"] = headline(
        full_probs[~np.isnan(market_te)], y_te[~np.isnan(market_te)]
    )
    return out


def print_stage_0a(res: dict, seeds: list[int]) -> None:
    print("\n=== STAGE 0a — record-only vs full ensemble on the UFC tail ===")
    full_tail = next(r for r in res["full_buckets"] if r["lo"] == 0.72)
    full_coin = next(r for r in res["full_buckets"] if r["lo"] == 0.50)
    print(f"\nfull ensemble  (reference): coin 0.50-0.55 ll {full_coin['model']:.4f}"
          f"  ·  tail 0.72+ ll {full_tail['model']:.4f}  ·  market tail {full_tail['market']:.4f}")

    for seed in seeds:
        s = res["seeds"][str(seed)]
        print(f"\n-- seed {seed} (blend={s['blend_mode']}) — record-only bucket table --")
        print_bucket_table(s["buckets"])
        print(f"  overall /odds  acc {s['headline_odds']['acc']:.4f}  "
              f"ll {s['headline_odds']['logloss']:.4f}  auc {s['headline_odds']['auc']:.4f}  "
              f"sd {s['headline_odds']['sd']:.4f}  ·  val ll {s['val_logloss']:.4f}")
        print("  record-only model's OWN confidence / accuracy by market bucket:")
        print(f"    {'market conf':>12}  {'n':>4}  {'model conf':>10}  "
              f"{'model acc':>9}  {'mkt conf':>8}")
        for c in s["confidence"]:
            hi = "1.00" if c["hi"] > 1.0 else f"{c['hi']:.2f}"
            print(f"    {c['lo']:.2f}-{hi:>4}  {c['n']:>4}  {c['model_mean_conf']:>10.4f}  "
                  f"{c['model_acc']:>9.4f}  {c['market_mean_conf']:>8.4f}")

    # GATE 0a read: tail gap to full, and tail-vs-coin separation.
    print("\n-- GATE 0a read --")
    for seed in seeds:
        s = res["seeds"][str(seed)]
        rec_tail = next(r for r in s["buckets"] if r["lo"] == 0.72)
        conf_tail = next(c for c in s["confidence"] if c["lo"] == 0.72)
        conf_mid = next((c for c in s["confidence"] if c["lo"] == 0.62), None)
        conf_coin = next(c for c in s["confidence"] if c["lo"] == 0.50)
        sep = conf_tail["model_mean_conf"] - conf_coin["model_mean_conf"]
        print(f"  seed {seed}: tail ll record {rec_tail['model']:.4f} vs full "
              f"{full_tail['model']:.4f} (Δ {rec_tail['model'] - full_tail['model']:+.4f}); "
              f"own conf coin→tail {conf_coin['model_mean_conf']:.3f}→"
              f"{conf_tail['model_mean_conf']:.3f} (sep {sep:+.3f})"
              + (f", mid {conf_mid['model_mean_conf']:.3f}" if conf_mid else ""))


# ── Stage 0b — point-in-time non-UFC training rows + union model ─────────


def _ufc_universe(ufc_full: pd.DataFrame) -> pd.DataFrame:
    """The main-model universe: both-experienced completed UFC bouts, exactly as
    eval_tail_buckets.load_symmetrized selects them, so 0b's UFC rows match 0a's."""
    df = ufc_full
    if "is_debut_a" in df.columns:
        debut = (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).astype(bool)
        df = df[~debut].reset_index(drop=True)
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)
    return df


def build_nonufc_training_rows(raw, nonufc_bouts: pd.DataFrame, ufc_columns: list[str]) -> pd.DataFrame:
    """Point-in-time non-UFC training rows, one per decisive both-known bout in
    the train window.

    A SINGLE chronological replay over BOTH populations: UFC bouts advance each
    fighter's UFC FighterHistory (never non-UFC bouts — those carry no round
    stats and their outcomes ride on preufc_* instead), and at each non-UFC bout
    we snapshot the UFC history + the non-UFC (preufc) record strictly before its
    date. The UFC-history-advance logic is a faithful copy of build_dataset's, so
    prior_* on a non-UFC row means exactly what it means on a UFC row: the UFC
    record before that date (usually empty — these are pre-debut regional fights,
    where the signal is all in preufc_* and physicals).

    The row schema is reindexed onto the UFC frame's columns (non-record and
    round-stat sources filled NaN) so build_feature_matrix runs unchanged; only
    the record-only subset is ever read downstream.
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
            row["gender"] = a.pop("_gender_a") or b.get("_gender_b")
            b.pop("_gender_b", None)
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
            {"round_finished": bout.round_finished, "time_finished_seconds": bout.time_finished_seconds},
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
    Cached to data/ (gitignored) so the weight/seed sweep does not re-replay."""
    if use_cache and _UFC_FRAME_CACHE.exists() and _NONUFC_FRAME_CACHE.exists():
        return pd.read_parquet(_UFC_FRAME_CACHE), pd.read_parquet(_NONUFC_FRAME_CACHE)
    raw = fetch_raw()
    ufc_full = symmetrize_for_training(build_dataset(raw, include_debuts=True))
    ufc = _ufc_universe(ufc_full)
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(NONUFC_TRAIN_SQL, (TRAIN_END,))
        cols = [d[0] for d in cur.description]
        nonufc_bouts = pd.DataFrame(cur.fetchall(), columns=cols)
    print(f"non-UFC decisive both-known train-window bouts: {len(nonufc_bouts):,}")
    nonufc = build_nonufc_training_rows(raw, nonufc_bouts, list(ufc.columns))
    ufc.to_parquet(_UFC_FRAME_CACHE, index=False)
    nonufc.to_parquet(_NONUFC_FRAME_CACHE, index=False)
    return ufc, nonufc


def stage_0b(seeds: list[int], weights: list[float], use_cache: bool) -> dict:
    """Record-only model trained on UFC-only vs UFC + non-UFC (down-weighted),
    evaluated on the held-out UFC tail. GATE 0b: do non-UFC rows move it?"""
    cols = record_only_columns()
    ufc, nonufc = build_union_frames(use_cache)
    print(f"UFC universe {len(ufc):,} rows · non-UFC training rows {len(nonufc):,} "
          f"(base A-win {nonufc['target_a_wins'].mean():.4f})")

    # UFC splits.
    Xu, yu, metau = build_feature_matrix(ufc)
    Xu_sw, _, _ = build_feature_matrix(swap_sides(ufc))
    dt = pd.to_datetime(metau["event_date"])
    m_tr = (dt < TRAIN_END).to_numpy()
    m_va = ((dt >= TRAIN_END) & (dt < VAL_END)).to_numpy()
    m_te = (dt >= VAL_END).to_numpy()
    Xu, Xu_sw = Xu[cols], Xu_sw[cols]
    y_te = yu[m_te].to_numpy().astype(int)
    y_va = yu[m_va].to_numpy().astype(int)
    market_te = metau.loc[m_te, "market_prob_a"].to_numpy(dtype=float)
    has_te = ~np.isnan(market_te)

    # Non-UFC training rows (all in the train window by construction).
    Xn, yn, _ = build_feature_matrix(nonufc)
    Xn = Xn[cols]
    assert pd.to_datetime(nonufc["event_date"]).max() < pd.to_datetime(TRAIN_END), (
        "non-UFC rows leaked past TRAIN_END"
    )

    X_ufc_tr, y_ufc_tr = Xu[m_tr], yu[m_tr]

    def eval_model(model) -> dict:
        p_te = order_averaged_probs(model, Xu[m_te], Xu_sw[m_te])
        p_va = order_averaged_probs(model, Xu[m_va], Xu_sw[m_va])
        return {
            "headline_odds": headline(p_te[has_te], y_te[has_te]),
            "val_logloss": float(log_loss(y_va, np.clip(p_va, EPS, 1 - EPS))),
            "buckets": bucket_table(p_te, market_te, y_te),
            "murphy": murphy(p_te[has_te], y_te[has_te]),
        }

    out: dict = {"n_ufc": int(len(ufc)), "n_nonufc": int(len(nonufc)),
                 "n_ufc_train": int(m_tr.sum()), "seeds": {}}
    for seed in seeds:
        seed_res: dict = {}
        # Baseline: UFC-only (weight-free), same recipe as 0a.
        base = fit_record_only(X_ufc_tr, y_ufc_tr, Xu[m_va], yu[m_va], cols, seed)
        seed_res["ufc_only"] = eval_model(base)
        # Union: append non-UFC rows to the train split at each down-weight.
        X_union = pd.concat([X_ufc_tr, Xn], ignore_index=True)
        y_union = pd.concat([y_ufc_tr, yn], ignore_index=True)
        for w in weights:
            sw = np.concatenate([np.ones(len(X_ufc_tr)), np.full(len(Xn), w)])
            model = fit_record_only(X_union, y_union, Xu[m_va], yu[m_va], cols, seed, sample_weight=sw)
            seed_res[f"union_w{w}"] = eval_model(model)
        out["seeds"][str(seed)] = seed_res
    return out


def print_stage_0b(res: dict, seeds: list[int], weights: list[float]) -> None:
    print("\n=== STAGE 0b — do non-UFC training rows move the held-out UFC tail ===")
    print(f"UFC {res['n_ufc']:,} rows (train {res['n_ufc_train']:,}) + "
          f"{res['n_nonufc']:,} non-UFC training rows\n")

    def tail(d):
        return next(r for r in d["buckets"] if r["lo"] == 0.72)

    def coin(d):
        return next(r for r in d["buckets"] if r["lo"] == 0.50)

    for seed in seeds:
        s = res["seeds"][str(seed)]
        base = s["ufc_only"]
        print(f"-- seed {seed} --")
        print(f"  {'config':<14}{'overall':>9}{'val':>9}{'tail 0.72+':>12}{'Δtail':>9}"
              f"{'coin':>9}{'Δcoin':>9}{'acc':>8}{'reliab':>9}")
        print(f"  {'ufc_only':<14}{base['headline_odds']['logloss']:>9.4f}"
              f"{base['val_logloss']:>9.4f}{tail(base)['model']:>12.4f}{'—':>9}"
              f"{coin(base)['model']:>9.4f}{'—':>9}{base['headline_odds']['acc']:>8.4f}"
              f"{base['murphy']['reliability']:>9.5f}")
        for w in weights:
            u = s[f"union_w{w}"]
            print(f"  {'union w' + str(w):<14}{u['headline_odds']['logloss']:>9.4f}"
                  f"{u['val_logloss']:>9.4f}{tail(u)['model']:>12.4f}"
                  f"{tail(u)['model'] - tail(base)['model']:>+9.4f}"
                  f"{coin(u)['model']:>9.4f}{coin(u)['model'] - coin(base)['model']:>+9.4f}"
                  f"{u['headline_odds']['acc']:>8.4f}{u['murphy']['reliability']:>9.5f}")
        print()

    print("-- GATE 0b read: Δtail sign across seeds, per weight --")
    for w in weights:
        deltas = []
        for seed in seeds:
            s = res["seeds"][str(seed)]
            deltas.append(tail(s[f"union_w{w}"])["model"] - tail(s["ufc_only"])["model"])
        sign = "stable-BETTER" if all(d < 0 for d in deltas) else (
            "stable-WORSE" if all(d > 0 for d in deltas) else "FLIPS")
        print(f"  w{w}: Δtail " + " ".join(f"{d:+.4f}" for d in deltas) + f"  → {sign}")


# ── Stage 0b controls — falsification + population-shift risk (§5) ───────


def stage_0b_controls(seeds: list[int], weights: list[float], use_cache: bool) -> dict:
    """Three adversarial reads on the 0b tail gain:

    1. LABEL-SHUFFLE falsification — the decisive test of information vs. data
       volume. Permute the non-UFC labels (RandomState(seed)) and re-run: if the
       tail still improves with the label→feature link destroyed, the gain is
       regularization / row count, not non-UFC information, and the lever closes.
    2. PROPENSITY AUC — an LGB separating UFC-train from non-UFC rows on the
       record features. High AUC = the two populations are far apart and the
       union model is extrapolating (§5 go/no-go).
    3. STYLE decomposition — split the tail gain by the market-favourite's career
       finish rate. If it is all in punchers, it is a striker skew, not
       resolution (the risk lab_graded_style checked for the graded label).
    """
    import lightgbm as lgb
    from sklearn.metrics import roc_auc_score

    cols = record_only_columns()
    ufc, nonufc = build_union_frames(use_cache)
    Xu, yu, metau = build_feature_matrix(ufc)
    Xu_sw, _, _ = build_feature_matrix(swap_sides(ufc))
    dt = pd.to_datetime(metau["event_date"])
    m_tr = (dt < TRAIN_END).to_numpy()
    m_va = ((dt >= TRAIN_END) & (dt < VAL_END)).to_numpy()
    m_te = (dt >= VAL_END).to_numpy()
    Xu, Xu_sw = Xu[cols], Xu_sw[cols]
    y_te = yu[m_te].to_numpy().astype(int)
    market_te = metau.loc[m_te, "market_prob_a"].to_numpy(dtype=float)
    has_te = ~np.isnan(market_te)
    Xn, yn, _ = build_feature_matrix(nonufc)
    Xn = Xn[cols]
    X_ufc_tr, y_ufc_tr = Xu[m_tr], yu[m_tr]

    def tail_ll(model) -> float:
        p = order_averaged_probs(model, Xu[m_te], Xu_sw[m_te])
        return next(r for r in bucket_table(p, market_te, y_te) if r["lo"] == 0.72)["model"]

    # ── 1. label-shuffle falsification ──
    print("\n-- control 1: label-shuffle falsification (real vs shuffled non-UFC labels) --")
    X_union = pd.concat([X_ufc_tr, Xn], ignore_index=True)
    shuffle: dict = {}
    for seed in seeds:
        base = fit_record_only(X_ufc_tr, y_ufc_tr, Xu[m_va], yu[m_va], cols, seed)
        base_tail = tail_ll(base)
        rng = np.random.RandomState(seed)
        yn_shuf = pd.Series(rng.permutation(yn.to_numpy()), name=yn.name)
        y_union_real = pd.concat([y_ufc_tr, yn], ignore_index=True)
        y_union_shuf = pd.concat([y_ufc_tr, yn_shuf], ignore_index=True)
        for w in weights:
            sw = np.concatenate([np.ones(len(X_ufc_tr)), np.full(len(Xn), w)])
            m_real = fit_record_only(X_union, y_union_real, Xu[m_va], yu[m_va], cols, seed, sample_weight=sw)
            m_shuf = fit_record_only(X_union, y_union_shuf, Xu[m_va], yu[m_va], cols, seed, sample_weight=sw)
            shuffle.setdefault(f"w{w}", {})[str(seed)] = {
                "d_real": tail_ll(m_real) - base_tail,
                "d_shuffled": tail_ll(m_shuf) - base_tail,
            }
            print(f"  seed {seed} w{w}: Δtail real {tail_ll(m_real) - base_tail:+.4f}  "
                  f"shuffled {tail_ll(m_shuf) - base_tail:+.4f}")

    # ── 2. propensity AUC ──
    print("\n-- control 2: propensity (UFC-train vs non-UFC) on record features --")
    Xp = pd.concat([X_ufc_tr, Xn], ignore_index=True).reset_index(drop=True)
    yp = np.concatenate([np.zeros(len(X_ufc_tr)), np.ones(len(Xn))])
    rng = np.random.RandomState(42)
    perm = rng.permutation(len(Xp))
    cut = int(0.7 * len(Xp))
    tr_i, va_i = perm[:cut], perm[cut:]
    dtr = lgb.Dataset(Xp.iloc[tr_i], label=yp[tr_i])
    dva = lgb.Dataset(Xp.iloc[va_i], label=yp[va_i], reference=dtr)
    booster = lgb.train({**LGB_PARAMS, "objective": "binary", "seed": 42}, dtr,
                        num_boost_round=500, valid_sets=[dva],
                        callbacks=[lgb.early_stopping(50, verbose=False)])
    prop_auc = float(roc_auc_score(yp[va_i], booster.predict(Xp.iloc[va_i])))
    print(f"  propensity AUC {prop_auc:.4f}  (1.0 = perfectly separable populations)")

    # ── 3. style decomposition of the tail gain (seed 42, middle weight) ──
    print("\n-- control 3: tail gain by market-favourite finish rate (seed 42) --")
    w_mid = weights[len(weights) // 2]
    base = fit_record_only(X_ufc_tr, y_ufc_tr, Xu[m_va], yu[m_va], cols, 42)
    sw = np.concatenate([np.ones(len(X_ufc_tr)), np.full(len(Xn), w_mid)])
    y_union_real = pd.concat([y_ufc_tr, yn], ignore_index=True)
    union = fit_record_only(X_union, y_union_real, Xu[m_va], yu[m_va], cols, 42, sample_weight=sw)
    p_base = order_averaged_probs(base, Xu[m_te], Xu_sw[m_te])
    p_union = order_averaged_probs(union, Xu[m_te], Xu_sw[m_te])
    # favourite's career (UFC) finish rate on the test rows.
    fr_a = pd.to_numeric(ufc.loc[m_te, "prior_finish_rate_a"].reset_index(drop=True), errors="coerce")
    fr_b = pd.to_numeric(ufc.loc[m_te, "prior_finish_rate_b"].reset_index(drop=True), errors="coerce")
    fav_a = market_te >= 0.5
    fav_fr = np.where(fav_a, fr_a.to_numpy(), fr_b.to_numpy())
    conf = np.maximum(market_te, 1 - market_te)
    tail_sel = has_te & (conf >= 0.72)
    from sklearn.metrics import log_loss as _ll
    style: dict = {}
    for name, lo, hi in [("grappler", -0.01, 0.34), ("mixed", 0.34, 0.67), ("finisher", 0.67, 1.01)]:
        sel = tail_sel & (fav_fr >= lo) & (fav_fr < hi) & ~np.isnan(fav_fr)
        k = int(sel.sum())
        if k < 5:
            continue
        yy = y_te[sel]
        ll_b = float(_ll(yy, np.clip(p_base[sel], EPS, 1 - EPS), labels=[0, 1]))
        ll_u = float(_ll(yy, np.clip(p_union[sel], EPS, 1 - EPS), labels=[0, 1]))
        style[name] = {"n": k, "mean_fr": float(np.nanmean(fav_fr[sel])),
                       "base_ll": ll_b, "union_ll": ll_u, "delta": ll_u - ll_b}
        print(f"  {name:<9} n {k:>3}  fav_fr {np.nanmean(fav_fr[sel]):.2f}  "
              f"base {ll_b:.4f} → union {ll_u:.4f}  Δ {ll_u - ll_b:+.4f}")

    print("\n-- controls verdict --")
    for w in weights:
        reals = [shuffle[f"w{w}"][str(s)]["d_real"] for s in seeds]
        shufs = [shuffle[f"w{w}"][str(s)]["d_shuffled"] for s in seeds]
        print(f"  w{w}: mean Δtail real {np.mean(reals):+.4f}  shuffled {np.mean(shufs):+.4f}  "
              f"→ information share {(np.mean(reals) - np.mean(shufs)):+.4f}")
    return {"shuffle": shuffle, "propensity_auc": prop_auc, "style": style, "w_mid": w_mid}


# ── entrypoint ───────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=("0a", "0b", "0bx"))
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--seeds", default="42,7,13")
    ap.add_argument("--weights", default="0.1,0.2,0.4")
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",")]

    payload: dict = {}
    if args.stage == "0a":
        df = load_symmetrized(args.cache)
        print(f"UFC frame: {len(df):,} both-experienced bouts · "
              f"base {df['target_a_wins'].mean():.4f}")
        res = stage_0a(df, seeds)
        print_stage_0a(res, seeds)
        payload = {"stage_0a": res}
    elif args.stage == "0b":
        weights = [float(w) for w in args.weights.split(",")]
        res = stage_0b(seeds, weights, args.cache)
        print_stage_0b(res, seeds, weights)
        payload = {"stage_0b": res}
    elif args.stage == "0bx":
        weights = [float(w) for w in args.weights.split(",")]
        res = stage_0b_controls(seeds, weights, args.cache)
        payload = {"stage_0b_controls": res}

    existing = json.loads(OUT_PATH.read_text()) if OUT_PATH.exists() else {}
    existing.update(payload)
    OUT_PATH.write_text(json.dumps(existing, indent=2, default=float))
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()

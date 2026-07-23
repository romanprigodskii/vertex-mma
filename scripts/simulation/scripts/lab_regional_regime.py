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
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
    TRAIN_END,
    VAL_END,
)
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import swap_sides  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.train import _load_tuned_params  # noqa: E402

OUT_PATH = ARTIFACTS_DIR / "lab_regional_regime.json"


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


# ── entrypoint ───────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=("0a", "0b"))
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--seeds", default="42,7,13")
    ap.add_argument("--weights", default="0.1,0.2,0.4")
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",")]

    df = load_symmetrized(args.cache)
    print(f"UFC frame: {len(df):,} both-experienced bouts · "
          f"base {df['target_a_wins'].mean():.4f}")

    payload: dict = {}
    if args.stage == "0a":
        res = stage_0a(df, seeds)
        print_stage_0a(res, seeds)
        payload = {"stage_0a": res}

    existing = json.loads(OUT_PATH.read_text()) if OUT_PATH.exists() else {}
    existing.update(payload)
    OUT_PATH.write_text(json.dumps(existing, indent=2, default=float))
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()

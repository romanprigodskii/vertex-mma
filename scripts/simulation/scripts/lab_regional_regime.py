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
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import log_loss  # noqa: E402

from src.config import (  # noqa: E402
    ARTIFACTS_DIR,
    FEATURE_CONTRI_OVERRIDES,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
    TRAIN_END,
    VAL_END,
)
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import swap_sides  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.regional_export import build_union_frames  # noqa: E402
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


# ── Stage 0b — point-in-time non-UFC training rows + union model ─────────


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


# ── Stage 2 — does the union record leg help the SERVED ensemble? ────────


def train_full_ensemble(
    X_tr: pd.DataFrame, y_tr: pd.Series, X_va: pd.DataFrame, y_va: pd.Series, seed: int
) -> EnsembleModel:
    """The served 3-leg recipe (feature_names(), tuned params, age throttle) on
    the UFC train split — the baseline the union leg must improve on."""
    cols = feature_names()
    tuned = _load_tuned_params()
    lgb_params = {
        **LGB_PARAMS, **tuned,
        "feature_contri": [FEATURE_CONTRI_OVERRIDES.get(c, 1.0) for c in cols],
        "seed": seed,
    }
    m = EnsembleModel(cols, lgb_params, LGB_NUM_ROUNDS, LGB_EARLY_STOPPING_ROUNDS)
    if seed != 42:
        m._cb_params = staticmethod(  # type: ignore[method-assign]
            lambda: {**EnsembleModel._cb_params(), "random_seed": seed}
        ).__func__
    m.fit(X_train=X_tr.reset_index(drop=True), y_train=y_tr.reset_index(drop=True),
          X_val=X_va.reset_index(drop=True), y_val=y_va.reset_index(drop=True))
    return m


def _select_blend(base_va: np.ndarray, y_va: np.ndarray) -> dict:
    """Pick the blend the served EnsembleModel would: best of logreg / mean /
    softmax-weighted-mean on BINARY val log-loss, over an N-leg base matrix."""
    blender = LogisticRegression(max_iter=500, C=0.1, solver="liblinear", random_state=42)
    blender.fit(base_va, y_va)
    p_lr = blender.predict_proba(base_va)[:, 1]
    p_mean = base_va.mean(axis=1)
    per_ll = np.array([log_loss(y_va, base_va[:, j].clip(1e-4, 1 - 1e-4))
                       for j in range(base_va.shape[1])])
    scaled = -per_ll / max(per_ll.std(), 1e-6)
    e = np.exp(scaled - scaled.max())
    weights = e / e.sum()
    p_w = base_va @ weights
    opts = {
        "logreg": log_loss(y_va, p_lr.clip(1e-4, 1 - 1e-4)),
        "mean": log_loss(y_va, p_mean.clip(1e-4, 1 - 1e-4)),
        "weighted_mean": log_loss(y_va, p_w.clip(1e-4, 1 - 1e-4)),
    }
    best = min(opts, key=lambda k: opts[k])
    return {"mode": best, "weights": weights, "blender": blender, "val_opts": opts}


def _apply_blend(base: np.ndarray, sel: dict) -> np.ndarray:
    if sel["mode"] == "mean":
        return base.mean(axis=1)
    if sel["mode"] == "weighted_mean":
        return base @ sel["weights"]
    return sel["blender"].predict_proba(base)[:, 1]


def _order_avg_blend(base: np.ndarray, base_sw: np.ndarray, sel: dict) -> np.ndarray:
    return 0.5 * (_apply_blend(base, sel) + (1.0 - _apply_blend(base_sw, sel)))


def stage_2a(seeds: list[int], weights: list[float], use_cache: bool) -> dict:
    """4th-leg blend: the union-trained record-only model joins lgb/cb/logreg on
    the FULL feature set, the blender picks its weight on binary val log-loss.
    Baseline = the served 3-leg ensemble. GATE 1 = all of a-g."""
    rec_cols = record_only_columns()
    full_cols = feature_names()
    ufc, nonufc = build_union_frames(use_cache)

    X, y, meta = build_feature_matrix(ufc)
    X_sw, _, _ = build_feature_matrix(swap_sides(ufc))
    dt = pd.to_datetime(meta["event_date"])
    m_tr = (dt < TRAIN_END).to_numpy()
    m_va = ((dt >= TRAIN_END) & (dt < VAL_END)).to_numpy()
    m_te = (dt >= VAL_END).to_numpy()
    y_te = y[m_te].to_numpy().astype(int)
    y_va_arr = y[m_va].to_numpy().astype(int)
    market_te = meta.loc[m_te, "market_prob_a"].to_numpy(dtype=float)
    has_te = ~np.isnan(market_te)

    Xn, yn, _ = build_feature_matrix(nonufc)
    Xr_tr = pd.concat([X[rec_cols][m_tr], Xn[rec_cols]], ignore_index=True)
    yr_tr = pd.concat([y[m_tr], yn], ignore_index=True)

    def eval_probs(probs: np.ndarray) -> dict:
        return {
            "headline_odds": headline(probs[has_te], y_te[has_te]),
            "buckets": bucket_table(probs, market_te, y_te),
            "murphy": murphy(probs[has_te], y_te[has_te]),
        }

    out: dict = {"seeds": {}}
    for seed in seeds:
        full = train_full_ensemble(X[full_cols][m_tr], y[m_tr], X[full_cols][m_va], y[m_va], seed)
        # full 3-leg base matrices (val single-orientation for selection; test
        # both orientations for order-averaged eval).
        bf_va = full._base_predict_matrix(X[full_cols][m_va].reset_index(drop=True))
        bf_te = full._base_predict_matrix(X[full_cols][m_te].reset_index(drop=True))
        bf_te_sw = full._base_predict_matrix(X_sw[full_cols][m_te].reset_index(drop=True))
        bf_va_sw = full._base_predict_matrix(X_sw[full_cols][m_va].reset_index(drop=True))

        sel3 = _select_blend(bf_va, y_va_arr)
        p3_te = _order_avg_blend(bf_te, bf_te_sw, sel3)
        p3_va = _order_avg_blend(bf_va, bf_va_sw, sel3)
        seed_res: dict = {
            "baseline_3leg": {
                **eval_probs(p3_te),
                "val_logloss": float(log_loss(y_va_arr, np.clip(p3_va, EPS, 1 - EPS))),
                "blend_mode": sel3["mode"],
            },
        }
        for w in weights:
            sw = np.concatenate([np.ones(int(m_tr.sum())), np.full(len(Xn), w)])
            union = fit_record_only(Xr_tr, yr_tr, X[rec_cols][m_va], y[m_va], rec_cols, seed, sample_weight=sw)
            pu_va = union.predict_proba_a(X[rec_cols][m_va].reset_index(drop=True))
            pu_te = union.predict_proba_a(X[rec_cols][m_te].reset_index(drop=True))
            pu_te_sw = union.predict_proba_a(X_sw[rec_cols][m_te].reset_index(drop=True))
            pu_va_sw = union.predict_proba_a(X_sw[rec_cols][m_va].reset_index(drop=True))

            b4_va = np.column_stack([bf_va, pu_va])
            b4_te = np.column_stack([bf_te, pu_te])
            b4_te_sw = np.column_stack([bf_te_sw, pu_te_sw])
            b4_va_sw = np.column_stack([bf_va_sw, pu_va_sw])
            sel4 = _select_blend(b4_va, y_va_arr)
            p4_te = _order_avg_blend(b4_te, b4_te_sw, sel4)
            p4_va = _order_avg_blend(b4_va, b4_va_sw, sel4)
            # union leg weight: softmax weight if weighted_mean, else blender coef.
            if sel4["mode"] == "weighted_mean":
                leg_w = float(sel4["weights"][-1])
            elif sel4["mode"] == "logreg":
                leg_w = float(sel4["blender"].coef_[0][-1])
            else:
                leg_w = 0.25
            seed_res[f"union4_w{w}"] = {
                **eval_probs(p4_te),
                "val_logloss": float(log_loss(y_va_arr, np.clip(p4_va, EPS, 1 - EPS))),
                "blend_mode": sel4["mode"],
                "union_leg_weight": leg_w,
            }
        out["seeds"][str(seed)] = seed_res
    return out


def _gate1_row(d: dict, base: dict) -> str:
    def tail(x):
        return next(r for r in x["buckets"] if r["lo"] == 0.72)["model"]

    def coin(x):
        return next(r for r in x["buckets"] if r["lo"] == 0.50)["model"]
    return (f"{d['headline_odds']['logloss']:>8.4f}{d['val_logloss']:>8.4f}"
            f"{tail(d):>9.4f}{tail(d) - tail(base):>+8.4f}{coin(d):>8.4f}"
            f"{coin(d) - coin(base):>+8.4f}{d['headline_odds']['acc']:>8.4f}"
            f"{d['murphy']['reliability']:>9.5f}")


def print_stage_2a(res: dict, seeds: list[int], weights: list[float]) -> None:
    print("\n=== STAGE 2a — union record leg as 4th leg of the served ensemble ===")
    print("baseline = served 3-leg ensemble (target: overall 0.6198, tail 0.5152, "
          "coin 0.6688, acc 0.6690, reliab 0.00296, market tail 0.4392)\n")
    for seed in seeds:
        s = res["seeds"][str(seed)]
        base = s["baseline_3leg"]
        print(f"-- seed {seed} --")
        print(f"  {'config':<14}{'overall':>8}{'val':>8}{'tail':>9}{'Δtail':>8}"
              f"{'coin':>8}{'Δcoin':>8}{'acc':>8}{'reliab':>9}{'legW':>7}{'mode':>14}")
        print(f"  {'3leg base':<14}{_gate1_row(base, base)}{'—':>7}{base['blend_mode']:>14}")
        for w in weights:
            u = s[f"union4_w{w}"]
            print(f"  {'union4 w' + str(w):<14}{_gate1_row(u, base)}"
                  f"{u['union_leg_weight']:>7.3f}{u['blend_mode']:>14}")
        print()

    print("-- GATE 1(c,g) read: tail Δ sign across seeds --")

    def tailv(x):
        return next(r for r in x["buckets"] if r["lo"] == 0.72)["model"]
    for w in weights:
        ds = [tailv(res["seeds"][str(s)][f"union4_w{w}"]) - tailv(res["seeds"][str(s)]["baseline_3leg"])
              for s in seeds]
        sign = "stable-BETTER" if all(d < 0 for d in ds) else (
            "stable-WORSE" if all(d > 0 for d in ds) else "FLIPS")
        print(f"  w{w}: Δtail " + " ".join(f"{d:+.4f}" for d in ds) + f"  → {sign}")


# ── Stage 2b — transfer: non-UFC as a prior, then fine-tune on UFC ───────


def fit_record_transfer(
    union_model: EnsembleModel,
    X_ufc: pd.DataFrame, y_ufc: pd.Series,
    X_va: pd.DataFrame, y_va: pd.Series,
    seed: int, ft_rounds: int = 300,
) -> EnsembleModel:
    """Continue the union-pretrained record legs on UFC-only (LGB/CB via
    init_model, logreg refit) — the non-UFC region as a PRIOR the UFC data then
    corrects, rather than as equal-weight rows. The blend is re-selected on the
    UFC val split, so the returned model's predict_proba_a serves as a leg."""
    import lightgbm as lgb
    from catboost import CatBoostClassifier

    m = EnsembleModel(union_model.feature_columns, union_model.lgb_params,
                      LGB_NUM_ROUNDS, LGB_EARLY_STOPPING_ROUNDS)
    dtr = lgb.Dataset(X_ufc, label=y_ufc)
    dva = lgb.Dataset(X_va, label=y_va, reference=dtr)
    m.lgb_global = lgb.train(union_model.lgb_params, dtr, num_boost_round=ft_rounds,
                             valid_sets=[dva], valid_names=["val"],
                             init_model=union_model.lgb_global,
                             callbacks=[lgb.early_stopping(LGB_EARLY_STOPPING_ROUNDS, verbose=False)])
    cbp = {**EnsembleModel._cb_params(), "random_seed": seed, "iterations": ft_rounds}
    cb = CatBoostClassifier(**cbp, early_stopping_rounds=100)
    cb.fit(X_ufc, y_ufc.astype(int), eval_set=(X_va, y_va.astype(int)),
           init_model=union_model.cb_global)
    m.cb_global = cb
    m.logreg, m.scaler, m.logreg_means = m._train_logreg(X_ufc, y_ufc)
    # re-select the internal 3-leg blend on UFC val so predict_proba_a works.
    base_va = m._base_predict_matrix(X_va.reset_index(drop=True))
    sel = _select_blend(base_va, y_va.to_numpy().astype(int))
    m.blender = sel["blender"]
    m._blend_mode = sel["mode"]
    m._blend_weights = sel["weights"].tolist()
    m._val_blend_logloss = sel["val_opts"]
    return m


def stage_2b(seeds: list[int], weights: list[float], use_cache: bool) -> dict:
    """Transfer variant of Stage 2: the record leg is union-pretrained then
    fine-tuned on UFC, blended as the 4th leg. Reports each record model's OWN
    tail (the ceiling for any record-leg approach) alongside the blend result."""
    rec_cols = record_only_columns()
    full_cols = feature_names()
    ufc, nonufc = build_union_frames(use_cache)
    X, y, meta = build_feature_matrix(ufc)
    X_sw, _, _ = build_feature_matrix(swap_sides(ufc))
    dt = pd.to_datetime(meta["event_date"])
    m_tr = (dt < TRAIN_END).to_numpy()
    m_va = ((dt >= TRAIN_END) & (dt < VAL_END)).to_numpy()
    m_te = (dt >= VAL_END).to_numpy()
    y_te = y[m_te].to_numpy().astype(int)
    y_va_arr = y[m_va].to_numpy().astype(int)
    market_te = meta.loc[m_te, "market_prob_a"].to_numpy(dtype=float)
    has_te = ~np.isnan(market_te)
    Xn, yn, _ = build_feature_matrix(nonufc)
    w = weights[len(weights) // 2]  # one representative down-weight
    Xr_tr = pd.concat([X[rec_cols][m_tr], Xn[rec_cols]], ignore_index=True)
    yr_tr = pd.concat([y[m_tr], yn], ignore_index=True)
    sw = np.concatenate([np.ones(int(m_tr.sum())), np.full(len(Xn), w)])

    def rec_tail(model) -> float:
        p = order_averaged_probs(model, X[rec_cols][m_te], X_sw[rec_cols][m_te])
        return next(r for r in bucket_table(p, market_te, y_te) if r["lo"] == 0.72)["model"]

    def leg_and_blend(union_leg, full, bf_va, bf_te, bf_te_sw, bf_va_sw, sel3):
        pu_va = union_leg.predict_proba_a(X[rec_cols][m_va].reset_index(drop=True))
        pu_te = union_leg.predict_proba_a(X[rec_cols][m_te].reset_index(drop=True))
        pu_te_sw = union_leg.predict_proba_a(X_sw[rec_cols][m_te].reset_index(drop=True))
        pu_va_sw = union_leg.predict_proba_a(X_sw[rec_cols][m_va].reset_index(drop=True))
        b4_va = np.column_stack([bf_va, pu_va])
        sel4 = _select_blend(b4_va, y_va_arr)
        p4_te = _order_avg_blend(np.column_stack([bf_te, pu_te]),
                                 np.column_stack([bf_te_sw, pu_te_sw]), sel4)
        p4_va = _order_avg_blend(b4_va, np.column_stack([bf_va_sw, pu_va_sw]), sel4)
        tl = next(r for r in bucket_table(p4_te, market_te, y_te) if r["lo"] == 0.72)["model"]
        cn = next(r for r in bucket_table(p4_te, market_te, y_te) if r["lo"] == 0.50)["model"]
        return {
            "headline_odds": headline(p4_te[has_te], y_te[has_te]),
            "tail": tl, "coin": cn,
            "val_logloss": float(log_loss(y_va_arr, np.clip(p4_va, EPS, 1 - EPS))),
            "murphy": murphy(p4_te[has_te], y_te[has_te]),
            "mode": sel4["mode"],
        }, sel4

    out: dict = {"weight": w, "seeds": {}}
    for seed in seeds:
        full = train_full_ensemble(X[full_cols][m_tr], y[m_tr], X[full_cols][m_va], y[m_va], seed)
        bf_va = full._base_predict_matrix(X[full_cols][m_va].reset_index(drop=True))
        bf_te = full._base_predict_matrix(X[full_cols][m_te].reset_index(drop=True))
        bf_te_sw = full._base_predict_matrix(X_sw[full_cols][m_te].reset_index(drop=True))
        bf_va_sw = full._base_predict_matrix(X_sw[full_cols][m_va].reset_index(drop=True))
        sel3 = _select_blend(bf_va, y_va_arr)
        p3_te = _order_avg_blend(bf_te, bf_te_sw, sel3)
        base3_tail = next(r for r in bucket_table(p3_te, market_te, y_te) if r["lo"] == 0.72)["model"]

        union = fit_record_only(Xr_tr, yr_tr, X[rec_cols][m_va], y[m_va], rec_cols, seed, sample_weight=sw)
        transfer = fit_record_transfer(union, X[rec_cols][m_tr].reset_index(drop=True),
                                       y[m_tr].reset_index(drop=True),
                                       X[rec_cols][m_va].reset_index(drop=True),
                                       y[m_va].reset_index(drop=True), seed)
        blend_union, _ = leg_and_blend(union, full, bf_va, bf_te, bf_te_sw, bf_va_sw, sel3)
        blend_transfer, _ = leg_and_blend(transfer, full, bf_va, bf_te, bf_te_sw, bf_va_sw, sel3)
        out["seeds"][str(seed)] = {
            "full_tail": base3_tail,
            "union_standalone_tail": rec_tail(union),
            "transfer_standalone_tail": rec_tail(transfer),
            "blend_union": blend_union,
            "blend_transfer": blend_transfer,
            "base3_val": float(log_loss(y_va_arr, np.clip(_order_avg_blend(bf_va, bf_va_sw, sel3), EPS, 1 - EPS))),
        }
    return out


def print_stage_2b(res: dict, seeds: list[int]) -> None:
    print(f"\n=== STAGE 2b — transfer record leg (down-weight {res['weight']}) ===")
    print("standalone tails (the ceiling: a record leg can never out-sharpen the "
          "full model's tail) and the 4th-leg blend result:\n")
    print(f"  {'seed':<6}{'full tail':>10}{'union tail':>12}{'transf tail':>12}"
          f"{'blendU tail':>12}{'blendT tail':>12}{'blendT val':>12}")
    for seed in seeds:
        s = res["seeds"][str(seed)]
        print(f"  {seed:<6}{s['full_tail']:>10.4f}{s['union_standalone_tail']:>12.4f}"
              f"{s['transfer_standalone_tail']:>12.4f}{s['blend_union']['tail']:>12.4f}"
              f"{s['blend_transfer']['tail']:>12.4f}{s['blend_transfer']['val_logloss']:>12.4f}")
    print("\n-- GATE 1 read (transfer vs 3-leg baseline) --")
    for seed in seeds:
        s = res["seeds"][str(seed)]
        dt_tail = s["blend_transfer"]["tail"] - s["full_tail"]
        dv = s["blend_transfer"]["val_logloss"] - s["base3_val"]
        print(f"  seed {seed}: transfer-blend Δtail {dt_tail:+.4f}  Δval {dv:+.4f}  "
              f"acc {s['blend_transfer']['headline_odds']['acc']:.4f}  "
              f"reliab {s['blend_transfer']['murphy']['reliability']:.5f}")


# ── entrypoint ───────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=("0a", "0b", "0bx", "2a", "2b"))
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
    elif args.stage == "2a":
        weights = [float(w) for w in args.weights.split(",")]
        res = stage_2a(seeds, weights, args.cache)
        print_stage_2a(res, seeds, weights)
        payload = {"stage_2a": res}
    elif args.stage == "2b":
        weights = [float(w) for w in args.weights.split(",")]
        res = stage_2b(seeds, weights, args.cache)
        print_stage_2b(res, seeds)
        payload = {"stage_2b": res}

    existing = json.loads(OUT_PATH.read_text()) if OUT_PATH.exists() else {}
    existing.update(payload)
    OUT_PATH.write_text(json.dumps(existing, indent=2, default=float))
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()

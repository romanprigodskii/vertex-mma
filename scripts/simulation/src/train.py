"""Train the EnsembleModel (LightGBM + XGBoost + LogReg, blended on the
val split). Artifacts go to scripts/simulation/artifacts/ensemble/."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd
from rich.console import Console
from rich.table import Table
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)

from .config import (
    ARTIFACTS_DIR,
    FEATURE_CONTRI_OVERRIDES,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
    MODEL_VERSION,
    RESIDUAL_CORRECTION,
    TRAIN_END,
    VAL_END,
)
from .ensemble import EnsembleModel, ResidualCorrector
from .features import (
    build_feature_matrix,
    debut_feature_names,
    feature_names,
    serving_columns,
)
from .method_model import (
    METHOD_MODEL_DEBUT_DIR,
    METHOD_MODEL_DEBUT_EVAL_DIR,
    METHOD_MODEL_DIR,
    METHOD_MODEL_EVAL_DIR,
    METHODS,
    USE_LEVELS,
    USE_SUB_AXIS,
    MethodModel,
    _multiclass_logloss,
    build_method_features,
    gradeable_rows,
    orient_winner_first,
    training_matrix,
)
from .provenance import collect_provenance, learner_iterations

console = Console()

ENSEMBLE_DIR = ARTIFACTS_DIR / "ensemble"
# The SPLIT-trained model is saved here too, so the manual eval scripts
# (eval_market / eval_calibration) can evaluate OUT-OF-SAMPLE: the served model
# in ENSEMBLE_DIR is refit on ALL data, so a test-split eval against it would be
# in-sample (optimistic).
ENSEMBLE_EVAL_DIR = ARTIFACTS_DIR / "ensemble_eval"
# v0.8.0 — the debut specialist (serves bouts with >=1 UFC debutant) and its
# split-trained eval twin.
ENSEMBLE_DEBUT_DIR = ARTIFACTS_DIR / "ensemble_debut"
ENSEMBLE_DEBUT_EVAL_DIR = ARTIFACTS_DIR / "ensemble_debut_eval"
# Transfer weighting for the specialist: both-experienced rows contribute at
# this weight so the model learns general feature->outcome structure without
# drowning the ~2k debut rows it exists for (v0.8 lab: 0.2 beat debut-only
# training and a reduced feature set on debut-val log-loss).
DEBUT_EXP_ROW_WEIGHT = 0.2

# What each temporal split is actually USED for — so the report doesn't present
# the val number as a clean generalization estimate. val is consumed 3–4×
# (LGB/XGB early-stopping → blender fit → blend-mode argmin), so its
# headline logloss is the very quantity minimized (it equals
# val_blend_logloss[best_mode]) and is optimistic by construction. TEST is the
# only split untouched by any fitting/selection — the one honest metric.
SPLIT_ROLES: dict[str, str] = {
    "train": "fit (in-sample)",
    "val": "early-stop + blender fit + blend-mode select — OPTIMISTIC, not held-out",
    "test": "held-out — clean",
}
CLEAN_HOLDOUT_SPLIT = "test"


def temporal_split(
    X: pd.DataFrame, y: pd.Series, meta: pd.DataFrame
) -> tuple[dict, dict, dict]:
    """Train / val / test split by event_date."""
    dt = pd.to_datetime(meta["event_date"])
    train_end = pd.to_datetime(TRAIN_END)
    val_end = pd.to_datetime(VAL_END)
    train_mask = dt < train_end
    val_mask = (dt >= train_end) & (dt < val_end)
    test_mask = dt >= val_end
    Xs = {
        "train": X.loc[train_mask].reset_index(drop=True),
        "val": X.loc[val_mask].reset_index(drop=True),
        "test": X.loc[test_mask].reset_index(drop=True),
    }
    ys = {
        "train": y.loc[train_mask].reset_index(drop=True),
        "val": y.loc[val_mask].reset_index(drop=True),
        "test": y.loc[test_mask].reset_index(drop=True),
    }
    metas = {
        "train": meta.loc[train_mask].reset_index(drop=True),
        "val": meta.loc[val_mask].reset_index(drop=True),
        "test": meta.loc[test_mask].reset_index(drop=True),
    }
    console.log(
        f"split sizes — train {len(Xs['train']):,} · val {len(Xs['val']):,} · "
        f"test {len(Xs['test']):,}"
    )
    return Xs, ys, metas


def _load_tuned_params() -> dict:
    """Pick up Optuna-tuned hyperparameters when present. Falls back to
    the defaults in LGB_PARAMS so the pipeline still trains end-to-end
    on a clean checkout where tune.py hasn't been run yet."""
    path = ARTIFACTS_DIR / "best_params.json"
    if not path.exists():
        return {}
    payload = json.loads(path.read_text())
    return payload.get("best_params", {})


def evaluate_probs(
    probs: np.ndarray,
    y: pd.Series,
    market_prob_a: pd.Series | None = None,
) -> dict[str, float]:
    # Reset every input to a common positional 0..n-1 index. `probs` is a
    # numpy array straight off predict_proba_a (positional), while `y` and
    # `market_prob_a` come from reset_index'd splits — but defensively
    # normalizing here is what makes the boolean masking below alignment-safe
    # regardless of caller index, which is exactly what the old market bug
    # (df.loc[reset_index]) got wrong.
    probs = np.asarray(probs, dtype=float)
    y = pd.Series(np.asarray(y)).reset_index(drop=True)
    pred = (probs >= 0.5).astype(int)
    out: dict[str, float] = {
        "n": int(len(y)),
        "accuracy": float(accuracy_score(y, pred)),
        "log_loss": float(log_loss(y, probs.clip(1e-4, 1 - 1e-4))),
        "brier": float(brier_score_loss(y, probs)),
        "roc_auc": float(roc_auc_score(y, probs)),
    }
    if market_prob_a is not None:
        m = pd.Series(np.asarray(market_prob_a, dtype=float)).reset_index(drop=True)
        m_mask = m.notna().to_numpy()
        if m_mask.any():
            m_clipped = m[m_mask].clip(1e-4, 1 - 1e-4)
            y_m = y[m_mask]
            m_pred = (m_clipped >= 0.5).astype(int)
            # Market on the bouts that actually have odds.
            out["market_accuracy"] = float(accuracy_score(y_m, m_pred))
            out["market_log_loss"] = float(log_loss(y_m, m_clipped))
            out["market_brier"] = float(brier_score_loss(y_m, m_clipped))
            out["market_n"] = int(m_mask.sum())
            # MODEL on the SAME odds subset — the apples-to-apples comparison.
            # The headline `accuracy` above is over ALL bouts in the split;
            # comparing it to `market_accuracy` (odds subset only) is what made
            # "model not worse than market" misleading. These let the report
            # put both on the identical set of bouts.
            p_sub = probs[m_mask]
            out["model_accuracy_on_market"] = float(
                accuracy_score(y_m, (p_sub >= 0.5).astype(int))
            )
            out["model_log_loss_on_market"] = float(
                log_loss(y_m, p_sub.clip(1e-4, 1 - 1e-4))
            )
            out["model_brier_on_market"] = float(brier_score_loss(y_m, p_sub))
    return out


def print_metrics_table(metrics: dict[str, dict[str, float]]) -> None:
    table = Table(title=f"Backtest — {MODEL_VERSION} (ensemble)")
    table.add_column("Split")
    table.add_column("N", justify="right")
    table.add_column("Acc", justify="right")
    table.add_column("LogLoss", justify="right")
    table.add_column("Brier", justify="right")
    table.add_column("AUC", justify="right")
    table.add_column("Role")
    for name in ("train", "val", "test"):
        m = metrics[name]
        table.add_row(
            name,
            f"{m['n']:,}",
            f"{m['accuracy']:.3f}",
            f"{m['log_loss']:.3f}",
            f"{m['brier']:.3f}",
            f"{m['roc_auc']:.3f}",
            SPLIT_ROLES[name],
        )
    console.print(table)
    console.log(
        f"[dim]only '{CLEAN_HOLDOUT_SPLIT}' is a clean held-out estimate; "
        f"val is reused for model selection (optimistic) — see SPLIT_ROLES[/dim]"
    )


def print_market_comparison(metrics: dict[str, dict[str, float]]) -> None:
    """Honest model-vs-market: both scored on the SAME bouts (those with a
    sportsbook line). Only splits that have any odds appear. This is the
    comparison the old code got wrong — model accuracy was over all bouts,
    market accuracy over the ~20% with odds, on misaligned rows."""
    rows = [n for n in ("train", "val", "test") if "market_n" in metrics[n]]
    if not rows:
        console.log("no bouts with odds in any split — skipping market comparison")
        return
    table = Table(title="Model vs market — identical bouts (odds only)")
    table.add_column("Split")
    table.add_column("N (odds)", justify="right")
    table.add_column("Model Acc", justify="right")
    table.add_column("Market Acc", justify="right")
    table.add_column("Model LogLoss", justify="right")
    table.add_column("Market LogLoss", justify="right")
    for name in rows:
        m = metrics[name]
        table.add_row(
            name,
            f"{m['market_n']:,}",
            f"{m['model_accuracy_on_market']:.3f}",
            f"{m['market_accuracy']:.3f}",
            f"{m['model_log_loss_on_market']:.3f}",
            f"{m['market_log_loss']:.3f}",
        )
    console.print(table)


def print_breakdown_table(
    by_learner: dict[str, dict[str, float]],
) -> None:
    """Compare each individual learner against the blended output."""
    table = Table(title="Per-learner test performance")
    table.add_column("Learner")
    table.add_column("Acc", justify="right")
    table.add_column("LogLoss", justify="right")
    table.add_column("AUC", justify="right")
    for name, m in by_learner.items():
        table.add_row(
            name,
            f"{m['accuracy']:.3f}",
            f"{m['log_loss']:.3f}",
            f"{m['roc_auc']:.3f}",
        )
    console.print(table)


def train_method_model(exp_df: pd.DataFrame) -> dict[str, Any]:
    """Fit the conditional method model on the same both-experienced
    population the main ensemble uses, and save both twins.

    Same two-artifact discipline as the ensemble: the split-trained model
    goes to method_model_eval/ so `eval_method_market.py` stays out-of-sample,
    and the served model is refit on ALL gradeable rows for the iteration
    counts the split run selected. Debut bouts are excluded here and skipped
    at serve time — the model has never been fitted on a row where one side's
    career columns are entirely NaN, and the debut segment already has its
    own specialist rather than a shared one.

    Method-leg lab: docs/method_leg.md."""
    X, y, dates = training_matrix(exp_df)
    tr = (dates < pd.Timestamp(TRAIN_END)).to_numpy()
    va = ((dates >= pd.Timestamp(TRAIN_END)) & (dates < pd.Timestamp(VAL_END))).to_numpy()
    if not tr.any() or not va.any():
        raise RuntimeError("empty method-model train or val split — check TRAIN_END/VAL_END")

    console.log(
        f"training conditional method model on {int(tr.sum()):,} rows "
        f"(val {int(va.sum()):,}, {X.shape[1]} features)…"
    )
    split = MethodModel().fit(
        X.loc[tr].reset_index(drop=True), y[tr],
        X.loc[va].reset_index(drop=True), y[va],
    )
    p_va = split.predict_cond(X.loc[va].reset_index(drop=True))
    va_ll = _multiclass_logloss(y[va], p_va)
    base = np.array([(y[tr] == j).mean() for j in range(3)])
    const_ll = float(-np.log(np.clip(np.tile(base, (int(va.sum()), 1))[
        np.arange(int(va.sum())), y[va]], 1e-12, 1.0)).mean())
    console.log(
        f"method model val log-loss {va_ll:.4f} vs {const_ll:.4f} for the "
        f"constant base rates · weights "
        + " ".join(f"{k}={v:.2f}" for k, v in split.weights.items())
    )
    split.save(METHOD_MODEL_EVAL_DIR)

    served = MethodModel(
        feature_columns=split.feature_columns,
        use_levels=split.use_levels,
        weights=split.weights,
        best_iters=split.best_iters,
        val_metrics=split.val_metrics,
    ).refit_fixed(X, y)
    served.save(METHOD_MODEL_DIR)
    console.log(f"method model refit on ALL {len(X):,} gradeable rows (served)")

    return {
        "n_train": int(tr.sum()),
        "n_val": int(va.sum()),
        "n_served_rows": int(len(X)),
        "n_features": int(X.shape[1]),
        "use_levels": split.use_levels,
        "val_logloss": va_ll,
        "val_logloss_constant_base_rates": const_ll,
        "val_solo_logloss": split.val_metrics.get("solo_logloss", {}),
        "blend_weights": split.weights,
        "best_iters": split.best_iters,
        "train_base_rates": dict(zip(METHODS, [float(x) for x in base], strict=True)),
        "note": (
            "conditional P(method | this side wins); serves via "
            "monte_carlo.simulate_bout(method_mix=...) and replaces "
            "METHOD_ANCHOR_LAMBDA on the non-debut segment"
        ),
    }


def train_debut_method_model(df: pd.DataFrame) -> dict[str, Any]:
    """Fit the conditional method model for the DEBUT segment.

    Until v0.14.0 there was no model here at all. `train_method_model`
    above is handed `exp_df`, so it has never seen a debut row, and
    `predict.py` passed `method_mix=None` for those bouts — roughly 19 % of
    the priced slate took its method / distance / total_rounds numbers from
    the simulator's own hazards, whose entire per-fight input is the ten
    hand-shrunk `FighterMC` fields, every one of which is a router default
    when one side has no UFC record.

    Same transfer recipe as the winner-leg specialist (v0.8.0), for the same
    reason: there are only ~2.2k gradeable debut rows, and training on them
    alone throws away everything the other 6.4k teach about how a skill gap
    turns into a finish. Both-experienced rows enter at
    `DEBUT_EXP_ROW_WEIGHT`; selection (early stopping and the simplex blend)
    uses DEBUT val rows only, so the model is chosen for the segment it
    serves.

    Gate trail: `docs/accuracy_batch.md` §6. The number that mattered was
    not the one this was expected to be: a per-length CONSTANT on the debut
    base rates is WORSE than the simulator (1.0524 vs 1.0091 on 793
    walk-forward bouts), so the anchor was not a straw man and the win here
    is a model win, not a corrected marginal.
    """
    sub = df.loc[gradeable_rows(df)].reset_index(drop=True)
    debut = (
        sub["is_debut_a"].fillna(False).astype(bool)
        | sub["is_debut_b"].fillna(False).astype(bool)
    ).to_numpy()
    oriented = orient_winner_first(sub)
    base, _, _ = build_feature_matrix(oriented)
    X = build_method_features(base, oriented, levels=USE_LEVELS, sub_axis=USE_SUB_AXIS)
    y = np.array([METHODS.index(m) for m in sub["method_bucket"]], dtype=int)
    dates = pd.to_datetime(sub["event_date"])
    weights = np.where(debut, 1.0, DEBUT_EXP_ROW_WEIGHT)

    tr = (dates < pd.Timestamp(TRAIN_END)).to_numpy()
    va = (
        (dates >= pd.Timestamp(TRAIN_END)) & (dates < pd.Timestamp(VAL_END))
    ).to_numpy() & debut
    if not tr.any() or va.sum() < 20:
        raise RuntimeError(
            f"debut method model: train {int(tr.sum())} / debut val {int(va.sum())} "
            "— refusing to select on that"
        )

    console.log(
        f"training debut method model (transfer, exp-row weight "
        f"{DEBUT_EXP_ROW_WEIGHT}) — {int(debut.sum()):,} debut rows · "
        f"train {int(tr.sum()):,} · debut val {int(va.sum())}"
    )
    split = MethodModel().fit(
        X.loc[tr].reset_index(drop=True),
        y[tr],
        X.loc[va].reset_index(drop=True),
        y[va],
        sample_weight=weights[tr],
    )
    p_va = split.predict_cond(X.loc[va].reset_index(drop=True))
    va_ll = _multiclass_logloss(y[va], p_va)
    base_rates = np.array([(y[tr & debut] == j).mean() for j in range(3)])
    const_ll = float(
        -np.log(
            np.clip(
                np.tile(base_rates, (int(va.sum()), 1))[np.arange(int(va.sum())), y[va]],
                1e-12,
                1.0,
            )
        ).mean()
    )
    console.log(
        f"debut method model val log-loss {va_ll:.4f} vs {const_ll:.4f} for the "
        f"debut base rates · weights "
        + " ".join(f"{k}={v:.2f}" for k, v in split.weights.items())
    )
    split.save(METHOD_MODEL_DEBUT_EVAL_DIR)

    served = MethodModel(
        feature_columns=split.feature_columns,
        use_levels=split.use_levels,
        weights=split.weights,
        best_iters=split.best_iters,
        val_metrics=split.val_metrics,
    ).refit_fixed(X, y, sample_weight=weights)
    served.save(METHOD_MODEL_DEBUT_DIR)
    console.log(
        f"debut method model refit on ALL {len(X):,} gradeable rows (served)"
    )

    return {
        "n_debut_rows": int(debut.sum()),
        "n_train": int(tr.sum()),
        "n_val_debut": int(va.sum()),
        "n_served_rows": int(len(X)),
        "n_features": int(X.shape[1]),
        "exp_row_weight": DEBUT_EXP_ROW_WEIGHT,
        "val_logloss": va_ll,
        "val_logloss_debut_base_rates": const_ll,
        "blend_weights": split.weights,
        "best_iters": split.best_iters,
        "debut_base_rates": dict(
            zip(METHODS, [float(x) for x in base_rates], strict=True)
        ),
        "note": (
            "conditional P(method | this side wins) for bouts with a UFC "
            "debutant; before v0.14.0 that segment had no method model and "
            "fell back to the simulator's hazards on router defaults"
        ),
    }


def run_training(df: pd.DataFrame) -> dict[str, dict[str, float]]:
    # The dataset may include debut rows (v0.8.0). The MAIN model trains on
    # both-experienced bouts only — exactly the v0.7.0 recipe — so adding
    # debut coverage cannot move its weights. The debut specialist below
    # trains on everything.
    if "is_debut_a" in df.columns:
        debut_mask_df = (df["is_debut_a"] | df["is_debut_b"]).astype(bool)
        exp_df = df[~debut_mask_df].reset_index(drop=True)
    else:
        exp_df = df

    # `corrector=True` so the CORRECTOR_COLUMNS ride along. The learners
    # never see them — `cols` below is feature_names() and EnsembleModel
    # narrows to its own feature_columns — but every scoring call after the
    # corrector is attached needs them present.
    X, y, meta = build_feature_matrix(exp_df, corrector=True)
    cols = feature_names()
    X_fit = X[cols]
    X = X[serving_columns(cols)]

    Xs, ys, metas = temporal_split(X, y, meta)
    Xfit_s, _, _ = temporal_split(X_fit, y, meta)
    if len(Xs["train"]) == 0 or len(Xs["val"]) == 0:
        raise RuntimeError(
            "Empty train or val split. Check TRAIN_END / VAL_END vs your data range."
        )

    feature_contri = [FEATURE_CONTRI_OVERRIDES.get(col, 1.0) for col in cols]
    tuned = _load_tuned_params()
    lgb_params = {**LGB_PARAMS, **tuned, "feature_contri": feature_contri}
    if tuned:
        console.log(f"using Optuna-tuned LGB params · {len(tuned)} overrides")

    ensemble = EnsembleModel(
        feature_columns=cols,
        lgb_params=lgb_params,
        lgb_num_rounds=LGB_NUM_ROUNDS,
        lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
    )

    console.log("training ensemble (LGB + XGB + LogReg)…")
    train_meta = ensemble.fit(
        X_train=Xfit_s["train"],
        y_train=ys["train"],
        X_val=Xfit_s["val"],
        y_val=ys["val"],
    )
    console.log(
        "blender coefs: "
        + " ".join(f"{k}={v:+.2f}" for k, v in train_meta["blender_coefs"].items())
    )

    # v0.13.0 — attach the residual corrector BEFORE any metric below is
    # computed, so the reported numbers are the ones production serves. It is a
    # fixed set of coefficients from config, not something fitted here: fitting
    # it needs walk-forward out-of-fold predictions (32 refits), which belongs
    # in the lab and not in a retrain that runs from cron.
    corrector = (
        ResidualCorrector.from_dict(RESIDUAL_CORRECTION) if RESIDUAL_CORRECTION else None
    )
    ensemble.corrector = corrector
    if corrector is not None:
        console.log(f"residual corrector attached — {corrector.describe()}")

    # Headline blended metrics per split.
    metrics: dict[str, dict[str, float]] = {}
    for name in ("train", "val", "test"):
        probs = ensemble.predict_proba_a(Xs[name])
        # market_prob_a rides on `meta` (build_feature_matrix), so metas[name]
        # is reset_index'd off the SAME mask as Xs[name]/ys[name] — i.e. row i
        # of `market` is row i of `probs`. The previous code indexed the FULL
        # df by the split's reset index (df.loc[metas[name].index, ...]), which
        # for val/test selected the earliest bouts in history instead of the
        # split's bouts (and silently dropped the market metrics entirely).
        market = (
            metas[name]["market_prob_a"]
            if "market_prob_a" in metas[name].columns
            else None
        )
        metrics[name] = evaluate_probs(probs, ys[name], market)
    print_metrics_table(metrics)
    print_market_comparison(metrics)

    # Per-learner test performance so we see whether the ensemble is
    # actually pulling its weight vs the strongest single model.
    test_breakdown = ensemble.predict_proba_breakdown(Xs["test"])
    by_learner: dict[str, dict[str, float]] = {}
    for learner_name, probs in test_breakdown.items():
        by_learner[learner_name] = evaluate_probs(probs, ys["test"])
    print_breakdown_table(by_learner)

    # Production refit: the SERVED model trains on ALL data (train+val+test) so
    # deployed weights include the most recent fights — not only data before
    # TRAIN_END (the split model never sees val/test, ~2.5yr stale by mid-2026).
    # The split-trained `ensemble` stays the source of the honest held-out
    # metrics above; `prod` is what we actually save + serve.

    # Persist the EVAL (split-trained) model so eval_market / eval_calibration
    # keep evaluating out-of-sample (the served model below is refit on all data).
    ENSEMBLE_EVAL_DIR.mkdir(exist_ok=True)
    ensemble.save(ENSEMBLE_EVAL_DIR)

    console.log(f"refitting production model on ALL {len(X):,} rows (served weights)…")
    prod = ensemble.refit_on_all(X_fit, y)
    served_through = str(pd.to_datetime(meta["event_date"]).max().date())

    # Persist artifacts — the PRODUCTION (refit-on-all) model is what we serve.
    ENSEMBLE_DIR.mkdir(exist_ok=True)
    prod.save(ENSEMBLE_DIR)

    # ── Debut specialist (v0.8.0) ───────────────────────────────────────
    # Serves bouts with >=1 UFC debutant, which the main model never sees.
    # Transfer recipe (validated in the v0.8 lab as "c_transfer"): train on
    # ALL rows with both-experienced bouts down-weighted to 0.2 — the 5.5k
    # extra rows teach what an elo/anthro/age edge is worth while the debut
    # rows + flags keep the debut regime dominant. Early stopping and the
    # blend-mode pick use the DEBUT val rows only.
    debut_metrics: dict[str, Any] | None = None
    debut_cols: list[str] | None = None
    debut_iterations: dict[str, Any] | None = None
    if "is_debut_a" in df.columns and bool(debut_mask_df.any()):
        debut_cols = debut_feature_names()
        X_d, y_d, meta_d = build_feature_matrix(df, corrector=True)
        X_d_fit = X_d[debut_cols]
        X_d = X_d[serving_columns(debut_cols)]
        weights_all = np.where(debut_mask_df.to_numpy(), 1.0, DEBUT_EXP_ROW_WEIGHT)

        dt_d = pd.to_datetime(meta_d["event_date"])
        m_tr = dt_d < pd.to_datetime(TRAIN_END)
        m_va = (dt_d >= pd.to_datetime(TRAIN_END)) & (dt_d < pd.to_datetime(VAL_END))
        m_te = dt_d >= pd.to_datetime(VAL_END)
        m_debut = debut_mask_df.to_numpy()
        # val = debut rows only — the specialist is selected for its segment.
        va_mask = m_va.to_numpy() & m_debut

        # Same tuned params, but feature_contri must match the specialist's
        # 92-column layout (the main list is 90 wide).
        debut_lgb_params = {
            **lgb_params,
            "feature_contri": [
                FEATURE_CONTRI_OVERRIDES.get(col, 1.0) for col in debut_cols
            ],
        }
        specialist = EnsembleModel(
            feature_columns=debut_cols,
            lgb_params=debut_lgb_params,
            lgb_num_rounds=LGB_NUM_ROUNDS,
            lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
        )
        console.log(
            f"training debut specialist (transfer, exp-row weight {DEBUT_EXP_ROW_WEIGHT}) — "
            f"{int(m_debut.sum()):,} debut rows · val {int(va_mask.sum())}"
        )
        specialist.fit(
            X_train=X_d_fit.loc[m_tr.to_numpy()].reset_index(drop=True),
            y_train=y_d.loc[m_tr.to_numpy()].reset_index(drop=True),
            X_val=X_d_fit.loc[va_mask].reset_index(drop=True),
            y_val=y_d.loc[va_mask].reset_index(drop=True),
            sample_weight=weights_all[m_tr.to_numpy()],
        )
        te_mask = m_te.to_numpy() & m_debut
        debut_probs = specialist.predict_proba_a(X_d.loc[te_mask].reset_index(drop=True))
        debut_metrics = evaluate_probs(
            debut_probs,
            y_d.loc[te_mask].reset_index(drop=True),
            meta_d.loc[te_mask, "market_prob_a"].reset_index(drop=True),
        )
        console.log(
            f"debut specialist test segment: n={debut_metrics['n']} "
            f"acc={debut_metrics['accuracy']:.3f} ll={debut_metrics['log_loss']:.3f}"
        )

        ENSEMBLE_DEBUT_EVAL_DIR.mkdir(exist_ok=True)
        specialist.save(ENSEMBLE_DEBUT_EVAL_DIR)
        prod_specialist = specialist.refit_on_all(
            X_d_fit, y_d, sample_weight=weights_all
        )
        ENSEMBLE_DEBUT_DIR.mkdir(exist_ok=True)
        prod_specialist.save(ENSEMBLE_DEBUT_DIR)
        debut_iterations = {
            "split": learner_iterations(specialist),
            "served": learner_iterations(prod_specialist),
        }

    # ── Conditional method model (v0.12.0) ──────────────────────────────
    # Prices the method and round legs. Trained on the same both-experienced
    # population as the main ensemble, on rows whose outcome the method
    # market actually settles.
    method_meta = train_method_model(exp_df)

    # v0.14.0 — the same leg for the segment that had none. Trained on the
    # FULL frame (debut rows included) with both-experienced down-weighted,
    # so it does not disturb the model above, which keeps its own
    # both-experienced-only fit.
    debut_method_meta: dict[str, Any] | None = None
    if "is_debut_a" in df.columns and bool(debut_mask_df.any()):
        debut_method_meta = train_debut_method_model(df)

    metadata = {
        "model_version": MODEL_VERSION,
        "model_kind": "ensemble",
        "trained_at": datetime.utcnow().isoformat() + "Z",
        # What produced these weights. Without it a changed `.cbm` has no
        # suspects: the dataset, the library and the code all leave the same
        # trace, which is none. See src/provenance.py.
        "provenance": {
            **collect_provenance(df),
            "iterations": {
                "split": learner_iterations(ensemble),
                "served": learner_iterations(prod),
                "debut": debut_iterations,
            },
        },
        "feature_columns": cols,
        "train_end": TRAIN_END,
        "val_end": VAL_END,
        "lgb_params": lgb_params,
        "blender": train_meta,
        "metrics": metrics,
        # Honesty flags: val is reused for early-stopping + blender fit +
        # blend-mode selection, so its metrics are optimistic by construction
        # (val log-loss == the minimized val_blend_logloss). Only test is clean.
        "split_roles": SPLIT_ROLES,
        "clean_holdout_metric": CLEAN_HOLDOUT_SPLIT,
        # The SAVED/served model is refit on ALL data; the metrics above come
        # from the split model and are a conservative estimate (the served model
        # has strictly more training data, incl. the most recent fights).
        "served_model": {
            "refit_on_all_data": True,
            "n_rows": int(len(X)),
            "trained_through": served_through,
            "note": "served weights = train+val+test; metrics are the split model's honest held-out estimate",
        },
        "test_breakdown_by_learner": {k: v for k, v in by_learner.items()},
        "n_train": int(len(Xs["train"])),
        "n_val": int(len(Xs["val"])),
        "n_test": int(len(Xs["test"])),
        # v0.8.0 — debut specialist (None when the dataset had no debut rows).
        "debut_specialist": (
            {
                "feature_columns": debut_cols,
                "exp_row_weight": DEBUT_EXP_ROW_WEIGHT,
                "metrics_test_debut_segment": debut_metrics,
                "note": "serves bouts with >=1 UFC debutant; selection val = debut rows only; weaker than the market on this segment — probabilities are directional, not sharp",
            }
            if debut_metrics is not None
            else None
        ),
        # v0.12.0 — conditional method model. Prices the method/round legs;
        # the winner leg is untouched, so every metric above is unaffected.
        "method_model": method_meta,
        # v0.14.0 — the debut segment's conditional method model.
        "method_model_debut": debut_method_meta,
    }
    (ARTIFACTS_DIR / "metadata.json").write_text(
        json.dumps(metadata, indent=2, default=str)
    )
    console.log(
        f"saved PRODUCTION ensemble (refit on all {len(X):,} rows, "
        f"through {served_through}) to {ENSEMBLE_DIR.name}/ · metadata.json refreshed"
    )
    return metrics

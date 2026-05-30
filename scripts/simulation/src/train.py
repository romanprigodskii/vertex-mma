"""Phase 5 — train the EnsembleModel (LightGBM + XGBoost + LogReg + per-class
LightGBM specialists, blended by a small LogReg + isotonic calibration).
Artifacts go to scripts/simulation/artifacts/ensemble/."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

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
    TRAIN_END,
    VAL_END,
)
from .ensemble import EnsembleModel, weight_group
from .features import build_feature_matrix, feature_names

console = Console()

ENSEMBLE_DIR = ARTIFACTS_DIR / "ensemble"


def temporal_split(
    X: pd.DataFrame, y: pd.Series, meta: pd.DataFrame
) -> tuple[dict, dict, dict, dict]:
    """Train / val / test split by event_date, plus per-row weight-group
    assignment so the ensemble's specialists can pick their subset."""
    dt = pd.to_datetime(meta["event_date"])
    groups = meta["weight_class"].apply(weight_group).reset_index(drop=True)
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
    gs = {
        "train": groups.loc[train_mask].reset_index(drop=True),
        "val": groups.loc[val_mask].reset_index(drop=True),
        "test": groups.loc[test_mask].reset_index(drop=True),
    }
    console.log(
        f"split sizes — train {len(Xs['train']):,} · val {len(Xs['val']):,} · "
        f"test {len(Xs['test']):,}"
    )
    return Xs, ys, metas, gs


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
    pred = (probs >= 0.5).astype(int)
    out: dict[str, float] = {
        "n": int(len(y)),
        "accuracy": float(accuracy_score(y, pred)),
        "log_loss": float(log_loss(y, probs.clip(1e-4, 1 - 1e-4))),
        "brier": float(brier_score_loss(y, probs)),
        "roc_auc": float(roc_auc_score(y, probs)),
    }
    if market_prob_a is not None:
        m = market_prob_a.copy()
        m_mask = m.notna()
        if m_mask.any():
            m_clipped = m.loc[m_mask].clip(1e-4, 1 - 1e-4)
            y_m = y.loc[m_mask]
            m_pred = (m_clipped >= 0.5).astype(int)
            out["market_accuracy"] = float(accuracy_score(y_m, m_pred))
            out["market_log_loss"] = float(log_loss(y_m, m_clipped))
            out["market_brier"] = float(brier_score_loss(y_m, m_clipped))
            out["market_n"] = int(m_mask.sum())
    return out


def print_metrics_table(metrics: dict[str, dict[str, float]]) -> None:
    table = Table(title=f"Backtest — {MODEL_VERSION} (ensemble)")
    table.add_column("Split")
    table.add_column("N", justify="right")
    table.add_column("Acc", justify="right")
    table.add_column("LogLoss", justify="right")
    table.add_column("Brier", justify="right")
    table.add_column("AUC", justify="right")
    for name in ("train", "val", "test"):
        m = metrics[name]
        table.add_row(
            name,
            f"{m['n']:,}",
            f"{m['accuracy']:.3f}",
            f"{m['log_loss']:.3f}",
            f"{m['brier']:.3f}",
            f"{m['roc_auc']:.3f}",
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


def run_training(df: pd.DataFrame) -> dict[str, dict[str, float]]:
    X, y, meta = build_feature_matrix(df)
    cols = feature_names()
    X = X[cols]

    # meta needs weight_class for the splitter; build_feature_matrix
    # drops it, so pull from the source df via the bout_id join.
    meta = meta.merge(
        df[["bout_id", "weight_class"]], on="bout_id", how="left"
    )

    Xs, ys, metas, gs = temporal_split(X, y, meta)
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

    console.log("training ensemble (LGB + XGB + LogReg + per-class specialists)…")
    train_meta = ensemble.fit(
        X_train=Xs["train"],
        y_train=ys["train"],
        groups_train=gs["train"],
        X_val=Xs["val"],
        y_val=ys["val"],
        groups_val=gs["val"],
    )
    console.log(
        "blender coefs: "
        + " ".join(f"{k}={v:+.2f}" for k, v in train_meta["blender_coefs"].items())
        + f" · specialists trained: {train_meta['specialists']}"
    )

    # Headline blended metrics per split.
    metrics: dict[str, dict[str, float]] = {}
    for name in ("train", "val", "test"):
        probs = ensemble.predict_proba_a(Xs[name], gs[name])
        market = (
            df.loc[metas[name].index, "market_prob_a"]
            if "market_prob_a" in df.columns
            else None
        )
        metrics[name] = evaluate_probs(probs, ys[name], market)
    print_metrics_table(metrics)

    # Per-learner test performance so we see whether the ensemble is
    # actually pulling its weight vs the strongest single model.
    test_breakdown = ensemble.predict_proba_breakdown(Xs["test"], gs["test"])
    by_learner: dict[str, dict[str, float]] = {}
    for learner_name, probs in test_breakdown.items():
        by_learner[learner_name] = evaluate_probs(probs, ys["test"])
    print_breakdown_table(by_learner)

    # Persist artifacts.
    ENSEMBLE_DIR.mkdir(exist_ok=True)
    ensemble.save(ENSEMBLE_DIR)

    metadata = {
        "model_version": MODEL_VERSION,
        "model_kind": "ensemble",
        "trained_at": datetime.utcnow().isoformat() + "Z",
        "feature_columns": cols,
        "train_end": TRAIN_END,
        "val_end": VAL_END,
        "lgb_params": lgb_params,
        "blender": train_meta,
        "metrics": metrics,
        "test_breakdown_by_learner": {k: v for k, v in by_learner.items()},
        "n_train": int(len(Xs["train"])),
        "n_val": int(len(Xs["val"])),
        "n_test": int(len(Xs["test"])),
    }
    (ARTIFACTS_DIR / "metadata.json").write_text(
        json.dumps(metadata, indent=2, default=str)
    )
    console.log(
        f"saved ensemble to {ENSEMBLE_DIR.name}/ · metadata.json refreshed"
    )
    return metrics

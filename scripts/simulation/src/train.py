"""Train LightGBM with temporal split + isotonic calibration. Saves
artifacts to scripts/simulation/artifacts/."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from rich.console import Console
from rich.table import Table
from sklearn.isotonic import IsotonicRegression
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
from .features import build_feature_matrix, feature_names

console = Console()


def temporal_split(
    X: pd.DataFrame, y: pd.Series, meta: pd.DataFrame
) -> tuple[dict[str, pd.DataFrame], dict[str, pd.Series]]:
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


def train_lgb(
    X_train: pd.DataFrame, y_train: pd.Series, X_val: pd.DataFrame, y_val: pd.Series
) -> lgb.Booster:
    # Per-feature gain multiplier: <1 makes a feature pay more "gain
    # tax" before being split on, so its share of total SHAP shrinks
    # without us hand-removing it. Defaults to 1.0 for anything not in
    # the overrides map.
    feature_contri = [
        FEATURE_CONTRI_OVERRIDES.get(col, 1.0) for col in X_train.columns
    ]
    params = {**LGB_PARAMS, "feature_contri": feature_contri}
    dtrain = lgb.Dataset(X_train, label=y_train)
    dval = lgb.Dataset(X_val, label=y_val, reference=dtrain)
    booster = lgb.train(
        params,
        dtrain,
        num_boost_round=LGB_NUM_ROUNDS,
        valid_sets=[dtrain, dval],
        valid_names=["train", "val"],
        callbacks=[
            lgb.early_stopping(stopping_rounds=LGB_EARLY_STOPPING_ROUNDS, verbose=False),
            lgb.log_evaluation(period=100),
        ],
    )
    return booster


def fit_calibrator(booster: lgb.Booster, X_val: pd.DataFrame, y_val: pd.Series) -> IsotonicRegression:
    """Isotonic on validation. Maps raw LGB sigmoid prob → calibrated prob."""
    raw = booster.predict(X_val, num_iteration=booster.best_iteration)
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(raw, y_val)
    return iso


def evaluate(
    booster: lgb.Booster,
    iso: IsotonicRegression,
    X: pd.DataFrame,
    y: pd.Series,
    market_prob_a: pd.Series | None = None,
) -> dict[str, float]:
    raw = booster.predict(X, num_iteration=booster.best_iteration)
    cal = iso.transform(raw)
    pred = (cal >= 0.5).astype(int)
    out = {
        "n": int(len(y)),
        "accuracy": float(accuracy_score(y, pred)),
        "log_loss": float(log_loss(y, cal.clip(1e-4, 1 - 1e-4))),
        "brier": float(brier_score_loss(y, cal)),
        "roc_auc": float(roc_auc_score(y, cal)),
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
    table = Table(title=f"Backtest — {MODEL_VERSION}")
    table.add_column("Split")
    table.add_column("N", justify="right")
    table.add_column("Acc", justify="right")
    table.add_column("LogLoss", justify="right")
    table.add_column("Brier", justify="right")
    table.add_column("AUC", justify="right")
    table.add_column("Mkt Acc", justify="right")
    table.add_column("Mkt LogLoss", justify="right")
    for name in ("train", "val", "test"):
        m = metrics[name]
        table.add_row(
            name,
            f"{m['n']:,}",
            f"{m['accuracy']:.3f}",
            f"{m['log_loss']:.3f}",
            f"{m['brier']:.3f}",
            f"{m['roc_auc']:.3f}",
            f"{m.get('market_accuracy', float('nan')):.3f}" if "market_accuracy" in m else "—",
            f"{m.get('market_log_loss', float('nan')):.3f}" if "market_log_loss" in m else "—",
        )
    console.print(table)


def run_training(df: pd.DataFrame) -> dict[str, dict[str, float]]:
    X, y, meta = build_feature_matrix(df)
    # Lock column order so predict.py can rebuild identical feature
    # arrays for one-off bouts.
    cols = feature_names()
    X = X[cols]
    Xs, ys, metas = temporal_split(X, y, meta)

    if len(Xs["train"]) == 0 or len(Xs["val"]) == 0:
        raise RuntimeError(
            "Empty train or val split. Check TRAIN_END / VAL_END vs your data range."
        )

    console.log(f"training LightGBM with {len(cols)} features…")
    booster = train_lgb(Xs["train"], ys["train"], Xs["val"], ys["val"])
    console.log(
        f"best_iteration={booster.best_iteration} of {LGB_NUM_ROUNDS} (early stop on val)"
    )

    iso = fit_calibrator(booster, Xs["val"], ys["val"])

    metrics: dict[str, dict[str, float]] = {}
    for name in ("train", "val", "test"):
        market = (
            df.loc[metas[name].index, "market_prob_a"]
            if "market_prob_a" in df.columns
            else None
        )
        metrics[name] = evaluate(booster, iso, Xs[name], ys[name], market)
    print_metrics_table(metrics)

    # Persist artifacts.
    model_path = ARTIFACTS_DIR / "model.lgb"
    iso_path = ARTIFACTS_DIR / "calibrator.pkl"
    meta_path = ARTIFACTS_DIR / "metadata.json"
    booster.save_model(str(model_path), num_iteration=booster.best_iteration)
    joblib.dump(iso, iso_path)
    metadata = {
        "model_version": MODEL_VERSION,
        "trained_at": datetime.utcnow().isoformat() + "Z",
        "feature_columns": cols,
        "train_end": TRAIN_END,
        "val_end": VAL_END,
        "best_iteration": booster.best_iteration,
        "params": LGB_PARAMS,
        "metrics": metrics,
        "n_train": int(len(Xs["train"])),
        "n_val": int(len(Xs["val"])),
        "n_test": int(len(Xs["test"])),
    }
    Path(meta_path).write_text(json.dumps(metadata, indent=2, default=str))
    console.log(f"saved: {model_path.name} · {iso_path.name} · {meta_path.name}")
    return metrics

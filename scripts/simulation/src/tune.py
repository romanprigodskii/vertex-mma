"""Optuna hyperparameter search for the LightGBM bout-winner model.

Strategy:
  * Use the same temporal split as production (train ≤ TRAIN_END,
    val [TRAIN_END, VAL_END), test ≥ VAL_END).
  * Optimize validation log-loss — better-calibrated than accuracy and
    less noisy on our split sizes (~400 val bouts).
  * Cap rounds at 1500 with early stopping (100 rounds) so each trial
    finishes in seconds; ~100 trials runs in ~3 min on a laptop.
  * Apply the same FEATURE_CONTRI_OVERRIDES as production so the
    tuned params live in a consistent search space.

After the study finishes the best params are written to
artifacts/best_params.json. train.py reads that file (if present) and
merges over LGB_PARAMS — meaning a fresh `python scripts/run_train.py`
automatically picks up tuned params next training run.
"""

from __future__ import annotations

import json
from typing import Any

import lightgbm as lgb
import numpy as np
import optuna
import pandas as pd
from optuna.samplers import TPESampler
from rich.console import Console

from .config import ARTIFACTS_DIR, FEATURE_CONTRI_OVERRIDES, TRAIN_END, VAL_END

console = Console()

# Number of boosting rounds capped per trial. We rely on early stopping
# on val, so this is just a safety ceiling; most trials converge in
# 50–200 iterations.
MAX_ROUNDS_PER_TRIAL = 1500
EARLY_STOPPING_ROUNDS_TRIAL = 100


def _temporal_split(
    X: pd.DataFrame, y: pd.Series, dt: pd.Series
) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame, pd.Series]:
    train_end = pd.to_datetime(TRAIN_END)
    val_end = pd.to_datetime(VAL_END)
    train_mask = dt < train_end
    val_mask = (dt >= train_end) & (dt < val_end)
    return (
        X.loc[train_mask].reset_index(drop=True),
        y.loc[train_mask].reset_index(drop=True),
        X.loc[val_mask].reset_index(drop=True),
        y.loc[val_mask].reset_index(drop=True),
    )


def make_objective(X: pd.DataFrame, y: pd.Series, dt: pd.Series):
    X_train, y_train, X_val, y_val = _temporal_split(X, y, dt)
    feature_contri = [FEATURE_CONTRI_OVERRIDES.get(col, 1.0) for col in X.columns]

    def objective(trial: optuna.Trial) -> float:
        params = {
            "objective": "binary",
            "metric": "binary_logloss",
            "verbosity": -1,
            "feature_contri": feature_contri,
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.1, log=True),
            "num_leaves": trial.suggest_int("num_leaves", 8, 127),
            "max_depth": trial.suggest_int("max_depth", 3, 12),
            "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 20, 200),
            "feature_fraction": trial.suggest_float("feature_fraction", 0.5, 1.0),
            "bagging_fraction": trial.suggest_float("bagging_fraction", 0.5, 1.0),
            "bagging_freq": trial.suggest_int("bagging_freq", 1, 10),
            "lambda_l1": trial.suggest_float("lambda_l1", 1e-3, 10.0, log=True),
            "lambda_l2": trial.suggest_float("lambda_l2", 1e-3, 10.0, log=True),
            "min_gain_to_split": trial.suggest_float("min_gain_to_split", 0.0, 0.2),
        }
        dtrain = lgb.Dataset(X_train, label=y_train)
        dval = lgb.Dataset(X_val, label=y_val, reference=dtrain)
        booster = lgb.train(
            params,
            dtrain,
            num_boost_round=MAX_ROUNDS_PER_TRIAL,
            valid_sets=[dval],
            valid_names=["val"],
            callbacks=[
                lgb.early_stopping(stopping_rounds=EARLY_STOPPING_ROUNDS_TRIAL, verbose=False),
            ],
        )
        return booster.best_score["val"]["binary_logloss"]

    return objective


def run_tuning(df: pd.DataFrame, n_trials: int = 100) -> dict[str, Any]:
    """Run Optuna search. Returns the best param dict and writes it
    to artifacts/best_params.json so train.py picks it up automatically."""
    from .features import build_feature_matrix, feature_names

    X, y, meta = build_feature_matrix(df)
    X = X[feature_names()]
    dt = pd.to_datetime(meta["event_date"])

    sampler = TPESampler(seed=42)
    study = optuna.create_study(direction="minimize", sampler=sampler)
    objective = make_objective(X, y, dt)

    console.log(
        f"starting Optuna search · {n_trials} trials · val={(dt >= pd.to_datetime(TRAIN_END)).sum()} bouts"
    )
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)

    best = study.best_trial
    console.log(
        f"best val log-loss = {best.value:.4f} (trial #{best.number}) · "
        f"baseline ~0.63 = pure-noise floor"
    )
    out_path = ARTIFACTS_DIR / "best_params.json"
    payload = {
        "best_value": float(best.value),
        "best_trial_number": best.number,
        "best_params": best.params,
        "n_trials": n_trials,
    }
    out_path.write_text(json.dumps(payload, indent=2))
    console.log(f"saved tuned params → {out_path.name}")
    return best.params

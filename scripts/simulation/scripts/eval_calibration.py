"""Calibration experiment — does re-calibrating the blended model beat the
current (no-calibrator) setup on the HELD-OUT test split?

The ensemble deliberately ships no post-blender calibrator (fitting isotonic on
the ~430-row val set double-dipped noise and pushed test log-loss 0.65 → 0.72).
Before changing that, this measures, on TEST: ECE / Brier / log-loss for
  - current (uncalibrated blend)
  - temperature scaling (1 param, fit on val)
  - Platt scaling (2 params: scale+bias on the logit, fit on val)
  - isotonic (fit on val)
Calibrators are fit ONLY on val (held out from base-learner training); train
probs are in-sample and unsound to calibrate on. A candidate is worth shipping
only if it clearly beats "current" on test — otherwise leave the model alone.

No retrain, no artifact writes.  Usage (scripts/simulation, venv active):
  python scripts/eval_calibration.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import brier_score_loss, log_loss  # noqa: E402

from src.config import ARTIFACTS_DIR  # noqa: E402
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.train import temporal_split  # noqa: E402

# Evaluate the EVAL (split-trained) model so val/test are genuinely out-of-
# sample — the served artifacts/ensemble/ is refit on ALL data, so calibrating
# against its test split would be in-sample. Fall back to the served model only
# if the eval model is absent.
_EVAL_DIR = ARTIFACTS_DIR / "ensemble_eval"
ENSEMBLE_DIR = _EVAL_DIR if _EVAL_DIR.exists() else ARTIFACTS_DIR / "ensemble"
EPS = 1e-6


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-z))


def ece(probs: np.ndarray, y: np.ndarray, n_bins: int = 10) -> float:
    """Expected Calibration Error — Σ (n_b/N)·|mean_pred − mean_actual|."""
    edges = np.linspace(0, 1, n_bins + 1)
    total = 0.0
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        sel = (probs >= lo) & (probs < hi if i < n_bins - 1 else probs <= hi)
        if sel.sum() == 0:
            continue
        total += (sel.sum() / len(probs)) * abs(probs[sel].mean() - y[sel].mean())
    return total


def report(name: str, probs: np.ndarray, y: np.ndarray) -> None:
    probs = np.clip(probs, EPS, 1 - EPS)
    print(
        f"{name:24s} ece {ece(probs, y):.4f}   brier {brier_score_loss(y, probs):.4f}   "
        f"logloss {log_loss(y, probs):.4f}"
    )


def fit_temperature(p_val: np.ndarray, y_val: np.ndarray) -> float:
    """1-param temperature on the logit, grid + refine on val log-loss."""
    z = logit(p_val)
    best_t, best_ll = 1.0, 1e9
    for t in np.concatenate([np.linspace(0.5, 3.0, 51), np.linspace(0.6, 1.6, 101)]):
        ll = log_loss(y_val, np.clip(sigmoid(z / t), EPS, 1 - EPS))
        if ll < best_ll:
            best_ll, best_t = ll, float(t)
    return best_t


def main() -> None:
    df = symmetrize_for_training(build_dataset(fetch_raw()))
    X, y, meta = build_feature_matrix(df)
    X = X[feature_names()]
    meta = meta.merge(df[["bout_id", "weight_class"]], on="bout_id", how="left")
    Xs, ys, metas, gs = temporal_split(X, y, meta)

    ens = EnsembleModel.load(ENSEMBLE_DIR)
    # predict_proba_a applies the (currently None) calibrator → this IS the
    # uncalibrated blended prob.
    p_val = ens.predict_proba_a(Xs["val"], gs["val"])
    p_test = ens.predict_proba_a(Xs["test"], gs["test"])
    y_val = ys["val"].to_numpy().astype(int)
    y_test = ys["test"].to_numpy().astype(int)

    print(f"\n=== CALIBRATION on TEST (val n={len(y_val)}, test n={len(y_test)}) ===")
    report("current (none)", p_test, y_test)

    # Temperature (1 param)
    t = fit_temperature(p_val, y_val)
    report(f"temperature (T={t:.3f})", sigmoid(logit(p_test) / t), y_test)

    # Platt (LogReg on the logit: scale + bias)
    platt = LogisticRegression(C=1e6, solver="lbfgs")
    platt.fit(logit(p_val).reshape(-1, 1), y_val)
    report("platt (logit)", platt.predict_proba(logit(p_test).reshape(-1, 1))[:, 1], y_test)

    # Isotonic (non-parametric, fit on val)
    iso = IsotonicRegression(out_of_bounds="clip")
    iso.fit(p_val, y_val)
    report("isotonic", iso.predict(p_test), y_test)

    # Reliability of current vs best, mid-range focus.
    print("\n=== reliability (current) — pred vs actual by decile (test) ===")
    edges = np.linspace(0, 1, 11)
    for i in range(10):
        lo, hi = edges[i], edges[i + 1]
        sel = (p_test >= lo) & (p_test < hi if i < 9 else p_test <= hi)
        if sel.sum() == 0:
            continue
        print(
            f"  {lo:.1f}-{hi:.1f}  n={int(sel.sum()):4d}  pred {p_test[sel].mean()*100:5.1f}%  "
            f"actual {y_test[sel].mean()*100:5.1f}%"
        )


if __name__ == "__main__":
    main()

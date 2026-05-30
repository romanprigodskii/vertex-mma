"""Static config — paths, model version, training hyperparameters."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = PACKAGE_ROOT / "artifacts"
DATA_DIR = PACKAGE_ROOT / "data"

ARTIFACTS_DIR.mkdir(exist_ok=True)
DATA_DIR.mkdir(exist_ok=True)

# Bumped on every retrain. Stored alongside each prediction so the UI can
# distinguish "made by old model" vs "fresh prediction" and a future
# version can do clean side-by-side comparison.
MODEL_VERSION = "v0.1.0"

# Temporal split anchors. Bouts strictly before TRAIN_END go into training,
# bouts in [TRAIN_END, VAL_END) into validation (used for early-stopping
# and calibration fitting), bouts on or after VAL_END into the held-out
# test set we report metrics on. Updated when we retrain.
TRAIN_END = "2024-01-01"
VAL_END = "2025-01-01"

LGB_PARAMS = {
    "objective": "binary",
    "metric": ["binary_logloss", "auc"],
    "learning_rate": 0.03,
    "num_leaves": 31,
    "min_data_in_leaf": 50,
    "feature_fraction": 0.85,
    "bagging_fraction": 0.85,
    "bagging_freq": 5,
    "lambda_l2": 1.0,
    "verbosity": -1,
}
LGB_NUM_ROUNDS = 2000
LGB_EARLY_STOPPING_ROUNDS = 100

# Confidence bands derived from |prob - 0.5|.
#   low    : 0.50 - 0.58  (toss-up to slight lean)
#   medium : 0.58 - 0.68  (clear favorite)
#   high   : 0.68+        (heavy favorite)
CONFIDENCE_BANDS = (
    ("low", 0.0, 0.08),
    ("medium", 0.08, 0.18),
    ("high", 0.18, 1.0),
)


def confidence_label(prob_favorite: float) -> str:
    margin = abs(prob_favorite - 0.5)
    for label, lo, hi in CONFIDENCE_BANDS:
        if lo <= margin < hi:
            return label
    return "high"

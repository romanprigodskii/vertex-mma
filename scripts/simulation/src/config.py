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
MODEL_VERSION = "v0.14.0"

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
    # Reproducibility: `seed` pins every sub-seed (bagging / feature
    # sampling), and `deterministic` + `force_row_wise` make histogram
    # construction independent of thread scheduling. Without these, bagging
    # (bagging_fraction < 1) drew fresh randomness each run, so retraining the
    # SAME data produced a different model and metadata.json was unreproducible.
    "seed": 42,
    "deterministic": True,
    "force_row_wise": True,
}
LGB_NUM_ROUNDS = 2000
LGB_EARLY_STOPPING_ROUNDS = 100

# Per-feature gain multiplier passed to LightGBM via `feature_contri`.
# 1.0 = treat normally, <1.0 = the model has to find more lift to justify
# splitting on it, effectively reducing its share of total SHAP. Used
# only on features that the baseline model leans on too hard relative
# to their real-world signal (currently age — Phase 2 audit showed
# diff_age as the #1 attribution in almost every upcoming bout, which
# overstates a feature that's already partly redundant with vertex_score
# and recent_form).
FEATURE_CONTRI_OVERRIDES: dict[str, float] = {
    "diff_age": 0.45,
    "abs_age_a": 0.5,
    "abs_age_b": 0.5,
}

# v0.13.0 — post-blend residual correction (src/ensemble.py ResidualCorrector),
# attached by train.py to both the served and eval models.
#
# One coefficient: the blend under-uses the age difference in a measurable,
# one-directional way. The winner-batch lab (docs/winner_batch.md) found it
# gives a 35-year-old facing a 28-year-old a 0.371 chance where the truth is
# 0.164, and — importantly — that RAISING the throttle above does not fix it.
# The signal is present and diluted, not absent, so the fix belongs after the
# blend rather than inside it. Fitted on 3,087 walk-forward OOF bouts:
#   cross-fitted OOF -0.0026 (97 % of bootstraps), forward split (fit pre-2022,
#   score after) -0.0029 (94 %), held-out test -0.0054 (97 %).
#
# `scale` keeps the coefficient readable: -0.2939 per TEN years of age
# advantage, i.e. about -0.03 logits per year. No intercept and an (A − B)
# input, so the correction negates on a side swap and composes cleanly with
# the order averaging in predict.py.
#
# A SECOND term — fighter nationality — was built, gated and REFUSED. The
# block below documents it because the data and the plumbing shipped even
# though the coefficient did not: `features.CORRECTOR_COLUMNS` carries
# `diff_is_american`, `export.FIGHTERS_SQL` reads it, and
# `fighter.sherdog_flag_code` is filled. Same reasoning that kept
# `regional_export.py` and `USE_SUB_AXIS` after their labs failed — building
# the data is the expensive part.
#
# The bias it targets is real: the blend has a directional error no monotone
# map can reach.
# On the walk-forward pool the American side is given about 8 pp more than
# it gets, in every era:
#
#   A American, B not   n=485   model 0.4927   actual 0.4124   +0.0804
#   B American, A not   n=551   model 0.5165   actual 0.5644   -0.0479
#
# The mechanism is NOT travel and NOT crowd: an event-geography version
# (home vs away venue) is dominated by the plain citizenship indicator, so
# read this as a roster-composition bias and do not send the next lab
# scraping altitudes.
#
# The first attempt at this FAILED (docs/accuracy_batch.md §2). It was
# fitted on `fighter.country_code`, which is Wikidata-sourced and covers
# 71 % of the fit pool but only 42 % of the held-out window — so it was
# fitted where it was visible and scored where it was not, and the third
# leg came back +0.0017. Read off `fighter.sherdog_flag_code` instead
# (99 % of the test window) all three legs agree:
#   cross-fit -0.0015, forward -0.0020, held-out -0.0013, incremental over
#   the age term alone. Joint held-out delta -0.0066 against -0.0053 for
#   age by itself.
#
# Both coefficients are fitted JOINTLY and must be refit together — age
# moves from -0.2939 to -0.2731 when nationality is in the block, because
# the two are not quite orthogonal.
#
# `diff_is_american` is in features.CORRECTOR_COLUMNS, i.e. it is built
# into the serving matrix but is NOT in feature_names(): the learners must
# never see it. That is the whole mechanism — §6 of winner_batch.md showed
# the correction works precisely because nothing competes with it.
#
# Set to None to serve uncorrected. REFIT when the recipe changes:
#   python scripts/lab_winner_batch.py --stage oof --arms baseline --cache
#   python scripts/lab_accuracy_batch.py --stage nat --cache \
#       --nat-source sherdog_flag_code
# NOT SHIPPED, and the reason is the fourth basis. The three-leg gate above
# passed. The ROLLING backtest — production semantics, per-origin refit, the
# basis winner_batch.md §8 reported when v0.13.0 shipped — disagrees:
#
#   arm                 all (n=417)   odds subset (n=394)
#   uncorrected             0.62384               0.61989
#   age only                0.61676               0.61150
#   age + nationality       0.61894               0.61241
#
# +0.0022 against age alone, where the other three bases said -0.0013 to
# -0.0020. Every one of those numbers is under the detection floor measured
# in docs/accuracy_batch.md §0 (one-sided 80% MDE 0.0036), so the honest
# reading is not "three bases beat one" — it is that nothing here is
# resolved, and a term whose sign flips between bases is not shippable.
#
# There is also a mechanism that would explain the rolling sign: the
# coefficients are fitted on walk-forward models trained on LESS data than
# the rolling ones, which is the same reason `slope` is pinned to 1.0. A
# correction sized for a weaker model can overshoot a stronger one.
#
# Reproduce:
#   python scripts/run_rolling_backtest.py --cache --corrector-terms diff_age
#   python scripts/run_rolling_backtest.py --cache
#
# RESIDUAL_CORRECTION_NATIONALITY = {
#     "terms": [
#         {"column": "diff_age", "weight": -0.2731, "scale": 10.0},
#         {"column": "diff_is_american", "weight": -0.1900, "scale": 1.0},
#     ],
#     "slope": 1.0,
# }
RESIDUAL_CORRECTION: dict | None = {
    "terms": [{"column": "diff_age", "weight": -0.2939, "scale": 10.0}],
    "slope": 1.0,
}

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

"""Convert the per-bout A/B feature row into model-ready feature vectors.

We use DIFFERENCES (A - B) as the primary signal — the model is then
inherently symmetric (training on the same bout flipped just negates
the features and the target, so we don't need to augment). A handful of
context features (weight class, title fight, market prob) stay unflipped.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Numeric per-fighter columns where "A minus B" is the right signal.
DIFF_COLUMNS = [
    "height",
    "reach",
    "age",
    "prior_bouts",
    "prior_wins",
    "prior_losses",
    "prior_win_rate",
    "prior_finish_rate",
    "prior_wins_ko",
    "prior_wins_sub",
    "prior_wins_dec",
    "prior_losses_ko",
    "prior_losses_sub",
    "prior_losses_dec",
    "slpm",
    "sapm",
    "str_acc",
    "td_per15",
    "td_acc",
    "td_def",
    "sub_per15",
    "kd_per_fight",
    "control_per_min",
    "title_bouts",
    "layoff_days",
    "recent3_wins",
    "recent5_wins",
    "vertex_score",
    "vertex_score_all_time",
]

# Per-fighter columns we ALSO keep as-is for A and B (sometimes absolute
# level matters, not just the gap — e.g. both fighters being 38 years old
# is different from both being 28).
ABSOLUTE_KEEP = [
    "age",
    "vertex_score",
    "vertex_score_all_time",
    "layoff_days",
    "prior_bouts",
]

CONTEXT_COLUMNS = [
    "is_title_fight",
    "is_main_event",
    "scheduled_rounds",
    "weight_class",
    "stance_a",
    "stance_b",
    "market_prob_a",
]


def build_feature_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    """Return (X, y, meta) where meta keeps bout_id + event_date for
    temporal splitting / joining predictions back to the DB."""
    out: dict[str, pd.Series] = {}

    # A - B diffs.
    for col in DIFF_COLUMNS:
        a = pd.to_numeric(df[f"{col}_a"], errors="coerce")
        b = pd.to_numeric(df[f"{col}_b"], errors="coerce")
        out[f"diff_{col}"] = a - b

    # Absolute levels kept for both sides.
    for col in ABSOLUTE_KEEP:
        out[f"abs_{col}_a"] = pd.to_numeric(df[f"{col}_a"], errors="coerce")
        out[f"abs_{col}_b"] = pd.to_numeric(df[f"{col}_b"], errors="coerce")

    # Context.
    out["is_title_fight"] = df["is_title_fight"].astype("int8")
    out["is_main_event"] = df["is_main_event"].astype("int8")
    out["scheduled_rounds"] = df["scheduled_rounds"].astype("int8")
    out["market_prob_a"] = pd.to_numeric(df["market_prob_a"], errors="coerce")
    # market_log_odds — gives the model a nicer scaled view of the line.
    p = out["market_prob_a"].clip(1e-4, 1 - 1e-4)
    out["market_log_odds"] = np.log(p / (1 - p))

    # Categorical: one-hot for stance pairing and weight class (keep small).
    for col_name in ("stance_a", "stance_b"):
        cat = df[col_name].fillna("unknown").astype(str)
        for val in ("orthodox", "southpaw", "switch"):
            out[f"{col_name}_{val}"] = (cat == val).astype("int8")

    weight_cat = df["weight_class"].fillna("unknown").astype(str)
    for wc in (
        "strawweight",
        "flyweight",
        "bantamweight",
        "featherweight",
        "lightweight",
        "welterweight",
        "middleweight",
        "light_heavyweight",
        "heavyweight",
    ):
        out[f"wc_{wc}"] = (weight_cat == wc).astype("int8")

    X = pd.DataFrame(out)
    y = df["target_a_wins"].astype("int8")
    meta = df[["bout_id", "event_id", "event_date", "fighter_a_id", "fighter_b_id"]].copy()
    return X, y, meta


def feature_names() -> list[str]:
    """Stable column order — useful when serving the model against a
    single row at predict time."""
    cols: list[str] = []
    cols += [f"diff_{c}" for c in DIFF_COLUMNS]
    for c in ABSOLUTE_KEEP:
        cols += [f"abs_{c}_a", f"abs_{c}_b"]
    cols += [
        "is_title_fight",
        "is_main_event",
        "scheduled_rounds",
        "market_prob_a",
        "market_log_odds",
    ]
    for side in ("stance_a", "stance_b"):
        cols += [f"{side}_orthodox", f"{side}_southpaw", f"{side}_switch"]
    cols += [
        "wc_strawweight",
        "wc_flyweight",
        "wc_bantamweight",
        "wc_featherweight",
        "wc_lightweight",
        "wc_welterweight",
        "wc_middleweight",
        "wc_light_heavyweight",
        "wc_heavyweight",
    ]
    return cols

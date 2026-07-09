"""Convert the per-bout A/B feature row into model-ready feature vectors.

We use DIFFERENCES (A - B) as the primary signal — the model is then
inherently symmetric (training on the same bout flipped just negates
the features and the target, so we don't need to augment). A handful of
context features (weight class, title fight) stay unflipped.

NOTE: the sportsbook line (market_prob_a / market_log_odds) is deliberately
NOT a model feature. The scraped line is the CLOSING line — a near-leak in
backtest and absent for most upcoming bouts at predict time (train/serve
skew) — and letting the LogReg learner echo it made "beats the market" a
circular claim. market_prob_a still rides along on `meta` so predict.py can
compute the edge (model_prob - market_prob) and so train.py can score the
model against the market on the SAME bouts, but the model never sees it.
"""

from __future__ import annotations

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
    # Phase 4 — only the high-signal additions kept. Strike location
    # shares + reversals + control absorbed were tried first and hurt
    # val log-loss (noisy on a 5,400-bout train, model latched onto
    # quirks). Survived the cull:
    #   * current_streak — momentum signal, hard to redundantly derive
    #     from prior_wins/losses alone.
    #   * finish_against_per_bout — durability proxy that's NOT a ratio
    #     (ratio is noisy when prior_losses is small).
    #   * avg_bout_seconds — distinguishes grinders from finishers
    #     better than prior_finish_rate alone.
    "current_streak",
    "finish_against_per_bout",
    "avg_bout_seconds",
    # v0.6.0 — validated on the 2025-07..2026-07 rolling backtest:
    #   * durability trio (kd_absorbed / control_absorbed / reversals) —
    #     the only culled-feature group that improved val AND test
    #     log-loss/brier/AUC together (rolling log-loss 0.639 → 0.633,
    #     AUC 0.693 → 0.703), stable across seeds.
    #   * elo — point-in-time K=32 rating from export.py's walk;
    #     aggregates strength-of-schedule the career averages miss
    #     (+~1pp pick accuracy, flips near-0.5 calls).
    "kd_absorbed_per_fight",
    "control_absorbed_per_min",
    "reversals_per_fight",
    "elo",
    # v0.7.0 — opponent-adjusted ratings (src/opponent_ratings.py), the
    # combo validated in the v0.7 lab: online attack/defense skill ratings
    # (deviation from league mean, opponent-adjusted bout by bout — fixes
    # the "5 strikes/min vs elite defense == 5 vs journeymen" blindness of
    # raw career averages) + opponent-quality Elo aggregates (WHO the
    # record was compiled against). Diffs only — abs levels added nothing.
    "str_off",
    "str_def",
    "grap_off",
    "grap_def",
    "kd_off",
    "kd_def",
    "ctrl_off",
    "ctrl_def",
    "avg_opp_elo_career",
    "avg_opp_elo_last5",
    "max_opp_elo_beaten",
    "avg_opp_elo_beaten",
    "sos_weighted_winrate",
    # v0.9.0 — pre-UFC career record (Sherdog, non-UFC fights strictly
    # before the bout date). The debut segment's information gap fix:
    # bookmakers price a debutant's 15-0 regional record, we saw NaN.
    # Also fills in 1-2-UFC-fight fighters whose UFC-only career columns
    # are near-empty. NaN when the fighter has no verified Sherdog match
    # (see sherdog_matched flags); real zeros for matched fighters who
    # genuinely debuted with no regional record.
    "preufc_bouts",
    "preufc_wins",
    "preufc_losses",
    "preufc_win_rate",
    "preufc_ko_rate",
    "preufc_sub_rate",
    "preufc_finish_rate",
    "preufc_finish_losses",
    "preufc_career_days",
    # Recency/trajectory/pedigree — the record alone barely separates
    # debutants (every signee arrives ~10-2); when and where they fought
    # is the sharper half of the signal (real layoff for debutants whose
    # UFC layoff_days is NaN, activity, form, Contender Series vetting,
    # finish speed).
    "preufc_days_since_last",
    "preufc_fights_last_24mo",
    "preufc_last3_wins",
    "preufc_dwcs_fights",
    "preufc_avg_win_seconds",
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
    "current_streak",
    "kd_per_fight",
    "kd_absorbed_per_fight",
    # Absolute Elo levels carry signal the diff loses (a 1600-vs-1570
    # matchup reads differently from 1450-vs-1420 — division strength,
    # depth of résumé).
    "elo",
    # v0.9.0 — absolute pre-UFC volume/quality: a 20-fight regional vet
    # vs a 4-fight prospect matters even when the diff is the same; the
    # absolute regional layoff is a debutant's only real layoff signal.
    "preufc_bouts",
    "preufc_win_rate",
    "preufc_days_since_last",
]

# Context features kept as-is (not differenced). market_prob_a is NOT here:
# it is comparison-only (see module docstring), carried on `meta`, not `X`.
CONTEXT_COLUMNS = [
    "is_title_fight",
    "is_main_event",
    "scheduled_rounds",
    "weight_class",
    "stance_a",
    "stance_b",
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
    # Debut flags (v0.8.0) — consumed only by the debut specialist
    # (debut_feature_names()); the main model's feature list excludes them.
    # Rows without the columns (custom sims — both fighters always have
    # history there) default to 0. They swap correctly as an _a/_b pair.
    # sherdog_matched flags (v0.9.0) — "pre-UFC columns are real zeros vs
    # unknown": a matched fighter with no regional fights is signal, an
    # unmatched fighter is missing data. Same guard for column-less rows.
    for flag in ("is_debut_a", "is_debut_b", "sherdog_matched_a", "sherdog_matched_b"):
        out[flag] = (
            df[flag].fillna(False).astype("int8")
            if flag in df.columns
            else pd.Series(0, index=df.index, dtype="int8")
        )
    # Women's divisions differ in pace / finish rates — give the model the flag
    # (was fetched but never used). Default to men's when gender is missing.
    gender = df["gender"].fillna("male").astype(str) if "gender" in df.columns else "male"
    out["is_womens"] = (gender == "female").astype("int8")
    # market_prob_a / market_log_odds intentionally omitted — see module
    # docstring. The market line is comparison-only and rides on `meta` below.

    # Categorical: one-hot for stance pairing and weight class (keep small).
    for col_name in ("stance_a", "stance_b"):
        cat = df[col_name].fillna("unknown").astype(str)
        for val in ("orthodox", "southpaw", "switch"):
            out[f"{col_name}_{val}"] = (cat == val).astype("int8")

    # Interaction features — small set, each one a known MMA-signal
    # asymmetry that LightGBM finds harder to discover from raw inputs.
    stance_a = df["stance_a"].fillna("unknown").astype(str)
    stance_b = df["stance_b"].fillna("unknown").astype(str)
    # Orthodox-vs-southpaw is the classic asymmetric matchup (different
    # power-side angles); flagged here so the model gets one feature
    # that already encodes the pairing.
    out["stance_asymmetry"] = (
        ((stance_a == "orthodox") & (stance_b == "southpaw"))
        | ((stance_a == "southpaw") & (stance_b == "orthodox"))
    ).astype("int8")
    # Reach-to-height ratio gap — wingspan advantage decoupled from
    # raw reach gap, so a tall fighter with average reach reads
    # differently from a short fighter with freakish reach.
    h_a = pd.to_numeric(df["height_a"], errors="coerce")
    h_b = pd.to_numeric(df["height_b"], errors="coerce")
    r_a = pd.to_numeric(df["reach_a"], errors="coerce")
    r_b = pd.to_numeric(df["reach_b"], errors="coerce")
    out["reach_height_ratio_diff"] = (r_a / h_a) - (r_b / h_b)
    # Age curve: distance from 30 (typical MMA peak), squared so both
    # very young (skill not yet locked) and very old (athleticism faded)
    # read as negative signal. Scaled down so LightGBM doesn't treat it
    # as a high-cardinality feature.
    age_a = pd.to_numeric(df["age_a"], errors="coerce")
    age_b = pd.to_numeric(df["age_b"], errors="coerce")
    out["age_curve_diff"] = (((age_b - 30) ** 2 - (age_a - 30) ** 2) / 100).astype("float32")

    weight_cat = df["weight_class"].fillna("unknown").astype(str)
    _STD_WC = (
        "strawweight",
        "flyweight",
        "bantamweight",
        "featherweight",
        "lightweight",
        "welterweight",
        "middleweight",
        "light_heavyweight",
        "heavyweight",
    )
    for wc in _STD_WC:
        out[f"wc_{wc}"] = (weight_cat == wc).astype("int8")
    # catchweight / openweight / unknown fall through every one-hot above → all
    # zeros, indistinguishable from a missing class. Flag them so the model can
    # treat those (often short-notice / heavy) bouts differently.
    out["wc_other"] = (~weight_cat.isin(_STD_WC)).astype("int8")

    X = pd.DataFrame(out)
    y = df["target_a_wins"].astype("int8")
    # market_prob_a travels on `meta` (NOT `X`) so it stays positionally
    # aligned with each temporal split for the honest model-vs-market
    # comparison and the predict.py edge, without ever entering the model.
    meta_cols = ["bout_id", "event_id", "event_date", "fighter_a_id", "fighter_b_id"]
    if "market_prob_a" in df.columns:
        meta_cols.append("market_prob_a")
    meta = df[meta_cols].copy()
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
        "is_womens",
        # v0.9.0 — data-availability flags for the pre-UFC columns (real
        # zeros vs unknown). In both models, not just the specialist:
        # low-experience non-debut fighters benefit the same way.
        "sherdog_matched_a",
        "sherdog_matched_b",
    ]
    for side in ("stance_a", "stance_b"):
        cols += [f"{side}_orthodox", f"{side}_southpaw", f"{side}_switch"]
    cols += [
        "stance_asymmetry",
        "reach_height_ratio_diff",
        "age_curve_diff",
    ]
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
        "wc_other",
    ]
    return cols


def debut_feature_names() -> list[str]:
    """Feature list for the DEBUT SPECIALIST (v0.8.0): the main model's
    columns plus the per-side debut flags. The debutant side's career
    columns arrive as NaN (LGB/XGB consume them natively; the LogReg leg
    mean-imputes from train), so the flags let the model tell "unknown
    because debut" apart from ordinary missingness."""
    return feature_names() + ["is_debut_a", "is_debut_b"]

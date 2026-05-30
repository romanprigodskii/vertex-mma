"""Inference runner — scores upcoming UFC bouts.

Three things get written per bout:

  1. bout_simulation                  — calibrated ensemble winner prob
  2. bout_simulation_features         — top-N SHAP attributions (Phase 2,
                                        sourced from the ensemble's
                                        global LightGBM — interpretable)
  3. bout_simulation_rounds           — Monte Carlo method × round (Phase 3)

Re-running for the same (bout_id, model_version) is an UPSERT so the
cron can be invoked multiple times safely (idempotent)."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
from psycopg.types.json import Jsonb
from rich.console import Console

from .config import ARTIFACTS_DIR, confidence_label
from .db import get_connection
from .ensemble import EnsembleModel, weight_group
from .export import build_dataset, fetch_raw
from .features import build_feature_matrix
from .monte_carlo import FighterMC, simulate_bout

console = Console()

# Number of top features (by |shap|) we persist per bout. The UI shows
# at most ~5, but keeping a couple extras gives Phase 3 / debug
# inspection room without re-running the model.
TOP_N_FEATURES = 8

ENSEMBLE_DIR = ARTIFACTS_DIR / "ensemble"


class LoadedModel:
    def __init__(self) -> None:
        meta_path = ARTIFACTS_DIR / "metadata.json"
        if not meta_path.exists() or not ENSEMBLE_DIR.exists():
            raise RuntimeError(
                "Trained ensemble artifacts missing. Run scripts/run_train.py first."
            )
        self.metadata = json.loads(meta_path.read_text())
        self.ensemble = EnsembleModel.load(ENSEMBLE_DIR)
        self.feature_columns: list[str] = self.metadata["feature_columns"]
        self.model_version: str = self.metadata["model_version"]

    def predict_proba_a(self, X: pd.DataFrame, groups: pd.Series) -> np.ndarray:
        X = X[self.feature_columns]
        return self.ensemble.predict_proba_a(X, groups)

    def shap_contributions(self, X: pd.DataFrame) -> np.ndarray:
        """TreeSHAP values from the ENSEMBLE's global LightGBM. The
        blended probability comes from 4 learners, but SHAP only makes
        sense per single tree model — and the global LGB is the most
        interpretable choice (linear LogReg coefs and XGB-vs-LGB
        differences would muddle the "why" panel)."""
        X = X[self.feature_columns]
        booster = self.ensemble.lgb_global
        assert booster is not None
        contribs = booster.predict(X, pred_contrib=True)
        return contribs[:, :-1]


def predict_upcoming(*, force_version: str | None = None) -> int:
    """Score every upcoming UFC bout where both fighters have ≥1 prior
    UFC fight. Returns the number of rows written."""
    model = LoadedModel()
    version = force_version or model.model_version
    console.log(f"loaded model {version} ({len(model.feature_columns)} features)")

    raw = fetch_raw()
    df_all = build_dataset(raw, include_scheduled=True)
    upcoming = df_all[df_all["target_a_wins"].isna()].reset_index(drop=True)
    if upcoming.empty:
        console.log("no upcoming bouts with sufficient history to score")
        return 0
    console.log(f"scoring {len(upcoming):,} upcoming bouts…")

    # Fill the target column with a dummy 0 so build_feature_matrix
    # (which selects on target) doesn't break — we won't use y.
    upcoming_fill = upcoming.copy()
    upcoming_fill["target_a_wins"] = 0
    X, _, meta = build_feature_matrix(upcoming_fill)
    # Weight-group per bout — needed so the ensemble can route to the
    # right per-class specialist. Pulled from the upcoming DataFrame
    # which carries weight_class through from build_dataset.
    groups = upcoming["weight_class"].apply(weight_group).reset_index(drop=True)

    probs_a = model.predict_proba_a(X, groups)
    shap_matrix = model.shap_contributions(X)  # (n_bouts, n_features)
    confidences = [confidence_label(max(p, 1 - p)) for p in probs_a]
    pred_winners = [
        row.fighter_a_id if p >= 0.5 else row.fighter_b_id
        for p, row in zip(probs_a, meta.itertuples(index=False), strict=False)
    ]

    market_a = upcoming["market_prob_a"].astype(float).where(upcoming["market_prob_a"].notna(), None)
    edges = []
    for p_model, p_mkt in zip(probs_a, market_a, strict=False):
        if p_mkt is None or pd.isna(p_mkt):
            edges.append(None)
        else:
            edges.append(float(p_model - p_mkt))

    rows = []
    for i, m in enumerate(meta.itertuples(index=False)):
        p_a = float(probs_a[i])
        rows.append(
            (
                m.bout_id,
                version,
                p_a,
                1.0 - p_a,
                pred_winners[i],
                confidences[i],
                None if market_a.iloc[i] is None or pd.isna(market_a.iloc[i]) else float(market_a.iloc[i]),
                edges[i],
            )
        )

    # Build per-bout top-N SHAP rows. abs_rank is 1-indexed for human-
    # readable ORDER BY. feature_value carries the raw input so the UI can
    # show "Reach +6 cm" without re-fetching the source row.
    feature_rows: list[tuple] = []
    for i, m in enumerate(meta.itertuples(index=False)):
        shap_row = shap_matrix[i]
        x_row = X.iloc[i]
        abs_order = np.argsort(-np.abs(shap_row))
        for rank, col_idx in enumerate(abs_order[:TOP_N_FEATURES], start=1):
            feature_name = model.feature_columns[col_idx]
            shap_value = float(shap_row[col_idx])
            raw_val = x_row.iloc[col_idx]
            feature_value = (
                None
                if raw_val is None or (isinstance(raw_val, float) and pd.isna(raw_val))
                else float(raw_val)
            )
            feature_rows.append(
                (m.bout_id, version, feature_name, shap_value, feature_value, rank)
            )

    # Phase 3 — Monte Carlo per-bout. We rebuild FighterMC from the
    # upcoming DataFrame rows; the snapshot fields are all present there
    # (see export.FighterHistory.snapshot keys). seed is bout-stable so
    # re-running the same bout gets the same distribution (within
    # rounding) — easier to debug.
    mc_rows: list[tuple] = []
    for i, m in enumerate(meta.itertuples(index=False)):
        row = upcoming.iloc[i]
        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        a = FighterMC.from_snapshot(snap_a)
        b = FighterMC.from_snapshot(snap_b)
        scheduled_rounds = int(row["scheduled_rounds"])
        mc = simulate_bout(a, b, scheduled_rounds, seed=hash(m.bout_id) & 0xFFFFFFFF)
        mc_rows.append(
            (
                m.bout_id,
                version,
                mc.n_simulations,
                mc.winner_prob_a,
                mc.winner_prob_b,
                mc.prob_ko_a,
                mc.prob_ko_b,
                mc.prob_sub_a,
                mc.prob_sub_b,
                mc.prob_decision_a,
                mc.prob_decision_b,
                mc.avg_finish_seconds,
                mc.prob_finish_per_round.get(1),
                mc.prob_finish_per_round.get(2),
                mc.prob_finish_per_round.get(3),
                mc.prob_finish_per_round.get(4),
                mc.prob_finish_per_round.get(5),
                Jsonb(mc.distribution),
            )
        )

    upsert_sim_sql = """
        INSERT INTO bout_simulation
          (bout_id, model_version, prob_a, prob_b, predicted_winner_id,
           confidence_label, market_prob_a, edge_a)
        VALUES (%s::uuid, %s, %s, %s, %s::uuid, %s, %s, %s)
        ON CONFLICT (bout_id, model_version) DO UPDATE SET
          prob_a = EXCLUDED.prob_a,
          prob_b = EXCLUDED.prob_b,
          predicted_winner_id = EXCLUDED.predicted_winner_id,
          confidence_label = EXCLUDED.confidence_label,
          market_prob_a = EXCLUDED.market_prob_a,
          edge_a = EXCLUDED.edge_a,
          generated_at = now()
    """
    upsert_features_sql = """
        INSERT INTO bout_simulation_features
          (bout_id, model_version, feature_name, shap_value, feature_value, abs_rank)
        VALUES (%s::uuid, %s, %s, %s, %s, %s)
        ON CONFLICT (bout_id, model_version, feature_name) DO UPDATE SET
          shap_value = EXCLUDED.shap_value,
          feature_value = EXCLUDED.feature_value,
          abs_rank = EXCLUDED.abs_rank,
          generated_at = now()
    """
    upsert_rounds_sql = """
        INSERT INTO bout_simulation_rounds
          (bout_id, model_version, n_simulations,
           mc_winner_prob_a, mc_winner_prob_b,
           prob_ko_a, prob_ko_b, prob_sub_a, prob_sub_b,
           prob_decision_a, prob_decision_b,
           avg_finish_seconds,
           prob_finish_round_1, prob_finish_round_2, prob_finish_round_3,
           prob_finish_round_4, prob_finish_round_5,
           distribution)
        VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s)
        ON CONFLICT (bout_id, model_version) DO UPDATE SET
          n_simulations = EXCLUDED.n_simulations,
          mc_winner_prob_a = EXCLUDED.mc_winner_prob_a,
          mc_winner_prob_b = EXCLUDED.mc_winner_prob_b,
          prob_ko_a = EXCLUDED.prob_ko_a,
          prob_ko_b = EXCLUDED.prob_ko_b,
          prob_sub_a = EXCLUDED.prob_sub_a,
          prob_sub_b = EXCLUDED.prob_sub_b,
          prob_decision_a = EXCLUDED.prob_decision_a,
          prob_decision_b = EXCLUDED.prob_decision_b,
          avg_finish_seconds = EXCLUDED.avg_finish_seconds,
          prob_finish_round_1 = EXCLUDED.prob_finish_round_1,
          prob_finish_round_2 = EXCLUDED.prob_finish_round_2,
          prob_finish_round_3 = EXCLUDED.prob_finish_round_3,
          prob_finish_round_4 = EXCLUDED.prob_finish_round_4,
          prob_finish_round_5 = EXCLUDED.prob_finish_round_5,
          distribution = EXCLUDED.distribution,
          generated_at = now()
    """

    # Re-running for the same (bout, version) under fewer top-N or
    # different rank could leave stale rows around. Wipe the prior set
    # in the same transaction before inserting the fresh top-N.
    bout_ids = sorted({r[0] for r in rows})
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(upsert_sim_sql, rows)
            if bout_ids:
                cur.execute(
                    "DELETE FROM bout_simulation_features "
                    "WHERE model_version = %s AND bout_id = ANY(%s::uuid[])",
                    (version, bout_ids),
                )
            cur.executemany(upsert_features_sql, feature_rows)
            cur.executemany(upsert_rounds_sql, mc_rows)
        conn.commit()
    console.log(
        f"wrote {len(rows):,} predictions · {len(feature_rows):,} SHAP rows · "
        f"{len(mc_rows):,} Monte Carlo distributions"
    )
    return len(rows)

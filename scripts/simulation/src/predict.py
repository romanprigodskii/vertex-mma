"""Inference runner — scores upcoming UFC bouts with the trained
LightGBM + isotonic calibrator and writes one row per bout to the
`bout_simulation` table.

Re-running for the same (bout_id, model_version) pair is an UPSERT so
the cron can be invoked multiple times safely (idempotent)."""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from rich.console import Console

from .config import ARTIFACTS_DIR, MODEL_VERSION, confidence_label
from .db import get_connection
from .export import build_dataset, fetch_raw
from .features import build_feature_matrix, feature_names

console = Console()

# Number of top features (by |shap|) we persist per bout. The UI shows
# at most ~5, but keeping a couple extras gives Phase 3 / debug
# inspection room without re-running the model.
TOP_N_FEATURES = 8


class LoadedModel:
    def __init__(self) -> None:
        meta_path = ARTIFACTS_DIR / "metadata.json"
        model_path = ARTIFACTS_DIR / "model.lgb"
        iso_path = ARTIFACTS_DIR / "calibrator.pkl"
        if not (meta_path.exists() and model_path.exists() and iso_path.exists()):
            raise RuntimeError(
                "Trained artifacts missing. Run scripts/run_train.py first."
            )
        self.metadata = json.loads(meta_path.read_text())
        self.booster = lgb.Booster(model_file=str(model_path))
        self.calibrator = joblib.load(iso_path)
        self.feature_columns: list[str] = self.metadata["feature_columns"]
        self.model_version: str = self.metadata["model_version"]

    def predict_proba_a(self, X: pd.DataFrame) -> np.ndarray:
        X = X[self.feature_columns]
        raw = self.booster.predict(X)
        return self.calibrator.transform(raw)

    def shap_contributions(self, X: pd.DataFrame) -> np.ndarray:
        """TreeSHAP values for each row. Returns shape (n_samples, n_features).
        The last LightGBM-emitted column is the expected_value bias term —
        we drop it; the bias is constant across bouts so it doesn't help
        the per-bout "why" UI."""
        X = X[self.feature_columns]
        contribs = self.booster.predict(X, pred_contrib=True)
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

    probs_a = model.predict_proba_a(X)
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
        conn.commit()
    console.log(
        f"wrote {len(rows):,} predictions · {len(feature_rows):,} SHAP rows "
        f"(top {TOP_N_FEATURES} per bout)"
    )
    return len(rows)

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

    upsert_sql = """
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
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.executemany(upsert_sql, rows)
        conn.commit()
    console.log(f"wrote {len(rows):,} predictions to bout_simulation")
    return len(rows)

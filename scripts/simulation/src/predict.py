"""Inference runner — scores upcoming UFC bouts.

Three things get written per bout:

  1. bout_simulation                  — blended ensemble winner prob (NOT
                                        post-hoc calibrated — see ensemble.py)
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
from .ensemble import EnsembleModel
from .export import build_dataset, fetch_raw, stable_hash, swap_sides
from .features import build_feature_matrix, serving_columns
from .method_model import METHOD_MODEL_DEBUT_DIR, METHOD_MODEL_DIR, MethodModel
from .method_model import conditional_mix as method_conditional_mix
from .monte_carlo import FighterMC, simulate_bout

console = Console()

# Number of top features (by |shap|) we persist per bout. The UI shows
# at most ~5, but keeping a couple extras gives Phase 3 / debug
# inspection room without re-running the model.
TOP_N_FEATURES = 8

ENSEMBLE_DIR = ARTIFACTS_DIR / "ensemble"
ENSEMBLE_DEBUT_DIR = ARTIFACTS_DIR / "ensemble_debut"


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
        # v0.8.0 — debut specialist, present when trained with debut rows.
        # Bouts with a UFC debutant route here; the main ensemble never sees
        # them (its training set excludes debuts entirely).
        debut_meta = self.metadata.get("debut_specialist")
        if debut_meta and ENSEMBLE_DEBUT_DIR.exists():
            self.debut_ensemble: EnsembleModel | None = EnsembleModel.load(
                ENSEMBLE_DEBUT_DIR
            )
            self.debut_feature_columns: list[str] = debut_meta["feature_columns"]
        else:
            self.debut_ensemble = None
            self.debut_feature_columns = []

    def predict_proba_a(
        self, X: pd.DataFrame, *, debut: bool = False
    ) -> np.ndarray:
        if debut:
            assert self.debut_ensemble is not None
            return self.debut_ensemble.predict_proba_a(
                X[serving_columns(self.debut_feature_columns)]
            )
        return self.ensemble.predict_proba_a(X[serving_columns(self.feature_columns)])

    def shap_contributions(
        self, X: pd.DataFrame, *, debut: bool = False
    ) -> tuple[np.ndarray, list[str]]:
        """TreeSHAP values from the serving model's global LightGBM (the
        debut specialist's for debut bouts). The blended probability comes
        from 3 learners, but SHAP only makes sense per single tree model —
        and the global LGB is the most interpretable choice (linear LogReg
        coefs and XGB-vs-LGB differences would muddle the "why" panel).
        Returns (contribs, the column list they're indexed by)."""
        cols = self.debut_feature_columns if debut else self.feature_columns
        booster = (
            self.debut_ensemble.lgb_global if debut else self.ensemble.lgb_global
        )
        assert booster is not None
        contribs = booster.predict(X[cols], pred_contrib=True)
        return contribs[:, :-1], cols


def predict_upcoming(*, force_version: str | None = None) -> int:
    """Score every upcoming UFC bout where both fighters have ≥1 prior
    UFC fight. Returns the number of rows written."""
    model = LoadedModel()
    version = force_version or model.model_version
    console.log(f"loaded model {version} ({len(model.feature_columns)} features)")

    raw = fetch_raw()
    # include_debuts only when the specialist exists — otherwise keep the
    # legacy "both fighters have >=1 prior bout" coverage.
    with_debuts = model.debut_ensemble is not None
    df_all = build_dataset(raw, include_scheduled=True, include_debuts=with_debuts)
    upcoming = df_all[df_all["target_a_wins"].isna()].reset_index(drop=True)
    if upcoming.empty:
        console.log("no upcoming bouts with sufficient history to score")
        return 0
    debut_mask = (
        (upcoming["is_debut_a"] | upcoming["is_debut_b"]).to_numpy()
        if with_debuts
        else np.zeros(len(upcoming), dtype=bool)
    )
    console.log(
        f"scoring {len(upcoming):,} upcoming bouts "
        f"({int(debut_mask.sum())} with a debutant → specialist)…"
    )

    # Fill the target column with a dummy 0 so build_feature_matrix
    # (which selects on target) doesn't break — we won't use y.
    upcoming_fill = upcoming.copy()
    upcoming_fill["target_a_wins"] = 0
    X, _, meta = build_feature_matrix(upcoming_fill, corrector=True)

    # Order-invariant winner prob: the model isn't perfectly antisymmetric
    # (abs_*_a/_b, stance one-hots), so the raw scrape order would leak into
    # the prediction. Score both orders and average:
    #   P(A wins) = ½·[ predict(A,B) + (1 − predict(B,A)) ].
    # Bouts with a debutant route to the specialist, everything else to the
    # main ensemble; both get the same order-averaging.
    X_swapped, _, _ = build_feature_matrix(swap_sides(upcoming_fill), corrector=True)
    probs_a = np.empty(len(upcoming), dtype=float)
    for mask, is_debut in ((~debut_mask, False), (debut_mask, True)):
        if not mask.any():
            continue
        p = model.predict_proba_a(X.loc[mask], debut=is_debut)
        p_sw = model.predict_proba_a(X_swapped.loc[mask], debut=is_debut)
        probs_a[mask] = 0.5 * (p + (1.0 - p_sw))
    # SHAP stays on the original order — it explains this row's inputs as
    # scraped; the headline prob is the symmetrized one above. Each segment
    # is explained by the model that actually scored it.
    shap_cols_by_row: list[list[str]] = [[] for _ in range(len(upcoming))]
    shap_values_by_row: list[np.ndarray] = [np.array([])] * len(upcoming)
    for mask, is_debut in ((~debut_mask, False), (debut_mask, True)):
        if not mask.any():
            continue
        contribs, cols = model.shap_contributions(X.loc[mask], debut=is_debut)
        for j, i in enumerate(np.where(mask)[0]):
            shap_values_by_row[i] = contribs[j]
            shap_cols_by_row[i] = cols
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
        shap_row = shap_values_by_row[i]
        row_cols = shap_cols_by_row[i]
        x_row = X.iloc[i]
        abs_order = np.argsort(-np.abs(shap_row))
        for rank, col_idx in enumerate(abs_order[:TOP_N_FEATURES], start=1):
            feature_name = row_cols[col_idx]
            shap_value = float(shap_row[col_idx])
            raw_val = x_row[feature_name]
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
    # (see export.FighterHistory.snapshot keys). seed is bout-stable
    # (stable_hash, NOT the salted builtin hash) so re-running the same bout
    # gets the same distribution across processes — the contract this comment
    # promised but the old `hash()` quietly broke.
    # v0.12.0 — conditional method mix from the discriminative model. It
    # replaces the simulator's hazard-derived mix and its base-rate anchor on
    # the segment it was fitted for; debut bouts keep the simulator, because
    # the model has never seen a row with one side's career columns entirely
    # NaN and the debut segment is served by a separate specialist anyway.
    # Missing artifact → mix stays None → pre-v0.12.0 behaviour, unchanged.
    method_mixes: np.ndarray | None = None
    if METHOD_MODEL_DIR.exists():
        method_model = MethodModel.load(METHOD_MODEL_DIR)
        method_mixes = method_conditional_mix(method_model, upcoming_fill)
        console.log(
            f"method model loaded ({len(method_model.feature_columns)} features) — "
            f"pricing {int((~debut_mask).sum())} non-debut bouts"
        )
    else:
        console.log("no method model artifact — method mix falls back to the simulator")

    # v0.14.0 — the debut segment gets its own conditional instead of the
    # simulator's hazards. It is a SEPARATE artifact, not the model above
    # applied wider: that one has never been fitted on a row where one
    # side's career columns are entirely NaN. Missing artifact → this stays
    # None → the debut segment keeps pre-v0.14.0 behaviour exactly.
    debut_method_mixes: np.ndarray | None = None
    if METHOD_MODEL_DEBUT_DIR.exists() and bool(debut_mask.any()):
        debut_method_model = MethodModel.load(METHOD_MODEL_DEBUT_DIR)
        debut_method_mixes = method_conditional_mix(debut_method_model, upcoming_fill)
        console.log(
            f"debut method model loaded "
            f"({len(debut_method_model.feature_columns)} features) — "
            f"pricing {int(debut_mask.sum())} debut bouts"
        )
    elif bool(debut_mask.any()):
        console.log(
            f"no debut method model artifact — {int(debut_mask.sum())} debut "
            f"bouts fall back to the simulator"
        )

    def mix_for(i: int) -> tuple[tuple[float, ...], tuple[float, ...]] | None:
        source = debut_method_mixes if debut_mask[i] else method_mixes
        if source is None:
            return None
        return (tuple(source[i, 0]), tuple(source[i, 1]))

    mc_rows: list[tuple] = []
    for i, m in enumerate(meta.itertuples(index=False)):
        row = upcoming.iloc[i]
        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        a = FighterMC.from_snapshot(snap_a)
        b = FighterMC.from_snapshot(snap_b)
        scheduled_rounds = int(row["scheduled_rounds"])
        mc = simulate_bout(
            a,
            b,
            scheduled_rounds,
            seed=stable_hash(m.bout_id),
            # Covariates of the fitted finish-hazard timing model. Both ride on
            # the upcoming row already (export.build_dataset writes them), so
            # this needs no extra fetch.
            is_main_event=bool(row["is_main_event"]),
            is_title_fight=bool(row["is_title_fight"]),
            method_mix=mix_for(i),
        )
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

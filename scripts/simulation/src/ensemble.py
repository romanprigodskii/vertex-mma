"""Ensemble model: blend of three base learners trained on the same
feature matrix.

Base learners (always trained on the global dataset):
  - LightGBM (Optuna-tuned hyperparameters)
  - CatBoost (v0.10.0, replaced XGBoost — ordered boosting / oblivious
    trees give a different bias profile; it was the strongest individual
    learner on every eval and the swap beat the XGB blend on val AND test)
  - LogisticRegression on standardized features (linear baseline so the
    blend has both tree and linear viewpoints — these disagree on
    extrapolation cases the GBTs overfit on small data)

v0.6.0 dropped the per-weight-class LightGBM specialists: on every
honest evaluation (served split AND the 2025-07..2026-07 rolling
backtest) the specialist was the worst learner by a wide margin
(solo log-loss ~0.68 vs ~0.64 for the others — each weight group has
too little data to beat the global model it was forked from) and
removing it from the blend never hurt any metric.

Blender: LogisticRegression on the three base predictions evaluated on
the validation split (one of three modes — logreg / mean / weighted_mean —
picked on val log-loss in fit()).

NOTE ON CALIBRATION: NO post-blender calibrator is applied (calibrator=None).
Isotonic on the ~430 val rows double-dipped noise and pushed test log-loss
0.65→0.72, so the blended probability is shipped as-is. The usually-chosen
`weighted_mean` mode AVERAGES the learners' probabilities, which is mildly
UNDER-DISPERSED (Jensen — pulled toward 0.5), so the output is NOT guaranteed
calibrated. Don't describe these probabilities as "calibrated" downstream.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler


class EnsembleModel:
    """Container with persistence — handles training all sub-models and
    blending them into a single probability (blended, not post-hoc
    calibrated — see the module docstring)."""

    def __init__(
        self,
        feature_columns: list[str],
        lgb_params: dict[str, Any],
        lgb_num_rounds: int,
        lgb_early_stopping: int,
    ) -> None:
        self.feature_columns = feature_columns
        self.lgb_params = lgb_params
        self.lgb_num_rounds = lgb_num_rounds
        self.lgb_early_stopping = lgb_early_stopping

        self.lgb_global: lgb.Booster | None = None
        self.cb_global: CatBoostClassifier | None = None
        self.logreg: LogisticRegression | None = None
        self.scaler: StandardScaler | None = None
        # Imputer values learned on train for logreg (mean per column).
        self.logreg_means: np.ndarray | None = None
        self.blender: LogisticRegression | None = None
        self.calibrator: IsotonicRegression | None = None
        self.training_meta: dict[str, Any] = {}

    # ── individual training helpers ────────────────────────────────────

    def _train_lgb(
        self,
        X_tr: pd.DataFrame,
        y_tr: pd.Series,
        X_va: pd.DataFrame,
        y_va: pd.Series,
        sample_weight: np.ndarray | None = None,
    ) -> lgb.Booster:
        dtr = lgb.Dataset(X_tr, label=y_tr, weight=sample_weight)
        dva = lgb.Dataset(X_va, label=y_va, reference=dtr)
        return lgb.train(
            self.lgb_params,
            dtr,
            num_boost_round=self.lgb_num_rounds,
            valid_sets=[dva],
            valid_names=["val"],
            callbacks=[
                lgb.early_stopping(
                    stopping_rounds=self.lgb_early_stopping, verbose=False
                ),
            ],
        )

    @staticmethod
    def _cb_params() -> dict[str, Any]:
        # CatBoost config from the v0.10 lab winner (d6 / lr 0.05 beat the
        # more-regularized d4 / lr 0.03 everywhere). random_seed pins the
        # ordered-boosting permutations; allow_writing_files kills the
        # catboost_info/ litter.
        return {
            "iterations": 2000,
            "learning_rate": 0.05,
            "depth": 6,
            "loss_function": "Logloss",
            "eval_metric": "Logloss",
            "random_seed": 42,
            "verbose": 0,
            "allow_writing_files": False,
        }

    def _train_cb(
        self,
        X_tr: pd.DataFrame,
        y_tr: pd.Series,
        X_va: pd.DataFrame,
        y_va: pd.Series,
        sample_weight: np.ndarray | None = None,
    ) -> CatBoostClassifier:
        model = CatBoostClassifier(**self._cb_params(), early_stopping_rounds=100)
        model.fit(
            X_tr,
            y_tr.astype(int),
            sample_weight=sample_weight,
            eval_set=(X_va, y_va.astype(int)),
        )
        return model

    # ── fixed-iteration trainers (production refit on ALL data) ─────────

    def _train_lgb_fixed(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        num_rounds: int,
        sample_weight: np.ndarray | None = None,
    ) -> lgb.Booster:
        """Train LGB for a FIXED round count (no val / early stopping). Used by
        the production refit: the iteration count comes from the eval-split run,
        so we can train on ALL data without holding any out."""
        dtr = lgb.Dataset(X, label=y, weight=sample_weight)
        return lgb.train(self.lgb_params, dtr, num_boost_round=max(1, int(num_rounds)))

    def _train_cb_fixed(
        self,
        X: pd.DataFrame,
        y: pd.Series,
        num_rounds: int,
        sample_weight: np.ndarray | None = None,
    ) -> CatBoostClassifier:
        params = {**self._cb_params(), "iterations": max(1, int(num_rounds))}
        model = CatBoostClassifier(**params)
        model.fit(X, y.astype(int), sample_weight=sample_weight)
        return model

    def _train_logreg(
        self,
        X_tr: pd.DataFrame,
        y_tr: pd.Series,
        sample_weight: np.ndarray | None = None,
    ) -> tuple[LogisticRegression, StandardScaler, np.ndarray]:
        # Linear models can't handle NaN natively. Impute with the column
        # mean learned on train (falls back to 0 when the column is
        # entirely NaN, which happens for ratio features computed from
        # zero-denominator histories).
        col_means = X_tr.mean(numeric_only=True)
        col_means = col_means.fillna(0.0)
        means = col_means.values.astype(np.float64)
        X_filled = X_tr.fillna(col_means).fillna(0.0).values.astype(np.float64)
        scaler = StandardScaler()
        X_scaled = scaler.fit_transform(X_filled)
        clf = LogisticRegression(
            max_iter=500, C=0.5, solver="liblinear", random_state=42
        )
        clf.fit(X_scaled, y_tr.astype(int), sample_weight=sample_weight)
        return clf, scaler, means

    # ── full training entrypoint ───────────────────────────────────────

    def fit(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        X_val: pd.DataFrame,
        y_val: pd.Series,
        sample_weight: np.ndarray | None = None,
    ) -> dict[str, Any]:
        """`sample_weight` (v0.8.0) lets the debut specialist train on the
        full dataset with both-experienced rows down-weighted — early
        stopping, the blender and the blend-mode pick stay on the
        (unweighted) val split."""
        # 1. Train base learners on the full train split.
        self.lgb_global = self._train_lgb(X_train, y_train, X_val, y_val, sample_weight)
        self.cb_global = self._train_cb(X_train, y_train, X_val, y_val, sample_weight)
        self.logreg, self.scaler, self.logreg_means = self._train_logreg(
            X_train, y_train, sample_weight
        )

        # 2. Build val-set base predictions for the blender.
        val_preds = self._base_predict_matrix(X_val)

        # 3. Pick the best of three blend strategies on val log-loss:
        #
        #   * "logreg"        — full LogReg blender (C=0.1). Best when
        #                       val signal is strong; can over-weight
        #                       one learner on small val sets.
        #   * "mean"          — plain arithmetic mean. Most conservative,
        #                       robust to small-val noise.
        #   * "weighted_mean" — mean weighted by softmax(-val_logloss).
        #                       Gives more weight to learners that do
        #                       well on val without the extreme
        #                       coefficients of full LogReg.
        #
        # Best of three is picked on val log-loss. All three are cheap
        # to compute so this stays fast.
        from sklearn.metrics import log_loss as _log_loss

        blender = LogisticRegression(
            max_iter=500, C=0.1, solver="liblinear", random_state=42
        )
        blender.fit(val_preds, y_val.astype(int))
        p_lr = blender.predict_proba(val_preds)[:, 1]
        p_mean = val_preds.mean(axis=1)

        # Per-learner val log-loss → softmax weights.
        per_learner_ll = np.array(
            [
                _log_loss(y_val.astype(int), val_preds[:, j].clip(1e-4, 1 - 1e-4))
                for j in range(val_preds.shape[1])
            ]
        )
        scaled = -per_learner_ll / max(per_learner_ll.std(), 1e-6)
        e = np.exp(scaled - scaled.max())
        weights = e / e.sum()
        p_wmean = val_preds @ weights

        ll_lr = _log_loss(y_val.astype(int), p_lr.clip(1e-4, 1 - 1e-4))
        ll_mean = _log_loss(y_val.astype(int), p_mean.clip(1e-4, 1 - 1e-4))
        ll_wmean = _log_loss(y_val.astype(int), p_wmean.clip(1e-4, 1 - 1e-4))
        options = {"logreg": ll_lr, "mean": ll_mean, "weighted_mean": ll_wmean}
        best_mode = min(options, key=lambda k: options[k])

        self.blender = blender
        self._blend_mode = best_mode
        self._blend_weights = weights.tolist()
        self._val_blend_logloss = {k: float(v) for k, v in options.items()}

        # NB: no post-blender calibrator. Fitting isotonic on the ~430 val rows
        # double-dipped noise and pushed test log-loss 0.65→0.72, so we ship the
        # blended prob as-is. CAVEAT: the chosen mode is often `weighted_mean`
        # (a mean of the learners' probs), which is mildly under-dispersed, so
        # the output is NOT guaranteed calibrated — downstream copy must not
        # claim it is. (A no-vig book would leak any residual miscalibration into
        # EV, part of why the sportsbook carries a margin.)
        self.calibrator = None

        # Bookkeeping — store the blender weights AND the chosen blend
        # mode so the metadata report shows both options' val log-loss
        # and which one we shipped.
        self.training_meta = {
            "blend_mode": self._blend_mode,
            "val_blend_logloss": self._val_blend_logloss,
            "weighted_mean_weights": {
                name: float(w)
                for name, w in zip(
                    ["p_lgb_global", "p_cb_global", "p_logreg"],
                    self._blend_weights,
                    strict=False,
                )
            },
            "blender_intercept": float(blender.intercept_[0]),
            "blender_coefs": {
                name: float(c)
                for name, c in zip(
                    ["p_lgb_global", "p_cb_global", "p_logreg"],
                    blender.coef_[0],
                    strict=False,
                )
            },
        }
        return self.training_meta

    # ── production refit on ALL data ───────────────────────────────────

    def refit_on_all(
        self,
        X_all: pd.DataFrame,
        y_all: pd.Series,
        sample_weight: np.ndarray | None = None,
    ) -> "EnsembleModel":
        """Return a PRODUCTION ensemble whose base learners are refit on the
        FULL dataset (train+val+test), so the SERVED weights include the most
        recent fights instead of only data before TRAIN_END. The temporal-split
        model this is called on stays the source of the honest held-out metrics;
        this is the model we actually deploy.

        Iteration counts are taken from the eval-split fit (best_iteration), so
        no held-out val is needed to refit on all data. The blender + blend mode
        + weights are TRANSFERRED unchanged — they're meta-parameters selected on
        val and can't be re-fit without a holdout, and they're stable.
        """
        assert self.lgb_global is not None and self.cb_global is not None
        X_all = X_all.reset_index(drop=True)
        y_all = y_all.reset_index(drop=True)

        prod = EnsembleModel(
            feature_columns=self.feature_columns,
            lgb_params=self.lgb_params,
            lgb_num_rounds=self.lgb_num_rounds,
            lgb_early_stopping=self.lgb_early_stopping,
        )
        lgb_rounds = self.lgb_global.best_iteration or self.lgb_num_rounds
        prod.lgb_global = self._train_lgb_fixed(X_all, y_all, lgb_rounds, sample_weight)
        cb_best = self.cb_global.get_best_iteration()
        cb_rounds = (cb_best + 1) if cb_best is not None else 2000
        prod.cb_global = self._train_cb_fixed(X_all, y_all, cb_rounds, sample_weight)
        prod.logreg, prod.scaler, prod.logreg_means = self._train_logreg(
            X_all, y_all, sample_weight
        )
        # Transfer the blend config unchanged (meta-params selected on val).
        prod.blender = self.blender
        prod.calibrator = self.calibrator
        prod._blend_mode = getattr(self, "_blend_mode", "logreg")
        prod._blend_weights = getattr(self, "_blend_weights", [])
        prod._val_blend_logloss = getattr(self, "_val_blend_logloss", {})
        prod.training_meta = dict(self.training_meta)
        return prod

    # ── prediction ─────────────────────────────────────────────────────

    def _base_predict_matrix(self, X: pd.DataFrame) -> np.ndarray:
        """Stack base predictions as [p_lgb, p_cb, p_logreg] with one row
        per input bout."""
        assert self.lgb_global is not None
        assert self.cb_global is not None
        assert self.logreg is not None
        assert self.scaler is not None
        assert self.logreg_means is not None
        X_filled = X.fillna(pd.Series(self.logreg_means, index=X.columns)).fillna(0.0)
        p_lgb = self.lgb_global.predict(X, num_iteration=self.lgb_global.best_iteration)
        # CatBoost's predict_proba respects best_iteration automatically when
        # early stopping was used; the fixed-round production refit simply
        # uses all trees.
        p_cb = self.cb_global.predict_proba(X)[:, 1]
        p_log = self.logreg.predict_proba(self.scaler.transform(X_filled.values))[:, 1]
        return np.column_stack([p_lgb, p_cb, p_log])

    def predict_proba_a(self, X: pd.DataFrame) -> np.ndarray:
        """Final P(A wins). Blend mode is picked at fit() time on val
        log-loss — see EnsembleModel.fit for the three options
        (logreg / mean / weighted_mean)."""
        assert self.blender is not None
        base = self._base_predict_matrix(X)
        mode = getattr(self, "_blend_mode", None)
        if mode == "mean":
            return base.mean(axis=1)
        if mode == "weighted_mean":
            weights = np.array(getattr(self, "_blend_weights", []))
            if weights.size != base.shape[1]:
                weights = np.ones(base.shape[1]) / base.shape[1]
            return base @ weights
        # Default / "logreg" mode.
        return self.blender.predict_proba(base)[:, 1]

    def predict_proba_breakdown(self, X: pd.DataFrame) -> dict[str, np.ndarray]:
        """Per-learner predictions — handy for debugging blender weights
        and for the metadata report."""
        base = self._base_predict_matrix(X)
        return {
            "p_lgb_global": base[:, 0],
            "p_cb_global": base[:, 1],
            "p_logreg": base[:, 2],
            "p_blended": self.predict_proba_a(X),
        }

    # ── persistence ────────────────────────────────────────────────────

    def save(self, dir_path: Path) -> None:
        dir_path.mkdir(parents=True, exist_ok=True)
        assert self.lgb_global is not None
        assert self.cb_global is not None
        self.lgb_global.save_model(str(dir_path / "lgb_global.lgb"))
        self.cb_global.save_model(str(dir_path / "cb_global.cbm"))
        # v0.10.0 swapped XGBoost out — drop its stale artifact if present.
        stale_xgb = dir_path / "xgb_global.json"
        if stale_xgb.exists():
            stale_xgb.unlink()
        # v0.6.0 dropped the weight-class specialists — clear out any
        # lgb_specialist_*.lgb files a previous version left in this dir so
        # the artifact set on disk always matches the loaded model.
        for stale in dir_path.glob("lgb_specialist_*.lgb"):
            stale.unlink()
        joblib.dump(self.logreg, dir_path / "logreg.pkl")
        joblib.dump(self.scaler, dir_path / "logreg_scaler.pkl")
        np.save(dir_path / "logreg_means.npy", self.logreg_means)
        joblib.dump(self.blender, dir_path / "blender.pkl")
        # calibrator may be None (Phase 5 dropped post-blender isotonic).
        if self.calibrator is not None:
            joblib.dump(self.calibrator, dir_path / "calibrator.pkl")
        (dir_path / "feature_columns.json").write_text(
            json.dumps(self.feature_columns)
        )
        # Persist the chosen blend mode + weights so load() reproduces
        # predictions byte-for-byte.
        (dir_path / "blend_mode.json").write_text(
            json.dumps({
                "blend_mode": getattr(self, "_blend_mode", "logreg"),
                "blend_weights": getattr(self, "_blend_weights", []),
                "val_blend_logloss": getattr(self, "_val_blend_logloss", {}),
            })
        )

    @classmethod
    def load(cls, dir_path: Path) -> "EnsembleModel":
        feature_columns = json.loads((dir_path / "feature_columns.json").read_text())
        m = cls(feature_columns=feature_columns, lgb_params={}, lgb_num_rounds=0, lgb_early_stopping=0)
        m.lgb_global = lgb.Booster(model_file=str(dir_path / "lgb_global.lgb"))
        m.cb_global = CatBoostClassifier()
        m.cb_global.load_model(str(dir_path / "cb_global.cbm"))
        m.logreg = joblib.load(dir_path / "logreg.pkl")
        m.scaler = joblib.load(dir_path / "logreg_scaler.pkl")
        m.logreg_means = np.load(dir_path / "logreg_means.npy")
        m.blender = joblib.load(dir_path / "blender.pkl")
        cal_path = dir_path / "calibrator.pkl"
        m.calibrator = joblib.load(cal_path) if cal_path.exists() else None
        blend_mode_path = dir_path / "blend_mode.json"
        if blend_mode_path.exists():
            payload = json.loads(blend_mode_path.read_text())
            m._blend_mode = payload.get("blend_mode", "logreg")
            m._blend_weights = payload.get("blend_weights", [])
            m._val_blend_logloss = payload.get("val_blend_logloss", {})
        else:
            m._blend_mode = "logreg"
            m._blend_weights = []
            m._val_blend_logloss = {}
        return m

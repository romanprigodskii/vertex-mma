"""Ensemble model: blend of several base learners trained on the same
feature matrix, plus per-weight-class LightGBM specialists.

Base learners (always trained on the global dataset):
  - LightGBM (Optuna-tuned hyperparameters)
  - XGBoost  (modest defaults — different bias/variance vs LGB)
  - LogisticRegression on standardized features (linear baseline so the
    blend has both tree and linear viewpoints — these disagree on
    extrapolation cases the GBTs overfit on small data)

Specialists (per weight-class group):
  - "light"         : strawweight + flyweight + bantamweight + featherweight + lightweight
  - "welter_middle" : welterweight + middleweight
  - "heavy"         : light_heavyweight + heavyweight

Each bout maps to exactly one group; the specialist's prediction is
used as the 4th input to the blender. Because there's only one
specialist per bout, the blender doesn't need to know which group —
it just sees a single "p_specialist" column.

Blender: LogisticRegression on the four base predictions evaluated on
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
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler


# Map every weight_class value to one of three training groups. Unknown
# classes (catchweight, openweight, NULL) fall back to "welter_middle"
# because that group has the most data and the broadest style mix.
WEIGHT_GROUP_MAP: dict[str, str] = {
    "strawweight": "light",
    "flyweight": "light",
    "bantamweight": "light",
    "featherweight": "light",
    "lightweight": "light",
    "welterweight": "welter_middle",
    "middleweight": "welter_middle",
    "light_heavyweight": "heavy",
    "heavyweight": "heavy",
}
GROUP_NAMES = ("light", "welter_middle", "heavy")


def weight_group(weight_class: str | None) -> str:
    if weight_class is None:
        return "welter_middle"
    return WEIGHT_GROUP_MAP.get(weight_class, "welter_middle")


def derive_group_from_features(X_row: pd.Series) -> str:
    """Recover the weight group from a one-hot feature row at predict
    time. Falls back to 'welter_middle' when no wc_* column is hot
    (catchweight / openweight)."""
    for col in (
        "wc_strawweight",
        "wc_flyweight",
        "wc_bantamweight",
        "wc_featherweight",
        "wc_lightweight",
    ):
        if X_row.get(col, 0) == 1:
            return "light"
    for col in ("wc_welterweight", "wc_middleweight"):
        if X_row.get(col, 0) == 1:
            return "welter_middle"
    for col in ("wc_light_heavyweight", "wc_heavyweight"):
        if X_row.get(col, 0) == 1:
            return "heavy"
    return "welter_middle"


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
        self.xgb_global: xgb.Booster | None = None
        self.logreg: LogisticRegression | None = None
        self.scaler: StandardScaler | None = None
        # Imputer values learned on train for logreg (mean per column).
        self.logreg_means: np.ndarray | None = None
        self.lgb_specialists: dict[str, lgb.Booster] = {}
        self.blender: LogisticRegression | None = None
        self.calibrator: IsotonicRegression | None = None
        self.training_meta: dict[str, Any] = {}

    # ── individual training helpers ────────────────────────────────────

    def _train_lgb(
        self, X_tr: pd.DataFrame, y_tr: pd.Series, X_va: pd.DataFrame, y_va: pd.Series
    ) -> lgb.Booster:
        dtr = lgb.Dataset(X_tr, label=y_tr)
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
    def _xgb_params() -> dict[str, Any]:
        # XGBoost params chosen to be a deliberate twin of the LGB config but
        # with different regularization defaults — the ensemble benefits when
        # its members disagree on edge cases. `seed` pins subsample/colsample
        # draws (reproducibility; LightGBM is pinned via LGB_PARAMS).
        return {
            "objective": "binary:logistic",
            "eval_metric": "logloss",
            "learning_rate": 0.05,
            "max_depth": 5,
            "min_child_weight": 5,
            "subsample": 0.85,
            "colsample_bytree": 0.85,
            "reg_lambda": 1.5,
            "reg_alpha": 0.1,
            "verbosity": 0,
            "tree_method": "hist",
            "seed": 42,
        }

    def _train_xgb(
        self, X_tr: pd.DataFrame, y_tr: pd.Series, X_va: pd.DataFrame, y_va: pd.Series
    ) -> xgb.Booster:
        dtr = xgb.DMatrix(X_tr, label=y_tr.astype(int))
        dva = xgb.DMatrix(X_va, label=y_va.astype(int))
        return xgb.train(
            self._xgb_params(),
            dtr,
            num_boost_round=1000,
            evals=[(dva, "val")],
            early_stopping_rounds=50,
            verbose_eval=False,
        )

    # ── fixed-iteration trainers (production refit on ALL data) ─────────

    def _train_lgb_fixed(
        self, X: pd.DataFrame, y: pd.Series, num_rounds: int
    ) -> lgb.Booster:
        """Train LGB for a FIXED round count (no val / early stopping). Used by
        the production refit: the iteration count comes from the eval-split run,
        so we can train on ALL data without holding any out."""
        dtr = lgb.Dataset(X, label=y)
        return lgb.train(self.lgb_params, dtr, num_boost_round=max(1, int(num_rounds)))

    def _train_xgb_fixed(
        self, X: pd.DataFrame, y: pd.Series, num_rounds: int
    ) -> xgb.Booster:
        dtr = xgb.DMatrix(X, label=y.astype(int))
        return xgb.train(self._xgb_params(), dtr, num_boost_round=max(1, int(num_rounds)))

    def _train_logreg(
        self, X_tr: pd.DataFrame, y_tr: pd.Series
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
        clf.fit(X_scaled, y_tr.astype(int))
        return clf, scaler, means

    # ── full training entrypoint ───────────────────────────────────────

    def fit(
        self,
        X_train: pd.DataFrame,
        y_train: pd.Series,
        groups_train: pd.Series,
        X_val: pd.DataFrame,
        y_val: pd.Series,
        groups_val: pd.Series,
    ) -> dict[str, Any]:
        # 1. Train base learners on the full train split.
        self.lgb_global = self._train_lgb(X_train, y_train, X_val, y_val)
        self.xgb_global = self._train_xgb(X_train, y_train, X_val, y_val)
        self.logreg, self.scaler, self.logreg_means = self._train_logreg(
            X_train, y_train
        )

        # 2. Specialists per weight group. Each gets the SAME val split
        # (the small-group val numbers are noisy but we use them only
        # for early stopping; the blender is what protects us downstream).
        for g in GROUP_NAMES:
            mask_tr = groups_train == g
            mask_va = groups_val == g
            if mask_tr.sum() < 200 or mask_va.sum() < 20:
                # Not enough data to fit a specialist for this group; the
                # ensemble silently falls back to the global LGB
                # prediction for these bouts.
                continue
            self.lgb_specialists[g] = self._train_lgb(
                X_train.loc[mask_tr].reset_index(drop=True),
                y_train.loc[mask_tr].reset_index(drop=True),
                X_val.loc[mask_va].reset_index(drop=True),
                y_val.loc[mask_va].reset_index(drop=True),
            )

        # 3. Build val-set base predictions for the blender.
        val_preds = self._base_predict_matrix(X_val, groups_val)

        # 4. Pick the best of three blend strategies on val log-loss:
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
                    ["p_lgb_global", "p_xgb_global", "p_logreg", "p_specialist"],
                    self._blend_weights,
                    strict=False,
                )
            },
            "blender_intercept": float(blender.intercept_[0]),
            "blender_coefs": {
                name: float(c)
                for name, c in zip(
                    ["p_lgb_global", "p_xgb_global", "p_logreg", "p_specialist"],
                    blender.coef_[0],
                    strict=False,
                )
            },
            "specialists": list(self.lgb_specialists.keys()),
        }
        return self.training_meta

    # ── production refit on ALL data ───────────────────────────────────

    def refit_on_all(
        self,
        X_all: pd.DataFrame,
        y_all: pd.Series,
        groups_all: pd.Series,
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
        assert self.lgb_global is not None and self.xgb_global is not None
        X_all = X_all.reset_index(drop=True)
        y_all = y_all.reset_index(drop=True)
        groups_all = groups_all.reset_index(drop=True)

        prod = EnsembleModel(
            feature_columns=self.feature_columns,
            lgb_params=self.lgb_params,
            lgb_num_rounds=self.lgb_num_rounds,
            lgb_early_stopping=self.lgb_early_stopping,
        )
        lgb_rounds = self.lgb_global.best_iteration or self.lgb_num_rounds
        prod.lgb_global = self._train_lgb_fixed(X_all, y_all, lgb_rounds)
        xgb_rounds = (self.xgb_global.best_iteration or 1000) + 1
        prod.xgb_global = self._train_xgb_fixed(X_all, y_all, xgb_rounds)
        prod.logreg, prod.scaler, prod.logreg_means = self._train_logreg(X_all, y_all)
        for g, spec in self.lgb_specialists.items():
            mask = (groups_all == g).to_numpy()
            if mask.sum() == 0:
                continue
            spec_rounds = spec.best_iteration or self.lgb_num_rounds
            prod.lgb_specialists[g] = self._train_lgb_fixed(
                X_all.loc[mask].reset_index(drop=True),
                y_all.loc[mask].reset_index(drop=True),
                spec_rounds,
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

    def _base_predict_matrix(
        self, X: pd.DataFrame, groups: pd.Series
    ) -> np.ndarray:
        """Stack base predictions as [p_lgb, p_xgb, p_logreg, p_specialist]
        with one row per input bout."""
        assert self.lgb_global is not None
        assert self.xgb_global is not None
        assert self.logreg is not None
        assert self.scaler is not None
        assert self.logreg_means is not None
        X_filled = X.fillna(pd.Series(self.logreg_means, index=X.columns)).fillna(0.0)
        p_lgb = self.lgb_global.predict(X, num_iteration=self.lgb_global.best_iteration)
        # `best_iteration` only exists when early stopping was used (the eval
        # model). The production refit trains a FIXED round count → no best_
        # iteration; iteration_range=(0, 0) tells XGBoost to use all trees.
        xgb_best = getattr(self.xgb_global, "best_iteration", None)
        xgb_range = (0, int(xgb_best) + 1) if xgb_best is not None else (0, 0)
        p_xgb = self.xgb_global.predict(xgb.DMatrix(X), iteration_range=xgb_range)
        p_log = self.logreg.predict_proba(self.scaler.transform(X_filled.values))[:, 1]
        p_spec = np.empty(len(X), dtype=np.float64)
        for i, g in enumerate(groups.values):
            spec = self.lgb_specialists.get(g)
            if spec is None:
                p_spec[i] = p_lgb[i]
            else:
                p_spec[i] = spec.predict(
                    X.iloc[[i]], num_iteration=spec.best_iteration
                )[0]
        return np.column_stack([p_lgb, p_xgb, p_log, p_spec])

    def predict_proba_a(
        self, X: pd.DataFrame, groups: pd.Series
    ) -> np.ndarray:
        """Final P(A wins). Blend mode is picked at fit() time on val
        log-loss — see EnsembleModel.fit for the three options
        (logreg / mean / weighted_mean)."""
        assert self.blender is not None
        base = self._base_predict_matrix(X, groups)
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

    def predict_proba_breakdown(
        self, X: pd.DataFrame, groups: pd.Series
    ) -> dict[str, np.ndarray]:
        """Per-learner predictions — handy for debugging blender weights
        and for the metadata report."""
        base = self._base_predict_matrix(X, groups)
        return {
            "p_lgb_global": base[:, 0],
            "p_xgb_global": base[:, 1],
            "p_logreg": base[:, 2],
            "p_specialist": base[:, 3],
            "p_blended": self.predict_proba_a(X, groups),
        }

    # ── persistence ────────────────────────────────────────────────────

    def save(self, dir_path: Path) -> None:
        dir_path.mkdir(parents=True, exist_ok=True)
        assert self.lgb_global is not None
        assert self.xgb_global is not None
        self.lgb_global.save_model(str(dir_path / "lgb_global.lgb"))
        self.xgb_global.save_model(str(dir_path / "xgb_global.json"))
        for g, model in self.lgb_specialists.items():
            model.save_model(str(dir_path / f"lgb_specialist_{g}.lgb"))
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
        m.xgb_global = xgb.Booster()
        m.xgb_global.load_model(str(dir_path / "xgb_global.json"))
        for g in GROUP_NAMES:
            p = dir_path / f"lgb_specialist_{g}.lgb"
            if p.exists():
                m.lgb_specialists[g] = lgb.Booster(model_file=str(p))
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

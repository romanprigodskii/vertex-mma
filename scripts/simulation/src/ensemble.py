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

The `calibrator` slot below is real and wired into predict_proba_a, but the
tail-resolution lab left it EMPTY on purpose (docs/tail_resolution.md). What
it measured, on the 568 test bouts with a closing line:

  * The under-dispersion is genuine — the model says 0.68 in the market's
    0.72+ bucket where the truth is 0.84 — but a monotone transform is worth
    only ~0.002-0.003 of the 0.023 log-loss gap, because it cannot sharpen
    the heavy favourites without also sharpening the coin-flips, which is
    where we already beat the book.
  * Fitting 2-3 parameters on the 429-row val split is not affordable:
    bootstrapped over val, 1-param temperature beats the uncalibrated model
    in 90% of resamples, 2-param families in 55-62%, the 3-param piecewise
    in 37%. Val PICKS the piecewise family, which is the worst of them on
    test — the same failure that killed isotonic, at three parameters
    instead of unbounded.
  * Fitting on ~3.1k walk-forward out-of-fold rows instead makes every family
    agree on the same mild map (T≈0.89) and makes it robust (91% of
    bootstraps), but the honest effect is then only +0.0022 — it never
    approaches the tail bucket's 0.4850 mechanical ceiling, so it fails the
    lab's gate and is not shipped.

Anything fitted into this slot is applied PER FIGHTER ORDERING, inside the
order-averaging that predict.py / custom.py wrap around predict_proba_a.
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
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

_CAL_EPS = 1e-6
# Logit range the monotonicity check sweeps. The blend has never produced a
# probability outside ~[0.10, 0.90] (|z| <= 2.2); 4.0 leaves headroom so a
# transform that would fold back on itself just outside the observed range is
# still rejected.
_CAL_Z_MAX = 4.0

# Monotone recalibration families and their Nelder-Mead starting points.
# Two free parameters is the honest budget on 429 val rows: one (temperature)
# can only sharpen everything uniformly, and isotonic (unbounded) already
# failed here — it double-dipped val noise and pushed test log-loss 0.65→0.72.
CALIBRATOR_FAMILIES: dict[str, dict[str, Any]] = {
    # sigmoid(z / T) — uniform sharpening. Symmetric.
    "temperature": {"n_params": 1, "starts": [[1.0], [0.8], [1.2]]},
    # sigmoid(a·z + b·z³) — symmetric by construction; z³ vanishes near
    # p=0.5 so the middle is left alone while the tails stretch.
    "cubic": {"n_params": 2, "starts": [[1.0, 0.0], [1.0, 0.05], [1.2, 0.10]]},
    # sigmoid(a·log p − b·log(1−p) + c) — Kull et al. beta calibration.
    # Only symmetric when a=b and c=0, so a≠b on a symmetrized frame is
    # noise-fitting by construction.
    "beta": {"n_params": 3, "starts": [[1.0, 1.0, 0.0], [1.2, 1.2, 0.0]]},
    "beta_c0": {"n_params": 2, "starts": [[1.0, 1.0], [1.2, 1.2], [0.9, 1.1]]},
    # Slope s_in inside |z| <= kink, s_out beyond it, continuous at the kink
    # (so it stays monotone) and symmetric in sign. params = [s_in, s_out, kink].
    "piecewise": {"n_params": 3, "starts": [[1.0, 1.0, 0.5], [1.0, 1.6, 0.5]]},
}


class ProbabilityCalibrator:
    """A monotone two-ish-parameter map applied to the blended probability.

    Lives in EnsembleModel.calibrator and is applied inside predict_proba_a,
    i.e. PER FIGHTER ORDERING — production averages the two orderings around
    it (predict.py / custom.py), so anything fit against the served quantity
    is fit against this placement.

    Serialized as plain JSON (family + params), not a pickle: it is three
    floats and a name, and a JSON artifact stays readable and diffable in the
    git-committed artifact set.
    """

    def __init__(self, family: str, params: list[float]) -> None:
        if family not in CALIBRATOR_FAMILIES:
            raise ValueError(f"unknown calibrator family {family!r}")
        self.family = family
        self.params = [float(p) for p in params]

    # ── the map ────────────────────────────────────────────────────────

    @staticmethod
    def _logit(p: np.ndarray) -> np.ndarray:
        p = np.clip(np.asarray(p, dtype=float), _CAL_EPS, 1 - _CAL_EPS)
        return np.log(p / (1 - p))

    @staticmethod
    def _sigmoid(z: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(z, -50, 50)))

    def _map_logit(self, z: np.ndarray) -> np.ndarray:
        pr = self.params
        if self.family == "temperature":
            return z / pr[0]
        if self.family == "cubic":
            return pr[0] * z + pr[1] * z**3
        if self.family == "piecewise":
            s_in, s_out, kink = pr[0], pr[1], abs(pr[2])
            a = np.abs(z)
            return np.sign(z) * (s_in * np.minimum(a, kink) + s_out * np.maximum(a - kink, 0.0))
        raise AssertionError(f"{self.family} is not a logit-space family")

    def transform(self, p: np.ndarray) -> np.ndarray:
        p = np.clip(np.asarray(p, dtype=float), _CAL_EPS, 1 - _CAL_EPS)
        if self.family in ("beta", "beta_c0"):
            a, b = self.params[0], self.params[1]
            c = self.params[2] if self.family == "beta" else 0.0
            return self._sigmoid(a * np.log(p) - b * np.log(1 - p) + c)
        return self._sigmoid(self._map_logit(self._logit(p)))

    def is_monotone(self) -> bool:
        """Reject parameter vectors whose map is non-increasing anywhere in
        the reachable range — the optimizer explores freely, and a transform
        that inverts an ordering is not a recalibration."""
        pr = self.params
        if self.family == "temperature":
            return pr[0] > 1e-3
        if self.family in ("beta", "beta_c0"):
            # d/dp = a/p + b/(1−p) > 0 for p in (0,1) iff a,b >= 0, not both 0.
            return pr[0] >= 0 and pr[1] >= 0 and (pr[0] + pr[1]) > 1e-6
        if self.family == "piecewise":
            return pr[0] > 1e-3 and pr[1] > 1e-3 and abs(pr[2]) > 1e-3
        # cubic: a + 3b·z² > 0 across the sweep (a<0 or b<0 can still be fine
        # over a bounded range, so check rather than constrain).
        z = np.linspace(-_CAL_Z_MAX, _CAL_Z_MAX, 601)
        return bool(np.all(pr[0] + 3.0 * pr[1] * z**2 > 1e-6))

    def describe(self) -> str:
        names = {
            "temperature": ["T"],
            "cubic": ["a", "b"],
            "beta": ["a", "b", "c"],
            "beta_c0": ["a", "b"],
            "piecewise": ["s_in", "s_out", "kink"],
        }[self.family]
        return " ".join(f"{n}={v:+.4f}" for n, v in zip(names, self.params, strict=False))

    # ── persistence ────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {"family": self.family, "params": self.params}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ProbabilityCalibrator:
        return cls(payload["family"], payload["params"])


class ResidualCorrector:
    """An additive, antisymmetric shift in logit space, applied after blending.

    Different animal from `ProbabilityCalibrator` above: that one is a monotone
    map of the probability alone, this one is CONDITIONAL on a feature. It
    exists because the blend has a measured directional bias no monotone map
    can reach — the winner-batch lab (docs/winner_batch.md) found the ensemble
    gives a 35-year-old facing a 28-year-old a 0.371 chance where the truth is
    0.164, and that giving LightGBM more age gain (`FEATURE_CONTRI_OVERRIDES`)
    does not fix it: the signal is there, it is diluted by 117 partly collinear
    columns and by a blend that averages three learners' disagreements about it.

    Shape, and why each part of it is pinned:
        z' = slope·z + Σ wᵢ·(xᵢ / scaleᵢ)
      * no intercept, and every xᵢ is an (A − B) difference, so the whole
        correction NEGATES under a side swap. Production averages both
        orderings; an asymmetric correction would survive that averaging as a
        slot bias, an antisymmetric one composes with it cleanly.
      * slope pinned to 1.0 in the shipped fit. The coefficients are fitted on
        walk-forward models trained on less data than the served one, so a
        fitted slope would import that sharpness difference into production,
        where it does not belong. Only the direction transfers.
      * a NaN input contributes ZERO shift rather than dropping the row — a
        fighter with no date of birth must come out of this unchanged, not
        corrected by a guess.

    Refit it whenever the recipe changes; the parameters live in
    `config.RESIDUAL_CORRECTION` and the fit is reproducible from
    `scripts/lab_winner_batch.py --stage correct`.
    """

    def __init__(self, terms: list[dict[str, Any]], slope: float = 1.0) -> None:
        if not terms:
            raise ValueError("ResidualCorrector needs at least one term")
        for t in terms:
            missing = {"column", "weight", "scale"} - set(t)
            if missing:
                raise ValueError(f"term {t!r} is missing {sorted(missing)}")
            if float(t["scale"]) == 0.0:
                raise ValueError(f"term {t['column']!r} has scale 0")
        self.terms = [
            {"column": str(t["column"]), "weight": float(t["weight"]), "scale": float(t["scale"])}
            for t in terms
        ]
        self.slope = float(slope)

    def shift(self, X: pd.DataFrame) -> np.ndarray:
        out = np.zeros(len(X), dtype=float)
        for t in self.terms:
            if t["column"] not in X.columns:
                # Loud, not silent: a served feature matrix that lost the
                # column would otherwise quietly serve an uncorrected
                # probability under a version number that promises otherwise.
                raise KeyError(
                    f"ResidualCorrector needs feature {t['column']!r}, which is not in "
                    f"the feature matrix — refit or clear config.RESIDUAL_CORRECTION"
                )
            v = pd.to_numeric(X[t["column"]], errors="coerce").to_numpy(dtype=float)
            out += t["weight"] * np.nan_to_num(v / t["scale"], nan=0.0, posinf=0.0, neginf=0.0)
        return out

    def transform(self, p: np.ndarray, X: pd.DataFrame) -> np.ndarray:
        p = np.clip(np.asarray(p, dtype=float), _CAL_EPS, 1 - _CAL_EPS)
        z = np.log(p / (1 - p))
        return 1.0 / (1.0 + np.exp(-np.clip(self.slope * z + self.shift(X), -50, 50)))

    def describe(self) -> str:
        body = " ".join(
            f"{t['weight']:+.4f}·{t['column']}/{t['scale']:g}" for t in self.terms
        )
        return f"slope={self.slope:.3f} {body}"

    def to_dict(self) -> dict[str, Any]:
        return {"terms": self.terms, "slope": self.slope}

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> ResidualCorrector:
        return cls(payload["terms"], payload.get("slope", 1.0))


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
        # SHIPPED EMPTY ON PURPOSE — this is not an unfinished slot.
        #
        # The machinery below it is complete and wired into predict_proba_a;
        # what is missing is a reason to fill it. The tail-resolution lab
        # (docs/tail_resolution.md) measured recalibration end to end: fitted
        # on ~3.1k walk-forward out-of-fold rows every family agrees on the
        # same mild map (T ~ 0.89) and it is robust (91 % of bootstraps), but
        # the honest effect is +0.0022 of the 0.0229 log-loss gap to the
        # closing line. That fails the lab's gate.
        #
        # It fails because the gap is RESOLUTION, not calibration: reliability
        # is already at parity with the book (0.00296 vs 0.00303) while
        # resolution is 0.03812 vs 0.04580. A monotone map cannot sharpen the
        # heavy favourites without equally sharpening the coin-flips, which is
        # the region where we already win. Fitting on the 429-row val split
        # instead is worse than useless — val PICKS the 3-parameter piecewise
        # family, which is the worst of them on test.
        #
        # So: filling this in is a measured dead end, not an oversight. If you
        # are here to add a calibrator, read the lab first.
        self.calibrator: ProbabilityCalibrator | None = None
        # v0.13.0 — the slot above's conditional cousin, and unlike it this one
        # ships filled. See ResidualCorrector and docs/winner_batch.md: one
        # coefficient on the age difference, fitted on 3,087 walk-forward OOF
        # bouts, worth -0.0026 nats there / -0.0054 on the held-out window.
        # Attached by train.py from config.RESIDUAL_CORRECTION.
        self.corrector: ResidualCorrector | None = None
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
    ) -> EnsembleModel:
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
        prod.corrector = self.corrector
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
        (logreg / mean / weighted_mean).

        The calibrator (when one is fitted) is applied HERE, so it is inside
        the order-averaging that predict.py / custom.py wrap around this
        call: the served number is ½·[g(f(A,B)) + 1 − g(f(B,A))]."""
        assert self.blender is not None
        base = self._base_predict_matrix(X)
        mode = getattr(self, "_blend_mode", None)
        if mode == "mean":
            blended = base.mean(axis=1)
        elif mode == "weighted_mean":
            weights = np.array(getattr(self, "_blend_weights", []))
            if weights.size != base.shape[1]:
                weights = np.ones(base.shape[1]) / base.shape[1]
            blended = base @ weights
        else:
            # Default / "logreg" mode.
            blended = self.blender.predict_proba(base)[:, 1]
        if self.calibrator is not None:
            blended = self.calibrator.transform(blended)
        # The corrector runs LAST and needs X, not just the probability: it is
        # conditional on a feature, so it cannot live in the calibrator slot.
        # Both sit inside predict_proba_a, i.e. inside the order averaging that
        # predict.py wraps around this call.
        if self.corrector is not None:
            blended = self.corrector.transform(blended, X)
        return blended

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
        # calibrator may be None. Written as JSON (family + params) so the
        # git-committed artifact set stays diffable; a stale pickle from the
        # abandoned isotonic experiment is cleared so what's on disk always
        # matches the loaded model.
        stale_cal = dir_path / "calibrator.pkl"
        if stale_cal.exists():
            stale_cal.unlink()
        cal_json = dir_path / "calibrator.json"
        if self.calibrator is not None:
            cal_json.write_text(json.dumps(self.calibrator.to_dict(), indent=2))
        elif cal_json.exists():
            cal_json.unlink()
        # Same discipline for the corrector: JSON, and removed when absent so a
        # directory on disk can never serve a correction the loaded model does
        # not have.
        corr_json = dir_path / "corrector.json"
        if self.corrector is not None:
            corr_json.write_text(json.dumps(self.corrector.to_dict(), indent=2))
        elif corr_json.exists():
            corr_json.unlink()
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
    def load(cls, dir_path: Path) -> EnsembleModel:
        feature_columns = json.loads((dir_path / "feature_columns.json").read_text())
        m = cls(feature_columns=feature_columns, lgb_params={}, lgb_num_rounds=0, lgb_early_stopping=0)
        m.lgb_global = lgb.Booster(model_file=str(dir_path / "lgb_global.lgb"))
        m.cb_global = CatBoostClassifier()
        m.cb_global.load_model(str(dir_path / "cb_global.cbm"))
        m.logreg = joblib.load(dir_path / "logreg.pkl")
        m.scaler = joblib.load(dir_path / "logreg_scaler.pkl")
        m.logreg_means = np.load(dir_path / "logreg_means.npy")
        m.blender = joblib.load(dir_path / "blender.pkl")
        cal_path = dir_path / "calibrator.json"
        m.calibrator = (
            ProbabilityCalibrator.from_dict(json.loads(cal_path.read_text()))
            if cal_path.exists()
            else None
        )
        corr_path = dir_path / "corrector.json"
        m.corrector = (
            ResidualCorrector.from_dict(json.loads(corr_path.read_text()))
            if corr_path.exists()
            else None
        )
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

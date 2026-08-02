"""Discriminative conditional method model — P(ko | sub | dec) given a winner.

The Monte Carlo (`monte_carlo.py`) produces the method mix generatively, from
the ten hand-shrunk fields of `FighterMC` fed through hand-set lift formulas.
That is the whole per-fight input: no weight class, no gender, no reach, no
opponent-adjusted ratings, no Elo/Glicko, no pre-UFC record — all of which the
winner ensemble consumes. `docs/method_leg.md` Stage 0 measures what the
bottleneck costs: 82 % of the method market's edge over us is the conditional
mix, and it is finish-specific (when a KO landed the simulator had priced
0.346 against the book's 0.461).

This module models the same quantity directly. Rows are oriented WINNER
FIRST, so the target is P(method | this side won) and the features are
winner-minus-loser diffs plus per-side levels. At serve time the model is
called twice per bout — once as (A, B) for "if A wins, how", once as (B, A)
for "if B wins, how" — which makes the two conditionals independent estimates
rather than a single distribution split by a hand rule.

Sampling note: rows exist only for the side that actually won, so the fit is
an unbiased sample of P(method | side wins, X) — the selection is ON the
conditioning event, not on the target. What it does mean is that the "losing
side wins anyway" region is covered in proportion to how often upsets happen
(~35 % of bouts), so the underdog conditional is the noisier of the two.

The three learners mirror `ensemble.py` (LightGBM / CatBoost / multinomial
LogReg, blended by a weight vector selected on val), because that recipe is
already validated on this feature matrix and the point of the lab is the
target, not a new architecture.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

from .config import ARTIFACTS_DIR
from .export import swap_sides
from .features import build_feature_matrix

METHODS = ("ko", "sub", "dec")
EPS = 1e-12

# Served artifact and its split-trained twin, mirroring ensemble/ and
# ensemble_eval/: the twin is what the backtests score, so every moving part
# of a held-out number stays out-of-sample and not just the ensemble weights.
METHOD_MODEL_DIR = ARTIFACTS_DIR / "method_model"
METHOD_MODEL_EVAL_DIR = ARTIFACTS_DIR / "method_model_eval"

# Whether the per-side absolute levels below are added to the matrix. The
# GATE 0 sweep found them a tie on val (0.7633 vs 0.7627 over three seeds)
# against 65 extra columns, so the diffs-only matrix wins on parsimony.
# Flipping this is a model change: refit both artifacts, do not hand-edit.
USE_LEVELS = False

# Per-fighter columns whose ABSOLUTE level (not just the winner-loser gap)
# drives how a fight ends. The winner-model feature matrix keeps most of
# these as diffs only — a diff of zero reads the same for two knockout
# artists as for two point-fighters, which is precisely the distinction the
# method mix lives on. `build_method_features` re-adds them per side.
METHOD_LEVEL_COLUMNS = [
    "prior_finish_rate",
    "prior_wins_ko",
    "prior_wins_sub",
    "prior_losses_ko",
    "prior_losses_sub",
    "finish_against_per_bout",
    "avg_bout_seconds",
    "slpm",
    "sapm",
    "str_acc",
    "td_per15",
    "td_acc",
    "td_def",
    "sub_per15",
    "control_per_min",
    "kd_absorbed_per_fight",
    "reversals_per_fight",
    "str_off",
    "str_def",
    "grap_off",
    "grap_def",
    "kd_off",
    "kd_def",
    "ctrl_off",
    "ctrl_def",
    "preufc_ko_rate",
    "preufc_sub_rate",
    "preufc_finish_rate",
    "preufc_finish_losses",
]

# Ratios the simulator's lift formulas are built out of, handed to the model
# directly so it can learn the functional form instead of inheriting a
# hand-set one. Numerator/denominator pairs are per side; a zero denominator
# yields NaN, which the trees consume natively and the LogReg mean-imputes.
_RATE_FEATURES = [
    ("w_ko_win_rate", "prior_wins_ko", "prior_wins", "a"),
    ("w_sub_win_rate", "prior_wins_sub", "prior_wins", "a"),
    ("l_ko_loss_rate", "prior_losses_ko", "prior_losses", "b"),
    ("l_sub_loss_rate", "prior_losses_sub", "prior_losses", "b"),
    ("w_ko_loss_rate", "prior_losses_ko", "prior_losses", "a"),
    ("l_ko_win_rate", "prior_wins_ko", "prior_wins", "b"),
    ("l_sub_win_rate", "prior_wins_sub", "prior_wins", "b"),
]


def build_method_features(
    base_X: pd.DataFrame, df_oriented: pd.DataFrame, *, levels: bool = True
) -> pd.DataFrame:
    """`base_X` is `features.build_feature_matrix(df_oriented)[0]` — the winner
    model's matrix on a WINNER-FIRST frame. When `levels` is True, append the
    per-side absolute levels and hand-formula ratios the diff view destroys.

    Column order is deterministic (base order, then levels, then rates) so the
    saved `feature_columns` list is a stable contract."""
    if not levels:
        return base_X.copy()

    out = base_X.copy()
    for col in METHOD_LEVEL_COLUMNS:
        for side in ("a", "b"):
            src = f"{col}_{side}"
            name = f"mlvl_{col}_{'w' if side == 'a' else 'l'}"
            if name in out.columns:
                continue
            out[name] = (
                pd.to_numeric(df_oriented[src], errors="coerce")
                if src in df_oriented.columns
                else np.nan
            )
    for name, num, den, side in _RATE_FEATURES:
        n = pd.to_numeric(df_oriented.get(f"{num}_{side}"), errors="coerce")
        d = pd.to_numeric(df_oriented.get(f"{den}_{side}"), errors="coerce")
        with np.errstate(divide="ignore", invalid="ignore"):
            out[f"mrate_{name}"] = np.where(d.to_numpy() > 0, n.to_numpy() / d.to_numpy(), np.nan)
    return out


def orient_winner_first(
    df: pd.DataFrame, *, extra_pairs: tuple[tuple[str, str], ...] = ()
) -> pd.DataFrame:
    """Flip every bout the B side won, so slot A is always the winner.

    `swap_sides` handles the `*_a`/`*_b` schema and `market_prob_a`; anything
    else that carries a side has to be named in `extra_pairs`, and
    `target_a_wins` is flipped here because it is not an `_a`/`_b` pair
    either. `method_bucket` is deliberately NOT flipped — it is a property of
    the bout, not of a side.

    Row order and index are preserved, so row i of the result is still bout i
    of the input."""
    b_wins = (df["target_a_wins"].fillna(-1).astype(int).to_numpy() == 0)
    if not b_wins.any():
        return df.copy()
    kept = df.loc[~b_wins].copy()
    flipped = swap_sides(df.loc[b_wins])
    for a_col, b_col in extra_pairs:
        a_vals = df.loc[b_wins, a_col].to_numpy()
        flipped[a_col] = df.loc[b_wins, b_col].to_numpy()
        flipped[b_col] = a_vals
    flipped["target_a_wins"] = 1
    return pd.concat([kept, flipped]).sort_index()


def gradeable_rows(df: pd.DataFrame) -> np.ndarray:
    """Bouts whose outcome lands in the three settled buckets. DQ, draws,
    no-contests and missing methods drop out — the same rows the method
    market voids, so the model is never fitted on a payout it cannot make."""
    return (
        df["method_bucket"].isin(METHODS).to_numpy()
        & df["target_a_wins"].notna().to_numpy()
    )


def training_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray, pd.Series]:
    """`build_dataset` frame → (X, y, event_date) for the conditional fit,
    winner-first oriented and restricted to gradeable bouts."""
    sub = df.loc[gradeable_rows(df)].reset_index(drop=True)
    oriented = orient_winner_first(sub)
    base, _, _ = build_feature_matrix(oriented)
    X = build_method_features(base, oriented, levels=USE_LEVELS)
    y = np.array([METHODS.index(m) for m in sub["method_bucket"]], dtype=int)
    return X, y, pd.to_datetime(sub["event_date"])


def conditional_mix(model: MethodModel, df: pd.DataFrame) -> np.ndarray:
    """(n, 2, 3) — P(ko, sub, dec) given slot A wins, and given slot B wins.

    The model is called once per orientation, so the two conditionals are
    independent estimates rather than one distribution split by a shared
    rule. That is the failure the round lab found in `_decision_logit`: a
    single hand-weighted number decided both sides at once, and when it was
    wrong it was wrong on both."""
    out = np.empty((len(df), 2, 3))
    for s, frame in enumerate((df, swap_sides(df))):
        base, _, _ = build_feature_matrix(frame)
        X = build_method_features(base, frame, levels=model.use_levels)
        out[:, s, :] = model.predict_cond(X[model.feature_columns])
    return out


LGB_MULTI_PARAMS: dict[str, Any] = {
    "objective": "multiclass",
    "num_class": 3,
    "metric": "multi_logloss",
    "learning_rate": 0.04,
    "num_leaves": 15,
    "min_data_in_leaf": 120,
    "feature_fraction": 0.6,
    "bagging_fraction": 0.7,
    "bagging_freq": 4,
    "lambda_l1": 0.05,
    "lambda_l2": 1.0,
    "max_depth": 4,
    "verbosity": -1,
    "seed": 42,
    "deterministic": True,
    "force_row_wise": True,
}
LGB_NUM_ROUNDS = 3000
LGB_EARLY_STOPPING = 150


def _cb_params(seed: int) -> dict[str, Any]:
    return {
        "iterations": 3000,
        "learning_rate": 0.04,
        "depth": 5,
        "loss_function": "MultiClass",
        "eval_metric": "MultiClass",
        "l2_leaf_reg": 6.0,
        "random_seed": seed,
        "verbose": 0,
        "allow_writing_files": False,
    }


def _multiclass_logloss(y: np.ndarray, p: np.ndarray) -> float:
    return float(-np.log(np.clip(p[np.arange(len(y)), y], EPS, 1.0)).mean())


@dataclass
class MethodModel:
    """Fitted conditional method model. `predict_cond(X)` returns an (n, 3)
    matrix of P(ko), P(sub), P(dec) GIVEN the side in slot A wins."""

    feature_columns: list[str] = field(default_factory=list)
    use_levels: bool = True
    weights: dict[str, float] = field(default_factory=dict)
    best_iters: dict[str, int] = field(default_factory=dict)
    lgb_model: lgb.Booster | None = None
    cb_model: CatBoostClassifier | None = None
    logreg: LogisticRegression | None = None
    scaler: StandardScaler | None = None
    col_means: np.ndarray | None = None
    val_metrics: dict[str, Any] = field(default_factory=dict)

    # ── individual learners ────────────────────────────────────────────

    def _fit_lgb(self, X_tr, y_tr, X_va, y_va, seed: int, w_tr=None) -> lgb.Booster:
        params = {**LGB_MULTI_PARAMS, "seed": seed}
        dtr = lgb.Dataset(X_tr, label=y_tr, weight=w_tr)
        dva = lgb.Dataset(X_va, label=y_va, reference=dtr)
        return lgb.train(
            params,
            dtr,
            num_boost_round=LGB_NUM_ROUNDS,
            valid_sets=[dva],
            valid_names=["val"],
            callbacks=[lgb.early_stopping(LGB_EARLY_STOPPING, verbose=False)],
        )

    def _fit_cb(self, X_tr, y_tr, X_va, y_va, seed: int, w_tr=None) -> CatBoostClassifier:
        m = CatBoostClassifier(**_cb_params(seed), early_stopping_rounds=150)
        m.fit(X_tr, y_tr, sample_weight=w_tr, eval_set=(X_va, y_va))
        return m

    def _fit_logreg(self, X_tr, y_tr, w_tr=None):
        means = X_tr.mean(numeric_only=True).fillna(0.0)
        Xf = X_tr.fillna(means).fillna(0.0).to_numpy(dtype=np.float64)
        scaler = StandardScaler().fit(Xf)
        clf = LogisticRegression(max_iter=1000, C=0.3, solver="lbfgs", random_state=42)
        clf.fit(scaler.transform(Xf), y_tr, sample_weight=w_tr)
        return clf, scaler, means.to_numpy(dtype=np.float64)

    def _logreg_proba(self, X: pd.DataFrame) -> np.ndarray:
        assert self.logreg is not None and self.scaler is not None
        means = pd.Series(self.col_means, index=self.feature_columns)
        Xf = X[self.feature_columns].fillna(means).fillna(0.0).to_numpy(dtype=np.float64)
        return self.logreg.predict_proba(self.scaler.transform(Xf))

    def _base_probs(self, X: pd.DataFrame) -> dict[str, np.ndarray]:
        Xc = X[self.feature_columns]
        out: dict[str, np.ndarray] = {}
        if self.lgb_model is not None:
            out["lgb"] = self.lgb_model.predict(
                Xc, num_iteration=self.lgb_model.best_iteration or None
            )
        if self.cb_model is not None:
            out["cb"] = self.cb_model.predict_proba(Xc)
        if self.logreg is not None:
            out["logreg"] = self._logreg_proba(Xc)
        return out

    # ── fit ────────────────────────────────────────────────────────────

    def fit(
        self,
        X_tr: pd.DataFrame,
        y_tr: np.ndarray,
        X_va: pd.DataFrame,
        y_va: np.ndarray,
        *,
        seed: int = 42,
        sample_weight: np.ndarray | None = None,
    ) -> MethodModel:
        self.feature_columns = list(X_tr.columns)
        X_tr = X_tr[self.feature_columns]
        X_va = X_va[self.feature_columns]

        self.lgb_model = self._fit_lgb(X_tr, y_tr, X_va, y_va, seed, sample_weight)
        self.cb_model = self._fit_cb(X_tr, y_tr, X_va, y_va, seed, sample_weight)
        self.logreg, self.scaler, self.col_means = self._fit_logreg(
            X_tr, y_tr, sample_weight
        )
        self.best_iters = {
            "lgb": int(self.lgb_model.best_iteration or LGB_NUM_ROUNDS),
            "cb": int(self.cb_model.get_best_iteration() or 0) + 1,
        }

        # Blend weights: a coarse simplex search on val. The winner ensemble
        # fits a LogReg blender on three scalars; with three 3-vectors that
        # would need a 9-parameter multinomial fitted on a few hundred val
        # rows, so the search is over a 0.1 grid instead — fewer degrees of
        # freedom, and the grid is reported in full for auditability.
        base = self._base_probs(X_va)
        names = list(base)
        solo = {k: _multiclass_logloss(y_va, v) for k, v in base.items()}
        best_w, best_ll = None, np.inf
        grid = np.arange(0.0, 1.0001, 0.1)
        for wl in grid:
            for wc in grid:
                if wl + wc > 1.0 + 1e-9:
                    continue
                wr = 1.0 - wl - wc
                cand = {"lgb": wl, "cb": wc, "logreg": wr}
                p = sum(cand[k] * base[k] for k in names)
                ll = _multiclass_logloss(y_va, p)
                if ll < best_ll - 1e-12:
                    best_ll, best_w = ll, cand
        self.weights = best_w or dict.fromkeys(names, 1.0 / len(names))
        self.val_metrics = {
            "solo_logloss": solo,
            "blend_logloss": float(best_ll),
            "weights": self.weights,
            "n_train": int(len(X_tr)),
            "n_val": int(len(X_va)),
        }
        return self

    def refit_fixed(
        self,
        X: pd.DataFrame,
        y: np.ndarray,
        *,
        seed: int = 42,
        sample_weight: np.ndarray | None = None,
    ) -> MethodModel:
        """Refit every learner on ALL rows for the iteration counts the
        split-trained run selected, keeping the val-selected blend weights.
        Mirrors `EnsembleModel.refit_on_all`."""
        X = X[self.feature_columns]
        params = {**LGB_MULTI_PARAMS, "seed": seed}
        self.lgb_model = lgb.train(
            params,
            lgb.Dataset(X, label=y, weight=sample_weight),
            num_boost_round=max(1, self.best_iters.get("lgb", LGB_NUM_ROUNDS)),
        )
        cb_params = {**_cb_params(seed), "iterations": max(1, self.best_iters.get("cb", 500))}
        self.cb_model = CatBoostClassifier(**cb_params)
        self.cb_model.fit(X, y, sample_weight=sample_weight)
        self.logreg, self.scaler, self.col_means = self._fit_logreg(X, y, sample_weight)
        return self

    # ── predict ────────────────────────────────────────────────────────

    def predict_cond(self, X: pd.DataFrame) -> np.ndarray:
        base = self._base_probs(X)
        w = self.weights or dict.fromkeys(base, 1.0 / len(base))
        p = sum(w.get(k, 0.0) * v for k, v in base.items())
        p = np.clip(np.asarray(p, dtype=float), EPS, None)
        return p / p.sum(axis=1, keepdims=True)

    # ── persistence ────────────────────────────────────────────────────

    def save(self, dir_path: Path) -> None:
        dir_path.mkdir(parents=True, exist_ok=True)
        assert self.lgb_model is not None
        self.lgb_model.save_model(str(dir_path / "lgb.txt"))
        assert self.cb_model is not None
        self.cb_model.save_model(str(dir_path / "cb.cbm"))
        joblib.dump(self.logreg, dir_path / "logreg.pkl")
        joblib.dump(self.scaler, dir_path / "logreg_scaler.pkl")
        (dir_path / "meta.json").write_text(
            json.dumps(
                {
                    "feature_columns": self.feature_columns,
                    "use_levels": self.use_levels,
                    "weights": self.weights,
                    "best_iters": self.best_iters,
                    "col_means": (
                        None if self.col_means is None else [float(x) for x in self.col_means]
                    ),
                    "classes": list(METHODS),
                    "val_metrics": self.val_metrics,
                },
                indent=2,
            )
        )

    @classmethod
    def load(cls, dir_path: Path) -> MethodModel:
        meta = json.loads((dir_path / "meta.json").read_text())
        m = cls(
            feature_columns=meta["feature_columns"],
            use_levels=meta.get("use_levels", True),
            weights=meta.get("weights", {}),
            best_iters=meta.get("best_iters", {}),
            val_metrics=meta.get("val_metrics", {}),
        )
        m.lgb_model = lgb.Booster(model_file=str(dir_path / "lgb.txt"))
        m.cb_model = CatBoostClassifier()
        m.cb_model.load_model(str(dir_path / "cb.cbm"))
        m.logreg = joblib.load(dir_path / "logreg.pkl")
        m.scaler = joblib.load(dir_path / "logreg_scaler.pkl")
        cm = meta.get("col_means")
        m.col_means = None if cm is None else np.asarray(cm, dtype=float)
        return m

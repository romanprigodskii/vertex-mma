"""Shared fitting harness for winner-leg labs.

Every lever tested on the winner model needs the same thing: train the served
three-learner recipe under one changed condition, then score it the way
production scores it (order-averaged over both fighter orderings) on val and
test. Doing that inline in each lab is how two labs end up comparing numbers
that were not measured the same way, so it lives here once.

What a caller can change, and nothing else:
  * `extra_block`   — a callable adding feature columns (e.g. the rank block)
  * `drop_columns`  — remove served columns (e.g. the leaked title flag)
  * `augment`       — train on both fighter orderings instead of one
  * `halflife_years`— exponential recency weights on training rows
  * `lgb_overrides` — hyperparameter deltas
  * `seed`          — reaches LightGBM AND CatBoost, so a seed-stability claim
                      is not vacuous (two thirds of the blend would be frozen
                      if only the LGB seed moved)

VAL is the only thing a lab may select on. `test` is computed here so a lab
does not have to re-derive it, but reading it before the gate has been decided
is the mistake this whole directory is organized to prevent.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from eval_tail_buckets import bucket_table, headline, murphy  # noqa: E402

from src.config import (  # noqa: E402
    FEATURE_CONTRI_OVERRIDES,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
)
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import swap_sides  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.train import _load_tuned_params, temporal_split  # noqa: E402


@dataclass
class ArmResult:
    """One (config, seed) fit, scored the way production serves."""

    seed: int
    label: str
    val: dict[str, float]
    test: dict[str, float]
    val_buckets: list[dict[str, float]] = field(default_factory=list)
    test_buckets: list[dict[str, float]] = field(default_factory=list)
    test_murphy: dict[str, float] = field(default_factory=dict)
    blend_mode: str = ""
    n_features: int = 0
    n_train_rows: int = 0
    probs_test: np.ndarray | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "label": self.label,
            "val": self.val,
            "test": self.test,
            "val_buckets": self.val_buckets,
            "test_buckets": self.test_buckets,
            "test_murphy": self.test_murphy,
            "blend_mode": self.blend_mode,
            "n_features": self.n_features,
            "n_train_rows": self.n_train_rows,
        }


def build_matrices(
    df: pd.DataFrame,
    extra_block: Callable[[pd.DataFrame], pd.DataFrame] | None = None,
    extra_args: dict[str, Any] | None = None,
    drop_columns: tuple[str, ...] = (),
) -> tuple[pd.DataFrame, pd.DataFrame, pd.Series, pd.DataFrame, list[str]]:
    """(X, X_swapped, y, meta, columns) for the given frame.

    The swapped matrix is rebuilt from `swap_sides(df)`, never by permuting
    columns of X — the stance one-hots and every `abs_*_a/_b` pair are exactly
    the columns a naive permutation gets wrong, and they are the ones that
    break antisymmetry.
    """
    cols = [c for c in feature_names() if c not in drop_columns]
    X, y, meta = build_feature_matrix(df)
    df_sw = swap_sides(df)
    X_sw, _, _ = build_feature_matrix(df_sw)
    X, X_sw = X[cols].copy(), X_sw[cols].copy()

    if extra_block is not None:
        args = extra_args or {}
        block = extra_block(df, **args)
        block_sw = extra_block(df_sw, **args)
        assert list(block.columns) == list(block_sw.columns)
        cols = cols + list(block.columns)
        X = pd.concat([X, block.set_index(X.index)], axis=1)
        X_sw = pd.concat([X_sw, block_sw.set_index(X_sw.index)], axis=1)

    return X, X_sw, y, meta, cols


def _recency_weights(dates: pd.Series, halflife_years: float | None) -> np.ndarray | None:
    if halflife_years is None:
        return None
    d = pd.to_datetime(dates)
    age_years = (d.max() - d).dt.days.to_numpy() / 365.25
    return np.asarray(0.5 ** (age_years / halflife_years), dtype=float)


def fit_arm(
    df: pd.DataFrame,
    *,
    label: str = "arm",
    extra_block: Callable[[pd.DataFrame], pd.DataFrame] | None = None,
    extra_args: dict[str, Any] | None = None,
    extra_columns: list[str] | None = None,  # accepted for symmetry; unused
    drop_columns: tuple[str, ...] = (),
    augment: str = "none",
    halflife_years: float | None = None,
    lgb_overrides: dict[str, Any] | None = None,
    seed: int = 42,
    keep_probs: bool = False,
    **_ignored: Any,
) -> ArmResult:
    """Train one arm and score it on val and test, order-averaged.

    `augment` is the only option that changes the SHAPE of training rather than
    their content: with "train" (or "train+val") every bout enters twice, once
    per fighter ordering, with the target flipped on the second copy. That adds
    no information — it states the symmetry the served path already assumes by
    averaging both orderings, and which the model currently only approximates.
    """
    X, X_sw, y, meta, cols = build_matrices(df, extra_block, extra_args, drop_columns)
    Xs, ys, metas = temporal_split(X, y, meta)
    Xsw_s, _, _ = temporal_split(X_sw, y, meta)

    tuned = _load_tuned_params()
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        **(lgb_overrides or {}),
        "seed": seed,
        "feature_contri": [FEATURE_CONTRI_OVERRIDES.get(c, 1.0) for c in cols],
    }
    model = EnsembleModel(
        feature_columns=cols,
        lgb_params=lgb_params,
        lgb_num_rounds=LGB_NUM_ROUNDS,
        lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
    )
    if seed != 42:
        model._cb_params = staticmethod(  # type: ignore[method-assign]
            lambda: {**EnsembleModel._cb_params(), "random_seed": seed}
        ).__func__

    X_tr, y_tr = Xs["train"].reset_index(drop=True), ys["train"].reset_index(drop=True)
    X_va, y_va = Xs["val"].reset_index(drop=True), ys["val"].reset_index(drop=True)
    w_tr = _recency_weights(metas["train"]["event_date"], halflife_years)

    if augment in ("train", "train+val"):
        X_tr = pd.concat([X_tr, Xsw_s["train"].reset_index(drop=True)], ignore_index=True)
        y_tr = pd.concat([y_tr, (1 - y_tr.iloc[: len(ys["train"])])], ignore_index=True)
        if w_tr is not None:
            w_tr = np.concatenate([w_tr, w_tr])
    if augment == "train+val":
        n_va = len(y_va)
        X_va = pd.concat([X_va, Xsw_s["val"].reset_index(drop=True)], ignore_index=True)
        y_va = pd.concat([y_va, (1 - y_va.iloc[:n_va])], ignore_index=True)

    model.fit(X_train=X_tr, y_train=y_tr, X_val=X_va, y_val=y_va, sample_weight=w_tr)

    def score(name: str) -> tuple[dict, list, np.ndarray]:
        p = model.predict_proba_a(Xs[name].reset_index(drop=True))
        p_sw = model.predict_proba_a(Xsw_s[name].reset_index(drop=True))
        probs = 0.5 * (p + (1.0 - p_sw))
        yy = ys[name].to_numpy().astype(int)
        mk = metas[name]["market_prob_a"].to_numpy(dtype=float)
        return headline(probs, yy), bucket_table(probs, mk, yy), probs

    val_h, val_b, _ = score("val")
    test_h, test_b, p_test = score("test")
    return ArmResult(
        seed=seed,
        label=label,
        val=val_h,
        test=test_h,
        val_buckets=val_b,
        test_buckets=test_b,
        test_murphy=murphy(p_test, ys["test"].to_numpy().astype(int)),
        blend_mode=getattr(model, "_blend_mode", ""),
        n_features=len(cols),
        n_train_rows=int(len(X_tr)),
        probs_test=p_test if keep_probs else None,
    )


# ── walk-forward out-of-fold evaluation ────────────────────────────────
#
# The 429-row val split is the weakest instrument in this directory. It is what
# picked the 3-parameter piecewise calibrator that turned out to be the worst
# family on test (docs/tail_resolution.md), and a lever worth 0.003 nats is
# simply not measurable on it. Walk-forward OOF scores ~3,100 bouts the model
# never saw, at production's own retrain cadence, and still never touches the
# 2025+ test window — so it can carry the SELECTION that val cannot.

OOF_START = "2017-01-01"
OOF_END = "2025-01-01"   # == VAL_END. Test stays untouched by construction.
OOF_STEP_MONTHS = 3
OOF_VAL_MONTHS = 12


def walk_forward(
    df: pd.DataFrame,
    *,
    label: str = "arm",
    extra_block: Callable[[pd.DataFrame], pd.DataFrame] | None = None,
    extra_args: dict[str, Any] | None = None,
    drop_columns: tuple[str, ...] = (),
    augment: str = "none",
    halflife_years: float | None = None,
    lgb_overrides: dict[str, Any] | None = None,
    seed: int = 42,
    start: str = OOF_START,
    end: str = OOF_END,
    verbose: bool = False,
) -> pd.DataFrame:
    """Per-origin refit, scored on the quarter that follows it.

    Mirrors run_rolling_backtest / lab_oof_calibration exactly:
        train  event_date <  origin − 12mo
        val    [origin − 12mo, origin)      early stop + blender + mode
        score  [origin, origin + 3mo)       never seen, never fit
    """
    X, X_sw, y, meta, cols = build_matrices(df, extra_block, extra_args, drop_columns)
    dates = pd.to_datetime(meta["event_date"])
    market = meta["market_prob_a"].to_numpy(dtype=float)

    tuned = _load_tuned_params()
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        **(lgb_overrides or {}),
        "seed": seed,
        "feature_contri": [FEATURE_CONTRI_OVERRIDES.get(c, 1.0) for c in cols],
    }

    rows = []
    origin = pd.to_datetime(start)
    stop = pd.to_datetime(end)
    while origin < stop:
        nxt = origin + pd.DateOffset(months=OOF_STEP_MONTHS)
        val_start = origin - pd.DateOffset(months=OOF_VAL_MONTHS)
        tr = (dates < val_start).to_numpy()
        va = ((dates >= val_start) & (dates < origin)).to_numpy()
        sc = ((dates >= origin) & (dates < min(nxt, stop))).to_numpy()
        if tr.sum() < 500 or va.sum() < 50 or sc.sum() == 0:
            origin = nxt
            continue

        model = EnsembleModel(
            feature_columns=cols,
            lgb_params=lgb_params,
            lgb_num_rounds=LGB_NUM_ROUNDS,
            lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
        )
        if seed != 42:
            model._cb_params = staticmethod(  # type: ignore[method-assign]
                lambda: {**EnsembleModel._cb_params(), "random_seed": seed}
            ).__func__

        X_tr = X.loc[tr].reset_index(drop=True)
        y_tr = y.loc[tr].reset_index(drop=True)
        X_va = X.loc[va].reset_index(drop=True)
        y_va = y.loc[va].reset_index(drop=True)
        w_tr = _recency_weights(meta.loc[tr, "event_date"], halflife_years)
        if augment in ("train", "train+val"):
            n_tr = len(y_tr)
            X_tr = pd.concat([X_tr, X_sw.loc[tr].reset_index(drop=True)], ignore_index=True)
            y_tr = pd.concat([y_tr, 1 - y_tr.iloc[:n_tr]], ignore_index=True)
            if w_tr is not None:
                w_tr = np.concatenate([w_tr, w_tr])
        if augment == "train+val":
            n_va = len(y_va)
            X_va = pd.concat([X_va, X_sw.loc[va].reset_index(drop=True)], ignore_index=True)
            y_va = pd.concat([y_va, 1 - y_va.iloc[:n_va]], ignore_index=True)

        model.fit(X_train=X_tr, y_train=y_tr, X_val=X_va, y_val=y_va, sample_weight=w_tr)
        p = model.predict_proba_a(X.loc[sc].reset_index(drop=True))
        p_sw = model.predict_proba_a(X_sw.loc[sc].reset_index(drop=True))
        rows.append(
            pd.DataFrame(
                {
                    "origin": str(origin.date()),
                    "label": label,
                    "seed": seed,
                    "bout_id": meta.loc[sc, "bout_id"].to_numpy(),
                    "p": 0.5 * (p + (1.0 - p_sw)),
                    "p_raw": p,
                    "p_sw": p_sw,
                    "y": y.loc[sc].to_numpy().astype(int),
                    "market": market[sc],
                }
            )
        )
        if verbose:
            print(
                f"    origin {origin.date()}  train {int(tr.sum()):5d}  val {int(va.sum()):4d}  "
                f"scored {int(sc.sum()):4d}"
            )
        origin = nxt
    return pd.concat(rows, ignore_index=True)


def oof_logloss(frame: pd.DataFrame) -> float:
    p = np.clip(frame["p"].to_numpy(dtype=float), 1e-6, 1 - 1e-6)
    yy = frame["y"].to_numpy(dtype=float)
    return float(-(yy * np.log(p) + (1 - yy) * np.log(1 - p)).mean())


def paired_bootstrap(
    cand: pd.DataFrame, base: pd.DataFrame, n: int = 4000, seed: int = 11
) -> dict[str, float]:
    """Per-bout log-loss difference (cand − base) with a percentile interval.

    Both frames must cover the same bouts in the same order — the caller aligns
    on bout_id, because an unaligned "paired" bootstrap silently becomes an
    unpaired one and the interval it reports is too wide to fail anything.
    """
    assert (cand["bout_id"].to_numpy() == base["bout_id"].to_numpy()).all(), "unaligned"
    eps = 1e-6
    yy = cand["y"].to_numpy(dtype=float)
    lc = -(yy * np.log(np.clip(cand["p"], eps, 1 - eps))
           + (1 - yy) * np.log(np.clip(1 - cand["p"], eps, 1 - eps)))
    lb = -(yy * np.log(np.clip(base["p"], eps, 1 - eps))
           + (1 - yy) * np.log(np.clip(1 - base["p"], eps, 1 - eps)))
    d = (lc - lb).to_numpy()
    rng = np.random.default_rng(seed)
    boots = np.array([d[rng.integers(0, len(d), len(d))].mean() for _ in range(n)])
    return {
        "delta": float(d.mean()),
        "lo": float(np.percentile(boots, 2.5)),
        "hi": float(np.percentile(boots, 97.5)),
        "frac_improving": float((boots < 0).mean()),
    }


def median_delta(base: list[dict], cand: list[dict], split: str = "val") -> float:
    return float(
        np.median(
            [c[split]["logloss"] - b[split]["logloss"] for b, c in zip(base, cand, strict=True)]
        )
    )

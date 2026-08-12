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
from src.features import (  # noqa: E402
    build_debut_matrix,
    build_feature_matrix,
    debut_feature_names,
    feature_names,
)
from src.train import (  # noqa: E402
    DEBUT_EXP_ROW_WEIGHT,
    _load_tuned_params,
    temporal_split,
)


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


def _apply_blend_override(
    model: EnsembleModel,
    force_blend_mode: str | None,
    force_blend_weights: list[float] | None,
) -> None:
    """Replace the blend rule chosen inside `fit()` on the val split.

    Worth having a knob for, because the shipped rule is stranger than it
    looks: `weighted_mean` weights are softmax(−val_logloss / std of the three
    val log-losses). Dividing by the std of THREE numbers makes the softmax
    temperature depend on how close the learners happened to land on 429 rows,
    so a 0.01 spread turns into weights of 0.07 / 0.17 / 0.76. The current
    served model puts 76 % of its blend on the LogReg leg for exactly that
    reason. Whether that is a good rule or an artefact of the scale is a
    question only a bigger sample can answer.
    """
    if force_blend_weights is not None:
        w = np.asarray(force_blend_weights, dtype=float)
        model._blend_weights = (w / w.sum()).tolist()
        model._blend_mode = "weighted_mean"
    elif force_blend_mode is not None:
        model._blend_mode = force_blend_mode


def _bind_cb_params(
    model: EnsembleModel, cb_overrides: dict[str, Any] | None, seed: int
) -> None:
    """Rebind CatBoost's parameter factory on this instance.

    `_cb_params` is a staticmethod baked into EnsembleModel, so a lab that
    wants a different depth — or just a different seed — has to replace it
    here. Worth doing carefully rather than skipping: CatBoost is the strongest
    single learner on every eval, and leaving its seed frozen while LightGBM's
    moves would make any seed-stability claim vacuous.
    """
    overrides = dict(cb_overrides or {})
    if seed != 42:
        overrides["random_seed"] = seed
    if not overrides:
        return
    model._cb_params = staticmethod(  # type: ignore[method-assign]
        lambda: {**EnsembleModel._cb_params(), **overrides}
    ).__func__


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
    cb_overrides: dict[str, Any] | None = None,
    feature_contri: dict[str, float] | None = None,
    force_blend_mode: str | None = None,
    force_blend_weights: list[float] | None = None,
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
    contri = FEATURE_CONTRI_OVERRIDES if feature_contri is None else feature_contri
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        **(lgb_overrides or {}),
        "seed": seed,
        "feature_contri": [contri.get(c, 1.0) for c in cols],
    }
    model = EnsembleModel(
        feature_columns=cols,
        lgb_params=lgb_params,
        lgb_num_rounds=LGB_NUM_ROUNDS,
        lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
    )
    _bind_cb_params(model, cb_overrides, seed)

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
    _apply_blend_override(model, force_blend_mode, force_blend_weights)

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


def iter_origins(
    dates: pd.Series,
    *,
    start: str = OOF_START,
    end: str = OOF_END,
    step_months: int = OOF_STEP_MONTHS,
    val_months: int = OOF_VAL_MONTHS,
    min_train: int = 500,
    min_val: int = 50,
):
    """Yield `(origin, train_mask, val_mask, score_mask)` per quarterly origin.

    The schedule, extracted so that objects other than the winner ensemble can
    be measured on the SAME instrument rather than on a re-implementation of
    it. That matters more than it sounds: the method leg selects on 428 val
    rows and the debut specialist on 84, both of them smaller than the 429-row
    val split this directory already documented as unable to resolve the
    effects it was being asked about — and a second, subtly different
    walk-forward would make those two numbers incomparable with the winner
    leg's.

    Masks are plain boolean arrays over the caller's frame, so a caller that
    fits on everything and scores on a subset (the debut specialist) just
    intersects `score_mask` with its own segment mask.
    """
    origin = pd.to_datetime(start)
    stop = pd.to_datetime(end)
    while origin < stop:
        nxt = origin + pd.DateOffset(months=step_months)
        val_start = origin - pd.DateOffset(months=val_months)
        tr = (dates < val_start).to_numpy()
        va = ((dates >= val_start) & (dates < origin)).to_numpy()
        sc = ((dates >= origin) & (dates < min(nxt, stop))).to_numpy()
        if tr.sum() < min_train or va.sum() < min_val or sc.sum() == 0:
            origin = nxt
            continue
        yield origin, tr, va, sc
        origin = nxt


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
    cb_overrides: dict[str, Any] | None = None,
    feature_contri: dict[str, float] | None = None,
    force_blend_mode: str | None = None,
    force_blend_weights: list[float] | None = None,
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
    contri = FEATURE_CONTRI_OVERRIDES if feature_contri is None else feature_contri
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        **(lgb_overrides or {}),
        "seed": seed,
        "feature_contri": [contri.get(c, 1.0) for c in cols],
    }

    rows = []
    for origin, tr, va, sc in iter_origins(dates, start=start, end=end):
        model = EnsembleModel(
            feature_columns=cols,
            lgb_params=lgb_params,
            lgb_num_rounds=LGB_NUM_ROUNDS,
            lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
        )
        _bind_cb_params(model, cb_overrides, seed)

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
        _apply_blend_override(model, force_blend_mode, force_blend_weights)
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
    return pd.concat(rows, ignore_index=True)


def walk_forward_debut(
    df: pd.DataFrame,
    *,
    label: str = "baseline",
    seed: int = 42,
    columns: list[str] | None = None,
    levels: bool = False,
    corrector: Any | None = None,
    start: str = OOF_START,
    end: str = OOF_END,
    min_val_debut: int = 20,
    verbose: bool = False,
) -> pd.DataFrame:
    """Walk-forward OOF pool for the DEBUT specialist.

    The specialist is the worst-measured object in this tree. `train.py:436`
    picks its early-stopping round, its blender and its blend mode on the
    debut rows inside the 2024 val window — 84 of them. `tail_resolution.md`
    retired a 429-row instrument for being unable to resolve the effects it
    was asked about; this one is five times smaller, and every v0.8.0-era
    claim about the specialist rests on it.

    Production recipe, reproduced exactly (`train.py:415-479`): fit on ALL
    rows with both-experienced bouts down-weighted to `DEBUT_EXP_ROW_WEIGHT`,
    select on DEBUT rows only, serve on debut rows only. The only thing that
    changes here is the split — quarterly origins instead of one static 2024
    window.

    `corrector` attaches a `ResidualCorrector` after the blend, which
    production does NOT do for the specialist (`train.py` assigns `.corrector`
    only on the main ensemble, at :365). That is the open question at the end
    of docs/winner_batch.md, and this is the pool it needs.
    """
    cols = (
        list(columns)
        if columns is not None
        else debut_feature_names(levels=levels)
    )
    X, y, meta = build_debut_matrix(df, levels=levels)
    X = X[cols]
    df_sw = swap_sides(df)
    # Rebuilt from the swapped FRAME, never by permuting columns of X — the
    # `dlvl_*_a/_b` pairs are exactly what a naive permutation gets wrong,
    # and getting them wrong breaks the antisymmetry the order averaging
    # below depends on.
    X_sw, _, _ = build_debut_matrix(df_sw, levels=levels)
    X_sw = X_sw[cols]

    debut = (df["is_debut_a"].astype(bool) | df["is_debut_b"].astype(bool)).to_numpy()
    weights_all = np.where(debut, 1.0, DEBUT_EXP_ROW_WEIGHT)
    dates = pd.to_datetime(meta["event_date"])
    market = meta["market_prob_a"].to_numpy(dtype=float)

    tuned = _load_tuned_params()
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        "seed": seed,
        "feature_contri": [FEATURE_CONTRI_OVERRIDES.get(c, 1.0) for c in cols],
    }

    rows = []
    for origin, tr, va, sc in iter_origins(dates, start=start, end=end):
        va_d = va & debut
        sc_d = sc & debut
        # Guarded on the DEBUT counts, not the full ones. An origin whose val
        # window holds four debutants would pick an early-stopping round from
        # noise, and the pool would inherit it silently.
        if va_d.sum() < min_val_debut or sc_d.sum() == 0:
            if verbose:
                print(
                    f"    origin {origin.date()}  SKIP (val debut {int(va_d.sum())}, "
                    f"scored debut {int(sc_d.sum())})"
                )
            continue

        model = EnsembleModel(
            feature_columns=cols,
            lgb_params=lgb_params,
            lgb_num_rounds=LGB_NUM_ROUNDS,
            lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
        )
        _bind_cb_params(model, None, seed)
        model.fit(
            X_train=X.loc[tr].reset_index(drop=True),
            y_train=y.loc[tr].reset_index(drop=True),
            X_val=X.loc[va_d].reset_index(drop=True),
            y_val=y.loc[va_d].reset_index(drop=True),
            sample_weight=weights_all[tr],
        )
        model.corrector = corrector

        p = model.predict_proba_a(X.loc[sc_d].reset_index(drop=True))
        p_sw = model.predict_proba_a(X_sw.loc[sc_d].reset_index(drop=True))
        rows.append(
            pd.DataFrame(
                {
                    "origin": str(origin.date()),
                    "label": label,
                    "seed": seed,
                    "bout_id": meta.loc[sc_d, "bout_id"].to_numpy(),
                    "p": 0.5 * (p + (1.0 - p_sw)),
                    "p_raw": p,
                    "p_sw": p_sw,
                    "y": y.loc[sc_d].to_numpy().astype(int),
                    "market": market[sc_d],
                }
            )
        )
        if verbose:
            print(
                f"    origin {origin.date()}  train {int(tr.sum()):5d}  "
                f"val debut {int(va_d.sum()):3d}  scored debut {int(sc_d.sum()):3d}"
            )
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

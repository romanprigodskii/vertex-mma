"""LAB — lever 2: is the tail compression created in the MODEL rather than at
the output?

Two suspects from the brief, plus one the brief's own docstring points at.

2a. THE BLENDER IS ~80% LINEAR. Current weights are p_lgb 0.081 / p_cb 0.120 /
    p_logreg 0.799 under blend_mode=weighted_mean. A LogReg on 118 features
    structurally compresses tails, and averaging the three learners'
    PROBABILITIES compresses them again (Jensen — ensemble.py's docstring
    already flags the output as under-dispersed for exactly this reason).
    So this tests five modes, not three: the three shipped ones plus averaging
    the learners in LOGIT space, which is the same weights without the Jensen
    pull. (Distinct from the rejected idea in the brief's §1 — that was
    averaging over fighter ORDER in logit space, which is a different average.)

2b. AGE IS THROTTLED BY HAND. config.FEATURE_CONTRI_OVERRIDES puts diff_age at
    0.45 and abs_age_a/_b at 0.5, set for SHAP-attribution aesthetics rather
    than accuracy. Age is exactly what separates a 24-year-old prospect from a
    38-year-old veteran — i.e. exactly the tail. NOTE BEFORE MEASURING:
    `feature_contri` is a LightGBM-only parameter, and LightGBM carries 8% of
    the blend, so this knob can move the SHAP display (which is sourced from
    the global LGB) far more than it can move the served probability. The
    measurement below is what decides it, but that is the prior.

Evaluated on TWO bases, because n=568 cannot resolve what we are looking for:
  * the static test split (2025+, 568 bouts with odds) — the brief's basis and
    the gate;
  * a 32-origin quarterly walk-forward over 2017-2024 (production's own
    rolling recipe), pooling ~3.1k out-of-sample bouts, ~1.2k with odds.
Both get the four-bucket table. A change is only interesting if it moves the
same direction on both.

Blend modes are computed from ONE fit per config: the base-learner matrix is
scored once and each mode is a different reduction of it, so five modes cost
one training run rather than five.

GATE 2 = GATE 1's four conditions (val logloss up, 0.50-0.55 bucket not
degraded, 0.72+ clearly better, accuracy not down) plus sign stability across
seeds.

Usage (scripts/simulation, venv active):
  python scripts/lab_blend_age.py [--cache] [--skip-oof] [--seeds 42,7,13]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from eval_tail_buckets import (  # noqa: E402
    EPS,
    bucket_table,
    headline,
    load_symmetrized,
    murphy,
    print_bucket_table,
)
from run_rolling_backtest import VAL_MONTHS  # noqa: E402
from sklearn.metrics import log_loss  # noqa: E402

from src.config import (  # noqa: E402
    ARTIFACTS_DIR,
    FEATURE_CONTRI_OVERRIDES,
    LGB_EARLY_STOPPING_ROUNDS,
    LGB_NUM_ROUNDS,
    LGB_PARAMS,
    TRAIN_END,
    VAL_END,
)
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import swap_sides  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402
from src.train import _load_tuned_params  # noqa: E402

OUT_PATH = ARTIFACTS_DIR / "lab_blend_age.json"

BLEND_MODES = (
    "logreg",
    "mean",
    "weighted_mean",
    "logit_mean",
    "weighted_logit_mean",
    # Not blends — the three learners on their own. If the blend compresses
    # the tail, at least one leg has to be sharper than the blend; if none is,
    # the compression is upstream of the blender and lever 2a is dead on
    # arrival regardless of which mode we pick.
    "solo_lgb",
    "solo_cb",
    "solo_logreg",
)

# Age-throttle configurations. "current" is what ships.
AGE_CONFIGS: dict[str, dict[str, float]] = {
    "current": dict(FEATURE_CONTRI_OVERRIDES),
    "age_half_off": {"diff_age": 0.7, "abs_age_a": 0.75, "abs_age_b": 0.75},
    "age_off": {},
}

OOF_START = "2017-01-01"
OOF_END = VAL_END  # never cross the test boundary
STEP_MONTHS = 3


def _logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(p, EPS, 1 - EPS)
    return np.log(p / (1 - p))


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -50, 50)))


def blend(base: np.ndarray, mode: str, model: EnsembleModel) -> np.ndarray:
    """Reduce the [p_lgb, p_cb, p_logreg] matrix to one probability.

    The three shipped modes replicate EnsembleModel.predict_proba_a exactly;
    the two logit modes apply the SAME weights in logit space, which is the
    only difference — it removes the Jensen pull toward 0.5 that averaging
    probabilities introduces.
    """
    w = np.array(getattr(model, "_blend_weights", []))
    if w.size != base.shape[1]:
        w = np.ones(base.shape[1]) / base.shape[1]
    if mode == "logreg":
        return model.blender.predict_proba(base)[:, 1]
    if mode == "mean":
        return base.mean(axis=1)
    if mode == "weighted_mean":
        return base @ w
    if mode == "logit_mean":
        return _sigmoid(_logit(base).mean(axis=1))
    if mode == "weighted_logit_mean":
        return _sigmoid(_logit(base) @ w)
    if mode.startswith("solo_"):
        return base[:, {"solo_lgb": 0, "solo_cb": 1, "solo_logreg": 2}[mode]]
    raise ValueError(mode)


def fit_config(
    X_tr: pd.DataFrame,
    y_tr: pd.Series,
    X_va: pd.DataFrame,
    y_va: pd.Series,
    cols: list[str],
    contri: dict[str, float],
    seed: int = 42,
) -> EnsembleModel:
    tuned = _load_tuned_params()
    lgb_params = {
        **LGB_PARAMS,
        **tuned,
        "feature_contri": [contri.get(c, 1.0) for c in cols],
        "seed": seed,
    }
    model = EnsembleModel(
        feature_columns=cols,
        lgb_params=lgb_params,
        lgb_num_rounds=LGB_NUM_ROUNDS,
        lgb_early_stopping=LGB_EARLY_STOPPING_ROUNDS,
    )
    if seed != 42:
        # CatBoost's seed is hardcoded in EnsembleModel._cb_params; the seed
        # sweep has to reach it too or two thirds of the ensemble would be
        # frozen and the "stability" claim would be vacuous.
        model._cb_params = staticmethod(  # type: ignore[method-assign]
            lambda: {**EnsembleModel._cb_params(), "random_seed": seed}
        ).__func__
    model.fit(
        X_train=X_tr.reset_index(drop=True),
        y_train=y_tr.reset_index(drop=True),
        X_val=X_va.reset_index(drop=True),
        y_val=y_va.reset_index(drop=True),
    )
    return model


def order_averaged(model: EnsembleModel, X: pd.DataFrame, X_sw: pd.DataFrame) -> dict:
    """Return {mode: order-averaged P(A)} from a single pair of base matrices."""
    base = model._base_predict_matrix(X.reset_index(drop=True))
    base_sw = model._base_predict_matrix(X_sw.reset_index(drop=True))
    return {
        mode: 0.5 * (blend(base, mode, model) + (1.0 - blend(base_sw, mode, model)))
        for mode in BLEND_MODES
    }


def summarize(probs: np.ndarray, y: np.ndarray, market: np.ndarray) -> dict:
    has = ~np.isnan(market)
    h = headline(probs[has], y[has])
    rows = bucket_table(probs, market, y)
    tail = next((r for r in rows if r["lo"] == 0.72), None)
    coin = next((r for r in rows if r["lo"] == 0.50), None)
    return {
        "headline": h,
        "buckets": rows,
        "tail_ll": tail["model"] if tail else float("nan"),
        "coin_ll": coin["model"] if coin else float("nan"),
        "murphy": murphy(probs[has], y[has]),
    }


# ── static split ───────────────────────────────────────────────────────


def run_static(df: pd.DataFrame, seeds: list[int]) -> dict:
    cols = feature_names()
    X, y, meta = build_feature_matrix(df)
    X = X[cols]
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    X_sw = X_sw[cols]
    dt = pd.to_datetime(meta["event_date"])
    m_tr = (dt < TRAIN_END).to_numpy()
    m_va = ((dt >= TRAIN_END) & (dt < VAL_END)).to_numpy()
    m_te = (dt >= VAL_END).to_numpy()
    market_te = meta.loc[m_te, "market_prob_a"].to_numpy(dtype=float)
    y_te = y[m_te].to_numpy().astype(int)
    y_va = y[m_va].to_numpy().astype(int)

    out: dict = {}
    for age_name, contri in AGE_CONFIGS.items():
        for seed in seeds:
            model = fit_config(
                X[m_tr], y[m_tr], X[m_va], y[m_va], cols, contri, seed
            )
            probs_va = order_averaged(model, X[m_va], X_sw[m_va])
            probs_te = order_averaged(model, X[m_te], X_sw[m_te])
            for mode in BLEND_MODES:
                key = f"{age_name}|{mode}|seed{seed}"
                s = summarize(probs_te[mode], y_te, market_te)
                s["val_logloss"] = float(
                    log_loss(y_va, np.clip(probs_va[mode], EPS, 1 - EPS))
                )
                s["val_blend_pick"] = model.training_meta["blend_mode"]
                s["weights"] = list(getattr(model, "_blend_weights", []))
                out[key] = s
    return out


# ── walk-forward ───────────────────────────────────────────────────────


def run_oof(df: pd.DataFrame, seed: int = 42) -> dict:
    """Pool out-of-sample predictions from quarterly retrains, per config.

    Each origin picks its own blender weights on its own 12-month val tail —
    the same thing production does every week — so the pooled numbers are what
    the configuration would actually have delivered over 2017-2024.
    """
    cols = feature_names()
    X, y, meta = build_feature_matrix(df)
    X = X[cols]
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    X_sw = X_sw[cols]
    dates = pd.to_datetime(meta["event_date"])
    market = meta["market_prob_a"].to_numpy(dtype=float)

    pooled: dict[str, dict[str, list]] = {
        f"{a}|{m}": {"p": [], "y": [], "market": []}
        for a in AGE_CONFIGS
        for m in BLEND_MODES
    }
    origin = pd.to_datetime(OOF_START)
    stop = pd.to_datetime(OOF_END)
    n_origins = 0
    while origin < stop:
        nxt = origin + pd.DateOffset(months=STEP_MONTHS)
        val_start = origin - pd.DateOffset(months=VAL_MONTHS)
        tr = (dates < val_start).to_numpy()
        va = ((dates >= val_start) & (dates < origin)).to_numpy()
        sc = ((dates >= origin) & (dates < min(nxt, stop))).to_numpy()
        if tr.sum() < 500 or va.sum() < 50 or sc.sum() == 0:
            origin = nxt
            continue
        n_origins += 1
        for age_name, contri in AGE_CONFIGS.items():
            model = fit_config(X[tr], y[tr], X[va], y[va], cols, contri, seed)
            probs = order_averaged(model, X[sc], X_sw[sc])
            for mode in BLEND_MODES:
                k = f"{age_name}|{mode}"
                pooled[k]["p"].extend(probs[mode].tolist())
                pooled[k]["y"].extend(y[sc].to_numpy().astype(int).tolist())
                pooled[k]["market"].extend(market[sc].tolist())
        print(f"  origin {origin.date()}  train {int(tr.sum()):5d}  scored {int(sc.sum()):4d}")
        origin = nxt

    out = {}
    for k, d in pooled.items():
        out[k] = summarize(
            np.array(d["p"]), np.array(d["y"]), np.array(d["market"], dtype=float)
        )
    out["_n_origins"] = n_origins
    return out


def print_table(title: str, res: dict, keys: list[str], baseline_key: str) -> None:
    print(f"\n{title}")
    print(
        f"{'config':<34}{'ll':>9}{'Δll':>9}{'acc':>8}{'sd':>8}"
        f"{'0.50-.55':>10}{'0.72+':>9}"
    )
    b = res[baseline_key]
    for k in keys:
        r = res[k]
        h = r["headline"]
        print(
            f"{k:<34}{h['logloss']:>9.4f}{h['logloss'] - b['headline']['logloss']:>+9.4f}"
            f"{h['acc']:>8.4f}{h['sd']:>8.4f}{r['coin_ll']:>10.4f}{r['tail_ll']:>9.4f}"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--skip-oof", action="store_true")
    ap.add_argument("--seeds", default="42")
    args = ap.parse_args()
    seeds = [int(s) for s in args.seeds.split(",")]

    df = load_symmetrized(args.cache)
    print(f"frame: {len(df):,} graded both-experienced bouts · base {df['target_a_wins'].mean():.4f}")

    print("\n=== STATIC SPLIT (test 2025+, 568 with odds) ===")
    static = run_static(df, seeds)
    base_key = f"current|weighted_mean|seed{seeds[0]}"
    for seed in seeds:
        keys = [f"{a}|{m}|seed{seed}" for a in AGE_CONFIGS for m in BLEND_MODES]
        print_table(
            f"seed {seed} — baseline is current|weighted_mean "
            f"(market ll 0.5968, tail 0.4392, coin 0.6873):",
            static,
            keys,
            base_key,
        )
    print(
        f"\n  val blend-mode argmin picked: "
        f"{static[base_key]['val_blend_pick']} · "
        f"weights {[round(w, 4) for w in static[base_key]['weights']]}"
    )
    print(f"  val logloss by mode (current age config, seed {seeds[0]}):")
    for m in BLEND_MODES:
        print(f"    {m:<22} {static[f'current|{m}|seed{seeds[0]}']['val_logloss']:.4f}")

    oof = {}
    if not args.skip_oof:
        print(f"\n=== WALK-FORWARD {OOF_START} → {OOF_END} (quarterly retrains) ===")
        oof = run_oof(df)
        keys = [f"{a}|{m}" for a in AGE_CONFIGS for m in BLEND_MODES]
        print_table(
            f"pooled out-of-sample over {oof['_n_origins']} origins:",
            oof,
            keys,
            "current|weighted_mean",
        )
        print_bucket_table(
            oof["current|weighted_mean"]["buckets"], "  [current|weighted_mean] buckets:"
        )

    OUT_PATH.write_text(json.dumps({"static": static, "oof": oof}, indent=2, default=float))
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()

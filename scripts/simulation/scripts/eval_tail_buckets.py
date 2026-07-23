"""Per-bucket model-vs-market diagnostic — where in the confidence range does
the log-loss gap to the closing line actually live?

Motivation: the headline gap to the market (test log-loss 0.620 vs 0.597) is
NOT spread evenly. Murphy's decomposition says our reliability matches the
book's almost exactly and the whole deficit is RESOLUTION, and slicing by the
market's own confidence shows it concentrated in the heavy-favourite bucket.
A single global number hides that — and any global gate would happily trade
away our edge on coin-flips to buy a tail improvement. Every change to the
winner model is therefore gated per bucket, with this script as the ruler.

What it prints:
  * headline model vs market on the SAME bouts (test split, odds only)
  * Murphy decomposition (reliability / resolution / uncertainty) for both
  * the four-bucket table by MARKET confidence: 0.50-0.55 / 0.55-0.62 /
    0.62-0.72 / 0.72+, with n and log-loss for model and market

Two things this does that eval_market.py / eval_calibration.py do NOT:
  1. ORDER AVERAGING. Production scores both fighter orderings and averages
     (predict.py) — the model is not perfectly antisymmetric, so scoring the
     raw scrape order understates it by ~2.1 pp accuracy. We measure the
     quantity we actually serve.
  2. It asserts the frame is symmetrized (base rate ~0.48). build_dataset()
     returns the raw scrape order where A wins ~95% of the time; metrics on
     that frame are meaningless.

Usage (from scripts/simulation, venv active):
  python scripts/eval_tail_buckets.py              # rebuild from the DB
  python scripts/eval_tail_buckets.py --cache      # reuse data/dataset.parquet

Importable: the lab scripts reuse prepare_splits() / bucket_table() / murphy()
so every report is computed the exact same way.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from collections.abc import Callable  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.metrics import accuracy_score, log_loss, roc_auc_score  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import build_dataset, fetch_raw, swap_sides, symmetrize_for_training  # noqa: E402
from src.features import build_feature_matrix  # noqa: E402
from src.train import temporal_split  # noqa: E402

EPS = 1e-6

# Buckets on the MARKET's confidence in its own favourite, max(m, 1-m).
# Edges chosen (before this lab) as ~even quartiles of the test odds subset;
# they are frozen so every report in the lab is comparable.
MARKET_BUCKETS: tuple[tuple[float, float], ...] = (
    (0.50, 0.55),
    (0.55, 0.62),
    (0.62, 0.72),
    (0.72, 1.01),
)

# Evaluate the SPLIT-trained twin so test is genuinely out-of-sample; the
# served artifacts/ensemble/ is refit on all data (test included).
_EVAL_DIR = ARTIFACTS_DIR / "ensemble_eval"


def resolve_ensemble_dir() -> Path:
    if _EVAL_DIR.exists():
        return _EVAL_DIR
    print(
        "WARNING: ensemble_eval/ missing — falling back to the served (all-data) "
        "model. Test numbers would be IN-SAMPLE; do not report them. Retrain first."
    )
    return ARTIFACTS_DIR / "ensemble"


# ── data ───────────────────────────────────────────────────────────────


def load_symmetrized(use_cache: bool = False) -> pd.DataFrame:
    """Symmetrized frame, main-model universe (both fighters experienced).

    run_train caches the symmetrized frame (WITH debut rows) at
    data/dataset.parquet; --cache reuses it to iterate without a DB round
    trip. Either way the debut rows are dropped here, because the main
    ensemble is trained on both-experienced bouts only (train.py) and the
    debut specialist is a separate model with its own artifacts.
    """
    cache_path = DATA_DIR / "dataset.parquet"
    if use_cache and cache_path.exists():
        df = pd.read_parquet(cache_path)
    else:
        df = symmetrize_for_training(build_dataset(fetch_raw(), include_debuts=True))
    if "is_debut_a" in df.columns:
        debut = (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).astype(bool)
        df = df[~debut].reset_index(drop=True)
    completed = df["target_a_wins"].notna()
    df = df[completed].reset_index(drop=True)
    base = float(pd.to_numeric(df["target_a_wins"]).mean())
    assert 0.40 < base < 0.60, (
        f"base rate {base:.3f} — frame is NOT symmetrized (raw scrape order puts "
        "A=winner in ~95% of bouts and every metric below would be garbage)"
    )
    return df


def prepare_splits(use_cache: bool = False, ensemble_dir: Path | None = None) -> dict:
    """Build both fighter orderings once and split them identically.

    Returns {split: {X, X_swapped, y, market}} plus the loaded ensemble. The
    swapped matrix is built from swap_sides() on the ROW frame (not by
    permuting columns of X) so the stance one-hots and abs_*_a/_b columns —
    exactly the ones that break antisymmetry — are rebuilt honestly.
    """
    df = load_symmetrized(use_cache)
    ens = EnsembleModel.load(ensemble_dir or resolve_ensemble_dir())

    X, y, meta = build_feature_matrix(df)
    X = X[ens.feature_columns]
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    X_sw = X_sw[ens.feature_columns]

    Xs, ys, metas = temporal_split(X, y, meta)
    Xsw_s, _, _ = temporal_split(X_sw, y, meta)

    out: dict = {"ensemble": ens, "splits": {}}
    for name in ("train", "val", "test"):
        out["splits"][name] = {
            "X": Xs[name],
            "X_swapped": Xsw_s[name],
            "y": ys[name].to_numpy().astype(int),
            "market": metas[name]["market_prob_a"].to_numpy(dtype=float),
        }
    return out


def averaged_probs(
    ens: EnsembleModel,
    split: dict,
    transform: Callable[[np.ndarray], np.ndarray] | None = None,
) -> np.ndarray:
    """P(A) as production serves it: ½·[f(A,B) + (1 − f(B,A))].

    `transform` (a monotone recalibration) is applied PER ORIENTATION, before
    averaging — that is where EnsembleModel.calibrator sits in the served
    path, so fitting anything against this function is fitting against the
    real pipeline.
    """
    p = ens.predict_proba_a(split["X"])
    p_sw = ens.predict_proba_a(split["X_swapped"])
    if transform is not None:
        p = transform(p)
        p_sw = transform(p_sw)
    return 0.5 * (p + (1.0 - p_sw))


# ── metrics ────────────────────────────────────────────────────────────


def murphy(probs: np.ndarray, y: np.ndarray, n_bins: int = 10) -> dict[str, float]:
    """Murphy decomposition of the Brier score:
        brier = reliability − resolution + uncertainty
    on `n_bins` equal-width probability bins.

    reliability  — mean squared gap between a bin's forecast and its outcome
                   rate (lower = better calibrated)
    resolution   — how far the bin outcome rates spread from the base rate
                   (higher = more informative; this is the discrimination term)
    uncertainty  — ȳ(1−ȳ), a property of the sample, identical for every
                   forecaster scored on the same bouts
    """
    probs = np.clip(np.asarray(probs, dtype=float), EPS, 1 - EPS)
    y = np.asarray(y, dtype=float)
    n = len(y)
    ybar = y.mean()
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    rel = res = 0.0
    for i in range(n_bins):
        lo, hi = edges[i], edges[i + 1]
        sel = (probs >= lo) & (probs < hi if i < n_bins - 1 else probs <= hi)
        k = int(sel.sum())
        if k == 0:
            continue
        f_bar = probs[sel].mean()
        o_bar = y[sel].mean()
        rel += k * (f_bar - o_bar) ** 2
        res += k * (o_bar - ybar) ** 2
    return {
        "reliability": rel / n,
        "resolution": res / n,
        "uncertainty": float(ybar * (1 - ybar)),
        "brier": float(np.mean((probs - y) ** 2)),
    }


def headline(probs: np.ndarray, y: np.ndarray) -> dict[str, float]:
    p = np.clip(np.asarray(probs, dtype=float), EPS, 1 - EPS)
    return {
        "n": int(len(y)),
        "acc": float(accuracy_score(y, (p >= 0.5).astype(int))),
        "logloss": float(log_loss(y, p)),
        "auc": float(roc_auc_score(y, p)) if 0 < y.mean() < 1 else float("nan"),
        "sd": float(p.std()),
        "max_p": float(np.maximum(p, 1 - p).max()),
    }


def bucket_table(
    probs: np.ndarray, market: np.ndarray, y: np.ndarray
) -> list[dict[str, float]]:
    """Log-loss of model and market inside each MARKET-confidence bucket.

    Bucketing on the MARKET (not the model) keeps the row membership fixed
    while the model changes — otherwise every candidate would be scored on a
    different set of bouts and the columns would not be comparable.
    """
    has = ~np.isnan(market)
    p = np.clip(np.asarray(probs, dtype=float)[has], EPS, 1 - EPS)
    m = np.clip(np.asarray(market, dtype=float)[has], EPS, 1 - EPS)
    yy = np.asarray(y)[has]
    conf = np.maximum(m, 1 - m)
    rows = []
    for lo, hi in MARKET_BUCKETS:
        sel = (conf >= lo) & (conf < hi)
        k = int(sel.sum())
        if k == 0:
            continue
        ll_model = float(log_loss(yy[sel], p[sel], labels=[0, 1]))
        ll_market = float(log_loss(yy[sel], m[sel], labels=[0, 1]))
        rows.append(
            {
                "lo": lo,
                "hi": hi,
                "n": k,
                "model": ll_model,
                "market": ll_market,
                "gap": ll_model - ll_market,
                "model_acc": float(((p[sel] >= 0.5) == (yy[sel] == 1)).mean()),
                "market_acc": float(((m[sel] >= 0.5) == (yy[sel] == 1)).mean()),
            }
        )
    return rows


def print_bucket_table(rows: list[dict[str, float]], title: str = "") -> None:
    if title:
        print(f"\n{title}")
    print(f"{'market conf':>12}  {'n':>4}  {'model ll':>9}  {'market ll':>9}  {'gap':>8}")
    for r in rows:
        hi = "1.00" if r["hi"] > 1.0 else f"{r['hi']:.2f}"
        print(
            f"  {r['lo']:.2f}-{hi:>4}  {r['n']:>4}  {r['model']:>9.4f}  "
            f"{r['market']:>9.4f}  {r['gap']:>+8.4f}"
        )
    n_tot = sum(r["n"] for r in rows)
    w_gap = sum(r["n"] * r["gap"] for r in rows) / max(n_tot, 1)
    print(f"{'weighted':>12}  {n_tot:>4}  {'':>9}  {'':>9}  {w_gap:>+8.4f}")


def print_murphy(name: str, d: dict[str, float]) -> None:
    print(
        f"  {name:<10} reliability {d['reliability']:.5f}   "
        f"resolution {d['resolution']:.5f}   uncertainty {d['uncertainty']:.4f}   "
        f"brier {d['brier']:.4f}"
    )


# ── entrypoint ─────────────────────────────────────────────────────────


def report(
    prepared: dict,
    split_name: str = "test",
    transform: Callable[[np.ndarray], np.ndarray] | None = None,
    label: str = "current",
) -> dict:
    ens = prepared["ensemble"]
    split = prepared["splits"][split_name]
    probs = averaged_probs(ens, split, transform)
    y = split["y"]
    market = split["market"]
    has = ~np.isnan(market)

    h_all = headline(probs, y)
    h_sub = headline(probs[has], y[has])
    h_mkt = headline(market[has], y[has])

    print(f"\n=== {label} · {split_name} split (order-averaged) ===")
    print(
        f"  all bouts     n {h_all['n']:>4}  acc {h_all['acc']:.4f}  "
        f"ll {h_all['logloss']:.4f}  auc {h_all['auc']:.4f}  sd {h_all['sd']:.4f}  "
        f"max_p {h_all['max_p']:.3f}"
    )
    print(
        f"  model /odds   n {h_sub['n']:>4}  acc {h_sub['acc']:.4f}  "
        f"ll {h_sub['logloss']:.4f}  auc {h_sub['auc']:.4f}  sd {h_sub['sd']:.4f}  "
        f"max_p {h_sub['max_p']:.3f}"
    )
    print(
        f"  market /odds  n {h_mkt['n']:>4}  acc {h_mkt['acc']:.4f}  "
        f"ll {h_mkt['logloss']:.4f}  auc {h_mkt['auc']:.4f}  sd {h_mkt['sd']:.4f}  "
        f"max_p {h_mkt['max_p']:.3f}"
    )
    print(f"  gap to market  {h_sub['logloss'] - h_mkt['logloss']:+.4f} log-loss")

    print("\n  Murphy decomposition (odds subset, 10 equal-width bins):")
    print_murphy("model", murphy(probs[has], y[has]))
    print_murphy("market", murphy(market[has], y[has]))

    rows = bucket_table(probs, market, y)
    print_bucket_table(rows, "  by MARKET confidence:")
    return {"headline": h_sub, "market": h_mkt, "buckets": rows, "probs": probs}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--cache",
        action="store_true",
        help="reuse data/dataset.parquet instead of rebuilding from the DB",
    )
    ap.add_argument("--split", default="test", choices=("train", "val", "test"))
    args = ap.parse_args()

    prepared = prepare_splits(use_cache=args.cache)
    report(prepared, split_name=args.split)


if __name__ == "__main__":
    main()

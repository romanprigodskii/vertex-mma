"""LAB — tail-aware recalibration of the blended winner probability.

Premise (measured, see scripts/eval_tail_buckets.py): our reliability already
matches the closing line (0.00296 vs 0.00303). The entire log-loss deficit is
RESOLUTION, and it lives in the heavy-favourite bucket: on the 180 test bouts
where the market is >=0.72 confident we agree with it on the favourite 92% of
the time but say 0.677 where the truth is 0.839. We are TIMID, not wrong.

Mechanically scaling the logit inside that bucket recovers about 40% of the
bucket deficit (x1.6 → 0.4850 vs 0.5152 raw, market 0.4392) and then stops —
so a monotone transform is worth roughly 0.010 of the 0.023 total gap and no
more. This script asks which two-parameter monotone transform gets closest,
fit HONESTLY on val.

Candidates (all monotone; z = logit(p)):
  identity        — the shipped model
  temperature     — sigmoid(z/T). 1 param. The bar to beat: it sharpens
                    EVERYTHING, including the coin-flips where we already beat
                    the book, so it buys the tail by selling our edge.
  cubic           — sigmoid(a·z + b·z³). Symmetric, leaves the middle alone
                    (z³ ≈ 0 near p=0.5) and stretches the tails.
  piecewise-T     — separate slope inside/outside a |z| kink, continuous at
                    the kink so it stays monotone. Kink chosen on val.
  beta            — sigmoid(a·log p − b·log(1−p) + c) and its c=0 variant.

SYMMETRY. The training frame is symmetrized (deterministic A/B flip), so the
true recalibration map must satisfy g(1−p) = 1−g(p). cubic and piecewise-T
enforce that by construction — a free regularizer worth half the parameter
count on 429 val rows. beta only satisfies it when a=b and c=0, so any a≠b it
finds is noise-fitting; it is included precisely to show that.

FITTING IS AGAINST THE SERVED QUANTITY. Production scores both fighter
orderings and averages (predict.py); the calibrator sits inside
predict_proba_a, i.e. it is applied per orientation BEFORE the average. The
objective here is exactly that: logloss(y_val, ½·[g(p) + 1 − g(p_swapped)]).

HONESTY. Parameters are fit on val ONLY (429 rows, 122 of which have odds —
far too thin to bucket, which is why the per-bucket gate is read off test).
Test is the accept/reject gate, never the parameter source. That is still a
weaker guarantee than a fully blind holdout, so the bootstrap block below
reports how much of the test improvement survives val resampling.

Usage (scripts/simulation, venv active):
  python scripts/lab_tail_calibration.py [--cache] [--bootstrap 300]
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
from eval_tail_buckets import (  # noqa: E402
    EPS,
    bucket_table,
    headline,
    murphy,
    prepare_splits,
    print_bucket_table,
    print_murphy,
)
from scipy.optimize import minimize  # noqa: E402
from sklearn.metrics import log_loss  # noqa: E402

from src.config import ARTIFACTS_DIR  # noqa: E402
from src.ensemble import CALIBRATOR_FAMILIES, ProbabilityCalibrator  # noqa: E402

OUT_PATH = ARTIFACTS_DIR / "lab_tail_calibration.json"


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def served(p: np.ndarray, p_sw: np.ndarray, cal: ProbabilityCalibrator | None) -> np.ndarray:
    """The production quantity: calibrate each orientation, then average."""
    if cal is None:
        return 0.5 * (p + (1.0 - p_sw))
    return 0.5 * (cal.transform(p) + (1.0 - cal.transform(p_sw)))


def _val_objective(family: str, params: np.ndarray, ctx: dict) -> float:
    cal = ProbabilityCalibrator(family, params.tolist())
    if not cal.is_monotone():
        return 1e6 + float(np.sum(np.abs(params)))
    q = served(ctx["p"], ctx["p_sw"], cal)
    return float(log_loss(ctx["y"], np.clip(q, EPS, 1 - EPS)))


def fit_family(family: str, ctx: dict) -> tuple[ProbabilityCalibrator, float]:
    """Nelder-Mead from several starts (2-3 params, cheap, no gradients)."""
    starts = CALIBRATOR_FAMILIES[family]["starts"]
    best_p, best_ll = None, np.inf
    for x0 in starts:
        res = minimize(
            lambda q: _val_objective(family, q, ctx),
            np.asarray(x0, dtype=float),
            method="Nelder-Mead",
            options={"xatol": 1e-6, "fatol": 1e-9, "maxiter": 4000, "maxfev": 4000},
        )
        if res.fun < best_ll:
            best_ll, best_p = float(res.fun), res.x
    return ProbabilityCalibrator(family, np.asarray(best_p).tolist()), best_ll


def fit_piecewise(ctx: dict) -> tuple[ProbabilityCalibrator, float]:
    """Piecewise temperature — the kink is a grid search, the two slopes are
    optimized at each kink. Grid so the kink can't wander into a region with
    no val rows on one side of it."""
    best, best_ll = None, np.inf
    for z0 in np.linspace(0.15, 1.20, 22):
        ctx_k = {**ctx, "kink": float(z0)}
        for x0 in ([1.0, 1.0], [1.0, 1.6], [1.3, 2.0]):
            res = minimize(
                lambda q, _z0=z0, _c=ctx_k: _val_objective(
                    "piecewise", np.array([q[0], q[1], _z0]), _c
                ),
                np.asarray(x0, dtype=float),
                method="Nelder-Mead",
                options={"xatol": 1e-6, "fatol": 1e-9, "maxiter": 3000},
            )
            if res.fun < best_ll:
                best_ll = float(res.fun)
                best = ProbabilityCalibrator(
                    "piecewise", [float(res.x[0]), float(res.x[1]), float(z0)]
                )
    return best, best_ll


def mechanical_ceiling(p: np.ndarray, market: np.ndarray, y: np.ndarray) -> None:
    """Reference point for GATE 1c: uniform logit scaling applied ONLY inside
    the 0.72+ bucket. Not shippable (it peeks at the market to decide who to
    sharpen) — it is the ceiling a legitimate transform is measured against."""
    has = ~np.isnan(market)
    m = market[has]
    conf = np.maximum(m, 1 - m)
    sel = conf >= 0.72
    pp, yy = p[has][sel], y[has][sel]
    print("\n  mechanical logit scaling INSIDE the 0.72+ bucket (reference, not shippable):")
    for k in (1.0, 1.3, 1.6, 2.0):
        q = 1.0 / (1.0 + np.exp(-logit(pp) * k))
        conf_mean = np.maximum(q, 1 - q).mean()
        print(
            f"    x{k:.1f}  mean conf {conf_mean:.4f}  "
            f"logloss {log_loss(yy, np.clip(q, EPS, 1 - EPS), labels=[0, 1]):.4f}"
        )
    print(
        f"    market                      logloss "
        f"{log_loss(yy, np.clip(m[sel], EPS, 1 - EPS), labels=[0, 1]):.4f}"
    )


def evaluate(name: str, cal: ProbabilityCalibrator | None, ctx_te: dict) -> dict:
    q = served(ctx_te["p"], ctx_te["p_sw"], cal)
    y, market = ctx_te["y"], ctx_te["market"]
    has = ~np.isnan(market)
    h = headline(q[has], y[has])
    mu = murphy(q[has], y[has])
    buckets = bucket_table(q, market, y)
    return {
        "name": name,
        "params": None if cal is None else cal.params,
        "family": None if cal is None else cal.family,
        "headline": h,
        "murphy": mu,
        "buckets": buckets,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--bootstrap", type=int, default=300)
    ap.add_argument(
        "--bootstrap-families",
        default="",
        help="comma-separated families to bootstrap instead of just the val winner "
        "(piecewise is ~50x the cost of the others — it grid-searches the kink)",
    )
    args = ap.parse_args()

    prepared = prepare_splits(use_cache=args.cache)
    ens = prepared["ensemble"]

    ctx = {}
    for split in ("val", "test"):
        s = prepared["splits"][split]
        ctx[split] = {
            "p": ens.predict_proba_a(s["X"]),
            "p_sw": ens.predict_proba_a(s["X_swapped"]),
            "y": s["y"],
            "market": s["market"],
        }
    ctx_va, ctx_te = ctx["val"], ctx["test"]

    base_val = float(
        log_loss(ctx_va["y"], np.clip(served(ctx_va["p"], ctx_va["p_sw"], None), EPS, 1 - EPS))
    )
    print(f"\n=== VAL fit (n={len(ctx_va['y'])}) — baseline val logloss {base_val:.4f} ===")

    fitted: list[tuple[str, ProbabilityCalibrator | None, float]] = [
        ("identity", None, base_val)
    ]
    for family in ("temperature", "cubic", "beta", "beta_c0"):
        cal, ll = fit_family(family, ctx_va)
        fitted.append((family, cal, ll))
    cal_pw, ll_pw = fit_piecewise(ctx_va)
    fitted.append(("piecewise", cal_pw, ll_pw))

    for name, cal, ll in fitted:
        pstr = "" if cal is None else "  " + cal.describe()
        print(f"  {name:<12} val ll {ll:.4f}  ({ll - base_val:+.4f}){pstr}")

    print("\n=== TEST (order-averaged, odds subset n=568) — GATE READOUT ===")
    baseline_eval = evaluate("identity", None, ctx_te)
    results = [baseline_eval]
    for name, cal, _ in fitted[1:]:
        results.append(evaluate(name, cal, ctx_te))

    mkt_h = headline(
        ctx_te["market"][~np.isnan(ctx_te["market"])],
        ctx_te["y"][~np.isnan(ctx_te["market"])],
    )
    print(
        f"  market        ll {mkt_h['logloss']:.4f}  acc {mkt_h['acc']:.4f}  "
        f"sd {mkt_h['sd']:.4f}"
    )
    for r in results:
        h = r["headline"]
        print(
            f"  {r['name']:<12} ll {h['logloss']:.4f}  acc {h['acc']:.4f}  "
            f"sd {h['sd']:.4f}  max_p {h['max_p']:.3f}  "
            f"gap {h['logloss'] - mkt_h['logloss']:+.4f}"
        )

    for r in results:
        print_bucket_table(r["buckets"], f"  [{r['name']}] by MARKET confidence:")
        print_murphy(r["name"], r["murphy"])

    mechanical_ceiling(
        served(ctx_te["p"], ctx_te["p_sw"], None), ctx_te["market"], ctx_te["y"]
    )

    # ── val-noise sensitivity ──────────────────────────────────────────
    # 429 val rows and 2 free parameters: how much of the test gain is real
    # and how much is one lucky val draw? Refit on bootstrap resamples of val,
    # re-score the SAME test set, report the spread.
    winner = min((f for f in fitted[1:]), key=lambda t: t[2])
    families = (
        [f.strip() for f in args.bootstrap_families.split(",") if f.strip()]
        or [winner[0]]
    )
    rng = np.random.default_rng(42)
    n_val = len(ctx_va["y"])
    base_test = baseline_eval["headline"]["logloss"]
    has = ~np.isnan(ctx_te["market"])
    boot_out: dict[str, dict] = {}
    for fam in families:
        print(
            f"\n=== bootstrap ({args.bootstrap}x) — refit '{fam}' on resampled val, "
            f"re-score test ==="
        )
        test_lls, params_boot = [], []
        for _ in range(args.bootstrap):
            idx = rng.integers(0, n_val, n_val)
            ctx_b = {
                "p": ctx_va["p"][idx],
                "p_sw": ctx_va["p_sw"][idx],
                "y": ctx_va["y"][idx],
            }
            cal_b, _ = fit_piecewise(ctx_b) if fam == "piecewise" else fit_family(fam, ctx_b)
            q = served(ctx_te["p"], ctx_te["p_sw"], cal_b)
            test_lls.append(float(log_loss(ctx_te["y"][has], np.clip(q[has], EPS, 1 - EPS))))
            params_boot.append(cal_b.params)
        test_lls = np.array(test_lls)
        print(
            f"  test ll  median {np.median(test_lls):.4f}  "
            f"p05 {np.percentile(test_lls, 5):.4f}  p95 {np.percentile(test_lls, 95):.4f}"
        )
        print(
            f"  beats the uncalibrated model ({base_test:.4f}) in "
            f"{100 * (test_lls < base_test).mean():.1f}% of resamples"
        )
        pb = np.array(params_boot)
        for j in range(pb.shape[1]):
            print(
                f"  param[{j}]  median {np.median(pb[:, j]):+.4f}  "
                f"p05 {np.percentile(pb[:, j], 5):+.4f}  p95 {np.percentile(pb[:, j], 95):+.4f}"
            )
        boot_out[fam] = {
            "n": args.bootstrap,
            "test_logloss_median": float(np.median(test_lls)),
            "test_logloss_p05": float(np.percentile(test_lls, 5)),
            "test_logloss_p95": float(np.percentile(test_lls, 95)),
            "frac_beating_baseline": float((test_lls < base_test).mean()),
            "param_median": np.median(pb, axis=0).tolist(),
        }

    OUT_PATH.write_text(
        json.dumps(
            {
                "val_baseline_logloss": base_val,
                "val_fits": [
                    {"name": n, "params": (c.params if c else None), "val_logloss": ll}
                    for n, c, ll in fitted
                ],
                "test": [
                    {k: v for k, v in r.items() if k != "probs"} for r in results
                ],
                "market_test": mkt_h,
                "val_winner": winner[0],
                "bootstrap": boot_out,
            },
            indent=2,
            default=float,
        )
    )
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()

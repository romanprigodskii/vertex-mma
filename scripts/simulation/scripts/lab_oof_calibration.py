"""LAB — does tail-aware recalibration survive when it is NOT fit on 429 rows?

scripts/lab_tail_calibration.py fits the transform on the static val split
(429 rows) and the result is a coin toss: val picks the piecewise family, and
piecewise is the WORST candidate on test. That is the expected failure mode of
a 2-3 parameter fit on 429 rows, and it is exactly why isotonic was rejected
before this lab. So before concluding "a monotone transform cannot close the
tail gap", give the transform the best possible chance: fit it on thousands of
honest out-of-fold rows instead.

The harness is production's own rolling retrain (run_rolling_backtest.py):
at each quarterly origin, train on bouts before origin-12mo, validate on the
12-month tail, and score the next quarter — bouts the model has never seen.
Pooling those scored windows over 2017-2024 gives ~3k genuinely out-of-sample
probabilities from models built exactly like the served one, all strictly
BEFORE the 2025-01-01 test boundary. Fitting two parameters on 3k honest rows
is a completely different statistical proposition than fitting them on 429.

Three questions, in order:

  A. OOF-INTERNAL. Fit on early origins, evaluate on late origins. Never
     touches test. This is the clean answer to "does a tail transform
     generalize at all?", free of any test-set peeking.
  B. THE GATE. Fit on ALL pre-2025 OOF rows, apply to the static test split,
     read the four buckets. Parameters come from data strictly before the test
     boundary, so this is a legitimate held-out application.
  C. STABILITY. Bootstrap the OOF fit; how much of the effect is one draw?

CAVEAT, stated up front: early origins train on materially less data than the
served model, so their probabilities are not drawn from quite the same
distribution as today's. The fit is therefore also reported on the recent half
of the OOF window alone, and the two parameter sets are compared.

Usage (scripts/simulation, venv active):
  python scripts/lab_oof_calibration.py [--cache] [--rebuild-oof]
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
    murphy,
    prepare_splits,
    print_bucket_table,
    print_murphy,
)
from lab_tail_calibration import fit_family, fit_piecewise, served  # noqa: E402
from run_rolling_backtest import VAL_MONTHS, _fit_ensemble, load_dataset  # noqa: E402
from sklearn.metrics import log_loss  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.ensemble import ProbabilityCalibrator  # noqa: E402
from src.features import build_feature_matrix, feature_names  # noqa: E402

# The OOF pool is a rebuildable cache (32 ensemble fits, ~90s), so it lives in
# the gitignored data/ dir like the other dataset caches; only the fitted
# numbers land in artifacts/.
OOF_PATH = DATA_DIR / "lab_oof_probs.parquet"
OUT_PATH = ARTIFACTS_DIR / "lab_oof_calibration.json"

OOF_START = "2017-01-01"
# Hard stop at the test boundary: no OOF row may come from on/after VAL_END,
# or the calibrator would be fit on the split it is later gated against.
OOF_END = "2025-01-01"
STEP_MONTHS = 3
# Split point for question A (early origins fit, late origins evaluate).
OOF_HOLDOUT_FROM = "2022-01-01"


def build_oof(use_cache: bool) -> pd.DataFrame:
    """Walk-forward out-of-fold probabilities for the MAIN segment.

    Per origin the split mirrors production (and run_rolling_backtest):
      train  event_date <  origin - 12mo
      val    [origin - 12mo, origin)     early stop + blender + blend mode
      score  [origin, origin + 3mo)      never seen, never fit
    Both fighter orderings are scored and averaged, as predict.py serves.
    We keep the PER-ORIENTATION probabilities too: the calibrator is applied
    per orientation inside predict_proba_a, so fitting needs both.
    """
    df = load_dataset(use_cache)
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)
    cols = feature_names()

    X, y, meta = build_feature_matrix(df)
    from src.export import swap_sides

    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    dates = pd.to_datetime(meta["event_date"])
    debut = (
        (df["is_debut_a"].fillna(False) | df["is_debut_b"].fillna(False)).to_numpy()
        if "is_debut_a" in df.columns
        else np.zeros(len(df), dtype=bool)
    )
    exp = ~debut
    market = meta["market_prob_a"].to_numpy(dtype=float)

    rows = []
    origin = pd.to_datetime(OOF_START)
    stop = pd.to_datetime(OOF_END)
    while origin < stop:
        nxt = origin + pd.DateOffset(months=STEP_MONTHS)
        val_start = origin - pd.DateOffset(months=VAL_MONTHS)
        tr = (dates < val_start).to_numpy() & exp
        va = ((dates >= val_start) & (dates < origin)).to_numpy() & exp
        sc = ((dates >= origin) & (dates < min(nxt, stop))).to_numpy() & exp
        if tr.sum() < 500 or va.sum() < 50 or sc.sum() == 0:
            origin = nxt
            continue
        model = _fit_ensemble(
            X.loc[tr, cols], y.loc[tr], X.loc[va, cols], y.loc[va], cols
        )
        p = model.predict_proba_a(X.loc[sc, cols].reset_index(drop=True))
        p_sw = model.predict_proba_a(X_sw.loc[sc, cols].reset_index(drop=True))
        rows.append(
            pd.DataFrame(
                {
                    "origin": str(origin.date()),
                    "p": p,
                    "p_sw": p_sw,
                    "y": y.loc[sc].to_numpy().astype(int),
                    "market": market[sc],
                }
            )
        )
        print(
            f"  origin {origin.date()}  train {int(tr.sum()):5d}  val {int(va.sum()):4d}  "
            f"scored {int(sc.sum()):4d}  (odds {int((~np.isnan(market[sc])).sum()):4d})"
        )
        origin = nxt
    out = pd.concat(rows, ignore_index=True)
    out.to_parquet(OOF_PATH, index=False)
    return out


def ctx_from(frame: pd.DataFrame) -> dict:
    return {
        "p": frame["p"].to_numpy(),
        "p_sw": frame["p_sw"].to_numpy(),
        "y": frame["y"].to_numpy().astype(int),
        "market": frame["market"].to_numpy(dtype=float),
    }


def fit_all(ctx: dict) -> list[tuple[str, ProbabilityCalibrator | None, float]]:
    base = float(
        log_loss(ctx["y"], np.clip(served(ctx["p"], ctx["p_sw"], None), EPS, 1 - EPS))
    )
    out: list[tuple[str, ProbabilityCalibrator | None, float]] = [
        ("identity", None, base)
    ]
    for family in ("temperature", "cubic", "beta", "beta_c0"):
        cal, ll = fit_family(family, ctx)
        out.append((family, cal, ll))
    cal_pw, ll_pw = fit_piecewise(ctx)
    out.append(("piecewise", cal_pw, ll_pw))
    return out


def score(ctx: dict, cal: ProbabilityCalibrator | None) -> float:
    q = served(ctx["p"], ctx["p_sw"], cal)
    return float(log_loss(ctx["y"], np.clip(q, EPS, 1 - EPS)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true", help="reuse the cached bout frame")
    ap.add_argument("--rebuild-oof", action="store_true")
    ap.add_argument("--bootstrap", type=int, default=200)
    args = ap.parse_args()

    if args.rebuild_oof or not OOF_PATH.exists():
        print(f"=== building OOF predictions {OOF_START} → {OOF_END} (step {STEP_MONTHS}mo) ===")
        oof = build_oof(args.cache)
    else:
        oof = pd.read_parquet(OOF_PATH)
    n_odds = int(oof["market"].notna().sum())
    print(
        f"\nOOF pool: {len(oof):,} bouts over {oof['origin'].nunique()} origins "
        f"({n_odds:,} with odds) · base rate {oof['y'].mean():.4f}"
    )

    # ── A. OOF-internal temporal validation (test never touched) ───────
    early = oof[oof["origin"] < OOF_HOLDOUT_FROM]
    late = oof[oof["origin"] >= OOF_HOLDOUT_FROM]
    ctx_e, ctx_l = ctx_from(early), ctx_from(late)
    print(
        f"\n=== A. OOF-internal — fit on {len(early):,} rows (<{OOF_HOLDOUT_FROM}), "
        f"evaluate on {len(late):,} rows (>={OOF_HOLDOUT_FROM}) ==="
    )
    fits_early = fit_all(ctx_e)
    base_late = score(ctx_l, None)
    a_rows = []
    for name, cal, ll_fit in fits_early:
        ll_late = score(ctx_l, cal)
        a_rows.append({"name": name, "fit_ll": ll_fit, "holdout_ll": ll_late})
        pstr = "" if cal is None else "  " + cal.describe()
        print(
            f"  {name:<12} fit ll {ll_fit:.4f}   holdout ll {ll_late:.4f}  "
            f"({ll_late - base_late:+.4f}){pstr}"
        )
    lt = late[late["market"].notna()]
    if len(lt) > 200:
        ctx_lt = ctx_from(lt)
        best_a = min(fits_early[1:], key=lambda t: t[2])
        print_bucket_table(
            bucket_table(served(ctx_lt["p"], ctx_lt["p_sw"], None), ctx_lt["market"], ctx_lt["y"]),
            f"  [identity] OOF holdout buckets (n={len(lt)}):",
        )
        print_bucket_table(
            bucket_table(
                served(ctx_lt["p"], ctx_lt["p_sw"], best_a[1]), ctx_lt["market"], ctx_lt["y"]
            ),
            f"  [{best_a[0]}] OOF holdout buckets:",
        )

    # ── B. fit on ALL pre-2025 OOF, gate on the static test split ──────
    ctx_all = ctx_from(oof)
    fits_all = fit_all(ctx_all)
    recent = oof[oof["origin"] >= "2022-01-01"]
    fits_recent = fit_all(ctx_from(recent))
    print(f"\n=== B. fit on ALL {len(oof):,} OOF rows → apply to the static test split ===")
    for (name, cal, ll), (_, cal_r, _) in zip(fits_all, fits_recent, strict=False):
        pstr = "" if cal is None else "  " + cal.describe()
        rstr = "" if cal_r is None else "   [recent-only: " + cal_r.describe() + "]"
        print(f"  {name:<12} oof ll {ll:.4f}{pstr}{rstr}")

    prepared = prepare_splits(use_cache=args.cache)
    ens = prepared["ensemble"]
    s = prepared["splits"]["test"]
    ctx_te = {
        "p": ens.predict_proba_a(s["X"]),
        "p_sw": ens.predict_proba_a(s["X_swapped"]),
        "y": s["y"],
        "market": s["market"],
    }
    has = ~np.isnan(ctx_te["market"])
    mkt_h = headline(ctx_te["market"][has], ctx_te["y"][has])
    print(f"\n  market        ll {mkt_h['logloss']:.4f}  acc {mkt_h['acc']:.4f}")

    results = []
    for name, cal, _ in fits_all:
        q = served(ctx_te["p"], ctx_te["p_sw"], cal)
        h = headline(q[has], ctx_te["y"][has])
        results.append(
            {
                "name": name,
                "params": None if cal is None else cal.params,
                "family": None if cal is None else cal.family,
                "headline": h,
                "murphy": murphy(q[has], ctx_te["y"][has]),
                "buckets": bucket_table(q, ctx_te["market"], ctx_te["y"]),
            }
        )
        print(
            f"  {name:<12} ll {h['logloss']:.4f}  acc {h['acc']:.4f}  sd {h['sd']:.4f}  "
            f"max_p {h['max_p']:.3f}  gap {h['logloss'] - mkt_h['logloss']:+.4f}"
        )
    for r in results:
        print_bucket_table(r["buckets"], f"  [{r['name']}] by MARKET confidence:")
        print_murphy(r["name"], r["murphy"])

    # ── C. bootstrap the OOF fit ───────────────────────────────────────
    winner = min(fits_all[1:], key=lambda t: t[2])
    print(f"\n=== C. bootstrap ({args.bootstrap}x) — refit '{winner[0]}' on resampled OOF ===")
    rng = np.random.default_rng(42)
    n = len(oof)
    base_test = results[0]["headline"]["logloss"]
    lls, params = [], []
    for _ in range(args.bootstrap):
        idx = rng.integers(0, n, n)
        ctx_b = {
            "p": ctx_all["p"][idx],
            "p_sw": ctx_all["p_sw"][idx],
            "y": ctx_all["y"][idx],
        }
        cal_b, _ = (
            fit_piecewise(ctx_b) if winner[0] == "piecewise" else fit_family(winner[0], ctx_b)
        )
        q = served(ctx_te["p"], ctx_te["p_sw"], cal_b)
        lls.append(float(log_loss(ctx_te["y"][has], np.clip(q[has], EPS, 1 - EPS))))
        params.append(cal_b.params)
    lls = np.array(lls)
    pb = np.array(params)
    print(
        f"  test ll  median {np.median(lls):.4f}  p05 {np.percentile(lls, 5):.4f}  "
        f"p95 {np.percentile(lls, 95):.4f}"
    )
    print(f"  beats uncalibrated ({base_test:.4f}) in {100 * (lls < base_test).mean():.1f}%")
    for j in range(pb.shape[1]):
        print(
            f"  param[{j}]  median {np.median(pb[:, j]):+.4f}  "
            f"p05 {np.percentile(pb[:, j], 5):+.4f}  p95 {np.percentile(pb[:, j], 95):+.4f}"
        )

    OUT_PATH.write_text(
        json.dumps(
            {
                "oof": {
                    "n": int(len(oof)),
                    "n_odds": n_odds,
                    "origins": int(oof["origin"].nunique()),
                    "start": OOF_START,
                    "end": OOF_END,
                },
                "a_oof_internal": a_rows,
                "b_fits_all_oof": [
                    {"name": n_, "params": (c.params if c else None), "oof_logloss": ll}
                    for n_, c, ll in fits_all
                ],
                "b_fits_recent_oof": [
                    {"name": n_, "params": (c.params if c else None), "oof_logloss": ll}
                    for n_, c, ll in fits_recent
                ],
                "b_test": results,
                "market_test": mkt_h,
                "c_bootstrap": {
                    "family": winner[0],
                    "n": args.bootstrap,
                    "test_logloss_median": float(np.median(lls)),
                    "test_logloss_p05": float(np.percentile(lls, 5)),
                    "test_logloss_p95": float(np.percentile(lls, 95)),
                    "frac_beating_baseline": float((lls < base_test).mean()),
                },
            },
            indent=2,
            default=float,
        )
    )
    print(f"\nwrote {OUT_PATH}")


if __name__ == "__main__":
    main()

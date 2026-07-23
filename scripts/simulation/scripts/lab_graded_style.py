"""STAGE 2, §4 — is the graded label's effect a resolution gain or a style tilt?

Dominance is entangled with STYLE, not only with the class gap. A grappler
wins 3-0 without ever threatening a finish; a striker wins by knockout. Two
equally decisive wins get different labels. The risk is that a soft-target
model learns "trust finishers" rather than "this matchup has a bigger gap",
which on serving would read as over-confidence in punchers and
under-confidence in grapplers — a new systematic skew for an old one.

This checks it directly. For the soft variant vs the binary baseline, on the
test split, it measures the per-bout probability SHIFT (soft favourite prob
minus binary favourite prob) and splits it by the favourite's career finish
rate (`prior_finish_rate`, a real feature, point-in-time). If the shift is
concentrated in high-finish-rate favourites and does NOT track whether those
favourites actually won more decisively, it is a style tilt. If the shift is
even across the finish-rate range, the label is not paying strikers a
premium.

Usage (from scripts/simulation):
  ./venv/bin/python scripts/lab_graded_style.py --cache
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
from lab_graded_target import (  # noqa: E402
    build_variant,
    fit_calibrator,
    load_frame,
    prepare,
)
from sklearn.metrics import log_loss  # noqa: E402

from src.config import ARTIFACTS_DIR  # noqa: E402

EPS = 1e-6


def favourite_view(probs: np.ndarray, market: np.ndarray, y: np.ndarray) -> dict:
    """Re-orient onto the MARKET's favourite so 'raised confidence' means the
    same thing across bouts."""
    fav_a = market > 0.5
    p_fav = np.where(fav_a, probs, 1 - probs)
    y_fav = np.where(fav_a, y == 1, y == 0).astype(int)
    m_fav = np.where(fav_a, market, 1 - market)
    return {"p_fav": p_fav, "y_fav": y_fav, "m_fav": m_fav, "fav_a": fav_a}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    prepared = prepare(args.cache)
    cols, splits = prepared["cols"], prepared["splits"]
    sp_tr, sp_va, sp_te = splits["train"], splits["val"], splits["test"]

    # Re-derive the test frame's favourite finish-rate and actual decisiveness
    # from the same symmetrized frame the splits came from, so rows line up.
    df = load_frame(args.cache)

    from src.features import build_feature_matrix
    _, _, meta = build_feature_matrix(df)
    # prior_finish_rate rides in the frame per side; grab both, oriented later.
    fr_a = pd.to_numeric(df["prior_finish_rate_a"], errors="coerce").to_numpy()
    fr_b = pd.to_numeric(df["prior_finish_rate_b"], errors="coerce").to_numpy()
    dates = pd.to_datetime(meta["event_date"])
    test_mask = (dates >= "2025-01-01").to_numpy()
    fr_a_te, fr_b_te = fr_a[test_mask], fr_b[test_mask]

    baseline = build_variant({"name": "b", "kind": "binary"}, sp_tr, sp_va, cols, args.seed)
    baseline.pick_blend(sp_va["X"], sp_va["y"])
    soft = build_variant(
        {"name": "s", "kind": "soft", "s": 1.0, "logreg": "binary"}, sp_tr, sp_va, cols, args.seed
    )
    soft.pick_blend(sp_va["X"], sp_va["y"])
    cal = fit_calibrator(soft, sp_va)
    cal_b = fit_calibrator(baseline, sp_va)

    market = sp_te["market"]
    y = sp_te["y"]
    has = ~np.isnan(market)
    p_base = baseline.served(sp_te, cal_b)
    p_soft = soft.served(sp_te, cal)

    vb = favourite_view(p_base, market, y)
    vs = favourite_view(p_soft, market, y)
    # Finish rate of the FAVOURITE.
    fr_fav = np.where(vb["fav_a"], fr_a_te, fr_b_te)

    m = has & ~np.isnan(fr_fav)
    p_base_f, p_soft_f = vb["p_fav"][m], vs["p_fav"][m]
    y_f = vb["y_fav"][m]
    fr = fr_fav[m]
    shift = p_soft_f - p_base_f

    print(f"\n=== §4 style confound · soft s=1.0 vs binary (both calibrated), seed {args.seed} ===")
    print(f"  n = {m.sum()}   mean |shift| {np.abs(shift).mean():.4f}   "
          f"mean shift {shift.mean():+.4f}")
    print(f"  corr(finish-rate of fav, confidence shift) = "
          f"{np.corrcoef(fr, shift)[0, 1]:+.4f}")

    # Terciles of the favourite's finish rate.
    q = np.quantile(fr, [1 / 3, 2 / 3])
    print(f"\n  {'fav style':<22} {'n':>4} {'mean fr':>8} {'shift':>8} "
          f"{'base ll':>8} {'soft ll':>8} {'d ll':>8} {'fav won':>8}")
    bands = [
        ("grappler (low fr)", fr <= q[0]),
        ("mixed", (fr > q[0]) & (fr <= q[1])),
        ("finisher (high fr)", fr > q[1]),
    ]
    rows = []
    for name, sel in bands:
        k = int(sel.sum())
        ll_b = log_loss(y_f[sel], np.clip(p_base_f[sel], EPS, 1 - EPS), labels=[0, 1])
        ll_s = log_loss(y_f[sel], np.clip(p_soft_f[sel], EPS, 1 - EPS), labels=[0, 1])
        print(f"  {name:<22} {k:>4} {fr[sel].mean():>8.3f} {shift[sel].mean():>+8.4f} "
              f"{ll_b:>8.4f} {ll_s:>8.4f} {ll_s - ll_b:>+8.4f} {y_f[sel].mean():>8.3f}")
        rows.append({"band": name, "n": k, "mean_fr": float(fr[sel].mean()),
                     "mean_shift": float(shift[sel].mean()), "base_ll": float(ll_b),
                     "soft_ll": float(ll_s), "d_ll": float(ll_s - ll_b),
                     "fav_win_rate": float(y_f[sel].mean())})

    print("\n  reading: if the shift rises with finish rate AND the soft column "
          "is worse for\n  finishers, the label is paying a striker premium rather "
          "than resolving the gap.")

    out = {
        "seed": args.seed,
        "n": int(m.sum()),
        "corr_finishrate_shift": float(np.corrcoef(fr, shift)[0, 1]),
        "mean_shift": float(shift.mean()),
        "bands": rows,
    }
    (ARTIFACTS_DIR / "lab_graded_style.json").write_text(json.dumps(out, indent=2))
    print(f"\nwrote {ARTIFACTS_DIR / 'lab_graded_style.json'}")


if __name__ == "__main__":
    main()

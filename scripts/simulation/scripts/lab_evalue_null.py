"""Validate the instrument before reading it: every claim, under a true null.

The audit in `lab_evalue.py` reports e-values, an e-BH decision and an
anytime-valid confidence sequence. Each of those is a promise about what
happens WHEN THE NULL IS TRUE, and none of them is worth quoting until the
promise has been checked on this pool rather than in general.

The null is easy to impose here and hard to argue with: keep every price,
every model probability and every stake exactly as they are, and resample
the OUTCOME from the market's own de-vigged probability. Then `q` is the
truth by construction, the stake is still predictable, and anything the
machinery finds is a false positive by definition.

Three things are measured:

  * E[e] and Ville coverage per segment. The martingale property says
    E[e] = 1 and Pr(sup_t e_t >= 1/alpha) <= alpha. Both are checked on the
    84 pre-registered slices, at their real sizes and in calendar order.
  * the e-BH FALSE-REJECTION RATE over the whole family. `lab_evalue.py`
    reports that e-BH rejects nothing on the real pool; that is one draw,
    and one draw is not a rate.
  * confidence-sequence coverage. The interval is supposed to hold at EVERY
    sample size simultaneously, so the run counts as covered only if the
    truth is inside it at every t, not at the last one.

The pool-level e-value is deliberately NOT summarised by its mean: over
1,787 bouts the wealth distribution is log-normal enough that the sample
mean of 40,000 draws is dominated by a handful of paths, and reporting
`E[e] = 1.00` from it would be reporting the estimator's failure as the
theorem's success. Segment-length processes are where the check has power.
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

import lab_evalue_common as ev  # noqa: E402
from lab_evalue_stages import _segs  # noqa: E402
from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402

ALPHA = 0.05
ALPHAS = (0.05, 0.10, 0.20)
PRIMARY_SEED = 42
SEED = 20260827
FRAME_CACHE = DATA_DIR / "lab_evalue_frame.parquet"


def priced() -> pd.DataFrame:
    f = pd.read_parquet(FRAME_CACHE)
    f = f[(f["seed"] == PRIMARY_SEED) & f["has_market"]]
    f = f[f["market"].notna() & f["p"].notna() & f["y"].notna()]
    return f.sort_values(["event_date", "bout_id"]).reset_index(drop=True)


def _setup(f: pd.DataFrame):
    """Per-bout log-increments for both outcomes, and the segment membership."""
    q = f["market"].to_numpy(float)
    lam = ev.clip_lambda(0.5 * ev.kelly_lambda(f["p"].to_numpy(float), q), q)
    L1 = np.log(np.maximum(1.0 + lam * (1 - q), ev.EPS))   # the bout resolves y=1
    L0 = np.log(np.maximum(1.0 - lam * q, ev.EPS))         # ... and y=0
    masks, names = [], []
    for seg in _segs(dedupe=True):
        if seg.family == "post_hoc":
            continue
        a, b = seg.mask(f)
        m = np.asarray(a | b)
        if m.sum() >= 20:
            masks.append(m)
            names.append(seg.name)
    return q, L1, L0, masks, names


def stage_null(f: pd.DataFrame, reps: int = 40_000, chunk: int = 250) -> dict:
    q, L1, L0, masks, names = _setup(f)
    K = len(masks)
    idx = [np.flatnonzero(m) for m in masks]
    M = np.ascontiguousarray(np.array([m.astype(np.float32) for m in masks]).T)
    rng = np.random.default_rng(SEED)

    e_sum = np.zeros(K)
    e_sq = np.zeros(K)
    sup_hits = np.zeros((len(ALPHAS), K))
    ebh_any = np.zeros(len(ALPHAS))
    ebh_rejections = np.zeros(len(ALPHAS))
    for s0 in range(0, reps, chunk):
        r = min(chunk, reps - s0)
        y = rng.random((r, len(q))) < q
        logs = np.where(y, L1, L0).astype(np.float32)
        e_seg = np.exp((logs @ M).astype(float))            # terminal wealth, (r, K)
        e_sum += e_seg.sum(axis=0)
        e_sq += (e_seg ** 2).sum(axis=0)
        for k, ix in enumerate(idx):                        # running max, in bout order
            sup = np.exp(np.cumsum(logs[:, ix], axis=1).max(axis=1).astype(float))
            for i, a in enumerate(ALPHAS):
                sup_hits[i, k] += float((sup >= 1 / a).sum())
        for i, a in enumerate(ALPHAS):
            for row in e_seg:
                rej = ev.e_bh(row, a)
                n = int(rej.sum())
                if n:
                    ebh_any[i] += 1
                    ebh_rejections[i] += n

    mean = e_sum / reps
    var = np.maximum(e_sq / reps - mean ** 2, 0.0)
    se = np.sqrt(var / reps)
    cov = sup_hits / reps
    out = dict(
        reps=int(reps), K=int(K), n_bouts=int(len(f)),
        e_mean_pooled=float(mean.mean()), e_mean_se_pooled=float(np.sqrt((se ** 2).sum()) / K),
        e_mean_min=float(mean.min()), e_mean_max=float(mean.max()),
        ville={f"{a}": dict(mean=float(cov[i].mean()), max=float(cov[i].max()),
                            over=int((cov[i] > a).sum()))
               for i, a in enumerate(ALPHAS)},
        ebh_any_rejection={f"{a}": float(ebh_any[i] / reps) for i, a in enumerate(ALPHAS)},
        ebh_false_rejections_per_run={f"{a}": float(ebh_rejections[i] / reps)
                                      for i, a in enumerate(ALPHAS)},
        worst_segment=str(names[int(np.argmax(cov[0]))]),
    )
    print(f"\n  {reps:,} replications, {K} pre-registered segments, {len(f)} bouts")
    print(f"    E[e] per segment: {out['e_mean_pooled']:.3f} +/- {out['e_mean_se_pooled']:.3f}"
          f"   (range over segments {out['e_mean_min']:.2f}-{out['e_mean_max']:.2f})")
    for a in ALPHAS:
        v = out["ville"][f"{a}"]
        print(f"    Pr(sup_t e_t >= 1/{a:g}) mean {v['mean']:.3f}, worst segment {v['max']:.3f}"
              f"  -> {v['over']} of {K} above {a:g}")
    print(f"    e-BH on {K} pure nulls rejects at all in "
          f"{out['ebh_any_rejection']['0.05']:.4f} of runs (alpha=0.05), "
          f"{out['ebh_false_rejections_per_run']['0.05']:.4f} false rejections per run")
    return out


def stage_cs_coverage(f: pd.DataFrame, reps: int = 1_000) -> dict:
    """Does the ROI confidence sequence hold at EVERY t, not just the last one?

    Simulated on the deployable rule's own bet sizes and prices: the returns
    are the real decimal payouts, and only the outcome is resampled, from a
    true win probability fixed at the null the CS is asked about.
    """
    s = f[f["lean_fav"] >= 0.05]
    fav_a = (s["market"] >= 0.5).to_numpy()
    dec = np.where(fav_a, s["dec_a"].to_numpy(float), s["dec_b"].to_numpy(float))
    win_p = np.where(fav_a, s["market"].to_numpy(float), 1 - s["market"].to_numpy(float))
    ok = np.isfinite(dec) & np.isfinite(win_p)
    dec, win_p = dec[ok], win_p[ok]
    truth = float(np.mean(win_p * (dec - 1.0) + (1 - win_p) * (-1.0)))
    hi = float(dec.max() - 1.0)
    rng = np.random.default_rng(SEED + 1)
    covered = 0
    for _ in range(reps):
        won = rng.random(len(dec)) < win_p
        r = np.where(won, dec - 1.0, -1.0)
        lo_cs, hi_cs = ev.betting_cs(r, alpha=ALPHA, lo=-1.0, hi=hi)
        inside = (lo_cs <= truth + 1e-12) & (truth - 1e-12 <= hi_cs)
        covered += int(bool(np.all(inside[~np.isnan(lo_cs)])))
    out = dict(reps=int(reps), n_bets=int(len(dec)), true_roi=truth,
               coverage_every_t=covered / reps)
    print(f"\n  CS coverage on {out['n_bets']} bets, true ROI {truth:+.3%}: "
          f"covered at EVERY t in {out['coverage_every_t']:.3f} of {reps:,} runs")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=40_000)
    ap.add_argument("--cs-reps", type=int, default=1_000)
    ap.add_argument("--stage", default="all", choices=["null", "cs", "all"])
    args = ap.parse_args()

    f = priced()
    res = {}
    if args.stage in ("null", "all"):
        res["null"] = stage_null(f, reps=args.reps)
    if args.stage in ("cs", "all"):
        res["cs"] = stage_cs_coverage(f, reps=args.cs_reps)
    if args.stage == "all":
        path = ARTIFACTS_DIR / "lab_evalue_null.json"
        path.write_text(json.dumps(res, indent=2, default=float))
        print(f"\n  wrote {path}")


if __name__ == "__main__":
    main()

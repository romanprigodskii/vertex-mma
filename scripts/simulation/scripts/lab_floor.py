"""Measure the selection instrument before reading anything it says.

A model-selection pipeline reports that a candidate improved a metric. It
almost never reports what change it could have detected, and the two are
different claims. This measures the second one on a deployed pipeline.

The construction that makes it measurable: the same recipe, refit under a
different random seed, is a NULL LEVER. It changes nothing real, so every
difference it produces is instrument noise, and there are C(5,2) = 10 such
comparisons available in a pool that was scored under five seeds. That
gives the noise distribution directly, without assuming one.
"""

from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy.stats import norm  # noqa: E402

from lab_edge_common import per_bout_logloss  # noqa: E402
from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402

SEEDS = [7, 13, 42, 99, 2024]
Z = norm.ppf(0.95) + norm.ppf(0.80)   # one-sided 5%, 80% power


def load_seed_matrix() -> tuple[np.ndarray, np.ndarray, list[str]]:
    """(n_seeds x n_bouts) of served probabilities, plus the shared labels."""
    frames = {}
    for seed in SEEDS:
        d = pd.read_parquet(DATA_DIR / f"lab_edge_pool_seed{seed}.parquet")
        frames[seed] = d.set_index("bout_id")
    common = sorted(set.intersection(*(set(d.index) for d in frames.values())))
    P = np.array([frames[s].loc[common, "p"].to_numpy(float) for s in SEEDS])
    y = frames[SEEDS[0]].loc[common, "y"].to_numpy(float)
    return P, y, common


def floor_report() -> dict:
    P, y, bouts = load_seed_matrix()
    n = len(y)
    LL = np.array([per_bout_logloss(P[i], y) for i in range(len(SEEDS))])
    per_seed = LL.mean(axis=1)

    # 1. the spread the project would see if it re-ran the SAME recipe
    sd_across_seeds = float(per_seed.std(ddof=1))

    # 2. the null lever: same recipe, different seed, paired by bout.
    #    This is the quantity a candidate has to beat, and it is not the
    #    same as the spread above -- pairing removes the bout-level noise
    #    that both arms share, which is most of it.
    pair_deltas, pair_ses = [], []
    for i, j in itertools.combinations(range(len(SEEDS)), 2):
        d = LL[i] - LL[j]
        pair_deltas.append(float(d.mean()))
        pair_ses.append(float(d.std(ddof=1) / np.sqrt(n)))
    paired_se = float(np.mean(pair_ses))

    # 3. how the floor moves with the seed budget.
    #    Averaging k seeds per arm shrinks the training-stochasticity term
    #    by k but leaves the bout-level term alone, so the floor has a
    #    horizontal asymptote and buying seeds walks you to it, not past it.
    #    Both components are estimated from the null lever itself.
    var_pair = float(np.var(pair_deltas, ddof=1))       # includes both terms
    var_bout = float(np.mean([s ** 2 for s in pair_ses]))
    var_seed = max(var_pair - var_bout, 0.0)
    curve = {}
    for k in (1, 2, 3, 5, 10, 25, 100):
        se_k = float(np.sqrt(var_bout + var_seed / k))
        curve[k] = dict(se=se_k, mde=float(Z * se_k))
    se_inf = float(np.sqrt(var_bout))
    curve["inf"] = dict(se=se_inf, mde=float(Z * se_inf))

    out = dict(
        n_bouts=int(n), n_seeds=len(SEEDS),
        per_seed_logloss={str(s): float(v) for s, v in zip(SEEDS, per_seed)},
        sd_across_seeds=sd_across_seeds,
        null_lever=dict(
            comparisons=len(pair_deltas),
            max_abs_delta=float(np.max(np.abs(pair_deltas))),
            paired_se=paired_se,
            sd_of_deltas=float(np.std(pair_deltas, ddof=1)),
        ),
        variance_split=dict(bout_level=var_bout, seed_level=var_seed,
                            seed_share=float(var_seed / (var_bout + var_seed))),
        mde_curve=curve,
        mde_single_seed=curve[1]["mde"], mde_infinite_seeds=curve["inf"]["mde"],
        floor_ratio=float(curve[1]["mde"] / curve["inf"]["mde"]),
    )

    print(f"  pool: {n:,} bouts scored under {len(SEEDS)} seeds")
    print(f"  per-seed OOF log-loss: " + ", ".join(f"{v:.5f}" for v in per_seed))
    print(f"  sd across seeds                       {sd_across_seeds:.5f}")
    print(f"  null lever (same recipe, other seed): {len(pair_deltas)} comparisons, "
          f"largest |delta| {out['null_lever']['max_abs_delta']:.5f}, "
          f"paired SE {paired_se:.5f}")
    print(f"  variance split: bout-level {var_bout:.3e}, seed-level {var_seed:.3e} "
          f"({out['variance_split']['seed_share']:.0%} of the total is the seed)")
    print("\n  one-sided 80% MDE against the seed budget:")
    for k, v in curve.items():
        print(f"    k={str(k):>4} seeds   SE {v['se']:.5f}   MDE {v['mde']:.5f}")
    print(f"\n  buying INFINITE seeds moves the floor by {out['floor_ratio']:.2f}x. "
          f"The bout-level term is {1-out['variance_split']['seed_share']:.0%} of the "
          f"variance and no seed budget touches it.")
    return out


if __name__ == "__main__":
    res = floor_report()
    (ARTIFACTS_DIR / "lab_floor.json").write_text(json.dumps(res, indent=2, default=float))
    print(f"\n  wrote {ARTIFACTS_DIR / 'lab_floor.json'}")

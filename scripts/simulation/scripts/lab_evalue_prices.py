"""Every headline at BOTH prices, and under a de-vig it did not choose.

Two questions a reader of `lab_evalue.py` is entitled to ask, and which the
first pass answered only for the pool as a whole.

  1. WHICH PRICE? The fair-odds process settles at $1/q$ and is the
     statistical object: it measures whether the closing line is wrong. The
     real-odds process settles at the decimals the book posted and is the
     deployable object: it measures whether a bettor could have banked the
     difference. The second is a supermartingale under the same null, so it
     is always the lower of the two, and the gap is the margin. Reporting a
     segment e-value without saying which one it is invites the reader to
     assume the flattering one.

  2. WHICH DE-VIG? `q` is the null. The lab de-vigs by the power method
     (`lab_edge_common.power_devig`), which takes proportionally more off
     the longshot than the proportional split does. That choice matters
     most exactly where the post-hoc rule lives -- the proportional split
     understates `q` on favourites, which inflates `p - q` on favourites,
     which is a false-positive mechanism aimed straight at a rule that
     backs them. So both alternatives are recomputed end to end: the null
     moves, the Kelly stake moves with it, and every threshold family is
     re-cut on the new prices.

Shin's de-vig is implemented here rather than imported because the repo has
never carried one; `docs/edge_segments.md` §1 retracts an earlier draft's
Shin figures for exactly that reason, and a number with no code behind it
should not appear in a paper twice.
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
from lab_evalue_stages import DISCOVERY_END, _segs  # noqa: E402
from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402

ALPHA = 0.05
SEEDS = [42, 7, 13, 99, 2024]
PRIMARY_SEED = 42
STREAK = "form_momentum__long_win_streak_4plus"
GRID = np.round(np.arange(0.02, 0.2251, 0.01), 3)
FRAME_CACHE = DATA_DIR / "lab_evalue_frame.parquet"


def shin_devig(dec_a: np.ndarray, dec_b: np.ndarray) -> np.ndarray:
    """Shin (1993), two outcomes: strip the margin a book charges for insiders.

    With vigged implied probabilities pi_i = 1/d_i summing to Pi > 1,

        q_i(z) = [sqrt(z^2 + 4(1-z) pi_i^2 / Pi) - z] / (2(1-z)),

    and z -- the notional share of informed money -- solved so the pair sums
    to one. Bisection rather than a solver call: q_a + q_b - 1 is monotone in
    z, positive at 0 and negative at 1, so the bracket is guaranteed and the
    whole pool is done in one vectorised pass.
    """
    pa, pb = 1.0 / np.asarray(dec_a, float), 1.0 / np.asarray(dec_b, float)
    total = pa + pb

    def q(z: np.ndarray, pi: np.ndarray) -> np.ndarray:
        return (np.sqrt(z * z + 4 * (1 - z) * pi * pi / total) - z) / (2 * (1 - z))

    lo = np.full(len(pa), 1e-9)
    hi = np.full(len(pa), 1 - 1e-9)
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        above = (q(mid, pa) + q(mid, pb) - 1.0) > 0
        lo = np.where(above, mid, lo)
        hi = np.where(above, hi, mid)
    return q(0.5 * (lo + hi), pa)


def priced(frame: pd.DataFrame, seed: int) -> pd.DataFrame:
    f = frame[(frame["seed"] == seed) & frame["has_market"]].copy()
    f = f[f["market"].notna() & f["p"].notna() & f["y"].notna()]
    return f.sort_values(["event_date", "bout_id"]).reset_index(drop=True)


def recut(f: pd.DataFrame, q: np.ndarray) -> pd.DataFrame:
    """Re-derive every price-dependent column from a different de-vig.

    `market_conf`, `disagreement`, `lean_fav` and `same_favourite` are all
    functions of q, and segments and threshold families are cut on them. A
    robustness check that moved only the stake would be checking nothing.
    """
    g = f.copy()
    p = g["p"].to_numpy(float)
    g["market"] = q
    g["market_conf"] = np.maximum(q, 1 - q)
    g["disagreement"] = np.abs(p - q)
    fav_a = q >= 0.5
    g["lean_fav"] = np.where(fav_a, p, 1 - p) - np.where(fav_a, q, 1 - q)
    g["same_favourite"] = (p >= 0.5) == (q >= 0.5)
    return g


def _fair(s: pd.DataFrame) -> np.ndarray:
    return ev.wealth_increments(s["p"].to_numpy(float), s["market"].to_numpy(float),
                                s["y"].to_numpy(float), frac=0.5)


def _real(s: pd.DataFrame) -> np.ndarray:
    return ev.vigged_increments(s["p"].to_numpy(float), s["market"].to_numpy(float),
                                s["y"].to_numpy(float), s["dec_a"].to_numpy(float),
                                s["dec_b"].to_numpy(float), frac=0.5)


def both(s: pd.DataFrame, label: str, quiet: bool = False) -> dict:
    a, b = _fair(s), _real(s)
    d = dict(label=label, n=int(len(s)), e_fair=ev.evalue(a), e_real=ev.evalue(b),
             growth_fair=ev.log_growth(a), growth_real=ev.log_growth(b))
    d["margin_cost"] = d["growth_fair"] - d["growth_real"]
    d["bouts_needed_fair"] = ev.bouts_to_reject(a)
    d["bouts_needed_real"] = ev.bouts_to_reject(b)
    if not quiet:
        print(f"    {label:<40} n={d['n']:>5}  fair {d['e_fair']:>10.4g}  "
              f"real {d['e_real']:>9.4g}   margin {d['margin_cost']:.5f} nats/bout")
    return d


def segment_rows(f: pd.DataFrame, name: str) -> pd.DataFrame:
    seg = {s.name: s for s in _segs()}[name]
    a, b = seg.mask(f)
    return f[a | b].sort_values(["event_date", "bout_id"])


def mixture(f: pd.DataFrame, masks: list[np.ndarray], real: bool) -> float:
    paths = []
    for m in masks:
        s = f[m]
        if len(s) < 10:
            paths.append(np.array([1.0]))
            continue
        paths.append(ev.running_evalue(_real(s) if real else _fair(s)))
    return float(ev.mixture_evalue(paths)[-1])


def families(f: pd.DataFrame) -> dict[str, list[np.ndarray]]:
    back = [(f["lean_fav"] >= th).to_numpy() for th in GRID]
    fade = [(f["lean_fav"] <= -th).to_numpy() for th in GRID]
    disagree = [(f["disagreement"] >= th).to_numpy() for th in GRID]
    return {"thresholds (21)": back, "+ direction (42)": back + fade,
            "+ statistic (63)": back + fade + disagree}


def stage_bases(frame: pd.DataFrame) -> dict:
    """The whole ladder, twice: at the fair price and at the one on offer."""
    f = priced(frame, PRIMARY_SEED)
    s = segment_rows(f, STREAK)
    is_conf = (s["event_date"] >= DISCOVERY_END).to_numpy()
    print("\n  the ladder at both prices")
    out = dict(
        pool=both(f, "whole priced pool"),
        overround=float(f["overround"].mean()),
        streak_full=both(s, "streak, full pool"),
        streak_discovery=both(s[~is_conf], "streak, discovery window"),
        streak_replication=both(s[is_conf], "streak, replication window"),
        declared_cut=both(f[f["lean_fav"] >= 0.05], "declared cut lean>=0.05"),
    )
    r = out["streak_replication"]
    print(f"      replication window needs {r['bouts_needed_fair']:.0f} bouts at fair odds "
          f"and {r['bouts_needed_real']:.0f} at real ones ({r['n']} have arrived)")
    out["ladder"] = {}
    for label, masks in families(f).items():
        row = dict(e_fair=mixture(f, masks, False), e_real=mixture(f, masks, True))
        out["ladder"][label] = row
        print(f"    mixture over {label:<20} fair {row['e_fair']:>7.2f}   real {row['e_real']:>7.2f}")
    return out


def stage_seeds(frame: pd.DataFrame) -> dict:
    """The same segment on five walk-forward seeds -- the spread is the result."""
    print("\n  the streak segment across seeds")
    rows = [both(segment_rows(priced(frame, sd), STREAK), f"seed {sd}") for sd in SEEDS]
    fair = np.array([r["e_fair"] for r in rows])
    real = np.array([r["e_real"] for r in rows])
    out = dict(per_seed={str(sd): r for sd, r in zip(SEEDS, rows, strict=True)},
               fair=dict(min=float(fair.min()), median=float(np.median(fair)),
                         max=float(fair.max()), all_reject=bool((fair >= 1 / ALPHA).all())),
               real=dict(min=float(real.min()), median=float(np.median(real)),
                         max=float(real.max()), all_reject=bool((real >= 1 / ALPHA).all())))
    print(f"    fair  min {fair.min():.1f}  median {np.median(fair):.1f}  max {fair.max():.1f}"
          f"   -> {'all' if out['fair']['all_reject'] else 'not all'} clear 1/alpha")
    print(f"    real  min {real.min():.1f}  median {np.median(real):.1f}  max {real.max():.1f}"
          f"   -> {'all' if out['real']['all_reject'] else 'not all'} clear 1/alpha")
    return out


def stage_devig(frame: pd.DataFrame) -> dict:
    """Is the finding a property of the market, or of how we removed the vig?"""
    f0 = priced(frame, PRIMARY_SEED)
    dec_a, dec_b = f0["dec_a"].to_numpy(float), f0["dec_b"].to_numpy(float)
    bases = {
        "power (reported)": f0["market"].to_numpy(float),
        "proportional": (1 / dec_a) / ((1 / dec_a) + (1 / dec_b)),
        "shin": shin_devig(dec_a, dec_b),
    }
    out = {}
    for label, q in bases.items():
        f = recut(f0, q)
        s = segment_rows(f, STREAK)
        conf = (s["event_date"] >= DISCOVERY_END).to_numpy()
        mixes = {k: mixture(f, m, False) for k, m in families(f).items()}
        out[label] = dict(
            mean_favourite_price=float(np.maximum(q, 1 - q).mean()),
            streak=both(s, f"{label}: streak", quiet=True),
            streak_replication=both(s[conf], f"{label}: replication", quiet=True),
            ladder_fair=mixes,
            declared_cut_n=int((f["lean_fav"] >= 0.05).sum()),
        )
        r = out[label]
        print(f"\n    {label}")
        print(f"      streak e = {r['streak']['e_fair']:.1f} fair / {r['streak']['e_real']:.1f} real"
              f"   replication {r['streak_replication']['e_fair']:.2f}")
        rungs = " / ".join(f"{v:.1f}" for v in mixes.values())
        print(f"      ladder   {rungs}   (declared cut n={r['declared_cut_n']})")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="all", choices=["bases", "seeds", "devig", "all"])
    args = ap.parse_args()

    frame = pd.read_parquet(FRAME_CACHE)
    res = {}
    if args.stage in ("bases", "all"):
        res["bases"] = stage_bases(frame)
    if args.stage in ("seeds", "all"):
        res["seeds"] = stage_seeds(frame)
    if args.stage in ("devig", "all"):
        res["devig"] = stage_devig(frame)
    if args.stage == "all":
        path = ARTIFACTS_DIR / "lab_evalue_prices.json"
        path.write_text(json.dumps(res, indent=2, default=float))
        print(f"\n  wrote {path}")


if __name__ == "__main__":
    main()

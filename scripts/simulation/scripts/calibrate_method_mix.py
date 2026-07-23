"""Calibrate the Monte Carlo method mix (KO/Sub/Dec) on PRE-TEST data.

The method-market backtest (eval_method_market.py) showed the MC is
finish-heavy on the 2025+ test window: KO 38.7% predicted vs 31.0%
actual, Dec 38.0% vs 51.0%. The knobs are the per-fight total finish
log-hazard scales (KO_TOTAL_SCALE / SUB_TOTAL_SCALE) and the anchor
weight METHOD_ANCHOR_LAMBDA in src/monte_carlo.py — hand-tuned
constants, not trained, so they can be recalibrated on train/val
without burning the test split.

Calibration window: [--start, VAL_END) — default 2021-01-01, the
modern era, STRICTLY before the eval's test split.

Objective: mean 3-class log-loss of the CONDITIONAL method given the
actual winner side, -log P_mc(method | winner). The production
reconciliation (sportsbook.ts reconcileMethodProbs) preserves exactly
this conditional mix and takes the winner LEVEL from the ensemble, so
the conditional loss isolates the MC's contribution — no ensemble
probs involved, nothing optimistic leaks in. Marginal aggregates
(via MC winner-prob weighting) are reported alongside as a sanity
check.

Grid search: coarse multipliers on the two hazard scales at the
current lambda, then a refinement pass around the best cell that also
sweeps lambda. MC runs at n=2000 sims (seed = stable_hash(bout_id),
same contract as production) in parallel via joblib.

Usage (from scripts/simulation, venv active):
  python scripts/calibrate_method_mix.py            # full grid, prints table
  python scripts/calibrate_method_mix.py --start 2022-01-01
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from joblib import Parallel, delayed  # noqa: E402

import src.monte_carlo as mc  # noqa: E402
from src.config import ARTIFACTS_DIR, VAL_END  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.export import (  # noqa: E402
    build_dataset,
    fetch_raw,
    stable_hash,
    symmetrize_for_training,
)

N_SIMS = 2000
BASE_KO = mc.KO_TOTAL_SCALE
BASE_SUB = mc.SUB_TOTAL_SCALE
BASE_LAM = mc.METHOD_ANCHOR_LAMBDA

# The MC's finish TIMING comes from a fitted hazard artifact. Use the
# split-trained twin, never the served all-data one, so the timing model has
# not seen the bouts being calibrated on. Same reasoning as
# eval_market.py's ensemble_eval resolution.
#
# CAVEAT, and it is a real one: the default calibration window starts
# 2021-01-01 while the hazard's train split ends at TRAIN_END=2024-01-01, so
# three of the four years here ARE in the hazard's training data. A lambda
# swept on this window is optimistic about the per-fight mix. Run with
# --start 2024-01-01 for a window that is fully out-of-sample for the timing
# model; the wider window is kept because it is what the recorded
# METHOD_ANCHOR_LAMBDA=0.80 was measured on and comparability matters.
_HAZARD_EVAL_PATH = ARTIFACTS_DIR / "finish_hazard_eval.json"
_DECISION_EVAL_PATH = ARTIFACTS_DIR / "decision_winner_eval.json"
_EXPECT_OOS_START = "2024-01-01"

OUTCOME_SQL = """
SELECT b.id::text, b.fighter_a_id::text, b.winner_id::text, b.method::text
FROM bout b
WHERE b.id = ANY(%s::uuid[])
"""


def _bucket(method: str | None) -> str | None:
    if method in ("ko", "tko"):
        return "ko"
    if method == "submission":
        return "sub"
    if method is not None and method.startswith("decision"):
        return "dec"
    return None


def _sim_one(
    snap_a: dict,
    snap_b: dict,
    scheduled_rounds: int,
    seed: int,
    ko_scale: float,
    sub_scale: float,
    lam: float,
    is_main_event: bool = False,
    is_title_fight: bool = False,
) -> tuple[float, float, float, float, float, float]:
    """Run one bout's MC with overridden constants; return the six
    anchored cells (ko_a, sub_a, dec_a, ko_b, sub_b, dec_b)."""
    mc.KO_TOTAL_SCALE = ko_scale
    mc.SUB_TOTAL_SCALE = sub_scale
    mc.METHOD_ANCHOR_LAMBDA = lam
    # Runs inside a joblib worker process, which has its own module globals —
    # load here, not in main(). Cached by path, so this is a dict lookup after
    # the first call in each worker.
    if _HAZARD_EVAL_PATH.exists():
        mc.load_hazard_model(_HAZARD_EVAL_PATH)
    if _DECISION_EVAL_PATH.exists():
        mc.load_decision_model(_DECISION_EVAL_PATH)
    r = mc.simulate_bout(
        mc.FighterMC.from_snapshot(snap_a),
        mc.FighterMC.from_snapshot(snap_b),
        scheduled_rounds,
        n_simulations=N_SIMS,
        seed=seed,
        is_main_event=is_main_event,
        is_title_fight=is_title_fight,
    )
    return (r.prob_ko_a, r.prob_sub_a, r.prob_decision_a,
            r.prob_ko_b, r.prob_sub_b, r.prob_decision_b)


def evaluate_point(
    jobs: list[tuple],
    winner_side: np.ndarray,
    actual_bucket: np.ndarray,
    ko_scale: float,
    sub_scale: float,
    lam: float,
) -> dict:
    cells = Parallel(n_jobs=-1, batch_size=64)(
        delayed(_sim_one)(sa, sb, rd, seed, ko_scale, sub_scale, lam, me, tf)
        for (sa, sb, rd, seed, me, tf) in jobs
    )
    cells = np.asarray(cells)  # (n, 6): ko_a, sub_a, dec_a, ko_b, sub_b, dec_b
    eps = 1e-9

    # Conditional method-given-winner (what reconciliation preserves).
    idx_a = winner_side == 0
    side_cells = np.where(idx_a[:, None], cells[:, :3], cells[:, 3:])
    side_sum = side_cells.sum(axis=1)
    degenerate = side_sum <= 0
    cond = np.where(
        degenerate[:, None], 1.0 / 3.0, side_cells / np.maximum(side_sum, eps)[:, None]
    )
    m_idx = actual_bucket  # 0=ko, 1=sub, 2=dec
    cond_ll = float(-np.log(np.clip(cond[np.arange(len(cond)), m_idx], eps, None)).mean())

    # Marginals via MC winner weighting (cells already sum to winner probs).
    marg = {
        "ko": float((cells[:, 0] + cells[:, 3]).mean()),
        "sub": float((cells[:, 1] + cells[:, 4]).mean()),
        "dec": float((cells[:, 2] + cells[:, 5]).mean()),
    }
    return {"cond_ll": cond_ll, **marg}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", type=str, default="2021-01-01")
    ap.add_argument(
        "--point",
        action="append",
        default=None,
        metavar="KO_MULT,SUB_MULT,LAM",
        help="evaluate only these points (repeatable), skip the grid",
    )
    args = ap.parse_args()

    df = symmetrize_for_training(build_dataset(fetch_raw()))
    dt = pd.to_datetime(df["event_date"])
    window = (dt >= pd.to_datetime(args.start)) & (dt < pd.to_datetime(VAL_END))
    df_cal = df.loc[window.to_numpy()].reset_index(drop=True)
    print(f"calibration window {args.start} → {VAL_END}: {len(df_cal)} bouts")
    if _HAZARD_EVAL_PATH.exists():
        print(f"finish timing: split-trained {_HAZARD_EVAL_PATH.name}")
        print(
            "decision winner: "
            + (
                f"split-trained {_DECISION_EVAL_PATH.name}"
                if _DECISION_EVAL_PATH.exists()
                else "legacy hand-set logit"
            )
        )
        if args.start < _EXPECT_OOS_START:
            print(
                f"WARNING: window starts before {_EXPECT_OOS_START}, so part of it "
                "is inside the hazard model's training data — the lambda picked "
                "here is optimistic. Re-run with --start "
                f"{_EXPECT_OOS_START} for a fully out-of-sample sweep."
            )
    else:
        print("finish timing: legacy hand-set damage shape (no hazard artifact)")

    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(OUTCOME_SQL, (df_cal["bout_id"].tolist(),))
        rows = {r[0]: r for r in cur.fetchall()}

    jobs: list[tuple] = []
    winner_side: list[int] = []
    actual_bucket: list[int] = []
    bucket_ids = {"ko": 0, "sub": 1, "dec": 2}
    for i in range(len(df_cal)):
        row = df_cal.iloc[i]
        r = rows.get(row["bout_id"])
        if r is None:
            continue
        _, _db_fa, db_winner, db_method = r
        bucket = _bucket(db_method)
        if bucket is None or db_winner is None:
            continue  # DQ / draw / missing method — not a 3-class outcome
        # df rows already carry the symmetrized (possibly flipped) fighter
        # ids, so the winner side is a direct id comparison.
        if db_winner == row["fighter_a_id"]:
            side = 0
        elif db_winner == row["fighter_b_id"]:
            side = 1
        else:
            continue
        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        jobs.append((
            snap_a, snap_b, int(row["scheduled_rounds"]), stable_hash(row["bout_id"]),
            bool(row["is_main_event"]), bool(row["is_title_fight"]),
        ))
        winner_side.append(side)
        actual_bucket.append(bucket_ids[bucket])

    ws = np.array(winner_side)
    ab = np.array(actual_bucket)
    n = len(jobs)
    actual = {k: float((ab == v).mean()) for k, v in bucket_ids.items()}
    print(f"{n} gradeable bouts · actual mix ko {actual['ko']:.3f} / "
          f"sub {actual['sub']:.3f} / dec {actual['dec']:.3f}")
    # Reference: a CONSTANT predictor of the window's own base rates. Any
    # per-fight mix worth keeping must beat this; λ→1 converges to ~it.
    const_ll = -float(
        actual["ko"] * np.log(actual["ko"])
        + actual["sub"] * np.log(actual["sub"])
        + actual["dec"] * np.log(actual["dec"])
    )
    print(f"constant base-rate predictor cond_ll: {const_ll:.4f}")

    def show(tag: str, ko_m: float, sub_m: float, lam: float, res: dict) -> None:
        print(
            f"{tag} ko_mult={ko_m:.2f} sub_mult={sub_m:.2f} lam={lam:.2f} | "
            f"cond_ll {res['cond_ll']:.4f} | marginals ko {res['ko']:.3f} "
            f"sub {res['sub']:.3f} dec {res['dec']:.3f}"
        )

    results: dict[tuple, dict] = {}

    def run(ko_m: float, sub_m: float, lam: float, tag: str = " ") -> dict:
        key = (round(ko_m, 3), round(sub_m, 3), round(lam, 3))
        if key not in results:
            results[key] = evaluate_point(jobs, ws, ab, BASE_KO * ko_m, BASE_SUB * sub_m, lam)
            show(tag, ko_m, sub_m, lam, results[key])
        return results[key]

    if args.point:
        print("\n=== requested points ===")
        for p in args.point:
            ko_m, sub_m, lam = (float(x) for x in p.split(","))
            run(ko_m, sub_m, lam, "*")
        return

    print("\n=== baseline (current constants) ===")
    run(1.0, 1.0, BASE_LAM, "*")

    print("\n=== coarse grid ===")
    for ko_m in (0.55, 0.70, 0.85, 1.00):
        for sub_m in (0.55, 0.70, 0.85, 1.00):
            run(ko_m, sub_m, BASE_LAM)

    best = min(results, key=lambda k: results[k]["cond_ll"])
    print(f"\ncoarse best: {best} cond_ll {results[best]['cond_ll']:.4f}")

    print("\n=== refine scales around best (± 0.075, base lambda) ===")
    ko_c, sub_c, _ = best
    for ko_m in (ko_c - 0.075, ko_c, ko_c + 0.075):
        for sub_m in (sub_c - 0.075, sub_c, sub_c + 0.075):
            if ko_m <= 0 or sub_m <= 0:
                continue
            run(ko_m, sub_m, BASE_LAM)

    best = min(results, key=lambda k: results[k]["cond_ll"])
    print(f"\n=== lambda sweep at scales ({best[0]:.3f}, {best[1]:.3f}) ===")
    for lam in (0.15, 0.25, 0.4, 0.6, 0.8, 1.0):
        run(best[0], best[1], lam)

    best = min(results, key=lambda k: results[k]["cond_ll"])
    r = results[best]
    print(f"\n=== BEST ===")
    show("*", best[0], best[1], best[2], r)
    print(
        f"→ KO_TOTAL_SCALE = {BASE_KO * best[0]:.4f}, "
        f"SUB_TOTAL_SCALE = {BASE_SUB * best[1]:.4f}, "
        f"METHOD_ANCHOR_LAMBDA = {best[2]:.2f}"
    )
    print(
        f"marginal errors vs actual: ko {abs(r['ko']-actual['ko'])*100:+.1f}pp "
        f"sub {abs(r['sub']-actual['sub'])*100:+.1f}pp dec {abs(r['dec']-actual['dec'])*100:+.1f}pp"
    )


if __name__ == "__main__":
    main()

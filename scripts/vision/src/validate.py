"""The gate. Pre-registered, so it can actually fail.

The thresholds below are fixed before the first fight is processed. That
is the whole point of running this as a gate rather than as an
exploration: a correlation you go looking for after seeing the scatter
is not evidence, and this codebase has already paid for that lesson once
(20 style hypotheses, 0 survivors, and the one survivor that did clear
its gate was refused by the rolling basis anyway).

Ground truth is UFCStats' positional strike split and control time. It
is not perfect — it is hand-tagged and it undercounts scrambles — but it
is independent of anything the pose model does, which is what a gate
requires.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ARTIFACTS = Path(__file__).resolve().parents[1] / "artifacts"

# --- Pre-registered thresholds -------------------------------------------
# Recovering a known quantity is a low bar by design. If pose cannot
# clear it on the thing UFCStats measures most bluntly, it will not see
# anything subtler.
PASS_RHO = 0.50
WEAK_RHO = 0.25
MAX_P_VALUE = 0.01

# A fight where two bodies were resolvable in under half the frames is
# not evidence either way — it is a pipeline failure, and counting it as
# a miss would blame the hypothesis for the plumbing.
MIN_COVERAGE = 0.50
MIN_FIGHTS = 30

PERMUTATIONS = 20_000
SEED = 7
# -------------------------------------------------------------------------


@dataclass(frozen=True)
class Correlation:
    name: str
    n: int
    rho: float
    p_value: float
    verdict: str


def _spearman(x: np.ndarray, y: np.ndarray) -> float:
    rx = pd.Series(x).rank().to_numpy()
    ry = pd.Series(y).rank().to_numpy()
    rx = rx - rx.mean()
    ry = ry - ry.mean()
    denom = np.sqrt((rx**2).sum() * (ry**2).sum())
    return float((rx * ry).sum() / denom) if denom > 0 else 0.0


def _permutation_p(x: np.ndarray, y: np.ndarray, rho: float, rng) -> float:
    """Two-sided, distribution-free. n is ~40; asymptotic p-values lie."""
    y_perm = y.copy()
    hits = 0
    for _ in range(PERMUTATIONS):
        rng.shuffle(y_perm)
        if abs(_spearman(x, y_perm)) >= abs(rho):
            hits += 1
    return (hits + 1) / (PERMUTATIONS + 1)


def _verdict(rho: float, p: float) -> str:
    if rho >= PASS_RHO and p <= MAX_P_VALUE:
        return "pass"
    if rho >= WEAK_RHO:
        return "weak"
    return "fail"


def correlate(df: pd.DataFrame, pose_col: str, truth_col: str, rng) -> Correlation:
    sub = df[[pose_col, truth_col]].dropna()
    x = sub[pose_col].to_numpy(dtype=float)
    y = sub[truth_col].to_numpy(dtype=float)
    if len(x) < 3:
        return Correlation(f"{pose_col} ~ {truth_col}", len(x), float("nan"), 1.0, "fail")
    rho = _spearman(x, y)
    p = _permutation_p(x, y, rho, rng)
    return Correlation(f"{pose_col} ~ {truth_col}", len(x), rho, p, _verdict(rho, p))


# The primary is the gate. The secondaries are diagnostics — they say
# *how* it failed, if it failed, but they do not get to rescue it.
PRIMARY = ("frac_ground", "ground_strike_share")
SECONDARY = (
    ("frac_ground", "control_share"),
    ("frac_distance", "distance_strike_share"),
    ("mean_separation", "distance_strike_share"),
)


def run(df: pd.DataFrame) -> dict:
    rng = np.random.default_rng(SEED)

    eligible = df[df["coverage"] >= MIN_COVERAGE].copy()
    dropped = len(df) - len(eligible)

    if len(eligible) < MIN_FIGHTS:
        return {
            "verdict": "inconclusive",
            "reason": (
                f"{len(eligible)} fights cleared coverage >= {MIN_COVERAGE}; "
                f"the gate needs {MIN_FIGHTS}"
            ),
            "fights_total": len(df),
            "fights_dropped_low_coverage": dropped,
        }

    primary = correlate(eligible, *PRIMARY, rng=rng)
    secondaries = [correlate(eligible, a, b, rng=rng) for a, b in SECONDARY]

    return {
        "verdict": primary.verdict,
        "thresholds": {
            "pass_rho": PASS_RHO, "weak_rho": WEAK_RHO,
            "max_p": MAX_P_VALUE, "min_coverage": MIN_COVERAGE,
            "min_fights": MIN_FIGHTS,
        },
        "fights_total": len(df),
        "fights_used": len(eligible),
        "fights_dropped_low_coverage": dropped,
        "median_coverage": float(eligible["coverage"].median()),
        "median_ambiguity_rate": float(eligible["ambiguity_rate"].median()),
        "primary": asdict(primary),
        "secondary": [asdict(c) for c in secondaries],
    }


def write_report(df: pd.DataFrame, suffix: str = "") -> Path:
    report = run(df)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS / f"validation{suffix}.json"
    path.write_text(json.dumps(report, indent=2))
    return path

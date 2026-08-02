"""Pins the shipped residual correction (src/ensemble.py ResidualCorrector).

Three properties, each of which would be a silent failure if it broke:

  * ANTISYMMETRY. predict.py averages both fighter orderings. A correction
    that did not negate on a swap would survive that averaging as a constant
    push toward whoever sits in slot A — and slot A is ~95 % the winner in the
    raw scrape, so the backtest would look excellent and the served numbers
    would be garbage. This is the same failure mode `symmetrize_for_training`
    exists to prevent, one layer further down.
  * NaN SAFETY. A fighter with no date of birth has NaN age. The correction
    must leave that bout alone, not shift it by a guess.
  * DIRECTION. The whole point is that the ensemble under-penalises the older
    fighter; a sign flip would double the bias instead of removing it.

Run: ./venv/bin/python tests/test_residual_correction.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.config import RESIDUAL_CORRECTION  # noqa: E402
from src.ensemble import ResidualCorrector  # noqa: E402

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
_results: list[tuple[str, bool]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    _results.append((name, bool(cond)))
    print(f"  {PASS if cond else FAIL}  {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    corr = ResidualCorrector([{"column": "diff_age", "weight": -0.3, "scale": 10.0}])

    print("antisymmetry — the property order-averaging depends on")
    p = np.array([0.5, 0.62, 0.31, 0.80])
    d = np.array([8.0, -4.0, 0.0, 12.0])
    X = pd.DataFrame({"diff_age": d})
    X_sw = pd.DataFrame({"diff_age": -d})
    # The swapped orientation of a perfectly antisymmetric model.
    served = 0.5 * (corr.transform(p, X) + (1.0 - corr.transform(1 - p, X_sw)))
    direct = corr.transform(p, X)
    check("order-averaging a symmetric model reproduces one side exactly",
          bool(np.allclose(served, direct, atol=1e-12)),
          f"max diff {np.abs(served - direct).max():.2e}")
    check("a zero age gap is left untouched", abs(direct[2] - p[2]) < 1e-12)

    print("\ndirection")
    older_a = corr.transform(np.array([0.5]), pd.DataFrame({"diff_age": [10.0]}))[0]
    older_b = corr.transform(np.array([0.5]), pd.DataFrame({"diff_age": [-10.0]}))[0]
    check("ten years older → lower P(A)", older_a < 0.5, f"{older_a:.4f}")
    check("ten years younger → higher P(A)", older_b > 0.5, f"{older_b:.4f}")
    check("the two are mirror images", abs((older_a + older_b) - 1.0) < 1e-12)
    check("the size is a nudge, not a rewrite", 0.40 < older_a < 0.49, f"{older_a:.4f}")

    print("\nNaN safety")
    p_nan = corr.transform(np.array([0.7, 0.7]), pd.DataFrame({"diff_age": [np.nan, 0.0]}))
    check("a missing age shifts nothing", abs(p_nan[0] - 0.7) < 1e-12, f"{p_nan[0]:.6f}")
    check("...and matches the zero-gap case", abs(p_nan[0] - p_nan[1]) < 1e-12)

    print("\nmonotonicity in the model's own probability")
    grid = np.linspace(0.05, 0.95, 50)
    out = corr.transform(grid, pd.DataFrame({"diff_age": np.full(50, 6.0)}))
    check("ordering is preserved", bool(np.all(np.diff(out) > 0)))

    print("\nguards")
    try:
        corr.transform(np.array([0.5]), pd.DataFrame({"something_else": [1.0]}))
        check("a missing feature raises", False)
    except KeyError:
        check("a missing feature raises", True)
    for bad in ([], [{"column": "diff_age", "weight": 1.0}],
                [{"column": "diff_age", "weight": 1.0, "scale": 0.0}]):
        try:
            ResidualCorrector(bad)  # type: ignore[arg-type]
            check(f"rejects {bad}", False)
        except ValueError:
            check(f"rejects malformed spec ({len(bad)} terms)", True)

    print("\nserialization")
    rt = ResidualCorrector.from_dict(corr.to_dict())
    check("JSON round-trip is exact",
          bool(np.allclose(rt.transform(p, X), corr.transform(p, X), atol=1e-15)))

    print("\nthe shipped configuration")
    if RESIDUAL_CORRECTION is None:
        check("config.RESIDUAL_CORRECTION is set", False, "None — nothing ships")
    else:
        shipped = ResidualCorrector.from_dict(RESIDUAL_CORRECTION)
        check("config parses", True, shipped.describe())
        check("slope is pinned to 1 (an offset, not a temperature)",
              abs(shipped.slope - 1.0) < 1e-12)
        ages = [t for t in shipped.terms if t["column"] == "diff_age"]
        check("corrects on the age difference", len(ages) == 1)
        check("and penalises the older fighter", ages[0]["weight"] < 0,
              f"{ages[0]['weight']:+.4f}")

    failed = [n for n, ok in _results if not ok]
    print(f"\n{len(_results) - len(failed)}/{len(_results)} checks passed")
    if failed:
        print("failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

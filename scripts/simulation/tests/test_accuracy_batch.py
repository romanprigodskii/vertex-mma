"""Contracts introduced by the accuracy batch (docs/accuracy_batch.md).

Three things, each of which a plausible edit would silently break:

  1. the served debut specialist is UNTOUCHED. `debut_feature_names()` with
     no argument must still be the v0.8.0 list, because the levels lever
     failed its gate and the plumbing was kept anyway.
  2. `dlvl_*_a` / `_b` swap correctly under `swap_sides`. The whole reason
     `add_debut_levels` takes the row frame rather than permuting columns of
     X is that a naive permutation gets exactly these pairs wrong — and
     getting them wrong breaks the antisymmetry the order averaging depends
     on, silently, in a direction that looks like a small accuracy gain.
  3. `iter_origins` never lets a scoring row into its own training or
     validation window. The pools this batch added are only worth what that
     invariant is worth.

Run: ./venv/bin/python tests/test_accuracy_batch.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(PACKAGE_ROOT / "scripts"))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.export import swap_sides  # noqa: E402
from src.features import (  # noqa: E402
    DEBUT_LEVEL_COLUMNS,
    build_debut_matrix,
    debut_feature_names,
    feature_names,
)

DATASET = PACKAGE_ROOT / "data" / "dataset.parquet"


def test_served_debut_list_unchanged() -> None:
    assert debut_feature_names() == feature_names() + ["is_debut_a", "is_debut_b"]
    # and the levels variant is strictly additive, in a pinned order
    extended = debut_feature_names(levels=True)
    assert extended[: len(debut_feature_names())] == debut_feature_names()
    tail = extended[len(debut_feature_names()) :]
    assert tail == [
        f"dlvl_{c}_{s}" for c in DEBUT_LEVEL_COLUMNS for s in ("a", "b")
    ]
    print(
        f"  served list {len(debut_feature_names())} cols · "
        f"with levels {len(extended)} cols — additive"
    )


def test_debut_levels_are_antisymmetric(df: pd.DataFrame) -> None:
    sub = df.head(400).reset_index(drop=True)
    X, _, _ = build_debut_matrix(sub, levels=True)
    X_sw, _, _ = build_debut_matrix(swap_sides(sub), levels=True)
    for col in DEBUT_LEVEL_COLUMNS:
        a = X[f"dlvl_{col}_a"].to_numpy(dtype=float)
        b = X[f"dlvl_{col}_b"].to_numpy(dtype=float)
        a_sw = X_sw[f"dlvl_{col}_a"].to_numpy(dtype=float)
        b_sw = X_sw[f"dlvl_{col}_b"].to_numpy(dtype=float)
        # NaN == NaN has to be treated as equal here; a debut row is mostly
        # NaN on these columns by construction, which is the point.
        assert np.array_equal(a, b_sw, equal_nan=True), f"{col}: a != b_swapped"
        assert np.array_equal(b, a_sw, equal_nan=True), f"{col}: b != a_swapped"
    print(f"  {len(DEBUT_LEVEL_COLUMNS)} level pairs swap correctly")


def test_origins_do_not_leak(df: pd.DataFrame) -> None:
    from lab_winner_common import iter_origins

    dates = pd.to_datetime(df["event_date"])
    n = 0
    for origin, tr, va, sc in iter_origins(dates):
        n += 1
        assert not (tr & va).any(), f"{origin}: train and val overlap"
        assert not (tr & sc).any(), f"{origin}: train and score overlap"
        assert not (va & sc).any(), f"{origin}: val and score overlap"
        # strict temporal order, which is the whole claim
        assert dates[tr].max() < dates[va].min(), f"{origin}: train not before val"
        assert dates[va].max() < dates[sc].min(), f"{origin}: val not before score"
        # and the 2025+ window stays out by construction
        assert dates[sc].max() < pd.Timestamp("2025-01-01"), f"{origin}: touched test"
    assert n == 32, f"expected 32 origins, got {n}"
    print(f"  {n} origins · no leakage · test window untouched")


def main() -> int:
    if not DATASET.exists():
        print(f"SKIP — {DATASET} not built (run a --stage pools first)")
        return 0
    df = pd.read_parquet(DATASET)
    print("test_accuracy_batch")
    test_served_debut_list_unchanged()
    test_debut_levels_are_antisymmetric(df)
    test_origins_do_not_leak(df)
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

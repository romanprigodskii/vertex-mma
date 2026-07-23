"""Pin the three properties the graded label lives or dies by.

BAN. `dominance_a` is a function of the outcome of the bout being predicted.
It is a label. Nothing derived from it may reach `X` — not as a feature, not
as a career aggregate computed with it, not as a per-row weight keyed on a
test row's own result. A leak here would look like a spectacular backtest and
serve nothing, so it is checked two ways: no feature is NAMED for it, and no
feature CORRELATES with the part of the label the binary target does not
already carry.

MIRRORING. `symmetrize_for_training` flips ~50% of rows to break the scrape
convention that puts the winner in slot A. `dominance_a` has no `dominance_b`
partner, so the generic column-pair swap never sees it and it has to be
mirrored by hand. Forget it and the label locks onto the winner slot — which
is invisible in every training metric.

SCALE. Draws and no-contests sit at exactly 0.5 and still have a NULL winner
(the 2026-07 repair), the winner is always above 0.5, and the ladder is
ordered: earlier finish > later finish > shutout > close decision.

Run:
    scripts/simulation/venv/bin/python scripts/simulation/tests/test_dominance.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.config import DATA_DIR  # noqa: E402
from src.dominance import (  # noqa: E402
    DOM_MIN_WIN,
    add_dominance,
    attach_round_share,
    validate,
)
from src.export import swap_sides, symmetrize_for_training  # noqa: E402
from src.features import build_feature_matrix, debut_feature_names, feature_names  # noqa: E402

CACHE = DATA_DIR / "dataset_dominance.parquet"


def test_no_dominance_feature_by_name() -> None:
    for name in (*feature_names(), *debut_feature_names()):
        assert "dominance" not in name.lower(), f"{name} is named for the label"
    print("ok   no feature is named for the label")


def test_no_dominance_feature_by_correlation(df: pd.DataFrame) -> None:
    """The name check alone would miss a leak smuggled in under another name.

    The interesting quantity is the RESIDUAL — dominance minus the binary
    target — which is precisely the extra information the graded label adds
    and the only thing a leak could be carrying. A feature computed honestly
    from prior bouts can correlate with it a little (better fighters do win
    more decisively); one computed FROM this bout's result would sit near 1.
    """
    completed = df[df["target_a_wins"].notna()].reset_index(drop=True)
    X, _, meta = build_feature_matrix(completed)
    assert "dominance_a" not in X.columns
    assert not [c for c in X.columns if "dominance" in c.lower()]
    assert "dominance_a" not in meta.columns, (
        "dominance_a rides on meta — harmless today, but meta is what the lab "
        "scripts thread around, so keep it out"
    )

    dom = pd.to_numeric(completed["dominance_a"], errors="coerce")
    tgt = pd.to_numeric(completed["target_a_wins"], errors="coerce")
    residual = dom - tgt
    corrs = X.corrwith(residual, numeric_only=True).abs().dropna()
    worst = corrs.sort_values(ascending=False).head(3)
    assert corrs.max() < 0.5, f"feature correlates with the label residual:\n{worst}"
    print(f"ok   no feature tracks the label residual (max |r| {corrs.max():.4f} "
          f"on {corrs.idxmax()})")


def test_symmetrization_mirrors_the_label() -> None:
    """Synthetic frame, so this fails on the logic rather than on the data."""
    n = 400
    rng = np.random.default_rng(0)
    dom = rng.uniform(0.55, 0.95, n)
    df = pd.DataFrame(
        {
            "bout_id": [f"bout-{i:04d}" for i in range(n)],
            "fighter_a_id": [f"fa-{i}" for i in range(n)],
            "fighter_b_id": [f"fb-{i}" for i in range(n)],
            # The scrape convention this function exists to break.
            "target_a_wins": 1,
            "dominance_a": dom,
            "market_prob_a": rng.uniform(0.3, 0.9, n),
            "elo_a": rng.normal(1500, 100, n),
            "elo_b": rng.normal(1500, 100, n),
        }
    )
    out = symmetrize_for_training(df)
    tgt = pd.to_numeric(out["target_a_wins"])
    d = pd.to_numeric(out["dominance_a"])

    flipped = tgt == 0
    assert flipped.any() and (~flipped).any(), "nothing flipped — mask is broken"
    # Every flipped row must be the exact mirror of its input, and every
    # unflipped row must be untouched.
    assert np.allclose(d[flipped], 1.0 - dom[flipped.to_numpy()])
    assert np.allclose(d[~flipped], dom[(~flipped).to_numpy()])
    # And the two labels must agree on direction afterwards.
    assert ((d > 0.5) == (tgt == 1)).all(), "graded and binary labels disagree"
    assert abs(d.mean() - 0.5) < 0.05, f"mean dominance {d.mean():.4f} after symmetrizing"

    # swap_sides is the inference-time twin and must mirror it too, or the
    # order-averaged evaluation frames carry a stale label.
    back = swap_sides(out)
    assert np.allclose(pd.to_numeric(back["dominance_a"]), 1.0 - d)
    print("ok   symmetrize_for_training and swap_sides both mirror the label")


def test_label_scale() -> None:
    """The ladder, built on a hand-written frame with a known answer."""
    bouts = pd.DataFrame(
        [
            # bout, method, round, time-in-round, scheduled, winner
            ("ko1", "ko", 1, 60, 3, "A"),
            ("ko3", "ko", 3, 290, 3, "A"),
            ("sub1", "submission", 1, 100, 3, "B"),
            ("dec_sweep", "decision_unanimous", 3, 300, 3, "A"),
            ("dec_21", "decision_unanimous", 3, 300, 3, "A"),
            ("dec_split", "decision_split", 3, 300, 3, "A"),
            ("dec_nocard", "decision_unanimous", 3, 300, 3, "A"),
            ("draw", "decision_split", 3, 300, 3, None),
            ("nc", "no_contest", 1, 30, 3, None),
            ("dq", "dq", 2, 45, 3, "A"),
        ],
        columns=["bout_id", "method", "round_finished", "time_finished_seconds",
                 "scheduled_rounds", "winner"],
    )
    bouts["fighter_a_id"] = "A"
    bouts["fighter_b_id"] = "B"
    bouts["winner_id"] = bouts["winner"]
    bouts["event_date"] = pd.Timestamp("2020-06-01")

    cards = []
    for bout, shares in (
        ("dec_sweep", [1, 1, 1]),
        ("dec_21", [1, 1, 0]),
        ("dec_split", [1, 1, 0]),
        ("draw", [1, 0, 0]),
    ):
        for rnd, a_wins in enumerate(shares, start=1):
            for judge in ("j1", "j2", "j3"):
                cards.append(
                    {"bout_id": bout, "round": rnd, "judge_name": judge,
                     "fighter_a_score": 10 if a_wins else 9,
                     "fighter_b_score": 9 if a_wins else 10}
                )
    scored = add_dominance(attach_round_share(bouts, pd.DataFrame(cards)))
    validate(scored)
    d = dict(zip(scored["bout_id"], scored["dominance_a"], strict=True))

    assert d["draw"] == 0.5 and d["nc"] == 0.5
    assert scored.loc[scored["bout_id"].isin(["draw", "nc"]), "winner_id"].isna().all()
    assert d["sub1"] < 0.5, "B won — label must be below 0.5"
    assert d["ko1"] > d["ko3"], "an earlier finish must outrank a later one"
    assert d["ko3"] > d["dec_sweep"], "a finish must outrank a shutout on the cards"
    assert d["dec_sweep"] > d["dec_21"] > d["dec_split"], "decision ladder out of order"
    assert d["dec_21"] < d["dec_nocard"] < d["dec_sweep"], (
        "a unanimous decision with no card must land between a 2-1 card and a "
        "shutout, never AT the shutout"
    )
    assert abs(d["dq"] - 0.55) < 1e-9, "a DQ is a rules event, not a blowout"
    assert min(d.values()) >= 0.05 - 1e-9 and max(d.values()) <= 0.95 + 1e-9
    assert d["dec_split"] >= DOM_MIN_WIN
    print("ok   the ladder is ordered and the edge cases land where intended")


def main() -> None:
    test_no_dominance_feature_by_name()
    test_symmetrization_mirrors_the_label()
    test_label_scale()
    if CACHE.exists():
        test_no_dominance_feature_by_correlation(pd.read_parquet(CACHE))
    else:
        print(f"skip {CACHE.name} absent — run the lab once to check the leak "
              "correlation on real rows")
    print("\nall dominance tests passed")


if __name__ == "__main__":
    main()

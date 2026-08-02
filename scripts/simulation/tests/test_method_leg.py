"""Pin the invariants the method leg is priced on.

LEVEL PRESERVATION. `sportsbook.ts reconcileMethodProbs` rescales each side's
(ko, sub, dec) to that side's ENSEMBLE win probability, so the simulator only
ever supplies the ratio. `_anchor_methods` was written to preserve each side's
win level exactly; the v0.12.0 `method_mix` override has to preserve it too,
or the two paths disagree about what the MC's winner prob means and
`mc_winner_prob_a` stops matching the cells it is stored beside.

ROUND CONSISTENCY. `prob_finish_round_*` is what the round market is priced
from and it must still sum to the total finish probability after the mix is
replaced — the per-round breakdown distributes the per-method totals by that
method's round SHARE, so changing the totals must move the rounds with them.

FALLBACK EXACTNESS. `method_mix=None` is the no-artifact path (a deploy whose
artifacts fail to load, `eval_method_market.py --legacy`, `custom.py`). It has
to reproduce the pre-v0.12.0 numbers bit for bit, not approximately.

BUCKET AGREEMENT. `export.method_bucket` trains the model and
`sportsbook.ts methodBucket` pays the bet. A disagreement would settle one
grading against another, so the mapping is pinned here in both directions.

ORIENTATION INVARIANCE. `dominance_a` had to be mirrored by hand because it
is a property of side A. `method_bucket` is a property of the BOUT — a KO is
a KO whichever slot the winner sits in — so `swap_sides` and
`symmetrize_for_training` must leave it strictly alone. Flipping it would be
as invisible in training metrics as forgetting to flip `dominance_a`.

Run:
    scripts/simulation/venv/bin/python scripts/simulation/tests/test_method_leg.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import pandas as pd  # noqa: E402

import src.monte_carlo as _mc  # noqa: E402
from src.export import (  # noqa: E402
    METHOD_BUCKETS,
    method_bucket,
    swap_sides,
    symmetrize_for_training,
)
from src.monte_carlo import FighterMC, simulate_bout  # noqa: E402

TOL = 1e-9


def _fighters() -> tuple[FighterMC, FighterMC]:
    """A puncher against a grappler — a matchup where the mix override has
    something to disagree with the hazards about."""
    a = FighterMC(
        slpm=4.8, sapm=3.1, kd_per_fight=0.9, sub_per15=0.2, td_per15=0.4,
        td_def=0.72, control_per_min=0.5, losses_ko_rate=0.10,
        losses_sub_rate=0.20, finish_rate_for=0.70,
    )
    b = FighterMC(
        slpm=2.9, sapm=3.4, kd_per_fight=0.1, sub_per15=1.8, td_per15=3.6,
        td_def=0.55, control_per_min=2.4, losses_ko_rate=0.35,
        losses_sub_rate=0.05, finish_rate_for=0.55,
    )
    return a, b


def test_fallback_is_bit_identical() -> None:
    a, b = _fighters()
    kw = dict(seed=99, is_main_event=True, is_title_fight=False)
    base = simulate_bout(a, b, 5, **kw)
    again = simulate_bout(a, b, 5, method_mix=None, **kw)
    for field in (
        "winner_prob_a", "winner_prob_b", "prob_ko_a", "prob_ko_b",
        "prob_sub_a", "prob_sub_b", "prob_decision_a", "prob_decision_b",
        "avg_finish_seconds",
    ):
        assert getattr(base, field) == getattr(again, field), field
    assert base.prob_finish_per_round == again.prob_finish_per_round
    print("ok   method_mix=None reproduces the anchored path exactly")


def test_mix_preserves_each_win_level() -> None:
    a, b = _fighters()
    kw = dict(seed=99, is_main_event=True, is_title_fight=False)
    base = simulate_bout(a, b, 5, **kw)
    for mix in (
        ((0.80, 0.05, 0.15), (0.10, 0.10, 0.80)),
        ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
        ((0.33, 0.33, 0.33), (0.33, 0.33, 0.33)),
        ((0.5, 0.25, 0.2), (0.4, 0.4, 0.1)),  # deliberately not summing to 1
    ):
        out = simulate_bout(a, b, 5, method_mix=mix, **kw)
        assert abs(out.winner_prob_a - base.winner_prob_a) < TOL, mix
        assert abs(out.winner_prob_b - base.winner_prob_b) < TOL, mix
        assert abs(out.winner_prob_a + out.winner_prob_b - 1.0) < TOL, mix
        # And the ratio really is the one we asked for.
        want = [m / sum(mix[0]) for m in mix[0]]
        got = [
            out.prob_ko_a / out.winner_prob_a,
            out.prob_sub_a / out.winner_prob_a,
            out.prob_decision_a / out.winner_prob_a,
        ]
        assert all(abs(w - g) < 1e-8 for w, g in zip(want, got, strict=True)), mix
    print("ok   the mix reshapes HOW each side wins and never how often")


def test_rounds_track_the_new_totals() -> None:
    a, b = _fighters()
    kw = dict(seed=7, is_main_event=False, is_title_fight=False)
    for mix in (
        None,
        ((0.85, 0.10, 0.05), (0.05, 0.85, 0.10)),
        ((0.02, 0.02, 0.96), (0.02, 0.02, 0.96)),
    ):
        out = simulate_bout(a, b, 3, method_mix=mix, **kw)
        finish_total = (
            out.prob_ko_a + out.prob_ko_b + out.prob_sub_a + out.prob_sub_b
        )
        by_round = sum(out.prob_finish_per_round.values())
        assert abs(by_round - finish_total) < 1e-8, (mix, by_round, finish_total)
        assert set(out.prob_finish_per_round) == {1, 2, 3}
        cells = (
            out.prob_ko_a + out.prob_sub_a + out.prob_decision_a
            + out.prob_ko_b + out.prob_sub_b + out.prob_decision_b
        )
        assert abs(cells - 1.0) < TOL, mix
    print("ok   prob_finish_round_* still sums to the total finish probability")


def test_method_bucket_matches_sportsbook() -> None:
    for method, want in (
        ("ko", "ko"), ("tko", "ko"),
        ("submission", "sub"),
        ("decision_unanimous", "dec"), ("decision_split", "dec"),
        ("decision_majority", "dec"),
        ("dq", None), ("draw", None), ("no_contest", None), (None, None),
        ("something_new", None),
    ):
        assert method_bucket(method) == want, method
    assert set(METHOD_BUCKETS) == {"ko", "sub", "dec"}
    print("ok   export.method_bucket agrees with sportsbook.ts methodBucket")


def _frame() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "bout_id": ["b1", "b2", "b3", "b4"],
            "fighter_a_id": ["fa1", "fa2", "fa3", "fa4"],
            "fighter_b_id": ["fb1", "fb2", "fb3", "fb4"],
            "target_a_wins": pd.array([1, 0, 1, 0], dtype="Int8"),
            "market_prob_a": [0.7, 0.4, None, 0.55],
            "method_bucket": ["ko", "sub", "dec", "ko"],
            "slpm_a": [4.0, 3.0, 5.0, 2.0],
            "slpm_b": [3.0, 4.0, 2.0, 5.0],
        }
    )


def test_method_bucket_never_flips() -> None:
    df = _frame()
    assert list(swap_sides(df)["method_bucket"]) == list(df["method_bucket"])
    sym = symmetrize_for_training(df)
    assert list(sym["method_bucket"]) == list(df["method_bucket"])
    # Sanity: the swap really did happen on this frame, so the assertion
    # above is not passing because nothing moved.
    assert list(swap_sides(df)["slpm_a"]) == list(df["slpm_b"])
    print("ok   method_bucket survives swap_sides and symmetrize untouched")


def test_leaked_covariate_cannot_reach_the_served_timing() -> None:
    """`finish_hazard.py` still takes `is_title_fight` as a covariate, and §7
    of docs/method_leg.md shows that column is a post-fight bonus flag. The
    blast radius on the ROUND leg is nil, and this pins why rather than
    asserting it: every covariate in the hazard model is time-CONSTANT, so it
    contributes a constant factor to exp(eta) and `_normalize_shape` divides
    that factor straight back out.

    What this does NOT establish is that the flag's presence during FITTING
    left the shared time-basis coefficients where they would otherwise be.
    That is a refit question, and it is open."""
    hazard = _mc.load_hazard_model()
    if hazard is None:
        print("skip finish_hazard artifact absent — run run_train.py first")
        return
    a, b = _fighters()
    for rounds in (3, 5):
        off = _mc._fitted_timing_shapes(hazard, a, b, rounds, rounds * 300, False, False)
        on = _mc._fitted_timing_shapes(hazard, a, b, rounds, rounds * 300, False, True)
        for curve_off, curve_on in zip(off, on, strict=True):
            assert float(abs(curve_off - curve_on).max()) < 1e-12, rounds
        r_off = simulate_bout(a, b, rounds, seed=5, is_title_fight=False)
        r_on = simulate_bout(a, b, rounds, seed=5, is_title_fight=True)
        assert r_off.prob_finish_per_round == r_on.prob_finish_per_round, rounds
        assert r_off.prob_ko_a == r_on.prob_ko_a, rounds
    print("ok   the leaked title flag cannot move the served round distribution")


def main() -> None:
    test_fallback_is_bit_identical()
    test_mix_preserves_each_win_level()
    test_rounds_track_the_new_totals()
    test_method_bucket_matches_sportsbook()
    test_method_bucket_never_flips()
    test_leaked_covariate_cannot_reach_the_served_timing()
    print("\nall method-leg tests passed")


if __name__ == "__main__":
    main()

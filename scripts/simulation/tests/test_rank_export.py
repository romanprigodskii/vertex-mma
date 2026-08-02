"""Pins the point-in-time contract of src/rank_export.py.

The failure this file exists to catch does not announce itself. If a rank
lookup ever reads the snapshot published ON or AFTER the bout, the model gets
a rating that already knows the result — the fighter who won moves up, the one
who lost drops out — and a backtest would look brilliant with nothing behind
it. Same class of bug as `is_title_fight` (docs/method_leg.md §7), which was a
model's largest feature for a while before anyone noticed.

Run: ./venv/bin/python tests/test_rank_export.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from src.rank_export import (  # noqa: E402
    MAX_SNAPSHOT_AGE_DAYS,
    UNRANKED_LEVEL,
    build_rank_features,
    effective_rank,
)

PASS, FAIL = "\033[32mPASS\033[0m", "\033[31mFAIL\033[0m"
_results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    _results.append((name, bool(cond), detail))
    print(f"  {PASS if cond else FAIL}  {name}" + (f" — {detail}" if detail else ""))


def _ranks(rows: list[tuple[str, str, str, bool, int]]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["fighter_id", "snapshot_date", "division", "is_women", "rank"])
    df["snapshot_date"] = pd.to_datetime(df["snapshot_date"]).astype("datetime64[ns]")
    return df


def _bout(date: str, a: str, b: str, wc: str = "lightweight", gender: str = "male") -> pd.DataFrame:
    return pd.DataFrame(
        [{"event_date": date, "fighter_a_id": a, "fighter_b_id": b,
          "weight_class": wc, "gender": gender}]
    )


def main() -> int:
    print("point-in-time contract")

    # A fighter ranked #3 on the 1st and #1 on the 15th. A bout on the 10th may
    # only ever see the #3.
    ranks = _ranks([
        ("F1", "2020-01-01", "lightweight", False, 3),
        ("F1", "2020-01-15", "lightweight", False, 1),
        ("F2", "2020-01-01", "lightweight", False, 9),
        ("F2", "2020-01-15", "lightweight", False, 9),
    ])
    rf = build_rank_features(_bout("2020-01-10", "F1", "F2"), ranks)
    check("reads the snapshot BEFORE the bout", rf["rank_div_a"].iloc[0] == 3,
          f"got {rf['rank_div_a'].iloc[0]}")

    # A bout ON a snapshot date must not read that snapshot: the UFC publishes
    # after the previous weekend's card, so the same-day list already contains
    # the result.
    rf = build_rank_features(_bout("2020-01-15", "F1", "F2"), ranks)
    check("a same-day snapshot is not used", rf["rank_div_a"].iloc[0] == 3,
          f"got {rf['rank_div_a'].iloc[0]}")

    # Falling out of the rankings must read as unranked, not as a stale rank.
    ranks_out = _ranks([
        ("F1", "2020-01-01", "lightweight", False, 3),
        ("F2", "2020-01-01", "lightweight", False, 9),
        ("F2", "2020-06-01", "lightweight", False, 9),   # F1 absent from this one
    ])
    rf = build_rank_features(_bout("2020-06-10", "F1", "F2"), ranks_out)
    check("dropping out reads as unranked", bool(np.isnan(rf["rank_div_a"].iloc[0])),
          f"got {rf['rank_div_a'].iloc[0]}")
    check("...and is_ranked goes to 0", rf["rank_is_ranked_a"].iloc[0] == 0)
    check("...while days-since counts the gap", rf["rank_days_since_a"].iloc[0] == 152,
          f"got {rf['rank_days_since_a'].iloc[0]}")

    # Before the table starts there is no data — which must be distinguishable
    # from being unranked, or every pre-2017 row silently becomes "both fighters
    # are nobodies".
    rf = build_rank_features(_bout("2015-05-05", "F1", "F2"), ranks)
    check("pre-table bouts have no data", rf["rank_has_data"].iloc[0] == 0)
    check("...and no rank", bool(np.isnan(rf["rank_best_a"].iloc[0])))

    # A snapshot older than the staleness bound is treated as no data.
    rf = build_rank_features(_bout("2021-01-01", "F1", "F2"), ranks)
    check(f"a snapshot older than {MAX_SNAPSHOT_AGE_DAYS}d is dropped",
          rf["rank_has_data"].iloc[0] == 0)

    print("\nside symmetry")
    ranks2 = _ranks([
        ("F1", "2020-01-01", "lightweight", False, 0),
        ("F2", "2020-01-01", "lightweight", False, 7),
    ])
    ab = build_rank_features(_bout("2020-01-20", "F1", "F2"), ranks2)
    ba = build_rank_features(_bout("2020-01-20", "F2", "F1"), ranks2)
    check("swapping sides swaps the columns",
          (ab["rank_div_a"].iloc[0] == ba["rank_div_b"].iloc[0])
          and (ab["rank_div_b"].iloc[0] == ba["rank_div_a"].iloc[0]))
    check("champion flag follows the fighter",
          ab["rank_is_champ_a"].iloc[0] == 1 and ba["rank_is_champ_b"].iloc[0] == 1)

    print("\ndivision resolution")
    # Ranked at 155 but the bout is at 170: the divisional column must not
    # borrow the other division's number, while rank_best still sees it.
    rf = build_rank_features(_bout("2020-01-20", "F1", "F2", wc="welterweight"), ranks2)
    check("out-of-division rank does not fill rank_div", bool(np.isnan(rf["rank_div_a"].iloc[0])))
    check("...but rank_best still finds it", rf["rank_best_a"].iloc[0] == 0)

    # Women's lists are separate: a men's flyweight #1 is not a women's #1.
    ranks_w = _ranks([
        ("F1", "2020-01-01", "flyweight", False, 1),
        ("F3", "2020-01-01", "flyweight", True, 1),
    ])
    rf = build_rank_features(
        _bout("2020-01-20", "F3", "F1", wc="flyweight", gender="female"), ranks_w
    )
    check("women's flyweight resolves to the women's list", rf["rank_div_a"].iloc[0] == 1)
    check("...and the men's #1 is not credited in it", bool(np.isnan(rf["rank_div_b"].iloc[0])))

    print("\neffective rank")
    check("unranked maps to the sentinel",
          effective_rank(pd.Series([np.nan, 3.0])).tolist() == [UNRANKED_LEVEL, 3.0])

    failed = [n for n, ok, _ in _results if not ok]
    print(f"\n{len(_results) - len(failed)}/{len(_results)} checks passed")
    if failed:
        print("failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

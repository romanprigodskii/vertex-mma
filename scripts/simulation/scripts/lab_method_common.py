"""Walk-forward out-of-fold harness for the CONDITIONAL METHOD leg.

`docs/method_leg.md` selected every one of its gates on the 2024 val window:
428 rows overall, and — for the stage that mattered most — **71 submissions**.
Its own §9 says so out loud ("a gate on 71 rows selects noise"). Meanwhile
`docs/winner_batch.md` §1 had already retired the 429-row val split for the
winner leg on exactly that reasoning and moved selection to a walk-forward
pool of 3,087 bouts.

This module gives the method leg the same instrument, on the same schedule
(`lab_winner_common.iter_origins`), so the two legs' numbers stay
comparable and the 2025+ test window stays untouched by construction.

What it deliberately does NOT do: change the model. `walk_forward_method`
fits `MethodModel` with the production recipe — the 0.1-grid simplex blend
on val, the same early stopping, the same winner-first orientation — and
only replaces the split. A lever that wants to change the model passes it
in (`use_levels`, `use_sub_axis`, `feature_block`).

The pool is per-BOUT in the winner-first orientation, which is the
orientation the conditional is defined in: P(ko|sub|dec GIVEN this side
wins), evaluated on the side that actually won. That is the term the 6-cell
factorisation calls LL(method | winner), and it is the one this leg owns —
the winner term is the ensemble's and is measured elsewhere.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from lab_winner_common import OOF_END, OOF_START, iter_origins  # noqa: E402

from src.features import build_feature_matrix  # noqa: E402
from src.method_model import (  # noqa: E402
    METHODS,
    USE_LEVELS,
    USE_SUB_AXIS,
    MethodModel,
    build_method_features,
    gradeable_rows,
    orient_winner_first,
)

EPS = 1e-12


def method_frame(
    df: pd.DataFrame,
    *,
    levels: bool = USE_LEVELS,
    sub_axis: bool = USE_SUB_AXIS,
) -> tuple[pd.DataFrame, np.ndarray, pd.DataFrame]:
    """(X, y, meta) for the conditional fit, keeping bout_id and the date.

    `src.method_model.training_matrix` does the same thing but returns only
    the dates, and a pool that cannot be joined back to a bout cannot be
    compared against the book. Same construction otherwise — gradeable rows
    only, winner-first oriented, row order preserved.
    """
    sub = df.loc[gradeable_rows(df)].reset_index(drop=True)
    oriented = orient_winner_first(sub)
    base, _, _ = build_feature_matrix(oriented)
    X = build_method_features(base, oriented, levels=levels, sub_axis=sub_axis)
    y = np.array([METHODS.index(m) for m in sub["method_bucket"]], dtype=int)
    meta = pd.DataFrame(
        {
            "bout_id": sub["bout_id"].to_numpy(),
            "event_date": pd.to_datetime(sub["event_date"]),
            "weight_class": sub.get("weight_class", pd.Series([None] * len(sub))),
        }
    )
    return X, y, meta


def multiclass_logloss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1.0)
    return float(-np.log(p[np.arange(len(y)), y]).mean())


def walk_forward_method(
    df: pd.DataFrame,
    *,
    label: str = "baseline",
    seed: int = 42,
    levels: bool = USE_LEVELS,
    sub_axis: bool = USE_SUB_AXIS,
    exclude_debuts: bool = True,
    start: str = OOF_START,
    end: str = OOF_END,
    min_val: int = 80,
    verbose: bool = False,
) -> pd.DataFrame:
    """Per-origin refit of the conditional method model, scored on the next
    quarter. Returns one row per scored bout with the 3-class conditional.

    `exclude_debuts` mirrors production (`train.py:485` passes `exp_df`): the
    served method model has never seen a row where one side's career columns
    are entirely NaN. A lab that wants to CHANGE that — the debut method
    specialist — passes False and supplies its own weighting.
    """
    frame = df
    if exclude_debuts and "is_debut_a" in df.columns:
        keep = ~(df["is_debut_a"].astype(bool) | df["is_debut_b"].astype(bool))
        frame = df.loc[keep].reset_index(drop=True)

    X, y, meta = method_frame(frame, levels=levels, sub_axis=sub_axis)
    dates = meta["event_date"]

    rows = []
    for origin, tr, va, sc in iter_origins(
        dates, start=start, end=end, min_val=min_val
    ):
        model = MethodModel(use_levels=levels, use_sub_axis=sub_axis).fit(
            X.loc[tr].reset_index(drop=True),
            y[tr],
            X.loc[va].reset_index(drop=True),
            y[va],
            seed=seed,
        )
        p = model.predict_cond(X.loc[sc].reset_index(drop=True))
        rows.append(
            pd.DataFrame(
                {
                    "origin": str(origin.date()),
                    "label": label,
                    "seed": seed,
                    "bout_id": meta.loc[sc, "bout_id"].to_numpy(),
                    "event_date": meta.loc[sc, "event_date"].to_numpy(),
                    "p_ko": p[:, 0],
                    "p_sub": p[:, 1],
                    "p_dec": p[:, 2],
                    "y": y[sc],
                }
            )
        )
        if verbose:
            print(
                f"    origin {origin.date()}  train {int(tr.sum()):5d}  "
                f"val {int(va.sum()):4d}  scored {int(sc.sum()):4d}  "
                f"weights {model.weights}"
            )
    return pd.concat(rows, ignore_index=True)


def pool_logloss(frame: pd.DataFrame) -> float:
    p = frame[["p_ko", "p_sub", "p_dec"]].to_numpy(dtype=float)
    return multiclass_logloss(frame["y"].to_numpy(dtype=int), p)


def cell_table(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """Per-class log-loss and reliability. The submission cell is the one
    `method_leg.md` §4 named as carrying the whole residual gap to the book,
    so it gets reported on its own every time — as a DIAGNOSTIC. The gate
    metric is the overall 3-class number, because a gate on the sub cell is
    a gate on ~600 rows of a 3,000-row pool."""
    p = frame[["p_ko", "p_sub", "p_dec"]].to_numpy(dtype=float)
    y = frame["y"].to_numpy(dtype=int)
    out = []
    for j, name in enumerate(METHODS):
        m = y == j
        out.append(
            {
                "class": name,
                "n": int(m.sum()),
                "share_actual": float(m.mean()),
                "share_pred": float(p[:, j].mean()),
                "logloss_when_true": (
                    float(-np.log(np.clip(p[m, j], EPS, 1.0)).mean())
                    if m.any()
                    else float("nan")
                ),
            }
        )
    return out


def paired_bootstrap_method(
    cand: pd.DataFrame, base: pd.DataFrame, n: int = 4000, seed: int = 11
) -> dict[str, float]:
    """Per-bout 3-class log-loss difference (cand − base), percentile CI.

    Same alignment assertion as the winner-leg version: an unaligned
    'paired' bootstrap is an unpaired one with an interval too wide to fail
    anything."""
    assert (
        cand["bout_id"].to_numpy() == base["bout_id"].to_numpy()
    ).all(), "unaligned"
    y = cand["y"].to_numpy(dtype=int)
    pc = np.clip(cand[["p_ko", "p_sub", "p_dec"]].to_numpy(dtype=float), EPS, 1.0)
    pb = np.clip(base[["p_ko", "p_sub", "p_dec"]].to_numpy(dtype=float), EPS, 1.0)
    d = -np.log(pc[np.arange(len(y)), y]) + np.log(pb[np.arange(len(y)), y])
    rng = np.random.default_rng(seed)
    boots = np.array(
        [d[rng.integers(0, len(d), len(d))].mean() for _ in range(n)]
    )
    return {
        "delta": float(d.mean()),
        "lo": float(np.percentile(boots, 2.5)),
        "hi": float(np.percentile(boots, 97.5)),
        "frac_improving": float((boots < 0).mean()),
    }

"""Accuracy batch — the levers that came out of the v0.13.0 post-mortem.

Everything here is gated on walk-forward out-of-fold pools, never on the
2024 val window, for the reason `docs/winner_batch.md` §1 gives: a lever
worth 0.003 nats is not measurable on 429 rows, and the two objects this
batch spends most of its time on are selected on 428 (the method leg) and
**84** (the debut specialist).

Stages:

  pools     build and cache the three OOF pools
              main   3,087 both-experienced bouts   (existing, reused)
              debut    798 debut bouts              (new — production: 84)
              method 3,081 bouts / 543 submissions  (new — production: 428/71)
  nat       GATE — a nationality term in ResidualCorrector
  subtemp   GATE — one temperature parameter on the sub-vs-dec contrast
  debutlv   GATE — absolute levels in the debut specialist's matrix
  debutcorr GATE — the shipped age correction, applied to the specialist
  power     the instrument's own resolution: seed spread, paired SE, MDE
  calib     bin-free (CORP/PAV) reliability vs the 10-bin number in the README

Every gate reports THREE legs, the same three that killed the 8-column
correction block in `winner_batch.md` §6: cross-fit on the pool, forward
(fit on the pre-2022 half, score the rest), and the untouched 2025+ test
window read exactly once. A lever that is best on the pool it was fitted
on and worst forward is the shape of overfitting, and it is the only shape
this directory has ever caught by accident.

Usage:
  python scripts/lab_accuracy_batch.py --stage pools [--seeds 42,7,13]
  python scripts/lab_accuracy_batch.py --stage nat --cache
  python scripts/lab_accuracy_batch.py --stage subtemp --cache
  python scripts/lab_accuracy_batch.py --stage debutlv --cache --seeds 42,7,13
  python scripts/lab_accuracy_batch.py --stage debutcorr --cache
  python scripts/lab_accuracy_batch.py --stage power --cache
  python scripts/lab_accuracy_batch.py --stage calib --cache
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from lab_method_common import (  # noqa: E402
    cell_table,
    method_frame,
    multiclass_logloss,
    pool_logloss,
    walk_forward_method,
)
from lab_winner_common import (  # noqa: E402
    oof_logloss,
    paired_bootstrap,
    walk_forward,
    walk_forward_debut,
)

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402

ARTIFACT_PATH = ARTIFACTS_DIR / "lab_accuracy_batch.json"
DATASET_CACHE = DATA_DIR / "dataset.parquet"
POOL_MAIN = DATA_DIR / "lab_winner_batch_oof.parquet"
POOL_DEBUT = DATA_DIR / "lab_accuracy_debut_oof.parquet"
POOL_METHOD = DATA_DIR / "lab_accuracy_method_oof.parquet"

FORWARD_SPLIT = "2022-01-01"


# ── data ───────────────────────────────────────────────────────────────


def load_dataset(cache: bool) -> pd.DataFrame:
    if cache and DATASET_CACHE.exists():
        return pd.read_parquet(DATASET_CACHE)
    raw = fetch_raw()
    df = symmetrize_for_training(build_dataset(raw, include_debuts=True))
    DATASET_CACHE.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(DATASET_CACHE)
    return df


def debut_mask(df: pd.DataFrame) -> np.ndarray:
    return (df["is_debut_a"].astype(bool) | df["is_debut_b"].astype(bool)).to_numpy()


# ── shared gate machinery ──────────────────────────────────────────────


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    return np.log(p / (1 - p))


def binary_logloss(y: np.ndarray, p: np.ndarray) -> float:
    p = np.clip(np.asarray(p, dtype=float), 1e-12, 1 - 1e-12)
    y = np.asarray(y, dtype=float)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def fit_terms(z: np.ndarray, y: np.ndarray, Xc: np.ndarray) -> np.ndarray:
    """Least-log-loss coefficients on an OFFSET model: sigmoid(z + Xc·k).

    The model logit enters as a fixed offset with slope pinned to 1.0 —
    the shipped corrector's own shape, and for its stated reason: the
    coefficients are fitted on walk-forward models trained on less data
    than the served one, so a free slope would import that sharpness
    difference into production where it does not belong.
    """
    from scipy.optimize import minimize

    def obj(k: np.ndarray) -> float:
        return binary_logloss(y, 1.0 / (1.0 + np.exp(-(z + Xc @ k))))

    res = minimize(obj, np.zeros(Xc.shape[1]), method="Nelder-Mead",
                   options={"xatol": 1e-6, "fatol": 1e-10, "maxiter": 4000})
    return np.asarray(res.x, dtype=float)


def three_leg_gate(
    z: np.ndarray,
    y: np.ndarray,
    Xc: np.ndarray,
    dates: pd.Series,
    *,
    n_folds: int = 5,
    seed: int = 0,
) -> dict[str, Any]:
    """cross-fit · forward · (test is scored by the caller, separately).

    Cross-fit is K-fold rather than the 2-fold a quick probe would use:
    with one or two parameters the fold-to-fold coefficient spread is the
    only visible sign of a term that is fitting a handful of rows.
    """
    base_ll = binary_logloss(y, 1.0 / (1.0 + np.exp(-z)))

    rng = np.random.default_rng(seed)
    fold = rng.integers(0, n_folds, len(y))
    p_cf = np.empty(len(y), dtype=float)
    coefs = []
    for f in range(n_folds):
        tr, te = fold != f, fold == f
        k = fit_terms(z[tr], y[tr], Xc[tr])
        coefs.append(k)
        p_cf[te] = 1.0 / (1.0 + np.exp(-(z[te] + Xc[te] @ k)))
    cf_delta = binary_logloss(y, p_cf) - base_ll

    dt = pd.to_datetime(dates).to_numpy()
    tr = dt < np.datetime64(FORWARD_SPLIT)
    te = ~tr
    k_fwd = fit_terms(z[tr], y[tr], Xc[tr])
    p_fwd = 1.0 / (1.0 + np.exp(-(z[te] + Xc[te] @ k_fwd)))
    fwd_delta = binary_logloss(y[te], p_fwd) - binary_logloss(
        y[te], 1.0 / (1.0 + np.exp(-z[te]))
    )

    k_all = fit_terms(z, y, Xc)
    return {
        "base_logloss": base_ll,
        "cross_fit_delta": float(cf_delta),
        "cross_fit_coefs": [[float(v) for v in k] for k in coefs],
        "forward_delta": float(fwd_delta),
        "forward_coefs": [float(v) for v in k_fwd],
        "forward_n_train": int(tr.sum()),
        "forward_n_score": int(te.sum()),
        "full_coefs": [float(v) for v in k_all],
        "n": int(len(y)),
    }


# ── stage: pools ───────────────────────────────────────────────────────


def stage_pools(df: pd.DataFrame, seeds: list[int], fresh: bool) -> dict[str, Any]:
    out: dict[str, Any] = {}

    exp_df = df.loc[~debut_mask(df)].reset_index(drop=True)

    if fresh or not POOL_MAIN.exists():
        print("  building the MAIN pool (both-experienced)…")
        frames = [
            walk_forward(exp_df, label="baseline", seed=s, verbose=True)
            for s in seeds
        ]
        pd.concat(frames, ignore_index=True).to_parquet(POOL_MAIN)
    main = pd.read_parquet(POOL_MAIN)
    m42 = main[(main.label == "baseline") & (main.seed == seeds[0])]
    out["main"] = {
        "path": str(POOL_MAIN),
        "n": int(len(m42)),
        "logloss": oof_logloss(m42),
    }
    print(f"  main pool   n={len(m42):5d}  ll={oof_logloss(m42):.5f}")

    if fresh or not POOL_DEBUT.exists():
        print("  building the DEBUT pool…")
        frames = [
            walk_forward_debut(df, label="baseline", seed=s, verbose=True)
            for s in seeds
        ]
        pd.concat(frames, ignore_index=True).to_parquet(POOL_DEBUT)
    deb = pd.read_parquet(POOL_DEBUT)
    d42 = deb[(deb.label == "baseline") & (deb.seed == seeds[0])]
    out["debut"] = {
        "path": str(POOL_DEBUT),
        "n": int(len(d42)),
        "logloss": oof_logloss(d42),
        "production_val_rows": 84,
    }
    print(f"  debut pool  n={len(d42):5d}  ll={oof_logloss(d42):.5f}  (production selects on 84)")

    if fresh or not POOL_METHOD.exists():
        print("  building the METHOD pool…")
        frames = [
            walk_forward_method(df, label="baseline", seed=s, verbose=True)
            for s in seeds
        ]
        pd.concat(frames, ignore_index=True).to_parquet(POOL_METHOD)
    met = pd.read_parquet(POOL_METHOD)
    x42 = met[(met.label == "baseline") & (met.seed == seeds[0])]
    out["method"] = {
        "path": str(POOL_METHOD),
        "n": int(len(x42)),
        "n_submissions": int((x42["y"] == 1).sum()),
        "logloss": pool_logloss(x42),
        "cells": cell_table(x42),
        "production_val_rows": 428,
        "production_val_submissions": 71,
    }
    print(
        f"  method pool n={len(x42):5d}  ll={pool_logloss(x42):.5f}  "
        f"submissions={int((x42['y'] == 1).sum())}  (production selects on 428/71)"
    )
    return out


# ── stage: nat — a nationality term in the corrector ───────────────────


NAT_SOURCES = ("country_code", "sherdog_flag_code")


def fetch_nationality(column: str) -> dict[str, str]:
    """{fighter_id: code} from one of the two nationality columns.

    Only the US indicator is ever used downstream, and 'US' means the same
    thing in both vocabularies — so the Home-Nations ambiguity that stopped
    the Sherdog codes from being written into `country_code` (0094) does not
    reach this lever at all.
    """
    from src.db import get_connection

    if column not in NAT_SOURCES:
        raise ValueError(f"unknown nationality column {column!r}")
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"SELECT id::text, {column} FROM fighter WHERE {column} IS NOT NULL"  # noqa: S608
        )
        return {r[0]: str(r[1]).upper() for r in cur.fetchall()}


def _us_indicator(
    ids_a: np.ndarray, ids_b: np.ndarray, nat: dict[str, str]
) -> tuple[np.ndarray, np.ndarray]:
    """(d_us, covered). An uncovered side contributes 0, which is the same
    thing `ResidualCorrector` does with a NaN — the row is served exactly as
    it is today rather than corrected by a guess."""
    a = np.array([nat.get(str(i)) for i in ids_a], dtype=object)
    b = np.array([nat.get(str(i)) for i in ids_b], dtype=object)
    covered = np.array([x is not None and y is not None for x, y in zip(a, b, strict=True)])
    d = (a == "US").astype(float) - (b == "US").astype(float)
    d[~covered] = 0.0
    return d, covered


def stage_nat(df: pd.DataFrame, seeds: list[int], source: str) -> dict[str, Any]:
    """GATE — does a fighter-nationality term belong in RESIDUAL_CORRECTION?

    The bias is not subtle. On the seed-42 OOF pool the blend gives the
    American side ~8pp more than it gets, in every era. What the gate has to
    decide is whether ONE coefficient on that, applied where nothing else
    competes with it, survives all three legs — the shipped age term's own
    standard, and the standard the 8-column block failed in §6.
    """
    if not POOL_MAIN.exists():
        raise SystemExit("run --stage pools first")
    pool = pd.read_parquet(POOL_MAIN)
    pool = pool[(pool.label == "baseline") & (pool.seed == seeds[0])].reset_index(drop=True)

    ids = df.set_index("bout_id")[["fighter_a_id", "fighter_b_id", "age_a", "age_b"]]
    joined = pool.join(ids, on="bout_id")
    assert joined["fighter_a_id"].notna().all(), "OOF pool has bouts absent from the frame"

    nat = fetch_nationality(source)
    d_us, covered = _us_indicator(
        joined["fighter_a_id"].to_numpy(), joined["fighter_b_id"].to_numpy(), nat
    )
    d_age = np.nan_to_num(
        (joined["age_a"].to_numpy(dtype=float) - joined["age_b"].to_numpy(dtype=float)) / 10.0
    )
    y = joined["y"].to_numpy(dtype=float)
    z = logit(joined["p"].to_numpy(dtype=float))
    dates = joined.join(
        df.set_index("bout_id")[["event_date"]], on="bout_id"
    )["event_date"]

    out: dict[str, Any] = {
        "source": source,
        "n": int(len(joined)),
        "n_covered": int(covered.sum()),
        "coverage": float(covered.mean()),
        "n_asymmetric": int((d_us != 0).sum()),
        "seed": seeds[0],
    }

    # The raw bias, before any fitting. This is the thing that has to be
    # real; the coefficient is only its summary.
    bias = []
    for value in (1.0, -1.0):
        m = d_us == value
        if m.any():
            bias.append(
                {
                    "d_us": value,
                    "n": int(m.sum()),
                    "model_p": float(joined.loc[m, "p"].mean()),
                    "actual": float(y[m].mean()),
                    "bias": float(joined.loc[m, "p"].mean() - y[m].mean()),
                }
            )
    out["raw_bias"] = bias

    era_rows = []
    dt = pd.to_datetime(dates).to_numpy()
    for lo, hi in (("2017", "2020"), ("2020", "2023"), ("2023", "2027")):
        era = (dt >= np.datetime64(lo)) & (dt < np.datetime64(hi))
        for value in (1.0, -1.0):
            m = era & (d_us == value)
            if m.sum() >= 30:
                era_rows.append(
                    {
                        "era": f"{lo}-{hi}",
                        "d_us": value,
                        "n": int(m.sum()),
                        "bias": float(joined.loc[m, "p"].mean() - y[m].mean()),
                    }
                )
    out["era_bias"] = era_rows

    blocks = {
        "age_only": np.column_stack([d_age]),
        "us_only": np.column_stack([d_us]),
        "age_plus_us": np.column_stack([d_age, d_us]),
    }
    out["gate"] = {
        name: three_leg_gate(z, y, Xc, dates) for name, Xc in blocks.items()
    }
    out["incremental_forward"] = (
        out["gate"]["age_plus_us"]["forward_delta"]
        - out["gate"]["age_only"]["forward_delta"]
    )
    out["incremental_cross_fit"] = (
        out["gate"]["age_plus_us"]["cross_fit_delta"]
        - out["gate"]["age_only"]["cross_fit_delta"]
    )

    # ── the third leg: the untouched 2025+ window, read once ────────────
    out["test"] = nat_test_leg(
        {name: np.asarray(g["full_coefs"]) for name, g in out["gate"].items()},
        nat,
        use_cache=True,
    )
    return out


def nat_test_leg(
    coefs: dict[str, np.ndarray], nat: dict[str, str], *, use_cache: bool
) -> dict[str, Any]:
    """Apply each fitted block to the held-out window and read the delta.

    This is the leg that killed the 8-column correction block in
    `winner_batch.md` §6 — it was the best block on the pool it was
    cross-fitted on and the worst here. Nothing is fitted in this function;
    the coefficients arrive already fixed from the OOF pool.

    The shipped corrector is stripped from the eval artifact first. Since
    v0.13.0 it is baked in, and measuring on top of it would fit a
    correction to an already-corrected model and report ~0 — which reads
    as "the lab was wrong" rather than "the lab already shipped".
    """
    from eval_tail_buckets import bucket_table, murphy, prepare_splits

    prep = prepare_splits(use_cache=use_cache)
    ens = prep["ensemble"]
    stripped = None
    if getattr(ens, "corrector", None) is not None:
        stripped = ens.corrector.describe()
        ens.corrector = None

    sp = prep["splits"]["test"]
    p = ens.predict_proba_a(sp["X"])
    p_sw = ens.predict_proba_a(sp["X_swapped"])
    y = sp["y"].astype(float)
    meta = sp["meta"]

    d_us, covered = _us_indicator(
        meta["fighter_a_id"].to_numpy(), meta["fighter_b_id"].to_numpy(), nat
    )
    d_age = np.nan_to_num(
        (
            pd.to_numeric(sp["X"]["abs_age_a"], errors="coerce").to_numpy(dtype=float)
            - pd.to_numeric(sp["X"]["abs_age_b"], errors="coerce").to_numpy(dtype=float)
        )
        / 10.0
    )
    block_cols = {
        "age_only": [d_age],
        "us_only": [d_us],
        "age_plus_us": [d_age, d_us],
    }

    def served(shift: np.ndarray) -> np.ndarray:
        # The correction is antisymmetric, so it enters the swapped
        # orientation with the opposite sign — exactly what
        # ResidualCorrector does inside predict_proba_a, and the reason the
        # shift survives the order averaging instead of cancelling.
        za = logit(p) + shift
        zb = logit(p_sw) - shift
        return 0.5 * (
            1.0 / (1.0 + np.exp(-za)) + (1.0 - 1.0 / (1.0 + np.exp(-zb)))
        )

    base = served(np.zeros(len(y)))
    base_ll = binary_logloss(y, base)
    out: dict[str, Any] = {
        "n": int(len(y)),
        "n_covered": int(covered.sum()),
        "coverage": float(covered.mean()),
        "stripped_corrector": stripped,
        "baseline_logloss": base_ll,
        "baseline_murphy": murphy(base, y.astype(int)),
        "blocks": {},
    }
    market = sp["market"]
    for name, cols in block_cols.items():
        k = coefs[name]
        shift = sum(float(kk) * c for kk, c in zip(k, cols, strict=True))
        pr = served(shift)
        out["blocks"][name] = {
            "coefs": [float(v) for v in k],
            "logloss": binary_logloss(y, pr),
            "delta": binary_logloss(y, pr) - base_ll,
            "accuracy": float(((pr >= 0.5).astype(int) == y.astype(int)).mean()),
            "murphy": murphy(pr, y.astype(int)),
            "buckets": bucket_table(pr, market, y.astype(int)),
        }
    out["incremental_delta"] = (
        out["blocks"]["age_plus_us"]["delta"] - out["blocks"]["age_only"]["delta"]
    )
    return out


def print_nat(res: dict) -> None:
    print(f"\n{'=' * 78}\nNATIONALITY TERM — source: {res['source']}\n{'=' * 78}")
    print(
        f"  pool n={res['n']}  covered {res['n_covered']} ({res['coverage']:.1%})  "
        f"asymmetric {res['n_asymmetric']}"
    )
    print(f"\n  {'segment':16s} {'n':>5} {'model p':>9} {'actual':>8} {'bias':>8}")
    for b in res["raw_bias"]:
        seg = "A is US" if b["d_us"] > 0 else "B is US"
        print(
            f"  {seg:16s} {b['n']:>5} {b['model_p']:>9.4f} {b['actual']:>8.4f} "
            f"{b['bias']:>+8.4f}"
        )
    print(f"\n  {'era':12s} {'d_us':>5} {'n':>5} {'bias':>8}")
    for e in res["era_bias"]:
        print(f"  {e['era']:12s} {e['d_us']:>+5.0f} {e['n']:>5} {e['bias']:>+8.4f}")
    print(f"\n  {'block':14s} {'cross-fit':>10} {'forward':>9} {'coefs (full fit)':>28}")
    for name, g in res["gate"].items():
        coefs = " ".join(f"{c:+.4f}" for c in g["full_coefs"])
        print(
            f"  {name:14s} {g['cross_fit_delta']:>+10.5f} {g['forward_delta']:>+9.5f} "
            f"{coefs:>28}"
        )
    print(
        f"\n  incremental over age:  cross-fit {res['incremental_cross_fit']:+.5f}  "
        f"forward {res['incremental_forward']:+.5f}"
    )
    t = res.get("test")
    if t:
        print(
            f"\n  HELD-OUT 2025+ (n={t['n']}, covered {t['coverage']:.1%}, "
            f"baseline ll {t['baseline_logloss']:.4f})"
        )
        print(f"  {'block':14s} {'log-loss':>9} {'delta':>9} {'acc':>7} {'resolution':>11}")
        for name, b in t["blocks"].items():
            print(
                f"  {name:14s} {b['logloss']:>9.4f} {b['delta']:>+9.5f} "
                f"{b['accuracy']:>7.4f} {b['murphy']['resolution']:>11.5f}"
            )
        print(f"  incremental over age on test: {t['incremental_delta']:+.5f}")
        print("\n  VERDICT — three legs must agree in sign for the US term:")
        legs = {
            "cross-fit": res["incremental_cross_fit"],
            "forward": res["incremental_forward"],
            "test": t["incremental_delta"],
        }
        for leg, v in legs.items():
            print(f"    {leg:10s} {v:+.5f}  {'PASS' if v < 0 else 'FAIL'}")
        print(f"    => {'GATE PASS' if all(v < 0 for v in legs.values()) else 'GATE FAIL'}")


# ── stage: subtemp — temperature on the sub-vs-dec contrast ────────────


def apply_sub_temperature(p: np.ndarray, tau: float) -> np.ndarray:
    """Scale the submission coordinate's log-odds against DECISION.

    Decision is the reference class, so `tau` moves sub-vs-dec and leaves
    ko-vs-dec alone; ko still moves in absolute terms because everything
    renormalises, which is correct — the three shares are a simplex, not
    three independent numbers.

    A SCALE and not a shift, because the measured defect is a scale. The
    submission share is under-dispersed at BOTH ends of its own quintile
    table, and a shift can only move one end at the cost of the other.
    `tau > 1` sharpens.
    """
    q = np.clip(np.asarray(p, dtype=float), 1e-12, 1.0)
    z_ko = np.log(q[:, 0] / q[:, 2])
    z_sub = np.log(q[:, 1] / q[:, 2]) * float(tau)
    z = np.column_stack([z_ko, z_sub, np.zeros(len(q))])
    z -= z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def _fit_tau(p: np.ndarray, y: np.ndarray) -> float:
    from scipy.optimize import minimize_scalar

    res = minimize_scalar(
        lambda t: multiclass_logloss(y, apply_sub_temperature(p, t)),
        bounds=(0.2, 3.0),
        method="bounded",
    )
    return float(res.x)


def _quintile_reliability(p_col: np.ndarray, hit: np.ndarray) -> list[dict[str, Any]]:
    edges = np.quantile(p_col, [0.0, 0.2, 0.4, 0.6, 0.8, 1.0])
    out = []
    for i in range(5):
        lo, hi = edges[i], edges[i + 1]
        m = (p_col >= lo) & (p_col <= hi if i == 4 else p_col < hi)
        if m.sum() == 0:
            continue
        out.append(
            {
                "quintile": i + 1,
                "n": int(m.sum()),
                "predicted": float(p_col[m].mean()),
                "actual": float(hit[m].mean()),
            }
        )
    return out


def stage_subtemp(df: pd.DataFrame, seeds: list[int]) -> dict[str, Any]:
    """GATE — one temperature parameter on the submission axis.

    `method_leg.md` §4 named the submission cell as carrying the whole
    residual gap to the book, and §9 then failed to move it twice: a
    hierarchical re-shape was WORSE than the flat softmax, and nine columns
    of genuinely new submission information moved the val cell by 0.002 with
    per-seed deltas that did not agree in sign. Both of those were gates on
    71 val submissions.

    This is the third thing it could have been, and the only one those two
    do not rule out: not the shape, not the information, the DISPERSION.
    Gated on 543 submissions instead of 71.

    Gate metric is the OVERALL 3-class log-loss. Hard side condition: the
    decision cell must not degrade — `dec` is the one cell where the model
    is ahead of the book (-0.0920), and a sub-vs-dec temperature is the
    most direct way to spend it.
    """
    if not POOL_METHOD.exists():
        raise SystemExit("run --stage pools first")
    pool = pd.read_parquet(POOL_METHOD)
    pool = pool[(pool.label == "baseline") & (pool.seed == seeds[0])].reset_index(drop=True)

    p = pool[["p_ko", "p_sub", "p_dec"]].to_numpy(dtype=float)
    y = pool["y"].to_numpy(dtype=int)
    dates = pd.to_datetime(pool["event_date"])

    out: dict[str, Any] = {
        "n": int(len(pool)),
        "n_submissions": int((y == 1).sum()),
        "baseline_logloss": multiclass_logloss(y, p),
        "baseline_cells": cell_table(pool),
        "sub_reliability_before": _quintile_reliability(p[:, 1], (y == 1).astype(float)),
    }

    # in-sample, cross-fit, forward
    tau_all = _fit_tau(p, y)
    rng = np.random.default_rng(0)
    fold = rng.integers(0, 5, len(y))
    p_cf = p.copy()
    taus_cf = []
    for f in range(5):
        tr, te = fold != f, fold == f
        t = _fit_tau(p[tr], y[tr])
        taus_cf.append(t)
        p_cf[te] = apply_sub_temperature(p[te], t)
    dt = dates.to_numpy()
    tr = dt < np.datetime64(FORWARD_SPLIT)
    te = ~tr
    tau_fwd = _fit_tau(p[tr], y[tr])

    out["tau_full"] = tau_all
    out["tau_cross_fit"] = taus_cf
    out["tau_forward"] = tau_fwd
    out["cross_fit_delta"] = multiclass_logloss(y, p_cf) - out["baseline_logloss"]
    out["forward_delta"] = multiclass_logloss(
        y[te], apply_sub_temperature(p[te], tau_fwd)
    ) - multiclass_logloss(y[te], p[te])
    out["forward_n_train"] = int(tr.sum())
    out["forward_n_score"] = int(te.sum())

    after = pool.copy()
    after[["p_ko", "p_sub", "p_dec"]] = apply_sub_temperature(p, tau_all)
    out["cells_after_full_fit"] = cell_table(after)
    out["sub_reliability_after"] = _quintile_reliability(
        after["p_sub"].to_numpy(), (y == 1).astype(float)
    )

    # ── the third leg: 2025+, with the split-trained twin ───────────────
    out["test"] = subtemp_test_leg(df, tau_all, tau_fwd)
    return out


def subtemp_test_leg(df: pd.DataFrame, tau_all: float, tau_fwd: float) -> dict[str, Any]:
    """The conditional leg on the untouched window, using method_model_eval
    (the split-trained twin) so the measurement stays out-of-sample."""
    from src.config import VAL_END
    from src.method_model import METHOD_MODEL_EVAL_DIR, MethodModel

    model = MethodModel.load(METHOD_MODEL_EVAL_DIR)
    keep = ~(df["is_debut_a"].astype(bool) | df["is_debut_b"].astype(bool))
    frame = df.loc[keep].reset_index(drop=True)
    X, y, meta = method_frame(
        frame, levels=model.use_levels, sub_axis=model.use_sub_axis
    )
    te = (meta["event_date"] >= pd.Timestamp(VAL_END)).to_numpy()
    p = model.predict_cond(X.loc[te][model.feature_columns].reset_index(drop=True))
    yy = y[te]

    base = pd.DataFrame(
        {"p_ko": p[:, 0], "p_sub": p[:, 1], "p_dec": p[:, 2], "y": yy}
    )
    out: dict[str, Any] = {
        "n": int(len(yy)),
        "n_submissions": int((yy == 1).sum()),
        "baseline_logloss": multiclass_logloss(yy, p),
        "baseline_cells": cell_table(base),
        "arms": {},
    }
    for name, tau in (("tau_full_fit", tau_all), ("tau_forward_fit", tau_fwd)):
        q = apply_sub_temperature(p, tau)
        after = pd.DataFrame(
            {"p_ko": q[:, 0], "p_sub": q[:, 1], "p_dec": q[:, 2], "y": yy}
        )
        cells = cell_table(after)
        base_cells = {c["class"]: c["logloss_when_true"] for c in out["baseline_cells"]}
        out["arms"][name] = {
            "tau": tau,
            "logloss": multiclass_logloss(yy, q),
            "delta": multiclass_logloss(yy, q) - out["baseline_logloss"],
            "cells": cells,
            "cell_deltas": {
                c["class"]: c["logloss_when_true"] - base_cells[c["class"]]
                for c in cells
            },
        }
    return out


def print_subtemp(res: dict) -> None:
    print(f"\n{'=' * 78}\nSUB-AXIS TEMPERATURE\n{'=' * 78}")
    print(
        f"  pool n={res['n']} · submissions {res['n_submissions']} · "
        f"baseline 3-class ll {res['baseline_logloss']:.4f}"
    )
    print(f"\n  submission reliability by quintile (n={res['n']})")
    print(f"  {'q':>2} {'n':>5} {'predicted':>10} {'actual':>8}   {'-> after':>10} ")
    for b, a in zip(
        res["sub_reliability_before"], res["sub_reliability_after"], strict=True
    ):
        print(
            f"  {b['quintile']:>2} {b['n']:>5} {b['predicted']:>10.4f} "
            f"{b['actual']:>8.4f}   {a['predicted']:>10.4f}"
        )
    print(
        f"\n  tau: full {res['tau_full']:.4f} · forward {res['tau_forward']:.4f} · "
        f"cross-fit {[round(t, 3) for t in res['tau_cross_fit']]}"
    )
    print(
        f"  cross-fit {res['cross_fit_delta']:+.5f} · "
        f"forward {res['forward_delta']:+.5f} (n={res['forward_n_score']})"
    )
    t = res["test"]
    print(
        f"\n  HELD-OUT 2025+ (n={t['n']}, submissions {t['n_submissions']}, "
        f"baseline {t['baseline_logloss']:.4f})"
    )
    print(f"  {'arm':16s} {'tau':>7} {'ll':>8} {'delta':>9}   cell deltas (ko/sub/dec)")
    for name, a in t["arms"].items():
        cd = a["cell_deltas"]
        print(
            f"  {name:16s} {a['tau']:>7.4f} {a['logloss']:>8.4f} {a['delta']:>+9.5f}   "
            f"{cd['ko']:+.4f} / {cd['sub']:+.4f} / {cd['dec']:+.4f}"
        )
    print("\n  VERDICT — three legs plus the decision-cell side condition:")
    legs = {
        "cross-fit": res["cross_fit_delta"],
        "forward": res["forward_delta"],
        "test": t["arms"]["tau_full_fit"]["delta"],
    }
    for leg, v in legs.items():
        print(f"    {leg:14s} {v:+.5f}  {'PASS' if v < 0 else 'FAIL'}")
    dec = t["arms"]["tau_full_fit"]["cell_deltas"]["dec"]
    print(f"    {'dec not worse':14s} {dec:+.5f}  {'PASS' if dec <= 0 else 'FAIL'}")
    ok = all(v < 0 for v in legs.values()) and dec <= 0
    print(f"    => {'GATE PASS' if ok else 'GATE FAIL'}")


# ── stage: debutcorr — the shipped age correction, on the specialist ───


def apply_corrector_to_pool(pool: pd.DataFrame, shift: np.ndarray) -> np.ndarray:
    """Re-serve a stored pool under an additive antisymmetric logit shift.

    Exact, not an approximation: `ResidualCorrector` runs after the blend
    and does not touch fitting, so applying it to the stored per-orientation
    probabilities reproduces what `predict_proba_a` would have returned —
    including the sign flip on the swapped orientation, which is what makes
    the shift survive the order averaging instead of cancelling in it.
    """
    za = logit(pool["p_raw"].to_numpy(dtype=float)) + shift
    zb = logit(pool["p_sw"].to_numpy(dtype=float)) - shift
    return 0.5 * (
        1.0 / (1.0 + np.exp(-za)) + (1.0 - 1.0 / (1.0 + np.exp(-zb)))
    )


def stage_debutcorr(df: pd.DataFrame, seeds: list[int]) -> dict[str, Any]:
    """GATE — does RESIDUAL_CORRECTION belong on the debut specialist?

    The open question at the end of `winner_batch.md`. The correction was
    fitted and gated on the both-experienced population only, and
    `train.py` never assigns `.corrector` to the specialist. One
    uncontrolled observation (an accidental run) moved the debut segment
    0.6534 -> 0.6380 on 94 bouts and was left explicitly ungated.

    The MDE is declared here, before the number is read, because at n=798
    it decides what this stage is even able to say. And a mechanistic
    argument is recorded AGAINST the lever up front: v0.13.0's whole
    justification was that `diff_age` is DILUTED among 117 partly
    collinear columns. A debut row has 27 of the 67 diffs at NaN, so
    there is less to dilute it, so the correction should be worth LESS
    here, not more. The uncontrolled observation says the opposite, which
    is exactly why it needed gating rather than shipping.
    """
    from src.config import RESIDUAL_CORRECTION

    if not POOL_DEBUT.exists():
        raise SystemExit("run --stage pools first")
    pool = pd.read_parquet(POOL_DEBUT)
    pool = pool[(pool.label == "baseline") & (pool.seed == seeds[0])].reset_index(drop=True)

    joined = pool.join(
        df.set_index("bout_id")[["age_a", "age_b", "event_date"]], on="bout_id"
    )
    y = joined["y"].to_numpy(dtype=float)
    base = joined["p"].to_numpy(dtype=float)
    base_ll = binary_logloss(y, base)

    eps = 1e-6
    pb = np.clip(base, eps, 1 - eps)
    per_bout = -(y * np.log(pb) + (1 - y) * np.log(1 - pb))
    se_pair_upper = float(per_bout.std(ddof=1) / np.sqrt(len(per_bout)))

    terms = (RESIDUAL_CORRECTION or {}).get("terms", [])
    shift = np.zeros(len(joined), dtype=float)
    d_age = (
        joined["age_a"].to_numpy(dtype=float) - joined["age_b"].to_numpy(dtype=float)
    )
    age_live = float(np.isfinite(d_age).mean())
    for t in terms:
        if t["column"] != "diff_age":
            raise SystemExit(
                f"this stage only knows diff_age, got {t['column']!r} — extend it"
            )
        shift += float(t["weight"]) * np.nan_to_num(d_age / float(t["scale"]))

    p_corr = apply_corrector_to_pool(joined, shift)
    delta = binary_logloss(y, p_corr) - base_ll

    d = -(y * np.log(np.clip(p_corr, eps, 1 - eps))
          + (1 - y) * np.log(np.clip(1 - p_corr, eps, 1 - eps))) - per_bout
    se_paired = float(d.std(ddof=1) / np.sqrt(len(d)))

    return {
        "n": int(len(joined)),
        "diff_age_live_share": age_live,
        "effective_n": int(np.isfinite(d_age).sum()),
        "corrector": RESIDUAL_CORRECTION,
        "declared_mde_before_run": {
            "unpaired_se": se_pair_upper,
            "one_sided_80pct": 2.49 * se_pair_upper,
            "note": (
                "Declared from the baseline pool alone, before the corrected "
                "number was computed. The paired SE below is smaller and is "
                "the one the verdict uses; the unpaired figure is what a lab "
                "that forgot to pair would have been stuck with."
            ),
        },
        "baseline_logloss": base_ll,
        "corrected_logloss": binary_logloss(y, p_corr),
        "delta": float(delta),
        "paired_se": se_paired,
        "z": float(delta / se_paired) if se_paired else float("nan"),
        "uncontrolled_observation_for_scale": {"before": 0.6534, "after": 0.6380, "n": 94},
    }


def print_debutcorr(res: dict) -> None:
    print(f"\n{'=' * 78}\nAGE CORRECTION ON THE DEBUT SPECIALIST\n{'=' * 78}")
    m = res["declared_mde_before_run"]
    print(
        f"  n={res['n']} · diff_age live on {res['diff_age_live_share']:.1%} "
        f"(effective n={res['effective_n']})"
    )
    print(
        f"  DECLARED BEFORE THE RUN: unpaired SE {m['unpaired_se']:.5f} -> "
        f"one-sided 80% MDE {m['one_sided_80pct']:.5f}"
    )
    print(
        f"\n  baseline  {res['baseline_logloss']:.5f}\n"
        f"  corrected {res['corrected_logloss']:.5f}\n"
        f"  delta     {res['delta']:+.5f}  (paired SE {res['paired_se']:.5f}, "
        f"z = {res['z']:+.2f})"
    )
    verdict = "PASS" if res["delta"] < 0 and abs(res["z"]) >= 1.96 else "FAIL"
    print(f"  => GATE {verdict}")


# ── stage: debutlv — absolute levels in the specialist's matrix ────────


def stage_debutlv(df: pd.DataFrame, seeds: list[int]) -> dict[str, Any]:
    """GATE — 22 absolute pairs the debut matrix cannot currently see.

    Measured, not assumed: 27 of the 67 diffs are 100% NaN on a debut row,
    and 22 of them have no `abs_*` companion. The consequence is not that
    the debutant's level is unknown — it is that the OPPONENT's is. Every
    debut bout looks identical on those 22 axes.

    Same diagnosis METHOD_LEVEL_COLUMNS fixed for the method leg, where it
    was worth 0.8966 -> 0.8870 seed-stably.
    """
    if not POOL_DEBUT.exists():
        raise SystemExit("run --stage pools first")
    base_pool = pd.read_parquet(POOL_DEBUT)

    from src.features import DEBUT_LEVEL_COLUMNS

    out: dict[str, Any] = {
        "n_level_columns": len(DEBUT_LEVEL_COLUMNS),
        "level_columns": list(DEBUT_LEVEL_COLUMNS),
        "seeds": seeds,
        "arms": {},
    }
    for seed in seeds:
        b = base_pool[(base_pool.label == "baseline") & (base_pool.seed == seed)]
        if b.empty:
            print(f"  (no baseline pool for seed {seed} — building)")
            b = walk_forward_debut(df, label="baseline", seed=seed)
        cand = walk_forward_debut(df, label="levels", seed=seed, levels=True, verbose=True)

        b = b.sort_values("bout_id").reset_index(drop=True)
        c = cand.sort_values("bout_id").reset_index(drop=True)
        boot = paired_bootstrap(c, b)
        out["arms"][str(seed)] = {
            "baseline_logloss": oof_logloss(b),
            "levels_logloss": oof_logloss(c),
            "delta": oof_logloss(c) - oof_logloss(b),
            "bootstrap": boot,
            "n": int(len(b)),
        }
        print(
            f"  seed {seed}: {oof_logloss(b):.5f} -> {oof_logloss(c):.5f}  "
            f"delta {oof_logloss(c) - oof_logloss(b):+.5f}  "
            f"improving {boot['frac_improving']:.0%}"
        )
    deltas = [a["delta"] for a in out["arms"].values()]
    out["sign_stable"] = bool(all(d < 0 for d in deltas) or all(d > 0 for d in deltas))
    out["median_delta"] = float(np.median(deltas))
    return out


def print_debutlv(res: dict) -> None:
    print(f"\n{'=' * 78}\nABSOLUTE LEVELS IN THE DEBUT MATRIX ({res['n_level_columns']} pairs)\n{'=' * 78}")
    print(f"  {'seed':>5} {'baseline':>9} {'levels':>9} {'delta':>9} {'95% CI':>22} {'improving':>10}")
    for seed, a in res["arms"].items():
        b = a["bootstrap"]
        ci = f"[{b['lo']:+.5f}, {b['hi']:+.5f}]"
        print(
            f"  {seed:>5} {a['baseline_logloss']:>9.5f} {a['levels_logloss']:>9.5f} "
            f"{a['delta']:>+9.5f} {ci:>22} {b['frac_improving']:>10.0%}"
        )
    print(
        f"\n  median delta {res['median_delta']:+.5f} · "
        f"sign stable across seeds: {res['sign_stable']}"
    )
    ok = res["sign_stable"] and res["median_delta"] < 0
    print(f"  => GATE {'PASS' if ok else 'FAIL'}")


# ── stage: debutmethod — a method model for the debut segment ──────────


def stage_debutmethod(df: pd.DataFrame, seeds: list[int]) -> dict[str, Any]:
    """GATE — the method leg on the 19% of the slate it does not serve.

    Baseline is a per-scheduled-length CONSTANT on the debut base rates,
    not the current MC anchor. Most of the available gain is a marginal
    that is simply wrong for the segment (ko/sub/dec 0.3597/0.2292/0.4111
    on debut rows against 0.3257/0.1877/0.4866 on experienced ones), and a
    discriminative model that only beats the anchor has demonstrated
    nothing except that the anchor was wrong.
    """
    from lab_method_common import (
        paired_bootstrap_method,
        walk_forward_method_debut,
    )

    out: dict[str, Any] = {"arms": {}, "seeds": seeds}
    const = walk_forward_method_debut(df, label="constant", arm="constant", seed=seeds[0])
    out["constant"] = {
        "n": int(len(const)),
        "n_submissions": int((const["y"] == 1).sum()),
        "logloss": pool_logloss(const),
        "cells": cell_table(const),
    }
    print(
        f"  constant baseline: n={len(const)} ll={pool_logloss(const):.5f} "
        f"(submissions {int((const['y'] == 1).sum())})"
    )

    mc_scored = score_mc_against(mc_anchor_frame(df), const)
    mc_frame = mc_scored.pop("frame")
    out["mc_anchor"] = mc_scored
    out["mc_anchor"]["delta_constant_minus_mc"] = (
        out["constant"]["logloss"] - mc_scored["logloss"]
    )
    c_al = const.sort_values("bout_id").reset_index(drop=True)
    m_al = mc_frame.sort_values("bout_id").reset_index(drop=True)
    out["mc_anchor"]["bootstrap_constant_vs_mc"] = paired_bootstrap_method(c_al, m_al)
    print(
        f"  MC anchor (what production serves today): ll={mc_scored['logloss']:.5f}  "
        f"constant - MC = {out['mc_anchor']['delta_constant_minus_mc']:+.5f}"
    )

    for seed in seeds:
        model = walk_forward_method_debut(
            df, label="model", arm="model", seed=seed, verbose=True
        )
        c = model.sort_values("bout_id").reset_index(drop=True)
        b = const.sort_values("bout_id").reset_index(drop=True)
        boot = paired_bootstrap_method(c, b)
        out["arms"][str(seed)] = {
            "logloss": pool_logloss(model),
            "delta_vs_constant": pool_logloss(model) - out["constant"]["logloss"],
            "bootstrap": boot,
            "cells": cell_table(model),
        }
        print(
            f"  seed {seed}: model {pool_logloss(model):.5f} vs constant "
            f"{out['constant']['logloss']:.5f}  "
            f"delta {pool_logloss(model) - out['constant']['logloss']:+.5f}  "
            f"improving {boot['frac_improving']:.0%}"
        )
    deltas = [a["delta_vs_constant"] for a in out["arms"].values()]
    out["median_delta"] = float(np.median(deltas))
    out["sign_stable"] = bool(all(d < 0 for d in deltas) or all(d > 0 for d in deltas))
    return out


MC_ANCHOR_CACHE = DATA_DIR / "lab_accuracy_debut_mc.parquet"


def mc_anchor_frame(df: pd.DataFrame) -> pd.DataFrame:
    """What production actually serves on these bouts today.

    Without this arm the gate answers the wrong question. "The model beats
    a constant" decides whether to build a MODEL; "the constant beats the
    MC anchor" decides whether to ship ANYTHING, and that is the one worth
    knowing first, because `predict.py:246-250` currently hands the whole
    debut segment to a simulator whose ten `FighterMC` inputs are router
    defaults for a debutant.

    The conditional is read off the joint the way `sportsbook.ts` does:
    P(ko | this side wins) = prob_ko_side / winner_prob_side, taken for
    the side that actually won so it lines up with the winner-first pool.
    """
    from lab_method_common import method_frame

    from src.export import stable_hash
    from src.monte_carlo import FighterMC, simulate_bout

    _, y, meta = method_frame(df)
    keep = meta["is_debut"].to_numpy()
    ids = set(meta.loc[keep, "bout_id"].to_numpy())

    if MC_ANCHOR_CACHE.exists():
        cached = pd.read_parquet(MC_ANCHOR_CACHE)
        if set(cached["bout_id"]) == ids:
            print(f"  MC anchor: reusing {MC_ANCHOR_CACHE.name} ({len(cached)} bouts)")
            return cached

    sub = df.loc[df["bout_id"].isin(ids)].reset_index(drop=True)
    print(f"  MC anchor: simulating {len(sub)} debut bouts (~0.4s each)…")
    rows = []
    for i in range(len(sub)):
        row = sub.iloc[i]
        snap_a = {
            k[:-2]: row[k]
            for k in row.index
            if k.endswith("_a") and k != "fighter_a_id"
        }
        snap_b = {
            k[:-2]: row[k]
            for k in row.index
            if k.endswith("_b") and k != "fighter_b_id"
        }
        mc = simulate_bout(
            FighterMC.from_snapshot(snap_a),
            FighterMC.from_snapshot(snap_b),
            int(row["scheduled_rounds"]),
            seed=stable_hash(row["bout_id"]),
            is_main_event=bool(row["is_main_event"]),
            is_title_fight=bool(row["is_title_fight"]),
        )
        a_won = int(row["target_a_wins"]) == 1
        win = mc.winner_prob_a if a_won else mc.winner_prob_b
        ko = mc.prob_ko_a if a_won else mc.prob_ko_b
        sb = mc.prob_sub_a if a_won else mc.prob_sub_b
        dc = mc.prob_decision_a if a_won else mc.prob_decision_b
        win = max(win, 1e-9)
        rows.append(
            {
                "bout_id": row["bout_id"],
                "p_ko": ko / win,
                "p_sub": sb / win,
                "p_dec": dc / win,
            }
        )
    frame = pd.DataFrame(rows)
    frame.to_parquet(MC_ANCHOR_CACHE)
    return frame


def score_mc_against(frame: pd.DataFrame, truth: pd.DataFrame) -> dict[str, Any]:
    """Score the MC conditional on exactly the bouts the pool scored.

    `truth` is the constant arm's own output — same bout_ids, same class
    encoding — so the two numbers are comparable per bout and the paired
    bootstrap below is a real pairing rather than two marginal means.
    """
    m = frame.merge(truth[["bout_id", "y"]], on="bout_id", how="inner")
    p = np.clip(m[["p_ko", "p_sub", "p_dec"]].to_numpy(dtype=float), 1e-9, None)
    p = p / p.sum(axis=1, keepdims=True)
    scored = pd.DataFrame(
        {
            "bout_id": m["bout_id"],
            "p_ko": p[:, 0],
            "p_sub": p[:, 1],
            "p_dec": p[:, 2],
            "y": m["y"].to_numpy(dtype=int),
        }
    )
    return {
        "n": int(len(scored)),
        "logloss": pool_logloss(scored),
        "cells": cell_table(scored),
        "frame": scored,
    }


def print_debutmethod(res: dict) -> None:
    print(f"\n{'=' * 78}\nMETHOD MODEL FOR THE DEBUT SEGMENT\n{'=' * 78}")
    c = res["constant"]
    mc = res.get("mc_anchor")
    if mc:
        b = mc["bootstrap_constant_vs_mc"]
        print(
            f"  MC anchor — what production serves today: n={mc['n']} · "
            f"ll {mc['logloss']:.5f}"
        )
        print(
            f"  constant - MC anchor: {mc['delta_constant_minus_mc']:+.5f}  "
            f"95% CI [{b['lo']:+.5f}, {b['hi']:+.5f}]  "
            f"improving {b['frac_improving']:.0%}"
        )
    print(
        f"  constant baseline (per-length debut base rates): n={c['n']} · "
        f"submissions {c['n_submissions']} · ll {c['logloss']:.5f}"
    )
    print(f"\n  {'seed':>5} {'model ll':>9} {'delta':>9} {'95% CI':>24} {'improving':>10}")
    for seed, a in res["arms"].items():
        b = a["bootstrap"]
        ci = f"[{b['lo']:+.5f}, {b['hi']:+.5f}]"
        print(
            f"  {seed:>5} {a['logloss']:>9.5f} {a['delta_vs_constant']:>+9.5f} "
            f"{ci:>24} {b['frac_improving']:>10.0%}"
        )
    print(
        f"\n  median delta {res['median_delta']:+.5f} · sign stable: {res['sign_stable']}"
    )
    ok = res["sign_stable"] and res["median_delta"] < 0
    print(f"  => GATE {'PASS' if ok else 'FAIL'} (against the CONSTANT, not the MC anchor)")


# ── stage: power (probe D) ─────────────────────────────────────────────


def stage_power(seeds: list[int]) -> dict[str, Any]:
    """What the instrument can actually resolve.

    Half of every candidate list is below this number, and the honest
    move is to say so in the header of a lab report rather than to chase
    the effect with more seeds. Reported for the MAIN pool, because that
    is the one every winner-leg claim is measured on.
    """
    main = pd.read_parquet(POOL_MAIN)
    base = main[main.label == "baseline"]
    by_seed = {
        int(s): oof_logloss(base[base.seed == s]) for s in sorted(base.seed.unique())
    }
    lls = np.array(list(by_seed.values()))

    ref = base[base.seed == seeds[0]].sort_values("bout_id").reset_index(drop=True)
    eps = 1e-6
    y = ref["y"].to_numpy(dtype=float)
    p = np.clip(ref["p"].to_numpy(dtype=float), eps, 1 - eps)
    per_bout = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    se = float(per_bout.std(ddof=1) / np.sqrt(len(per_bout)))

    # A paired comparison cancels bout difficulty, so its SE is far below
    # the unpaired one. Estimated from the seed-to-seed pairs, which are
    # the only "same recipe, different noise" pairs available.
    paired_ses = []
    for s in sorted(base.seed.unique()):
        if s == seeds[0]:
            continue
        other = base[base.seed == s].sort_values("bout_id").reset_index(drop=True)
        if len(other) != len(ref) or not (other.bout_id == ref.bout_id).all():
            continue
        q = np.clip(other["p"].to_numpy(dtype=float), eps, 1 - eps)
        d = -(y * np.log(q) + (1 - y) * np.log(1 - q)) - per_bout
        paired_ses.append(float(d.std(ddof=1) / np.sqrt(len(d))))

    paired_se = float(np.mean(paired_ses)) if paired_ses else float("nan")
    sd_seed = float(lls.std(ddof=1)) if len(lls) > 1 else float("nan")
    # One-sided, 80% power, alpha 0.05 → 2.49 sigma.
    mde_1seed = 2.49 * float(np.hypot(paired_se, sd_seed)) if paired_ses else float("nan")
    mde_inf = 2.49 * paired_se if paired_ses else float("nan")

    return {
        "logloss_by_seed": by_seed,
        "seed_spread": float(lls.max() - lls.min()) if len(lls) > 1 else float("nan"),
        "sd_across_seeds": sd_seed,
        "unpaired_se": se,
        "paired_se_between_seeds": paired_se,
        "mde_one_sided_80pct_single_seed": mde_1seed,
        "mde_one_sided_80pct_infinite_seeds": mde_inf,
        "shipped_lever_for_scale": -0.0026,
        "note": (
            "RESIDUAL_CORRECTION, the only lever this repo has ever shipped on "
            "the winner leg, is worth -0.0026 OOF. Any candidate whose honest "
            "estimate is below the MDE above cannot be gated on this pool no "
            "matter how many seeds are spent on it."
        ),
    }


# ── stage: calib (probe C) ─────────────────────────────────────────────


def _pav(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Pool-adjacent-violators isotonic fit — the CORP recalibration."""
    order = np.argsort(p, kind="mergesort")
    ys = y[order].astype(float)
    w = np.ones_like(ys)
    level, weight = [], []
    for value, wt in zip(ys, w, strict=True):
        level.append(value)
        weight.append(wt)
        while len(level) > 1 and level[-2] > level[-1]:
            v2, w2 = level.pop(), weight.pop()
            v1, w1 = level.pop(), weight.pop()
            level.append((v1 * w1 + v2 * w2) / (w1 + w2))
            weight.append(w1 + w2)
    fitted = np.repeat(level, [int(round(x)) for x in weight])
    out = np.empty_like(fitted)
    out[order] = fitted
    return out


def _binned_reliability(y: np.ndarray, p: np.ndarray, bins: int) -> float:
    edges = np.linspace(0.0, 1.0, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if not m.any():
            continue
        total += m.sum() * (p[m].mean() - y[m].mean()) ** 2
    return float(total / len(y))


def stage_calib(seeds: list[int]) -> dict[str, Any]:
    """Is 'better calibrated than the closing line' an artefact of 10 bins?

    `winner_batch.md` §8 reports reliability 0.00186 model vs 0.00301
    market on a 10-equal-width-bin Murphy decomposition. Binned reliability
    is biased by the bin count, so the claim is re-read two ways: the same
    statistic swept over bin counts, and the bin-free CORP miscalibration
    (Dimitriadis/Gneiting/Jordan 2021), which fits a PAV recalibration and
    reads the score improvement it buys.
    """
    main = pd.read_parquet(POOL_MAIN)
    base = main[main.label == "baseline"]
    available = set(int(s) for s in base.seed.unique())
    use = [s for s in seeds if s in available] or sorted(available)

    out: dict[str, Any] = {"seeds": use, "per_seed": {}}
    for seed in use:
        frame = base[(base.seed == seed) & base["market"].notna()].reset_index(drop=True)
        y = frame["y"].to_numpy(dtype=float)

        swept = {}
        for bins in (5, 10, 20, 40):
            swept[bins] = {
                "model": _binned_reliability(y, frame["p"].to_numpy(dtype=float), bins),
                "market": _binned_reliability(
                    y, frame["market"].to_numpy(dtype=float), bins
                ),
            }
            swept[bins]["model_minus_market"] = (
                swept[bins]["model"] - swept[bins]["market"]
            )

        corp = {}
        for name in ("p", "market"):
            p = np.clip(frame[name].to_numpy(dtype=float), 1e-9, 1 - 1e-9)
            rc = np.clip(_pav(y, p), 1e-9, 1 - 1e-9)
            corp[name] = {
                "mcb_brier": float(((p - y) ** 2).mean() - ((rc - y) ** 2).mean()),
                "mcb_logloss": float(binary_logloss(y, p) - binary_logloss(y, rc)),
            }

        out["per_seed"][str(seed)] = {
            "n": int(len(frame)),
            "binned_reliability": swept,
            "corp": corp,
        }

    # The verdict is about STABILITY, not about one number. Binned
    # reliability at 40 bins puts ~30 bouts in a bin, and within-bin
    # sampling error inflates it for whichever series is more dispersed —
    # which is the market, by construction, since it is the sharper one.
    signs = {
        bins: [
            out["per_seed"][str(s)]["binned_reliability"][bins]["model_minus_market"]
            for s in use
        ]
        for bins in (5, 10, 20, 40)
    }
    out["sign_stable_by_bins"] = {
        str(bins): bool(all(v < 0 for v in vs) or all(v > 0 for v in vs))
        for bins, vs in signs.items()
    }
    out["corp_sign_stable"] = bool(
        all(
            out["per_seed"][str(s)]["corp"]["p"]["mcb_logloss"]
            < out["per_seed"][str(s)]["corp"]["market"]["mcb_logloss"]
            for s in use
        )
    )
    out["verdict_note"] = (
        "MCB is a miscalibration measure: lower is better calibrated. The "
        "10-bin figure in the README is one point on a curve that is not "
        "sign-stable across seeds at 20-40 bins; the bin-free CORP number "
        "is, and it agrees with the README."
    )
    return out


def print_calib(res: dict) -> None:
    print(f"\n{'=' * 78}\nCALIBRATION — binned vs bin-free\n{'=' * 78}")
    seeds = res["seeds"]
    print(f"  {'bins':>5} " + " ".join(f"{'seed ' + str(s):>13}" for s in seeds) + "  stable")
    for bins in (5, 10, 20, 40):
        vals = [
            res["per_seed"][str(s)]["binned_reliability"][str(bins)][
                "model_minus_market"
            ]
            if str(bins) in res["per_seed"][str(s)]["binned_reliability"]
            else res["per_seed"][str(s)]["binned_reliability"][bins][
                "model_minus_market"
            ]
            for s in seeds
        ]
        stable = res["sign_stable_by_bins"][str(bins)]
        print(
            f"  {bins:>5} "
            + " ".join(f"{v:>+13.6f}" for v in vals)
            + f"  {'yes' if stable else 'NO'}"
        )
    print("\n  bin-free CORP miscalibration (lower = better calibrated)")
    print(f"  {'seed':>6} {'model':>10} {'market':>10}")
    for s in seeds:
        c = res["per_seed"][str(s)]["corp"]
        print(
            f"  {s:>6} {c['p']['mcb_logloss']:>10.5f} "
            f"{c['market']['mcb_logloss']:>10.5f}"
        )
    print(
        f"\n  model better calibrated than the book on every seed: "
        f"{res['corp_sign_stable']}"
    )


# ── main ───────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--stage",
        default="pools",
        choices=(
            "pools",
            "nat",
            "subtemp",
            "debutlv",
            "debutcorr",
            "debutmethod",
            "power",
            "calib",
        ),
    )
    ap.add_argument("--seeds", default="42")
    ap.add_argument("--cache", action="store_true", help="reuse data/dataset.parquet")
    ap.add_argument("--fresh", action="store_true", help="rebuild the OOF pools")
    ap.add_argument(
        "--nat-source",
        default="country_code",
        choices=NAT_SOURCES,
        help="which nationality column the nat stage reads",
    )
    args = ap.parse_args()

    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]
    payload: dict = (
        json.loads(ARTIFACT_PATH.read_text()) if ARTIFACT_PATH.exists() else {}
    )

    if args.stage == "pools":
        df = load_dataset(args.cache)
        payload["pools"] = stage_pools(df, seeds, args.fresh)
    elif args.stage == "nat":
        df = load_dataset(args.cache)
        res = stage_nat(df, seeds, args.nat_source)
        payload.setdefault("nat", {})[args.nat_source] = res
        print_nat(res)
    elif args.stage == "subtemp":
        df = load_dataset(args.cache)
        payload["subtemp"] = stage_subtemp(df, seeds)
        print_subtemp(payload["subtemp"])
    elif args.stage == "debutcorr":
        df = load_dataset(args.cache)
        payload["debutcorr"] = stage_debutcorr(df, seeds)
        print_debutcorr(payload["debutcorr"])
    elif args.stage == "debutlv":
        df = load_dataset(args.cache)
        payload["debutlv"] = stage_debutlv(df, seeds)
        print_debutlv(payload["debutlv"])
    elif args.stage == "debutmethod":
        df = load_dataset(args.cache)
        payload["debutmethod"] = stage_debutmethod(df, seeds)
        print_debutmethod(payload["debutmethod"])
    elif args.stage == "power":
        payload["power"] = stage_power(seeds)
        print(json.dumps(payload["power"], indent=1, default=str))
    elif args.stage == "calib":
        payload["calib"] = stage_calib(seeds)
        print_calib(payload["calib"])
    else:
        raise SystemExit(f"stage {args.stage!r} is not implemented yet")

    ARTIFACT_PATH.write_text(json.dumps(payload, indent=1, default=str))
    print(f"\nwrote {ARTIFACT_PATH}")


if __name__ == "__main__":
    main()

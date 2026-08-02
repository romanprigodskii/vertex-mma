"""Method-leg lab — is the conditional method mix the addressable half?

The fixed-odds book prices three legs off two sources. The WINNER leg comes
from the 118-feature ensemble; the METHOD and ROUND legs come from
`monte_carlo.simulate_bout`, a generative simulator whose entire per-fight
input is the ten hand-shrunk fields of `FighterMC` plus three context flags.
Six labs have now confirmed the winner leg is at its information ceiling
(`docs/regional_regime.md`). The method leg has never been attacked directly:
the round lab re-fitted the simulator's INTERNALS (timing hazards, decision
split) but left the ten-field bottleneck in place.

This lab asks whether the bottleneck — not the information — is what costs the
method leg its 0.10 nats against the closing line.

Every 6-cell distribution factorises exactly:

    LL(6-cell) = LL(winner side) + LL(method | winner side)

so the deficit splits into a half the winner ensemble owns and a half the
simulator owns, and the two are separately measurable against the devigged
method book on identical bouts. Stage 0 does that split. Nothing is fitted in
Stage 0 — it decides whether the rest of the lab is worth building.

Gates (each must pass before the next stage is built):

  GATE 0  a discriminative P(ko/sub/dec | winner, X) model, trained strictly
          before TRAIN_END, must beat BOTH the production Monte Carlo mix AND
          the constant base rates on the VAL window. Kill test: if the
          simulator is already extracting what record+stat features hold, a
          direct fit cannot help and the lab stops here.
  GATE 1  on the held-out TEST window the new mix, reconciled to the same
          ensemble winner level production uses, must beat the production
          6-cell log-loss — seed-stably, and with a label-shuffle control.
  GATE 2  marginal calibration and per-cell reliability must not degrade.

Usage (from scripts/simulation, venv active):
  python scripts/lab_method_leg.py --stage decompose
  python scripts/lab_method_leg.py --stage gate0
  python scripts/lab_method_leg.py --stage gate1
  python scripts/lab_method_leg.py --stage all
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import src.monte_carlo as _mc  # noqa: E402
from src.config import ARTIFACTS_DIR, DATA_DIR, TRAIN_END, VAL_END  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.ensemble import EnsembleModel  # noqa: E402
from src.export import (  # noqa: E402
    build_dataset,
    fetch_raw,
    stable_hash,
    swap_sides,
    symmetrize_for_training,
)
from src.features import build_feature_matrix  # noqa: E402
from src.monte_carlo import FighterMC, simulate_bout  # noqa: E402

REPORT_PATH = ARTIFACTS_DIR / "lab_method_leg.json"
DATASET_CACHE = DATA_DIR / "method_lab_dataset.parquet"
MC_CACHE = DATA_DIR / "method_lab_mc.parquet"

_EVAL_DIR = ARTIFACTS_DIR / "ensemble_eval"
ENSEMBLE_DIR = _EVAL_DIR if _EVAL_DIR.exists() else ARTIFACTS_DIR / "ensemble"
_HAZARD_EVAL_PATH = ARTIFACTS_DIR / "finish_hazard_eval.json"
_DECISION_EVAL_PATH = ARTIFACTS_DIR / "decision_winner_eval.json"

MAX_MARKET_EDGE = 0.15  # keep in sync with src/lib/sportsbook.ts
METHODS = ("ko", "sub", "dec")
CELLS = ["a_ko", "a_sub", "a_dec", "b_ko", "b_sub", "b_dec"]
EPS = 1e-12

# Outcome + closing method book per bout. Mirrors eval_method_market.ODDS_SQL,
# plus the finishing round/clock the round leg needs later.
OUTCOME_SQL = """
SELECT
  b.id::text,
  b.fighter_a_id::text,
  b.winner_id::text,
  b.method::text,
  b.round_finished,
  b.time_finished_seconds,
  beo.method_a_kotko_decimal, beo.method_a_sub_decimal, beo.method_a_dec_decimal,
  beo.method_b_kotko_decimal, beo.method_b_sub_decimal, beo.method_b_dec_decimal
FROM bout b
LEFT JOIN LATERAL (
  SELECT *
  FROM bout_external_odds beo
  WHERE beo.bout_id = b.id
  ORDER BY (beo.source = 'bestfightodds') DESC, beo.fetched_at DESC
  LIMIT 1
) beo ON TRUE
WHERE b.id = ANY(%s::uuid[])
"""


def method_bucket(method: str | None) -> str | None:
    """Mirror of sportsbook.ts methodBucket for the buckets we grade."""
    if method is None:
        return None
    if method in ("ko", "tko"):
        return "ko"
    if method == "submission":
        return "sub"
    if method.startswith("decision"):
        return "dec"
    return method  # draw / no_contest / dq — handled by the caller


# ── data prep ──────────────────────────────────────────────────────────


def load_dataset(*, cache: bool = True) -> pd.DataFrame:
    """`build_dataset` output, symmetrized exactly like training, with the
    outcome label and the closing method book joined on.

    Symmetrizing FIRST and joining the book SECOND matters: `symmetrize_for_
    training` flips ~50 % of bouts A↔B, so the book's a-side cells have to be
    flipped with them. The join reads `fighter_a_id` off the (possibly
    flipped) frame and compares it to the DB's own a-side to decide."""
    if cache and DATASET_CACHE.exists():
        return pd.read_parquet(DATASET_CACHE)

    df = symmetrize_for_training(build_dataset(fetch_raw()))
    bout_ids = df["bout_id"].tolist()
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(OUTCOME_SQL, (bout_ids,))
        rows = {r[0]: r for r in cur.fetchall()}

    winner_side: list[str | None] = []
    bucket: list[str | None] = []
    round_finished: list[float] = []
    finish_seconds: list[float] = []
    book: dict[str, list[float | None]] = {c: [] for c in CELLS}
    for bid, fa, fb in zip(
        df["bout_id"], df["fighter_a_id"], df["fighter_b_id"], strict=True
    ):
        r = rows.get(bid)
        if r is None:
            winner_side.append(None)
            bucket.append(None)
            round_finished.append(np.nan)
            finish_seconds.append(np.nan)
            for c in CELLS:
                book[c].append(None)
            continue
        (_, db_fa, db_winner, db_method, rf, tfs, a_ko, a_sub, a_dec, b_ko, b_sub, b_dec) = r
        flipped = db_fa != fa
        cells = (
            {"a_ko": b_ko, "a_sub": b_sub, "a_dec": b_dec,
             "b_ko": a_ko, "b_sub": a_sub, "b_dec": a_dec}
            if flipped
            else {"a_ko": a_ko, "a_sub": a_sub, "a_dec": a_dec,
                  "b_ko": b_ko, "b_sub": b_sub, "b_dec": b_dec}
        )
        for c in CELLS:
            v = cells[c]
            book[c].append(float(v) if v is not None else None)
        if db_winner == fa:
            winner_side.append("a")
        elif db_winner == fb:
            winner_side.append("b")
        else:
            winner_side.append(None)
        bucket.append(method_bucket(db_method))
        round_finished.append(float(rf) if rf is not None else np.nan)
        finish_seconds.append(float(tfs) if tfs is not None else np.nan)

    df = df.copy()
    df["winner_side"] = winner_side
    df["method_bucket"] = bucket
    df["round_finished"] = round_finished
    df["finish_seconds"] = finish_seconds
    for c in CELLS:
        df[f"book_{c}"] = book[c]

    DATASET_CACHE.parent.mkdir(exist_ok=True)
    df.to_parquet(DATASET_CACHE, index=False)
    return df


def split_masks(df: pd.DataFrame) -> dict[str, np.ndarray]:
    d = pd.to_datetime(df["event_date"])
    return {
        "train": (d < pd.Timestamp(TRAIN_END)).to_numpy(),
        "val": ((d >= pd.Timestamp(TRAIN_END)) & (d < pd.Timestamp(VAL_END))).to_numpy(),
        "test": (d >= pd.Timestamp(VAL_END)).to_numpy(),
    }


def gradeable_mask(df: pd.DataFrame) -> np.ndarray:
    """Bouts whose outcome lands in the 6-cell space: a winner side and a
    ko/sub/dec bucket. DQ, missing method and draws/NC drop out — the same
    rows settlement voids."""
    return (
        df["winner_side"].isin(("a", "b")).to_numpy()
        & df["method_bucket"].isin(METHODS).to_numpy()
    )


def book_probs(df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(devigged 6-cell market matrix, coherent-book mask). Devigging is
    proportional-to-inverse-odds across all six cells. The coherence guard is
    eval_method_market.py's: a real 6-cell book carries overround, so the
    implied sum must sit in [1.0, 1.6]; anything else is scrape corruption."""
    raw = np.column_stack([df[f"book_{c}"].to_numpy(dtype=float) for c in CELLS])
    with np.errstate(divide="ignore", invalid="ignore"):
        inv = 1.0 / raw
    ok = np.isfinite(raw).all(axis=1) & (raw > 1.0).all(axis=1)
    s = np.where(ok, inv.sum(axis=1), np.nan)
    coherent = ok & (s >= 1.0) & (s <= 1.6)
    probs = np.full_like(inv, np.nan)
    probs[coherent] = inv[coherent] / s[coherent, None]
    return probs, coherent


# ── Monte Carlo (production path) ──────────────────────────────────────


def load_split_trained_mc() -> None:
    """Point the simulator at the SPLIT-trained hazard / decision twins, so
    every moving part of the production baseline is out-of-sample on the test
    window rather than just the ensemble weights."""
    for label, path, loader in (
        ("finish timing", _HAZARD_EVAL_PATH, _mc.load_hazard_model),
        ("decision winner", _DECISION_EVAL_PATH, _mc.load_decision_model),
    ):
        if path.exists():
            loader(path)
            print(f"  {label}: split-trained {path.name}")
        else:
            print(f"  {label}: legacy hand-set constants (no artifact)")


def mc_cells(df: pd.DataFrame, mask: np.ndarray, *, cache: bool = True) -> pd.DataFrame:
    """Production Monte Carlo cells for the masked bouts, indexed by bout_id.
    Deterministic (seed = stable_hash(bout_id)), so the cache is exact."""
    want = set(df.loc[mask, "bout_id"])
    if cache and MC_CACHE.exists():
        cached = pd.read_parquet(MC_CACHE)
        if want <= set(cached["bout_id"]):
            return cached[cached["bout_id"].isin(want)].set_index("bout_id")
    else:
        cached = None

    sub = df.loc[mask].reset_index(drop=True)
    print(f"  running Monte Carlo on {len(sub)} bouts…")
    out = []
    for i in range(len(sub)):
        row = sub.iloc[i]
        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        mc = simulate_bout(
            FighterMC.from_snapshot(snap_a),
            FighterMC.from_snapshot(snap_b),
            int(row["scheduled_rounds"]),
            seed=stable_hash(row["bout_id"]),
            is_main_event=bool(row["is_main_event"]),
            is_title_fight=bool(row["is_title_fight"]),
        )
        out.append(
            {
                "bout_id": row["bout_id"],
                "a_ko": mc.prob_ko_a, "a_sub": mc.prob_sub_a, "a_dec": mc.prob_decision_a,
                "b_ko": mc.prob_ko_b, "b_sub": mc.prob_sub_b, "b_dec": mc.prob_decision_b,
                "avg_finish_seconds": mc.avg_finish_seconds,
                **{f"fr_{r}": mc.prob_finish_per_round.get(r, 0.0) for r in range(1, 6)},
            }
        )
    fresh = pd.DataFrame(out)
    merged = (
        pd.concat([cached[~cached["bout_id"].isin(fresh["bout_id"])], fresh])
        if cached is not None
        else fresh
    )
    merged.to_parquet(MC_CACHE, index=False)
    return merged[merged["bout_id"].isin(want)].set_index("bout_id")


# ── winner level (production path) ─────────────────────────────────────


def ensemble_prob_a(df: pd.DataFrame) -> np.ndarray:
    """Order-averaged ensemble P(A wins), exactly like predict.py."""
    ens = EnsembleModel.load(ENSEMBLE_DIR)
    X, _, _ = build_feature_matrix(df)
    X_sw, _, _ = build_feature_matrix(swap_sides(df))
    p_raw = ens.predict_proba_a(X[ens.feature_columns])
    p_sw = ens.predict_proba_a(X_sw[ens.feature_columns])
    return 0.5 * (p_raw + (1.0 - p_sw))


def apply_edge_guard(model_prob_a: np.ndarray, market_prob_a: np.ndarray) -> np.ndarray:
    lo = market_prob_a - MAX_MARKET_EDGE
    hi = market_prob_a + MAX_MARKET_EDGE
    guarded = np.where(
        np.isfinite(market_prob_a),
        np.clip(model_prob_a, lo, hi),
        model_prob_a,
    )
    return np.clip(guarded, 1e-6, 1 - 1e-6)


# ── metrics ────────────────────────────────────────────────────────────


def conditional_mix(cells: np.ndarray) -> np.ndarray:
    """(n, 6) cells → (n, 2, 3) per-side conditional mix P(method | that side
    wins). Rows whose side total is non-positive fall back to uniform."""
    n = cells.shape[0]
    out = np.full((n, 2, 3), 1.0 / 3.0)
    for s in range(2):
        side = cells[:, 3 * s : 3 * s + 3]
        tot = side.sum(axis=1)
        ok = tot > 0
        out[ok, s] = side[ok] / tot[ok, None]
    return out


def leg_losses(
    cells: np.ndarray, winner_side: np.ndarray, bucket: np.ndarray
) -> dict[str, float]:
    """Exact decomposition LL(6-cell) = LL(winner) + LL(method | winner).

    `cells` is (n, 6) in CELLS order and must sum to 1 per row."""
    side_idx = np.where(winner_side == "a", 0, 1)
    meth_idx = np.array([METHODS.index(b) for b in bucket])
    cell_idx = side_idx * 3 + meth_idx
    rows = np.arange(len(cells))

    p_cell = np.clip(cells[rows, cell_idx], EPS, 1.0)
    side_tot = np.clip(
        cells[:, :3].sum(axis=1) * (side_idx == 0) + cells[:, 3:].sum(axis=1) * (side_idx == 1),
        EPS,
        1.0,
    )
    p_cond = np.clip(p_cell / side_tot, EPS, 1.0)

    onehot = np.zeros_like(cells)
    onehot[rows, cell_idx] = 1.0
    return {
        "n": int(len(cells)),
        "ll_6cell": float(-np.log(p_cell).mean()),
        "ll_winner": float(-np.log(side_tot).mean()),
        "ll_cond": float(-np.log(p_cond).mean()),
        "brier_6cell": float(((cells - onehot) ** 2).sum(axis=1).mean()),
    }


def cond_ll_from_mix(
    mix: np.ndarray, winner_side: np.ndarray, bucket: np.ndarray
) -> float:
    """Conditional log-loss from a (n, 2, 3) per-side mix."""
    side_idx = np.where(winner_side == "a", 0, 1)
    meth_idx = np.array([METHODS.index(b) for b in bucket])
    rows = np.arange(len(mix))
    return float(-np.log(np.clip(mix[rows, side_idx, meth_idx], EPS, 1.0)).mean())


def reconcile(mix: np.ndarray, prob_a: np.ndarray) -> np.ndarray:
    """(n, 2, 3) conditional mix + P(A) → (n, 6) cells, mirroring
    sportsbook.ts reconcileMethodProbs: the mix sets the RATIO, the ensemble
    sets the LEVEL."""
    level = np.column_stack([prob_a, 1.0 - prob_a])
    return (mix * level[:, :, None]).reshape(len(mix), 6)


def _fmt(d: dict[str, float]) -> str:
    return (
        f"n={d['n']:4d}  6-cell {d['ll_6cell']:.4f}  "
        f"= winner {d['ll_winner']:.4f} + cond {d['ll_cond']:.4f}   "
        f"brier {d['brier_6cell']:.4f}"
    )


# ── Stage 0 — decomposition ────────────────────────────────────────────


def stage_decompose(df: pd.DataFrame, *, cache: bool) -> dict:
    masks = split_masks(df)
    grade = gradeable_mask(df)
    market, coherent = book_probs(df)

    print("\nloading production Monte Carlo artifacts:")
    load_split_trained_mc()

    report: dict = {"window": {}, "base_rates": {}}

    for split in ("val", "test"):
        sel = masks[split] & grade & coherent
        sub = df.loc[sel].reset_index(drop=True)
        mkt = market[sel]
        winner_side = sub["winner_side"].to_numpy()
        bucket = sub["method_bucket"].to_numpy()

        print(f"\n=== {split.upper()} window (>= {TRAIN_END if split == 'val' else VAL_END}), "
              f"n={len(sub)} gradeable bouts with a coherent 6-cell book ===")

        cells = mc_cells(df, sel, cache=cache)
        cells = cells.loc[sub["bout_id"]]
        mc = cells[CELLS].to_numpy(dtype=float)

        prob_a = ensemble_prob_a(sub)
        market_prob_a = mkt[:, :3].sum(axis=1)
        guarded_a = apply_edge_guard(prob_a, market_prob_a)

        mix_mc = conditional_mix(mc)
        model_pure = reconcile(mix_mc, prob_a)
        model_guard = reconcile(mix_mc, guarded_a)

        # Base-rate mix: the same constant (31/18/51) for both sides.
        base = np.array([_mc.METHOD_BASE_KO, _mc.METHOD_BASE_SUB, _mc.METHOD_BASE_DEC])
        base = base / base.sum()
        mix_base = np.tile(base, (len(sub), 2, 1))

        # Empirical base rate measured on TRAIN only — the honest constant.
        tr = masks["train"] & grade
        tr_bucket = df.loc[tr, "method_bucket"].to_numpy()
        emp = np.array([(tr_bucket == m).mean() for m in METHODS])
        mix_emp = np.tile(emp, (len(sub), 2, 1))

        rows = {
            "model_pure": leg_losses(model_pure, winner_side, bucket),
            "model_guarded": leg_losses(model_guard, winner_side, bucket),
            "market": leg_losses(mkt, winner_side, bucket),
            "base_rate_mix_on_model_level": leg_losses(
                reconcile(mix_base, prob_a), winner_side, bucket
            ),
            "market_mix_on_model_level": leg_losses(
                reconcile(conditional_mix(mkt), prob_a), winner_side, bucket
            ),
            "model_mix_on_market_level": leg_losses(
                reconcile(mix_mc, market_prob_a), winner_side, bucket
            ),
        }
        for label, d in rows.items():
            print(f"  {label:32s} {_fmt(d)}")

        cond = {
            "mc_production": cond_ll_from_mix(mix_mc, winner_side, bucket),
            "market": cond_ll_from_mix(conditional_mix(mkt), winner_side, bucket),
            "constant_module_base": cond_ll_from_mix(mix_base, winner_side, bucket),
            "constant_train_empirical": cond_ll_from_mix(mix_emp, winner_side, bucket),
        }
        print("\n  conditional-mix log-loss (method | actual winner):")
        for label, v in sorted(cond.items(), key=lambda kv: kv[1]):
            print(f"    {label:28s} {v:.4f}")

        # Where the conditional loss sits, by the method that actually landed.
        per_method = {}
        for m in METHODS:
            m_sel = bucket == m
            if not m_sel.any():
                continue
            per_method[m] = {
                "n": int(m_sel.sum()),
                "mc": cond_ll_from_mix(
                    mix_mc[m_sel], winner_side[m_sel], bucket[m_sel]
                ),
                "market": cond_ll_from_mix(
                    conditional_mix(mkt)[m_sel], winner_side[m_sel], bucket[m_sel]
                ),
                "mc_mean_prob": float(
                    mix_mc[
                        np.arange(len(mix_mc)),
                        np.where(winner_side == "a", 0, 1),
                        METHODS.index(m),
                    ][m_sel].mean()
                ),
                "market_mean_prob": float(
                    conditional_mix(mkt)[
                        np.arange(len(mkt)),
                        np.where(winner_side == "a", 0, 1),
                        METHODS.index(m),
                    ][m_sel].mean()
                ),
            }
        print("\n  conditional loss by the method that actually landed:")
        print(f"    {'method':>6} {'n':>4} {'mc ll':>8} {'mkt ll':>8} {'mc p':>7} {'mkt p':>7}")
        for m, d in per_method.items():
            print(
                f"    {m:>6} {d['n']:4d} {d['mc']:8.4f} {d['market']:8.4f} "
                f"{d['mc_mean_prob']:7.3f} {d['market_mean_prob']:7.3f}"
            )

        report["window"][split] = {"legs": rows, "conditional": cond, "per_method": per_method}

    tr = masks["train"] & grade
    tr_bucket = df.loc[tr, "method_bucket"].to_numpy()
    report["base_rates"] = {
        "train_empirical": {m: float((tr_bucket == m).mean()) for m in METHODS},
        "module_constants": {
            "ko": _mc.METHOD_BASE_KO, "sub": _mc.METHOD_BASE_SUB, "dec": _mc.METHOD_BASE_DEC
        },
        "n_train_gradeable": int(tr.sum()),
    }
    return report


# ── entrypoint ─────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stage", default="decompose",
                    choices=["decompose", "gate0", "gate1", "all"])
    ap.add_argument("--no-cache", action="store_true",
                    help="rebuild the dataset and Monte Carlo caches from the DB")
    args = ap.parse_args()
    cache = not args.no_cache

    print("loading dataset…")
    df = load_dataset(cache=cache)
    grade = gradeable_mask(df)
    print(
        f"  {len(df):,} bouts · {int(grade.sum()):,} land in the 6-cell space "
        f"({int((~grade).sum())} dq / missing-method / no-row)"
    )

    report: dict = {}
    if args.stage in ("decompose", "all"):
        report["decompose"] = stage_decompose(df, cache=cache)

    existing = json.loads(REPORT_PATH.read_text()) if REPORT_PATH.exists() else {}
    existing.update(report)
    REPORT_PATH.write_text(json.dumps(existing, indent=2))
    print(f"\nwrote {REPORT_PATH.relative_to(PACKAGE_ROOT)}")


if __name__ == "__main__":
    main()

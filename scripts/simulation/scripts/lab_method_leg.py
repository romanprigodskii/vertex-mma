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
  GATE 2  marginal calibration and per-cell reliability must not degrade —
          and if they do, no correction ships unless VAL selects it by a
          margin bigger than val noise.

Stage 3 then measures every leg `sportsbook.ts` actually offers, because
three of the four are priced off the same reconciled distribution and a mix
change moves them whether or not anyone looks.

Results: docs/method_leg.md. Report: artifacts/lab_method_leg.json.

Usage (from scripts/simulation, venv active):
  python scripts/lab_method_leg.py --stage decompose
  python scripts/lab_method_leg.py --stage gate0
  python scripts/lab_method_leg.py --stage gate1
  python scripts/lab_method_leg.py --stage gate2
  python scripts/lab_method_leg.py --stage legs
  python scripts/lab_method_leg.py --stage all
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

import lightgbm as lgb  # noqa: E402
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
from src.features import build_feature_matrix, serving_columns  # noqa: E402
from src.method_model import (  # noqa: E402
    LGB_MULTI_PARAMS,
    MethodModel,
    _multiclass_logloss,
    build_method_features,
)
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


def orient_winner_first(df: pd.DataFrame) -> pd.DataFrame:
    """Flip every bout the B side won, so slot A is always the winner.

    `swap_sides` handles the `*_a`/`*_b` schema and `market_prob_a`; the four
    columns this lab added afterwards (`winner_side`, the six book cells) are
    not `_a`/`_b` pairs, so they are mirrored by hand here — the same trap
    `symmetrize_for_training` documents for `dominance_a`. Getting it wrong
    would not announce itself: the label would lock onto the winner slot and
    the backtest would look brilliant with nothing behind it.

    Row order and index are preserved, so row i of the result is still bout i
    of the input."""
    b_wins = (df["winner_side"].to_numpy() == "b")
    if not b_wins.any():
        return df.copy()
    kept = df.loc[~b_wins].copy()
    flipped = swap_sides(df.loc[b_wins])
    flipped["winner_side"] = "a"
    for m in METHODS:
        a_col, b_col = f"book_a_{m}", f"book_b_{m}"
        a_vals = df.loc[b_wins, a_col].to_numpy()
        flipped[a_col] = df.loc[b_wins, b_col].to_numpy()
        flipped[b_col] = a_vals
    if "target_a_wins" in flipped.columns:
        flipped["target_a_wins"] = 1 - df.loc[b_wins, "target_a_wins"].to_numpy()
    return pd.concat([kept, flipped]).sort_index()


def method_index(bucket: np.ndarray) -> np.ndarray:
    return np.array([METHODS.index(b) for b in bucket], dtype=int)


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
    X, _, _ = build_feature_matrix(df, corrector=True)
    X_sw, _, _ = build_feature_matrix(swap_sides(df), corrector=True)
    p_raw = ens.predict_proba_a(X[serving_columns(ens.feature_columns)])
    p_sw = ens.predict_proba_a(X_sw[serving_columns(ens.feature_columns)])
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


# ── GATE 0 — can a direct fit beat the simulator's mix? ────────────────

GATE0_MARGIN = 0.02  # nats the fit must take off the MC mix on val, per seed
SEEDS = (42, 7, 13)

# Margin a post-hoc correction must clear on val before it is allowed to
# ship. 428 val bouts put roughly 0.005 nats of noise on a conditional
# log-loss, so anything smaller is a coin landing the right way up — and a
# correction is exactly the kind of change that will find that coin.
VAL_SELECT_MARGIN = 0.005


def _fit_variant(
    X: pd.DataFrame,
    y: np.ndarray,
    tr: np.ndarray,
    va: np.ndarray,
    *,
    seed: int,
    sample_weight: np.ndarray | None = None,
) -> tuple[MethodModel, np.ndarray]:
    m = MethodModel().fit(
        X.loc[tr].reset_index(drop=True),
        y[tr],
        X.loc[va].reset_index(drop=True),
        y[va],
        seed=seed,
        sample_weight=None if sample_weight is None else sample_weight[tr],
    )
    return m, m.predict_cond(X.loc[va].reset_index(drop=True))


def stage_gate0(df: pd.DataFrame, *, cache: bool) -> dict:
    masks = split_masks(df)
    grade = gradeable_mask(df)

    print("\nloading production Monte Carlo artifacts:")
    load_split_trained_mc()

    tr_mask = masks["train"] & grade
    va_mask = masks["val"] & grade
    sel = tr_mask | va_mask
    sub = df.loc[sel].reset_index(drop=True)
    oriented = orient_winner_first(sub)
    y = method_index(sub["method_bucket"].to_numpy())

    tr = tr_mask[sel]
    va = va_mask[sel]
    print(f"\n=== GATE 0 — train n={int(tr.sum())} (< {TRAIN_END}) · "
          f"val n={int(va.sum())} ([{TRAIN_END}, {VAL_END})) ===")

    base_X, _, _ = build_feature_matrix(oriented)
    variants = {
        "diffs_only": build_method_features(base_X, oriented, levels=False),
        "with_levels": build_method_features(base_X, oriented, levels=True),
    }

    # Reference points on the identical val rows.
    cells = mc_cells(df, va_mask, cache=cache)
    va_ids = sub.loc[va, "bout_id"]
    mc = cells.loc[va_ids][CELLS].to_numpy(dtype=float)
    winner_side_va = sub.loc[va, "winner_side"].to_numpy()
    bucket_va = sub.loc[va, "method_bucket"].to_numpy()
    mix_mc = conditional_mix(mc)
    ll_mc = cond_ll_from_mix(mix_mc, winner_side_va, bucket_va)

    tr_bucket = sub.loc[tr, "method_bucket"].to_numpy()
    emp = np.array([(tr_bucket == m).mean() for m in METHODS])
    ll_const = float(
        -np.log(np.clip(np.tile(emp, (int(va.sum()), 1))[np.arange(int(va.sum())), y[va]], EPS, 1))
        .mean()
    )

    print(f"  reference — MC production mix   {ll_mc:.4f}")
    print(f"  reference — constant base rates {ll_const:.4f}  ({dict(zip(METHODS, emp.round(4), strict=True))})")
    print(f"  gate: beat the MC mix by >= {GATE0_MARGIN:.2f} nats on every seed\n")

    results: dict[str, Any] = {}
    for name, X in variants.items():
        per_seed = []
        for seed in SEEDS:
            model, p_va = _fit_variant(X, y, tr, va, seed=seed)
            ll = _multiclass_logloss(y[va], p_va)
            per_seed.append(
                {"seed": seed, "val_logloss": ll, "solo": model.val_metrics["solo_logloss"],
                 "weights": model.weights, "best_iters": model.best_iters}
            )
            print(
                f"  {name:12s} seed {seed:2d}  val {ll:.4f}  "
                f"(lgb {model.val_metrics['solo_logloss'].get('lgb', float('nan')):.4f} · "
                f"cb {model.val_metrics['solo_logloss'].get('cb', float('nan')):.4f} · "
                f"lr {model.val_metrics['solo_logloss'].get('logreg', float('nan')):.4f})  "
                f"w={ {k: round(v, 2) for k, v in model.weights.items()} }"
            )
        lls = [r["val_logloss"] for r in per_seed]
        results[name] = {
            "per_seed": per_seed,
            "median_val_logloss": float(np.median(lls)),
            "worst_val_logloss": float(np.max(lls)),
            "n_features": int(X.shape[1]),
            "beats_mc_every_seed": bool(all(ll_mc - ll >= GATE0_MARGIN for ll in lls)),
            "beats_constant_every_seed": bool(all(ll < ll_const for ll in lls)),
        }
        print(
            f"  {name:12s} median {results[name]['median_val_logloss']:.4f} · "
            f"worst {results[name]['worst_val_logloss']:.4f} · "
            f"{X.shape[1]} features · gate "
            f"{'PASS' if results[name]['beats_mc_every_seed'] else 'FAIL'}\n"
        )

    # Where the gain comes from. A 0.18-nat jump over the simulator is large
    # enough that "it must be a leak" is the right first reaction, so the two
    # ablations that would localise one are run here rather than left to a
    # reader: a context-only fit (no fighter stats at all — just the four
    # bout facts the simulator structurally cannot see, plus the weight-class
    # and gender one-hots) and a fit on RANDOM rather than winner-first
    # orientation (which removes the conditioning and leaves only bout-level
    # method information).
    best_name = min(results, key=lambda k: results[k]["median_val_logloss"])
    X_best = variants[best_name]
    ctx_cols = [
        c for c in X_best.columns
        if c.startswith("wc_")
        or c in ("is_womens", "scheduled_rounds", "is_title_fight", "is_main_event")
    ]
    _, p_ctx = _fit_variant(X_best[ctx_cols], y, tr, va, seed=42)
    ll_ctx = _multiclass_logloss(y[va], p_ctx)

    rng_or = np.random.default_rng(0)
    flip = rng_or.random(len(sub)) < 0.5
    mixed = sub.copy()
    mixed.loc[flip] = swap_sides(sub.loc[flip])
    bx_mixed, _, _ = build_feature_matrix(mixed)
    X_mixed = build_method_features(bx_mixed, mixed, levels=(best_name == "with_levels"))
    _, p_mixed = _fit_variant(X_mixed, y, tr, va, seed=42)
    ll_mixed = _multiclass_logloss(y[va], p_mixed)

    print("\n  where the gain comes from (val log-loss, seed 42):")
    print(f"    constant base rates                      {ll_const:.4f}")
    print(f"    MC production mix                        {ll_mc:.4f}")
    print(f"    context only ({len(ctx_cols)} cols, no fighter stats)  {ll_ctx:.4f}")
    print(f"    random orientation (no conditioning)     {ll_mixed:.4f}")
    print(f"    full, winner-first                       {results[best_name]['per_seed'][0]['val_logloss']:.4f}")

    provenance = {
        "constant": ll_const,
        "mc_production": ll_mc,
        "context_only": ll_ctx,
        "context_columns": ctx_cols,
        "random_orientation": ll_mixed,
        "full_winner_first": results[best_name]["per_seed"][0]["val_logloss"],
    }

    # Falsification: shuffle the method labels inside train only. A model that
    # is reading real signal collapses to roughly the constant predictor; one
    # that is reading a leak or a slot artefact does not.
    rng = np.random.default_rng(42)
    y_shuf = y.copy()
    y_shuf[tr] = rng.permutation(y_shuf[tr])
    _, p_shuf = _fit_variant(variants[best_name], y_shuf, tr, va, seed=42)
    ll_shuf = _multiclass_logloss(y[va], p_shuf)
    print(f"  falsification — train labels shuffled: val {ll_shuf:.4f} "
          f"(constant {ll_const:.4f}; a real fit must NOT beat the constant here)")

    passed = results[best_name]["beats_mc_every_seed"] and results[best_name][
        "beats_constant_every_seed"
    ]
    print(f"\n  GATE 0: {'PASS' if passed else 'FAIL'} — best variant '{best_name}' "
          f"{results[best_name]['median_val_logloss']:.4f} vs MC {ll_mc:.4f}")

    return {
        "n_train": int(tr.sum()),
        "n_val": int(va.sum()),
        "reference": {
            "mc_production_mix": ll_mc,
            "constant_train_empirical": ll_const,
            "train_base_rates": dict(zip(METHODS, [float(x) for x in emp], strict=True)),
        },
        "variants": results,
        "provenance": provenance,
        "falsification_shuffled_labels": {
            "variant": best_name, "val_logloss": ll_shuf, "constant": ll_const,
            "clean": bool(ll_shuf >= ll_const - 0.005),
        },
        "best_variant": best_name,
        "gate_margin": GATE0_MARGIN,
        "passed": bool(passed),
    }


# ── GATE 1 — held-out test window ──────────────────────────────────────


def model_mix(model: MethodModel, frame: pd.DataFrame, *, levels: bool) -> np.ndarray:
    """(n, 2, 3) conditional mix from the discriminative model, called once
    per orientation: slot A's conditional from (A, B) and slot B's from
    (B, A). The two are independent estimates — there is no shared "decision
    logit" splitting one number between the sides, which is what the round
    lab found to be the simulator's failure mode."""
    out = np.empty((len(frame), 2, 3))
    for s, f in enumerate((frame, swap_sides(frame))):
        base, _, _ = build_feature_matrix(f)
        X = build_method_features(base, f, levels=levels)
        out[:, s, :] = model.predict_cond(X[model.feature_columns])
    return out


def _shrink_mix(mix: np.ndarray, lam: float, base: np.ndarray) -> np.ndarray:
    """Blend a conditional mix toward the base rates — the same operation
    `_anchor_methods` performs on the simulator's cells, applied to whatever
    mix is passed so the two are comparable at equal lambda."""
    if lam <= 0.0:
        return mix
    return (1.0 - lam) * mix + lam * base[None, None, :]


def _paired_bootstrap(
    loss_a: np.ndarray, loss_b: np.ndarray, *, n_boot: int = 4000, seed: int = 42
) -> dict[str, float]:
    """95 % CI for mean(loss_a) − mean(loss_b), resampled by bout."""
    rng = np.random.default_rng(seed)
    d = loss_a - loss_b
    idx = rng.integers(0, len(d), size=(n_boot, len(d)))
    means = d[idx].mean(axis=1)
    return {
        "delta": float(d.mean()),
        "lo95": float(np.quantile(means, 0.025)),
        "hi95": float(np.quantile(means, 0.975)),
        "frac_positive": float((means > 0).mean()),
    }


def _cellwise_loss(cells: np.ndarray, winner_side: np.ndarray, bucket: np.ndarray) -> np.ndarray:
    side_idx = np.where(winner_side == "a", 0, 1)
    meth_idx = method_index(bucket)
    return -np.log(np.clip(cells[np.arange(len(cells)), side_idx * 3 + meth_idx], EPS, 1.0))


def _settle(cell: str, winner_side: str, bucket: str) -> str:
    side, method = cell.split("_", 1)
    return "won" if (side == winner_side and method == bucket) else "lost"


def _roi(
    cells: np.ndarray, book: np.ndarray, winner_side, bucket, thr: float,
    *, n_boot: int = 4000, seed: int = 42,
) -> dict:
    """Flat 1u on every cell whose EV clears `thr`, graded against the closing
    method line. Mirrors eval_method_market.run_roi, including its bootstrap:
    resampling is BY BOUT, because up to six cells of the same bout are
    mutually exclusive and resampling bets independently would understate the
    variance badly enough to turn noise into a result."""
    per_bout_pnl = np.zeros(len(cells))
    per_bout_n = np.zeros(len(cells))
    won = 0
    for i in range(len(cells)):
        for j, c in enumerate(CELLS):
            odds = book[i, j]
            if not np.isfinite(odds) or odds <= 1.0:
                continue
            if cells[i, j] * odds - 1.0 <= thr:
                continue
            per_bout_n[i] += 1
            if _settle(c, winner_side[i], bucket[i]) == "won":
                per_bout_pnl[i] += odds - 1.0
                won += 1
            else:
                per_bout_pnl[i] -= 1.0

    n_bets = float(per_bout_n.sum())
    pnl = float(per_bout_pnl.sum())
    out = {
        "threshold": thr, "bets": int(n_bets), "won": won,
        "pnl": pnl, "roi": float(pnl / n_bets) if n_bets else 0.0,
    }
    if n_bets:
        rng = np.random.default_rng(seed)
        idx = rng.integers(0, len(cells), size=(n_boot, len(cells)))
        sums = per_bout_pnl[idx].sum(axis=1)
        counts = np.maximum(1.0, per_bout_n[idx].sum(axis=1))
        rois = sums / counts
        out["roi_lo95"] = float(np.quantile(rois, 0.025))
        out["roi_hi95"] = float(np.quantile(rois, 0.975))
        out["frac_profitable"] = float((rois > 0).mean())
    return out


def _best_variant(report: dict | None) -> bool:
    """`with_levels` or not, as GATE 0 selected it. Reads the in-memory report
    first: `--stage all` writes the JSON only once at the end, so consulting
    the file here would hand a later stage the PREVIOUS run's choice. That
    silently ran GATE 1 on the losing variant once already."""
    src = report if report and "gate0" in report else (
        json.loads(REPORT_PATH.read_text()) if REPORT_PATH.exists() else {}
    )
    return src.get("gate0", {}).get("best_variant", "diffs_only") == "with_levels"


def stage_gate1(df: pd.DataFrame, *, cache: bool, report: dict | None = None) -> dict:
    masks = split_masks(df)
    grade = gradeable_mask(df)
    levels = _best_variant(report)

    print("\nloading production Monte Carlo artifacts:")
    load_split_trained_mc()

    tr_mask = masks["train"] & grade
    va_mask = masks["val"] & grade
    te_mask = masks["test"] & grade

    fit_sel = tr_mask | va_mask
    fit_sub = df.loc[fit_sel].reset_index(drop=True)
    fit_oriented = orient_winner_first(fit_sub)
    y_fit = method_index(fit_sub["method_bucket"].to_numpy())
    base_fit, _, _ = build_feature_matrix(fit_oriented)
    X_fit = build_method_features(base_fit, fit_oriented, levels=levels)
    tr, va = tr_mask[fit_sel], va_mask[fit_sel]

    te = df.loc[te_mask].reset_index(drop=True)
    winner_side = te["winner_side"].to_numpy()
    bucket = te["method_bucket"].to_numpy()
    market, coherent_te = book_probs(te)
    book_odds = np.column_stack([te[f"book_{c}"].to_numpy(dtype=float) for c in CELLS])

    cells_mc = mc_cells(df, te_mask, cache=cache).loc[te["bout_id"]]
    mix_mc = conditional_mix(cells_mc[CELLS].to_numpy(dtype=float))
    prob_a = ensemble_prob_a(te)
    market_prob_a = np.where(coherent_te, market[:, :3].sum(axis=1), np.nan)
    guarded_a = apply_edge_guard(prob_a, market_prob_a)

    base_rates = np.array([_mc.METHOD_BASE_KO, _mc.METHOD_BASE_SUB, _mc.METHOD_BASE_DEC])
    base_rates = base_rates / base_rates.sum()

    print(f"\n=== GATE 1 — held-out test (>= {VAL_END}), n={len(te)} gradeable "
          f"({int(coherent_te.sum())} with a coherent 6-cell book) ===")

    per_seed: list[dict] = []
    mixes: list[np.ndarray] = []
    for seed in SEEDS:
        model = MethodModel().fit(
            X_fit.loc[tr].reset_index(drop=True), y_fit[tr],
            X_fit.loc[va].reset_index(drop=True), y_fit[va], seed=seed,
        )
        # Anchor sweep on VAL, using the same shrink the simulator applies.
        va_sub = fit_sub.loc[va].reset_index(drop=True)
        mix_va = model_mix(model, va_sub, levels=levels)
        lam_grid = np.arange(0.0, 0.61, 0.05)
        lam_ll = {
            float(lam): cond_ll_from_mix(
                _shrink_mix(mix_va, float(lam), base_rates),
                va_sub["winner_side"].to_numpy(), va_sub["method_bucket"].to_numpy(),
            )
            for lam in lam_grid
        }
        lam_star = min(lam_ll, key=lam_ll.get)

        mix_te = _shrink_mix(model_mix(model, te, levels=levels), lam_star, base_rates)
        mixes.append(mix_te)
        ll_cond = cond_ll_from_mix(mix_te, winner_side, bucket)
        per_seed.append({
            "seed": seed, "lambda_star": lam_star,
            "val_lambda_curve": {f"{k:.2f}": v for k, v in lam_ll.items()},
            "test_cond_logloss": ll_cond,
            "weights": model.weights, "best_iters": model.best_iters,
        })
        print(f"  seed {seed:2d}  lambda*={lam_star:.2f}  test conditional LL {ll_cond:.4f}")

    mix_model = np.mean(mixes, axis=0)  # seed-averaged, the served behaviour

    ll_cond_mc = cond_ll_from_mix(mix_mc, winner_side, bucket)
    ll_cond_new = cond_ll_from_mix(mix_model, winner_side, bucket)
    print(f"\n  conditional mix on ALL {len(te)} gradeable test bouts:")
    print(f"    MC production   {ll_cond_mc:.4f}")
    print(f"    discriminative  {ll_cond_new:.4f}   (seed-averaged)")

    # ── 6-cell, on the bouts that carry a coherent book ────────────────
    c = coherent_te
    sub_market = market[c]
    ws, bk = winner_side[c], bucket[c]
    variants = {
        "production_pure": reconcile(mix_mc[c], prob_a[c]),
        "production_guarded": reconcile(mix_mc[c], guarded_a[c]),
        "new_pure": reconcile(mix_model[c], prob_a[c]),
        "new_guarded": reconcile(mix_model[c], guarded_a[c]),
        "market": sub_market,
        "market_mix_on_our_level": reconcile(conditional_mix(sub_market), prob_a[c]),
    }
    legs = {k: leg_losses(v, ws, bk) for k, v in variants.items()}
    print(f"\n  6-cell log-loss (n={int(c.sum())}):")
    for k, d in legs.items():
        print(f"    {k:26s} {_fmt(d)}")

    boot = {
        "new_pure_vs_production_pure": _paired_bootstrap(
            _cellwise_loss(variants["production_pure"], ws, bk),
            _cellwise_loss(variants["new_pure"], ws, bk),
        ),
        "market_vs_new_guarded": _paired_bootstrap(
            _cellwise_loss(variants["new_guarded"], ws, bk),
            _cellwise_loss(sub_market, ws, bk),
        ),
    }
    print("\n  paired bootstrap by bout (4000 resamples):")
    b = boot["new_pure_vs_production_pure"]
    print(f"    production − new (pure):  {b['delta']:+.4f} nats  "
          f"[{b['lo95']:+.4f}, {b['hi95']:+.4f}]  P(improves) {b['frac_positive']:.3f}")
    b = boot["market_vs_new_guarded"]
    print(f"    new(guarded) − market:    {b['delta']:+.4f} nats  "
          f"[{b['lo95']:+.4f}, {b['hi95']:+.4f}]  (positive = still behind the book)")

    # ── Where the residual gap to the book lives ───────────────────────
    # Stage 0 ran this on the simulator and found the deficit was entirely
    # in the two finish cells. Re-running it on the shipped mix says whether
    # another lab has anywhere to go.
    mix_mkt = conditional_mix(sub_market)
    residual = {}
    print("\n  residual conditional loss vs the book, by the method that landed:")
    print(f"    {'method':>6} {'n':>4} {'new ll':>8} {'mkt ll':>8} {'gap':>8} "
          f"{'new p':>7} {'mkt p':>7} {'actual':>7}")
    for m in METHODS:
        m_sel = bk == m
        if not m_sel.any():
            continue
        ll_new = cond_ll_from_mix(mix_model[c][m_sel], ws[m_sel], bk[m_sel])
        ll_mkt = cond_ll_from_mix(mix_mkt[m_sel], ws[m_sel], bk[m_sel])
        j = METHODS.index(m)
        rows_all = np.arange(int(c.sum()))
        side_idx = np.where(ws == "a", 0, 1)
        p_new = float(mix_model[c][rows_all, side_idx, j][m_sel].mean())
        p_mkt = float(mix_mkt[rows_all, side_idx, j][m_sel].mean())
        residual[m] = {
            "n": int(m_sel.sum()), "new_ll": ll_new, "market_ll": ll_mkt,
            "gap": ll_new - ll_mkt, "new_mean_p": p_new, "market_mean_p": p_mkt,
            "share_of_total_gap": float(
                (ll_new - ll_mkt) * m_sel.sum() / int(c.sum())
            ),
        }
        print(f"    {m:>6} {int(m_sel.sum()):4d} {ll_new:8.4f} {ll_mkt:8.4f} "
              f"{ll_new - ll_mkt:+8.4f} {p_new:7.3f} {p_mkt:7.3f} "
              f"{float(m_sel.mean()):7.3f}")
    total_gap = sum(d["share_of_total_gap"] for d in residual.values())
    print(f"    {'total':>6} {int(c.sum()):4d} {'':8} {'':8} {total_gap:+8.4f}")

    # ── GATE 2 — calibration must not degrade ──────────────────────────
    print("\n  marginal method calibration (all gradeable test bouts):")
    print(f"    {'method':>6} {'actual':>8} {'mc':>8} {'new':>8}")
    marg = {}
    for j, m in enumerate(METHODS):
        actual = float((bucket == m).mean())
        p_mc = float((mix_mc[:, 0, j] * prob_a + mix_mc[:, 1, j] * (1 - prob_a)).mean())
        p_new = float((mix_model[:, 0, j] * prob_a + mix_model[:, 1, j] * (1 - prob_a)).mean())
        marg[m] = {"actual": actual, "mc": p_mc, "new": p_new}
        print(f"    {m:>6} {actual:8.3f} {p_mc:8.3f} {p_new:8.3f}")

    print("\n  per-cell reliability, new mix (pure), coherent-book bouts:")
    flat_p = variants["new_pure"].ravel()
    onehot = np.zeros_like(variants["new_pure"])
    onehot[np.arange(int(c.sum())), np.where(ws == "a", 0, 1) * 3 + method_index(bk)] = 1.0
    flat_y = onehot.ravel()
    bins = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.60, 1.0]
    reliability = []
    print(f"    {'bin':>11} {'n':>5} {'pred%':>7} {'actual%':>8}")
    for lo, hi in zip(bins[:-1], bins[1:], strict=True):
        s = (flat_p >= lo) & (flat_p < hi)
        if not s.any():
            continue
        reliability.append({
            "lo": lo, "hi": hi, "n": int(s.sum()),
            "pred": float(flat_p[s].mean()), "actual": float(flat_y[s].mean()),
        })
        print(f"    {lo:.2f}-{hi:.2f} {int(s.sum()):5d} "
              f"{flat_p[s].mean()*100:6.1f}% {flat_y[s].mean()*100:7.1f}%")

    # ── ROI against the closing method lines ───────────────────────────
    print("\n  ROI vs closing method lines (flat 1u, coherent-book bouts):")
    roi = {}
    for label, cells in (("production_guarded", variants["production_guarded"]),
                         ("new_guarded", variants["new_guarded"])):
        roi[label] = [_roi(cells, book_odds[c], ws, bk, t) for t in (0.0, 0.05, 0.10, 0.20)]
        print(f"    {label}:")
        for r in roi[label]:
            ci = (
                f"[{r.get('roi_lo95', float('nan'))*100:+.1f}%, "
                f"{r.get('roi_hi95', float('nan'))*100:+.1f}%]  "
                f"P(profitable) {r.get('frac_profitable', float('nan')):.3f}"
            )
            print(f"      EV>{r['threshold']:.2f}  bets {r['bets']:5d}  won {r['won']:4d}  "
                  f"ROI {r['roi']*100:+6.1f}%  {ci}")

    passed = (
        legs["new_pure"]["ll_6cell"] < legs["production_pure"]["ll_6cell"]
        and legs["new_guarded"]["ll_6cell"] < legs["production_guarded"]["ll_6cell"]
        and all(r["test_cond_logloss"] < ll_cond_mc for r in per_seed)
        and boot["new_pure_vs_production_pure"]["lo95"] > 0
    )
    print(f"\n  GATE 1: {'PASS' if passed else 'FAIL'}")

    return {
        "n_test_gradeable": int(len(te)),
        "n_coherent_book": int(c.sum()),
        "levels": levels,
        "per_seed": per_seed,
        "conditional_all_gradeable": {"mc_production": ll_cond_mc, "discriminative": ll_cond_new},
        "legs": legs,
        "bootstrap": boot,
        "residual_gap_by_method": residual,
        "marginal_calibration": marg,
        "reliability": reliability,
        "roi": roi,
        "passed": bool(passed),
    }


# ── GATE 2 — is the marginal regression a defect or drift? ─────────────


def _prior_correct(mix: np.ndarray, w: np.ndarray) -> np.ndarray:
    out = mix * w[None, None, :]
    return out / out.sum(axis=2, keepdims=True)


def stage_gate2(df: pd.DataFrame, *, cache: bool, report: dict | None = None) -> dict:
    """Removing the anchor hands back the marginal accuracy it was buying:
    the new mix predicts 15.6 % submissions against 18.4 % actual on test.
    This stage asks whether that is a model defect (fixable) or year-to-year
    base-rate drift (not forecastable), and tries the three corrections that
    would fix it if it were a defect."""
    masks = split_masks(df)
    grade = gradeable_mask(df)
    tr_m, va_m, te_m = masks["train"] & grade, masks["val"] & grade, masks["test"] & grade

    levels = _best_variant(report)
    fit_sel = tr_m | va_m
    fit_sub = df.loc[fit_sel].reset_index(drop=True)
    fit_or = orient_winner_first(fit_sub)
    y = method_index(fit_sub["method_bucket"].to_numpy())
    base_fit, _, _ = build_feature_matrix(fit_or)
    X = build_method_features(base_fit, fit_or, levels=levels)
    tr, va = tr_m[fit_sel], va_m[fit_sel]

    va_sub = fit_sub.loc[va].reset_index(drop=True)
    te = df.loc[te_m].reset_index(drop=True)
    ws_va, bk_va = va_sub["winner_side"].to_numpy(), va_sub["method_bucket"].to_numpy()
    ws_te, bk_te = te["winner_side"].to_numpy(), te["method_bucket"].to_numpy()

    def _ll(mix, ws, bk):
        return cond_ll_from_mix(mix, ws, bk)

    def _at_winner(mix, ws):
        return mix[np.arange(len(mix)), np.where(ws == "a", 0, 1), :]

    model, _ = _fit_variant(X, y, tr, va, seed=42)
    mix_va = model_mix(model, va_sub, levels=levels)
    mix_te = model_mix(model, te, levels=levels)
    ll_va, ll_te = _ll(mix_va, ws_va, bk_va), _ll(mix_te, ws_te, bk_te)

    p_tr = model.predict_cond(X.loc[tr].reset_index(drop=True))
    tr_rate = np.array([(y[tr] == j).mean() for j in range(3)])
    va_rate = np.array([(y[va] == j).mean() for j in range(3)])
    te_rate = np.array([(bk_te == m).mean() for m in METHODS])

    print("\n=== GATE 2 — marginal calibration ===")
    print(f"  {'window':>7} {'':>4} {'ko':>7} {'sub':>7} {'dec':>7}")
    for label, pred, actual in (
        ("train", p_tr.mean(axis=0), tr_rate),
        ("val", _at_winner(mix_va, ws_va).mean(axis=0), va_rate),
        ("test", _at_winner(mix_te, ws_te).mean(axis=0), te_rate),
    ):
        print(f"  {label:>7} pred {pred[0]:7.3f} {pred[1]:7.3f} {pred[2]:7.3f}")
        print(f"  {'':>7} act  {actual[0]:7.3f} {actual[1]:7.3f} {actual[2]:7.3f}")

    # Year-by-year actual mix — the band any correction has to beat.
    d_all = pd.to_datetime(df.loc[grade, "event_date"])
    bk_all = df.loc[grade, "method_bucket"].to_numpy()
    years = {}
    for yr in range(2019, 2027):
        s = (d_all.dt.year == yr).to_numpy()
        if s.sum() < 20:
            continue
        years[str(yr)] = {
            "n": int(s.sum()),
            **{m: float((bk_all[s] == m).mean()) for m in METHODS},
        }
    print("\n  actual method mix by year:")
    for yr, d in years.items():
        print(f"    {yr}  n={d['n']:4d}  ko {d['ko']:.3f}  sub {d['sub']:.3f}  dec {d['dec']:.3f}")

    attempts: dict[str, Any] = {}

    # A — class-prior correction fitted on VAL. Recorded, but it can never be
    # SELECTED by val: the weights are chosen to make the val marginal exact,
    # so a val improvement is arithmetic, not evidence. It is here to show
    # what the correction does to a window it was not fitted on.
    w_val = va_rate / _at_winner(mix_va, ws_va).mean(axis=0)
    attempts["prior_correction_val_fitted"] = {
        "weights": [float(x) for x in w_val],
        "val": _ll(_prior_correct(mix_va, w_val), ws_va, bk_va),
        "test": _ll(_prior_correct(mix_te, w_val), ws_te, bk_te),
        "fitted_on_val": True,
    }

    # B — class-prior correction fitted on TRAIN (no val double-dip).
    w_tr = tr_rate / p_tr.mean(axis=0)
    attempts["prior_correction_train_fitted"] = {
        "weights": [float(x) for x in w_tr],
        "val": _ll(_prior_correct(mix_va, w_tr), ws_va, bk_va),
        "test": _ll(_prior_correct(mix_te, w_tr), ws_te, bk_te),
    }

    # C — recency-weighted training, so the fit tracks the modern era.
    d_fit = pd.to_datetime(fit_sub["event_date"])
    age_yr = (pd.Timestamp(TRAIN_END) - d_fit).dt.days.to_numpy() / 365.25
    for hl in (4.0, 6.0, 8.0, 12.0):
        w = np.exp(-np.log(2.0) * np.maximum(0.0, age_yr) / hl)
        m_hl, _ = _fit_variant(X, y, tr, va, seed=42, sample_weight=w)
        attempts[f"recency_halflife_{hl:g}y"] = {
            "val": _ll(model_mix(m_hl, va_sub, levels=levels), ws_va, bk_va),
            "test": _ll(model_mix(m_hl, te, levels=levels), ws_te, bk_te),
        }

    print(f"\n  corrections (conditional log-loss; baseline val {ll_va:.4f} test {ll_te:.4f}):")
    print(f"    {'attempt':32s} {'val':>8} {'test':>8}  {'val gate':>12}")
    for name, d in attempts.items():
        if d.get("fitted_on_val"):
            selected, why = False, "circular"
        elif d["val"] < ll_va - VAL_SELECT_MARGIN:
            selected, why = True, "selects"
        else:
            selected, why = False, "—"
        print(f"    {name:32s} {d['val']:8.4f} {d['test']:8.4f}  {why:>12}")
        d["selected_by_val"] = selected
        d["helps_test"] = bool(d["test"] < ll_te)

    selected = [k for k, v in attempts.items() if v["selected_by_val"]]
    verdict = {
        "baseline": {"val": ll_va, "test": ll_te},
        "marginals": {
            "train": {"pred": [float(x) for x in p_tr.mean(axis=0)],
                      "actual": [float(x) for x in tr_rate]},
            "val": {"pred": [float(x) for x in _at_winner(mix_va, ws_va).mean(axis=0)],
                    "actual": [float(x) for x in va_rate]},
            "test": {"pred": [float(x) for x in _at_winner(mix_te, ws_te).mean(axis=0)],
                     "actual": [float(x) for x in te_rate]},
        },
        "actual_mix_by_year": years,
        "attempts": attempts,
        "selected_by_val": selected,
        "shipped_correction": None,
    }
    print(f"\n  GATE 2 verdict: {len(selected)} correction(s) selected by val "
          f"{'— ' + ', '.join(selected) if selected else '— none ship'}")
    return verdict


# ── Stage 3 — every leg the book actually offers ───────────────────────


def _binary_scores(p: np.ndarray, y: np.ndarray) -> dict[str, float]:
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return {
        "n": int(len(y)),
        "log_loss": float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean()),
        "brier": float(((p - y) ** 2).mean()),
        "mean_pred": float(p.mean()),
        "base_rate": float(y.mean()),
    }


def stage_legs(df: pd.DataFrame, *, cache: bool, report: dict | None = None) -> dict:
    """The method market is one of FOUR legs `sportsbook.ts` prices, and three
    of them read the same reconciled distribution. `computeSportsbookOutcomes`
    derives P(distance) from the method cells directly and rescales the
    per-round finish curve to the reconciled finish total, so a better mix
    moves the distance and total_rounds legs whether or not anyone measures
    it. This stage measures it.

    Only the method leg has a scraped closing line, so the others are scored
    against the constant base rate instead of a market — an internal
    improvement, stated as one."""
    masks = split_masks(df)
    grade = gradeable_mask(df)
    levels = _best_variant(report)

    print("\nloading production Monte Carlo artifacts:")
    load_split_trained_mc()

    tr_mask, va_mask, te_mask = masks["train"] & grade, masks["val"] & grade, masks["test"] & grade
    fit_sel = tr_mask | va_mask
    fit_sub = df.loc[fit_sel].reset_index(drop=True)
    fit_or = orient_winner_first(fit_sub)
    y_fit = method_index(fit_sub["method_bucket"].to_numpy())
    base_fit, _, _ = build_feature_matrix(fit_or)
    X_fit = build_method_features(base_fit, fit_or, levels=levels)
    model, _ = _fit_variant(X_fit, y_fit, tr_mask[fit_sel], va_mask[fit_sel], seed=42)

    te = df.loc[te_mask].reset_index(drop=True)
    bucket = te["method_bucket"].to_numpy()
    winner_side = te["winner_side"].to_numpy()
    market, coherent = book_probs(te)
    cells_mc = mc_cells(df, te_mask, cache=cache).loc[te["bout_id"]]
    mix_mc = conditional_mix(cells_mc[CELLS].to_numpy(dtype=float))
    mix_new = model_mix(model, te, levels=levels)
    fr = cells_mc[[f"fr_{r}" for r in range(1, 6)]].to_numpy(dtype=float)
    raw_finish = fr.sum(axis=1)

    prob_a = ensemble_prob_a(te)
    market_prob_a = np.where(coherent, market[:, :3].sum(axis=1), np.nan)
    guarded_a = apply_edge_guard(prob_a, market_prob_a)

    # Outcomes, graded exactly as settleSelection does.
    y_dist = (bucket == "dec").astype(float)
    rf = te["round_finished"].to_numpy(dtype=float)
    y_under = np.where(bucket == "dec", 0.0, (rf <= 2).astype(float))
    gradeable_totals = (bucket == "dec") | np.isfinite(rf)
    y_win_a = (winner_side == "a").astype(float)

    print(f"\n=== Stage 3 — all four legs on the held-out test window, n={len(te)} ===")
    legs: dict[str, Any] = {}
    for label, mix in (("production", mix_mc), ("new", mix_new)):
        cells = reconcile(mix, guarded_a)
        dec_total = cells[:, 2] + cells[:, 5]
        finish_total = 1.0 - dec_total
        # sportsbook.ts: rescale the raw finish curve to the reconciled total
        # so totals, distance and method cannot be arbitraged against each
        # other. Bouts where the simulator produced no finish mass are not
        # priced at all (`if (rawFinish > 0)`), so they drop out here too.
        scale = np.where(raw_finish > 0, finish_total / np.maximum(raw_finish, EPS), 0.0)
        p_under = np.clip((fr[:, 0] + fr[:, 1]) * scale, 0.0, 1.0)
        priced = (raw_finish > 0) & gradeable_totals
        legs[label] = {
            "winner": _binary_scores(guarded_a, y_win_a),
            "distance_yes": _binary_scores(dec_total, y_dist),
            "under_2_5": _binary_scores(p_under[priced], y_under[priced]),
        }

    # Constant baselines from TRAIN, the honest "no model" reference.
    tr_bucket = df.loc[tr_mask, "method_bucket"].to_numpy()
    tr_rf = df.loc[tr_mask, "round_finished"].to_numpy(dtype=float)
    c_dist = float((tr_bucket == "dec").mean())
    tr_under = np.where(tr_bucket == "dec", 0.0, (tr_rf <= 2).astype(float))
    c_under = float(tr_under[np.isfinite(tr_rf) | (tr_bucket == "dec")].mean())
    legs["constant_train_rate"] = {
        "winner": _binary_scores(np.full(len(te), 0.5), y_win_a),
        "distance_yes": _binary_scores(np.full(len(te), c_dist), y_dist),
        "under_2_5": _binary_scores(
            np.full(int(gradeable_totals.sum()), c_under), y_under[gradeable_totals]
        ),
    }

    for leg in ("winner", "distance_yes", "under_2_5"):
        print(f"\n  {leg}:")
        print(f"    {'variant':20s} {'n':>5} {'log-loss':>9} {'brier':>8} "
              f"{'mean p':>8} {'actual':>8}")
        for label in ("constant_train_rate", "production", "new"):
            d = legs[label][leg]
            print(f"    {label:20s} {d['n']:5d} {d['log_loss']:9.4f} {d['brier']:8.4f} "
                  f"{d['mean_pred']:8.3f} {d['base_rate']:8.3f}")

    delta = {
        leg: legs["production"][leg]["log_loss"] - legs["new"][leg]["log_loss"]
        for leg in ("winner", "distance_yes", "under_2_5")
    }
    print("\n  log-loss taken off each leg by the method model "
          "(positive = better; winner leg is untouched by construction):")
    for leg, v in delta.items():
        print(f"    {leg:16s} {v:+.4f}")

    return {"n_test": int(len(te)), "legs": legs, "delta_production_minus_new": delta}


# ── Stage 4 — the audit that caught a leak in this lab's own result ────

LEAK_AUDIT_SQL = """
SELECT b.scheduled_rounds,
       b.is_title_fight,
       COUNT(*)                                                              AS n,
       COUNT(*) FILTER (WHERE b.method::text IN ('ko','tko','submission'))   AS finishes
FROM bout b
WHERE b.status = 'completed' AND b.method IS NOT NULL
GROUP BY 1, 2
ORDER BY 1, 2
"""

LEAK_RATE_SQL = """
SELECT EXTRACT(YEAR FROM e.date)::int                                        AS yr,
       COUNT(*) FILTER (WHERE b.status = 'completed')                        AS completed,
       COUNT(*) FILTER (WHERE b.status = 'completed' AND b.is_title_fight)   AS flagged,
       COUNT(*) FILTER (WHERE b.status <> 'completed')                       AS upcoming,
       COUNT(*) FILTER (WHERE b.status <> 'completed' AND b.is_title_fight)  AS flagged_upcoming
FROM bout b JOIN event e ON e.id = b.event_id
WHERE e.date >= '2021-01-01'
GROUP BY 1 ORDER BY 1
"""


def stage_leak(df: pd.DataFrame, *, cache: bool) -> dict:
    """`is_title_fight` was this lab's single largest feature by gain. It is
    also not known before the fight.

    `parsers/event_details.is_title_bout` reads "any <img> in the weight-class
    cell" as a belt, and UFCStats puts the post-fight bonus icons in that
    cell. So the flag marks bonuses, bonuses go to finishes, and the method
    model was reading its own target. This stage measures the contamination
    in the source data and re-runs the gate with the column removed —
    `method_model.LEAKING_COLUMNS` now drops it, so the "without" arm is what
    ships and the "with" arm is what the first pass of this lab reported."""
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(LEAK_AUDIT_SQL)
        audit = cur.fetchall()
        cur.execute(LEAK_RATE_SQL)
        rates = cur.fetchall()

    print("\n=== Stage 4 — is_title_fight is a post-fight bonus flag ===")
    print("\n  finish rate by (scheduled_rounds, flag) — completed bouts:")
    print(f"    {'rounds':>7} {'flag':>6} {'n':>6} {'finish%':>9}")
    audit_rows = []
    for rounds, flag, n, fin in audit:
        audit_rows.append({"rounds": int(rounds), "flagged": bool(flag),
                           "n": int(n), "finish_rate": float(fin) / int(n)})
        print(f"    {int(rounds):7d} {str(bool(flag)):>6} {int(n):6d} {fin / n * 100:8.1f}%")
    print("\n  A title fight is five rounds, always. Three-round bouts carrying")
    print("  the flag are impossible as titles and finish at roughly twice the")
    print("  base rate — the signature of Performance/Fight of the Night.")

    print("\n  flag rate by year, completed vs not-yet-fought:")
    print(f"    {'year':>5} {'done':>6} {'flagged':>8} {'pct':>7} {'upcoming':>9} {'flagged':>8}")
    rate_rows = []
    for yr, done, flagged, up, flagged_up in rates:
        rate_rows.append({"year": int(yr), "completed": int(done), "flagged": int(flagged),
                          "upcoming": int(up), "flagged_upcoming": int(flagged_up)})
        pct = flagged / done * 100 if done else 0.0
        print(f"    {int(yr):5d} {int(done):6d} {int(flagged):8d} {pct:6.1f}% "
              f"{int(up):9d} {int(flagged_up):8d}")
    print("\n  Unfought bouts carry no bonus icon, so they sit at the honest rate.")
    print("  That is a train/serve skew on top of the leak.")

    # Re-gate with and without. The "without" arm is what ships.
    masks = split_masks(df)
    grade = gradeable_mask(df)
    tr_m, va_m, te_m = masks["train"] & grade, masks["val"] & grade, masks["test"] & grade
    fit_sel = tr_m | va_m
    sub = df.loc[fit_sel].reset_index(drop=True)
    oriented = orient_winner_first(sub)
    y = method_index(sub["method_bucket"].to_numpy())
    tr, va = tr_m[fit_sel], va_m[fit_sel]
    te = df.loc[te_m].reset_index(drop=True)
    ws_te, bk_te = te["winner_side"].to_numpy(), te["method_bucket"].to_numpy()

    base_fit, _, _ = build_feature_matrix(oriented)
    X_clean = build_method_features(base_fit, oriented, levels=False)
    X_leaky = X_clean.copy()
    X_leaky["is_title_fight"] = base_fit["is_title_fight"].to_numpy()

    def _test_cond(model, cols) -> float:
        mix = np.empty((len(te), 2, 3))
        for s, frame in enumerate((te, swap_sides(te))):
            b, _, _ = build_feature_matrix(frame)
            xx = build_method_features(b, frame, levels=False)
            if "is_title_fight" in cols:
                xx = xx.copy()
                xx["is_title_fight"] = b["is_title_fight"].to_numpy()
            mix[:, s, :] = model.predict_cond(xx[cols])
        return cond_ll_from_mix(mix, ws_te, bk_te)

    arms: dict[str, Any] = {}
    for tag, X in (("with_leak", X_leaky), ("shipped_without_leak", X_clean)):
        cols = list(X.columns)
        va_lls, te_lls = [], []
        for seed in SEEDS:
            m, p_va = _fit_variant(X, y, tr, va, seed=seed)
            va_lls.append(_multiclass_logloss(y[va], p_va))
            te_lls.append(_test_cond(m, cols))
        arms[tag] = {
            "val_logloss_median": float(np.median(va_lls)),
            "val_per_seed": [float(v) for v in va_lls],
            "test_cond_median": float(np.median(te_lls)),
            "test_cond_per_seed": [float(v) for v in te_lls],
            "n_features": len(cols),
        }

    cells = mc_cells(df, te_m, cache=cache).loc[te["bout_id"]]
    ll_mc = cond_ll_from_mix(conditional_mix(cells[CELLS].to_numpy(dtype=float)), ws_te, bk_te)
    tr_b = sub.loc[tr, "method_bucket"].to_numpy()
    emp = np.array([(tr_b == m).mean() for m in METHODS])
    yi = method_index(bk_te)
    ll_const = float(-np.log(np.clip(np.tile(emp, (len(te), 1))[np.arange(len(te)), yi],
                                     EPS, 1.0)).mean())

    print("\n  conditional log-loss, with the leak and without:")
    print(f"    {'arm':26s} {'val':>8} {'test':>8}")
    for tag, d in arms.items():
        print(f"    {tag:26s} {d['val_logloss_median']:8.4f} {d['test_cond_median']:8.4f}")
    print(f"    {'MC production':26s} {'—':>8} {ll_mc:8.4f}")
    print(f"    {'constant base rates':26s} {'—':>8} {ll_const:8.4f}")

    cost = {
        "val": arms["shipped_without_leak"]["val_logloss_median"]
        - arms["with_leak"]["val_logloss_median"],
        "test": arms["shipped_without_leak"]["test_cond_median"]
        - arms["with_leak"]["test_cond_median"],
    }
    survives = arms["shipped_without_leak"]["test_cond_median"] < ll_mc
    print(f"\n  the leak was worth {cost['val']:.4f} nats on val and "
          f"{cost['test']:.4f} on test — none of it available at serve time.")
    print(f"  the honest model still beats the simulator: "
          f"{'YES' if survives else 'NO'} "
          f"({arms['shipped_without_leak']['test_cond_median']:.4f} vs {ll_mc:.4f})")

    return {
        "finish_rate_by_flag": audit_rows,
        "flag_rate_by_year": rate_rows,
        "arms": arms,
        "mc_production_test_cond": ll_mc,
        "constant_test_cond": ll_const,
        "leak_value": cost,
        "result_survives_removal": bool(survives),
        "root_cause": (
            "parsers/event_details.is_title_bout treats any <img> in the "
            "weight-class cell as a belt; UFCStats renders post-fight bonus "
            "icons in that cell"
        ),
    }


# ── Stage 5 — the round leg ────────────────────────────────────────────

MAX_ROUNDS = 5


def _round_mask(sched: np.ndarray) -> np.ndarray:
    """(n, 5) boolean — which round indices a bout of that length can end in."""
    return np.arange(1, MAX_ROUNDS + 1)[None, :] <= sched[:, None]


def _masked_norm(p: np.ndarray, sched: np.ndarray) -> np.ndarray:
    """Zero out rounds the bout cannot reach and renormalise."""
    out = np.where(_round_mask(sched), p, 0.0)
    s = out.sum(axis=1, keepdims=True)
    return np.divide(out, np.where(s > 0, s, 1.0))


def _round_ll(p: np.ndarray, y: np.ndarray) -> float:
    return float(-np.log(np.clip(p[np.arange(len(y)), y], EPS, 1.0)).mean())


def stage_rounds(df: pd.DataFrame, *, cache: bool, report: dict | None = None) -> dict:
    """Can a per-bout model beat the simulator on WHEN a finish lands?

    The prior is that it should, and for a structural reason: every covariate
    in `finish_hazard.py` is time-constant, so `_normalize_shape` divides it
    back out and the served timing is TWO FIXED CURVES per scheduled length,
    identical for every bout on the card. The only per-bout variation in the
    round distribution comes from how those two curves get mixed by the KO/sub
    totals. A discriminative P(round | a finish happened, X) has per-bout
    resolution the hazard cannot express.

    Scored on finished bouts only — the round market's `u2_5` needs the round
    a finish landed in, and decisions are graded by `wentDistance` instead."""
    levels = _best_variant(report)
    masks = split_masks(df)

    rf = df["round_finished"].to_numpy(dtype=float)
    sched_all = df["scheduled_rounds"].to_numpy(dtype=float)
    finished = (
        df["method_bucket"].isin(("ko", "sub")).to_numpy()
        & np.isfinite(rf)
        & (rf >= 1)
        & (rf <= sched_all)
    )
    print(f"\n=== Stage 5 — round of finish, n={int(finished.sum()):,} finished bouts ===")

    tr_m = masks["train"] & finished
    va_m = masks["val"] & finished
    te_m = masks["test"] & finished

    fit_sel = tr_m | va_m
    fit_sub = df.loc[fit_sel].reset_index(drop=True)
    te = df.loc[te_m].reset_index(drop=True)
    tr, va = tr_m[fit_sel], va_m[fit_sel]
    y_fit = fit_sub["round_finished"].to_numpy(dtype=int) - 1
    y_te = te["round_finished"].to_numpy(dtype=int) - 1
    sched_fit = fit_sub["scheduled_rounds"].to_numpy(dtype=int)
    sched_te = te["scheduled_rounds"].to_numpy(dtype=int)

    def _matrix(frame: pd.DataFrame) -> pd.DataFrame:
        base, _, _ = build_feature_matrix(frame)
        return build_method_features(base, frame, levels=levels)

    # Slot order is arbitrary for a bout-level target, so average both.
    X_fit = _matrix(fit_sub)
    X_fit_sw = _matrix(swap_sides(fit_sub))
    X_te = _matrix(te)
    X_te_sw = _matrix(swap_sides(te))

    print(f"  train {int(tr.sum()):,} · val {int(va.sum()):,} · test {len(te):,} "
          f"· {X_fit.shape[1]} features")

    # ── references ────────────────────────────────────────────────────
    cells_va = mc_cells(df, va_m, cache=cache).loc[fit_sub.loc[va, "bout_id"]]
    cells_te = mc_cells(df, te_m, cache=cache).loc[te["bout_id"]]
    fr_cols = [f"fr_{r}" for r in range(1, MAX_ROUNDS + 1)]
    prod_va = _masked_norm(cells_va[fr_cols].to_numpy(dtype=float),
                           fit_sub.loc[va, "scheduled_rounds"].to_numpy(dtype=int))
    prod_te = _masked_norm(cells_te[fr_cols].to_numpy(dtype=float), sched_te)

    # Constant: the empirical round distribution on TRAIN, per scheduled length.
    const_by_len: dict[int, np.ndarray] = {}
    for length in (3, 5):
        sel = tr & (sched_fit == length)
        counts = np.array([(y_fit[sel] == r).sum() for r in range(MAX_ROUNDS)], dtype=float)
        const_by_len[length] = counts / max(counts.sum(), 1.0)
    const_va = _masked_norm(
        np.array([const_by_len.get(int(s), const_by_len[3])
                  for s in fit_sub.loc[va, "scheduled_rounds"]]),
        fit_sub.loc[va, "scheduled_rounds"].to_numpy(dtype=int),
    )
    const_te = _masked_norm(
        np.array([const_by_len.get(int(s), const_by_len[3]) for s in sched_te]), sched_te
    )

    # ── discriminative model ──────────────────────────────────────────
    def _fit(seed: int):
        params = {
            **LGB_MULTI_PARAMS, "num_class": MAX_ROUNDS, "seed": seed,
            "min_data_in_leaf": 60, "num_leaves": 15, "max_depth": 4,
        }
        dtr = lgb.Dataset(X_fit.loc[tr].reset_index(drop=True), label=y_fit[tr])
        dva = lgb.Dataset(X_fit.loc[va].reset_index(drop=True), label=y_fit[va],
                          reference=dtr)
        return lgb.train(
            params, dtr, num_boost_round=2000, valid_sets=[dva],
            callbacks=[lgb.early_stopping(120, verbose=False)],
        )

    def _predict(booster, Xa: pd.DataFrame, Xb: pd.DataFrame, sched: np.ndarray) -> np.ndarray:
        it = booster.best_iteration or None
        p = 0.5 * (booster.predict(Xa, num_iteration=it) + booster.predict(Xb, num_iteration=it))
        return _masked_norm(np.asarray(p, dtype=float), sched)

    per_seed, va_preds, te_preds = [], [], []
    for seed in SEEDS:
        booster = _fit(seed)
        p_va = _predict(booster, X_fit.loc[va].reset_index(drop=True),
                        X_fit_sw.loc[va].reset_index(drop=True),
                        fit_sub.loc[va, "scheduled_rounds"].to_numpy(dtype=int))
        p_te = _predict(booster, X_te, X_te_sw, sched_te)
        va_preds.append(p_va)
        te_preds.append(p_te)
        per_seed.append({
            "seed": seed,
            "val_logloss": _round_ll(p_va, y_fit[va]),
            "test_logloss": _round_ll(p_te, y_te),
            "best_iteration": int(booster.best_iteration or 0),
        })
        print(f"  seed {seed:2d}  val {per_seed[-1]['val_logloss']:.4f}  "
              f"test {per_seed[-1]['test_logloss']:.4f}")

    model_va = np.mean(va_preds, axis=0)
    model_te = np.mean(te_preds, axis=0)

    refs = {
        "constant_train_by_length": {
            "val": _round_ll(const_va, y_fit[va]), "test": _round_ll(const_te, y_te)},
        "production_hazard": {
            "val": _round_ll(prod_va, y_fit[va]), "test": _round_ll(prod_te, y_te)},
        "discriminative": {
            "val": _round_ll(model_va, y_fit[va]), "test": _round_ll(model_te, y_te)},
    }
    print("\n  round-of-finish log-loss (conditional on a finish):")
    print(f"    {'variant':28s} {'val':>8} {'test':>8}")
    for k, v in refs.items():
        print(f"    {k:28s} {v['val']:8.4f} {v['test']:8.4f}")

    boot = _paired_bootstrap(
        -np.log(np.clip(prod_te[np.arange(len(y_te)), y_te], EPS, 1.0)),
        -np.log(np.clip(model_te[np.arange(len(y_te)), y_te], EPS, 1.0)),
    )
    print(f"\n  paired bootstrap: production − model {boot['delta']:+.4f} "
          f"[{boot['lo95']:+.4f}, {boot['hi95']:+.4f}]  P(improves) {boot['frac_positive']:.3f}")

    # Where the mass sits, 3-round bouts.
    three = sched_te == 3
    print("\n  3-round finishes, predicted vs actual share by round "
          f"(n={int(three.sum())}):")
    print(f"    {'round':>6} {'actual':>8} {'hazard':>8} {'model':>8}")
    dist = {}
    for r in range(3):
        dist[r + 1] = {
            "actual": float((y_te[three] == r).mean()),
            "hazard": float(prod_te[three, r].mean()),
            "model": float(model_te[three, r].mean()),
        }
        d = dist[r + 1]
        print(f"    {r + 1:6d} {d['actual']:8.3f} {d['hazard']:8.3f} {d['model']:8.3f}")

    passed = (
        refs["discriminative"]["val"] < refs["production_hazard"]["val"] - GATE0_MARGIN
        and all(s["val_logloss"] < refs["production_hazard"]["val"] for s in per_seed)
        and boot["lo95"] > 0
    )
    print(f"\n  GATE 5: {'PASS' if passed else 'FAIL'}")

    return {
        "n_train": int(tr.sum()), "n_val": int(va.sum()), "n_test": int(len(te)),
        "n_features": int(X_fit.shape[1]),
        "per_seed": per_seed,
        "references": refs,
        "bootstrap_production_minus_model": boot,
        "three_round_distribution": dist,
        "train_constant_by_length": {
            str(k): [float(x) for x in v] for k, v in const_by_len.items()},
        "passed": bool(passed),
    }


# ── Stage 6 — the submission cell ──────────────────────────────────────


def stage_submission(df: pd.DataFrame, *, cache: bool, report: dict | None = None) -> dict:
    """The whole residual gap to the closing method line is submissions
    (§4: +0.2141 nats on the 105 bouts one ended, against KO at +0.0802 and
    decisions at −0.0920). This stage asks the question the six winner-leg
    labs answered the hard way: is it the SHAPE of the model or the
    INFORMATION in it?

    GATE A re-shapes and adds nothing — a hierarchical P(finish) × P(sub |
    finish) factorisation instead of a flat 3-class softmax, which is the
    natural decomposition if "will it end early" and "on the mat or on the
    feet" are separate questions. If a re-shape closes the gap, the
    information was always there.

    GATE B adds information: an opponent-adjusted SUBMISSION rating (the
    existing `grap_*` pair is takedowns) and submission attempts CONCEDED.
    Both are computed from `bout_round_stats.sub_attempts`, a column that has
    been in the database since the first scrape and has never reached a model
    from the defensive side.

    The gate metric is the OVERALL conditional log-loss on val (n=428), not
    the submission cell alone: val carries ~71 submissions, and a gate on 71
    rows selects noise. The sub cell is reported as a diagnostic."""
    levels = _best_variant(report)
    masks = split_masks(df)
    grade = gradeable_mask(df)
    tr_m, va_m = masks["train"] & grade, masks["val"] & grade
    fit_sel = tr_m | va_m
    sub_df = df.loc[fit_sel].reset_index(drop=True)
    oriented = orient_winner_first(sub_df)
    y = method_index(sub_df["method_bucket"].to_numpy())
    tr, va = tr_m[fit_sel], va_m[fit_sel]
    y_va = y[va]
    is_sub_va = y_va == METHODS.index("sub")

    base, _, _ = build_feature_matrix(oriented)
    X_without = build_method_features(base, oriented, levels=levels, sub_axis=False)
    X_with = build_method_features(base, oriented, levels=levels, sub_axis=True)

    n_new = X_with.shape[1] - X_without.shape[1]
    print(f"\n=== Stage 6 — the submission cell (train {int(tr.sum()):,}, "
          f"val {int(va.sum())}, {int(is_sub_va.sum())} of them submissions) ===")
    print(f"  submission axis adds {n_new} columns "
          f"({X_without.shape[1]} -> {X_with.shape[1]})")

    def _diag(p: np.ndarray) -> dict[str, float]:
        return {
            "overall": _multiclass_logloss(y_va, p),
            "sub_cell": _multiclass_logloss(y_va[is_sub_va], p[is_sub_va]),
            "mean_p_sub_when_sub": float(p[is_sub_va, METHODS.index("sub")].mean()),
            "mean_p_sub_all": float(p[:, METHODS.index("sub")].mean()),
        }

    # ── baseline: the shipped matrix ──────────────────────────────────
    arms: dict[str, Any] = {}
    for tag, X in (("shipped", X_without), ("gate_b_sub_axis", X_with)):
        per_seed = []
        for seed in SEEDS:
            _, p_va = _fit_variant(X, y, tr, va, seed=seed)
            per_seed.append({"seed": seed, **_diag(p_va)})
        arms[tag] = {
            "per_seed": per_seed,
            "median_overall": float(np.median([r["overall"] for r in per_seed])),
            "median_sub_cell": float(np.median([r["sub_cell"] for r in per_seed])),
            "n_features": int(X.shape[1]),
        }

    # ── GATE A: re-shape only, no new columns ─────────────────────────
    # Stage 1: P(finish) binary. Stage 2: P(sub | finish) binary. Recombined
    # into the 3-cell distribution, so it is scored by the same metric.
    y_fin = (y != METHODS.index("dec")).astype(int)
    y_sub_given_fin = (y == METHODS.index("sub")).astype(int)
    fin_rows = y_fin == 1
    per_seed_a = []
    for seed in SEEDS:
        params = {**LGB_MULTI_PARAMS, "objective": "binary", "seed": seed}
        params.pop("num_class", None)
        params["metric"] = "binary_logloss"

        def _binary(mask_tr: np.ndarray, mask_va: np.ndarray, target: np.ndarray,
                    p: dict = params) -> np.ndarray:
            dtr = lgb.Dataset(X_without.loc[mask_tr].reset_index(drop=True),
                              label=target[mask_tr])
            dva = lgb.Dataset(X_without.loc[mask_va].reset_index(drop=True),
                              label=target[mask_va], reference=dtr)
            bst = lgb.train(p, dtr, num_boost_round=2000, valid_sets=[dva],
                            callbacks=[lgb.early_stopping(120, verbose=False)])
            return bst.predict(X_without.loc[va].reset_index(drop=True),
                               num_iteration=bst.best_iteration or None)

        p_fin = _binary(tr, va, y_fin)
        p_sub_g = _binary(tr & fin_rows, va & fin_rows, y_sub_given_fin)
        p_hier = np.column_stack([
            p_fin * (1.0 - p_sub_g),  # ko
            p_fin * p_sub_g,          # sub
            1.0 - p_fin,              # dec
        ])
        p_hier = np.clip(p_hier, EPS, None)
        p_hier /= p_hier.sum(axis=1, keepdims=True)
        per_seed_a.append({"seed": seed, **_diag(p_hier)})
    arms["gate_a_hierarchical"] = {
        "per_seed": per_seed_a,
        "median_overall": float(np.median([r["overall"] for r in per_seed_a])),
        "median_sub_cell": float(np.median([r["sub_cell"] for r in per_seed_a])),
        "n_features": int(X_without.shape[1]),
    }

    base_overall = arms["shipped"]["median_overall"]
    print(f"\n  {'arm':22s} {'val overall':>12} {'val sub cell':>13} "
          f"{'p(sub|sub)':>11} {'gate':>10}")
    for tag in ("shipped", "gate_a_hierarchical", "gate_b_sub_axis"):
        d = arms[tag]
        p_sub = float(np.median([r["mean_p_sub_when_sub"] for r in d["per_seed"]]))
        if tag == "shipped":
            verdict = "baseline"
        else:
            lls = [r["overall"] for r in d["per_seed"]]
            verdict = (
                "PASS" if all(v < base_overall - VAL_SELECT_MARGIN for v in lls) else "FAIL"
            )
            d["passed"] = verdict == "PASS"
        print(f"  {tag:22s} {d['median_overall']:12.4f} {d['median_sub_cell']:13.4f} "
              f"{p_sub:11.3f} {verdict:>10}")

    print(f"\n  gate: beat the shipped matrix by >= {VAL_SELECT_MARGIN} nats "
          f"on val OVERALL, every seed. The sub cell alone is "
          f"{int(is_sub_va.sum())} rows and selects noise.")

    return {
        "n_train": int(tr.sum()), "n_val": int(va.sum()),
        "n_val_submissions": int(is_sub_va.sum()),
        "sub_axis_columns": n_new,
        "arms": arms,
        "gate_margin": VAL_SELECT_MARGIN,
        "gate_a_passed": bool(arms["gate_a_hierarchical"].get("passed", False)),
        "gate_b_passed": bool(arms["gate_b_sub_axis"].get("passed", False)),
    }


# ── entrypoint ─────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--stage", default="decompose",
                    choices=["decompose", "gate0", "gate1", "gate2", "legs", "leak", "rounds", "submission", "all"])
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
    if args.stage in ("gate0", "all"):
        report["gate0"] = stage_gate0(df, cache=cache)
    if args.stage in ("gate1", "all"):
        report["gate1"] = stage_gate1(df, cache=cache, report=report)
    if args.stage in ("gate2", "all"):
        report["gate2"] = stage_gate2(df, cache=cache, report=report)
    if args.stage in ("legs", "all"):
        report["legs"] = stage_legs(df, cache=cache, report=report)
    if args.stage in ("leak", "all"):
        report["leak"] = stage_leak(df, cache=cache)
    if args.stage in ("rounds", "all"):
        report["rounds"] = stage_rounds(df, cache=cache, report=report)
    if args.stage in ("submission", "all"):
        report["submission"] = stage_submission(df, cache=cache, report=report)

    existing = json.loads(REPORT_PATH.read_text()) if REPORT_PATH.exists() else {}
    existing.update(report)
    REPORT_PATH.write_text(json.dumps(existing, indent=2))
    print(f"\nwrote {REPORT_PATH.relative_to(PACKAGE_ROOT)}")


if __name__ == "__main__":
    main()

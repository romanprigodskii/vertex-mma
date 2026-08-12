"""Backtest of the METHOD market (KO/Sub/Decision) on the held-out TEST split.

The Monte Carlo layer has produced per-side method distributions since
Phase 3, but they were never checked against fight outcomes or bookmaker
method lines. This script closes that gap:

  1. Rebuilds the dataset and scores the TEST split (>= VAL_END) with the
     split-trained artifacts/ensemble_eval model — model WEIGHTS are
     out-of-sample (trained strictly pre-VAL_END), though the feature set
     and architecture were historically selected consulting this same
     window, so treat the numbers as slightly optimistic. Winner probs are
     order-averaged like predict.py (P = ½·[p(A,B) + 1 − p(B,A)]).
     Population caveat: debut bouts are excluded (build_dataset default),
     while production also offers method markets on them via the debut
     specialist — this report covers only both-experienced bouts.
  2. Re-runs the production Monte Carlo per bout (deterministic:
     seed = stable_hash(bout_id)) and reconciles the MC method MIX to the
     ensemble winner LEVEL, exactly like src/lib/sportsbook.ts
     reconcileMethodProbs. Two variants are evaluated: PURE model and
     EDGE-GUARDED (winner prob clamped to ±0.15 of the devigged market
     moneyline — what the sportsbook actually offers).
  3. Pulls the method closing lines scraped into bout_external_odds
     (method_{a,b}_{kotko,sub,dec}_decimal — see
     scripts/odds_scraper/scripts/run_method_backfill.py) and reports:
       - marginal calibration (P(KO)/P(Sub)/P(Dec) vs actual frequencies)
       - 6-cell multiclass log-loss/Brier, model vs devigged market
       - flat-stake ROI vs the closing method lines across EV thresholds,
         plus a bet-every-cell baseline (≈ market overround)

Settlement mirrors src/lib/sportsbook.ts settleSelection: ko+tko → ko,
decision_* → dec; DQ voids the winner-side method bet and loses the rest;
winner-with-NULL-method voids. Draw/NC bouts never enter the dataset
(target_a_wins is NULL), which matches their void-everything grading.

Usage (from scripts/simulation, venv active):
  python scripts/eval_method_market.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

import src.monte_carlo as _mc  # noqa: E402
from src.config import ARTIFACTS_DIR, VAL_END  # noqa: E402
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
from src.method_model import METHOD_MODEL_EVAL_DIR, MethodModel  # noqa: E402
from src.method_model import conditional_mix as method_conditional_mix  # noqa: E402
from src.monte_carlo import FighterMC, simulate_bout  # noqa: E402

_EVAL_DIR = ARTIFACTS_DIR / "ensemble_eval"
ENSEMBLE_DIR = _EVAL_DIR if _EVAL_DIR.exists() else ARTIFACTS_DIR / "ensemble"

# The MC's finish timing and decision-winner split are fitted artifacts. Load
# the SPLIT-TRAINED twins (train < TRAIN_END) rather than the served all-data
# ones, so this backtest stays out-of-sample on every moving part, not just the
# ensemble weights.
_HAZARD_EVAL_PATH = ARTIFACTS_DIR / "finish_hazard_eval.json"
_DECISION_EVAL_PATH = ARTIFACTS_DIR / "decision_winner_eval.json"
# What METHOD_ANCHOR_LAMBDA was before the round lab re-swept it, so --legacy
# reproduces the whole pre-lab configuration and not just part of it.
LEGACY_ANCHOR_LAMBDA = 0.80

MAX_MARKET_EDGE = 0.15  # keep in sync with src/lib/sportsbook.ts
CELLS = ["a_ko", "a_sub", "a_dec", "b_ko", "b_sub", "b_dec"]
EV_THRESHOLDS = [0.0, 0.05, 0.10, 0.15, 0.20]

ODDS_SQL = """
SELECT
  b.id::text,
  b.fighter_a_id::text,
  b.winner_id::text,
  b.method::text,
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


def reconcile_method_probs(
    mc_cells: dict[str, float], prob_a: float, prob_b: float
) -> dict[str, float]:
    """Rescale each side's MC ko/sub/dec cells to sum to the ensemble
    winner prob for that side (mirror of sportsbook.ts
    reconcileMethodProbs — MC keeps the MIX, ensemble sets the LEVEL)."""
    out: dict[str, float] = {}
    for side, level in (("a", prob_a), ("b", prob_b)):
        ko, sub, dec = (mc_cells[f"{side}_ko"], mc_cells[f"{side}_sub"], mc_cells[f"{side}_dec"])
        total = ko + sub + dec
        if not total > 0:
            out[f"{side}_ko"] = out[f"{side}_sub"] = out[f"{side}_dec"] = level / 3
            continue
        out[f"{side}_ko"] = ko * level / total
        out[f"{side}_sub"] = sub * level / total
        out[f"{side}_dec"] = dec * level / total
    return out


def apply_edge_guard(model_prob_a: float, market_prob_a: float | None) -> float:
    if market_prob_a is None or not np.isfinite(market_prob_a):
        return float(np.clip(model_prob_a, 1e-6, 1 - 1e-6))
    lo, hi = market_prob_a - MAX_MARKET_EDGE, market_prob_a + MAX_MARKET_EDGE
    return float(np.clip(min(hi, max(lo, model_prob_a)), 1e-6, 1 - 1e-6))


def settle(cell: str, winner_side: str | None, bucket: str | None) -> str:
    """Grade a 1u flat bet on `cell`. Returns 'won' | 'lost' | 'void'.
    Mirrors settleSelection for the method market."""
    if bucket == "no_contest":
        return "void"
    if winner_side is None:  # draw
        return "void"
    side, method = cell.split("_", 1)
    if bucket == "dq":
        return "void" if side == winner_side else "lost"
    if bucket is None:  # completed with winner but method missing
        return "void"
    return "won" if (side == winner_side and method == bucket) else "lost"


def _fmt_pct(x: float) -> str:
    return f"{x * 100:+.1f}%"


def _bootstrap_roi_ci(
    settled: pd.DataFrame, n_boot: int = 2000, seed: int = 42
) -> tuple[float, float]:
    """95% CI for flat-stake ROI, bootstrapped by BOUT (up to 6 cells per
    bout are mutually exclusive — resampling bets independently would
    understate the variance)."""
    pnl = settled["result"].eq("won") * (settled["odds"] - 1.0) - settled[
        "result"
    ].eq("lost") * 1.0
    by_bout = pnl.groupby(settled["bout_id"]).agg(["sum", "count"])
    if by_bout.empty:
        return 0.0, 0.0
    rng = np.random.default_rng(seed)
    sums = by_bout["sum"].to_numpy()
    counts = by_bout["count"].to_numpy()
    idx = rng.integers(0, len(by_bout), size=(n_boot, len(by_bout)))
    rois = sums[idx].sum(axis=1) / np.maximum(1, counts[idx].sum(axis=1))
    return float(np.quantile(rois, 0.025)), float(np.quantile(rois, 0.975))


def run_roi(
    bets_df: pd.DataFrame, prob_col: str, label: str
) -> None:
    """Flat 1u stake on every cell whose EV = p*odds − 1 exceeds the
    threshold. bets_df: one row per (bout, cell) with odds + outcome."""
    print(f"\n=== ROI vs closing method lines — {label} ===")
    print(f"{'EV thr':>7} {'bets':>5} {'won':>5} {'void':>4} {'P&L':>8} {'ROI':>7}  95% CI (bout bootstrap)")
    for thr in EV_THRESHOLDS:
        sel = bets_df[(bets_df[prob_col] * bets_df["odds"] - 1.0) > thr]
        settled = sel[sel["result"] != "void"]
        pnl = float(
            (settled["result"].eq("won") * (settled["odds"] - 1.0)
             - settled["result"].eq("lost") * 1.0).sum()
        )
        n_bets, n_won, n_void = len(sel), int(sel["result"].eq("won").sum()), int(sel["result"].eq("void").sum())
        roi = pnl / len(settled) if len(settled) else 0.0
        lo, hi = _bootstrap_roi_ci(settled)
        print(
            f"{thr:7.2f} {n_bets:5d} {n_won:5d} {n_void:4d} {pnl:8.1f} "
            f"{_fmt_pct(roi):>7}  [{_fmt_pct(lo)}, {_fmt_pct(hi)}]"
        )

    # Per-method breakdown at a mid threshold.
    thr = 0.05
    sel = bets_df[(bets_df[prob_col] * bets_df["odds"] - 1.0) > thr]
    if len(sel):
        print(f"  breakdown at EV>{thr:.2f}:")
        sel = sel.copy()
        sel["method"] = sel["cell"].str.split("_").str[1]
        for meth, g in sel.groupby("method"):
            settled = g[g["result"] != "void"]
            pnl = float(
                (settled["result"].eq("won") * (settled["odds"] - 1.0)
                 - settled["result"].eq("lost") * 1.0).sum()
            )
            roi = pnl / len(settled) if len(settled) else 0.0
            print(f"    {meth:4s} n={len(g):4d}  P&L {pnl:7.1f}  ROI {_fmt_pct(roi)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--legacy",
        action="store_true",
        help="force the pre-round-lab Monte Carlo: hand-set damage timing, "
             "hand-weighted decision logit, METHOD_ANCHOR_LAMBDA=0.80. Use to "
             "measure the fitted models' effect on THIS test set rather than "
             "against a remembered number.",
    )
    args = ap.parse_args()

    if args.legacy:
        _mc.set_hazard_model(None)
        _mc.set_decision_model(None)
        _mc.METHOD_ANCHOR_LAMBDA = LEGACY_ANCHOR_LAMBDA
        print(
            "LEGACY MODE: hand-set damage timing + hand-weighted decision logit "
            f"+ METHOD_ANCHOR_LAMBDA={LEGACY_ANCHOR_LAMBDA}, no method model"
        )

    df = symmetrize_for_training(build_dataset(fetch_raw()))
    X, _, meta = build_feature_matrix(df, corrector=True)

    if ENSEMBLE_DIR.name != "ensemble_eval":
        print("WARNING: ensemble_eval/ missing — falling back to the served "
              "(all-data) model; numbers below are IN-SAMPLE.")
    for label, path, loader in (
        ("finish timing", _HAZARD_EVAL_PATH, _mc.load_hazard_model),
        ("decision winner", _DECISION_EVAL_PATH, _mc.load_decision_model),
    ):
        if args.legacy:
            continue
        if path.exists():
            loader(path)
            print(f"{label}: split-trained {path.name}")
        else:
            print(f"{label}: legacy hand-set constants (no artifact)")

    ensemble = EnsembleModel.load(ENSEMBLE_DIR)
    X = X[serving_columns(ensemble.feature_columns)]
    X_sw, _, _ = build_feature_matrix(swap_sides(df), corrector=True)
    X_sw = X_sw[serving_columns(ensemble.feature_columns)]

    test_mask = pd.to_datetime(meta["event_date"]) >= pd.to_datetime(VAL_END)
    df_test = df.loc[test_mask.to_numpy()].reset_index(drop=True)
    meta_test = meta.loc[test_mask.to_numpy()].reset_index(drop=True)

    # Order-averaged ensemble winner prob, like predict.py.
    p_raw = ensemble.predict_proba_a(X.loc[test_mask.to_numpy()].reset_index(drop=True))
    p_sw = ensemble.predict_proba_a(X_sw.loc[test_mask.to_numpy()].reset_index(drop=True))
    prob_a = 0.5 * (p_raw + (1.0 - p_sw))
    n = len(df_test)
    print(f"TEST split (>= {VAL_END}), n={n} bouts — running Monte Carlo…")

    # v0.12.0 — the conditional method model supplies the MIX that production
    # now prices from. The SPLIT-trained twin is loaded for the same reason
    # the hazard/decision twins are: everything on the held-out window has to
    # be out-of-sample, not just the ensemble weights. --legacy skips it, so
    # the flag still reproduces one whole pre-model configuration.
    method_mixes = None
    if not args.legacy and METHOD_MODEL_EVAL_DIR.exists():
        method_model = MethodModel.load(METHOD_MODEL_EVAL_DIR)
        method_mixes = method_conditional_mix(method_model, df_test)
        print(f"method mix: split-trained {METHOD_MODEL_EVAL_DIR.name}/")
    elif not args.legacy:
        print("method mix: simulator hazards (no method_model_eval artifact)")

    # Monte Carlo per bout — deterministic production seed.
    mc_cells_rows: list[dict[str, float]] = []
    for i in range(n):
        row = df_test.iloc[i]
        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        mc = simulate_bout(
            FighterMC.from_snapshot(snap_a),
            FighterMC.from_snapshot(snap_b),
            int(row["scheduled_rounds"]),
            seed=stable_hash(row["bout_id"]),
            is_main_event=bool(row["is_main_event"]),
            is_title_fight=bool(row["is_title_fight"]),
            method_mix=(
                (tuple(method_mixes[i, 0]), tuple(method_mixes[i, 1]))
                if method_mixes is not None
                else None
            ),
        )
        mc_cells_rows.append(
            {
                "a_ko": mc.prob_ko_a, "a_sub": mc.prob_sub_a, "a_dec": mc.prob_decision_a,
                "b_ko": mc.prob_ko_b, "b_sub": mc.prob_sub_b, "b_dec": mc.prob_decision_b,
            }
        )

    market_winner_a = meta_test["market_prob_a"].to_numpy(dtype=float)

    pure: list[dict[str, float]] = []
    guarded: list[dict[str, float]] = []
    for i in range(n):
        pa = float(prob_a[i])
        pure.append(reconcile_method_probs(mc_cells_rows[i], pa, 1.0 - pa))
        ga = apply_edge_guard(pa, None if np.isnan(market_winner_a[i]) else float(market_winner_a[i]))
        guarded.append(reconcile_method_probs(mc_cells_rows[i], ga, 1.0 - ga))

    # ── Outcomes + method closing lines from the DB ────────────────────
    bout_ids = meta_test["bout_id"].tolist()
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(ODDS_SQL, (bout_ids,))
        db_rows = {r[0]: r for r in cur.fetchall()}

    winner_side: list[str | None] = []
    bucket: list[str | None] = []
    odds_rows: list[dict[str, float | None]] = []
    for i in range(n):
        bid = meta_test["bout_id"].iloc[i]
        r = db_rows.get(bid)
        if r is None:
            winner_side.append(None)
            bucket.append("no_contest")  # missing row → treat as ungradeable
            odds_rows.append(dict.fromkeys(CELLS))
            continue
        (_, db_fa, db_winner, db_method, a_ko, a_sub, a_dec, b_ko, b_sub, b_dec) = r
        flipped = db_fa != meta_test["fighter_a_id"].iloc[i]
        cells = (
            {"a_ko": b_ko, "a_sub": b_sub, "a_dec": b_dec, "b_ko": a_ko, "b_sub": a_sub, "b_dec": a_dec}
            if flipped
            else {"a_ko": a_ko, "a_sub": a_sub, "a_dec": a_dec, "b_ko": b_ko, "b_sub": b_sub, "b_dec": b_dec}
        )
        odds_rows.append({k: (float(v) if v is not None else None) for k, v in cells.items()})
        if db_winner == meta_test["fighter_a_id"].iloc[i]:
            winner_side.append("a")
        elif db_winner == meta_test["fighter_b_id"].iloc[i]:
            winner_side.append("b")
        else:
            winner_side.append(None)
        bucket.append(method_bucket(db_method))

    has_any_odds = np.array([any(o[c] is not None for c in CELLS) for o in odds_rows])
    has_all_odds = np.array([all(o[c] is not None for c in CELLS) for o in odds_rows])

    # Market-coherence guard: a real 6-cell method book carries overround,
    # so its implied probabilities must sum comfortably above 1 (typically
    # 1.15-1.45). A sum below 1 is a free-arbitrage "book" that cannot
    # exist — scrape corruption — and absurdly high sums are junk too.
    # Incoherent bouts are dropped from EVERY odds-based analysis below.
    def _implied_sum(o: dict[str, float | None]) -> float | None:
        if any(o[c] is None or not o[c] > 1.0 for c in CELLS):
            return None
        return sum(1.0 / o[c] for c in CELLS)

    coherent = np.array(
        [
            (s := _implied_sum(o)) is not None and 1.0 <= s <= 1.6
            for o in odds_rows
        ]
    )
    n_incoherent = int((has_all_odds & ~coherent).sum())
    print(
        f"method odds coverage: any-cell {int(has_any_odds.sum())}/{n} · "
        f"all-6-cells {int(has_all_odds.sum())}/{n} · "
        f"incoherent books dropped {n_incoherent}"
    )
    print(
        "NOTE: debut bouts excluded (production prices them via the debut "
        "specialist); draws/NC never enter the dataset (void in settlement)."
    )

    # Gradeable 6-class outcome: a winner and a ko/sub/dec bucket.
    outcome_cell = np.array(
        [
            f"{w}_{b}" if (w in ("a", "b") and b in ("ko", "sub", "dec")) else ""
            for w, b in zip(winner_side, bucket, strict=True)
        ]
    )
    gradeable = outcome_cell != ""
    print(
        f"outcomes: {int(gradeable.sum())}/{n} land in the 6-cell space "
        f"(rest: dq/missing-method/no-row)"
    )

    # ── Marginal calibration: P(KO), P(Sub), P(Dec) ────────────────────
    for label, dists in (("PURE model", pure), ("EDGE-GUARDED", guarded)):
        print(f"\n=== MARGINAL method calibration — {label} (gradeable test bouts) ===")
        print(f"{'marginal':>8} {'pred%':>7} {'actual%':>8}")
        for meth in ("ko", "sub", "dec"):
            pred = np.array([d[f"a_{meth}"] + d[f"b_{meth}"] for d in dists])[gradeable]
            actual = np.array([c.endswith(meth) for c in outcome_cell[gradeable]])
            print(f"{meth:>8} {pred.mean()*100:6.1f}% {actual.mean()*100:7.1f}%")

    # Reliability bins on the winner-side cell probability (pure model).
    print("\n=== RELIABILITY (pure model, per-cell probs, gradeable bouts) ===")
    print("bin          n    pred%   actual%")
    cell_probs = np.array([[pure[i][c] for c in CELLS] for i in range(n)])
    grade_idx = np.where(gradeable)[0]
    flat_pred = cell_probs[grade_idx].ravel()
    flat_hit = np.array(
        [1.0 if CELLS[j] == outcome_cell[i] else 0.0 for i in grade_idx for j in range(6)]
    )
    bins = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.60, 1.0]
    for lo, hi in zip(bins[:-1], bins[1:], strict=True):
        sel = (flat_pred >= lo) & (flat_pred < hi)
        if not sel.any():
            continue
        print(
            f"{lo:.2f}-{hi:.2f} {int(sel.sum()):5d}  {flat_pred[sel].mean()*100:5.1f}%  "
            f"{flat_hit[sel].mean()*100:6.1f}%"
        )

    # ── 6-cell multiclass metrics vs devigged market ───────────────────
    hh = gradeable & has_all_odds & coherent
    if hh.any():
        idx = np.where(hh)[0]
        eps = 1e-12
        market_probs = np.zeros((len(idx), 6))
        for k, i in enumerate(idx):
            inv = np.array([1.0 / odds_rows[i][c] for c in CELLS])
            market_probs[k] = inv / inv.sum()
        y_cell = np.array([CELLS.index(outcome_cell[i]) for i in idx])
        for label, dists in (("PURE model", pure), ("EDGE-GUARDED", guarded)):
            mp = np.array([[dists[i][c] for c in CELLS] for i in idx])
            # Model cells sum to 1 by construction (p_a + p_b = 1); renormalize
            # anyway to keep the log-loss comparison exact.
            mp = mp / mp.sum(axis=1, keepdims=True)
            ll = -np.log(np.clip(mp[np.arange(len(idx)), y_cell], eps, None)).mean()
            onehot = np.zeros_like(mp)
            onehot[np.arange(len(idx)), y_cell] = 1.0
            brier = ((mp - onehot) ** 2).sum(axis=1).mean()
            print(f"\n=== 6-CELL multiclass vs market (n={len(idx)}) — {label} ===")
            print(f"model   logloss {ll:.4f}  brier {brier:.4f}")
            mll = -np.log(np.clip(market_probs[np.arange(len(idx)), y_cell], eps, None)).mean()
            mbrier = ((market_probs - onehot) ** 2).sum(axis=1).mean()
            print(f"market  logloss {mll:.4f}  brier {mbrier:.4f}  (devigged 6-cell)")

    # ── ROI vs closing lines ───────────────────────────────────────────
    bet_records: list[dict] = []
    for i in range(n):
        if has_all_odds[i] and not coherent[i]:
            continue  # corrupt book — betting into it is fiction
        for c in CELLS:
            o = odds_rows[i][c]
            if o is None or not o > 1.0:
                continue
            bet_records.append(
                {
                    "bout_id": meta_test["bout_id"].iloc[i],
                    "cell": c,
                    "odds": o,
                    "p_pure": pure[i][c],
                    "p_guarded": guarded[i][c],
                    "result": settle(c, winner_side[i], bucket[i]),
                }
            )
    bets_df = pd.DataFrame(bet_records)
    if bets_df.empty:
        print("\nNo method odds in the test window — run the method backfill first.")
        return

    settled_all = bets_df[bets_df["result"] != "void"]
    pnl_all = float(
        (settled_all["result"].eq("won") * (settled_all["odds"] - 1.0)
         - settled_all["result"].eq("lost") * 1.0).sum()
    )
    print(
        f"\nbet-every-cell baseline: {len(bets_df)} cells · "
        f"P&L {pnl_all:.1f} · ROI {_fmt_pct(pnl_all / max(1, len(settled_all)))} "
        f"(≈ market overround)"
    )
    run_roi(bets_df, "p_pure", "PURE model")
    run_roi(bets_df, "p_guarded", "EDGE-GUARDED (sportsbook probs)")


if __name__ == "__main__":
    main()

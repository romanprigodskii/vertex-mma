"""LAB — the official UFC rankings as a feature block.

Seven labs have closed on the winner leg at between 0 and +0.002 of the
0.0248-nat gap to the closing line, and the last two of them
(`regional_regime.md`, `method_leg.md` §9) added genuinely NEW information and
still closed at zero. Their shared conclusion was that the residual is not
absent information but redundant information — record-shaped data the
opponent-adjusted model already extracts.

`ranking_snapshot` is not record-shaped. It is 47,019 rows of the official UFC
divisional rankings as published — 279 snapshots from 2017-01-06, rank 0 =
champion, 1..15 = contenders — i.e. a panel's judgement of who is good,
recorded fortnightly, which no lab has ever fed to a model. Two reasons to
expect something where six levers found nothing:

  1. It is not derived from `bout_round_stats`. Every failed lever was a
     re-arrangement of the same fight-record substrate; this one is an outside
     opinion that prices reputation, matchmaking intent and eye-test the
     round-stat record cannot see.
  2. It is concentrated exactly where the deficit is. The whole gap lives in
     the market-0.72+ bucket (+0.0770 nats there, ~0 in the other three), and
     "champion vs unranked" is what a lopsided UFC matchup structurally IS.

Stated up front: the block only speaks about ~30 % of bouts (at least one
ranked fighter) and only from 2017 (54 % of the frame). A win on a third of
the rows has to be worth a third-sized effect on the headline; anything larger
would be suspicious rather than good.

Stages:
  0 — KILL TEST, no retraining. Do the rankings explain anything the SERVED
      ensemble's own probability does not already contain? Cross-fitted
      logistic on [model logit] vs [model logit + rank block], over the
      out-of-sample rows (val + test). If a block fitted directly on the
      model's residual cannot beat it, nothing downstream can.
  1 — GATE 1. Full retrain with the block in the feature matrix, gated on VAL
      log-loss across seeds, test reported once and never selected on.

Usage (scripts/simulation, venv active):
  python scripts/lab_rank_signal.py --stage 0 [--cache]
  python scripts/lab_rank_signal.py --stage 1 [--cache] [--seeds 42,7,13]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from eval_tail_buckets import (  # noqa: E402
    EPS,
    averaged_probs,
    load_symmetrized,
    prepare_splits,
)
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.model_selection import StratifiedKFold  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

from src.config import ARTIFACTS_DIR  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.rank_export import (  # noqa: E402
    UNRANKED_LEVEL,
    build_rank_features,
    effective_rank,
    fetch_rankings,
)

ARTIFACT_PATH = ARTIFACTS_DIR / "lab_rank_signal.json"

# Fill values for the pair-level block. The GBTs in stage 1 take NaN natively;
# the stage-0 logistic cannot, and every fill here is the neutral value of its
# own column ("no difference between the sides") except the two that have a
# meaningful worst case.
_PAIR_FILL = {
    "d_tenure_years": 0.0,
    "d_delta180": 0.0,
    "d_share_year": 0.0,
    "d_days_since_years": 0.0,
}


def rank_pair_block(rf: pd.DataFrame) -> pd.DataFrame:
    """Antisymmetric pair columns from the per-side rank frame.

    Every column is (A minus B) so a side swap negates it exactly — the same
    discipline features.py uses, and the reason a slot bias cannot be learned
    from this block.
    """
    out = pd.DataFrame(index=rf.index)
    out["d_eff_best"] = effective_rank(rf["rank_best_a"]) - effective_rank(rf["rank_best_b"])
    out["d_eff_div"] = effective_rank(rf["rank_div_a"]) - effective_rank(rf["rank_div_b"])
    out["d_champ"] = rf["rank_is_champ_a"].fillna(0) - rf["rank_is_champ_b"].fillna(0)
    out["d_ranked"] = rf["rank_is_ranked_a"].fillna(0) - rf["rank_is_ranked_b"].fillna(0)
    out["d_eff_peak"] = effective_rank(rf["rank_peak_a"]) - effective_rank(rf["rank_peak_b"])
    out["d_tenure_years"] = (rf["rank_tenure_days_a"] - rf["rank_tenure_days_b"]) / 365.0
    out["d_delta180"] = rf["rank_delta180_a"].fillna(0) - rf["rank_delta180_b"].fillna(0)
    out["d_share_year"] = rf["rank_share_year_a"].fillna(0) - rf["rank_share_year_b"].fillna(0)
    out["d_days_since_years"] = (
        rf["rank_days_since_a"].fillna(365 * 5) - rf["rank_days_since_b"].fillna(365 * 5)
    ) / 365.0
    # Symmetric context — unchanged by a swap, so it cannot encode a side.
    out["both_ranked"] = (
        (rf["rank_is_ranked_a"].fillna(0) > 0) & (rf["rank_is_ranked_b"].fillna(0) > 0)
    ).astype(float)
    out["either_champ"] = (
        (rf["rank_is_champ_a"].fillna(0) > 0) | (rf["rank_is_champ_b"].fillna(0) > 0)
    ).astype(float)
    return out.fillna(_PAIR_FILL).fillna(0.0)


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def _crossfit_logloss(
    X: np.ndarray, y: np.ndarray, seed: int = 42, folds: int = 5
) -> np.ndarray:
    """Out-of-fold predicted probabilities from a standardized logistic.

    Cross-fitting is what makes "does the block add anything" answerable on
    1,100 rows: an in-sample fit would report an improvement for any block of
    eleven columns, including noise.
    """
    oof = np.zeros(len(y), dtype=float)
    skf = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
    for tr, te in skf.split(X, y):
        sc = StandardScaler().fit(X[tr])
        clf = LogisticRegression(max_iter=1000, C=1.0, solver="liblinear")
        clf.fit(sc.transform(X[tr]), y[tr])
        oof[te] = clf.predict_proba(sc.transform(X[te]))[:, 1]
    return oof


def _ll(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, EPS, 1 - EPS)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def _paired_bootstrap(
    p_a: np.ndarray, p_b: np.ndarray, y: np.ndarray, n: int = 4000, seed: int = 11
) -> dict[str, float]:
    """Mean per-row log-loss difference (a − b) with a percentile interval."""
    la = -(y * np.log(np.clip(p_a, EPS, 1 - EPS)) + (1 - y) * np.log(np.clip(1 - p_a, EPS, 1)))
    lb = -(y * np.log(np.clip(p_b, EPS, 1 - EPS)) + (1 - y) * np.log(np.clip(1 - p_b, EPS, 1)))
    d = la - lb
    rng = np.random.default_rng(seed)
    boots = np.array([d[rng.integers(0, len(d), len(d))].mean() for _ in range(n)])
    return {
        "delta": float(d.mean()),
        "lo": float(np.percentile(boots, 2.5)),
        "hi": float(np.percentile(boots, 97.5)),
        "frac_negative": float((boots < 0).mean()),
    }


# ── Stage 0 — kill test ─────────────────────────────────────────────────


def stage_0(use_cache: bool) -> dict:
    """Is there signal in the rankings that the served model does not have?

    Basis: the rows where `ensemble_eval` is genuinely out-of-sample (val +
    test, i.e. event_date >= TRAIN_END). Its own probability is the baseline
    feature; the question is whether eleven rank columns fitted on top of that
    logit beat it out-of-fold.
    """
    prep = prepare_splits(use_cache=use_cache)
    ens = prep["ensemble"]

    frames = []
    for name in ("val", "test"):
        sp = prep["splits"][name]
        p = averaged_probs(ens, sp)
        frames.append(
            pd.DataFrame(
                {
                    "split": name,
                    "p": p,
                    "y": sp["y"],
                    "market": sp["market"],
                    "bout_id": sp["meta"]["bout_id"].to_numpy(),
                    "event_date": sp["meta"]["event_date"].to_numpy(),
                    "fighter_a_id": sp["meta"]["fighter_a_id"].to_numpy(),
                    "fighter_b_id": sp["meta"]["fighter_b_id"].to_numpy(),
                }
            )
        )
    ev = pd.concat(frames, ignore_index=True)

    # The rank block needs weight_class / gender, which live on the row frame.
    df = load_symmetrized(use_cache)
    ctx = df[["bout_id", "weight_class", "gender"]].drop_duplicates("bout_id")
    ev = ev.merge(ctx, on="bout_id", how="left")

    with get_connection() as conn:
        ranks = fetch_rankings(conn)
    rf = build_rank_features(ev, ranks)
    block = rank_pair_block(rf)
    ev = pd.concat([ev, rf, block], axis=1)

    y = ev["y"].to_numpy().astype(int)
    z = logit(ev["p"].to_numpy())
    cols = list(block.columns)
    X_base = z.reshape(-1, 1)
    X_cand = np.column_stack([z, block[cols].to_numpy(dtype=float)])

    p_base = _crossfit_logloss(X_base, y)
    p_cand = _crossfit_logloss(X_cand, y)

    # Eleven columns on 1,093 rows — 64 % of which are unranked-vs-unranked and
    # therefore all-zero in the block — is a noisy test, and a noisy test that
    # comes back negative proves nothing on its own. Re-run it as a NESTED
    # sequence so a real single-column effect cannot hide behind ten noise
    # columns, and so the failure mode (capacity vs substance) is visible.
    nested = {
        "1_eff_best": ["d_eff_best"],
        "3_core": ["d_eff_best", "d_champ", "both_ranked"],
        "5_core+form": ["d_eff_best", "d_champ", "both_ranked", "d_share_year", "d_delta180"],
        "11_full": cols,
    }
    res_nested = {}
    for label, sub in nested.items():
        Xc = np.column_stack([z, block[sub].to_numpy(dtype=float)])
        pc = _crossfit_logloss(Xc, y)
        res_nested[label] = {
            "k": len(sub),
            "logloss": _ll(pc, y),
            "delta_vs_base": _ll(pc, y) - _ll(p_base, y),
            "bootstrap": _paired_bootstrap(pc, p_base, y, n=2000),
        }

    res: dict = {
        "n": int(len(ev)),
        "n_with_snapshot": int(ev["rank_has_data"].sum()),
        "n_either_ranked": int(((ev["rank_is_ranked_a"] > 0) | (ev["rank_is_ranked_b"] > 0)).sum()),
        "n_both_ranked": int(((ev["rank_is_ranked_a"] > 0) & (ev["rank_is_ranked_b"] > 0)).sum()),
        "served_logloss": _ll(ev["p"].to_numpy(), y),
        "crossfit_base_logloss": _ll(p_base, y),
        "crossfit_cand_logloss": _ll(p_cand, y),
        "bootstrap_cand_minus_base": _paired_bootstrap(p_cand, p_base, y),
        "block_columns": cols,
        "nested": res_nested,
    }

    # Same comparison restricted to the region that carries the whole deficit,
    # and to the region where the block can act at all.
    m = ev["market"].to_numpy(dtype=float)
    conf = np.maximum(m, 1 - m)
    subsets = {
        "market_0.72+": (~np.isnan(m)) & (conf >= 0.72),
        "either_ranked": ((ev["rank_is_ranked_a"] > 0) | (ev["rank_is_ranked_b"] > 0)).to_numpy(),
        "neither_ranked": (
            (ev["rank_is_ranked_a"] == 0) & (ev["rank_is_ranked_b"] == 0)
        ).to_numpy(),
    }
    res["subsets"] = {}
    for label, sel in subsets.items():
        if sel.sum() < 30:
            continue
        res["subsets"][label] = {
            "n": int(sel.sum()),
            "base": _ll(p_base[sel], y[sel]),
            "cand": _ll(p_cand[sel], y[sel]),
            "delta": _ll(p_cand[sel], y[sel]) - _ll(p_base[sel], y[sel]),
        }

    # Interpretability: the block fitted once on everything, standardized, so
    # the coefficients are comparable to each other.
    sc = StandardScaler().fit(X_cand)
    clf = LogisticRegression(max_iter=1000, C=1.0, solver="liblinear").fit(sc.transform(X_cand), y)
    res["coefficients"] = dict(
        zip(["model_logit", *cols], [float(c) for c in clf.coef_[0]], strict=True)
    )

    # Does the BOOK price the rank gap more sharply than we do? If our deficit
    # is rank-shaped, the gap to the market should widen with |rank gap|.
    has_m = ~np.isnan(m)
    gap_bins = [(0, 0.5), (0.5, 5), (5, 12), (12, 100)]
    rows = []
    absgap = block["d_eff_best"].abs().to_numpy()
    for lo, hi in gap_bins:
        sel = has_m & (absgap >= lo) & (absgap < hi)
        if sel.sum() < 20:
            continue
        rows.append(
            {
                "lo": lo,
                "hi": hi,
                "n": int(sel.sum()),
                "model_ll": _ll(ev["p"].to_numpy()[sel], y[sel]),
                "market_ll": _ll(m[sel], y[sel]),
                "gap": _ll(ev["p"].to_numpy()[sel], y[sel]) - _ll(m[sel], y[sel]),
                "mean_market_conf": float(conf[sel].mean()),
                "mean_model_conf": float(
                    np.maximum(ev["p"].to_numpy()[sel], 1 - ev["p"].to_numpy()[sel]).mean()
                ),
            }
        )
    res["by_rank_gap"] = rows
    return res


def print_stage_0(res: dict) -> None:
    print(f"\n{'=' * 74}\nSTAGE 0 — kill test: does the served probability already contain it?\n{'=' * 74}")
    print(
        f"basis: {res['n']} out-of-sample bouts (val + test) · snapshot available for "
        f"{res['n_with_snapshot']} · at least one ranked {res['n_either_ranked']} · "
        f"both ranked {res['n_both_ranked']}"
    )
    print(f"\nserved model log-loss (order-averaged): {res['served_logloss']:.4f}")
    print("cross-fitted logistic, 5 folds:")
    print(f"  [model logit]                {res['crossfit_base_logloss']:.4f}")
    print(f"  [model logit + rank block]   {res['crossfit_cand_logloss']:.4f}")
    b = res["bootstrap_cand_minus_base"]
    print(
        f"  candidate − base             {b['delta']:+.4f} "
        f"[{b['lo']:+.4f}, {b['hi']:+.4f}] · improves in {b['frac_negative']:.1%} of resamples"
    )
    print("\nnested blocks (same cross-fit, k columns on top of the model logit):")
    for label, s in res["nested"].items():
        b2 = s["bootstrap"]
        print(
            f"  {label:14s} k={s['k']:2d}  ll {s['logloss']:.4f}  Δ {s['delta_vs_base']:+.4f}  "
            f"[{b2['lo']:+.4f}, {b2['hi']:+.4f}]  improves {b2['frac_negative']:.0%}"
        )
    print("\nby subset:")
    for label, s in res["subsets"].items():
        print(f"  {label:16s} n={s['n']:5d}  base {s['base']:.4f}  cand {s['cand']:.4f}  Δ {s['delta']:+.4f}")
    print("\nstandardized coefficients (fitted on everything, for reading only):")
    for k, v in sorted(res["coefficients"].items(), key=lambda kv: -abs(kv[1])):
        print(f"  {k:22s} {v:+.4f}")
    print(f"\nmodel vs market by |rank gap| (effective rank, unranked = {UNRANKED_LEVEL:.0f}):")
    print(f"  {'gap':>10}  {'n':>5}  {'model':>7}  {'market':>7}  {'Δ':>7}  {'mkt conf':>8}  {'our conf':>8}")
    for r in res["by_rank_gap"]:
        print(
            f"  {r['lo']:4.1f}-{r['hi']:<5.1f} {r['n']:5d}  {r['model_ll']:7.4f}  "
            f"{r['market_ll']:7.4f}  {r['gap']:+7.4f}  {r['mean_market_conf']:8.3f}  {r['mean_model_conf']:8.3f}"
        )


# ── Stage 1 — the real gate: rank columns inside the feature matrix ─────

# Model-facing rank columns. Same shape discipline as features.py: A−B diffs
# carry the matchup, a few absolute levels carry the regime (a #1-vs-#3 fight
# is not a #12-vs-#14 fight), and the symmetric context columns say whether the
# block can speak about this row at all.
RANK_MODEL_COLUMNS = [
    "diff_rank_eff_best",
    "diff_rank_eff_div",
    "diff_rank_eff_peak",
    "diff_rank_tenure_years",
    "diff_rank_delta180",
    "diff_rank_share_year",
    "diff_rank_days_since_years",
    "abs_rank_eff_best_a",
    "abs_rank_eff_best_b",
    "abs_rank_is_champ_a",
    "abs_rank_is_champ_b",
    "abs_rank_is_ranked_a",
    "abs_rank_is_ranked_b",
    "rank_both_ranked",
    "rank_either_champ",
    "rank_has_data",
]


def rank_model_block(rf: pd.DataFrame) -> pd.DataFrame:
    """The stage-1 feature block, from the per-side frame `build_rank_features`
    returns. Kept separate from `rank_pair_block` (stage 0): the GBTs take NaN
    natively, so the raw per-side ranks stay unfilled and "unranked" and
    "before 2017" remain distinguishable."""
    eff_a, eff_b = effective_rank(rf["rank_best_a"]), effective_rank(rf["rank_best_b"])
    out = pd.DataFrame(index=rf.index)
    out["diff_rank_eff_best"] = eff_a - eff_b
    out["diff_rank_eff_div"] = effective_rank(rf["rank_div_a"]) - effective_rank(rf["rank_div_b"])
    out["diff_rank_eff_peak"] = effective_rank(rf["rank_peak_a"]) - effective_rank(rf["rank_peak_b"])
    out["diff_rank_tenure_years"] = (rf["rank_tenure_days_a"] - rf["rank_tenure_days_b"]) / 365.0
    out["diff_rank_delta180"] = rf["rank_delta180_a"] - rf["rank_delta180_b"]
    out["diff_rank_share_year"] = rf["rank_share_year_a"] - rf["rank_share_year_b"]
    out["diff_rank_days_since_years"] = (
        rf["rank_days_since_a"] - rf["rank_days_since_b"]
    ) / 365.0
    out["abs_rank_eff_best_a"] = eff_a
    out["abs_rank_eff_best_b"] = eff_b
    out["abs_rank_is_champ_a"] = rf["rank_is_champ_a"]
    out["abs_rank_is_champ_b"] = rf["rank_is_champ_b"]
    out["abs_rank_is_ranked_a"] = rf["rank_is_ranked_a"]
    out["abs_rank_is_ranked_b"] = rf["rank_is_ranked_b"]
    out["rank_both_ranked"] = (
        (rf["rank_is_ranked_a"] > 0) & (rf["rank_is_ranked_b"] > 0)
    ).astype("int8")
    out["rank_either_champ"] = (
        (rf["rank_is_champ_a"] > 0) | (rf["rank_is_champ_b"] > 0)
    ).astype("int8")
    out["rank_has_data"] = rf["rank_has_data"]
    # A row with no snapshot must not read as "both unranked": blank the
    # effective-rank columns that fillna() would otherwise have set to 20.
    blind = rf["rank_has_data"] == 0
    for col in (
        "diff_rank_eff_best", "diff_rank_eff_div", "diff_rank_eff_peak",
        "abs_rank_eff_best_a", "abs_rank_eff_best_b",
        "abs_rank_is_champ_a", "abs_rank_is_champ_b",
        "abs_rank_is_ranked_a", "abs_rank_is_ranked_b",
        "rank_both_ranked", "rank_either_champ",
    ):
        out.loc[blind, col] = np.nan
    return out[RANK_MODEL_COLUMNS]


def rank_block_for_frame(frame: pd.DataFrame, ranks: pd.DataFrame) -> pd.DataFrame:
    """Feature-matrix hook: rebuild the block from whichever ORIENTATION of the
    frame it is handed. The harness calls this twice — once on the frame, once
    on `swap_sides(frame)` — and because the block is keyed on
    fighter_a_id / fighter_b_id, the swapped call re-resolves each side's rank
    from scratch rather than trusting a column permutation."""
    return rank_model_block(build_rank_features(frame, ranks))


def stage_1(use_cache: bool, seeds: list[int]) -> dict:
    """Retrain the served recipe with and without the rank block.

    Both arms are trained HERE — comparing a fresh arm against the shipped
    artifacts would confound the block with every other difference between this
    run and the one that produced them. VAL decides; test is computed once per
    arm and never selected on.
    """
    from lab_winner_common import ArmResult, fit_arm  # local import: shared harness

    df = load_symmetrized(use_cache)
    with get_connection() as conn:
        ranks = fetch_rankings(conn)

    # A third arm, because "16 columns hurt" and "the rankings hold nothing"
    # are different claims: the minimal block is the one a tree can actually
    # afford on 2,600 rows that carry a snapshot at all.
    def rank_block_min(frame: pd.DataFrame, ranks: pd.DataFrame) -> pd.DataFrame:
        return rank_block_for_frame(frame, ranks)[
            ["diff_rank_eff_best", "rank_both_ranked", "rank_has_data"]
        ]

    blocks = {
        "baseline": None,
        "rank": rank_block_for_frame,
        "rank_min": rank_block_min,
    }
    out: dict = {"seeds": seeds, "arms": {}}
    for arm, block in blocks.items():
        per_seed = []
        for seed in seeds:
            r: ArmResult = fit_arm(
                df,
                label=arm,
                extra_block=block,
                extra_args={"ranks": ranks} if block is not None else None,
                seed=seed,
            )
            per_seed.append(r.as_dict())
            print(
                f"  {arm:9s} seed {seed:>3}  val {r.val['logloss']:.4f}  "
                f"test {r.test['logloss']:.4f}  test acc {r.test['acc']:.4f}  "
                f"({r.n_features} cols, blend {r.blend_mode})"
            )
        out["arms"][arm] = per_seed
    return out


def print_stage_1(res: dict) -> None:
    print(f"\n{'=' * 74}\nSTAGE 1 — rank block in the feature matrix (VAL gates, test reports)\n{'=' * 74}")
    seeds = res["seeds"]
    base = res["arms"]["baseline"]
    for arm, cand in res["arms"].items():
        if arm == "baseline":
            continue
        print(f"\n-- {arm} vs baseline --")
        print(f"  {'seed':>5}  {'val base':>9}  {'val cand':>9}  {'Δ val':>8}  "
              f"{'test base':>10}  {'test cand':>10}  {'Δ test':>8}")
        for i, seed in enumerate(seeds):
            dv = cand[i]["val"]["logloss"] - base[i]["val"]["logloss"]
            dt = cand[i]["test"]["logloss"] - base[i]["test"]["logloss"]
            print(
                f"  {seed:>5}  {base[i]['val']['logloss']:9.4f}  {cand[i]['val']['logloss']:9.4f}  "
                f"{dv:+8.4f}  {base[i]['test']['logloss']:10.4f}  {cand[i]['test']['logloss']:10.4f}  {dt:+8.4f}"
            )
        dv = np.median([c["val"]["logloss"] - b["val"]["logloss"] for b, c in zip(base, cand, strict=True)])
        dt = np.median([c["test"]["logloss"] - b["test"]["logloss"] for b, c in zip(base, cand, strict=True)])
        print(f"  median Δ val {dv:+.4f} · median Δ test {dt:+.4f}")
        print(f"  GATE: {'PASS' if dv < -0.005 else 'FAIL'} (val must improve by > 0.005)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="0")
    ap.add_argument("--cache", action="store_true", help="reuse data/dataset.parquet")
    ap.add_argument("--seeds", default="42,7,13")
    args = ap.parse_args()

    payload: dict = {}
    if ARTIFACT_PATH.exists():
        payload = json.loads(ARTIFACT_PATH.read_text())

    if args.stage == "0":
        res = stage_0(args.cache)
        print_stage_0(res)
        payload["stage0"] = res
    elif args.stage == "1":
        seeds = [int(s) for s in args.seeds.split(",")]
        res = stage_1(args.cache, seeds)
        print_stage_1(res)
        payload["stage1"] = res
    else:
        raise SystemExit(f"unknown stage {args.stage!r}")

    ARTIFACT_PATH.write_text(json.dumps(payload, indent=1, default=str))
    print(f"\nwrote {ARTIFACT_PATH}")


if __name__ == "__main__":
    main()

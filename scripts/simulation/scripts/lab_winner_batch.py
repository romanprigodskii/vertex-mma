"""LAB — winner-leg levers that are NOT new features.

Eight labs have now looked for information the winner model does not have
(`round_lab`, redundancy, `tail_resolution`, blend/age, `graded_target`,
`regional_regime`, `method_leg` §9, `rank_signal`) and every one closed at
zero. This lab stops looking for information and asks the other question: is
the recipe itself leaving log-loss on the table?

Four candidates, none of which adds a single column of data:

  * SYMMETRY. `predict.py` serves ½·[f(A,B) + 1 − f(B,A)] because f is not
    antisymmetric — scoring one ordering costs ~2.1 pp of accuracy. That
    asymmetry is pure variance: the model spends capacity learning that slot A
    and slot B are the same question. Training on BOTH orderings states it
    instead of learning it.
  * THE LEAKED TITLE FLAG. `bout.is_title_fight` is a post-fight BONUS icon
    (`method_leg.md` §7), set on ~30 % of completed bouts against a real title
    rate near 5 %. The method model dropped it; the winner ensemble still
    consumes it at rank 114/118, and at serve time an upcoming bout carries the
    honest schedule value — so training and serving disagree about what the
    column means.
  * RECENCY. The sport moved between 2013 and 2025; the model weights a 2013
    bout and a 2024 bout identically.
  * CAPACITY. `best_params.json` predates ~40 of the 118 columns.

SELECTION BASIS. Not the 429-row val split — that instrument picked the
piecewise calibrator that was worst on test, and it cannot see a 0.003 effect.
Every arm here is chosen on walk-forward OOF (~3,100 bouts, 2017-2025, refit
per quarter at production's cadence), which never touches the 2025+ test
window. Test is read once, for the finalists, after selection is closed.

Usage (scripts/simulation, venv active):
  python scripts/lab_winner_batch.py --stage oof [--arms baseline,aug_train] [--seeds 42]
  python scripts/lab_winner_batch.py --stage test --arms aug_train --seeds 42,7,13
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
    bucket_table,
    headline,
    load_symmetrized,
    murphy,
    prepare_splits,
)
from lab_winner_common import (  # noqa: E402
    fit_arm,
    oof_logloss,
    paired_bootstrap,
    walk_forward,
)
from scipy.optimize import minimize  # noqa: E402
from sklearn.model_selection import StratifiedKFold  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.ensemble import CALIBRATOR_FAMILIES, ProbabilityCalibrator  # noqa: E402
from src.rank_export import UNRANKED_LEVEL, build_rank_features, fetch_rankings  # noqa: E402

ARTIFACT_PATH = ARTIFACTS_DIR / "lab_winner_batch.json"
OOF_CACHE = DATA_DIR / "lab_winner_batch_oof.parquet"

# Each arm is one changed condition against the served recipe. Nothing here
# adds data; every difference is in how the same rows are used.
ARMS: dict[str, dict] = {
    "baseline": {},
    # Symmetry, stated rather than learned.
    "aug_train": {"augment": "train"},
    "aug_train_val": {"augment": "train+val"},
    # The post-fight bonus flag the winner model still trains on.
    "no_title": {"drop_columns": ("is_title_fight",)},
    "aug_no_title": {"augment": "train", "drop_columns": ("is_title_fight",)},
    # Recency: how much of the sport's own drift to price in.
    "recency_8y": {"halflife_years": 8.0},
    "recency_4y": {"halflife_years": 4.0},
    # Capacity, both directions — best_params.json predates ~40 columns, so
    # "is the current setting even on the right side of the ridge" is open.
    "lgb_reg": {
        "lgb_overrides": {
            "num_leaves": 15,
            "min_data_in_leaf": 100,
            "learning_rate": 0.02,
            "feature_fraction": 0.6,
            "lambda_l2": 5.0,
        }
    },
    "lgb_deep": {
        "lgb_overrides": {"num_leaves": 63, "min_data_in_leaf": 20, "lambda_l2": 0.5}
    },
    # The blend rule. `weighted_mean` divides by the std of THREE val
    # log-losses before the softmax, so the served weights are 0.07 / 0.17 /
    # 0.76 — three quarters of the blend on the LogReg leg, decided by 429
    # rows. These arms ask whether that rule is doing anything a fixed one
    # would not do more stably.
    "blend_mean": {"force_blend_mode": "mean"},
    "blend_logreg": {"force_blend_mode": "logreg"},
    "blend_gbt_only": {"force_blend_weights": [0.5, 0.5, 0.0]},
    "blend_cb_heavy": {"force_blend_weights": [0.2, 0.5, 0.3]},
}

# Capacity, swept one axis at a time so the result is a REGION and not a lucky
# point. `best_params.json` was tuned on a feature set ~40 columns narrower
# than today's, and the tuning objective was the 429-row val split; the OOF
# pool can see differences that instrument cannot. CatBoost gets its own axes
# because it is the strongest single learner — and because the served blend
# currently puts only 6.7 % of its weight on LightGBM, so an LGB-only sweep
# would be measuring a leg the blend barely listens to.
HP_ARMS: dict[str, dict] = {
    "hp_lgb_leaves15": {"lgb_overrides": {"num_leaves": 15}},
    "hp_lgb_leaves63": {"lgb_overrides": {"num_leaves": 63}},
    "hp_lgb_mdl100": {"lgb_overrides": {"min_data_in_leaf": 100}},
    "hp_lgb_mdl20": {"lgb_overrides": {"min_data_in_leaf": 20}},
    "hp_lgb_lr02": {"lgb_overrides": {"learning_rate": 0.02}},
    "hp_lgb_lr05": {"lgb_overrides": {"learning_rate": 0.05}},
    "hp_lgb_ff60": {"lgb_overrides": {"feature_fraction": 0.6}},
    "hp_lgb_l2_10": {"lgb_overrides": {"lambda_l2": 10.0}},
    "hp_cb_depth4": {"cb_overrides": {"depth": 4}},
    "hp_cb_depth8": {"cb_overrides": {"depth": 8}},
    "hp_cb_lr03": {"cb_overrides": {"learning_rate": 0.03}},
    "hp_cb_lr08": {"cb_overrides": {"learning_rate": 0.08}},
    "hp_cb_l2r10": {"cb_overrides": {"l2_leaf_reg": 10.0}},
    "hp_cb_rsm07": {"cb_overrides": {"rsm": 0.7}},
    "hp_both_reg": {
        "lgb_overrides": {"num_leaves": 15, "min_data_in_leaf": 100, "lambda_l2": 5.0},
        "cb_overrides": {"depth": 4, "l2_leaf_reg": 10.0},
    },
}
# The age throttle. `FEATURE_CONTRI_OVERRIDES` multiplies the gain LightGBM is
# allowed to claim from diff_age (0.45) and the absolute ages (0.5). It was
# introduced for EXPLAINABILITY — a Phase 2 audit found diff_age topping the
# SHAP list on almost every upcoming bout — and its cost in log-loss was never
# measured on an instrument that could see it. The bias probe says we give a
# 35-year-old facing a 28-year-old a 0.371 chance where the truth is 0.164.
AGE_ARMS: dict[str, dict] = {
    "age_free": {"feature_contri": {}},
    "age_075": {"feature_contri": {"diff_age": 0.75, "abs_age_a": 0.75, "abs_age_b": 0.75}},
    "age_free_cb_only": {"feature_contri": {}, "force_blend_weights": [0.0, 1.0, 0.0]},
}
ARMS.update(HP_ARMS)
ARMS.update(AGE_ARMS)


def run_oof(arms: list[str], seeds: list[int], use_cache: bool, reuse: bool) -> pd.DataFrame:
    df = load_symmetrized(use_cache)
    have = pd.read_parquet(OOF_CACHE) if (reuse and OOF_CACHE.exists()) else None
    frames = [] if have is None else [have]
    for arm in arms:
        for seed in seeds:
            if have is not None and (
                (have["label"] == arm) & (have["seed"] == seed)
            ).any():
                print(f"  {arm} seed {seed}: cached")
                continue
            print(f"  {arm} seed {seed}: walking forward…")
            frames.append(walk_forward(df, label=arm, seed=seed, **ARMS[arm]))
    out = pd.concat(frames, ignore_index=True)
    out.to_parquet(OOF_CACHE, index=False)
    return out


def _bagged(oof: pd.DataFrame, arm: str, seeds: list[int]) -> pd.DataFrame | None:
    """Average an arm's probability across seeds, per bout.

    Seed averaging is the one variance reduction available for free: the three
    learners are refit from scratch per seed, and a GBT's seed moves bagging
    and feature sampling, so the spread between seeds is variance and nothing
    else. Production ships ONE seed, which throws that away.
    """
    sub = oof[(oof["label"] == arm) & (oof["seed"].isin(seeds))]
    if sub["seed"].nunique() < 2:
        return None
    g = sub.groupby("bout_id", as_index=False).agg(
        p=("p", "mean"), y=("y", "first"), market=("market", "first")
    )
    return g.sort_values("bout_id").reset_index(drop=True)


def summarize_oof(oof: pd.DataFrame, arms: list[str], seeds: list[int]) -> dict:
    res: dict = {"arms": {}, "seeds": seeds}
    for arm in arms:
        per_seed = {}
        for seed in seeds:
            a = oof[(oof["label"] == arm) & (oof["seed"] == seed)].reset_index(drop=True)
            b = oof[(oof["label"] == "baseline") & (oof["seed"] == seed)].reset_index(drop=True)
            if a.empty or b.empty:
                continue
            a = a.sort_values("bout_id").reset_index(drop=True)
            b = b.sort_values("bout_id").reset_index(drop=True)
            entry = {"n": int(len(a)), "logloss": oof_logloss(a)}
            if arm != "baseline":
                entry["vs_baseline"] = paired_bootstrap(a, b)
            per_seed[str(seed)] = entry
        res["arms"][arm] = per_seed

    # Synthetic arms: the same fits, averaged over seeds. Compared against the
    # BAGGED baseline where one exists, so a bagging win is not double-counted
    # in an arm that also bags.
    base_bag = _bagged(oof, "baseline", seeds)
    if base_bag is not None:
        res["bagged"] = {}
        for arm in arms:
            bag = _bagged(oof, arm, seeds)
            if bag is None:
                continue
            entry = {"n": int(len(bag)), "logloss": oof_logloss(bag), "n_seeds": len(seeds)}
            if arm != "baseline":
                entry["vs_bagged_baseline"] = paired_bootstrap(bag, base_bag)
            else:
                single = oof[(oof["label"] == "baseline") & (oof["seed"] == seeds[0])]
                single = single.sort_values("bout_id").reset_index(drop=True)
                entry["vs_single_seed"] = paired_bootstrap(bag, single)
            res["bagged"][arm] = entry
    return res


def print_oof(res: dict) -> None:
    print(f"\n{'=' * 78}\nWALK-FORWARD OOF — 2017..2025, quarterly origins (selection basis)\n{'=' * 78}")
    print(f"  {'arm':16s} {'seed':>5} {'n':>6} {'logloss':>9} {'Δ vs base':>10} {'95% CI':>22} {'improves':>9}")
    for arm, per_seed in res["arms"].items():
        for seed, e in per_seed.items():
            if "vs_baseline" in e:
                v = e["vs_baseline"]
                ci = f"[{v['lo']:+.4f}, {v['hi']:+.4f}]"
                print(f"  {arm:16s} {seed:>5} {e['n']:>6} {e['logloss']:9.4f} "
                      f"{v['delta']:+10.4f} {ci:>22} {v['frac_improving']:>8.0%}")
            else:
                print(f"  {arm:16s} {seed:>5} {e['n']:>6} {e['logloss']:9.4f} "
                      f"{'—':>10} {'—':>22} {'—':>9}")
    if "bagged" in res:
        n_seeds = res["bagged"]["baseline"]["n_seeds"]
        print(f"\n  seed-averaged over {n_seeds} seeds (vs the bagged baseline; "
              f"the baseline row is vs its own single seed):")
        for arm, e in res["bagged"].items():
            v = e.get("vs_bagged_baseline") or e.get("vs_single_seed")
            ci = f"[{v['lo']:+.4f}, {v['hi']:+.4f}]"
            print(f"  {arm + '_bag':16s} {'—':>5} {e['n']:>6} {e['logloss']:9.4f} "
                  f"{v['delta']:+10.4f} {ci:>22} {v['frac_improving']:>8.0%}")


def run_test(arms: list[str], seeds: list[int], use_cache: bool) -> dict:
    """Static split, production semantics. Read AFTER the OOF selection."""
    df = load_symmetrized(use_cache)
    prep = prepare_splits(use_cache=use_cache)
    y_test = prep["splits"]["test"]["y"]
    market = prep["splits"]["test"]["market"]

    out: dict = {"seeds": seeds, "arms": {}, "bagged": {}}
    for arm in arms:
        per_seed, probs = [], []
        for seed in seeds:
            r = fit_arm(df, label=arm, seed=seed, keep_probs=True, **ARMS[arm])
            per_seed.append(r.as_dict())
            probs.append(r.probs_test)
            print(
                f"  {arm:16s} seed {seed:>4}  val {r.val['logloss']:.4f}  "
                f"test {r.test['logloss']:.4f}  acc {r.test['acc']:.4f}  "
                f"auc {r.test['auc']:.4f}  ({r.n_train_rows} train rows, blend {r.blend_mode})"
            )
        out["arms"][arm] = per_seed
        if len(probs) > 1:
            p_bag = np.mean(np.column_stack(probs), axis=1)
            out["bagged"][arm] = {
                "n_seeds": len(seeds),
                "headline": headline(p_bag, y_test),
                "buckets": bucket_table(p_bag, market, y_test),
                "murphy": murphy(p_bag, y_test),
            }
            h = out["bagged"][arm]["headline"]
            print(
                f"  {arm + '_bag':16s} {'—':>9}  {'':13s}test {h['logloss']:.4f}  "
                f"acc {h['acc']:.4f}  auc {h['auc']:.4f}"
            )
    return out


def print_test(res: dict) -> None:
    print(f"\n{'=' * 78}\nSTATIC SPLIT — val (429) / test (664), order-averaged\n{'=' * 78}")
    for arm, b in res.get("bagged", {}).items():
        h = b["headline"]
        print(f"  {arm + ' (bag of ' + str(b['n_seeds']) + ')':28s} test {h['logloss']:.4f}  "
              f"acc {h['acc']:.4f}  auc {h['auc']:.4f}  sd {h['sd']:.4f}")
    base = res["arms"].get("baseline")
    print(f"  {'arm':16s} {'seed':>5} {'val':>8} {'test':>8} {'Δ test':>8} {'acc':>7} {'auc':>7}")
    for arm, per_seed in res["arms"].items():
        for i, e in enumerate(per_seed):
            dt = (
                e["test"]["logloss"] - base[i]["test"]["logloss"]
                if base is not None and arm != "baseline" and i < len(base)
                else float("nan")
            )
            print(
                f"  {arm:16s} {e['seed']:>5} {e['val']['logloss']:8.4f} {e['test']['logloss']:8.4f} "
                f"{dt:+8.4f} {e['test']['acc']:7.4f} {e['test']['auc']:7.4f}"
            )


# ── where the deficit actually sits ─────────────────────────────────────


def run_diagnostic(seeds: list[int], use_cache: bool) -> dict:
    """Slice the model-vs-market gap on the OOF pool, not on 664 test rows.

    Every previous slice of this deficit was measured on the test split, where
    a segment with 80 bouts has a standard error of ±0.05 nats and any story
    fits. The OOF pool carries ~1,200 bouts WITH a closing line over eight
    years, which is enough to tell a real segment from a bin that happened to
    go badly.
    """
    if not OOF_CACHE.exists():
        raise SystemExit("run --stage oof first")
    oof = pd.read_parquet(OOF_CACHE)
    oof = oof[(oof["label"] == "baseline") & (oof["seed"] == seeds[0])].reset_index(drop=True)

    df = load_symmetrized(use_cache)
    ctx_cols = [
        "bout_id", "weight_class", "gender", "scheduled_rounds", "is_main_event",
        "prior_bouts_a", "prior_bouts_b", "layoff_days_a", "layoff_days_b",
        "age_a", "age_b", "elo_a", "elo_b",
    ]
    ctx = df[[c for c in ctx_cols if c in df.columns]].drop_duplicates("bout_id")
    ev = oof.merge(ctx, on="bout_id", how="left")

    with get_connection() as conn:
        ranks = fetch_rankings(conn)
    ev["event_date"] = pd.to_datetime(
        df.set_index("bout_id").loc[ev["bout_id"], "event_date"].to_numpy()
    )
    ev["fighter_a_id"] = df.set_index("bout_id").loc[ev["bout_id"], "fighter_a_id"].to_numpy()
    ev["fighter_b_id"] = df.set_index("bout_id").loc[ev["bout_id"], "fighter_b_id"].to_numpy()
    rf = build_rank_features(ev, ranks)
    ev = pd.concat([ev, rf], axis=1)

    has = ev["market"].notna().to_numpy()
    y = ev["y"].to_numpy().astype(float)
    p = np.clip(ev["p"].to_numpy(dtype=float), 1e-6, 1 - 1e-6)
    m = np.clip(ev["market"].to_numpy(dtype=float), 1e-6, 1 - 1e-6)

    def ll(pp: np.ndarray, yy: np.ndarray) -> float:
        return float(-(yy * np.log(pp) + (1 - yy) * np.log(1 - pp)).mean())

    ranked_a = (ev["rank_is_ranked_a"].fillna(0) > 0).to_numpy()
    ranked_b = (ev["rank_is_ranked_b"].fillna(0) > 0).to_numpy()
    min_bouts = np.minimum(
        pd.to_numeric(ev["prior_bouts_a"], errors="coerce").fillna(0),
        pd.to_numeric(ev["prior_bouts_b"], errors="coerce").fillna(0),
    ).to_numpy()
    max_layoff = np.maximum(
        pd.to_numeric(ev["layoff_days_a"], errors="coerce").fillna(0),
        pd.to_numeric(ev["layoff_days_b"], errors="coerce").fillna(0),
    ).to_numpy()
    conf = np.maximum(m, 1 - m)

    segments: dict[str, np.ndarray] = {
        "ALL": np.ones(len(ev), dtype=bool),
        "both ranked": ranked_a & ranked_b,
        "one ranked": ranked_a ^ ranked_b,
        "neither ranked": ~(ranked_a | ranked_b),
        "5-round": (ev["scheduled_rounds"] == 5).to_numpy(),
        "3-round": (ev["scheduled_rounds"] == 3).to_numpy(),
        "main event": (ev["is_main_event"] == True).to_numpy(),  # noqa: E712
        "women": (ev["gender"] == "female").to_numpy(),
        "men": (ev["gender"] == "male").to_numpy(),
        "heavy (LHW+HW)": ev["weight_class"].isin(["light_heavyweight", "heavyweight"]).to_numpy(),
        "min prior <= 2": min_bouts <= 2,
        "min prior >= 6": min_bouts >= 6,
        "layoff > 400d": max_layoff > 400,
        "market conf < 0.60": conf < 0.60,
        "market conf 0.60-0.72": (conf >= 0.60) & (conf < 0.72),
        "market conf 0.72+": conf >= 0.72,
    }
    rows = []
    for name, sel in segments.items():
        s = sel & has
        if s.sum() < 40:
            continue
        rows.append(
            {
                "segment": name,
                "n": int(s.sum()),
                "model": ll(p[s], y[s]),
                "market": ll(m[s], y[s]),
                "gap": ll(p[s], y[s]) - ll(m[s], y[s]),
                "share_of_total_gap": float(
                    s.sum()
                    * (ll(p[s], y[s]) - ll(m[s], y[s]))
                    / (has.sum() * (ll(p[has], y[has]) - ll(m[has], y[has])))
                ),
            }
        )
    return {"n_with_odds": int(has.sum()), "segments": rows}


def print_diagnostic(res: dict) -> None:
    print(f"\n{'=' * 78}\nWHERE THE GAP SITS — OOF pool, {res['n_with_odds']} bouts with a closing line\n{'=' * 78}")
    print(f"  {'segment':24s} {'n':>6} {'model':>8} {'market':>8} {'gap':>8} {'% of gap':>9}")
    for r in res["segments"]:
        print(
            f"  {r['segment']:24s} {r['n']:>6} {r['model']:8.4f} {r['market']:8.4f} "
            f"{r['gap']:+8.4f} {r['share_of_total_gap']:>8.0%}"
        )


def _oof_context(seeds: list[int], use_cache: bool) -> pd.DataFrame:
    """The OOF pool joined to the per-bout context a segment needs.

    Shared by the bias and correction stages so both are looking at exactly the
    same rows and the same definitions.
    """
    if not OOF_CACHE.exists():
        raise SystemExit("run --stage oof first")
    oof = pd.read_parquet(OOF_CACHE)
    oof = oof[(oof["label"] == "baseline") & (oof["seed"] == seeds[0])].reset_index(drop=True)

    df = load_symmetrized(use_cache).set_index("bout_id")
    take = [
        "weight_class", "gender", "scheduled_rounds", "is_main_event", "event_date",
        "fighter_a_id", "fighter_b_id", "prior_bouts_a", "prior_bouts_b",
        "layoff_days_a", "layoff_days_b", "age_a", "age_b",
    ]
    for col in take:
        if col in df.columns:
            oof[col] = df.loc[oof["bout_id"], col].to_numpy()
    oof["event_date"] = pd.to_datetime(oof["event_date"])

    with get_connection() as conn:
        ranks = fetch_rankings(conn)
    return pd.concat([oof, build_rank_features(oof, ranks)], axis=1)


def run_bias(seeds: list[int], use_cache: bool) -> dict:
    """Is the segment deficit a BIAS or just noise?

    A log-loss gap on a slice says the book is sharper there; it does not say we
    are wrong in a fixable direction. This asks the sharper question: inside a
    slice, take the side the slice is about (the one coming off a long layoff,
    the ranked one) and compare what we say about it, what the book says, and
    what actually happened. Three numbers, and only one arrangement of them —
    ours above both the book's and the truth — means a systematic bias rather
    than missing sharpness.
    """
    ev = _oof_context(seeds, use_cache)
    has = ev["market"].notna().to_numpy()
    y = ev["y"].to_numpy().astype(float)
    p = ev["p"].to_numpy(dtype=float)
    m = ev["market"].to_numpy(dtype=float)

    lay_a = pd.to_numeric(ev["layoff_days_a"], errors="coerce").to_numpy()
    lay_b = pd.to_numeric(ev["layoff_days_b"], errors="coerce").to_numpy()
    rk_a = (ev["rank_is_ranked_a"].fillna(0) > 0).to_numpy()
    rk_b = (ev["rank_is_ranked_b"].fillna(0) > 0).to_numpy()
    exp_a = pd.to_numeric(ev["prior_bouts_a"], errors="coerce").fillna(0).to_numpy()
    exp_b = pd.to_numeric(ev["prior_bouts_b"], errors="coerce").fillna(0).to_numpy()
    age_a = pd.to_numeric(ev["age_a"], errors="coerce").to_numpy()
    age_b = pd.to_numeric(ev["age_b"], errors="coerce").to_numpy()

    # Each probe names a side: "the side this slice is about is in slot A".
    probes = {
        "layoff >400d vs <200d": (
            (lay_a > 400) & (lay_b < 200),
            (lay_b > 400) & (lay_a < 200),
        ),
        "layoff >600d vs <200d": (
            (lay_a > 600) & (lay_b < 200),
            (lay_b > 600) & (lay_a < 200),
        ),
        "ranked vs unranked": (rk_a & ~rk_b, rk_b & ~rk_a),
        "champion vs non-champ": (
            (ev["rank_is_champ_a"].fillna(0) > 0).to_numpy() & ~(ev["rank_is_champ_b"].fillna(0) > 0).to_numpy(),
            (ev["rank_is_champ_b"].fillna(0) > 0).to_numpy() & ~(ev["rank_is_champ_a"].fillna(0) > 0).to_numpy(),
        ),
        "10+ bouts vs <=2": ((exp_a >= 10) & (exp_b <= 2), (exp_b >= 10) & (exp_a <= 2)),
        "35+ yrs vs <=28": ((age_a >= 35) & (age_b <= 28), (age_b >= 35) & (age_a <= 28)),
    }
    rows = []
    for name, (sel_a, sel_b) in probes.items():
        sel_a, sel_b = sel_a & has, sel_b & has
        n = int(sel_a.sum() + sel_b.sum())
        if n < 40:
            continue
        # Orient every row so the named side is the one being scored.
        p_side = np.concatenate([p[sel_a], 1 - p[sel_b]])
        m_side = np.concatenate([m[sel_a], 1 - m[sel_b]])
        y_side = np.concatenate([y[sel_a], 1 - y[sel_b]])
        rows.append(
            {
                "probe": name,
                "n": n,
                "model_mean_p": float(p_side.mean()),
                "market_mean_p": float(m_side.mean()),
                "actual_rate": float(y_side.mean()),
                "model_minus_actual": float(p_side.mean() - y_side.mean()),
                "market_minus_actual": float(m_side.mean() - y_side.mean()),
            }
        )
    return {"probes": rows}


def print_bias(res: dict) -> None:
    print(f"\n{'=' * 78}\nBIAS PROBES — the named side is in slot A (OOF pool, odds subset)\n{'=' * 78}")
    print(f"  {'probe':26s} {'n':>5} {'model p':>8} {'market p':>9} {'actual':>7} "
          f"{'mod−act':>8} {'mkt−act':>8}")
    for r in res["probes"]:
        print(
            f"  {r['probe']:26s} {r['n']:>5} {r['model_mean_p']:8.3f} {r['market_mean_p']:9.3f} "
            f"{r['actual_rate']:7.3f} {r['model_minus_actual']:+8.3f} {r['market_minus_actual']:+8.3f}"
        )


def _correction_blocks(ev: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Candidate correction blocks, all antisymmetric in the two sides.

    Every column is (A minus B) — the same discipline features.py uses — so a
    correction fitted here cannot learn a slot preference, and applying it to
    both orderings before averaging leaves the served quantity symmetric.
    """
    eff_a = ev["rank_best_a"].fillna(UNRANKED_LEVEL)
    eff_b = ev["rank_best_b"].fillna(UNRANKED_LEVEL)
    lay_a = pd.to_numeric(ev["layoff_days_a"], errors="coerce").fillna(180).clip(0, 1500)
    lay_b = pd.to_numeric(ev["layoff_days_b"], errors="coerce").fillna(180).clip(0, 1500)
    exp_a = pd.to_numeric(ev["prior_bouts_a"], errors="coerce").fillna(0)
    exp_b = pd.to_numeric(ev["prior_bouts_b"], errors="coerce").fillna(0)
    age_a = pd.to_numeric(ev["age_a"], errors="coerce")
    age_b = pd.to_numeric(ev["age_b"], errors="coerce")

    rank = pd.DataFrame(
        {
            "d_ranked": (ev["rank_is_ranked_a"].fillna(0) - ev["rank_is_ranked_b"].fillna(0)),
            "d_eff_rank": (eff_a - eff_b) / 10.0,
            "d_champ": (ev["rank_is_champ_a"].fillna(0) - ev["rank_is_champ_b"].fillna(0)),
        },
        index=ev.index,
    ).fillna(0.0)
    age = pd.DataFrame(
        {
            "d_age": (age_a - age_b).fillna(0) / 10.0,
            "d_old": ((age_a >= 35).astype(float) - (age_b >= 35).astype(float)).fillna(0),
        },
        index=ev.index,
    )
    other = pd.DataFrame(
        {
            "d_layoff_y": (lay_a - lay_b) / 365.0,
            "d_long_layoff": ((lay_a > 400).astype(float) - (lay_b > 400).astype(float)),
            "d_log_exp": (np.log1p(exp_a) - np.log1p(exp_b)),
        },
        index=ev.index,
    ).fillna(0.0)
    # Parameterisation variants for the age block. Shipping two coefficients
    # where one does the work is two chances to be wrong later, so the simplest
    # form that holds is the one that goes in.
    age1 = pd.DataFrame({"d_age": age["d_age"]}, index=ev.index)
    age_curv = pd.DataFrame(
        {
            "d_age": age["d_age"],
            # Both-old vs both-young at the same GAP: two 38-year-olds is a
            # different fight from two 26-year-olds, and the diff column cannot
            # see it. Symmetric in the sides, so it survives the swap unchanged.
            "mean_age": ((age_a + age_b) / 2 - 30).fillna(0) / 10.0,
        },
        index=ev.index,
    )
    return {
        "rank": rank,
        "age1": age1,
        "age": age,
        "age_curv": age_curv,
        "rank+age": pd.concat([rank, age], axis=1),
        "rank+age+other": pd.concat([rank, age, other], axis=1),
    }


def _fit_offset_logit(
    z: np.ndarray, B: np.ndarray, y: np.ndarray, free_slope: bool, intercept: bool = True
) -> tuple[float, np.ndarray, float]:
    """Fit  P = sigmoid(a·z + B·w + c)  by log-loss.

    `free_slope=False` pins a = 1, which makes the result a pure ADDITIVE
    correction in logit space. That matters for shipping, not for scoring: the
    corrector is fitted on walk-forward models trained on less data than the
    served one, so a fitted slope would carry that sharpness difference into
    production, where it does not belong. An offset carries only the direction.
    """

    def nll(theta: np.ndarray) -> float:
        a = theta[0] if free_slope else 1.0
        w = theta[1:-1] if free_slope else theta[:-1]
        c = float(theta[-1]) if intercept else 0.0
        if not intercept:
            w = theta[1:] if free_slope else theta
        p = 1.0 / (1.0 + np.exp(-np.clip(a * z + B @ w + c, -30, 30)))
        p = np.clip(p, 1e-9, 1 - 1e-9)
        return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())

    k = B.shape[1]
    start = np.concatenate(
        ([1.0] if free_slope else [], np.zeros(k), [0.0] if intercept else [])
    )
    res = minimize(nll, start, method="L-BFGS-B")
    theta = res.x
    a = float(theta[0]) if free_slope else 1.0
    if intercept:
        w = theta[1:-1] if free_slope else theta[:-1]
        c = float(theta[-1])
    else:
        w = theta[1:] if free_slope else theta
        c = 0.0
    return a, np.asarray(w, dtype=float), c


def _apply_correction(
    p: np.ndarray, B: np.ndarray, a: float, w: np.ndarray, c: float
) -> np.ndarray:
    z = np.log(np.clip(p, 1e-9, 1 - 1e-9) / (1 - np.clip(p, 1e-9, 1 - 1e-9)))
    return 1.0 / (1.0 + np.exp(-np.clip(a * z + B @ w + c, -30, 30)))


def run_correction(seeds: list[int], use_cache: bool) -> dict:
    """A post-hoc correction layer, fitted on OOF and read once on test.

    The bias probe says we give a 35-year-old facing a 28-year-old a 0.371
    chance where the truth is 0.164, and rate a ranked fighter facing an
    unranked one at 0.506 where the truth is 0.618. Those are DIRECTIONS, not
    sharpness deficits, and a direction can be corrected after the fact — if it
    survives cross-fitting on a sample big enough to see it, a forward split in
    time, and a seed change. Anything that fails one of those three is the
    2024-window fit the rank block already turned out to be.

    Applied per orientation, inside the order averaging — the placement
    EnsembleModel.calibrator occupies — so the served quantity stays symmetric:
    every block column is (A − B) and negates on the swap.
    """
    ev = _oof_context(seeds, use_cache)
    y = ev["y"].to_numpy().astype(float)
    blocks = _correction_blocks(ev)
    origin = pd.to_datetime(ev["origin"])
    early = (origin < "2022-01-01").to_numpy()

    prep = prepare_splits(use_cache=use_cache)
    ens = prep["ensemble"]
    # Strip the shipped corrector before measuring. Once v0.13.0 landed the
    # eval artifacts carry it, and a rerun would otherwise fit a correction on
    # top of a corrected model and report a delta near zero — which reads as
    # "the lab was wrong" rather than "the lab already shipped".
    if getattr(ens, "corrector", None) is not None:
        print(f"  (stripping the shipped corrector to measure: {ens.corrector.describe()})")
        ens.corrector = None
    sp = prep["splits"]["test"]
    p_te = ens.predict_proba_a(sp["X"])
    p_te_sw = ens.predict_proba_a(sp["X_swapped"])
    y_te = sp["y"].astype(float)
    market_te = sp["market"]
    base_test = 0.5 * (p_te + (1.0 - p_te_sw))

    df_te = load_symmetrized(use_cache)
    df_te = df_te[pd.to_datetime(df_te["event_date"]) >= "2025-01-01"].reset_index(drop=True)
    with get_connection() as conn:
        ranks = fetch_rankings(conn)
    ev_te = pd.concat([df_te, build_rank_features(df_te, ranks)], axis=1)
    assert len(ev_te) == len(y_te), f"test context misaligned: {len(ev_te)} vs {len(y_te)}"
    blocks_te = _correction_blocks(ev_te)
    te_dates = pd.to_datetime(ev_te["event_date"])
    te_mid = te_dates.median()

    def ll(p: np.ndarray, yy: np.ndarray) -> float:
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return float(-(yy * np.log(p) + (1 - yy) * np.log(1 - p)).mean())

    def boot(p_c: np.ndarray, p_b: np.ndarray, yy: np.ndarray, seed: int = 11) -> dict:
        eps = 1e-6
        lc = -(yy * np.log(np.clip(p_c, eps, 1 - eps)) + (1 - yy) * np.log(np.clip(1 - p_c, eps, 1)))
        lb = -(yy * np.log(np.clip(p_b, eps, 1 - eps)) + (1 - yy) * np.log(np.clip(1 - p_b, eps, 1)))
        d = lc - lb
        rng = np.random.default_rng(seed)
        bs = np.array([d[rng.integers(0, len(d), len(d))].mean() for _ in range(4000)])
        return {
            "delta": float(d.mean()),
            "lo": float(np.percentile(bs, 2.5)),
            "hi": float(np.percentile(bs, 97.5)),
            "frac_improving": float((bs < 0).mean()),
        }

    out: dict = {
        "n_oof": int(len(y)),
        "raw_oof_logloss": ll(ev["p"].to_numpy(dtype=float), y),
        "baseline_test_logloss": ll(base_test, y_te),
        "n_early": int(early.sum()),
        "n_late": int((~early).sum()),
        "candidates": {},
    }

    for name, block in blocks.items():
        B = block.to_numpy(dtype=float)
        B_te = blocks_te[name].to_numpy(dtype=float)
        for mode in ("pure", "offset", "free"):
            free = mode == "free"
            use_intercept = mode != "pure"
            p_oof = ev["p"].to_numpy(dtype=float)
            z_oof = np.log(np.clip(p_oof, 1e-9, 1 - 1e-9) / (1 - np.clip(p_oof, 1e-9, 1 - 1e-9)))

            # 1. Cross-fitted on the whole OOF pool.
            cf = np.zeros(len(y))
            skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
            for tr, te in skf.split(B, y.astype(int)):
                a, w, c = _fit_offset_logit(z_oof[tr], B[tr], y[tr], free, use_intercept)
                cf[te] = _apply_correction(p_oof[te], B[te], a, w, c)

            # 2. Forward in time: fit on pre-2022 origins, score the rest. No
            #    fold shuffling, so a correction that only works because the
            #    folds share an era cannot pass this one.
            a_e, w_e, c_e = _fit_offset_logit(z_oof[early], B[early], y[early], free, use_intercept)
            p_late = _apply_correction(p_oof[~early], B[~early], a_e, w_e, c_e)

            # 3. Fitted on ALL of OOF, read once on test.
            a_f, w_f, c_f = _fit_offset_logit(z_oof, B, y, free, use_intercept)
            p_corr = 0.5 * (
                _apply_correction(p_te, B_te, a_f, w_f, c_f)
                + (1.0 - _apply_correction(p_te_sw, -B_te, a_f, w_f, c_f))
            )
            out["candidates"][f"{name}/{mode}"] = {
                "block": name,
                "mode": mode,
                "k": int(B.shape[1]),
                "crossfit_logloss": ll(cf, y),
                "crossfit_delta": ll(cf, y) - ll(p_oof, y),
                "crossfit_bootstrap": boot(cf, p_oof, y),
                "forward_delta": ll(p_late, y[~early]) - ll(p_oof[~early], y[~early]),
                "forward_bootstrap": boot(p_late, p_oof[~early], y[~early]),
                "test_logloss": ll(p_corr, y_te),
                "test_delta": ll(p_corr, y_te) - ll(base_test, y_te),
                "test_bootstrap": boot(p_corr, base_test, y_te),
                "test_buckets": bucket_table(p_corr, market_te, y_te.astype(int)),
                "test_headline": headline(p_corr, y_te.astype(int)),
                # The test window is 19 months; splitting it in half is one
                # more chance for a correction that only works on one stretch
                # of it to show itself.
                "test_halves": [
                    {
                        "half": lbl,
                        "n": int(sel.sum()),
                        "delta": ll(p_corr[sel], y_te[sel]) - ll(base_test[sel], y_te[sel]),
                    }
                    for lbl, sel in (
                        ("first", (te_dates < te_mid).to_numpy()),
                        ("second", (te_dates >= te_mid).to_numpy()),
                    )
                ],
                "params": {
                    "slope": a_f,
                    "intercept": c_f,
                    "weights": dict(zip(block.columns, [float(x) for x in w_f], strict=True)),
                },
            }
    return out


def print_correction(res: dict) -> None:
    print(f"\n{'=' * 92}\nCORRECTION LAYER — fitted on OOF ({res['n_oof']} bouts), read once on test\n{'=' * 92}")
    print(f"  raw OOF log-loss {res['raw_oof_logloss']:.4f} · test baseline "
          f"{res['baseline_test_logloss']:.4f} · forward split {res['n_early']}/{res['n_late']}")
    print(f"\n  {'block/mode':22s} {'k':>2} {'Δ OOF cf':>9} {'improv':>7} "
          f"{'Δ fwd':>9} {'improv':>7} {'Δ test':>9} {'improv':>7}")
    for name, c in res["candidates"].items():
        print(
            f"  {name:22s} {c['k']:>2} {c['crossfit_delta']:+9.4f} "
            f"{c['crossfit_bootstrap']['frac_improving']:>6.0%} "
            f"{c['forward_delta']:+9.4f} {c['forward_bootstrap']['frac_improving']:>6.0%} "
            f"{c['test_delta']:+9.4f} {c['test_bootstrap']['frac_improving']:>6.0%}"
        )
    best = min(res["candidates"].items(), key=lambda kv: kv[1]["test_delta"])
    print(f"\n  parameters of {best[0]}:")
    pr = best[1]["params"]
    print(f"    slope {pr['slope']:+.4f}  intercept {pr['intercept']:+.4f}")
    for k, v in pr["weights"].items():
        print(f"    {k:16s} {v:+.4f}")
    h = best[1]["test_headline"]
    print(f"\n  {best[0]} on test: logloss {h['logloss']:.4f}  acc {h['acc']:.4f}  "
          f"auc {h['auc']:.4f}  sd {h['sd']:.4f}")
    halves = " · ".join(
        f"{h['half']} (n={h['n']}) {h['delta']:+.4f}" for h in best[1]["test_halves"]
    )
    print(f"  test halves: {halves}")
    print(f"\n  test buckets for {best[0]} (market-confidence):")
    for b in best[1]["test_buckets"]:
        print(f"    {b['lo']:.2f}-{b['hi']:.2f}  n={b['n']:4d}  model {b['model']:.4f}  "
              f"market {b['market']:.4f}  gap {b['gap']:+.4f}")

# ── calibration, fitted where there is enough data to fit it ────────────


def _fit_calibrator(
    family: str, p_raw: np.ndarray, p_sw: np.ndarray, y: np.ndarray
) -> ProbabilityCalibrator:
    """Fit one family by minimizing the log-loss of the SERVED quantity.

    The calibrator lives inside `predict_proba_a`, i.e. inside the order
    averaging, so the objective is ½·[g(f(A,B)) + 1 − g(f(B,A))] — not g of the
    already-averaged probability. Fitting against the wrong one of those two
    optimizes a quantity production never computes.
    """
    spec = CALIBRATOR_FAMILIES[family]

    def objective(params: np.ndarray) -> float:
        cal = ProbabilityCalibrator(family, list(params))
        if not cal.is_monotone():
            return 1e6
        p = 0.5 * (cal.transform(p_raw) + (1.0 - cal.transform(p_sw)))
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())

    best, best_ll = None, float("inf")
    for start in spec["starts"]:
        res = minimize(objective, np.array(start, dtype=float), method="Nelder-Mead")
        if res.fun < best_ll:
            best, best_ll = res.x, float(res.fun)
    return ProbabilityCalibrator(family, list(best))


def run_calibration(seeds: list[int], use_cache: bool, recent_from: str = "2022-01-01") -> dict:
    """Fit every calibrator family on walk-forward OOF, read it once on test.

    This lever was measured before (docs/tail_resolution.md) and refused,
    because the gate then was "close the tail bucket" and a monotone map
    provably cannot: it sharpens the coin-flips, where we already beat the
    book, by as much as the heavy favourites. The question here is the
    different one the user asked — does it reduce log-loss — so it is
    re-measured on today's artifacts rather than inherited.
    """
    if not OOF_CACHE.exists():
        raise SystemExit("run --stage oof first (needs the baseline OOF pool)")
    oof = pd.read_parquet(OOF_CACHE)
    oof = oof[(oof["label"] == "baseline") & (oof["seed"] == seeds[0])].reset_index(drop=True)
    y_oof = oof["y"].to_numpy().astype(float)

    prep = prepare_splits(use_cache=use_cache)
    ens = prep["ensemble"]
    # Strip the shipped corrector before measuring. Once v0.13.0 landed the
    # eval artifacts carry it, and a rerun would otherwise fit a correction on
    # top of a corrected model and report a delta near zero — which reads as
    # "the lab was wrong" rather than "the lab already shipped".
    if getattr(ens, "corrector", None) is not None:
        print(f"  (stripping the shipped corrector to measure: {ens.corrector.describe()})")
        ens.corrector = None
    sp = prep["splits"]["test"]
    p_te = ens.predict_proba_a(sp["X"])
    p_te_sw = ens.predict_proba_a(sp["X_swapped"])
    y_te = sp["y"].astype(float)
    market = sp["market"]

    def served(p: np.ndarray, p_sw: np.ndarray, cal: ProbabilityCalibrator | None) -> np.ndarray:
        if cal is None:
            return 0.5 * (p + (1.0 - p_sw))
        return 0.5 * (cal.transform(p) + (1.0 - cal.transform(p_sw)))

    def ll(p: np.ndarray, y: np.ndarray) -> float:
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())

    pools = {
        "all_oof": np.ones(len(oof), dtype=bool),
        f"oof_{recent_from[:4]}+": (oof["origin"] >= recent_from).to_numpy(),
    }
    base_oof = ll(served(oof["p_raw"].to_numpy(), oof["p_sw"].to_numpy(), None), y_oof)
    base_test = ll(served(p_te, p_te_sw, None), y_te)

    out: dict = {
        "n_oof": int(len(oof)),
        "n_test": int(len(y_te)),
        "baseline_oof_logloss": base_oof,
        "baseline_test_logloss": base_test,
        "fits": {},
    }
    for pool_name, mask in pools.items():
        for family in CALIBRATOR_FAMILIES:
            cal = _fit_calibrator(
                family,
                oof.loc[mask, "p_raw"].to_numpy(),
                oof.loc[mask, "p_sw"].to_numpy(),
                y_oof[mask],
            )
            p_fit = served(oof.loc[mask, "p_raw"].to_numpy(), oof.loc[mask, "p_sw"].to_numpy(), cal)
            p_all = served(oof["p_raw"].to_numpy(), oof["p_sw"].to_numpy(), cal)
            p_test = served(p_te, p_te_sw, cal)
            out["fits"][f"{pool_name}/{family}"] = {
                "pool": pool_name,
                "family": family,
                "params": cal.params,
                "n_fit": int(mask.sum()),
                "fit_pool_logloss": ll(p_fit, y_oof[mask]),
                "all_oof_logloss": ll(p_all, y_oof),
                "all_oof_delta": ll(p_all, y_oof) - base_oof,
                "test_logloss": ll(p_test, y_te),
                "test_delta": ll(p_test, y_te) - base_test,
                "test_buckets": bucket_table(p_test, market, y_te.astype(int)),
                "test_murphy": murphy(p_test, y_te.astype(int)),
            }
    return out


def print_calibration(res: dict) -> None:
    print(f"\n{'=' * 78}\nCALIBRATION — fitted on walk-forward OOF, read once on test\n{'=' * 78}")
    print(
        f"  baseline: OOF {res['baseline_oof_logloss']:.4f} (n={res['n_oof']})  ·  "
        f"test {res['baseline_test_logloss']:.4f} (n={res['n_test']})"
    )
    print(f"\n  {'fit':22s} {'n fit':>6} {'params':>26} {'ΔOOF(all)':>10} {'Δtest':>9}")
    for name, f in res["fits"].items():
        params = " ".join(f"{p:+.3f}" for p in f["params"])
        print(
            f"  {name:22s} {f['n_fit']:>6} {params:>26} "
            f"{f['all_oof_delta']:+10.4f} {f['test_delta']:+9.4f}"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="oof", choices=("oof", "test", "calib", "diag", "bias", "correct"))
    ap.add_argument("--arms", default=",".join(ARMS))
    ap.add_argument("--seeds", default="42")
    ap.add_argument("--cache", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="ignore the OOF parquet cache")
    args = ap.parse_args()

    arms = [a for a in args.arms.split(",") if a]
    unknown = [a for a in arms if a not in ARMS]
    if unknown:
        raise SystemExit(f"unknown arms: {unknown}")
    seeds = [int(s) for s in args.seeds.split(",")]

    payload: dict = json.loads(ARTIFACT_PATH.read_text()) if ARTIFACT_PATH.exists() else {}
    if args.stage == "oof":
        if "baseline" not in arms:
            arms = ["baseline", *arms]
        oof = run_oof(arms, seeds, args.cache, reuse=not args.fresh)
        res = summarize_oof(oof, arms, seeds)
        print_oof(res)
        payload["oof"] = res
    elif args.stage == "test":
        if "baseline" not in arms:
            arms = ["baseline", *arms]
        res = run_test(arms, seeds, args.cache)
        print_test(res)
        payload["test"] = res
    elif args.stage == "calib":
        res = run_calibration(seeds, args.cache)
        print_calibration(res)
        payload["calibration"] = res
    elif args.stage == "diag":
        res = run_diagnostic(seeds, args.cache)
        print_diagnostic(res)
        payload["diagnostic"] = res
    elif args.stage == "bias":
        res = run_bias(seeds, args.cache)
        print_bias(res)
        payload["bias"] = res
    elif args.stage == "correct":
        res = run_correction(seeds, args.cache)
        print_correction(res)
        payload["correction"] = res

    ARTIFACT_PATH.write_text(json.dumps(payload, indent=1, default=str))
    print(f"\nwrote {ARTIFACT_PATH}")


if __name__ == "__main__":
    main()

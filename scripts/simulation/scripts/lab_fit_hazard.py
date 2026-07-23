"""Fit the discrete-time competing-risks finish hazard (Stage 1 of the
round-level-signals lab) and grade it against what the Monte Carlo does today.

Splits are the production ones: train < TRAIN_END, val in [TRAIN_END, VAL_END)
for the L2 penalty, test >= VAL_END reported once at the end.

Exclusions, all of them data-quality rather than convenience:
  * 10 bouts whose round stats show more rounds than `scheduled_rounds`
    (scheduled_rounds is unreliable on those, and it is a covariate here);
  * bouts with round_finished = 1 and time_finished_seconds > 300 — the
    pre-2000 long-round format, whose elapsed-time reconstruction is wrong;
  * no-contests and DQs, which are not KO / submission / decision outcomes.
Draws stay in as right-censored: they went to the scorecards, which is exactly
what "no finish" means here.

Usage (from scripts/simulation, venv active):
  python scripts/lab_fit_hazard.py
  python scripts/lab_fit_hazard.py --bin-seconds 15
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.table import Table  # noqa: E402
from sklearn.linear_model import PoissonRegressor  # noqa: E402

from src.config import ARTIFACTS_DIR, DATA_DIR, TRAIN_END, VAL_END  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.finish_hazard import (  # noqa: E402
    BIN_SECONDS,
    SECONDS_PER_ROUND,
    BoutSurvival,
    FinishHazardModel,
    current_mc_hazard_arrays,
    design_columns,
    expand_person_periods,
    fitted_hazard_arrays,
    integrate_outcomes,
    survival_loglik,
    time_basis_names,
)
from src.monte_carlo import FighterMC  # noqa: E402

console = Console()

# Two artifacts, mirroring the ensemble / ensemble_eval convention in train.py:
# the SERVED model is refit on all data so production carries the most recent
# fights, while the split-trained twin stays the source of honest held-out
# numbers. Grading the served model on the test window would be in-sample.
ARTIFACT_PATH = ARTIFACTS_DIR / "finish_hazard.json"
EVAL_ARTIFACT_PATH = ARTIFACTS_DIR / "finish_hazard_eval.json"
REPORT_PATH = ARTIFACTS_DIR / "lab_finish_hazard.json"
CACHE_PATH = DATA_DIR / "rolling_dataset.parquet"
ALPHAS = (1e-4, 1e-3, 1e-2, 3e-2, 1e-1, 3e-1, 1.0)

OUTCOME_SQL = """
SELECT
  b.id::text                AS bout_id,
  b.fighter_a_id::text      AS fighter_a_id,
  b.winner_id::text         AS winner_id,
  b.method::text            AS method,
  b.round_finished          AS round_finished,
  b.time_finished_seconds   AS time_finished_seconds,
  b.scheduled_rounds        AS scheduled_rounds,
  b.is_main_event           AS is_main_event,
  b.is_title_fight          AS is_title_fight,
  (SELECT COUNT(DISTINCT round) FROM bout_round_stats s WHERE s.bout_id = b.id)
                            AS observed_rounds
FROM bout b
WHERE b.id = ANY(%s::uuid[]) AND b.status = 'completed'
"""


def _cause(method: str | None) -> str | None:
    if method in ("ko", "tko"):
        return "ko"
    if method == "submission":
        return "sub"
    if method is not None and method.startswith("decision"):
        return None  # censored at the bell
    return "SKIP"  # dq / no_contest / unknown — not a gradeable outcome


def build_survival_set(df: pd.DataFrame) -> tuple[list[BoutSurvival], dict]:
    with get_connection() as conn, conn.cursor() as cur:
        cur.execute(OUTCOME_SQL, (df["bout_id"].tolist(),))
        cols = [d[0] for d in cur.description]
        rows = {r[0]: dict(zip(cols, r, strict=True)) for r in cur.fetchall()}

    bouts: list[BoutSurvival] = []
    skipped = {"no_db_row": 0, "ungradeable_method": 0, "sched_mismatch": 0,
               "legacy_long_round": 0, "bad_timing": 0}

    for i in range(len(df)):
        row = df.iloc[i]
        r = rows.get(row["bout_id"])
        if r is None:
            skipped["no_db_row"] += 1
            continue
        cause = _cause(r["method"])
        if cause == "SKIP":
            skipped["ungradeable_method"] += 1
            continue
        sched = int(r["scheduled_rounds"] or 3)
        if (r["observed_rounds"] or 0) > sched:
            skipped["sched_mismatch"] += 1
            continue
        rf, tf = r["round_finished"], r["time_finished_seconds"]
        if rf == 1 and tf is not None and tf > SECONDS_PER_ROUND:
            skipped["legacy_long_round"] += 1
            continue

        w = r["winner_id"]
        if w == row["fighter_a_id"]:
            winner_side = 0
        elif w == row["fighter_b_id"]:
            winner_side = 1
        else:
            winner_side = None  # draw — censored, and not method-gradeable

        if cause is None:
            end = float(sched * SECONDS_PER_ROUND)
            side = None
        else:
            if rf is None or tf is None:
                skipped["bad_timing"] += 1
                continue
            end = float((int(rf) - 1) * SECONDS_PER_ROUND + float(tf))
            if not 0 < end <= sched * SECONDS_PER_ROUND:
                skipped["bad_timing"] += 1
                continue
            if winner_side is None:
                skipped["bad_timing"] += 1
                continue
            side = winner_side

        snap_a = {k[:-2]: row[k] for k in row.index if k.endswith("_a") and k != "fighter_a_id"}
        snap_b = {k[:-2]: row[k] for k in row.index if k.endswith("_b") and k != "fighter_b_id"}
        bouts.append(
            BoutSurvival(
                bout_id=row["bout_id"],
                event_date=pd.to_datetime(row["event_date"]),
                scheduled_rounds=sched,
                is_main_event=bool(r["is_main_event"]),
                is_title_fight=bool(r["is_title_fight"]),
                end_seconds=end,
                cause=cause,
                finisher_side=side,
                winner_side=winner_side,
                # FighterMC applies the shrinkage the MC serves with, so the
                # hazard is fitted on exactly the numbers it will see live.
                snap_a=FighterMC.from_snapshot(snap_a),
                snap_b=FighterMC.from_snapshot(snap_b),
            )
        )
    return bouts, skipped


def fit_cause(
    T: np.ndarray, Xs: np.ndarray, expo: np.ndarray, y: np.ndarray, alpha: float
) -> PoissonRegressor:
    """Poisson with exposure via the standard offset trick: regress the RATE
    (events / exposure) weighted by exposure, which has the same likelihood as
    a log-link Poisson with log(exposure) as an offset."""
    design = np.hstack([T, Xs])
    model = PoissonRegressor(alpha=alpha, max_iter=1000, tol=1e-7)
    model.fit(design, y / expo, sample_weight=expo)
    return model


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bin-seconds", type=int, default=BIN_SECONDS)
    args = ap.parse_args()

    if CACHE_PATH.exists():
        console.log(f"loading cached dataset from {CACHE_PATH}")
        df = pd.read_parquet(CACHE_PATH)
    else:
        df = symmetrize_for_training(build_dataset(fetch_raw(), include_debuts=True))
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)

    bouts, skipped = build_survival_set(df)
    console.log(f"{len(bouts):,} bouts in the survival set · skipped {skipped}")

    dates = pd.to_datetime([b.event_date for b in bouts])
    tr = [b for b, d in zip(bouts, dates, strict=True) if d < pd.to_datetime(TRAIN_END)]
    va = [b for b, d in zip(bouts, dates, strict=True)
          if pd.to_datetime(TRAIN_END) <= d < pd.to_datetime(VAL_END)]
    te = [b for b, d in zip(bouts, dates, strict=True) if d >= pd.to_datetime(VAL_END)]
    console.log(f"split — train {len(tr):,} · val {len(va):,} · test {len(te):,}")

    T_tr, X_tr, e_tr, ko_tr, sub_tr = expand_person_periods(tr, args.bin_seconds)
    console.log(
        f"person-period rows: {len(T_tr):,} "
        f"({int(ko_tr.sum())} KO events, {int(sub_tr.sum())} sub events)"
    )

    cov_mean = X_tr.mean(axis=0)
    cov_std = X_tr.std(axis=0)
    cov_std[cov_std < 1e-9] = 1.0
    Xs_tr = (X_tr - cov_mean) / cov_std

    def build_model(alpha: float) -> FinishHazardModel:
        m_ko = fit_cause(T_tr, Xs_tr, e_tr, ko_tr, alpha)
        m_sub = fit_cause(T_tr, Xs_tr, e_tr, sub_tr, alpha)
        return FinishHazardModel(
            coef={"ko": m_ko.coef_.tolist(), "sub": m_sub.coef_.tolist()},
            intercept={"ko": float(m_ko.intercept_), "sub": float(m_sub.intercept_)},
            cov_mean=cov_mean.tolist(),
            cov_std=cov_std.tolist(),
            cov_names=design_columns(),
            time_names=time_basis_names(),
            meta={"alpha": alpha, "bin_seconds": args.bin_seconds,
                  "n_train_bouts": len(tr), "train_end": TRAIN_END, "val_end": VAL_END},
        )

    console.log("sweeping the L2 penalty on the validation window…")
    sweep: list[dict] = []
    best, best_ll = None, -np.inf
    for alpha in ALPHAS:
        model = build_model(alpha)
        ll = survival_loglik(model, va)["mean_loglik"]
        sweep.append({"alpha": alpha, "val_mean_loglik": ll})
        console.log(f"  alpha {alpha:<8g} val mean log-lik {ll:+.5f}")
        if ll > best_ll:
            best, best_ll = model, ll
    assert best is not None
    alpha = best.meta["alpha"]
    console.log(f"selected alpha = {alpha:g}")

    # ── held-out grading ────────────────────────────────────────────────
    report: dict = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "bin_seconds": args.bin_seconds,
        "skipped": skipped,
        "n_train": len(tr), "n_val": len(va), "n_test": len(te),
        "alpha_sweep": sweep,
        "selected_alpha": alpha,
        "survival_loglik": {
            "train": survival_loglik(best, tr),
            "val": survival_loglik(best, va),
            "test": survival_loglik(best, te),
        },
    }

    # Grading. Two hazard SPECIFICATIONS on identical bouts with identical
    # downstream arithmetic — fitted vs the incumbent hand-set constants —
    # and two ways of splitting the decision cell between the fighters:
    #
    #   current  : the production `_decision_logit` / DECISION_TEMPERATURE
    #   neutral  : 50/50
    #
    # The neutral split is what ISOLATES the hazard model. Under the current
    # split the conditional method log-loss is dominated by whether the
    # decision-winner logit picked the right fighter, which is Stage 2's
    # problem, not the hazard's — grading the hazard through it would credit
    # or blame this model for someone else's error.
    from src.monte_carlo import DECISION_TEMPERATURE, _decision_logit

    def grade(
        subset: list[BoutSurvival], label: str, source: str, dec_split: str
    ) -> dict:
        rows = []
        for b in subset:
            lam = (
                fitted_hazard_arrays(best, b)
                if source == "fitted"
                else current_mc_hazard_arrays(b)
            )
            p = integrate_outcomes(lam)
            if dec_split == "neutral":
                p_dec_a = 0.5
            else:
                logit = _decision_logit(b.snap_a, b.snap_b)
                p_dec_a = 1.0 / (1.0 + np.exp(-(logit / DECISION_TEMPERATURE)))
            rows.append(
                {
                    "ko_a": p["ko_a"], "sub_a": p["sub_a"],
                    "dec_a": p["decision"] * p_dec_a,
                    "ko_b": p["ko_b"], "sub_b": p["sub_b"],
                    "dec_b": p["decision"] * (1.0 - p_dec_a),
                    "cause": b.cause, "side": b.finisher_side,
                }
            )
        cells = np.array([[r[c] for c in
                           ("ko_a", "sub_a", "dec_a", "ko_b", "sub_b", "dec_b")]
                          for r in rows])
        pred = {
            "ko": float((cells[:, 0] + cells[:, 3]).mean()),
            "sub": float((cells[:, 1] + cells[:, 4]).mean()),
            "dec": float((cells[:, 2] + cells[:, 5]).mean()),
        }
        actual_cause = [b.cause or "dec" for b in subset]
        actual = {
            k: float(np.mean([c == k for c in actual_cause]))
            for k in ("ko", "sub", "dec")
        }
        # Conditional method | winner — the quantity sportsbook.ts preserves,
        # calibrate_method_mix.py optimizes, and the 1.018 constant baseline is
        # measured on. ALL THREE classes over every bout with a winning side:
        # scoring finishes only would be a different, easier metric.
        cond_terms: list[float] = []
        bucket_idx = {"ko": 0, "sub": 1, "dec": 2}
        for r, b in zip(rows, subset, strict=True):
            if b.winner_side is None:
                continue  # draw — not method-gradeable
            trio = (
                np.array([r["ko_a"], r["sub_a"], r["dec_a"]])
                if b.winner_side == 0
                else np.array([r["ko_b"], r["sub_b"], r["dec_b"]])
            )
            s = trio.sum()
            cond = trio / s if s > 0 else np.full(3, 1 / 3)
            cond_terms.append(-np.log(max(cond[bucket_idx[b.cause or "dec"]], 1e-12)))
        # Reference: a CONSTANT predictor of this window's own base rates —
        # the bar the per-fight mix has to clear to be worth anything at all.
        graded = [b for b in subset if b.winner_side is not None]
        base = {
            k: max(float(np.mean([(b.cause or "dec") == k for b in graded])), 1e-12)
            for k in ("ko", "sub", "dec")
        }
        const_ll = -sum(base[k] * np.log(base[k]) for k in base)
        return {
            "segment": label,
            "source": source,
            "decision_split": dec_split,
            "n": len(subset),
            "marginal_predicted": pred,
            "marginal_actual": actual,
            "cond_method_logloss": float(np.mean(cond_terms)) if cond_terms else None,
            "constant_baseline_logloss": float(const_ll),
            "n_conditional": len(cond_terms),
        }

    report["grading"] = {
        f"{split}|{source}|{dec}": grade(subset, split, source, dec)
        for split, subset in (("val", va), ("test", te))
        for source in ("fitted", "current_mc")
        for dec in ("neutral", "current")
    }

    best.save(EVAL_ARTIFACT_PATH)

    # Production refit: same alpha, same design, ALL bouts. The metrics above
    # stay the split model's, which is the conservative estimate — the served
    # model has strictly more data.
    T_all, X_all, e_all, ko_all, sub_all = expand_person_periods(
        bouts, args.bin_seconds
    )
    mean_all, std_all = X_all.mean(axis=0), X_all.std(axis=0)
    std_all[std_all < 1e-9] = 1.0
    Xs_all = (X_all - mean_all) / std_all
    m_ko_all = fit_cause(T_all, Xs_all, e_all, ko_all, alpha)
    m_sub_all = fit_cause(T_all, Xs_all, e_all, sub_all, alpha)
    served = FinishHazardModel(
        coef={"ko": m_ko_all.coef_.tolist(), "sub": m_sub_all.coef_.tolist()},
        intercept={
            "ko": float(m_ko_all.intercept_),
            "sub": float(m_sub_all.intercept_),
        },
        cov_mean=mean_all.tolist(),
        cov_std=std_all.tolist(),
        cov_names=design_columns(),
        time_names=time_basis_names(),
        meta={
            "alpha": alpha,
            "bin_seconds": args.bin_seconds,
            "refit_on_all_data": True,
            "n_bouts": len(bouts),
            "trained_through": str(max(dates).date()),
            "note": "served weights = all bouts; honest metrics come from "
                    "finish_hazard_eval.json (train-only)",
        },
    )
    served.save(ARTIFACT_PATH)
    console.log(
        f"saved served hazard (all {len(bouts):,} bouts) and the split-trained "
        f"eval twin ({len(tr):,} bouts)"
    )
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))

    # ── printout ────────────────────────────────────────────────────────
    t = Table(title="Finish hazard — held-out survival log-likelihood (per bout)")
    t.add_column("Split")
    t.add_column("N", justify="right")
    t.add_column("mean log-lik", justify="right")
    for k, v in report["survival_loglik"].items():
        t.add_row(k, f"{v['n_bouts']:,}", f"{v['mean_loglik']:+.5f}")
    console.print(t)

    m = Table(title="Marginal method calibration — exact integration, no MC noise")
    m.add_column("Split · hazards")
    m.add_column("KO pred/actual", justify="right")
    m.add_column("Sub pred/actual", justify="right")
    m.add_column("Dec pred/actual", justify="right")
    for k in ("val", "test"):
        for src in ("fitted", "current_mc"):
            g = report["grading"][f"{k}|{src}|neutral"]
            m.add_row(
                f"{k} (n={g['n']}) · {src}",
                f"{g['marginal_predicted']['ko']:.3f} / {g['marginal_actual']['ko']:.3f}",
                f"{g['marginal_predicted']['sub']:.3f} / {g['marginal_actual']['sub']:.3f}",
                f"{g['marginal_predicted']['dec']:.3f} / {g['marginal_actual']['dec']:.3f}",
            )
    console.print(m)

    cm = Table(title="Conditional method log-loss (method | actual winner, 3 classes)")
    cm.add_column("Split")
    cm.add_column("N", justify="right")
    cm.add_column("decision split")
    cm.add_column("fitted", justify="right")
    cm.add_column("current MC", justify="right")
    cm.add_column("constant base rates", justify="right")
    for k in ("val", "test"):
        for dec in ("neutral", "current"):
            gf = report["grading"][f"{k}|fitted|{dec}"]
            gc = report["grading"][f"{k}|current_mc|{dec}"]
            cm.add_row(
                k, f"{gf['n_conditional']:,}", dec,
                f"{gf['cond_method_logloss']:.4f}",
                f"{gc['cond_method_logloss']:.4f}",
                f"{gf['constant_baseline_logloss']:.4f}",
            )
    console.print(cm)

    c = Table(title="Coefficients (standardized covariates)")
    c.add_column("Term")
    c.add_column("KO", justify="right")
    c.add_column("Sub", justify="right")
    names = best.time_names + best.cov_names
    for i, name in enumerate(names):
        c.add_row(name, f"{best.coef['ko'][i]:+.4f}", f"{best.coef['sub'][i]:+.4f}")
    console.print(c)

    console.log(f"wrote {ARTIFACT_PATH} and {REPORT_PATH}")


if __name__ == "__main__":
    main()

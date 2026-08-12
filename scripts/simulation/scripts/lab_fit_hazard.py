"""Grade the discrete-time competing-risks finish hazard (Stage 1 of the
round-level-signals lab) against what the Monte Carlo did before it.

The FIT itself lives in `src/round_fit.py` and is part of the training
pipeline — `run_train.py` refits it on every retrain. This script re-runs that
same fit on demand and adds the grading the pipeline has no use for: fitted vs
the incumbent hand-set constants, the marginal method calibration, and the
round-of-finish verdict, written to `artifacts/lab_finish_hazard.json`.

Splits are the production ones: train < TRAIN_END, val in [TRAIN_END, VAL_END)
for the L2 penalty, test >= VAL_END reported once at the end. Population and
exclusions: see `src/round_fit.py`.

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

from src.config import ARTIFACTS_DIR, DATA_DIR  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.finish_hazard import (  # noqa: E402
    BIN_SECONDS,
    SECONDS_PER_ROUND,
    BoutSurvival,
    current_mc_hazard_arrays,
    fitted_hazard_arrays,
    integrate_outcomes,
    round_distribution,
    survival_loglik,
)
from src.round_fit import build_survival_set, fit_finish_hazard  # noqa: E402

console = Console()

REPORT_PATH = ARTIFACTS_DIR / "lab_finish_hazard.json"
CACHE_PATH = DATA_DIR / "rolling_dataset.parquet"


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

    fit = fit_finish_hazard(bouts, args.bin_seconds)
    best, tr, va, te = fit.eval_model, fit.train, fit.val, fit.test

    # ── held-out grading ────────────────────────────────────────────────
    report: dict = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "bin_seconds": args.bin_seconds,
        "skipped": skipped,
        "n_train": len(tr), "n_val": len(va), "n_test": len(te),
        "alpha_sweep": fit.sweep,
        "selected_alpha": fit.alpha,
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
        round_terms: list[float] = []
        for b in subset:
            lam = (
                fitted_hazard_arrays(best, b)
                if source == "fitted"
                else current_mc_hazard_arrays(b)
            )
            p = integrate_outcomes(lam)
            # Round-of-finish log-loss, graded only on bouts that DID finish.
            # Independent of the method mix and of the decision split — it is
            # purely a verdict on the timing shape.
            if b.cause is not None:
                dist = round_distribution(lam, b.scheduled_rounds)
                r_idx = min(int(b.end_seconds // SECONDS_PER_ROUND), len(dist) - 1)
                round_terms.append(-np.log(max(dist[r_idx], 1e-12)))
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
            "round_logloss": float(np.mean(round_terms)) if round_terms else None,
            "n_finishes": len(round_terms),
        }

    report["grading"] = {
        f"{split}|{source}|{dec}": grade(subset, split, source, dec)
        for split, subset in (("val", va), ("test", te))
        for source in ("fitted", "current_mc")
        for dec in ("neutral", "current")
    }
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

    rl = Table(title="Round-of-finish log-loss (finishes only — pure timing verdict)")
    rl.add_column("Split")
    rl.add_column("N finishes", justify="right")
    rl.add_column("fitted", justify="right")
    rl.add_column("current MC", justify="right")
    for k in ("val", "test"):
        gf = report["grading"][f"{k}|fitted|neutral"]
        gc = report["grading"][f"{k}|current_mc|neutral"]
        rl.add_row(
            k, f"{gf['n_finishes']:,}",
            f"{gf['round_logloss']:.4f}", f"{gc['round_logloss']:.4f}",
        )
    console.print(rl)

    c = Table(title="Coefficients (standardized covariates)")
    c.add_column("Term")
    c.add_column("KO", justify="right")
    c.add_column("Sub", justify="right")
    names = best.time_names + best.cov_names
    for i, name in enumerate(names):
        c.add_row(name, f"{best.coef['ko'][i]:+.4f}", f"{best.coef['sub'][i]:+.4f}")
    console.print(c)

    console.log(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()

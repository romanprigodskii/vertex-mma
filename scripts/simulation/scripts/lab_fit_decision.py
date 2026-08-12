"""Grade the decision-winner model (Stage 2 of the round-level-signals lab)
against the four hand-set weights it replaced.

The FIT itself lives in `src/round_fit.py` and is part of the training
pipeline — `run_train.py` refits it on every retrain. This script re-runs that
same fit on demand and adds the grading, written to
`artifacts/lab_decision_winner.json`.

Two things are being measured, and they are not the same:

  1. DECISION-CONDITIONAL log-loss — given the fight went the distance, did
     the model pick the right fighter. This is the direct verdict on the
     replacement.
  2. What that does to the CONDITIONAL METHOD mix, which is what
     `sportsbook.ts` actually prices. The decision split feeds it, so a
     miscalibrated winner split leaks into the KO/sub/dec ratio of both sides.

Usage (from scripts/simulation, venv active):
  python scripts/lab_fit_decision.py
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
from src.decision_model import DECISION_FEATURES  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.finish_hazard import BoutSurvival  # noqa: E402
from src.round_fit import (  # noqa: E402
    build_survival_set,
    decisions_from,
    fit_decision_winner,
    logloss,
)

console = Console()

REPORT_PATH = ARTIFACTS_DIR / "lab_decision_winner.json"
CACHE_PATH = DATA_DIR / "rolling_dataset.parquet"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.parse_args()

    if CACHE_PATH.exists():
        console.log(f"loading cached dataset from {CACHE_PATH}")
        df = pd.read_parquet(CACHE_PATH)
    else:
        df = symmetrize_for_training(build_dataset(fetch_raw(), include_debuts=True))
    df = df[df["target_a_wins"].notna()].reset_index(drop=True)

    # The Stage 1 survival builder, so the population, the exclusions and the
    # FighterMC shrinkage are identical across both stages.
    bouts, skipped = build_survival_set(df)
    decisions = decisions_from(bouts)
    console.log(
        f"{len(decisions):,} decisions with a winner "
        f"(of {len(bouts):,} bouts; skipped {skipped})"
    )

    fit = fit_decision_winner(decisions)
    model, va, te = fit.eval_model, fit.val, fit.test

    # ── grading vs the incumbent hand-set logit ─────────────────────────
    from src.monte_carlo import DECISION_TEMPERATURE, _decision_logit

    def incumbent_probs(subset: list[BoutSurvival]) -> np.ndarray:
        z = np.array([_decision_logit(b.snap_a, b.snap_b) for b in subset])
        return 1.0 / (1.0 + np.exp(-np.clip(z / DECISION_TEMPERATURE, -30, 30)))

    def fitted_probs(subset: list[BoutSurvival], temperature: float) -> np.ndarray:
        return np.array([model.prob_a(b.snap_a, b.snap_b, temperature) for b in subset])

    grading: dict[str, dict] = {}
    for name, subset in (("val", va), ("test", te)):
        if not subset:
            continue
        y = np.array([1 - b.winner_side for b in subset], dtype=float)
        p_new = fitted_probs(subset, fit.temperature)
        p_new_raw = fitted_probs(subset, 1.0)
        p_old = incumbent_probs(subset)
        n = len(subset)
        grading[name] = {
            "n": n,
            "fitted_logloss": logloss(p_new, y),
            "fitted_logloss_temperature_1": logloss(p_new_raw, y),
            "incumbent_logloss": logloss(p_old, y),
            "coin_flip_logloss": float(np.log(2.0)),
            "fitted_accuracy": float(((p_new >= 0.5) == (y == 1)).mean()),
            "incumbent_accuracy": float(((p_old >= 0.5) == (y == 1)).mean()),
            "accuracy_se": float(np.sqrt(0.25 / n)),
            # How extreme each model's probabilities get. The incumbent's
            # temperature of 0.45 is a 2.2x sharpening, so this is where the
            # damage shows up.
            "fitted_p_below_0.05_or_above_0.95": float(
                np.mean((p_new < 0.05) | (p_new > 0.95))
            ),
            "incumbent_p_below_0.05_or_above_0.95": float(
                np.mean((p_old < 0.05) | (p_old > 0.95))
            ),
        }

    # ── printout ────────────────────────────────────────────────────────
    t = Table(title="Decision-winner model — held-out (decisions only)")
    t.add_column("Split")
    t.add_column("N", justify="right")
    t.add_column("fitted LL", justify="right")
    t.add_column("incumbent LL", justify="right")
    t.add_column("coin flip", justify="right")
    t.add_column("fitted acc", justify="right")
    t.add_column("incumbent acc", justify="right")
    for name, g in grading.items():
        t.add_row(
            name, f"{g['n']:,}",
            f"{g['fitted_logloss']:.4f}", f"{g['incumbent_logloss']:.4f}",
            f"{g['coin_flip_logloss']:.4f}",
            f"{g['fitted_accuracy']:.4f} ±{g['accuracy_se'] * 100:.1f}pp",
            f"{g['incumbent_accuracy']:.4f}",
        )
    console.print(t)

    e = Table(title="Share of decisions priced beyond 5% / 95%")
    e.add_column("Split")
    e.add_column("fitted", justify="right")
    e.add_column("incumbent", justify="right")
    for name, g in grading.items():
        e.add_row(
            name,
            f"{g['fitted_p_below_0.05_or_above_0.95'] * 100:.1f}%",
            f"{g['incumbent_p_below_0.05_or_above_0.95'] * 100:.1f}%",
        )
    console.print(e)

    c = Table(title="Fitted coefficients (per standardized A-B difference)")
    c.add_column("Feature")
    c.add_column("coef", justify="right")
    c.add_column("incumbent hand weight", justify="right")
    hand = {"slpm": "+0.18", "sapm": "-0.10", "control_per_min": "+0.80",
            "td_per15": "+0.08"}
    for name, w in zip(DECISION_FEATURES, model.coef, strict=True):
        c.add_row(name, f"{w:+.4f}", hand.get(name, "—"))
    console.print(c)

    REPORT_PATH.write_text(
        json.dumps(
            {
                "generated_at": datetime.utcnow().isoformat() + "Z",
                "n_decisions": len(decisions),
                "n_train": len(fit.train), "n_val": len(va), "n_test": len(te),
                "C_sweep": fit.c_sweep,
                "temperature_sweep": fit.temperature_sweep,
                "selected_C": fit.C,
                "selected_temperature": fit.temperature,
                "coefficients": dict(
                    zip(DECISION_FEATURES, model.coef, strict=True)
                ),
                "grading": grading,
            },
            indent=2, default=str,
        )
    )
    console.log(f"wrote {REPORT_PATH}")


if __name__ == "__main__":
    main()

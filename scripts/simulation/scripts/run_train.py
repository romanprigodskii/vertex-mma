"""CLI: full pipeline — export raw data, build features, train, evaluate.

Usage (from project root):
  PYTHONPATH=scripts/simulation python -m scripts.run_train

  (Or, from inside scripts/simulation/, after `source venv/bin/activate`):
  python scripts/run_train.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow running this file directly (python scripts/run_train.py from
# inside scripts/simulation) by adding the package root to sys.path.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from rich.console import Console  # noqa: E402

from src.config import DATA_DIR  # noqa: E402
from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.round_fit import refit_round_models  # noqa: E402
from src.train import run_training  # noqa: E402

console = Console()


def main() -> None:
    raw = fetch_raw()
    # include_debuts (v0.8.0): the frame carries debut bouts for the debut
    # specialist; run_training still fits the MAIN model on both-experienced
    # rows only, so its weights are unaffected by this flag.
    df = build_dataset(raw, include_debuts=True)
    df = symmetrize_for_training(df)
    dataset_path = DATA_DIR / "dataset.parquet"
    df.to_parquet(dataset_path, index=False)
    console.log(
        f"dataset cached at {dataset_path} · "
        f"target_a_wins mean={df['target_a_wins'].mean():.3f}"
    )
    run_training(df)

    # The two artifacts the Monte Carlo serves — WHEN a fight ends and WHO
    # wins a decision. They used to be fitted only by hand from the lab
    # scripts, so every weekly retrain moved the ensemble and the method
    # models while these stayed at their lab date; a hazard fitted on an old
    # scrape keeps pricing `bout_simulation_rounds` and, through
    # `sportsbook.ts`, the totals and distance markets. Refitting them here
    # is the whole point of the pipeline being one command.
    #
    # A failure aborts the run before the cron commits anything, which is the
    # intended coupling: shipping an ensemble trained through today next to a
    # hazard trained through last quarter is the bug this replaces.
    summary = refit_round_models(df)
    console.log(
        f"round models refit · hazard through {summary['hazard_trained_through']} "
        f"({summary['n_bouts']:,} bouts, alpha {summary['hazard_alpha']:g}) · "
        f"decisions through {summary['decision_trained_through']} "
        f"({summary['n_decisions']:,} decisions, C {summary['decision_C']:g}, "
        f"T {summary['decision_temperature']:.2f})"
    )


if __name__ == "__main__":
    main()

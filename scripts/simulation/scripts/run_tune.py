"""CLI: Optuna hyperparameter search.

Usage:
  source venv/bin/activate
  python scripts/run_tune.py            # default 100 trials
  python scripts/run_tune.py 250        # longer search

Writes artifacts/best_params.json. The next `python scripts/run_train.py`
picks it up automatically.
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from src.export import build_dataset, fetch_raw, symmetrize_for_training  # noqa: E402
from src.tune import run_tuning  # noqa: E402


def main() -> None:
    n_trials = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    raw = fetch_raw()
    df = build_dataset(raw)
    df = symmetrize_for_training(df)
    run_tuning(df, n_trials=n_trials)


if __name__ == "__main__":
    main()

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
from src.train import run_training  # noqa: E402

console = Console()


def main() -> None:
    raw = fetch_raw()
    df = build_dataset(raw)
    df = symmetrize_for_training(df)
    dataset_path = DATA_DIR / "dataset.parquet"
    df.to_parquet(dataset_path, index=False)
    console.log(
        f"dataset cached at {dataset_path} · "
        f"target_a_wins mean={df['target_a_wins'].mean():.3f}"
    )
    run_training(df)


if __name__ == "__main__":
    main()

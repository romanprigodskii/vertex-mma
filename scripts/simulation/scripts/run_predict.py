"""CLI: score upcoming UFC bouts and write to bout_simulation.

Usage (from inside scripts/simulation/, after `source venv/bin/activate`):
  python scripts/run_predict.py
"""

from __future__ import annotations

import sys
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from src.predict import predict_upcoming  # noqa: E402


def main() -> None:
    predict_upcoming()


if __name__ == "__main__":
    main()

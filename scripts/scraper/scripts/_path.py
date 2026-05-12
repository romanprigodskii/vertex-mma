"""Make `src.*` importable when scripts are run as files."""
from __future__ import annotations

import sys
from pathlib import Path

_PROJECT = Path(__file__).resolve().parents[1]
if str(_PROJECT) not in sys.path:
    sys.path.insert(0, str(_PROJECT))

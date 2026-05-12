from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from rich.logging import RichHandler

LOG_LEVEL = os.environ.get("SCRAPER_LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(message)s",
    datefmt="[%X]",
    handlers=[RichHandler(rich_tracebacks=True, show_time=True, show_path=False)],
)

log = logging.getLogger("vertex.scraper")

# Errors that aren't fatal go here for manual review.
ERROR_LOG_PATH = (
    Path(__file__).resolve().parents[2] / ".errors.jsonl"
)


def record_parse_error(*, url: str, kind: str, message: str, extra: dict | None = None) -> None:
    """Append a structured error record to .errors.jsonl."""
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "url": url,
        "kind": kind,
        "message": message,
    }
    if extra:
        entry["extra"] = extra
    ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with ERROR_LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

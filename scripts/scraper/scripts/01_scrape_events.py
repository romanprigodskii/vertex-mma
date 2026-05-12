from __future__ import annotations

import _path  # noqa: F401

from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

from src.config import EVENTS_COMPLETED_URL, EVENTS_UPCOMING_URL
from src.db import get_connection
from src.http import Client
from src.loaders.events import upsert_event_listing
from src.parsers.events import parse_events_listing
from src.utils.logger import log


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    """Phase 1: fetch completed + upcoming event listings and upsert them.

    Returns counts {inserted, updated, total_seen}.
    """
    totals = {"inserted": 0, "updated": 0, "total_seen": 0}

    with Client() as http, get_connection() as conn, Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        TextColumn("[cyan]{task.completed}[/]"),
        TimeElapsedColumn(),
    ) as progress:
        task = progress.add_task("Events listing pages", total=2)

        for status, url in (("completed", EVENTS_COMPLETED_URL), ("upcoming", EVENTS_UPCOMING_URL)):
            html = http.get(url)
            items = parse_events_listing(html)
            log.info(f"{status} listing: {len(items)} events parsed")
            if limit is not None:
                items = items[:limit]
            counts = upsert_event_listing(conn, items, status=status, dry_run=dry_run)
            totals["inserted"] += counts.inserted
            totals["updated"] += counts.updated
            totals["total_seen"] += len(items)
            progress.advance(task)
            if not dry_run:
                conn.commit()

    log.info(
        f"phase 1 events: total_seen={totals['total_seen']} "
        f"inserted={totals['inserted']} updated={totals['updated']}"
    )
    return totals


if __name__ == "__main__":
    run()

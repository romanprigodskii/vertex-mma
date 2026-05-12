from __future__ import annotations

import string

import _path  # noqa: F401

from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from src.config import FIGHTERS_URL_TEMPLATE
from src.db import get_connection
from src.http import Client
from src.loaders.fighters import upsert_fighter_listing
from src.parsers.fighters import parse_fighters_listing
from src.utils.logger import log


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    """Phase 2: per-letter fighter listings → upsert.

    `limit` here means "stop after this many fighters total" (across letters).
    """
    totals = {"inserted": 0, "updated": 0, "total_seen": 0}
    letters = list(string.ascii_lowercase)

    with Client() as http, get_connection() as conn, Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[cyan]{task.completed}/{task.total}[/]"),
        TimeElapsedColumn(),
    ) as progress:
        task = progress.add_task("Fighter letters", total=len(letters))

        for letter in letters:
            url = FIGHTERS_URL_TEMPLATE.format(letter=letter)
            html = http.get(url)
            items = parse_fighters_listing(html)
            log.info(f"letter {letter!r}: {len(items)} fighters parsed")

            if limit is not None:
                remaining = limit - totals["total_seen"]
                if remaining <= 0:
                    break
                items = items[:remaining]

            counts = upsert_fighter_listing(conn, items, dry_run=dry_run)
            totals["inserted"] += counts.inserted
            totals["updated"] += counts.updated
            totals["total_seen"] += len(items)
            if not dry_run:
                conn.commit()
            progress.advance(task)

            if limit is not None and totals["total_seen"] >= limit:
                break

    log.info(
        f"phase 2 fighters: total_seen={totals['total_seen']} "
        f"inserted={totals['inserted']} updated={totals['updated']}"
    )
    return totals


if __name__ == "__main__":
    run()

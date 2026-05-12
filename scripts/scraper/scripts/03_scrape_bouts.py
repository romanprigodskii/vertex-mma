from __future__ import annotations

import _path  # noqa: F401

from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from src.config import BASE_URL
from src.db import get_connection
from src.http import Client
from src.loaders.events import upsert_bouts, upsert_event_details
from src.parsers.event_details import parse_event_details
from src.utils.logger import log


def _all_event_ufc_ids(conn, limit: int | None = None) -> list[str]:
    with conn.cursor() as cur:
        if limit is None:
            cur.execute(
                "SELECT ufc_stats_id FROM event WHERE ufc_stats_id IS NOT NULL ORDER BY date DESC"
            )
        else:
            cur.execute(
                "SELECT ufc_stats_id FROM event WHERE ufc_stats_id IS NOT NULL ORDER BY date DESC LIMIT %s",
                (limit,),
            )
        return [row[0] for row in cur.fetchall()]


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    totals = {"events_processed": 0, "bouts_inserted": 0, "bouts_updated": 0, "bouts_skipped": 0}

    with Client() as http, get_connection() as conn:
        event_ids = _all_event_ufc_ids(conn, limit=limit)
        log.info(f"phase 3: scraping {len(event_ids)} events for bouts")

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[cyan]{task.completed}/{task.total}[/]"),
            TimeElapsedColumn(),
        ) as progress:
            task = progress.add_task("Event detail pages", total=len(event_ids))

            for ufc_id in event_ids:
                url = f"{BASE_URL}/event-details/{ufc_id}"
                try:
                    html = http.get(url)
                    details = parse_event_details(html)
                except Exception as exc:  # noqa: BLE001 — surface and continue
                    log.error(f"event {ufc_id}: parse failed: {exc!r}")
                    progress.advance(task)
                    continue

                upsert_event_details(conn, ufc_stats_id=ufc_id, details=details, dry_run=dry_run)
                counts = upsert_bouts(
                    conn, event_ufc_id=ufc_id, bouts=details.bouts, dry_run=dry_run
                )
                totals["events_processed"] += 1
                totals["bouts_inserted"] += counts.inserted
                totals["bouts_updated"] += counts.updated
                totals["bouts_skipped"] += counts.skipped
                if not dry_run:
                    conn.commit()
                progress.advance(task)

    log.info(
        f"phase 3 bouts: events={totals['events_processed']} "
        f"inserted={totals['bouts_inserted']} updated={totals['bouts_updated']} "
        f"skipped={totals['bouts_skipped']}"
    )
    return totals


if __name__ == "__main__":
    run()

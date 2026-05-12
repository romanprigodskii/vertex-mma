from __future__ import annotations

import json
from pathlib import Path

import _path  # noqa: F401

from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from src.config import BASE_URL, CHECKPOINT_EVERY_FIGHTERS, FIGHTER_RESYNC_DAYS, RATE_LIMIT_ENRICH_SECONDS
from src.db import get_connection
from src.http import Client
from src.loaders.fighters import update_fighter_from_details
from src.parsers.fighter_details import parse_fighter_details
from src.utils.logger import log, record_parse_error

CHECKPOINT_PATH = Path(__file__).resolve().parents[1] / ".checkpoint_fighters.json"


def _load_checkpoint() -> set[str]:
    if not CHECKPOINT_PATH.exists():
        return set()
    try:
        return set(json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8")))
    except Exception:
        return set()


def _save_checkpoint(done: set[str]) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(sorted(done)), encoding="utf-8")


def _fighter_targets(conn, limit: int | None) -> list[str]:
    with conn.cursor() as cur:
        sql = """
            SELECT ufc_stats_id
            FROM fighter
            WHERE ufc_stats_id IS NOT NULL
              AND (last_synced_at IS NULL OR last_synced_at < now() - INTERVAL '%s days')
            ORDER BY last_synced_at NULLS FIRST, name_en
        """ % FIGHTER_RESYNC_DAYS
        if limit is not None:
            sql += " LIMIT %s"
            cur.execute(sql, (limit,))
        else:
            cur.execute(sql)
        return [row[0] for row in cur.fetchall()]


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    done = _load_checkpoint()
    totals = {"processed": 0, "errors": 0, "skipped_done": 0}

    with Client(rate_limit_seconds=RATE_LIMIT_ENRICH_SECONDS) as http, get_connection() as conn:
        targets = _fighter_targets(conn, limit=limit)
        targets = [t for t in targets if t not in done]
        log.info(f"phase 4: enriching {len(targets)} fighters (checkpointed: {len(done)})")

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[cyan]{task.completed}/{task.total}[/]"),
            TimeElapsedColumn(),
        ) as progress:
            task = progress.add_task("Fighters", total=len(targets))

            for ufc_id in targets:
                url = f"{BASE_URL}/fighter-details/{ufc_id}"
                try:
                    html = http.get(url)
                    details = parse_fighter_details(html)
                except Exception as exc:  # noqa: BLE001
                    totals["errors"] += 1
                    record_parse_error(url=url, kind="fighter_details", message=repr(exc))
                    log.error(f"fighter {ufc_id}: parse failed: {exc!r}")
                    progress.advance(task)
                    continue

                update_fighter_from_details(
                    conn, ufc_stats_id=ufc_id, details=details, dry_run=dry_run
                )
                if not dry_run:
                    conn.commit()
                done.add(ufc_id)
                totals["processed"] += 1
                progress.advance(task)

                if totals["processed"] % CHECKPOINT_EVERY_FIGHTERS == 0:
                    _save_checkpoint(done)

        _save_checkpoint(done)

    log.info(
        f"phase 4 fighters enriched: processed={totals['processed']} errors={totals['errors']}"
    )
    return totals


if __name__ == "__main__":
    run()

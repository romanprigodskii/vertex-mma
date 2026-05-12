from __future__ import annotations

import json
from pathlib import Path

import _path  # noqa: F401

from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn

from src.config import BASE_URL, CHECKPOINT_EVERY_BOUTS, RATE_LIMIT_ENRICH_SECONDS
from src.db import get_connection
from src.http import Client
from src.loaders.bout_stats import insert_round_stats
from src.parsers.bout_stats import parse_bout_round_stats
from src.utils.logger import log, record_parse_error

CHECKPOINT_PATH = Path(__file__).resolve().parents[1] / ".checkpoint_bouts.json"


def _load_checkpoint() -> set[str]:
    if not CHECKPOINT_PATH.exists():
        return set()
    try:
        return set(json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8")))
    except Exception:
        return set()


def _save_checkpoint(done: set[str]) -> None:
    CHECKPOINT_PATH.write_text(json.dumps(sorted(done)), encoding="utf-8")


def _bout_targets(conn, limit: int | None) -> list[str]:
    """Bouts that are completed and don't have any round stats yet."""
    with conn.cursor() as cur:
        sql = """
            SELECT b.ufc_stats_id
            FROM bout b
            LEFT JOIN bout_round_stats r ON r.bout_id = b.id
            WHERE b.status = 'completed'
              AND b.ufc_stats_id IS NOT NULL
              AND r.id IS NULL
            GROUP BY b.id, b.ufc_stats_id
            ORDER BY b.created_at DESC
        """
        if limit is not None:
            sql += " LIMIT %s"
            cur.execute(sql, (limit,))
        else:
            cur.execute(sql)
        return [row[0] for row in cur.fetchall()]


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    done = _load_checkpoint()
    totals = {"processed": 0, "errors": 0, "rounds_inserted": 0, "no_data": 0}

    with Client(rate_limit_seconds=RATE_LIMIT_ENRICH_SECONDS) as http, get_connection() as conn:
        targets = _bout_targets(conn, limit=limit)
        targets = [t for t in targets if t not in done]
        log.info(f"phase 5: enriching {len(targets)} bouts (checkpointed: {len(done)})")

        with Progress(
            TextColumn("[progress.description]{task.description}"),
            BarColumn(),
            TextColumn("[cyan]{task.completed}/{task.total}[/]"),
            TimeElapsedColumn(),
        ) as progress:
            task = progress.add_task("Bout round stats", total=len(targets))

            for ufc_id in targets:
                url = f"{BASE_URL}/fight-details/{ufc_id}"
                try:
                    html = http.get(url)
                    rounds = parse_bout_round_stats(html)
                except Exception as exc:  # noqa: BLE001
                    totals["errors"] += 1
                    record_parse_error(url=url, kind="bout_stats", message=repr(exc))
                    log.error(f"bout {ufc_id}: parse failed: {exc!r}")
                    progress.advance(task)
                    continue

                if not rounds:
                    # Old fights without per-round data. Mark as done so we don't retry.
                    totals["no_data"] += 1
                    done.add(ufc_id)
                    progress.advance(task)
                    continue

                inserted = insert_round_stats(
                    conn, bout_ufc_id=ufc_id, rounds=rounds, dry_run=dry_run
                )
                totals["rounds_inserted"] += inserted
                if not dry_run:
                    conn.commit()
                done.add(ufc_id)
                totals["processed"] += 1
                progress.advance(task)

                if totals["processed"] % CHECKPOINT_EVERY_BOUTS == 0:
                    _save_checkpoint(done)

        _save_checkpoint(done)

    log.info(
        f"phase 5 bouts enriched: processed={totals['processed']} "
        f"rounds_inserted={totals['rounds_inserted']} "
        f"no_data={totals['no_data']} errors={totals['errors']}"
    )
    return totals


if __name__ == "__main__":
    run()

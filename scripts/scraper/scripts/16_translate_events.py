"""Populate event.name_ru via Claude — transliterates the matchup surnames in
event names (e.g. "UFC Fight Night: Song vs. Figueiredo" → "UFC Fight Night:
Сун vs. Фигейреду"), keeping org/format prefixes and numbers intact.

Resumable: only events without name_ru are touched; a failed batch is left for
the next run. UI falls back to the English name where name_ru is missing.

Usage:
  ./venv/bin/python scripts/16_translate_events.py --dry-run --limit 10
  ./venv/bin/python scripts/16_translate_events.py
"""
from __future__ import annotations

import argparse

import _path  # noqa: F401

from src.db import get_connection
from src.event_translator import EventInput, translate_batch
from src.loaders.events import fetch_untranslated_events, save_event_name_ru
from src.utils.logger import log

BATCH_SIZE = 30


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    totals = {"translated": 0, "skipped": 0, "failed_batches": 0}

    with get_connection() as conn:
        events = fetch_untranslated_events(conn, limit=limit)
        log.info(f"event translate: {len(events)} event(s) without name_ru")
        if not events:
            return totals

        batch_count = (len(events) + BATCH_SIZE - 1) // BATCH_SIZE
        for bi in range(batch_count):
            batch = events[bi * BATCH_SIZE : (bi + 1) * BATCH_SIZE]
            inputs = [EventInput(index=i, name=e.name) for i, e in enumerate(batch)]
            try:
                results = translate_batch(inputs)
            except Exception as exc:
                log.error(f"  batch {bi + 1}/{batch_count} failed — {exc!r}")
                totals["failed_batches"] += 1
                continue

            for i, ev in enumerate(batch):
                ru = results.get(i)
                if not ru:
                    totals["skipped"] += 1
                    continue
                if dry_run:
                    log.info(f"  {ev.name}  ->  {ru}")
                else:
                    save_event_name_ru(conn, ev.id, ru)
                totals["translated"] += 1

            if not dry_run:
                conn.commit()
            log.info(f"  batch {bi + 1}/{batch_count}: {len(batch)} done")

    log.info(
        f"event translate done: translated={totals['translated']} "
        f"skipped={totals['skipped']} failed_batches={totals['failed_batches']}"
    )
    return totals


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run(limit=args.limit, dry_run=args.dry_run)

"""Populate fighter.name_ru via Claude transliteration into Russian.

Resumable: only fighters whose name_ru is null/empty are touched, and a failed
batch is left for the next run. name_en remains the display fallback wherever
name_ru is missing, so a partial run is always safe.

Usage:
  ./venv/bin/python scripts/14_translate_fighter_names.py --dry-run --limit 40
  ./venv/bin/python scripts/14_translate_fighter_names.py
"""
from __future__ import annotations

import argparse

import _path  # noqa: F401

from src.db import get_connection
from src.fighter_name_translator import NameInput, translate_batch
from src.loaders.fighters import fetch_untranslated_names, save_fighter_name_ru
from src.utils.logger import log

BATCH_SIZE = 40


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    totals = {"translated": 0, "skipped": 0, "failed_batches": 0}

    with get_connection() as conn:
        rows = fetch_untranslated_names(conn, limit=limit)
        log.info(f"fighter names: {len(rows)} fighter(s) without name_ru")
        if not rows:
            return totals

        batch_count = (len(rows) + BATCH_SIZE - 1) // BATCH_SIZE
        for bi in range(batch_count):
            batch = rows[bi * BATCH_SIZE : (bi + 1) * BATCH_SIZE]
            inputs = [
                NameInput(index=i, name_en=f.name_en, country_code=f.country_code)
                for i, f in enumerate(batch)
            ]
            try:
                results = translate_batch(inputs)
            except Exception as exc:
                log.error(f"  batch {bi + 1}/{batch_count} failed — {exc!r}")
                totals["failed_batches"] += 1
                continue

            for i, fighter in enumerate(batch):
                ru = results.get(i)
                if not ru:
                    totals["skipped"] += 1
                    log.warning(f"  {fighter.name_en}: no result — skipped")
                    continue
                if dry_run:
                    log.info(f"  {fighter.name_en}  ->  {ru}")
                else:
                    save_fighter_name_ru(conn, fighter.id, ru)
                totals["translated"] += 1

            if not dry_run:
                conn.commit()
            log.info(f"  batch {bi + 1}/{batch_count}: {len(batch)} done")

    log.info(
        f"done: translated={totals['translated']} "
        f"skipped={totals['skipped']} failed_batches={totals['failed_batches']}"
    )
    return totals


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run(limit=args.limit, dry_run=args.dry_run)

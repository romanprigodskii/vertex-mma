"""Populate news_item.title_ru / body_rephrased_ru via Claude translation.

Resumable: only approved items missing title_ru are touched, and a failed batch
is left for the next run. The RU site falls back to the English title / body
wherever the translation is missing, so a partial run is safe.

Usage:
  ./venv/bin/python scripts/15_translate_news.py --dry-run --limit 5
  ./venv/bin/python scripts/15_translate_news.py
"""
from __future__ import annotations

import argparse

import _path  # noqa: F401

from src.db import get_connection
from src.loaders.news import fetch_untranslated_news, save_news_translation
from src.news_translator import NewsTranslateInput, translate_batch
from src.utils.logger import log

BATCH_SIZE = 5


def run(*, limit: int | None = None, dry_run: bool = False) -> dict[str, int]:
    totals = {"translated": 0, "skipped": 0, "failed_batches": 0}

    with get_connection() as conn:
        items = fetch_untranslated_news(conn, limit=limit)
        log.info(f"news translate: {len(items)} approved item(s) without title_ru")
        if not items:
            return totals

        batch_count = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE
        for bi in range(batch_count):
            batch = items[bi * BATCH_SIZE : (bi + 1) * BATCH_SIZE]
            inputs = [
                NewsTranslateInput(index=i, title=it.title, body=it.body)
                for i, it in enumerate(batch)
            ]
            try:
                results = translate_batch(inputs)
            except Exception as exc:
                log.error(f"  batch {bi + 1}/{batch_count} failed — {exc!r}")
                totals["failed_batches"] += 1
                continue

            for i, item in enumerate(batch):
                res = results.get(i)
                if res is None:
                    totals["skipped"] += 1
                    log.warning(f"  {item.title[:50]!r}: no result — skipped")
                    continue
                if dry_run:
                    log.info(f"  {item.title[:55]}  ->  {res.title_ru[:55]}")
                else:
                    save_news_translation(
                        conn, item.id, res.title_ru, res.body_ru
                    )
                totals["translated"] += 1

            if not dry_run:
                conn.commit()
            log.info(f"  batch {bi + 1}/{batch_count}: {len(batch)} done")

    log.info(
        f"news translate done: translated={totals['translated']} "
        f"skipped={totals['skipped']} failed_batches={totals['failed_batches']}"
    )
    return totals


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run(limit=args.limit, dry_run=args.dry_run)

from __future__ import annotations

import _path  # noqa: F401

from src.db import get_connection
from src.http import Client
from src.loaders.news import (
    ensure_default_sources,
    list_active_sources,
    mark_source_fetched,
    upsert_news_items,
)
from src.parsers.news import parse_feed
from src.utils.logger import log, record_parse_error


def run(*, dry_run: bool = False) -> dict[str, int]:
    """Fetch every active news source's RSS feed and upsert new items.

    New rows land as status='pending'; 10_classify_news.py fills the
    classification, entity links, and approval. One dead feed is logged and
    skipped — it never aborts the others. Returns run counts.
    """
    totals = {"sources": 0, "failed": 0, "inserted": 0, "existing": 0}

    with Client() as http, get_connection() as conn:
        ensure_default_sources(conn)
        conn.commit()

        sources = list_active_sources(conn)
        log.info(f"news ingest: {len(sources)} active source(s)")

        for src in sources:
            totals["sources"] += 1
            try:
                xml = http.get(src.feed_url)
            except Exception as exc:
                # A single broken feed must not sink the whole run.
                log.error(f"  {src.slug}: feed fetch failed — {exc!r}")
                record_parse_error(
                    url=src.feed_url, kind="news_feed_fetch", message=str(exc)
                )
                totals["failed"] += 1
                continue

            entries = parse_feed(xml)
            if dry_run:
                log.info(f"  {src.slug}: {len(entries)} entries (dry-run)")
                continue

            counts = upsert_news_items(conn, src.id, entries)
            mark_source_fetched(conn, src.id)
            conn.commit()
            totals["inserted"] += counts.inserted
            totals["existing"] += counts.skipped
            log.info(
                f"  {src.slug}: {len(entries)} entries — "
                f"+{counts.inserted} new, {counts.skipped} existing"
            )

    log.info(
        f"news ingest done: sources={totals['sources']} "
        f"failed={totals['failed']} inserted={totals['inserted']} "
        f"existing={totals['existing']}"
    )
    return totals


if __name__ == "__main__":
    run()

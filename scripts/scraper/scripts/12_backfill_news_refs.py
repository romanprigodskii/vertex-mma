"""One-off backfill for news_item.external_refs on articles ingested
before the ref-extractor existed (or backfilled with junk from the
raw HTML before we learned to scope refs to the article body only).

Strategy: for each approved article, re-fetch the article URL with
trafilatura, ask it to extract just the article body as HTML
(output_format="html"), then pull refs from that cleaned HTML so
site chrome (nav menus, footers, related-article rails) doesn't
leak into the refs list. Body text is left untouched.

Safe to interrupt and re-run. The default WHERE clause picks up
both empty-refs rows AND rows that look junk-filled (single-word
nav anchors like "FORUM ▼" or "VIDEOS"). Hard-capped at LIMIT
articles per run so publishers don't get hammered.
"""
from __future__ import annotations

import json
import time

import _path  # noqa: F401
import trafilatura

from src.article_extractor import _EXTRACT_KWARGS
from src.db import get_connection
from src.ref_extractor import extract_refs
from src.utils.logger import log

LIMIT = 400
SLEEP_SECS = 0.4

SELECT_CANDIDATES = """
    SELECT id::text, url, title
    FROM news_item
    WHERE status IN ('approved', 'auto_approved')
      AND external_refs::text = '[]'
    ORDER BY published_at DESC
    LIMIT %s
"""

UPDATE_REFS = """
    UPDATE news_item
    SET external_refs = %s::jsonb
    WHERE id = %s::uuid
"""


def run() -> dict[str, int]:
    totals = {"checked": 0, "with_refs": 0, "without_refs": 0, "failed": 0}

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SELECT_CANDIDATES, (LIMIT,))
            items = cur.fetchall()
        log.info(f"ref backfill: {len(items)} candidate(s)")
        if not items:
            return totals

        for item_id, url, title in items:
            totals["checked"] += 1
            try:
                downloaded = trafilatura.fetch_url(url)
            except Exception as exc:
                log.warning(f"  fetch failed for {url}: {exc!r}")
                totals["failed"] += 1
                continue

            if not downloaded:
                totals["failed"] += 1
                continue

            # Extract refs from the cleaned article HTML (not raw page),
            # so site chrome doesn't bleed into the refs list.
            html_body = trafilatura.extract(
                downloaded, output_format="html", **_EXTRACT_KWARGS
            )
            refs = extract_refs(html_body) if html_body else []
            with conn.cursor() as cur:
                cur.execute(UPDATE_REFS, (json.dumps(refs), item_id))
            conn.commit()

            if refs:
                totals["with_refs"] += 1
                log.info(f"  [{title[:55]}] → {len(refs)} refs")
            else:
                totals["without_refs"] += 1

            time.sleep(SLEEP_SECS)

    log.info(
        "ref backfill done: "
        f"checked={totals['checked']} "
        f"with_refs={totals['with_refs']} "
        f"without_refs={totals['without_refs']} "
        f"failed={totals['failed']}"
    )
    return totals


if __name__ == "__main__":
    run()

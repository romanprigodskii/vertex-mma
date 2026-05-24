"""Re-fetch news items and replace the RSS-summary body with the full
article body so live-updated "Results" articles actually carry results.

Targets:
  - items whose stored body is missing or short (likely RSS teaser);
  - items whose title suggests they're live-updated (Results / live
    blog / play-by-play) AND were published within the last 48h.

Any item whose body is replaced has its `body_rephrased` cleared so the
next rephrase pass regenerates from the new content. Items also have
their `processed_at` cleared so the classifier re-evaluates against
the fuller body (a "Results" article that originally had only a
schedule may have classified as `general_news`; with results in it,
it should land as `result`).
"""
from __future__ import annotations

import time

import _path  # noqa: F401

from src.article_extractor import extract_article
from src.db import get_connection
from src.utils.logger import log

# Hard cap on items per run so a backlog doesn't blast publishers.
LIMIT = 200
# Be gentle on source servers.
SLEEP_SECS = 0.4
# Only persist an updated body if it's meaningfully longer than what we
# already had — protects against extractors that occasionally collapse
# a full article down to a one-line caption.
MIN_GAIN_CHARS = 200

SELECT_CANDIDATES = """
    SELECT id::text, url, title, COALESCE(length(body), 0) AS current_len
    FROM news_item
    WHERE status IN ('approved', 'auto_approved', 'pending')
      AND (
        body IS NULL
        OR length(body) < 400
        OR (
          (
            title ILIKE %s
            OR title ILIKE %s
            OR title ILIKE %s
            OR title ILIKE %s
          )
          AND published_at > now() - interval '48 hours'
        )
      )
    ORDER BY published_at DESC
    LIMIT %s
"""

LIVE_PATTERNS = ("%result%", "%live blog%", "%play-by-play%", "%recap%")

UPDATE_BODY = """
    UPDATE news_item
    SET body            = %s,
        body_rephrased  = NULL,
        processed_at    = NULL
    WHERE id = %s::uuid
"""


def run() -> dict[str, int]:
    totals = {"checked": 0, "updated": 0, "skipped_no_gain": 0, "failed": 0}

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SELECT_CANDIDATES, (*LIVE_PATTERNS, LIMIT))
            items = cur.fetchall()
        log.info(f"article extract: {len(items)} candidate(s)")
        if not items:
            return totals

        for item_id, url, title, current_len in items:
            totals["checked"] += 1
            try:
                body = extract_article(url)
            except Exception as exc:
                log.warning(f"  fetch failed for {url}: {exc!r}")
                totals["failed"] += 1
                continue

            if not body:
                log.info(f"  no body extracted from {url}")
                totals["failed"] += 1
                continue

            if len(body) < current_len + MIN_GAIN_CHARS:
                totals["skipped_no_gain"] += 1
                continue

            with conn.cursor() as cur:
                cur.execute(UPDATE_BODY, (body, item_id))
            conn.commit()
            totals["updated"] += 1
            log.info(
                f"  updated [{title[:60]}]: {current_len} → {len(body)} chars"
            )

            time.sleep(SLEEP_SECS)

    log.info(
        "article extract done: "
        f"checked={totals['checked']} "
        f"updated={totals['updated']} "
        f"skipped_no_gain={totals['skipped_no_gain']} "
        f"failed={totals['failed']}"
    )
    return totals


if __name__ == "__main__":
    run()

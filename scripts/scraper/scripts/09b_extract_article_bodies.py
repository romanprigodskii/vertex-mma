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

import json
import time

import _path  # noqa: F401

from src.article_extractor import extract_article_full
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

# Title patterns marking an article whose body keeps changing or matters in
# full, so it's worth re-fetching for a few days after publish:
#   - live results / recaps: the body fills in as the event runs, so the
#     pre-event snapshot must be replaced by the final version.
#   - full card / fight card / lineup: the complete bout list is the whole
#     point, and often lands in the article after the RSS teaser.
REFETCH_PATTERNS = (
    "%result%", "%live blog%", "%play-by-play%", "%recap%",
    "%full card%", "%fight card%", "%lineup%",
)
_TITLE_OR = " OR ".join(["title ILIKE %s"] * len(REFETCH_PATTERNS))

# 72h so a card/results article published a day or two before the event keeps
# getting re-checked until the final version (results filled in) is live.
SELECT_CANDIDATES = f"""
    SELECT id::text, url, title, COALESCE(length(body), 0) AS current_len,
           (image_url IS NULL) AS needs_image
    FROM news_item
    WHERE status IN ('approved', 'auto_approved', 'pending')
      AND (
        body IS NULL
        OR length(body) < 400
        OR (({_TITLE_OR}) AND published_at > now() - interval '72 hours')
        -- RSS feeds carry no images, so fetch recent imageless items once to
        -- pull their og:image (bounded by the 30-day window + LIMIT).
        OR (image_url IS NULL AND published_at > now() - interval '30 days')
      )
    ORDER BY published_at DESC
    LIMIT %s
"""

UPDATE_BODY = """
    UPDATE news_item
    SET body              = %s,
        -- clear EN + RU derived text so a refreshed body re-classifies,
        -- re-rephrases AND re-translates (RU was previously left stale).
        body_rephrased    = NULL,
        body_rephrased_ru = NULL,
        title_ru          = NULL,
        processed_at      = NULL,
        external_refs     = %s::jsonb,
        image_url         = COALESCE(image_url, %s)
    WHERE id = %s::uuid
"""

UPDATE_IMAGE = """
    UPDATE news_item SET image_url = %s
    WHERE id = %s::uuid AND image_url IS NULL
"""


def run() -> dict[str, int]:
    totals = {
        "checked": 0,
        "updated": 0,
        "images_added": 0,
        "skipped_no_gain": 0,
        "failed": 0,
    }

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(SELECT_CANDIDATES, (*REFETCH_PATTERNS, LIMIT))
            items = cur.fetchall()
        log.info(f"article extract: {len(items)} candidate(s)")
        if not items:
            return totals

        for item_id, url, title, current_len, needs_image in items:
            totals["checked"] += 1
            try:
                result = extract_article_full(url)
            except Exception as exc:
                log.warning(f"  fetch failed for {url}: {exc!r}")
                totals["failed"] += 1
                time.sleep(SLEEP_SECS)
                continue

            if not result:
                log.info(f"  no body extracted from {url}")
                totals["failed"] += 1
                time.sleep(SLEEP_SECS)
                continue

            if len(result.body) >= current_len + MIN_GAIN_CHARS:
                with conn.cursor() as cur:
                    cur.execute(
                        UPDATE_BODY,
                        (result.body, json.dumps(result.refs), result.image_url, item_id),
                    )
                conn.commit()
                totals["updated"] += 1
                log.info(
                    f"  updated [{title[:60]}]: "
                    f"{current_len} → {len(result.body)} chars, "
                    f"{len(result.refs)} refs"
                )
            elif needs_image and result.image_url:
                # Body didn't gain, but we found an image and the item lacked one.
                with conn.cursor() as cur:
                    cur.execute(UPDATE_IMAGE, (result.image_url, item_id))
                conn.commit()
                totals["images_added"] += 1
            else:
                totals["skipped_no_gain"] += 1

            time.sleep(SLEEP_SECS)

    log.info(
        "article extract done: "
        f"checked={totals['checked']} "
        f"updated={totals['updated']} "
        f"images_added={totals['images_added']} "
        f"skipped_no_gain={totals['skipped_no_gain']} "
        f"failed={totals['failed']}"
    )
    return totals


if __name__ == "__main__":
    run()

"""One-off cleanup: clear `body` / `body_rephrased` entries that are
live-blog scaffolding rather than real article content, so the next
rephrase pass regenerates them honestly (using only the title when
body is also garbage).

The earlier extractor run pulled the full page text from Sherdog's
pre-event live blogs verbatim — pages full of "Tudor Leonte scores the
round:" placeholder rows with no actual scores. Haiku then dutifully
rephrased the scaffolding. Reuse the same is_low_quality_body() check
the extractor now applies to retroactively scrub anything that slipped
through.
"""
from __future__ import annotations

import _path  # noqa: F401

from src.article_extractor import is_low_quality_body
from src.db import get_connection
from src.utils.logger import log


def run() -> dict[str, int]:
    totals = {
        "checked": 0,
        "body_cleared": 0,
        "rephrase_cleared": 0,
    }

    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id::text, title, body, body_rephrased
                FROM news_item
                WHERE body IS NOT NULL OR body_rephrased IS NOT NULL
                """
            )
            rows = cur.fetchall()
        log.info(f"garbage purge: scanning {len(rows)} item(s)")

        for item_id, title, body, body_rephrased in rows:
            totals["checked"] += 1
            body_bad = is_low_quality_body(body)
            reph_bad = is_low_quality_body(body_rephrased)

            if not body_bad and not reph_bad:
                continue

            sets: list[str] = []
            params: list[object] = []
            tags: list[str] = []
            if body_bad:
                sets.append("body = NULL")
                tags.append("body")
                totals["body_cleared"] += 1
            if reph_bad or body_bad:
                # Always clear the rephrase when body changes, so the
                # next rephrase pass picks it up fresh.
                sets.append("body_rephrased = NULL")
                sets.append("processed_at = NULL")
                if reph_bad and not body_bad:
                    totals["rephrase_cleared"] += 1
                tags.append("rephrase")

            params.append(item_id)
            stmt = (
                f"UPDATE news_item SET {', '.join(sets)} WHERE id = %s::uuid"
            )
            with conn.cursor() as cur:
                cur.execute(stmt, params)
            log.info(f"  cleared {'+'.join(tags)} for [{title[:60]}]")

        conn.commit()

    log.info(
        "garbage purge done: "
        f"checked={totals['checked']} "
        f"body_cleared={totals['body_cleared']} "
        f"rephrase_cleared={totals['rephrase_cleared']}"
    )
    return totals


if __name__ == "__main__":
    run()

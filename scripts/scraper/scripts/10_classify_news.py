from __future__ import annotations

import _path  # noqa: F401

from src.db import get_connection
from src.loaders.news import (
    apply_classification,
    fetch_unprocessed,
    find_bout,
    resolve_fighter_ids,
)
from src.news_classifier import ItemInput, classify_batch
from src.utils.logger import log

BATCH_SIZE = 10
APPROVE_THRESHOLD = 0.70


def decide_status(
    classification: str,
    model_confidence: float,
    source_base_confidence: float,
    source_is_trusted: bool,
) -> str:
    """Confidence-gated approval. A trusted source plus a confident, on-topic
    classification auto-approves; weaker signals wait as 'pending' (hidden
    from the feed until a future moderation pass). Off-topic items are
    rejected outright."""
    if classification == "unrelated":
        return "rejected"
    effective = (
        0.6 * model_confidence
        + 0.4 * source_base_confidence
        + (0.1 if source_is_trusted else 0.0)
    )
    effective = max(0.0, min(1.0, effective))
    return "auto_approved" if effective >= APPROVE_THRESHOLD else "pending"


def run() -> dict[str, int]:
    """Classify every unprocessed news item with Claude Haiku, link the
    fighters and bout it mentions, and set the confidence-gated status.

    Resumable: only items with processed_at IS NULL are touched, and a failed
    batch is left unprocessed for the next run.
    """
    totals: dict[str, int] = {
        "classified": 0,
        "auto_approved": 0,
        "pending": 0,
        "rejected": 0,
        "failed_batches": 0,
    }

    with get_connection() as conn:
        items = fetch_unprocessed(conn)
        log.info(f"news classify: {len(items)} unprocessed item(s)")
        if not items:
            return totals

        fighter_cache: dict[str, str | None] = {}
        batch_count = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE

        for bi in range(batch_count):
            batch = items[bi * BATCH_SIZE : (bi + 1) * BATCH_SIZE]
            inputs = [
                ItemInput(index=i, title=it.title, body=it.body)
                for i, it in enumerate(batch)
            ]
            try:
                results = classify_batch(inputs)
            except Exception as exc:
                # A failed batch stays unprocessed for the next run.
                log.error(f"  batch {bi + 1}/{batch_count} failed — {exc!r}")
                totals["failed_batches"] += 1
                continue

            for i, item in enumerate(batch):
                res = results.get(i)
                if res is None:
                    log.warning(
                        f"  item {item.id}: no classifier result — skipped"
                    )
                    continue

                fighter_ids = resolve_fighter_ids(
                    conn, res.fighters, fighter_cache
                )
                bout_id = (
                    find_bout(conn, fighter_ids[0], fighter_ids[1])
                    if len(fighter_ids) == 2
                    else None
                )
                status = decide_status(
                    res.classification,
                    res.confidence,
                    item.source_base_confidence,
                    item.source_is_trusted,
                )
                apply_classification(
                    conn,
                    item.id,
                    classification=res.classification,
                    confidence=res.confidence,
                    fighter_ids=fighter_ids,
                    bout_id=bout_id,
                    status=status,
                )
                totals["classified"] += 1
                totals[status] += 1

            conn.commit()
            log.info(
                f"  batch {bi + 1}/{batch_count}: {len(batch)} item(s) done"
            )

    log.info(
        f"news classify done: classified={totals['classified']} "
        f"auto_approved={totals['auto_approved']} pending={totals['pending']} "
        f"rejected={totals['rejected']} failed_batches={totals['failed_batches']}"
    )
    return totals


if __name__ == "__main__":
    run()

"""Generate rephrased bodies for approved news items via Claude Haiku."""
from __future__ import annotations

import _path  # noqa: F401

from src.db import get_connection
from src.loaders.news import fetch_unrephrased, save_rephrase
from src.news_rephraser import ItemInput, rephrase_batch
from src.utils.logger import log

BATCH_SIZE = 5


def run() -> dict[str, int]:
    """Rephrase every approved news item without body_rephrased via Claude Haiku.

    Resumable: only approved items missing body_rephrased are touched, and a
    failed batch is left for the next run.
    """
    totals: dict[str, int] = {"rephrased": 0, "failed_batches": 0}

    with get_connection() as conn:
        items = fetch_unrephrased(conn)
        log.info(f"news rephrase: {len(items)} unrephrased item(s)")
        if not items:
            return totals

        batch_count = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE
        for bi in range(batch_count):
            batch = items[bi * BATCH_SIZE : (bi + 1) * BATCH_SIZE]
            inputs = [
                ItemInput(index=i, title=it.title, body=it.body)
                for i, it in enumerate(batch)
            ]
            try:
                results = rephrase_batch(inputs)
            except Exception as exc:
                log.error(f"  batch {bi + 1}/{batch_count} failed — {exc!r}")
                totals["failed_batches"] += 1
                continue

            for i, item in enumerate(batch):
                res = results.get(i)
                if res is None:
                    log.warning(
                        f"  item {item.id}: no rephrase result — skipped"
                    )
                    continue
                save_rephrase(conn, item.id, res.body)
                totals["rephrased"] += 1

            conn.commit()
            log.info(
                f"  batch {bi + 1}/{batch_count}: {len(batch)} item(s) done"
            )

    log.info(
        f"news rephrase done: rephrased={totals['rephrased']} "
        f"failed_batches={totals['failed_batches']}"
    )
    return totals


if __name__ == "__main__":
    run()

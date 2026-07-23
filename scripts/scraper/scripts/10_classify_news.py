from __future__ import annotations

import _path  # noqa: F401

from src.db import get_connection
from src.loaders.news import (
    apply_classification,
    auto_create_bout,
    cancel_bout_if_provisional,
    fetch_unprocessed,
    find_bout,
    resolve_fighter_ids,
    resolve_or_create_event,
    update_provisional_bout,
)
from src.news_classifier import ItemInput, classify_batch
from src.utils.logger import log

BATCH_SIZE = 10
APPROVE_THRESHOLD = 0.70

# Auto-creating a bout (and, when needed, a provisional event) from a news
# announcement is irreversible-ish (we'd pollute the event/bout tables with bad
# rows). Gate it aggressively:
#   - Haiku must be at least 85% sure of the classification.
#   - The source has to be trusted (MMA Junkie / Fighting / Mania / etc.),
#     so a random tabloid blog can't seed a phantom bout.
#   - We need both fighters, a weight class, and an event hint; the event is
#     resolved or (with a parseable date) created provisionally.
AUTO_CREATE_BOUT_MIN_CONFIDENCE = 0.85


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
        "bouts_auto_created": 0,
        "bouts_cancelled": 0,
        "bouts_updated": 0,
    }

    with get_connection() as conn:
        items = fetch_unprocessed(conn)
        log.info(f"news classify: {len(items)} unprocessed item(s)")
        if not items:
            return totals

        fighter_cache: dict[str, str | None] = {}
        event_cache: dict[str, str | None] = {}
        batch_count = (len(items) + BATCH_SIZE - 1) // BATCH_SIZE

        for bi in range(batch_count):
            batch = items[bi * BATCH_SIZE : (bi + 1) * BATCH_SIZE]
            inputs = [
                ItemInput(
                    index=i,
                    title=it.title,
                    body=it.body,
                    published_at=it.published_at,
                )
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

                # Build the concrete matchups to act on. The classifier's
                # structured `bouts` carries one pairing per announced/changed
                # fight, so a multi-bout article ("A vs B and C vs D are
                # official") creates BOTH — the old code only fired when the
                # flat fighter list held exactly two names, so any article that
                # named a third fighter (a co-main, a mentioned champ) silently
                # created nothing. Fall back to the legacy "exactly two
                # fighters = one matchup" heuristic when the model gave no
                # structured pairing (e.g. a cancellation, which we don't ask
                # to pair). Each entry: (name_a, name_b, fighter_a_id,
                # fighter_b_id, weight_class).
                matchups: list[tuple[str, str, str, str, str | None]] = []
                for ab in res.bouts:
                    pair_ids = resolve_fighter_ids(
                        conn, [ab.fighter_a, ab.fighter_b], fighter_cache
                    )
                    if len(pair_ids) == 2:
                        matchups.append(
                            (
                                ab.fighter_a,
                                ab.fighter_b,
                                pair_ids[0],
                                pair_ids[1],
                                ab.weight_class or res.weight_class,
                            )
                        )
                # Legacy fallback: ONLY when the model gave no structured
                # pairing AND named exactly two fighters that both resolved.
                # resolve_fighter_ids drops unresolved names and de-dupes, so a
                # 3+-name article where only two resolve would leave the flat
                # list positionally misaligned with res.fighters — pairing two
                # fighters the article never matched. Requiring len 2 on BOTH
                # keeps fighter_ids[i] aligned with res.fighters[i].
                if (
                    not matchups
                    and len(res.fighters) == 2
                    and len(fighter_ids) == 2
                ):
                    matchups.append(
                        (
                            res.fighters[0],
                            res.fighters[1],
                            fighter_ids[0],
                            fighter_ids[1],
                            res.weight_class,
                        )
                    )

                # related_bout_id links the news item to a bout for display
                # (e.g. a result/weigh-in/announcement card linking to the
                # fight). Default to an existing bout for the primary matchup;
                # bout_announced may create one below and claim the slot.
                primary = matchups[0] if matchups else None
                bout_id = (
                    find_bout(conn, primary[2], primary[3])
                    if primary is not None
                    else None
                )

                # If Haiku tagged this as a freshly-announced booking AND we have
                # everything needed (two known fighters, a weight class, a
                # trusted source, high confidence) AND no existing bout links the
                # pair — spin up a scheduled bout so the matchup surfaces on the
                # event page without a manual touch. The event is resolved OR
                # created: a brand-new card (announced before UFCStats lists it
                # — the common case) gets a provisional event, which the later
                # official scrape adopts rather than duplicates. Every announced
                # matchup is handled, not just the first.
                if (
                    res.classification == "bout_announced"
                    and res.confidence >= AUTO_CREATE_BOUT_MIN_CONFIDENCE
                    and item.source_is_trusted
                    and res.event_hint
                ):
                    for name_a, name_b, fa_id, fb_id, wc in matchups:
                        if not wc:
                            continue
                        if find_bout(conn, fa_id, fb_id) is not None:
                            continue
                        event_id = resolve_or_create_event(
                            conn,
                            res.event_hint,
                            event_date=res.event_date,
                            cache=event_cache,
                        )
                        if not event_id:
                            continue
                        new_bout_id, created = auto_create_bout(
                            conn,
                            fighter_a_id=fa_id,
                            fighter_b_id=fb_id,
                            event_id=event_id,
                            weight_class=wc,
                        )
                        if bout_id is None:
                            bout_id = new_bout_id
                        if created:
                            totals["bouts_auto_created"] += 1
                            log.info(
                                f"  auto-bout: {name_a} vs {name_b} @ "
                                f"{res.event_hint} ({wc}) — {new_bout_id}"
                            )

                # A trusted cancellation report retires a provisional (news-
                # created) bout so the phantom card doesn't linger. Only ever
                # touches ufc_stats_id-NULL scheduled rows — official bouts are
                # left to the scrape.
                elif (
                    res.classification == "bout_cancelled"
                    and bout_id is not None
                    and item.source_is_trusted
                    and res.confidence >= AUTO_CREATE_BOUT_MIN_CONFIDENCE
                ):
                    if cancel_bout_if_provisional(
                        conn,
                        bout_id,
                        news_item_id=item.id,
                        observed_at=item.published_at_ts,
                        confidence=res.confidence,
                    ):
                        totals["bouts_cancelled"] += 1
                        log.info(f"  provisional bout cancelled: {bout_id}")

                # A trusted "details changed" report (opponent stays, date or
                # weight moved) updates the provisional bout/card in place.
                # Opponent SWAPS surface separately as a fresh bout_announced
                # for the new pair, so we don't guess them here.
                elif (
                    res.classification == "bout_changed"
                    and bout_id is not None
                    and item.source_is_trusted
                    and res.confidence >= AUTO_CREATE_BOUT_MIN_CONFIDENCE
                ):
                    if update_provisional_bout(
                        conn,
                        bout_id,
                        weight_class=(primary[4] if primary else None),
                        event_date=res.event_date,
                        news_item_id=item.id,
                        observed_at=item.published_at_ts,
                        confidence=res.confidence,
                    ):
                        totals["bouts_updated"] += 1
                        log.info(f"  provisional bout updated (changed): {bout_id}")

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
        f"rejected={totals['rejected']} failed_batches={totals['failed_batches']} "
        f"bouts_auto_created={totals['bouts_auto_created']} "
        f"bouts_cancelled={totals['bouts_cancelled']} "
        f"bouts_updated={totals['bouts_updated']}"
    )
    return totals


if __name__ == "__main__":
    run()

"""Persist news sources and ingested news items."""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg

from ..parsers.news import NewsEntry
from ..utils.logger import log
from ..utils.slugify import slugify
from .change_events import (
    KIND_DATE_MOVED,
    KIND_STATUS_CANCELLED,
    KIND_WEIGHT_CLASS_CHANGED,
    SOURCE_NEWS,
    record_change,
)


@dataclass
class SourceRow:
    id: str
    slug: str
    name: str
    feed_url: str


@dataclass
class UpsertCounts:
    inserted: int = 0
    skipped: int = 0


@dataclass
class SourceSeed:
    slug: str
    name: str
    url: str
    feed_url: str
    is_trusted: bool
    base_confidence: float


# Reputable MMA outlets. Adding a source = adding a row here (or inserting
# straight into news_source). A dead feed_url is logged and skipped on each
# ingest run, never fatal — so an out-of-date URL degrades gracefully.
DEFAULT_SOURCES: list[SourceSeed] = [
    SourceSeed(
        slug="mma-fighting",
        name="MMA Fighting",
        url="https://www.mmafighting.com",
        feed_url="https://www.mmafighting.com/rss/index.xml",
        is_trusted=True,
        base_confidence=0.72,
    ),
    SourceSeed(
        slug="espn-mma",
        name="ESPN MMA",
        url="https://www.espn.com/mma/",
        feed_url="https://www.espn.com/espn/rss/mma/news",
        is_trusted=True,
        base_confidence=0.78,
    ),
    SourceSeed(
        slug="sherdog",
        name="Sherdog",
        url="https://www.sherdog.com",
        feed_url="https://www.sherdog.com/rss/news.xml",
        is_trusted=True,
        base_confidence=0.65,
    ),
]


def ensure_default_sources(conn: psycopg.Connection) -> None:
    """Upsert the built-in source list by slug. `is_active` and
    `last_fetched_at` are left untouched, so a manual deactivation or a
    fetch timestamp survives re-runs."""
    with conn.cursor() as cur:
        for s in DEFAULT_SOURCES:
            cur.execute(
                """
                INSERT INTO news_source (
                    slug, name, url, feed_url, type, is_trusted, base_confidence
                )
                VALUES (%s, %s, %s, %s, 'rss', %s, %s)
                ON CONFLICT (slug) DO UPDATE SET
                    name = EXCLUDED.name,
                    url = EXCLUDED.url,
                    feed_url = EXCLUDED.feed_url,
                    type = EXCLUDED.type,
                    is_trusted = EXCLUDED.is_trusted,
                    base_confidence = EXCLUDED.base_confidence
                """,
                (s.slug, s.name, s.url, s.feed_url, s.is_trusted, s.base_confidence),
            )


def list_active_sources(conn: psycopg.Connection) -> list[SourceRow]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, slug, name, feed_url
            FROM news_source
            WHERE is_active = true AND feed_url IS NOT NULL
            ORDER BY slug
            """
        )
        return [
            SourceRow(id=r[0], slug=r[1], name=r[2], feed_url=r[3])
            for r in cur.fetchall()
        ]


def upsert_news_items(
    conn: psycopg.Connection,
    source_id: str,
    entries: list[NewsEntry],
) -> UpsertCounts:
    """Insert new items; existing URLs are left untouched (ON CONFLICT DO
    NOTHING). New rows land as status='pending' for the classifier."""
    counts = UpsertCounts()
    with conn.cursor() as cur:
        for e in entries:
            # Skip near-duplicate stories (the same booking re-reported across
            # outlets, or a re-post) via pg_trgm title similarity within a
            # recent window — otherwise the feed fills with the same headline.
            # Exact-URL dupes are still caught by ON CONFLICT below. Same-batch
            # dupes are caught too: an earlier insert is visible to this SELECT
            # within the open transaction.
            cur.execute(
                """
                SELECT 1 FROM news_item
                WHERE similarity(title, %s) > 0.85
                  AND published_at > now() - interval '7 days'
                LIMIT 1
                """,
                (e.title,),
            )
            if cur.fetchone() is not None:
                counts.skipped += 1
                continue
            cur.execute(
                """
                INSERT INTO news_item (
                    source_id, external_id, url, title, body, author,
                    image_url, published_at, external_refs
                )
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (url) DO NOTHING
                RETURNING id
                """,
                (
                    source_id,
                    e.external_id,
                    e.url,
                    e.title,
                    e.body,
                    e.author,
                    e.image_url,
                    e.published_at,
                    json.dumps(e.refs or []),
                ),
            )
            if cur.fetchone() is not None:
                counts.inserted += 1
            else:
                counts.skipped += 1
    return counts


def mark_source_fetched(conn: psycopg.Connection, source_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE news_source SET last_fetched_at = now() WHERE id = %s::uuid",
            (source_id,),
        )


@dataclass
class UnprocessedItem:
    id: str
    title: str
    body: str | None
    source_base_confidence: float
    source_is_trusted: bool
    # Article publish date (ISO 'YYYY-MM-DD'), used to anchor the classifier's
    # event-year inference so a backlog item doesn't get a wrong-year date.
    published_at: str | None
    # The same moment as a real timestamp. Used as `observed_at` for anything
    # this item makes us record: the classifier runs hourly and can pick up a
    # backlog item days after publication, so now() would misdate the change.
    published_at_ts: datetime | None = None


def fetch_unprocessed(
    conn: psycopg.Connection, limit: int = 500
) -> list[UnprocessedItem]:
    """News items not yet classified (processed_at IS NULL), newest first."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ni.id::text, ni.title, ni.body,
                   ns.base_confidence, ns.is_trusted,
                   to_char(ni.published_at, 'YYYY-MM-DD'),
                   ni.published_at
            FROM news_item ni
            JOIN news_source ns ON ns.id = ni.source_id
            WHERE ni.processed_at IS NULL
            ORDER BY ni.published_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return [
            UnprocessedItem(
                id=r[0],
                title=r[1],
                body=r[2],
                source_base_confidence=float(r[3]),
                source_is_trusted=bool(r[4]),
                published_at=r[5],
                published_at_ts=r[6],
            )
            for r in cur.fetchall()
        ]


def resolve_fighter_ids(
    conn: psycopg.Connection,
    names: list[str],
    cache: dict[str, str | None],
) -> list[str]:
    """Fuzzy-match fighter names to fighter IDs via pg_trgm. The threshold is
    deliberately high — a wrong link is worse than a missing one. `cache`
    memoises lookups within a run (the same fighters recur across articles)."""
    ids: list[str] = []
    with conn.cursor() as cur:
        for raw in names:
            name = raw.strip()
            if not name:
                continue
            if name not in cache:
                cur.execute(
                    """
                    SELECT id::text
                    FROM fighter
                    WHERE similarity(name_en, %s) > 0.45
                       OR lower(name_en) = lower(%s)
                    ORDER BY (lower(name_en) = lower(%s)) DESC,
                             similarity(name_en, %s) DESC
                    LIMIT 1
                    """,
                    (name, name, name, name),
                )
                row = cur.fetchone()
                cache[name] = row[0] if row else None
            fid = cache[name]
            if fid and fid not in ids:
                ids.append(fid)
    return ids


def find_bout(
    conn: psycopg.Connection, fighter_a: str, fighter_b: str
) -> str | None:
    """A bout between exactly these two fighters, preferring a scheduled one."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT b.id::text
            FROM bout b
            LEFT JOIN event e ON e.id = b.event_id
            WHERE (b.fighter_a_id = %s::uuid AND b.fighter_b_id = %s::uuid)
               OR (b.fighter_a_id = %s::uuid AND b.fighter_b_id = %s::uuid)
            ORDER BY (b.status = 'scheduled') DESC, e.date DESC NULLS LAST
            LIMIT 1
            """,
            (fighter_a, fighter_b, fighter_b, fighter_a),
        )
        row = cur.fetchone()
        return row[0] if row else None


def resolve_event_id(
    conn: psycopg.Connection,
    event_hint: str | None,
    *,
    cache: dict[str, str | None] | None = None,
) -> str | None:
    """Match an event hint string (e.g. "UFC 330", "UFC Fight Night: Whittaker
    vs Costa") to an event_id in the DB. Uses pg_trgm similarity on both
    event.name and event.short_name. Slugs are deterministic so we also try
    them directly. Returns None when nothing matches well enough.

    Threshold (0.45) is tuned to be aggressive — the news pipeline already
    runs upstream confidence gates before reaching here, so a missed match
    is worse than a slightly fuzzy hit. Won't return events that already
    happened more than a week ago."""
    if not event_hint:
        return None
    key = event_hint.strip().lower()
    if cache is not None and key in cache:
        return cache[key]
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text
            FROM event
            WHERE (
                similarity(name, %s) > 0.45
                OR similarity(coalesce(short_name, name), %s) > 0.45
                OR lower(name) = lower(%s)
                OR lower(coalesce(short_name, '')) = lower(%s)
              )
              AND (status IN ('upcoming', 'in_progress')
                   OR date >= now() - interval '7 days')
            ORDER BY
              GREATEST(
                similarity(name, %s),
                similarity(coalesce(short_name, name), %s)
              ) DESC,
              date ASC
            LIMIT 1
            """,
            (event_hint, event_hint, event_hint, event_hint, event_hint, event_hint),
        )
        row = cur.fetchone()
        eid = row[0] if row else None
    if cache is not None:
        cache[key] = eid
    return eid


# A provisional event created from a news booking can land at most this far
# out; anything beyond is almost certainly a hallucinated/garbled LLM date.
_MAX_EVENT_HORIZON_DAYS = 540


def resolve_or_create_event(
    conn: psycopg.Connection,
    event_hint: str | None,
    *,
    event_date: str | None,
    cache: dict[str, str | None] | None = None,
) -> str | None:
    """Resolve an event hint to an event_id, CREATING a provisional event when
    the hint names a card we don't track yet — the common case for a freshly
    announced bout that UFCStats hasn't listed (this is exactly why most
    auto-bout attempts used to fail silently).

    A provisional event is a normal `event` row with `ufc_stats_id = NULL`; the
    UFCStats scrape later ADOPTS it (loaders/events.upsert_event_listing claims
    the row by setting its ufc_stats_id) instead of inserting a duplicate, so
    the card — and any bouts/markets/predictions attached to it — survive the
    transition to official data with their IDs intact.

    Creation needs a parseable `event_date` because `event.date` is NOT NULL; we
    never invent a date, so when the LLM didn't extract one this degrades to the
    old resolve-only behaviour (returns None → no bout created). Returns the
    event_id, or None when nothing resolves and we can't create.
    """
    if not event_hint:
        return None
    existing = resolve_event_id(conn, event_hint, cache=cache)
    if existing:
        return existing
    if not event_date:
        return None
    try:
        when = datetime.strptime(event_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    now = datetime.now(timezone.utc)
    # Guard against bad LLM dates: not meaningfully in the past, not absurdly far out.
    if when < now - timedelta(days=2) or when > now + timedelta(days=_MAX_EVENT_HORIZON_DAYS):
        log.warning(
            f"  provisional event skipped — date {event_date} outside "
            f"[-2d, +{_MAX_EVENT_HORIZON_DAYS}d] for {event_hint!r}"
        )
        return None

    name = event_hint.strip()
    slug = f"{slugify(name) or 'ufc-event'}-{uuid.uuid4().hex[:6]}"
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO event (
                slug, name, short_name, promotion, date, status, ufc_stats_id
            )
            VALUES (%s, %s, %s, 'ufc', %s, 'upcoming'::event_status, NULL)
            RETURNING id::text
            """,
            (slug, name, name, when),
        )
        eid = cur.fetchone()[0]
    if cache is not None:
        cache[event_hint.strip().lower()] = eid
    log.info(
        f"  provisional event created: {name!r} @ {event_date} — {eid}"
    )
    return eid


def auto_create_bout(
    conn: psycopg.Connection,
    *,
    fighter_a_id: str,
    fighter_b_id: str,
    event_id: str,
    weight_class: str,
) -> tuple[str, bool]:
    """Insert a scheduled bout between two fighters at an event, or return
    the existing one if a row already links the same pair to the same event.
    Returns (bout_id, created). Idempotent on (event_id, fighter pair)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text FROM bout
            WHERE event_id = %s::uuid
              AND (
                (fighter_a_id = %s::uuid AND fighter_b_id = %s::uuid)
                OR (fighter_a_id = %s::uuid AND fighter_b_id = %s::uuid)
              )
            LIMIT 1
            """,
            (
                event_id,
                fighter_a_id, fighter_b_id,
                fighter_b_id, fighter_a_id,
            ),
        )
        row = cur.fetchone()
        if row:
            return row[0], False

        cur.execute(
            """
            INSERT INTO bout (event_id, fighter_a_id, fighter_b_id,
                              weight_class, status, scheduled_rounds)
            VALUES (%s::uuid, %s::uuid, %s::uuid,
                    %s::weight_class, 'scheduled', 3)
            RETURNING id::text
            """,
            (event_id, fighter_a_id, fighter_b_id, weight_class),
        )
        return cur.fetchone()[0], True


def cancel_bout_if_provisional(
    conn: psycopg.Connection,
    bout_id: str,
    *,
    news_item_id: str | None = None,
    observed_at: datetime | None = None,
    confidence: float | None = None,
) -> bool:
    """Mark a bout 'cancelled' ONLY if it's a still-scheduled provisional row
    (ufc_stats_id IS NULL) — i.e. one we auto-created from a news announcement.
    Never touches an official UFCStats-scraped bout (those are owned by the
    scrape). Returns True if a row was cancelled. Closes the loop so a
    'bout_cancelled' news item retires the phantom card it would otherwise
    leave behind.

    The cancellation is also recorded in bout_change_event — a withdrawal
    reported by the press, which is precisely the booking circumstance the
    model has no access to. `observed_at` is the article's published_at, not
    now(): the classifier runs hourly and a backlog item can be days old.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE bout SET status = 'cancelled'::bout_status, updated_at = now()
            WHERE id = %s::uuid AND ufc_stats_id IS NULL AND status = 'scheduled'
            RETURNING event_id::text, fighter_a_id::text, fighter_b_id::text,
                      weight_class::text
            """,
            (bout_id,),
        )
        row = cur.fetchone()
        if row is None:
            return False
        event_id, fa, fb, weight_class = row
        record_change(
            cur,
            bout_id=bout_id,
            event_id=event_id,
            kind=KIND_STATUS_CANCELLED,
            source=SOURCE_NEWS,
            # Per news item: two outlets reporting the same withdrawal are two
            # observations of one event, but a bout cancelled, re-booked and
            # cancelled again is two events.
            signature=news_item_id or "news_cancellation",
            observed_at=observed_at,
            payload={
                "news_item_id": news_item_id,
                "classification": "bout_cancelled",
                "confidence": confidence,
                "fighter_a_id": fa,
                "fighter_b_id": fb,
                "weight_class": weight_class,
                "previous_status": "scheduled",
                "was_provisional": True,
            },
        )
        return True


def update_provisional_bout(
    conn: psycopg.Connection,
    bout_id: str,
    *,
    weight_class: str | None = None,
    event_date: str | None = None,
    news_item_id: str | None = None,
    observed_at: datetime | None = None,
    confidence: float | None = None,
) -> bool:
    """Apply a `bout_changed` announcement to a still-provisional bout
    (ufc_stats_id NULL, scheduled): a weight-class change, and/or a card date
    change on its provisional event. Never touches official scraped rows (those
    are owned by the UFCStats scrape). Returns True if anything changed.

    Both kinds of change are recorded in bout_change_event with their BEFORE
    value, which is why each is read before it is written: a date move tells us
    how much the fighters' preparation window shifted, and that is only legible
    against the date it moved from. Recording follows the same rule as the
    update — only actual differences, so a re-reported change is silent.
    """
    changed = False
    with conn.cursor() as cur:
        if weight_class:
            cur.execute(
                "SELECT weight_class::text, event_id::text FROM bout "
                "WHERE id = %s::uuid AND ufc_stats_id IS NULL AND status = 'scheduled'",
                (bout_id,),
            )
            before = cur.fetchone()
            cur.execute(
                """
                UPDATE bout SET weight_class = %s::weight_class, updated_at = now()
                WHERE id = %s::uuid AND ufc_stats_id IS NULL AND status = 'scheduled'
                  AND weight_class <> %s::weight_class
                """,
                (weight_class, bout_id, weight_class),
            )
            if cur.rowcount > 0:
                changed = True
                record_change(
                    cur,
                    bout_id=bout_id,
                    event_id=before[1] if before else None,
                    kind=KIND_WEIGHT_CLASS_CHANGED,
                    source=SOURCE_NEWS,
                    signature=f"{before[0] if before else None}->{weight_class}",
                    observed_at=observed_at,
                    payload={
                        "news_item_id": news_item_id,
                        "classification": "bout_changed",
                        "confidence": confidence,
                        "old_weight_class": before[0] if before else None,
                        "new_weight_class": weight_class,
                        "was_provisional": True,
                    },
                )
        if event_date:
            try:
                when = datetime.strptime(event_date, "%Y-%m-%d").replace(
                    tzinfo=timezone.utc
                )
            except ValueError:
                when = None
            if when is not None:
                cur.execute(
                    """
                    SELECT e.id::text, e.date FROM event e
                    JOIN bout b ON b.event_id = e.id
                    WHERE b.id = %s::uuid AND b.ufc_stats_id IS NULL
                      AND e.ufc_stats_id IS NULL
                    """,
                    (bout_id,),
                )
                before_event = cur.fetchone()
                # Move the (provisional) event's date — shifts the whole card,
                # which is correct for a date change. Only if the event itself
                # is still provisional.
                cur.execute(
                    """
                    UPDATE event SET date = %s, updated_at = now()
                    WHERE ufc_stats_id IS NULL
                      AND id = (
                        SELECT event_id FROM bout
                        WHERE id = %s::uuid AND ufc_stats_id IS NULL
                      )
                      AND date::date <> %s::date
                    """,
                    (when, bout_id, when),
                )
                if cur.rowcount > 0:
                    changed = True
                    old_date = before_event[1] if before_event else None
                    # Filed against the bout that triggered it, but the move is
                    # event-scoped: every other bout on the card shifted too.
                    # Expand via event_id when analysing, don't assume one row
                    # per affected fight.
                    record_change(
                        cur,
                        bout_id=bout_id,
                        event_id=before_event[0] if before_event else None,
                        kind=KIND_DATE_MOVED,
                        source=SOURCE_NEWS,
                        signature=(
                            f"{old_date.date().isoformat() if old_date else None}"
                            f"->{when.date().isoformat()}"
                        ),
                        observed_at=observed_at,
                        payload={
                            "news_item_id": news_item_id,
                            "classification": "bout_changed",
                            "confidence": confidence,
                            "old_event_date": old_date,
                            "new_event_date": when,
                            "days_shifted": (
                                (when.date() - old_date.date()).days
                                if old_date
                                else None
                            ),
                            "scope": "event",
                            "was_provisional": True,
                        },
                    )
    return changed


def apply_classification(
    conn: psycopg.Connection,
    item_id: str,
    *,
    classification: str,
    confidence: float,
    fighter_ids: list[str],
    bout_id: str | None,
    status: str,
) -> None:
    """Write the classifier's verdict and mark the item processed."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE news_item SET
                classification = %s::news_classification,
                confidence = %s,
                related_fighter_ids = %s::uuid[],
                related_bout_id = %s::uuid,
                status = %s::news_status,
                processed_at = now()
            WHERE id = %s::uuid
            """,
            (
                classification,
                confidence,
                fighter_ids,
                bout_id,
                status,
                item_id,
            ),
        )


@dataclass
class UnrephrasedItem:
    id: str
    title: str
    body: str | None


def fetch_unrephrased(
    conn: psycopg.Connection, limit: int = 300
) -> list[UnrephrasedItem]:
    """Approved news items not yet rephrased, newest first."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, title, body
            FROM news_item
            WHERE status IN ('approved', 'auto_approved')
              AND body_rephrased IS NULL
            ORDER BY published_at DESC
            LIMIT %s
            """,
            (limit,),
        )
        return [
            UnrephrasedItem(id=r[0], title=r[1], body=r[2])
            for r in cur.fetchall()
        ]


def save_rephrase(
    conn: psycopg.Connection, item_id: str, body_rephrased: str
) -> None:
    """Store the Haiku-rephrased body for a news item."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE news_item SET body_rephrased = %s WHERE id = %s::uuid",
            (body_rephrased, item_id),
        )


@dataclass
class UntranslatedNewsItem:
    id: str
    title: str
    body: str | None


def fetch_untranslated_news(
    conn: psycopg.Connection, limit: int | None = None
) -> list[UntranslatedNewsItem]:
    """Approved items needing translation, newest first. Two cases:
    never translated (title_ru IS NULL), or translated title-only before the
    rephrased body existed — such items are picked up again once body_rephrased
    appears so the body gets its Russian text. Their title is re-translated too;
    that is fine and keeps title/body consistent from one model call. body is
    the displayed (rephrased) text — may be null when rephrasing didn't run, in
    which case only the title gets translated. The body branch requires a
    non-blank body_rephrased: a whitespace-only body legitimately translates to
    an empty body_ru, and without the btrim guard such an item would re-enter
    the queue every run forever."""
    sql = (
        "SELECT id::text, title, body_rephrased FROM news_item "
        "WHERE status IN ('approved', 'auto_approved') "
        "AND (title_ru IS NULL "
        "     OR (NULLIF(btrim(body_rephrased), '') IS NOT NULL "
        "         AND NULLIF(body_rephrased_ru, '') IS NULL)) "
        "ORDER BY published_at DESC"
    )
    params: tuple = ()
    if limit is not None:
        sql += " LIMIT %s"
        params = (limit,)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return [
            UntranslatedNewsItem(id=r[0], title=r[1], body=r[2])
            for r in cur.fetchall()
        ]


def save_news_translation(
    conn: psycopg.Connection,
    item_id: str,
    title_ru: str,
    body_rephrased_ru: str | None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE news_item SET title_ru = %s, body_rephrased_ru = %s "
            "WHERE id = %s::uuid",
            (title_ru, body_rephrased_ru, item_id),
        )

"""Persist news sources and ingested news items."""
from __future__ import annotations

from dataclasses import dataclass

import psycopg

from ..parsers.news import NewsEntry


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
            cur.execute(
                """
                INSERT INTO news_item (
                    source_id, external_id, url, title, body, author, published_at
                )
                VALUES (%s::uuid, %s, %s, %s, %s, %s, %s)
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
                    e.published_at,
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


def fetch_unprocessed(
    conn: psycopg.Connection, limit: int = 500
) -> list[UnprocessedItem]:
    """News items not yet classified (processed_at IS NULL), newest first."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT ni.id::text, ni.title, ni.body,
                   ns.base_confidence, ns.is_trusted
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

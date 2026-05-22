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

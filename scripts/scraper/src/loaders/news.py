"""Persist news sources and ingested news items."""
from __future__ import annotations

import json
import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psycopg

from ..parsers.news import NewsEntry
from ..utils.logger import log
from ..utils.slugify import slugify
from .change_events import (
    KIND_DATE_MOVED,
    KIND_NEWS_SIGNAL,
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


def _fold(value: str) -> str:
    """Accent-, case- and punctuation-insensitive form used to compare names."""
    folded = unicodedata.normalize("NFKD", value or "")
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = re.sub(r"[^A-Za-z ]", " ", folded)
    return " ".join(folded.lower().split())


def _given_names_compatible(a: str, b: str) -> bool:
    """Whether two given names can belong to the same fighter.

    Equal ("Ian"/"Ian"), an initial ("J."/"Joshua"), or one a prefix of the
    other ("Alex"/"Alexander", "Dooho"/"Doo Ho" once folded) all pass.
    Two different names ("Renato"/"Roan") do not.
    """
    if a == b:
        return True
    if not a or not b:
        return False
    if len(a) == 1 or len(b) == 1:
        return a[0] == b[0]
    return a.startswith(b) or b.startswith(a)


def names_can_be_same_fighter(candidate: str, mention: str) -> bool:
    """Reject surname-only trigram collisions.

    pg_trgm scores "Renato Carneiro" against "Roan Carneiro" at 0.50 — over
    the 0.45 bar — purely on the shared surname, and that is how a Sherdog
    article using Renato Moicano's legal surname booked a phantom bout for a
    fighter who last competed in 2017. Trigrams cannot tell "same surname,
    different man" from "same man, spelled differently", so require the
    surname to match AND the given names to be compatible.

    Deliberately asymmetric in cost: a rejected match means the bout waits for
    the UFCStats scrape, a wrong one puts a fight that does not exist on a
    live card.
    """
    cand, mention_f = _fold(candidate), _fold(mention)
    if not cand or not mention_f:
        return False
    if cand == mention_f:
        return True
    cand_parts, mention_parts = cand.split(), mention_f.split()
    if cand_parts[-1] != mention_parts[-1]:
        return False
    return _given_names_compatible(cand_parts[0], mention_parts[0])


def resolve_fighter_ids(
    conn: psycopg.Connection,
    names: list[str],
    cache: dict[str, str | None],
) -> list[str]:
    """Match fighter names to fighter IDs via a registered alias or pg_trgm.

    The trigram threshold is deliberately high and every fuzzy candidate must
    still clear `names_can_be_same_fighter` — a wrong link is worse than a
    missing one. An explicit `fighter_alias` row bypasses the name check: it
    is a human-curated statement that the two strings are one person (e.g.
    "Renato Carneiro" → Renato Moicano). `cache` memoises lookups within a
    run (the same fighters recur across articles).
    """
    ids: list[str] = []
    with conn.cursor() as cur:
        for raw in names:
            name = raw.strip()
            if not name:
                continue
            if name not in cache:
                cur.execute(
                    """
                    SELECT f.id::text, f.name_en, a.alias
                    FROM fighter f
                    LEFT JOIN fighter_alias a
                      ON a.fighter_id = f.id
                     AND lower(a.alias) = lower(%(name)s)
                    WHERE lower(f.name_en) = lower(%(name)s)
                       OR a.alias IS NOT NULL
                       OR similarity(f.name_en, %(name)s) > 0.45
                    ORDER BY (lower(f.name_en) = lower(%(name)s)) DESC,
                             (a.alias IS NOT NULL) DESC,
                             similarity(f.name_en, %(name)s) DESC
                    LIMIT 5
                    """,
                    {"name": name},
                )
                resolved: str | None = None
                for fid, candidate_name, alias in cur.fetchall():
                    if alias is not None or names_can_be_same_fighter(
                        candidate_name, name
                    ):
                        resolved = fid
                        break
                    log.info(
                        f"  fighter name rejected: {name!r} ~ {candidate_name!r} "
                        "(surname collision, different given name)"
                    )
                cache[name] = resolved
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


_UFC_NUMBER_RE = re.compile(r"\bUFC\s*(\d{1,4})\b", re.IGNORECASE)

# A numbered card matches by its number or not at all. Trigrams cannot do
# this: similarity('UFC 330', 'UFC 331') is 0.60 — the same 0.60 that
# 'UFC 300' scores against 'UFC 309' — while the real "UFC 331: Van vs.
# Pantoja 2" scores only 0.33 against the hint "UFC 331" and falls under the
# threshold entirely. So the hint "UFC 331" used to resolve, confidently, to
# UFC 330. Numbers are exact identifiers; match them as such.
_UFC_NUMBER_SQL = r"\yUFC[[:space:]]*{}\y"


def _ufc_number(text: str | None) -> str | None:
    match = _UFC_NUMBER_RE.search(text or "")
    return match.group(1) if match else None


def resolve_event_id(
    conn: psycopg.Connection,
    event_hint: str | None,
    *,
    cache: dict[str, str | None] | None = None,
) -> str | None:
    """Match an event hint string (e.g. "UFC 330", "UFC Fight Night: Whittaker
    vs Costa") to an event_id in the DB.

    A hint carrying a card number ("UFC 331") is resolved by that number
    alone — exactly, against both name and short_name — and returns None when
    we don't track that card yet, so the caller can create it provisionally
    instead of attaching the bout to a neighbouring card. Numbered candidates
    are likewise excluded from the fuzzy path, so an unnumbered hint
    ("UFC Paris") can never land on "UFC 330".

    Everything else falls back to pg_trgm similarity on name/short_name. That
    threshold (0.45) is tuned to be aggressive — the news pipeline already
    runs upstream confidence gates before reaching here, so for a *named*
    card a missed match is worse than a slightly fuzzy hit. Won't return
    events that already happened more than a week ago.
    """
    if not event_hint:
        return None
    key = event_hint.strip().lower()
    if cache is not None and key in cache:
        return cache[key]

    hint_number = _ufc_number(event_hint)
    with conn.cursor() as cur:
        if hint_number:
            pattern = _UFC_NUMBER_SQL.format(hint_number)
            cur.execute(
                """
                SELECT id::text
                FROM event
                WHERE (name ~* %s OR coalesce(short_name, '') ~* %s)
                  AND (status IN ('upcoming', 'in_progress')
                       OR date >= now() - interval '7 days')
                ORDER BY date ASC
                LIMIT 1
                """,
                (pattern, pattern),
            )
        else:
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
                  AND name !~* %s
                  AND coalesce(short_name, '') !~* %s
                ORDER BY
                  GREATEST(
                    similarity(name, %s),
                    similarity(coalesce(short_name, name), %s)
                  ) DESC,
                  date ASC
                LIMIT 1
                """,
                (
                    event_hint, event_hint, event_hint, event_hint,
                    r"\yUFC[[:space:]]*[0-9]", r"\yUFC[[:space:]]*[0-9]",
                    event_hint, event_hint,
                ),
            )
        row = cur.fetchone()
        eid = row[0] if row else None
    if cache is not None:
        cache[key] = eid
    return eid


# A provisional event created from a news booking can land at most this far
# out; anything beyond is almost certainly a hallucinated/garbled LLM date.
_MAX_EVENT_HORIZON_DAYS = 540

# Promotions we do not track. Our feeds are general MMA press, so they carry
# plenty of bookings for other organisations — and grappling and bare-knuckle
# cards, which are not MMA bouts at all. Provisional events are inserted with
# promotion 'ufc' by construction, so an unguarded hint of this kind becomes a
# fake UFC card: "BKFC event in Manchester" (Till vs. Romero, bare-knuckle
# boxing) and "ACBJJ 22" (Zabit Magomedsharipov's grappling match) both shipped
# to the live site this way. Resolution against an already-tracked event is
# unaffected — this only refuses to invent a card for someone else's show.
_FOREIGN_PROMOTION_RE = re.compile(
    r"\b(?:"
    r"bkfc|bare[\s-]?knuckle|pfl|bellator|rizin|ksw|invicta|glory|"
    r"one\s+(?:championship|fight\s+night|fc)|"
    r"cage\s+warriors|oktagon|acbjj|adcc|karate\s+combat|"
    r"aca|acb|raf|lfa|cffc"
    r")\b",
    re.IGNORECASE,
)


def is_foreign_promotion(event_hint: str | None) -> bool:
    """Whether an event hint names a promotion other than the UFC."""
    return bool(_FOREIGN_PROMOTION_RE.search(event_hint or ""))


def resolve_or_create_event(
    conn: psycopg.Connection,
    event_hint: str | None,
    *,
    event_date: str | None,
    cache: dict[str, str | None] | None = None,
    first_seen_at: datetime | None = None,
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

    `first_seen_at` is the announcing article's published_at — when the card
    was first reported, which for a provisional event is the only honest
    answer. Falls back to now() when the caller has nothing better.
    """
    if not event_hint:
        return None
    # Before resolution, not after: this function's answer for a promotion we
    # don't track is "no event" whether or not a row for it already exists.
    # Checking after would happily hand back a foreign card that an earlier,
    # unguarded run had already created — and keep hanging bouts on it.
    if is_foreign_promotion(event_hint):
        log.info(
            f"  provisional event skipped — {event_hint!r} is not a UFC card"
        )
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
                slug, name, short_name, promotion, date, status, ufc_stats_id,
                first_seen_at
            )
            VALUES (%s, %s, %s, 'ufc', %s, 'upcoming'::event_status, NULL,
                    COALESCE(%s, now()))
            RETURNING id::text
            """,
            (slug, name, name, when, first_seen_at),
        )
        eid = cur.fetchone()[0]
    if cache is not None:
        cache[event_hint.strip().lower()] = eid
    log.info(
        f"  provisional event created: {name!r} @ {event_date} — {eid}"
    )
    return eid


# Past this many months without a recorded bout, a fighter carrying a
# released/retired roster status is not someone the press is freshly booking —
# they are what a bad name match looks like. Every phantom bout that reached
# the live site paired a current fighter with one of these (Roan Carneiro, last
# bout 2017; Zabit Magomedsharipov, 2019; Yoel Romero, 2020; Darren Till,
# 2022). A genuine comeback still lands: the UFCStats scrape lists it within
# hours and creates the bout on the official card. This gate only decides
# whether we front-run that scrape on the strength of a headline.
_STALE_FIGHTER_MONTHS = 36


def stale_bookee(conn: psycopg.Connection, fighter_id: str) -> str | None:
    """Name of the fighter when they are too long inactive to be booked, else None."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT f.name_en
            FROM fighter f
            WHERE f.id = %(fid)s::uuid
              AND f.roster_status IN ('released', 'retired')
              AND COALESCE((
                    SELECT max(e.date)
                    FROM bout b JOIN event e ON e.id = b.event_id
                    WHERE (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)
                      AND b.method IS NOT NULL
                  ), 'epoch'::timestamptz)
                  < now() - make_interval(months => %(months)s)
            """,
            {"fid": fighter_id, "months": _STALE_FIGHTER_MONTHS},
        )
        row = cur.fetchone()
        return row[0] if row else None


def auto_create_bout(
    conn: psycopg.Connection,
    *,
    fighter_a_id: str,
    fighter_b_id: str,
    event_id: str,
    weight_class: str,
    first_seen_at: datetime | None = None,
) -> tuple[str | None, bool]:
    """Insert a scheduled bout between two fighters at an event, or return
    the existing one if a row already links the same pair to the same event.
    Returns (bout_id, created) — bout_id is None when the pairing was refused.
    Idempotent on (event_id, fighter pair).

    `first_seen_at` should be the announcing article's published_at — for a
    news-born booking that IS the announcement date, and it is the earliest
    such mark anywhere in the database. Passing None falls back to now(),
    which the hourly classifier makes wrong by up to the age of the backlog;
    callers that have the timestamp must pass it.

    The row survives adoption by the UFCStats scrape (which only sets
    ufc_stats_id on the existing row), so this timestamp is what the bout
    keeps for the rest of its life.
    """
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

    for fid in (fighter_a_id, fighter_b_id):
        stale = stale_bookee(conn, fid)
        if stale:
            log.info(
                f"  auto-bout refused — {stale} has no bout in "
                f"{_STALE_FIGHTER_MONTHS} months and is off the roster"
            )
            return None, False

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO bout (event_id, fighter_a_id, fighter_b_id,
                              weight_class, status, scheduled_rounds,
                              first_seen_at)
            VALUES (%s::uuid, %s::uuid, %s::uuid,
                    %s::weight_class, 'scheduled', 3,
                    COALESCE(%s, now()))
            RETURNING id::text
            """,
            (event_id, fighter_a_id, fighter_b_id, weight_class, first_seen_at),
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


def record_news_signal(
    conn: psycopg.Connection,
    *,
    bout_id: str,
    news_item_id: str,
    classification: str,
    confidence: float,
    published_at: datetime | None,
    source_is_trusted: bool,
    acted: bool,
) -> bool:
    """Keep a withdrawal / booking-change / weigh-in report against the bout it
    is about, whether or not it changed anything in the database.

    The classifier has been emitting these three categories all along, and
    almost all of them were then dropped: `bout_cancelled` and `bout_changed`
    only ever materialise on PROVISIONAL rows (an official bout is owned by
    the UFCStats scrape and must not be flipped by a headline), and `weigh_in`
    materialised nowhere at all. But "a trusted outlet reported that this
    fighter withdrew, eleven days out" is exactly the booking circumstance the
    model has no access to, and it is worth the same whether or not we felt
    entitled to touch the row.

    `acted` records which of the two it was, so a later analysis can tell a
    report we merely observed from one that also changed our data.

    Deduped by news item across ALL rows for the bout (`dedupe_scope='any'`):
    an article reports a given thing once no matter how often it is
    reprocessed, and unlike a recurring state it can't legitimately repeat.
    """
    with conn.cursor() as cur:
        return record_change(
            cur,
            bout_id=bout_id,
            kind=KIND_NEWS_SIGNAL,
            source=SOURCE_NEWS,
            signature=news_item_id,
            dedupe_scope="any",
            observed_at=published_at,
            payload={
                "news_item_id": news_item_id,
                "classification": classification,
                "confidence": confidence,
                "source_is_trusted": source_is_trusted,
                "acted": acted,
            },
        )


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
